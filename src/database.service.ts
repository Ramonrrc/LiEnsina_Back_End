import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as bcrypt from 'bcryptjs'
import initSqlJs = require('sql.js')
import type { Database as SqlDatabase } from 'sql.js'
import { Pool } from 'pg'

import { getDatabaseConfig, type DatabaseConfig } from './database.config'
import { databaseCollections } from './database.schema'
import { buildQuestionBankSeed } from './question-bank.seed'
import type { AppNotification, AssessmentDescriptor, AssessmentMatrix, AssessmentProgram, ClassRoom, CurriculumBase, CurriculumSkill, DatabaseShape, FoodRequestStatus, Guardian, LessonRecord, MealBudgetStatus, MealFood, MealFoodRequest, MealManagement, MealMenuStatus, MealRequestHistory, MealStockStatus, MealUnit, Question, QuestionImportPlan, RefreshSession, Role, RoleCode, RoomReservation, School, StoredImageObject, Student, Teacher, UserAccount } from './liensina.types'

const passwordHashPattern = /^\$2[aby]\$\d{2}\$/
const passwordSaltRounds = 12

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const defaultRolePermissions: Record<RoleCode, string[]> = {
  ADMIN: [
    'food.view.all',
    'food.request.manage.all',
    'food.stock.manage',
    'food.purchase.manage',
    'food.supplier.manage',
    'food.audit.view',
    'user.manage',
  ],
  DIRETOR: [
    'food.view.own_school',
    'food.request.create',
    'food.request.view.own_school',
    'food.request.edit_when_adjustment',
  ],
  NUTRITIONIST: [
    'food.request.view.all',
    'food.request.approve',
    'food.request.reject',
    'food.request.request_adjustment',
    'food.stock.view.all',
    'food.expiration_alerts.view',
  ],
  COORDENADOR: [],
  PROFESSOR: [],
  ALUNO: [],
  RESPONSAVEL: [],
}

const forbiddenRolePermissions: Partial<Record<RoleCode, string[]>> = {
  DIRETOR: ['auditoria:ler', 'food.audit.view'],
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name)
  private readonly databaseConfig: DatabaseConfig
  private readonly databasePath: string
  private data!: DatabaseShape
  private db?: SqlDatabase
  private pool?: Pool
  private pendingPersist: Promise<void> = Promise.resolve()

  constructor(private readonly configService: ConfigService) {
    this.databaseConfig = getDatabaseConfig(this.configService)
    this.databasePath = this.databaseConfig.sqlitePath
  }

  async onModuleInit() {
    if (this.databaseConfig.driver === 'postgres') {
      await this.initializePostgres()
      return
    }

    await this.initializeSqlite()
  }

  async onModuleDestroy() {
    await this.pendingPersist
    await this.pool?.end()
  }

  getDriver() {
    return this.databaseConfig.driver
  }

  private async initializeSqlite() {
    mkdirSync(dirname(this.databasePath), { recursive: true })

    const SQL = await initSqlJs({
      locateFile: (file) => resolve(process.cwd(), 'node_modules/sql.js/dist', file),
    })

    this.db = existsSync(this.databasePath)
      ? new SQL.Database(readFileSync(this.databasePath))
      : new SQL.Database()

    this.ensureSchema()

    const storedData = this.readCollections()
    if (Object.keys(storedData).length === 0) {
      this.logger.warn('Banco LiEnsina inicializado vazio. Colecoes iniciais serao criadas com o banco autoral de questoes.')
    }
    this.data = this.normalizeDatabase(storedData)

    this.persist()
    this.logger.log(`Banco LiEnsina SQLite inicializado em ${this.databasePath}`)
  }

  private async initializePostgres() {
    if (!this.databaseConfig.postgresUrl) {
      throw new Error('DATABASE_URL e obrigatoria quando DATABASE_DRIVER=postgres.')
    }

    this.pool = new Pool({
      connectionString: this.databaseConfig.postgresUrl,
      ssl: this.databaseConfig.postgresSsl ? { rejectUnauthorized: false } : undefined,
    })

    await this.ensurePostgresSchema()

    const storedData = await this.readPostgresCollections()
    if (Object.keys(storedData).length === 0) {
      this.logger.warn('Banco LiEnsina PostgreSQL inicializado vazio. Colecoes iniciais serao criadas com o banco autoral de questoes.')
    }

    this.data = this.normalizeDatabase(storedData)
    await this.persistPostgresNow()
    this.logger.log('Banco LiEnsina PostgreSQL inicializado.')
  }

  read(): DatabaseShape {
    return structuredClone(this.data)
  }

  update(mutator: (data: DatabaseShape) => void): DatabaseShape {
    mutator(this.data)
    this.persist()
    return this.read()
  }

  private ensureSchema() {
    this.db?.run(`
      CREATE TABLE IF NOT EXISTS collections (
        name TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  private readCollections(): Partial<DatabaseShape> {
    const output: Partial<DatabaseShape> = {}
    const result = this.db?.exec('SELECT name, payload FROM collections') ?? []
    const rows = result[0]?.values ?? []

    for (const row of rows) {
      const name = String(row[0]) as keyof DatabaseShape
      if (!databaseCollections.includes(name)) continue
      output[name] = JSON.parse(String(row[1])) as never
    }

    return output
  }

  private async ensurePostgresSchema() {
    await this.pool?.query(`
      CREATE TABLE IF NOT EXISTS collections (
        name text PRIMARY KEY,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT collections_payload_is_array CHECK (jsonb_typeof(payload) = 'array')
      )
    `)
    await this.pool?.query('CREATE INDEX IF NOT EXISTS collections_updated_at_idx ON collections (updated_at)')
    await this.pool?.query('CREATE INDEX IF NOT EXISTS collections_payload_gin_idx ON collections USING gin (payload jsonb_path_ops)')
  }

  private async readPostgresCollections(): Promise<Partial<DatabaseShape>> {
    const output: Partial<DatabaseShape> = {}
    const result = await this.pool?.query<{ name: keyof DatabaseShape; payload: unknown }>('SELECT name, payload FROM collections')

    for (const row of result?.rows ?? []) {
      if (!databaseCollections.includes(row.name)) continue
      output[row.name] = row.payload as never
    }

    return output
  }

  private normalizeDatabase(data: Partial<DatabaseShape>): DatabaseShape {
    const rawRoles = data.roles ?? []
    const rawSchools = data.schools ?? []
    const rawTeachers = data.teachers ?? []
    const rawGuardians = data.guardians ?? []
    const rawStudents = data.students ?? []
    const rawClasses = data.classes ?? []
    const rawEvaluations = data.evaluations ?? []
    const rawEvaluationCorrections = data.evaluationCorrections ?? []
    const rawCalendarEvents = data.calendarEvents ?? []
    const rawCurriculumBases = data.curriculumBases ?? []
    const rawCurriculumSkills = data.curriculumSkills ?? []
    const rawAssessmentPrograms = data.assessmentPrograms ?? []
    const rawAssessmentMatrices = data.assessmentMatrices ?? []
    const rawAssessmentDescriptors = data.assessmentDescriptors ?? []
    const rawQuestions = data.questions ?? []
    const rawQuestionImportPlans = data.questionImportPlans ?? []
    const rawLessonRecords = data.lessonRecords ?? []
    const rawRoomReservations = data.roomReservations ?? []
    const rawMealManagements = data.mealManagements ?? []
    const rawMealFoods = this.mergeMealFoodCatalog(data.mealFoods ?? [], rawMealManagements)
    const rawMealFoodRequests = data.mealFoodRequests ?? []
    const rawMealRequestHistory = data.mealRequestHistory ?? []
    const rawAuditEvents = data.auditEvents ?? []
    const rawUsers = data.users ?? []
    const rawRefreshSessions = data.refreshSessions ?? []
    const rawNotifications = data.notifications ?? []

    const idMaps = {
      roles: this.createUuidMap(rawRoles),
      users: this.createUuidMap(rawUsers),
      notifications: this.createUuidMap(rawNotifications),
      schools: this.createUuidMap(rawSchools),
      teachers: this.createUuidMap(rawTeachers),
      guardians: this.createUuidMap(rawGuardians),
      students: this.createUuidMap(rawStudents),
      classes: this.createUuidMap(rawClasses),
      evaluations: this.createUuidMap(rawEvaluations),
      evaluationCorrections: this.createUuidMap(rawEvaluationCorrections),
      calendarEvents: this.createUuidMap(rawCalendarEvents),
      roomReservations: this.createUuidMap(rawRoomReservations),
      mealManagements: this.createUuidMap(rawMealManagements),
      mealFoodRequests: this.createUuidMap(rawMealFoodRequests),
      mealRequestHistory: this.createUuidMap(rawMealRequestHistory),
      auditEvents: this.createUuidMap(rawAuditEvents),
    }

    const roles = this.ensureBaseRoles(rawRoles.map((role) => this.normalizeRole({
      ...role,
      id: this.remapId(role.id, idMaps.roles),
    })))
    const schools = rawSchools.map((school) => ({ ...school, id: this.remapId(school.id, idMaps.schools), active: school.active ?? true }))
    const schoolMap = new Map(schools.map((school) => [school.id, school]))
    const defaultSchoolId = schools[0]?.id ?? ''

    const classes = rawClasses.map((classRoom) => this.normalizeClassRoom({
      ...classRoom,
      id: this.remapId(classRoom.id, idMaps.classes),
      schoolId: this.remapOptionalId(classRoom.schoolId, idMaps.schools) ?? defaultSchoolId,
      teacherId: this.remapOptionalId(classRoom.teacherId, idMaps.teachers) ?? '',
      teacherIds: Array.isArray(classRoom.teacherIds)
        ? classRoom.teacherIds.map((teacherId) => this.remapId(teacherId, idMaps.teachers))
        : [],
    }))
    const teachers = rawTeachers.map((teacher) => this.normalizeTeacher({
      ...teacher,
      id: this.remapId(teacher.id, idMaps.teachers),
      userId: this.remapOptionalId(teacher.userId, idMaps.users) ?? randomUUID(),
      schoolId: this.remapOptionalId(teacher.schoolId, idMaps.schools) ?? defaultSchoolId,
    }))
    const students = rawStudents.map((student) => this.normalizeStudent({
      ...student,
      id: this.remapId(student.id, idMaps.students),
      userId: this.remapOptionalId(student.userId, idMaps.users) ?? randomUUID(),
      schoolId: this.remapOptionalId(student.schoolId, idMaps.schools) ?? defaultSchoolId,
      classId: this.remapOptionalId(student.classId, idMaps.classes) ?? '',
      guardianIds: Array.isArray(student.guardianIds)
        ? student.guardianIds.map((guardianId) => this.remapId(guardianId, idMaps.guardians))
        : [],
    }, schoolMap))
    const guardians = rawGuardians.map((guardian) => this.normalizeGuardian({
      ...guardian,
      id: this.remapId(guardian.id, idMaps.guardians),
      userId: this.remapOptionalId(guardian.userId, idMaps.users) ?? randomUUID(),
      schoolId: this.remapOptionalId(guardian.schoolId, idMaps.schools) ?? defaultSchoolId,
      studentIds: Array.isArray(guardian.studentIds)
        ? guardian.studentIds.map((studentId) => this.remapId(studentId, idMaps.students))
        : [],
    }))

    const usersById = new Map<string, UserAccount>()
    for (const user of rawUsers) {
      const normalized = this.normalizeUser({
        ...user,
        id: this.remapId(user.id, idMaps.users),
        roleId: this.remapRoleId(user.roleId, idMaps.roles),
        schoolId: this.remapNullableId(user.schoolId, idMaps.schools),
        linkedTeacherId: this.remapOptionalId(user.linkedTeacherId, idMaps.teachers),
        linkedStudentId: this.remapOptionalId(user.linkedStudentId, idMaps.students),
        linkedGuardianId: this.remapOptionalId(user.linkedGuardianId, idMaps.guardians),
      }, roles)
      usersById.set(normalized.id, normalized)
    }

    for (const teacher of teachers) {
      usersById.set(teacher.userId, this.mergeUser(usersById.get(teacher.userId), {
        id: teacher.userId,
        name: teacher.name,
        email: teacher.email,
        login: teacher.email,
        password: randomUUID(),
        roleId: this.getRoleIdFromCode(roles, 'PROFESSOR'),
        schoolId: teacher.schoolId,
        status: 'ativo',
        phone: '',
        linkedTeacherId: teacher.id,
      }))
    }

    for (const student of students) {
      usersById.set(student.userId, this.mergeUser(usersById.get(student.userId), {
        id: student.userId,
        name: student.name,
        email: `${student.registrationNumber}@aluno.liensina.com`,
        login: student.login,
        password: randomUUID(),
        roleId: this.getRoleIdFromCode(roles, 'ALUNO'),
        schoolId: student.schoolId,
        status: 'ativo',
        phone: '',
        linkedStudentId: student.id,
      }))
    }

    for (const guardian of guardians) {
      usersById.set(guardian.userId, this.mergeUser(usersById.get(guardian.userId), {
        id: guardian.userId,
        name: guardian.name,
        email: guardian.email,
        login: guardian.email,
        password: randomUUID(),
        roleId: this.getRoleIdFromCode(roles, 'RESPONSAVEL'),
        schoolId: guardian.schoolId,
        status: 'ativo',
        phone: guardian.phone,
        linkedGuardianId: guardian.id,
      }))
    }

    const guardianIds = new Set(guardians.map((guardian) => guardian.id))
    const studentIds = new Set(students.map((student) => student.id))

    for (const student of students) {
      student.guardianIds = student.guardianIds.filter((guardianId) => guardianIds.has(guardianId))
    }

    for (const guardian of guardians) {
      guardian.studentIds = guardian.studentIds.filter((studentId) => studentIds.has(studentId))
      for (const studentId of guardian.studentIds) {
        const student = students.find((item) => item.id === studentId)
        if (student && !student.guardianIds.includes(guardian.id)) student.guardianIds.push(guardian.id)
      }
    }

    const nutritionistRoleId = this.getRoleIdFromCode(roles, 'NUTRITIONIST')
    if (nutritionistRoleId && !Array.from(usersById.values()).some((user) => user.roleId === nutritionistRoleId)) {
      const nutritionistUserId = randomUUID()
      usersById.set(nutritionistUserId, this.normalizeUser({
        id: nutritionistUserId,
        name: 'Nutricionista da Secretaria',
        email: 'nutricionista@liensina.local',
        login: 'nutricionista@liensina.local',
        password: 'Nutri@2026!',
        roleId: nutritionistRoleId,
        schoolId: null,
        status: 'ativo',
        phone: '',
      }, roles))
    }

    const normalizedUsers = Array.from(usersById.values())
    for (const user of normalizedUsers) {
      if (user.linkedTeacherId) {
        const teacher = teachers.find((item) => item.id === user.linkedTeacherId)
        if (teacher) {
          this.applyProfileVisuals(teacher, user)
        }
      }

      if (user.linkedStudentId) {
        const student = students.find((item) => item.id === user.linkedStudentId)
        if (student) {
          this.applyProfileVisuals(student, user)
        }
      }

      if (user.linkedGuardianId) {
        const guardian = guardians.find((item) => item.id === user.linkedGuardianId)
        if (guardian) {
          this.applyProfileVisuals(guardian, user)
        }
      }
    }
    const mealFoods = this.normalizeMealFoods(rawMealFoods)
    const mealManagements = this.normalizeMealManagements(rawMealManagements, idMaps.mealManagements, idMaps.schools, idMaps.users, mealFoods)
    const mealFoodRequests = this.normalizeMealFoodRequests(rawMealFoodRequests, idMaps.mealFoodRequests, idMaps.schools, idMaps.users)
    const mealRequestHistory = this.normalizeMealRequestHistory(rawMealRequestHistory, idMaps.mealRequestHistory, idMaps.mealFoodRequests, idMaps.schools, idMaps.users, roles)
    const questionSeed = buildQuestionBankSeed()
    const curriculumBases = this.mergeSeedById(rawCurriculumBases, questionSeed.curriculumBases)
    const curriculumSkills = this.mergeSeedById(rawCurriculumSkills, questionSeed.curriculumSkills)
    const assessmentPrograms = this.mergeSeedById(rawAssessmentPrograms, questionSeed.assessmentPrograms)
    const assessmentMatrices = this.mergeSeedById(rawAssessmentMatrices, questionSeed.assessmentMatrices)
    const assessmentDescriptors = this.mergeSeedById(rawAssessmentDescriptors, questionSeed.assessmentDescriptors)
    const questions = this.mergeQuestionSeed(rawQuestions, questionSeed.questions)
    const questionImportPlans = this.mergeSeedById(rawQuestionImportPlans, questionSeed.questionImportPlans)

    return {
      users: normalizedUsers,
      roles,
      schools,
      teachers,
      guardians,
      students,
      classes,
      evaluations: rawEvaluations.map((evaluation) => ({
        ...evaluation,
        id: this.remapId(evaluation.id, idMaps.evaluations),
        classId: this.remapId(evaluation.classId, idMaps.classes),
      })),
      evaluationCorrections: rawEvaluationCorrections.map((correction) => ({
        ...correction,
        id: this.remapId(correction.id, idMaps.evaluationCorrections),
        evaluationId: this.remapId(correction.evaluationId, idMaps.evaluations),
        classId: this.remapId(correction.classId, idMaps.classes),
        studentId: this.remapId(correction.studentId, idMaps.students),
        reviewedById: this.remapNullableId(correction.reviewedById, idMaps.users),
        createdById: this.remapOptionalId(correction.createdById, idMaps.users) ?? '',
      })),
      curriculumBases,
      curriculumSkills,
      assessmentPrograms,
      assessmentMatrices,
      assessmentDescriptors,
      questions,
      questionImportPlans,
      lessonRecords: this.normalizeLessonRecords(rawLessonRecords, new Set(classes.map((classRoom) => classRoom.id))),
      roomReservations: this.normalizeRoomReservations(rawRoomReservations.map((reservation) => ({
        ...reservation,
        id: this.remapId(reservation.id, idMaps.roomReservations),
        classId: this.remapId(reservation.classId, idMaps.classes),
      })), new Set(classes.map((classRoom) => classRoom.id))),
      calendarEvents: rawCalendarEvents.map((calendarEvent) => ({
        ...calendarEvent,
        id: this.remapId(calendarEvent.id, idMaps.calendarEvents),
        schoolId: this.remapId(calendarEvent.schoolId, idMaps.schools),
        classId: this.remapNullableId(calendarEvent.classId, idMaps.classes),
        createdById: this.remapOptionalId(calendarEvent.createdById, idMaps.users) ?? '',
      })),
      mealFoods,
      mealManagements,
      mealFoodRequests,
      mealRequestHistory,
      refreshSessions: this.normalizeRefreshSessions(rawRefreshSessions, normalizedUsers),
      notifications: this.normalizeNotifications(rawNotifications, idMaps.notifications, idMaps.users, normalizedUsers),
      auditEvents: rawAuditEvents.map((auditEvent) => ({
        ...auditEvent,
        id: this.remapId(auditEvent.id, idMaps.auditEvents),
      })),
    }
  }

  private createUuidMap(items: Array<{ id?: string }>) {
    const map = new Map<string, string>()

    for (const item of items) {
      const id = String(item.id ?? '').trim()
      if (!id || this.isUuid(id) || map.has(id)) continue
      map.set(id, randomUUID())
    }

    return map
  }

  private mergeSeedById<T extends CurriculumBase | CurriculumSkill | AssessmentProgram | AssessmentMatrix | AssessmentDescriptor | QuestionImportPlan>(current: T[], seed: T[]) {
    const seen = new Set(current.map((item) => item.id))
    const merged = [...current]

    for (const item of seed) {
      if (seen.has(item.id)) continue
      merged.push(item)
      seen.add(item.id)
    }

    return merged
  }

  private mergeQuestionSeed(current: Question[], seed: Question[]) {
    const seen = new Set(current.flatMap((question) => [
      question.id,
      question.sourceExternalId,
      this.normalizeSeedQuestionKey(`${question.title}|${question.context}|${question.statement}`),
    ].filter(Boolean) as string[]))
    const merged = [...current]

    for (const question of seed) {
      const keys = [
        question.id,
        question.sourceExternalId,
        this.normalizeSeedQuestionKey(`${question.title}|${question.context}|${question.statement}`),
      ].filter(Boolean) as string[]
      if (keys.some((key) => seen.has(key))) continue

      merged.push(question)
      for (const key of keys) seen.add(key)
    }

    return merged
  }

  private normalizeSeedQuestionKey(value: unknown) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
  }

  private remapId(value: unknown, map: Map<string, string>) {
    const id = String(value ?? '').trim()
    if (!id) return randomUUID()
    return map.get(id) ?? id
  }

  private remapOptionalId(value: unknown, map: Map<string, string>) {
    const id = String(value ?? '').trim()
    if (!id) return undefined
    return map.get(id) ?? id
  }

  private remapNullableId(value: unknown, map: Map<string, string>) {
    const id = this.remapOptionalId(value, map)
    return id ?? null
  }

  private remapRoleId(roleId: unknown, roleMap: Map<string, string>) {
    const id = String(roleId ?? '').trim()
    if (!id) return id
    return roleMap.get(id) ?? id
  }

  private ensureUuid(value: unknown) {
    const id = String(value ?? '').trim()
    return this.isUuid(id) ? id : randomUUID()
  }

  private isUuid(value: string) {
    return uuidPattern.test(value)
  }

  private getRoleIdFromCode(roles: Role[], code: RoleCode) {
    return roles.find((role) => role.code === code)?.id ?? roles[0]?.id ?? ''
  }

  private normalizeRole(role: Partial<Role>): Role {
    const code = this.normalizeRoleCode(role.code ?? role.name ?? this.roleCodeFromLegacyId(String(role.id ?? '')) ?? 'ADMIN')
    const deniedPermissions = forbiddenRolePermissions[code] ?? []

    return {
      id: this.ensureUuid(role.id),
      code,
      name: code,
      description: String(role.description ?? '').trim(),
      permissions: Array.from(new Set([
        ...(Array.isArray(role.permissions) ? role.permissions : []),
        ...(defaultRolePermissions[code] ?? []),
      ])).filter((permission) => !deniedPermissions.includes(permission)),
    }
  }

  private ensureBaseRoles(roles: Role[]) {
    const output = [...roles]
    for (const code of ['ADMIN', 'DIRETOR', 'COORDENADOR', 'PROFESSOR', 'ALUNO', 'RESPONSAVEL', 'NUTRITIONIST'] as RoleCode[]) {
      if (output.some((role) => role.code === code)) continue
      output.push({
        id: randomUUID(),
        code,
        name: code,
        description: code === 'NUTRITIONIST' ? 'Avalia solicitacoes de merenda escolar.' : '',
        permissions: defaultRolePermissions[code] ?? [],
      })
    }
    return output
  }

  private normalizeRoleCode(value: unknown): RoleCode {
    const code = String(value ?? '').trim().toUpperCase()
    if (code === 'NUTRICIONISTA') return 'NUTRITIONIST'
    if (code === 'ADMIN' || code === 'DIRETOR' || code === 'COORDENADOR' || code === 'PROFESSOR' || code === 'ALUNO' || code === 'RESPONSAVEL' || code === 'NUTRITIONIST') {
      return code
    }
    return 'ADMIN'
  }

  private normalizeUser(user: UserAccount, roles: Role[]): UserAccount {
    const roleId = this.normalizeRoleId(user.roleId, roles)
    const safeRoleId = roles.some((role) => role.id === roleId) ? roleId : this.getRoleIdFromCode(roles, 'ADMIN')

    return {
      ...user,
      id: this.ensureUuid(user.id),
      login: user.login ?? user.email,
      password: this.normalizePassword(user.password),
      roleId: safeRoleId,
      schoolId: user.schoolId ?? null,
      status: user.status ?? 'ativo',
      phone: user.phone ?? '',
      cpf: user.cpf ?? '',
      birthDate: user.birthDate ?? '',
      avatarUrl: user.avatarUrl ?? user.avatarObject?.publicUrl ?? '',
      bannerUrl: user.bannerUrl ?? user.bannerObject?.publicUrl ?? '',
      avatarObject: this.normalizeStoredImageObject(user.avatarObject, user.avatarUrl),
      bannerObject: this.normalizeStoredImageObject(user.bannerObject, user.bannerUrl),
    }
  }

  private normalizeStoredImageObject(value: unknown, fallbackUrl?: string): StoredImageObject | null {
    if (value && typeof value === 'object') {
      const object = value as Partial<StoredImageObject>
      const bucket = String(object.bucket ?? '').trim()
      const key = String(object.key ?? '').trim()
      const publicUrl = String(object.publicUrl ?? '').trim()
      if (bucket && key && publicUrl) {
        return {
          storageProvider: object.storageProvider === 'bucket' ? 'bucket' : 'local',
          bucket,
          key,
          publicUrl,
          contentType: String(object.contentType ?? 'image/*'),
          sizeBytes: Number(object.sizeBytes ?? 0),
          originalName: String(object.originalName ?? ''),
          uploadedAt: this.normalizeIsoDate(object.uploadedAt),
        }
      }
    }

    const cleanUrl = String(fallbackUrl ?? '').split(/[?#]/)[0]
    const match = cleanUrl.match(/^\/uploads\/([^/]+)\/(.+)$/)
    if (!match) return null

    return {
      storageProvider: 'local',
      bucket: match[1],
      key: match[2],
      publicUrl: cleanUrl,
      contentType: 'image/*',
      sizeBytes: 0,
      originalName: '',
      uploadedAt: new Date().toISOString(),
    }
  }

  private applyProfileVisuals<T extends { avatarUrl?: string; bannerUrl?: string; avatarObject?: StoredImageObject | null; bannerObject?: StoredImageObject | null }>(
    entity: T,
    user: UserAccount,
  ) {
    if (user.avatarUrl || user.avatarObject) {
      entity.avatarUrl = user.avatarUrl ?? user.avatarObject?.publicUrl ?? entity.avatarUrl
      entity.avatarObject = user.avatarObject ?? entity.avatarObject
    }

    if (user.bannerUrl || user.bannerObject) {
      entity.bannerUrl = user.bannerUrl ?? user.bannerObject?.publicUrl ?? entity.bannerUrl
      entity.bannerObject = user.bannerObject ?? entity.bannerObject
    }
  }

  private normalizePassword(password: string) {
    const normalized = String(password ?? '').trim()
    if (!normalized) return bcrypt.hashSync(randomUUID(), passwordSaltRounds)
    if (passwordHashPattern.test(normalized)) return normalized
    return bcrypt.hashSync(normalized, passwordSaltRounds)
  }

  private normalizeRefreshSessions(sessions: RefreshSession[], users: UserAccount[]): RefreshSession[] {
    const now = Date.now()
    const userIds = new Set(users.map((user) => user.id))

    return sessions
      .filter((session) =>
        userIds.has(session.userId) &&
        passwordHashPattern.test(session.tokenHash) === false &&
        new Date(session.expiresAt).getTime() > now &&
        !session.revokedAt,
      )
      .map((session) => ({
        id: this.ensureUuid(session.id),
        userId: session.userId,
        tokenHash: String(session.tokenHash),
        createdAt: this.normalizeIsoDate(session.createdAt),
        expiresAt: this.normalizeIsoDate(session.expiresAt),
        rotatedFromId: session.rotatedFromId,
        userAgent: session.userAgent,
        ip: session.ip,
      }))
  }

  private normalizeNotifications(notifications: AppNotification[], notificationMap: Map<string, string>, userMap: Map<string, string>, users: UserAccount[]): AppNotification[] {
    const userIds = new Set(users.map((user) => user.id))

    return notifications
      .map((notification) => {
        const userId = this.remapOptionalId(notification.userId, userMap) ?? ''
        const tone = notification.tone === 'danger' || notification.tone === 'warning' || notification.tone === 'info'
          ? notification.tone
          : 'info'
        const sourceType = notification.sourceType === 'student-risk' || notification.sourceType === 'system'
          ? notification.sourceType
          : 'system'
        const readAt = String(notification.readAt ?? '').trim()

        return {
          id: this.remapId(notification.id, notificationMap),
          userId,
          title: String(notification.title ?? '').trim(),
          description: String(notification.description ?? '').trim(),
          tone,
          sourceType,
          sourceId: String(notification.sourceId ?? '').trim(),
          readAt: readAt ? this.normalizeIsoDate(readAt) : null,
          createdAt: this.normalizeIsoDate(notification.createdAt),
          updatedAt: this.normalizeIsoDate(notification.updatedAt),
        }
      })
      .filter((notification) => userIds.has(notification.userId) && Boolean(notification.title))
  }

  private normalizeTeacher(teacher: Partial<Teacher>): Teacher {
    const id = this.ensureUuid(teacher.id)

    return {
      id,
      userId: this.ensureUuid(teacher.userId),
      name: String(teacher.name ?? 'Professor sem nome').trim(),
      email: String(teacher.email ?? '').trim().toLowerCase(),
      schoolId: String(teacher.schoolId ?? '').trim(),
      specialty: String(teacher.specialty ?? 'Area nao informada').trim(),
      active: teacher.active ?? true,
    }
  }

  private normalizeGuardian(guardian: Partial<Guardian>): Guardian {
    const id = this.ensureUuid(guardian.id)

    return {
      id,
      userId: this.ensureUuid(guardian.userId),
      name: String(guardian.name ?? 'Responsavel sem nome').trim(),
      email: String(guardian.email ?? `${id}@responsavel.liensina.com`).trim().toLowerCase(),
      role: 'RESPONSAVEL',
      schoolId: String(guardian.schoolId ?? '').trim(),
      phone: String(guardian.phone ?? '').trim(),
      studentIds: Array.isArray(guardian.studentIds) ? guardian.studentIds : [],
    }
  }

  private normalizeStudent(student: Partial<Student>, schoolMap: Map<string, School>): Student {
    const schoolId = String(student.schoolId ?? '').trim()
    const registrationNumber = String(student.registrationNumber ?? student.registration ?? this.nextRegistrationNumber()).trim()
    const school = schoolMap.get(schoolId)
    const id = this.ensureUuid(student.id)
    const login = String(student.login ?? `${school?.inepCode ?? schoolId}-${registrationNumber}`).trim()

    return {
      id,
      userId: this.ensureUuid(student.userId),
      name: String(student.name ?? 'Aluno sem nome').trim(),
      login,
      role: 'ALUNO',
      registration: registrationNumber,
      registrationNumber,
      schoolId,
      classId: String(student.classId ?? ''),
      guardianIds: Array.isArray(student.guardianIds) ? student.guardianIds : [],
      status: student.status ?? 'matriculado',
      attendanceRate: Number(student.attendanceRate ?? 100),
      averageScore: Number(student.averageScore ?? 0),
      desempenho: student.desempenho ?? 'Otimo',
    }
  }

  private normalizeClassRoom(classRoom: Partial<ClassRoom>): ClassRoom {
    const teacherId = String(classRoom.teacherId ?? classRoom.teacherIds?.[0] ?? '')
    const teacherIds = Array.from(new Set([teacherId, ...(classRoom.teacherIds ?? [])].filter(Boolean)))

    return {
      id: this.ensureUuid(classRoom.id),
      name: String(classRoom.name ?? 'Turma sem nome').trim(),
      grade: this.normalizeClassGrade(classRoom.grade),
      shift: classRoom.shift ?? 'Manha',
      schoolId: String(classRoom.schoolId ?? '').trim(),
      teacherId,
      teacherIds,
      academicYear: Number(classRoom.academicYear ?? new Date().getFullYear()),
      schedule: String(classRoom.schedule ?? '').trim(),
      bnccFocus: Array.isArray(classRoom.bnccFocus) ? classRoom.bnccFocus : [],
    }
  }

  private normalizeLessonRecords(records: Partial<LessonRecord>[], classIds: Set<string>): LessonRecord[] {
    return records
      .map((record) => ({
        id: this.ensureUuid(record.id),
        classId: String(record.classId ?? '').trim(),
        subject: String(record.subject ?? '').trim(),
        date: this.normalizeNullableDate(record.date) ?? new Date().toISOString().slice(0, 10),
        time: String(record.time ?? '').trim(),
        content: String(record.content ?? '').trim(),
        plan: String(record.plan ?? '').trim(),
        resources: String(record.resources ?? '').trim(),
        activity: String(record.activity ?? '').trim(),
        notes: String(record.notes ?? '').trim(),
      }))
      .filter((record) => classIds.has(record.classId) && Boolean(record.subject || record.content))
  }

  private normalizeRoomReservations(records: Partial<RoomReservation>[], classIds: Set<string>): RoomReservation[] {
    return records
      .map((record) => ({
        id: this.ensureUuid(record.id),
        room: String(record.room ?? '').trim(),
        date: this.normalizeNullableDate(record.date) ?? new Date().toISOString().slice(0, 10),
        startTime: this.normalizeReservationTime(record.startTime, '07:00'),
        endTime: this.normalizeReservationTime(record.endTime, '07:30'),
        classId: String(record.classId ?? '').trim(),
        purpose: String(record.purpose ?? '').trim(),
      }))
      .filter((record) => (
        classIds.has(record.classId) &&
        Boolean(record.room) &&
        record.endTime > record.startTime
      ))
  }

  private normalizeReservationTime(value: unknown, fallback: string) {
    const time = String(value ?? '').trim()
    if (!/^\d{2}:\d{2}$/.test(time)) return fallback

    const [hour, minute] = time.split(':').map(Number)
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return fallback
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback

    return time
  }

  private normalizeClassGrade(value?: string | null) {
    const current = String(value ?? '').trim()
    const direct = current.toUpperCase()
    if (/^EF[1-9]$/.test(direct) || /^EM[1-3]$/.test(direct)) return direct

    const normalized = current
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[º°]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .toUpperCase()
    const year = Number(normalized.match(/\b([1-9])\b/)?.[1] ?? 0)

    if (year >= 1 && year <= 3 && normalized.includes('MEDIO')) return `EM${year}`
    if (year >= 1 && year <= 9 && (normalized.includes('FUNDAMENTAL') || normalized.includes('ANO'))) return `EF${year}`

    return current
  }

  private mergeMealFoodCatalog(catalog: MealFood[], managements: MealManagement[]) {
    const merged = this.normalizeMealFoods(catalog)
    const seen = new Set(merged.map((food) => this.normalizeMealFoodName(food.nome)))
    let nextId = Math.max(0, ...merged.map((food) => food.id))

    for (const management of managements) {
      for (const food of management.alimentosCadastrados ?? []) {
        const key = this.normalizeMealFoodName(food.nome)
        if (!key || seen.has(key)) continue

        nextId += 1
        const [normalized] = this.normalizeMealFoods([{ ...food, id: nextId }])
        merged.push(normalized)
        seen.add(key)
      }
    }

    return merged
  }

  private normalizeMealFoodName(value: unknown) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
  }

  private normalizeMealManagements(
    managements: MealManagement[],
    managementMap: Map<string, string>,
    schoolMap: Map<string, string>,
    userMap: Map<string, string>,
    mealFoods: MealFood[],
  ): MealManagement[] {
    const globalFoodByKey = new Map(mealFoods.map((food) => [this.normalizeMealFoodName(food.nome), food]))

    return managements.map((management) => {
      const rawItems = management.itensMerenda ?? []
      const rawStock = management.estoqueMerenda ?? []
      const rawMovements = management.movimentacoesOrcamento ?? []
      const rawMenus = management.cardapios ?? []
      const itemMap = this.createUuidMap(rawItems)
      const stockMap = this.createUuidMap(rawStock)
      const movementMap = this.createUuidMap(rawMovements)
      const menuMap = this.createUuidMap(rawMenus)
      const supplierMap = this.createUuidMap(rawItems.map((item) => item.fornecedor ?? {}))
      const budget = management.orcamentoMensal
      const budgetLimit = Number(budget?.valorLimite ?? 0)
      const alertPercent = Number(budget?.alertaAoAtingirPercentual ?? 80)

      const foodIdMap = new Map<number, number>()
      const foods = this.normalizeMealFoods(management.alimentosCadastrados ?? []).map((food) => {
        const globalFood = globalFoodByKey.get(this.normalizeMealFoodName(food.nome)) ?? food
        foodIdMap.set(food.id, globalFood.id)
        return globalFood
      }).filter((food, index, list) => list.findIndex((item) => item.id === food.id) === index)
      const foodById = new Map(foods.map((food) => [food.id, food]))
      const remapMealFoodId = (value: unknown, fallback: number) => {
        const foodId = this.normalizeMealFoodId(value, fallback)
        return foodIdMap.get(foodId) ?? foodId
      }
      const menus = rawMenus.map((menu, index) => {
        const foodIds = Array.isArray(menu.alimentoIds)
          ? menu.alimentoIds
              .map((foodId, foodIndex) => remapMealFoodId(foodId, foodIndex + 1))
              .filter((foodId) => foodById.has(foodId))
          : []

        return {
          ...menu,
          id: this.remapId(menu.id, menuMap),
          diaSemana: this.normalizeWeekday(menu.diaSemana, index),
          tipoRefeicao: this.normalizeMealType(menu.tipoRefeicao),
          turno: this.normalizeMealShift(menu.turno),
          titulo: String(menu.titulo ?? 'Cardapio da merenda').trim(),
          alimentoIds: Array.from(new Set(foodIds)),
          observacao: menu.observacao ? String(menu.observacao).trim() : undefined,
          status: this.normalizeMealMenuStatus(menu.status),
        }
      })

      const items = rawItems.map((item) => {
        const foodId = remapMealFoodId(item.alimentoId, 1)
        const food = foodById.get(foodId)
        const quantity = Number(item.quantidade ?? 0)
        const unitPrice = Number(item.valorUnitario ?? 0)
        const total = Number((quantity * unitPrice).toFixed(2))
        const validade = this.normalizeNullableDate(item.dataValidade)

        return {
          ...item,
          id: this.remapId(item.id, itemMap),
          alimentoId: foodId,
          nomeAlimento: food?.nome ?? String(item.nomeAlimento ?? 'Alimento'),
          categoria: food?.categoria ?? String(item.categoria ?? 'OUTROS'),
          quantidade: quantity,
          unidadeMedida: food?.unidadeMedida ?? this.normalizeMealUnit(item.unidadeMedida),
          valorUnitario: unitPrice,
          valorTotal: total,
          dataValidade: validade,
          possuiValidade: Boolean(validade ?? item.possuiValidade),
          lote: item.lote ? String(item.lote).trim() : null,
          fornecedor: {
            id: this.remapId(item.fornecedor?.id, supplierMap),
            nome: String(item.fornecedor?.nome ?? 'Fornecedor nao informado').trim(),
          },
          statusEstoque: this.normalizeMealStockStatus(item.statusEstoque, quantity, 0, validade),
          adicionadoPorId: this.remapId(item.adicionadoPorId, userMap),
          adicionadoEm: this.normalizeIsoDate(item.adicionadoEm),
        }
      })

      const stock = rawStock.map((stockItem) => {
        const quantity = Number(stockItem.quantidadeAtual ?? 0)
        const minimum = Number(stockItem.quantidadeMinima ?? 0)
        const validade = this.normalizeNullableDate(stockItem.dataValidade)

        return {
          ...stockItem,
          id: this.remapId(stockItem.id, stockMap),
          itemMerendaId: this.remapId(stockItem.itemMerendaId, itemMap),
          alimentoId: remapMealFoodId(stockItem.alimentoId, 1),
          nomeAlimento: String(stockItem.nomeAlimento ?? 'Alimento'),
          quantidadeAtual: quantity,
          quantidadeMinima: minimum,
          unidadeMedida: this.normalizeMealUnit(stockItem.unidadeMedida),
          dataValidade: validade,
          status: this.normalizeMealStockStatus(stockItem.status, quantity, minimum, validade),
        }
      })

      const movements = rawMovements.map((movement) => ({
        ...movement,
        id: this.remapId(movement.id, movementMap),
        tipo: movement.tipo === 'AJUSTE' ? 'AJUSTE' as const : 'COMPRA' as const,
        itemMerendaId: this.remapId(movement.itemMerendaId, itemMap),
        descricao: String(movement.descricao ?? 'Movimentacao de merenda').trim(),
        valor: Number(movement.valor ?? 0),
        saldoAntes: Number(movement.saldoAntes ?? budgetLimit),
        saldoDepois: Number(movement.saldoDepois ?? budgetLimit),
        responsavelId: this.remapId(movement.responsavelId, userMap),
        dataMovimentacao: this.normalizeIsoDate(movement.dataMovimentacao),
      }))

      return this.recalculateMealManagement({
        ...management,
        id: this.remapId(management.id, managementMap),
        escolaId: this.remapId(management.escolaId, schoolMap),
        mesReferencia: this.normalizeReferenceMonth(management.mesReferencia),
        status: management.status ?? 'ATIVO',
        orcamentoMensal: {
          id: this.ensureUuid(budget?.id),
          valorLimite: budgetLimit,
          valorUtilizado: Number(budget?.valorUtilizado ?? 0),
          valorDisponivel: Number(budget?.valorDisponivel ?? budgetLimit),
          percentualUtilizado: Number(budget?.percentualUtilizado ?? 0),
          status: this.normalizeMealBudgetStatus(budget?.status),
          alertaAoAtingirPercentual: alertPercent,
          permitirUltrapassarLimite: Boolean(budget?.permitirUltrapassarLimite),
        },
        responsaveisGestao: {
          diretorId: this.remapId(management.responsaveisGestao?.diretorId, userMap),
          nutricionistaId: this.remapId(management.responsaveisGestao?.nutricionistaId, userMap),
          merendeiroId: this.remapId(management.responsaveisGestao?.merendeiroId, userMap),
          responsavelFinanceiroId: this.remapId(management.responsaveisGestao?.responsavelFinanceiroId, userMap),
        },
        alimentosCadastrados: foods,
        cardapios: menus,
        itensMerenda: items,
        movimentacoesOrcamento: movements,
        estoqueMerenda: stock,
        resumo: management.resumo,
      })
    })
  }

  private normalizeMealFoodRequests(
    requests: MealFoodRequest[],
    requestMap: Map<string, string>,
    schoolMap: Map<string, string>,
    userMap: Map<string, string>,
  ): MealFoodRequest[] {
    return requests.map((request) => {
      const createdAt = this.normalizeIsoDate(request.createdAt)
      return {
        ...request,
        id: this.remapId(request.id, requestMap),
        schoolId: this.remapId(request.schoolId, schoolMap),
        requestedBy: this.remapId(request.requestedBy, userMap),
        itemName: String(request.itemName ?? 'Alimento').trim(),
        quantity: Math.max(0, Number(request.quantity ?? 0)),
        unit: this.normalizeMealUnit(request.unit),
        unitPrice: request.unitPrice === undefined || request.unitPrice === null ? null : Math.max(0, Number(request.unitPrice)),
        reason: String(request.reason ?? '').trim(),
        urgencyLevel: this.normalizeFoodRequestUrgency(request.urgencyLevel),
        expirationDate: this.normalizeNullableDate(request.expirationDate),
        observation: request.observation ? String(request.observation).trim() : null,
        status: this.normalizeFoodRequestStatus(request.status),
        reviewedBy: this.remapNullableId(request.reviewedBy, userMap),
        reviewedAt: request.reviewedAt ? this.normalizeIsoDate(request.reviewedAt) : null,
        nutritionistObservation: request.nutritionistObservation ? String(request.nutritionistObservation).trim() : null,
        rejectionReason: request.rejectionReason ? String(request.rejectionReason).trim() : null,
        suggestedQuantity: request.suggestedQuantity === undefined || request.suggestedQuantity === null ? null : Math.max(0, Number(request.suggestedQuantity)),
        suggestedUnit: request.suggestedUnit ? this.normalizeMealUnit(request.suggestedUnit) : null,
        suggestedUnitPrice: request.suggestedUnitPrice === undefined || request.suggestedUnitPrice === null ? null : Math.max(0, Number(request.suggestedUnitPrice)),
        confirmedBy: this.remapNullableId(request.confirmedBy, userMap),
        confirmedAt: request.confirmedAt ? this.normalizeIsoDate(request.confirmedAt) : null,
        supplierName: request.supplierName ? String(request.supplierName).trim() : null,
        purchaseValue: request.purchaseValue === undefined || request.purchaseValue === null ? null : Number(request.purchaseValue),
        purchaseDate: this.normalizeNullableDate(request.purchaseDate),
        stockItemId: request.stockItemId ? this.ensureUuid(request.stockItemId) : null,
        createdAt,
        updatedAt: request.updatedAt ? this.normalizeIsoDate(request.updatedAt) : createdAt,
      }
    })
  }

  private normalizeMealRequestHistory(
    history: MealRequestHistory[],
    historyMap: Map<string, string>,
    requestMap: Map<string, string>,
    schoolMap: Map<string, string>,
    userMap: Map<string, string>,
    roles: Role[],
  ): MealRequestHistory[] {
    return history.map((entry) => ({
      ...entry,
      id: this.remapId(entry.id, historyMap),
      action: entry.action,
      entityType: entry.entityType === 'MEAL_STOCK' ? 'MEAL_STOCK' : 'FOOD_REQUEST',
      entityId: entry.entityType === 'MEAL_STOCK' ? this.ensureUuid(entry.entityId) : this.remapId(entry.entityId, requestMap),
      userId: this.remapId(entry.userId, userMap),
      userRole: roles.some((role) => role.code === entry.userRole) ? entry.userRole : 'ADMIN',
      schoolId: this.remapId(entry.schoolId, schoolMap),
      description: String(entry.description ?? 'Movimentacao de merenda').trim(),
      createdAt: this.normalizeIsoDate(entry.createdAt),
    }))
  }

  private normalizeMealFoods(foods: MealFood[]) {
    const seen = new Set<number>()

    return foods.map((food, index) => {
      const id = this.normalizeMealFoodId(food.id, index + 1)
      const safeId = seen.has(id) ? index + 1 : id
      seen.add(safeId)

      return {
        ...food,
        id: safeId,
        nome: String(food.nome ?? 'Alimento').trim(),
        categoria: String(food.categoria ?? 'OUTROS').trim().toUpperCase(),
        unidadeMedida: this.normalizeMealUnit(food.unidadeMedida),
        iconKey: String(food.iconKey ?? 'utensils').trim(),
        ativo: food.ativo ?? true,
        criadoEm: this.normalizeIsoDate(food.criadoEm),
      }
    })
  }

  private recalculateMealManagement(management: MealManagement): MealManagement {
    const valorUtilizado = Number(management.itensMerenda.reduce((sum, item) => sum + Number(item.valorTotal ?? 0), 0).toFixed(2))
    const valorLimite = Number(management.orcamentoMensal.valorLimite || 0)
    const valorDisponivel = Number((valorLimite - valorUtilizado).toFixed(2))
    const percentualUtilizado = valorLimite > 0 ? Number(((valorUtilizado / valorLimite) * 100).toFixed(2)) : 0
    const status = this.resolveMealBudgetStatus(percentualUtilizado, valorDisponivel, management.orcamentoMensal.alertaAoAtingirPercentual)

    return {
      ...management,
      orcamentoMensal: {
        ...management.orcamentoMensal,
        valorUtilizado,
        valorDisponivel,
        percentualUtilizado,
        status,
      },
      resumo: {
        totalItens: management.itensMerenda.length,
        totalKgComprado: Number(management.itensMerenda
          .filter((item) => item.unidadeMedida === 'KG')
          .reduce((sum, item) => sum + item.quantidade, 0)
          .toFixed(2)),
        valorTotalComprado: valorUtilizado,
        orcamentoInicial: valorLimite,
        orcamentoRestante: valorDisponivel,
        percentualUtilizado,
        statusOrcamento: status,
        itensBaixoEstoque: management.estoqueMerenda.filter((item) => item.status === 'BAIXO').length,
        itensVencidos: management.estoqueMerenda.filter((item) => item.status === 'VENCIDO').length,
      },
    }
  }

  private normalizeMealFoodId(value: unknown, fallback: number) {
    const id = Number(value)
    return Number.isInteger(id) && id > 0 ? id : fallback
  }

  private normalizeMealUnit(value: unknown): MealUnit {
    const unit = String(value ?? '').trim().toUpperCase()
    if (unit === 'UN') return 'UNIT'
    if (unit === 'KG' || unit === 'G' || unit === 'L' || unit === 'ML' || unit === 'UNIT' || unit === 'BOX' || unit === 'PACKAGE' || unit === 'DOZEN') return unit
    return 'KG'
  }

  private normalizeFoodRequestStatus(value: unknown): FoodRequestStatus {
    const status = String(value ?? '').trim().toUpperCase()
    if (
      status === 'PENDING_NUTRITIONIST_APPROVAL'
      || status === 'APPROVED_BY_NUTRITIONIST'
      || status === 'REJECTED_BY_NUTRITIONIST'
      || status === 'NEEDS_ADJUSTMENT'
      || status === 'PENDING_PURCHASE'
      || status === 'PURCHASED'
      || status === 'ADDED_TO_STOCK'
      || status === 'CANCELLED'
    ) return status
    return 'PENDING_NUTRITIONIST_APPROVAL'
  }

  private normalizeFoodRequestUrgency(value: unknown) {
    const urgency = String(value ?? '').trim().toUpperCase()
    if (urgency === 'LOW' || urgency === 'MEDIUM' || urgency === 'HIGH' || urgency === 'URGENT') return urgency
    return 'MEDIUM'
  }

  private normalizeMealType(value: unknown): 'CAFE_DA_MANHA' | 'LANCHE' | 'ALMOCO' | 'JANTAR' {
    const type = String(value ?? '').trim().toUpperCase()
    if (type === 'CAFE_DA_MANHA' || type === 'ALMOCO' || type === 'JANTAR') return type
    return 'LANCHE'
  }

  private normalizeMealShift(value: unknown): 'MANHA' | 'TARDE' | 'NOITE' | 'INTEGRAL' {
    const shift = String(value ?? '').trim().toUpperCase()
    if (shift === 'TARDE' || shift === 'NOITE' || shift === 'INTEGRAL') return shift
    return 'MANHA'
  }

  private normalizeMealStockStatus(value: unknown, quantity: number, minimum: number, validity?: string | null): MealStockStatus {
    const status = String(value ?? '').trim().toUpperCase()
    if (status === 'DESCARTADO') return 'DESCARTADO'
    if (validity && new Date(`${validity}T00:00:00.000Z`) < new Date()) return 'VENCIDO'
    if (quantity <= minimum) return 'BAIXO'
    return status === 'BAIXO' || status === 'VENCIDO' ? status : 'DISPONIVEL'
  }

  private normalizeMealMenuStatus(value: unknown): MealMenuStatus {
    const status = String(value ?? '').trim().toUpperCase()
    if (status === 'RASCUNHO' || status === 'CANCELADO') return status
    return 'APROVADO'
  }

  private normalizeMealBudgetStatus(value: unknown): MealBudgetStatus {
    const status = String(value ?? '').trim().toUpperCase()
    if (status === 'EM_ALERTA' || status === 'ULTRAPASSADO') return status
    return 'DENTRO_DO_LIMITE'
  }

  private resolveMealBudgetStatus(percentualUtilizado: number, valorDisponivel: number, alertPercent: number): MealBudgetStatus {
    if (valorDisponivel < 0) return 'ULTRAPASSADO'
    if (percentualUtilizado >= alertPercent) return 'EM_ALERTA'
    return 'DENTRO_DO_LIMITE'
  }

  private normalizeReferenceMonth(value: unknown) {
    const month = String(value ?? '').trim()
    return /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7)
  }

  private normalizeWeekday(value: unknown, index: number) {
    const weekday = String(value ?? '').trim()
    const fallback = ['Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta'][index % 5]
    return weekday || fallback
  }

  private normalizeNullableDate(value: unknown) {
    const date = String(value ?? '').trim()
    if (!date) return null
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
  }

  private normalizeIsoDate(value: unknown) {
    const date = new Date(String(value ?? ''))
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
  }

  private mergeUser(current: UserAccount | undefined, fallback: UserAccount): UserAccount {
    return {
      ...fallback,
      ...current,
      roleId: fallback.roleId,
      schoolId: fallback.schoolId,
      linkedTeacherId: fallback.linkedTeacherId ?? current?.linkedTeacherId,
      linkedStudentId: fallback.linkedStudentId ?? current?.linkedStudentId,
      linkedGuardianId: fallback.linkedGuardianId ?? current?.linkedGuardianId,
      login: current?.login ?? fallback.login,
      password: this.normalizePassword(current?.password ?? fallback.password),
    }
  }

  private normalizeRoleId(roleId: string, roles: Role[]) {
    const id = String(roleId ?? '').trim()
    if (!roles.length) return id
    const legacyCode = this.roleCodeFromLegacyId(id)
    if (legacyCode) return this.getRoleIdFromCode(roles, legacyCode)
    return roles.some((role) => role.id === id) ? id : this.getRoleIdFromCode(roles, 'ADMIN')
  }

  private roleCodeFromLegacyId(roleId: string): RoleCode | null {
    const legacy: Record<string, RoleCode> = {
      'role-admin': 'ADMIN',
      'role-secretaria': 'ADMIN',
      'role-diretor': 'DIRETOR',
      'role-coordenador': 'COORDENADOR',
      'role-apoio': 'COORDENADOR',
      'role-professor': 'PROFESSOR',
      'role-aluno': 'ALUNO',
      'role-responsavel': 'RESPONSAVEL',
      'role-nutritionist': 'NUTRITIONIST',
      'role-nutricionista': 'NUTRITIONIST',
      Secretaria: 'ADMIN',
      Diretor: 'DIRETOR',
      Professor: 'PROFESSOR',
      ADMIN: 'ADMIN',
      DIRETOR: 'DIRETOR',
      COORDENADOR: 'COORDENADOR',
      PROFESSOR: 'PROFESSOR',
      ALUNO: 'ALUNO',
      RESPONSAVEL: 'RESPONSAVEL',
      NUTRITIONIST: 'NUTRITIONIST',
      NUTRICIONISTA: 'NUTRITIONIST',
    }

    return legacy[roleId] ?? null
  }

  private nextRegistrationNumber() {
    return String(new Date().getFullYear()) + String(Date.now()).slice(-5)
  }

  private createStableId(prefix: string, value: string) {
    const normalized = value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)

    return `${prefix}-${normalized || 'item'}`
  }

  private persist() {
    if (this.databaseConfig.driver === 'postgres') {
      this.pendingPersist = this.pendingPersist
        .then(() => this.persistPostgresNow())
        .catch((error: unknown) => {
          this.logger.error('Falha ao persistir dados no PostgreSQL.', error instanceof Error ? error.stack : String(error))
        })
      return
    }

    this.ensureSchema()
    this.db?.run('BEGIN TRANSACTION')
    this.db?.run('DELETE FROM collections')

    const statement = this.db?.prepare('INSERT INTO collections (name, payload, updated_at) VALUES (?, ?, ?)')
    const updatedAt = new Date().toISOString()

    for (const collection of databaseCollections) {
      statement?.run([collection, JSON.stringify(this.data[collection] ?? []), updatedAt])
    }

    statement?.free()
    this.db?.run('COMMIT')
    if (this.db) writeFileSync(this.databasePath, Buffer.from(this.db.export()))
  }

  private async persistPostgresNow() {
    if (!this.pool) throw new Error('Pool PostgreSQL nao inicializado.')

    const client = await this.pool.connect()
    const updatedAt = new Date()

    try {
      await client.query('BEGIN')
      for (const collection of databaseCollections) {
        await client.query(
          `
            INSERT INTO collections (name, payload, updated_at)
            VALUES ($1, $2::jsonb, $3)
            ON CONFLICT (name)
            DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
          `,
          [collection, JSON.stringify(this.data[collection] ?? []), updatedAt],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
