import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import * as bcrypt from 'bcryptjs'
import sharp from 'sharp'

import { DatabaseService } from './database.service'
import { writeEvaluationAnswerCardsPdfFile, writeEvaluationAnswerKeyPdfFile, writeEvaluationPdfFile } from './evaluation-pdf'
import { EvaluationAnswerCardCreationService, EvaluationQrCodeService } from './evaluation-answer-card.services'
import type { AddMealFoodRequestToStockPayload, AppNotification, AssessmentDescriptor, AssessmentMatrix, AssessmentProgram, CalendarEventType, ClassRoom, CreateMealFoodPayload, CreateMealFoodRequestPayload, CreateMealItemPayload, CreateMealManagementPayload, CreateQuestionRequest, DatabaseShape, Difficulty, EducationStage, Evaluation, EvaluationAnswerCard, EvaluationAnswerKeyItem, EvaluationBuildMode, EvaluationCorrection, EvaluationCorrectionDetectedAnswer, EvaluationCorrectionReviewPayload, FoodRequestStatus, GenerateEnemQuestionsRequest, GenerateEnemQuestionsResponse, GenerateQuestionSelectionRequest, GenerateQuestionSelectionResponse, Guardian, JwtPayload, LessonRecord, MealFood, MealFoodRequest, MealManagement, MealMenu, MealMenuStatus, MealRequestHistory, MealRequestHistoryAction, MealShift, MealStockStatus, MealType, MealUnit, NotificationsScreenPayload, PublicUserAccount, Question, QuestionDescriptorSummary, QuestionSourceType, QuestionStatus, QuestionType, QuestionVisibility, RefreshSession, ReviewMealFoodRequestPayload, Role, RoleCode, RoomReservation, School, SchoolCalendarEvent, StoredImageObject, Student, Teacher, UpdateMealBudgetPayload, UpdateMealFoodRequestPayload, UpsertMealMenuPayload, UserAccount } from './liensina.types'

type ProfileImageFile = {
  buffer: Buffer
  originalname: string
  mimetype: string
  size: number
}

type OmrImageFile = ProfileImageFile

type OmrServiceAnswer = EvaluationCorrectionDetectedAnswer
type OmrServiceResponse = {
  examId: string
  versionId: string
  answerCardId?: string | null
  studentId?: string | null
  classId?: string | null
  suggestedScore: number
  correctCount: number
  wrongCount: number
  blankCount: number
  multipleCount: number
  totalQuestions: number
  confidence: number
  requiresReview: boolean
  shouldRetakeImage: boolean
  failures: string[]
  detectedAnswers: OmrServiceAnswer[]
  [key: string]: unknown
}

type OmrBatchIssue = {
  fileName: string
  page: number | null
  reason: string
}

type OmrResolvedTarget = {
  student: Student
  answerCard: EvaluationAnswerCard | null
  cardId: string | null
}

export type AuthContext = {
  userAgent?: string
  ip?: string
}

const passwordHashPattern = /^\$2[aby]\$\d{2}\$/
const passwordSaltRounds = 12
const enemApiBaseUrl = 'https://api.enem.dev/v1/exams'
const defaultEnemYears = Array.from({ length: 2023 - 2009 + 1 }, (_, index) => 2009 + index)
const enemQuestionPageLimit = 50
const defaultMealBudgetLimit = 30000
const defaultMealBudgetAlertPercent = 80
const enemMarkdownImagePattern = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi
const forbiddenRolePermissions: Partial<Record<RoleCode, string[]>> = {
  DIRETOR: ['auditoria:ler', 'food.audit.view'],
}
const validRoleCodes = new Set<RoleCode>(['SUPERADMIN', 'ADMIN', 'ADMIN_ESCOLA', 'DIRETOR', 'COORDENADOR', 'PROFESSOR', 'ALUNO', 'RESPONSAVEL', 'NUTRITIONIST'])
const maxProfileImagePixels = 16_000_000
const maxStoredOmrImagePixels = 24_000_000
const maxProfileImageDimension = 2048
const maxStoredOmrImageDimension = 4096
const maxOmrBatchTotalBytes = 64 * 1024 * 1024
const maxRemoteQuestionImageBytes = 2 * 1024 * 1024

type EnemDevAlternative = {
  letter?: string
  text?: string
  file?: string | null
  isCorrect?: boolean
}

type EnemDevQuestion = {
  title?: string
  index?: number
  discipline?: string
  language?: string | null
  year?: number
  context?: string
  files?: string[]
  correctAlternative?: string
  alternativesIntroduction?: string
  alternatives?: EnemDevAlternative[]
}

type EnemDevQuestionPage = {
  metadata?: {
    limit?: number
    offset?: number
    total?: number
    hasMore?: boolean
  }
  questions?: EnemDevQuestion[]
}

type DownloadedQuestionImage = {
  dataUrl: string
  mimeType: string
  sizeBytes: number
}

type EvaluationDownloadFile = {
  filePath: string
  filename: string
  contentType: string
}
type EvaluationDownloadKind = 'complete' | 'answer_cards' | 'answer_key'

type SafeStoredFile = {
  buffer: Buffer
  contentType: string
  extension: string
  sizeBytes: number
}

function parseDurationSeconds(value: string | undefined, fallback: number) {
  const match = String(value ?? '').trim().match(/^(\d+)(s|m|h|d)?$/i)
  if (!match) return fallback

  const amount = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  if (unit === 'd') return amount * 24 * 60 * 60
  if (unit === 'h') return amount * 60 * 60
  if (unit === 'm') return amount * 60
  return amount
}

@Injectable()
export class LiensinaService {
  private readonly calendarEventTypes = new Set<CalendarEventType>(['aula', 'reuniao', 'avaliacao', 'prazo', 'evento'])
  private readonly answerCardCreationService = new EvaluationAnswerCardCreationService()
  private readonly qrCodeService = new EvaluationQrCodeService()
  private omrCircuitOpenUntil = 0
  private omrFailureCount = 0

  constructor(
    private readonly database: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private readDataForQuery() {
    const database = this.database as DatabaseService & { readForQuery?: () => DatabaseShape }
    return typeof database.readForQuery === 'function' ? database.readForQuery() : this.database.read()
  }

  async login(email: string, password: string, context: AuthContext = {}) {
    const normalizedLogin = email.trim().toLowerCase()
    const data = this.readDataForQuery()
    const studentByRegistration = data.students.find((student) => student.registrationNumber.toLowerCase() === normalizedLogin)
    const user = data.users.find((item) =>
      item.email.toLowerCase() === normalizedLogin ||
      item.login?.toLowerCase() === normalizedLogin ||
      (studentByRegistration ? item.linkedStudentId === studentByRegistration.id : false),
    )

    if (!user || !this.isPasswordValid(password, user.password) || user.status !== 'ativo') {
      throw new UnauthorizedException('Credenciais invalidas para o LiEnsina.')
    }

    let refreshToken = ''
    let refreshExpiresAt = ''
    let sessionId = ''
    let publicUser = this.toPublicUserWithResolvedSchool(data, user)

    this.database.update((currentData) => {
      this.removeExpiredRefreshSessions(currentData)
      const storedUser = this.ensureCurrentUser(currentData, user.id)
      if (storedUser.status !== 'ativo') throw new UnauthorizedException('Usuario bloqueado ou inativo.')
      if (!this.isPasswordHash(storedUser.password)) storedUser.password = this.hashPassword(password)

      const refreshSession = this.createRefreshSession(storedUser.id, context)
      currentData.refreshSessions.push(refreshSession.session)
      refreshToken = refreshSession.token
      refreshExpiresAt = refreshSession.session.expiresAt
      sessionId = refreshSession.session.id
      publicUser = this.toPublicUserWithResolvedSchool(currentData, storedUser)
      this.pushAudit(currentData, storedUser.id, 'Login realizado', storedUser.name)
    })

    const accessToken = await this.issueAccessToken(user, sessionId)

    return {
      token: accessToken.token,
      expiresIn: accessToken.expiresIn,
      expiresAt: accessToken.expiresAt,
      refreshToken,
      refreshExpiresAt,
      user: publicUser,
    }
  }

  async refreshLogin(refreshToken: string, context: AuthContext = {}) {
    const refreshPayload = await this.verifyRefreshToken(refreshToken)
    const tokenHash = this.hashRefreshToken(refreshToken)
    let user: UserAccount | null = null
    let publicUser: PublicUserAccount | null = null
    let nextRefreshToken = ''
    let refreshExpiresAt = ''
    let nextSessionId = ''

    this.database.update((data) => {
      this.removeExpiredRefreshSessions(data)
      const session = data.refreshSessions.find((item) =>
        item.tokenHash === tokenHash &&
        item.userId === refreshPayload.sub &&
        item.id === refreshPayload.sid &&
        item.jti === refreshPayload.jti
      )
      if (!session) {
        this.revokeRefreshSessionsForUser(data, refreshPayload.sub)
        throw new UnauthorizedException('Refresh token invalido ou sessao revogada.')
      }
      if (session.revokedAt) {
        this.revokeRefreshSessionsForUser(data, session.userId)
        throw new UnauthorizedException('Refresh token revogado ou reutilizado apos rotacao.')
      }
      if (new Date(session.expiresAt).getTime() <= Date.now()) throw new UnauthorizedException('Refresh token expirado.')

      const storedUser = this.ensureCurrentUser(data, session.userId)
      if (storedUser.status !== 'ativo') throw new UnauthorizedException('Usuario bloqueado ou inativo.')

      session.revokedAt = new Date().toISOString()
      const nextSession = this.createRefreshSession(storedUser.id, context, session.id)
      data.refreshSessions.push(nextSession.session)
      nextRefreshToken = nextSession.token
      refreshExpiresAt = nextSession.session.expiresAt
      nextSessionId = nextSession.session.id
      user = storedUser
      publicUser = this.toPublicUserWithResolvedSchool(data, storedUser)
    })

    if (!user) throw new UnauthorizedException('Usuario nao encontrado.')
    const accessToken = await this.issueAccessToken(user, nextSessionId)

    return {
      token: accessToken.token,
      expiresIn: accessToken.expiresIn,
      expiresAt: accessToken.expiresAt,
      refreshToken: nextRefreshToken,
      refreshExpiresAt,
      user: publicUser ?? this.toPublicUser(user),
    }
  }

  logout(refreshToken: string) {
    if (!refreshToken) return { success: true }
    const tokenHash = this.hashRefreshToken(refreshToken)

    this.database.update((data) => {
      const session = data.refreshSessions.find((item) => item.tokenHash === tokenHash && !item.revokedAt)
      if (session) session.revokedAt = new Date().toISOString()
      this.removeExpiredRefreshSessions(data)
    })

    return { success: true }
  }

  getUserById(userId: string) {
    const user = this.readDataForQuery().users.find((item) => item.id === userId)
    if (!user) throw new UnauthorizedException('Usuario nao encontrado.')
    if (user.status !== 'ativo') throw new UnauthorizedException('Usuario bloqueado ou inativo.')
    return user
  }

  getSession(userId: string) {
    const data = this.syncNotificationsForUser(userId)
    const currentUser = this.ensureCurrentUser(data, userId)

    return {
      currentUser: this.toPublicUserWithResolvedSchool(data, currentUser),
      currentRole: data.roles.find((role) => role.id === currentUser.roleId) ?? null,
      alertCount: this.getUnreadNotificationCount(data, userId),
    }
  }

  getDashboardScreen(userId: string, alertPage: string | number = 1, alertLimit: string | number = 10) {
    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const scopedClassIds = new Set(scoped.classes.map((classRoom) => classRoom.id))
    const scopedEvaluations = data.evaluations.filter((evaluation) => (
      scopedClassIds.has(evaluation.classId) || this.canAccessEvaluation(data, currentUser, evaluation)
    ))
    const dashboardData = {
      ...data,
      users: this.getScopedUsers(data, currentUser),
      schools: scoped.schools,
      classes: scoped.classes,
      teachers: scoped.teachers,
      students: scoped.students,
      guardians: scoped.guardians,
      evaluations: scopedEvaluations,
    }

    return {
      dashboard: this.buildDashboard(dashboardData, alertPage, alertLimit),
      evaluations: scopedEvaluations.map((evaluation) => this.dashboardEvaluationDto(evaluation)),
      auditEvents: this.getScopedAuditEvents(data, currentUser).slice(0, 25),
    }
  }

  getSchoolsScreen(userId: string) {
    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const scopedData = this.getScopedDatabaseView(data, currentUser)

    return {
      schools: scopedData.schools,
      teachers: scopedData.teachers,
      guardians: scopedData.guardians,
      students: scopedData.students,
      classes: scopedData.classes,
      lessonRecords: scopedData.lessonRecords,
      roomReservations: scopedData.roomReservations,
    }
  }

  listRoomReservations(userId: string) {
    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const schoolIds = new Set(scoped.schools.map((school) => school.id))
    const schoolByClassId = new Map(data.classes.map((classRoom) => [classRoom.id, classRoom.schoolId]))

    return data.roomReservations.filter((reservation) => {
      const reservationSchoolId = schoolByClassId.get(reservation.classId)
      return reservationSchoolId ? schoolIds.has(reservationSchoolId) : false
    })
  }

  listLessonRecords(userId: string) {
    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const classIds = new Set(scoped.classes.map((classRoom) => classRoom.id))

    return data.lessonRecords.filter((record) => classIds.has(record.classId))
  }

  listTeachersPage(
    userId: string,
    rawPage: string | number = 1,
    rawLimit: string | number = 10,
    search = '',
    schoolId = 'all',
    discipline = 'all',
  ) {
    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const query = this.normalizeTextKey(search)
    const schoolFilter = String(schoolId ?? 'all').trim()
    const disciplineFilter = this.normalizeTextKey(discipline === 'all' ? '' : discipline)

    const teachers = scoped.teachers.filter((teacher) => {
      if (schoolFilter && schoolFilter !== 'all' && teacher.schoolId !== schoolFilter) return false
      if (disciplineFilter) {
        const specialty = this.normalizeTextKey(teacher.specialty)
        if (!specialty.includes(disciplineFilter) && !disciplineFilter.includes(specialty)) return false
      }
      if (!query) return true

      return this.normalizeTextKey(`${teacher.name} ${teacher.email} ${teacher.specialty}`).includes(query)
    })

    const page = this.paginate(teachers, rawPage, rawLimit, 10)

    return {
      teachers: page.items,
      pagination: page.pagination,
    }
  }

  listStudentsPage(
    userId: string,
    rawPage: string | number = 1,
    rawLimit: string | number = 10,
    search = '',
    schoolId = 'all',
    discipline = 'all',
    _classId = 'all',
    view = 'default',
  ) {
    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const query = this.normalizeTextKey(search)
    const schoolFilter = String(schoolId ?? 'all').trim()
    const disciplineFilter = this.normalizeTextKey(discipline === 'all' ? '' : discipline)
    const disciplineClassIds = new Set(scoped.classes
      .filter((classRoom) => {
        if (!disciplineFilter) return true
        return (classRoom.bnccFocus ?? []).some((focus) => this.normalizeTextKey(focus).includes(disciplineFilter))
      })
      .map((classRoom) => classRoom.id))

    const students = scoped.students.filter((student) => {
      if (schoolFilter && schoolFilter !== 'all' && student.schoolId !== schoolFilter) return false
      if (disciplineFilter && !disciplineClassIds.has(student.classId)) return false
      if (!query) return true

      return this.normalizeTextKey(`${student.name} ${student.login} ${student.registrationNumber} ${student.registration}`).includes(query)
    })

    const page = this.paginate(students, rawPage, rawLimit, 10)

    const studentsPage = String(view) === 'identity'
      ? page.items.map((student) => ({ id: student.id, name: student.name, schoolId: student.schoolId, classId: student.classId }))
      : page.items

    return {
      students: studentsPage,
      pagination: page.pagination,
    }
  }

  listTeacherSubjectCardsPage(userId: string, rawPage: string | number = 1, rawLimit: string | number = 6) {
    const data = this.readDataForQuery()
    const actor = this.ensureCurrentUser(data, userId)
    const scoped = this.getScopedSchoolsData(data, actor)
    const subjects = new Map<string, { subject: string; classes: ClassRoom[] }>()
    const addSubject = (subject: string, classRoom?: ClassRoom) => {
      const cleanSubject = String(subject ?? '').trim()
      if (!cleanSubject) return
      const key = this.normalizeTextKey(cleanSubject)
      const current = subjects.get(key) ?? { subject: cleanSubject, classes: [] }
      if (classRoom && !current.classes.some((item) => item.id === classRoom.id)) current.classes.push(classRoom)
      subjects.set(key, current)
    }

    for (const classRoom of scoped.classes) {
      for (const focus of classRoom.bnccFocus ?? []) addSubject(focus, classRoom)
      if (!(classRoom.bnccFocus ?? []).length) addSubject(classRoom.grade, classRoom)
    }

    for (const fallback of ['Matematica', 'Lingua Portuguesa', 'Historia', 'Geografia', 'Ciencias']) addSubject(fallback)

    const cards = Array.from(subjects.values())
      .sort((first, second) => {
        const firstLinked = first.classes.length > 0 ? 0 : 1
        const secondLinked = second.classes.length > 0 ? 0 : 1
        return firstLinked - secondLinked || first.subject.localeCompare(second.subject)
      })
      .map((item) => ({
        id: this.createStableSubjectId(item.subject),
        subject: item.subject,
        classes: item.classes,
      }))
    const page = this.paginate(cards, rawPage, rawLimit, 6)

    return {
      subjectCards: page.items,
      pagination: page.pagination,
    }
  }

  getNotificationsScreen(userId: string): NotificationsScreenPayload {
    const data = this.syncNotificationsForUser(userId)
    return this.buildNotificationsPayload(data, userId)
  }

  markNotificationRead(userId: string, notificationId: string): NotificationsScreenPayload {
    const data = this.database.update((current) => {
      const currentUser = this.ensureCurrentUser(current, userId)
      this.syncNotificationsForUserInData(current, currentUser)
      const notification = current.notifications.find((item) => item.id === notificationId && item.userId === userId)
      if (!notification) throw new NotFoundException('Notificacao nao encontrada.')
      if (!notification.readAt) {
        const now = new Date().toISOString()
        notification.readAt = now
        notification.updatedAt = now
      }
    })

    return this.buildNotificationsPayload(data, userId)
  }

  markNotificationUnread(userId: string, notificationId: string): NotificationsScreenPayload {
    const data = this.database.update((current) => {
      const currentUser = this.ensureCurrentUser(current, userId)
      this.syncNotificationsForUserInData(current, currentUser)
      const notification = current.notifications.find((item) => item.id === notificationId && item.userId === userId)
      if (!notification) throw new NotFoundException('Notificacao nao encontrada.')
      if (notification.readAt) {
        notification.readAt = null
        notification.updatedAt = new Date().toISOString()
      }
    })

    return this.buildNotificationsPayload(data, userId)
  }

  markAllNotificationsRead(userId: string): NotificationsScreenPayload {
    const data = this.database.update((current) => {
      const currentUser = this.ensureCurrentUser(current, userId)
      this.syncNotificationsForUserInData(current, currentUser)
      const now = new Date().toISOString()

      for (const notification of current.notifications) {
        if (notification.userId !== userId || notification.readAt) continue
        notification.readAt = now
        notification.updatedAt = now
      }
    })

    return this.buildNotificationsPayload(data, userId)
  }

  getEvaluationsScreen(userId: string) {
    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const roleCode = this.getCurrentRoleCode(data, currentUser)
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const scopedClassIds = new Set(scoped.classes.map((classRoom) => classRoom.id))
    const scopedEvaluationIds = new Set(data.evaluations.filter((evaluation) => scopedClassIds.has(evaluation.classId)).map((evaluation) => evaluation.id))

    return {
      evaluations: data.evaluations.filter((evaluation) => scopedClassIds.has(evaluation.classId)),
      classes: scoped.classes,
      students: scoped.students,
      teachers: scoped.teachers,
      schools: scoped.schools,
      evaluationCorrections: data.evaluationCorrections.filter((correction) => scopedEvaluationIds.has(correction.evaluationId)),
      curriculumBases: data.curriculumBases,
      curriculumSkills: data.curriculumSkills,
      assessmentPrograms: data.assessmentPrograms,
      assessmentMatrices: data.assessmentMatrices,
      assessmentDescriptors: data.assessmentDescriptors,
      questionBank: data.questions.filter((question) => this.canUseQuestionInSelection(question, currentUser, roleCode)),
      questionImportPlans: data.questionImportPlans,
    }
  }

  getCalendarScreen(userId: string) {
    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const scopedData = this.getScopedDatabaseView(data, currentUser)

    return {
      calendarEvents: scopedData.calendarEvents,
      roomReservations: scopedData.roomReservations,
      schools: scopedData.schools,
      classes: scopedData.classes,
      evaluations: scopedData.evaluations,
    }
  }

  getMealsScreen(userId: string) {
    this.ensureMealManagementDataReady(userId)

    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const roleCode = this.getCurrentRoleCode(data, currentUser)
    const canViewAll = this.isSuperAdminRole(roleCode) || roleCode === 'NUTRITIONIST'
    const managements = currentUser.schoolId && !canViewAll
      ? data.mealManagements.filter((management) => management.escolaId === currentUser.schoolId)
      : data.mealManagements
    const schoolIds = new Set(managements.map((management) => management.escolaId))
    const foodRequests = canViewAll
      ? data.mealFoodRequests
      : data.mealFoodRequests.filter((request) => currentUser.schoolId && request.schoolId === currentUser.schoolId)
    const requestIds = new Set(foodRequests.map((request) => request.id))

    return {
      schools: data.schools.filter((school) => schoolIds.has(school.id) || canViewAll),
      mealManagements: managements,
      foodRequests,
      mealRequestHistory: data.mealRequestHistory.filter((entry) => requestIds.has(entry.entityId)),
    }
  }

  listMealManagements(userId: string) {
    return this.getMealsScreen(userId)
  }

  listMealManagementSchoolPage(userId: string, rawPage: string | number = 1, rawLimit: string | number = 5, search = '') {
    this.ensureMealManagementDataReady(userId)

    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const page = Math.max(1, Number(rawPage) || 1)
    const limit = Math.min(20, Math.max(1, Number(rawLimit) || 5))
    const roleCode = this.getCurrentRoleCode(data, currentUser)
    const canViewAll = this.isSuperAdminRole(roleCode) || roleCode === 'NUTRITIONIST'
    const query = this.normalizeTextKey(search)
    const managementBySchoolId = new Map<string, MealManagement>()
    for (const management of data.mealManagements) {
      if (!managementBySchoolId.has(management.escolaId)) managementBySchoolId.set(management.escolaId, management)
    }
    const schools = data.schools.filter((school) => {
      if (currentUser.schoolId && !canViewAll && school.id !== currentUser.schoolId) return false
      if (!query) return true
      return this.normalizeTextKey([school.name, school.director, school.address].filter(Boolean).join(' ')).includes(query)
    })
    const total = schools.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * limit
    const pageSchools = schools.slice(start, start + limit)
    const pageManagements = pageSchools
      .map((school) => managementBySchoolId.get(school.id))
      .filter((management): management is MealManagement => Boolean(management))

    return {
      schools: pageSchools,
      mealManagements: pageManagements,
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages,
      },
    }
  }

  searchMealFoods(userId: string, search: string, rawLimit: string | number = 5) {
    const data = this.readDataForQuery()
    this.ensureCurrentUser(data, userId)

    const query = this.normalizeMealFoodSearch(search)
    if (!query) return []

    const limit = Math.min(20, Math.max(1, Number(rawLimit) || 5))
    return data.mealFoods
      .filter((food) => food.ativo)
      .map((food) => ({ food, score: this.getMealFoodSearchScore(food, query) }))
      .filter((item) => item.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score || a.food.nome.localeCompare(b.food.nome, 'pt-BR'))
      .slice(0, limit)
      .map((item) => item.food)
  }

  createMealManagement(actorId: string, payload: CreateMealManagementPayload) {
    this.ensureRequired(payload, ['escolaId', 'mesReferencia', 'valorLimite'])

    let created: MealManagement | null = null
    this.database.update((data) => {
      const actor = this.ensureRole(data, actorId, 'ADMIN')
      const escolaId = String(payload.escolaId).trim()
      const mesReferencia = this.normalizeReferenceMonth(payload.mesReferencia)
      const valorLimite = Number(payload.valorLimite)
      const alertaAoAtingirPercentual = Number(payload.alertaAoAtingirPercentual ?? 80)

      this.ensureSchoolExists(data, escolaId)
      if (!Number.isFinite(valorLimite) || valorLimite <= 0) throw new BadRequestException('Valor limite deve ser maior que zero.')
      if (!Number.isFinite(alertaAoAtingirPercentual) || alertaAoAtingirPercentual <= 0 || alertaAoAtingirPercentual > 100) {
        throw new BadRequestException('Percentual de alerta deve estar entre 1 e 100.')
      }
      if (data.mealManagements.some((management) => management.escolaId === escolaId && management.mesReferencia === mesReferencia)) {
        throw new BadRequestException('Esta escola ja possui gestao de merenda para o mes informado.')
      }

      const responsaveis = payload.responsaveisGestao ?? {}
      let nextFoodId = Math.max(0, ...data.mealFoods.map((food) => food.id))
      const foods = (payload.alimentosCadastrados ?? []).map((foodPayload) => {
        const foodKey = this.normalizeMealFoodSearch(foodPayload.nome)
        let food = data.mealFoods.find((item) => this.normalizeMealFoodSearch(item.nome) === foodKey)
        if (!food) {
          nextFoodId += 1
          food = this.buildMealFood(foodPayload, nextFoodId)
          data.mealFoods.push(food)
        }
        return food
      }).filter((food, index, list) => list.findIndex((item) => item.id === food.id) === index)
      created = this.recalculateMealManagement({
        id: this.createId('meal-management'),
        escolaId,
        mesReferencia,
        status: 'ATIVO',
        orcamentoMensal: {
          id: this.createId('meal-budget'),
          valorLimite,
          valorUtilizado: 0,
          valorDisponivel: valorLimite,
          percentualUtilizado: 0,
          status: 'DENTRO_DO_LIMITE',
          alertaAoAtingirPercentual,
          permitirUltrapassarLimite: Boolean(payload.permitirUltrapassarLimite),
        },
        responsaveisGestao: {
          diretorId: this.normalizeResponsibleId(data, responsaveis.diretorId, escolaId, actor.id),
          nutricionistaId: this.normalizeResponsibleId(data, responsaveis.nutricionistaId, escolaId, actor.id),
          merendeiroId: this.normalizeResponsibleId(data, responsaveis.merendeiroId, escolaId, actor.id),
          responsavelFinanceiroId: this.normalizeResponsibleId(data, responsaveis.responsavelFinanceiroId, escolaId, actor.id),
        },
        alimentosCadastrados: foods,
        cardapios: [],
        itensMerenda: [],
        movimentacoesOrcamento: [],
        estoqueMerenda: [],
        resumo: {
          totalItens: 0,
          totalKgComprado: 0,
          valorTotalComprado: 0,
          orcamentoInicial: valorLimite,
          orcamentoRestante: valorLimite,
          percentualUtilizado: 0,
          statusOrcamento: 'DENTRO_DO_LIMITE',
          itensBaixoEstoque: 0,
          itensVencidos: 0,
        },
      })

      data.mealManagements.unshift(created)
      this.pushAudit(data, actorId, 'Criou gestao de merenda', `${escolaId} ${mesReferencia}`)
    })

    return created!
  }

  updateMealBudget(actorId: string, managementId: string, payload: UpdateMealBudgetPayload) {
    let updated: MealManagement | null = null

    this.database.update((data) => {
      this.ensureRole(data, actorId, 'ADMIN')
      const index = this.getMealManagementIndex(data, managementId)
      const management = data.mealManagements[index]
      const valorLimite = payload.valorLimite === undefined ? management.orcamentoMensal.valorLimite : Number(payload.valorLimite)
      const alertaAoAtingirPercentual = payload.alertaAoAtingirPercentual === undefined
        ? management.orcamentoMensal.alertaAoAtingirPercentual
        : Number(payload.alertaAoAtingirPercentual)

      if (!Number.isFinite(valorLimite) || valorLimite <= 0) throw new BadRequestException('Valor limite deve ser maior que zero.')
      if (!Number.isFinite(alertaAoAtingirPercentual) || alertaAoAtingirPercentual <= 0 || alertaAoAtingirPercentual > 100) {
        throw new BadRequestException('Percentual de alerta deve estar entre 1 e 100.')
      }

      updated = this.recalculateMealManagement({
        ...management,
        orcamentoMensal: {
          ...management.orcamentoMensal,
          valorLimite,
          alertaAoAtingirPercentual,
          permitirUltrapassarLimite: payload.permitirUltrapassarLimite ?? management.orcamentoMensal.permitirUltrapassarLimite,
        },
      })
      data.mealManagements[index] = updated
      this.pushAudit(data, actorId, 'Atualizou orcamento da merenda', management.mesReferencia)
    })

    return updated!
  }

  createMealFood(actorId: string, managementId: string, payload: CreateMealFoodPayload) {
    let updated: MealManagement | null = null

    this.database.update((data) => {
      this.ensureRole(data, actorId, 'ADMIN')
      const index = this.getMealManagementIndex(data, managementId)
      const management = data.mealManagements[index]
      const foodKey = this.normalizeMealFoodSearch(payload.nome)
      let food = data.mealFoods.find((item) => this.normalizeMealFoodSearch(item.nome) === foodKey)

      if (!food) {
        const nextFoodId = Math.max(0, ...data.mealFoods.map((item) => item.id)) + 1
        food = this.buildMealFood(payload, nextFoodId)
        data.mealFoods.push(food)
      }

      if (!management.alimentosCadastrados.some((item) => item.id === food.id)) {
        management.alimentosCadastrados.push(food)
      }
      updated = this.recalculateMealManagement(management)
      data.mealManagements[index] = updated
      this.pushAudit(data, actorId, 'Cadastrou alimento da merenda', food.nome)
    })

    return updated!
  }

  createMealMenu(actorId: string, managementId: string, payload: UpsertMealMenuPayload) {
    let updated: MealManagement | null = null

    this.database.update((data) => {
      this.ensureRole(data, actorId, 'ADMIN')
      const index = this.getMealManagementIndex(data, managementId)
      const management = data.mealManagements[index]
      const menu = this.buildMealMenu(management, payload)

      management.cardapios.unshift(menu)
      updated = this.recalculateMealManagement(management)
      data.mealManagements[index] = updated
      this.pushAudit(data, actorId, 'Criou cardapio da merenda', menu.titulo)
    })

    return updated!
  }

  updateMealMenu(actorId: string, managementId: string, menuId: string, payload: Partial<UpsertMealMenuPayload>) {
    let updated: MealManagement | null = null

    this.database.update((data) => {
      this.ensureRole(data, actorId, 'ADMIN')
      const index = this.getMealManagementIndex(data, managementId)
      const management = data.mealManagements[index]
      const menuIndex = management.cardapios.findIndex((menu) => menu.id === menuId)
      if (menuIndex < 0) throw new NotFoundException('Cardapio da merenda nao encontrado.')

      const menu = this.buildMealMenu(management, { ...management.cardapios[menuIndex], ...payload }, menuId)
      management.cardapios[menuIndex] = menu
      updated = this.recalculateMealManagement(management)
      data.mealManagements[index] = updated
      this.pushAudit(data, actorId, 'Atualizou cardapio da merenda', menu.titulo)
    })

    return updated!
  }

  deleteMealMenu(actorId: string, managementId: string, menuId: string) {
    let updated: MealManagement | null = null

    this.database.update((data) => {
      this.ensureRole(data, actorId, 'ADMIN')
      const index = this.getMealManagementIndex(data, managementId)
      const management = data.mealManagements[index]
      const menu = management.cardapios.find((item) => item.id === menuId)
      if (!menu) throw new NotFoundException('Cardapio da merenda nao encontrado.')

      management.cardapios = management.cardapios.filter((item) => item.id !== menuId)
      updated = this.recalculateMealManagement(management)
      data.mealManagements[index] = updated
      this.pushAudit(data, actorId, 'Removeu cardapio da merenda', menu.titulo)
    })

    return updated!
  }

  createMealFoodRequest(actorId: string, payload: CreateMealFoodRequestPayload) {
    let created: MealFoodRequest | null = null

    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const roleCode = this.getCurrentRoleCode(data, actor)
      if (roleCode !== 'ADMIN' && roleCode !== 'DIRETOR') {
        throw new ForbiddenException('Apenas Diretor ou Admin podem criar solicitacoes de alimentos.')
      }

      const schoolId = this.resolveFoodRequestSchoolId(data, actor, roleCode, payload.schoolId)
      const now = new Date().toISOString()
      created = this.buildMealFoodRequest(data, payload, schoolId, actorId, now)
      data.mealFoodRequests.unshift(created)
      this.pushMealRequestHistory(data, actor, 'CREATED_FOOD_REQUEST', created, null, created, `Criou solicitacao de ${created.quantity} ${created.unit} de ${created.itemName}`)
      this.pushAudit(data, actorId, 'Criou solicitacao de alimento', created.itemName)
    })

    return created!
  }

  updateMealFoodRequest(actorId: string, requestId: string, payload: UpdateMealFoodRequestPayload) {
    let updated: MealFoodRequest | null = null

    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const roleCode = this.getCurrentRoleCode(data, actor)
      const index = data.mealFoodRequests.findIndex((request) => request.id === requestId)
      if (index < 0) throw new NotFoundException('Solicitacao de alimento nao encontrada.')

      const current = data.mealFoodRequests[index]
      const isCreator = current.requestedBy === actorId
      const canCreatorUpdate = isCreator && this.canCreatorMutateMealFoodRequest(current.status)
      if (roleCode !== 'ADMIN') {
        if (!canCreatorUpdate) throw new ForbiddenException('Apenas o criador pode editar solicitacoes pendentes, reprovadas ou que precisam de ajuste.')
        if (current.schoolId !== actor.schoolId) throw new ForbiddenException('Usuario so pode editar solicitacoes da propria escola.')
      }

      const schoolId = this.resolveFoodRequestSchoolId(data, actor, roleCode, payload.schoolId ?? current.schoolId)
      const now = new Date().toISOString()
      const shouldResendToNutritionist = roleCode !== 'ADMIN' && canCreatorUpdate
      updated = this.buildMealFoodRequest(data, { ...current, ...payload }, schoolId, current.requestedBy, current.createdAt, current.id)
      updated = {
        ...updated,
        status: shouldResendToNutritionist ? 'PENDING_NUTRITIONIST_APPROVAL' : (payload as Partial<MealFoodRequest>).status ?? current.status,
        reviewedBy: shouldResendToNutritionist ? null : current.reviewedBy ?? null,
        reviewedAt: shouldResendToNutritionist ? null : current.reviewedAt ?? null,
        nutritionistObservation: shouldResendToNutritionist ? null : current.nutritionistObservation ?? null,
        rejectionReason: shouldResendToNutritionist ? null : current.rejectionReason ?? null,
        suggestedQuantity: shouldResendToNutritionist ? null : current.suggestedQuantity ?? null,
        suggestedUnit: shouldResendToNutritionist ? null : current.suggestedUnit ?? null,
        suggestedUnitPrice: shouldResendToNutritionist ? null : current.suggestedUnitPrice ?? null,
        confirmedBy: current.confirmedBy ?? null,
        confirmedAt: current.confirmedAt ?? null,
        supplierName: current.supplierName ?? null,
        purchaseValue: current.purchaseValue ?? null,
        purchaseDate: current.purchaseDate ?? null,
        stockItemId: current.stockItemId ?? null,
        updatedAt: now,
      }

      data.mealFoodRequests[index] = updated
      this.pushMealRequestHistory(data, actor, 'UPDATED_FOOD_REQUEST', updated, current, updated, `Editou solicitacao de ${updated.itemName}`)
      this.pushAudit(data, actorId, 'Editou solicitacao de alimento', updated.itemName)
    })

    return updated!
  }

  deleteMealFoodRequest(actorId: string, requestId: string) {
    let updated: MealFoodRequest | null = null

    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const roleCode = this.getCurrentRoleCode(data, actor)
      const index = data.mealFoodRequests.findIndex((request) => request.id === requestId)
      if (index < 0) throw new NotFoundException('Solicitacao de alimento nao encontrada.')

      const current = data.mealFoodRequests[index]
      const isCreator = current.requestedBy === actorId
      if (roleCode !== 'ADMIN') {
        if (!isCreator) throw new ForbiddenException('Apenas o criador pode excluir esta solicitacao.')
        if (current.schoolId !== actor.schoolId) throw new ForbiddenException('Usuario so pode excluir solicitacoes da propria escola.')
        if (!this.canCreatorMutateMealFoodRequest(current.status)) {
          throw new BadRequestException('Solicitacao nao pode mais ser excluida pelo criador.')
        }
      }

      if (current.status === 'ADDED_TO_STOCK' || current.status === 'PURCHASED') {
        throw new BadRequestException('Solicitacao ja finalizada nao pode ser excluida.')
      }

      updated = {
        ...current,
        status: 'CANCELLED',
        updatedAt: new Date().toISOString(),
      }

      data.mealFoodRequests[index] = updated
      this.pushMealRequestHistory(data, actor, 'CANCELLED_FOOD_REQUEST', updated, current, updated, `Cancelou solicitacao de ${updated.itemName}`)
      this.pushAudit(data, actorId, 'Cancelou solicitacao de alimento', updated.itemName)
    })

    return updated!
  }

  reviewMealFoodRequest(actorId: string, requestId: string, payload: ReviewMealFoodRequestPayload) {
    let updated: MealFoodRequest | null = null

    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const roleCode = this.getCurrentRoleCode(data, actor)
      if (roleCode !== 'ADMIN' && roleCode !== 'NUTRITIONIST') {
        throw new ForbiddenException('Apenas Nutricionista ou Admin podem avaliar solicitacoes.')
      }

      const index = data.mealFoodRequests.findIndex((request) => request.id === requestId)
      if (index < 0) throw new NotFoundException('Solicitacao de alimento nao encontrada.')
      const current = data.mealFoodRequests[index]
      if (current.status === 'ADDED_TO_STOCK' || current.status === 'CANCELLED') {
        throw new BadRequestException('Esta solicitacao nao pode mais ser avaliada.')
      }

      const action = String(payload.action ?? '').trim().toUpperCase()
      const now = new Date().toISOString()
      const suggestedUnitPrice = payload.suggestedUnitPrice === undefined || payload.suggestedUnitPrice === null || payload.suggestedUnitPrice === 0 ? null : Number(payload.suggestedUnitPrice)
      const base: MealFoodRequest = {
        ...current,
        reviewedBy: actorId,
        reviewedAt: now,
        updatedAt: now,
        nutritionistObservation: payload.nutritionistObservation ? String(payload.nutritionistObservation).trim() : null,
        rejectionReason: null,
        suggestedQuantity: payload.suggestedQuantity === undefined || payload.suggestedQuantity === null || payload.suggestedQuantity === 0 ? null : Number(payload.suggestedQuantity),
        suggestedUnit: payload.suggestedUnit ? this.normalizeMealUnit(payload.suggestedUnit) : null,
        suggestedUnitPrice,
      }

      if (suggestedUnitPrice !== null && (!Number.isFinite(suggestedUnitPrice) || suggestedUnitPrice <= 0)) {
        throw new BadRequestException('Valor unitario sugerido deve ser maior que zero.')
      }

      let historyAction: MealRequestHistoryAction = 'APPROVED_FOOD_REQUEST'
      if (action === 'APPROVE') {
        const approvedRequest: MealFoodRequest = { ...base, status: 'APPROVED_BY_NUTRITIONIST' }
        const stockResult = this.addFoodRequestToMealStock(data, approvedRequest, actorId, {}, { createMenu: true, automaticApproval: true })
        updated = stockResult.request
      } else if (action === 'REJECT') {
        const rejectionReason = String(payload.rejectionReason ?? '').trim()
        if (!rejectionReason) throw new BadRequestException('Informe o motivo da reprovacao.')
        updated = { ...base, status: 'REJECTED_BY_NUTRITIONIST', rejectionReason }
        historyAction = 'REJECTED_FOOD_REQUEST'
      } else if (action === 'REQUEST_ADJUSTMENT') {
        const observation = String(payload.nutritionistObservation ?? '').trim()
        if (!observation) throw new BadRequestException('Informe a observacao do ajuste solicitado.')
        updated = { ...base, status: 'NEEDS_ADJUSTMENT', nutritionistObservation: observation }
        historyAction = 'REQUESTED_FOOD_ADJUSTMENT'
      } else {
        throw new BadRequestException('Ação de avaliação inválida.')
      }

      data.mealFoodRequests[index] = updated
      if (action === 'APPROVE') {
        this.pushMealRequestHistory(data, actor, 'APPROVED_FOOD_REQUEST', updated, current, updated, this.describeFoodRequestHistory('APPROVED_FOOD_REQUEST', updated))
        this.pushMealRequestHistory(data, actor, 'ADDED_FOOD_REQUEST_TO_STOCK', updated, current, updated, `Solicitacao aprovada entrou automaticamente no estoque e no cardapio: ${updated.itemName}`)
        this.pushAudit(data, actorId, 'Aprovou solicitacao e gerou estoque/cardapio', updated.itemName)
      } else {
        this.pushMealRequestHistory(data, actor, historyAction, updated, current, updated, this.describeFoodRequestHistory(historyAction, updated))
        this.pushAudit(data, actorId, 'Avaliou solicitacao de alimento', updated.itemName)
      }
    })

    return updated!
  }

  addMealFoodRequestToStock(actorId: string, requestId: string, payload: AddMealFoodRequestToStockPayload) {
    let result: { request: MealFoodRequest; management: MealManagement; food: MealFood; quantity: number } | null = null

    this.database.update((data) => {
      const actor = this.ensureRole(data, actorId, 'ADMIN')
      const requestIndex = data.mealFoodRequests.findIndex((request) => request.id === requestId)
      if (requestIndex < 0) throw new NotFoundException('Solicitacao de alimento nao encontrada.')
      const current = data.mealFoodRequests[requestIndex]
      if (current.status === 'ADDED_TO_STOCK' || current.status === 'CANCELLED') {
        throw new BadRequestException('Esta solicitacao nao pode virar uma nova entrada no estoque.')
      }

      result = this.addFoodRequestToMealStock(data, current, actorId, payload)
      data.mealFoodRequests[requestIndex] = result.request
      this.pushMealRequestHistory(data, actor, 'ADDED_FOOD_REQUEST_TO_STOCK', result.request, current, result.request, `Admin adicionou ${result.quantity} ${result.food.unidadeMedida} de ${result.food.nome} ao estoque`)
      this.pushAudit(data, actorId, 'Adicionou solicitacao ao estoque', result.food.nome)
    })

    return result!
  }

  getAccessScreen(userId: string) {
    const data = this.readDataForQuery()
    this.ensureCurrentUser(data, userId)

    return {
      roles: data.roles,
      users: data.users.map((user) => this.toPublicUserWithResolvedSchool(data, user)),
      schools: data.schools,
    }
  }

  searchAccessUsers(userId: string, search = '', schoolId = 'all', kind = 'all', rawLimit: string | number = 10) {
    const data = this.readDataForQuery()
    this.ensureRole(data, userId, 'ADMIN')

    const query = this.normalizeTextKey(search)
    const schoolFilter = String(schoolId ?? 'all').trim()
    const kindFilter = this.normalizeTextKey(kind)
    const limit = Math.min(25, Math.max(1, Number(rawLimit) || 10))
    const rolesById = new Map(data.roles.map((role) => [role.id, role]))
    const schoolById = new Map(data.schools.map((school) => [school.id, school]))

    if (!query) return { users: [] }

    const getUserKind = (user: UserAccount): 'professor' | 'coordenador' | 'responsavel' | 'aluno' | 'outro' => {
      const role = rolesById.get(user.roleId)
      const roleText = this.normalizeTextKey(`${role?.code ?? ''} ${role?.name ?? ''} ${role?.description ?? ''}`).replace(/[^a-z0-9]/g, '')

      if (user.linkedTeacherId || roleText.includes('professor')) return 'professor'
      if (roleText.includes('coorden') || roleText.includes('pedagog')) return 'coordenador'
      if (user.linkedGuardianId || roleText.includes('responsavel') || roleText.includes('responsaveis')) return 'responsavel'
      if (user.linkedStudentId || roleText.includes('aluno')) return 'aluno'
      return 'outro'
    }

    const getScore = (user: UserAccount) => {
      const role = rolesById.get(user.roleId)
      const school = user.schoolId ? schoolById.get(user.schoolId) : null
      const userKind = getUserKind(user)
      const fields = [
        { value: user.name, weight: 90 },
        { value: user.email, weight: 62 },
        { value: user.login ?? '', weight: 52 },
        { value: user.phone ?? '', weight: 36 },
        { value: role?.name ?? '', weight: 28 },
        { value: role?.code ?? '', weight: 24 },
        { value: school?.name ?? '', weight: 22 },
        { value: school?.city ?? '', weight: 14 },
        { value: userKind, weight: 18 },
      ]

      return fields.reduce((best, field) => {
        const value = this.normalizeTextKey(field.value)
        if (!value) return best
        if (value === query) return Math.max(best, field.weight + 70)
        if (value.startsWith(query)) return Math.max(best, field.weight + 40)
        if (value.includes(query)) return Math.max(best, field.weight + 22)
        if (value.split(/\s+/).some((word) => word.startsWith(query))) return Math.max(best, field.weight + 32)
        return best
      }, 0)
    }

    const users = data.users
      .filter((user) => {
        if (schoolFilter && schoolFilter !== 'all') {
          if (schoolFilter === 'network') {
            if (user.schoolId) return false
          } else if (user.schoolId !== schoolFilter) {
            return false
          }
        }

        if (kindFilter && kindFilter !== 'all' && getUserKind(user) !== kindFilter) return false
        return true
      })
      .map((user) => ({ user, score: getScore(user) }))
      .filter((result) => result.score > 0)
      .sort((first, second) => second.score - first.score || first.user.name.localeCompare(second.user.name))
      .slice(0, limit)
      .map((result) => this.toPublicUserWithResolvedSchool(data, result.user))

    return { users }
  }

  getSettingsScreen(userId: string) {
    const data = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(data, userId)
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const currentUserPayload = this.toPublicUserWithResolvedSchool(data, currentUser)
    const linkedSchool = currentUserPayload.schoolId
      ? data.schools.find((school) => school.id === currentUserPayload.schoolId)
      : null
    const schools = linkedSchool && !scoped.schools.some((school) => school.id === linkedSchool.id)
      ? [linkedSchool, ...scoped.schools]
      : scoped.schools

    return {
      currentUser: currentUserPayload,
      schools,
    }
  }

  createSchool(actorId: string, payload: Partial<School>) {
    this.ensureRequired(payload, ['name', 'city', 'address', 'director', 'inepCode'])
    this.rejectControlledFields(payload, ['id'])
    const school: School = {
      id: this.createId('esc'),
      name: payload.name!.trim(),
      city: payload.city!.trim(),
      address: payload.address!.trim(),
      director: payload.director!.trim(),
      inepCode: payload.inepCode!.trim(),
      active: payload.active ?? true,
    }
    this.database.update((data) => {
      this.ensureGlobalAdmin(data, actorId)
      data.schools.unshift(school)
      this.createMissingMealManagements(data, this.getCurrentReferenceMonth(), actorId)
      this.pushAudit(data, actorId, 'Criou escola', school.name)
    })
    return school
  }

  updateSchool(actorId: string, id: string, payload: Partial<School>) {
    this.rejectControlledFields(payload, ['id'])
    let updated: School | null = null
    this.database.update((data) => {
      this.ensureGlobalAdmin(data, actorId)
      const index = data.schools.findIndex((school) => school.id === id)
      if (index < 0) throw new NotFoundException('Escola nao encontrada.')
      const current = data.schools[index]
      updated = {
        ...current,
        name: payload.name === undefined ? current.name : String(payload.name).trim(),
        city: payload.city === undefined ? current.city : String(payload.city).trim(),
        address: payload.address === undefined ? current.address : String(payload.address).trim(),
        director: payload.director === undefined ? current.director : String(payload.director).trim(),
        inepCode: payload.inepCode === undefined ? current.inepCode : String(payload.inepCode).trim(),
        active: payload.active === undefined ? current.active : Boolean(payload.active),
        id,
      }
      data.schools[index] = updated
      this.pushAudit(data, actorId, 'Atualizou escola', updated.name)
    })
    return updated!
  }

  createClassRoom(actorId: string, payload: Partial<ClassRoom>) {
    this.ensureRequired(payload, ['name', 'grade', 'schoolId', 'teacherId', 'schedule'])
    this.rejectControlledFields(payload, ['id'])
    const teacherIds = Array.from(new Set([payload.teacherId!, ...(payload.teacherIds ?? [])].filter(Boolean)))
    const classRoom: ClassRoom = {
      id: this.createId('turma'),
      name: payload.name!.trim(),
      grade: this.normalizeClassGrade(payload.grade),
      shift: payload.shift ?? 'Manha',
      schoolId: payload.schoolId!,
      teacherId: payload.teacherId!,
      teacherIds,
      academicYear: payload.academicYear ?? new Date().getFullYear(),
      schedule: payload.schedule!.trim(),
      bnccFocus: payload.bnccFocus ?? [],
    }
    this.database.update((data) => {
      this.ensureStudentMutationAllowed(data, actorId, classRoom.schoolId)
      if (!data.schools.some((school) => school.id === classRoom.schoolId)) throw new BadRequestException('Escola informada nao existe.')
      if (!teacherIds.every((teacherId) => data.teachers.some((teacher) => teacher.id === teacherId && teacher.schoolId === classRoom.schoolId))) {
        throw new BadRequestException('Todos os professores da turma precisam pertencer a escola selecionada.')
      }
      data.classes.unshift(classRoom)
      this.pushAudit(data, actorId, 'Criou turma', classRoom.name)
    })
    return classRoom
  }

  updateClassRoom(actorId: string, id: string, payload: Partial<ClassRoom>) {
    this.rejectControlledFields(payload, ['id'])
    let updated: ClassRoom | null = null
    this.database.update((data) => {
      const index = data.classes.findIndex((classRoom) => classRoom.id === id)
      if (index < 0) throw new NotFoundException('Turma nao encontrada.')
      const current = data.classes[index]
      const teacherId = payload.teacherId ?? current.teacherId
      const teacherIds = Array.from(new Set([teacherId, ...(payload.teacherIds ?? current.teacherIds ?? [])].filter(Boolean)))
      const schoolId = payload.schoolId ?? current.schoolId
      this.ensureStudentMutationAllowed(data, actorId, current.schoolId)
      if (schoolId !== current.schoolId) this.ensureStudentMutationAllowed(data, actorId, schoolId)
      if (!teacherIds.every((item) => data.teachers.some((teacher) => teacher.id === item && teacher.schoolId === schoolId))) {
        throw new BadRequestException('Todos os professores da turma precisam pertencer a escola selecionada.')
      }
      updated = {
        ...current,
        id,
        name: payload.name === undefined ? current.name : String(payload.name).trim(),
        grade: payload.grade === undefined ? current.grade : this.normalizeClassGrade(payload.grade),
        shift: payload.shift ?? current.shift,
        schoolId,
        teacherId,
        teacherIds,
        academicYear: payload.academicYear === undefined ? current.academicYear : Number(payload.academicYear),
        schedule: payload.schedule === undefined ? current.schedule : String(payload.schedule).trim(),
        bnccFocus: Array.isArray(payload.bnccFocus) ? payload.bnccFocus.map(String).slice(0, 20) : current.bnccFocus,
      }
      data.classes[index] = updated
      this.pushAudit(data, actorId, 'Atualizou turma', updated.name)
    })
    return updated!
  }

  createTeacher(actorId: string, payload: Partial<Teacher> & { classId?: string; password?: string; phone?: string }) {
    this.ensureRequired(payload, ['name', 'email', 'schoolId', 'specialty', 'password'])
    this.rejectControlledFields(payload, ['id', 'userId', 'avatarUrl', 'bannerUrl', 'avatarObject', 'bannerObject'])
    const teacherId = randomUUID()
    const userId = randomUUID()
    const teacher: Teacher = {
      id: teacherId,
      userId,
      name: payload.name!.trim(),
      email: payload.email!.trim().toLowerCase(),
      schoolId: payload.schoolId!,
      specialty: payload.specialty!.trim(),
      active: payload.active ?? true,
    }

    this.database.update((data) => {
      this.ensureStudentMutationAllowed(data, actorId, teacher.schoolId)
      this.ensureSchoolExists(data, teacher.schoolId)
      if (data.teachers.some((item) => item.email.toLowerCase() === teacher.email)) throw new BadRequestException('Ja existe professor com este e-mail.')
      if (data.users.some((item) => item.email.toLowerCase() === teacher.email)) throw new BadRequestException('Ja existe usuario com este e-mail.')

      data.teachers.unshift(teacher)
      data.users.unshift({
        id: userId,
        name: teacher.name,
        email: teacher.email,
        login: teacher.email,
        password: this.hashPassword(this.normalizeInitialPassword(payload.password)),
        roleId: this.getRoleId(data.roles, 'PROFESSOR'),
        schoolId: teacher.schoolId,
        status: 'ativo',
        phone: payload.phone?.trim() ?? '',
        linkedTeacherId: teacher.id,
      })

      if (payload.classId) {
        const classRoom = this.getClassRoomForSchool(data.classes, payload.classId, teacher.schoolId)
        classRoom.teacherIds = Array.from(new Set([...(classRoom.teacherIds ?? []), teacher.id]))
        if (!classRoom.teacherId) classRoom.teacherId = teacher.id
      }

      this.pushAudit(data, actorId, 'Criou professor', teacher.name)
    })

    return teacher
  }

  updateTeacher(actorId: string, id: string, payload: Partial<Teacher> & { classId?: string }) {
    this.rejectControlledFields(payload, ['id', 'userId', 'avatarUrl', 'bannerUrl', 'avatarObject', 'bannerObject'])
    let updated: Teacher | null = null

    this.database.update((data) => {
      const index = data.teachers.findIndex((teacher) => teacher.id === id)
      if (index < 0) throw new NotFoundException('Professor nao encontrado.')

      const current = data.teachers[index]
      const schoolId = payload.schoolId ?? current.schoolId
      this.ensureStudentMutationAllowed(data, actorId, current.schoolId)
      if (schoolId !== current.schoolId) this.ensureStudentMutationAllowed(data, actorId, schoolId)
      this.ensureSchoolExists(data, schoolId)
      updated = {
        ...current,
        id,
        name: payload.name === undefined ? current.name : String(payload.name).trim(),
        email: (payload.email ?? current.email).trim().toLowerCase(),
        schoolId,
        specialty: payload.specialty === undefined ? current.specialty : String(payload.specialty).trim(),
        active: payload.active === undefined ? current.active : Boolean(payload.active),
      }
      data.teachers[index] = updated

      const userIndex = data.users.findIndex((user) => user.id === updated!.userId)
      if (userIndex >= 0) {
        data.users[userIndex] = {
          ...data.users[userIndex],
          name: updated.name,
          email: updated.email,
          login: updated.email,
          schoolId: updated.schoolId,
          linkedTeacherId: updated.id,
        }
      }

      if (payload.classId) {
        const classRoom = this.getClassRoomForSchool(data.classes, payload.classId, updated.schoolId)
        classRoom.teacherIds = Array.from(new Set([...(classRoom.teacherIds ?? []), updated.id]))
        if (!classRoom.teacherId) classRoom.teacherId = updated.id
      }

      this.pushAudit(data, actorId, 'Atualizou professor', updated.name)
    })

    return updated!
  }

  createStudent(actorId: string, payload: Partial<Student> & { password?: string }) {
    this.ensureRequired(payload, ['name', 'schoolId', 'classId', 'password'])
    this.rejectControlledFields(payload, ['id', 'userId', 'role', 'registration', 'registrationNumber', 'login', 'status', 'attendanceRate', 'averageScore', 'desempenho', 'createdById'])
    const studentId = randomUUID()
    const userId = randomUUID()
    let student: Student | null = null

    this.database.update((data) => {
      this.ensureStudentMutationAllowed(data, actorId, String(payload.schoolId ?? ''))
      const school = this.ensureSchoolExists(data, payload.schoolId!)
      this.getClassRoomForSchool(data.classes, payload.classId!, school.id)
      const registrationNumber = this.buildRegistrationNumber(data, payload.registrationNumber ?? payload.registration)
      const login = `${school.inepCode}-${registrationNumber}`
      const email = `${registrationNumber}@aluno.liensina.com`

      if (data.students.some((item) => item.registrationNumber === registrationNumber || item.registration === registrationNumber)) {
        throw new BadRequestException('Ja existe aluno com esta matricula.')
      }
      if (data.users.some((item) => item.email.toLowerCase() === email.toLowerCase() || item.login?.toLowerCase() === login.toLowerCase())) {
        throw new BadRequestException('Ja existe usuario para esta matricula.')
      }

      student = {
        id: studentId,
        userId,
        name: payload.name!.trim(),
        login,
        role: 'ALUNO',
        registration: registrationNumber,
        registrationNumber,
        schoolId: school.id,
        classId: payload.classId!,
        guardianIds: payload.guardianIds ?? [],
        status: 'matriculado',
        attendanceRate: 100,
        averageScore: 0,
        desempenho: 'Otimo',
      }

      this.ensureGuardiansBelongToSchool(data, student.guardianIds, school.id)
      data.students.unshift(student)
      data.users.unshift({
        id: userId,
        name: student.name,
        email,
        login,
        password: this.hashPassword(this.normalizeInitialPassword(payload.password)),
        roleId: this.getRoleId(data.roles, 'ALUNO'),
        schoolId: school.id,
        status: 'ativo',
        phone: '',
        linkedStudentId: student.id,
      })

      for (const guardianId of student.guardianIds) {
        const guardian = data.guardians.find((item) => item.id === guardianId)
        if (guardian && !guardian.studentIds.includes(student.id)) guardian.studentIds.push(student.id)
      }

      this.pushAudit(data, actorId, 'Criou aluno', student.name)
    })

    return student!
  }

  updateStudent(actorId: string, id: string, payload: Partial<Student>) {
    this.rejectControlledFields(payload, ['id', 'userId', 'role', 'registration', 'registrationNumber', 'login', 'attendanceRate', 'averageScore', 'desempenho', 'avatarUrl', 'bannerUrl', 'avatarObject', 'bannerObject'])
    let updated: Student | null = null

    this.database.update((data) => {
      const index = data.students.findIndex((student) => student.id === id)
      if (index < 0) throw new NotFoundException('Aluno nao encontrado.')

      const current = data.students[index]
      const schoolId = payload.schoolId ?? current.schoolId
      this.ensureStudentMutationAllowed(data, actorId, current.schoolId)
      if (schoolId !== current.schoolId) this.ensureStudentMutationAllowed(data, actorId, schoolId)
      this.ensureSchoolExists(data, schoolId)
      const classId = payload.classId ?? current.classId
      this.getClassRoomForSchool(data.classes, classId, schoolId)
      const guardianIds = payload.guardianIds ?? current.guardianIds
      this.ensureGuardiansBelongToSchool(data, guardianIds, schoolId)

      updated = {
        ...current,
        id,
        name: payload.name === undefined ? current.name : String(payload.name).trim(),
        schoolId,
        classId,
        guardianIds,
        status: payload.status ?? current.status,
      }
      data.students[index] = updated

      for (const guardian of data.guardians) {
        guardian.studentIds = guardian.studentIds.filter((studentId) => studentId !== id)
        if (guardianIds.includes(guardian.id)) guardian.studentIds.push(id)
      }

      const userIndex = data.users.findIndex((user) => user.id === updated!.userId)
      if (userIndex >= 0) {
        data.users[userIndex] = {
          ...data.users[userIndex],
          name: updated.name,
          schoolId: updated.schoolId,
          login: updated.login,
          linkedStudentId: updated.id,
        }
      }

      this.pushAudit(data, actorId, 'Atualizou aluno', updated.name)
    })

    return updated!
  }

  createGuardian(actorId: string, payload: Partial<Guardian> & { password?: string }) {
    this.ensureRequired(payload, ['name', 'email', 'schoolId', 'password'])
    this.rejectControlledFields(payload, ['id', 'userId', 'role', 'avatarUrl', 'bannerUrl', 'avatarObject', 'bannerObject'])
    const guardianId = randomUUID()
    const userId = randomUUID()
    const studentIds = payload.studentIds ?? []
    let guardian: Guardian | null = null

    this.database.update((data) => {
      this.ensureStudentMutationAllowed(data, actorId, payload.schoolId!)
      this.ensureSchoolExists(data, payload.schoolId!)
      this.ensureStudentsBelongToSchool(data, studentIds, payload.schoolId!)
      const email = payload.email!.trim().toLowerCase()

      if (data.guardians.some((item) => item.email.toLowerCase() === email)) throw new BadRequestException('Ja existe responsavel com este e-mail.')
      if (data.users.some((item) => item.email.toLowerCase() === email)) throw new BadRequestException('Ja existe usuario com este e-mail.')

      guardian = {
        id: guardianId,
        userId,
        name: payload.name!.trim(),
        email,
        role: 'RESPONSAVEL',
        schoolId: payload.schoolId!,
        phone: payload.phone?.trim() ?? '',
        studentIds,
      }

      data.guardians.unshift(guardian)
      data.users.unshift({
        id: userId,
        name: guardian.name,
        email: guardian.email,
        login: guardian.email,
        password: this.hashPassword(this.normalizeInitialPassword(payload.password)),
        roleId: this.getRoleId(data.roles, 'RESPONSAVEL'),
        schoolId: guardian.schoolId,
        status: 'ativo',
        phone: guardian.phone,
        linkedGuardianId: guardian.id,
      })

      for (const studentId of studentIds) {
        const student = data.students.find((item) => item.id === studentId)
        if (student && !student.guardianIds.includes(guardian.id)) student.guardianIds.push(guardian.id)
      }

      this.pushAudit(data, actorId, 'Criou responsavel', guardian.name)
    })

    return guardian!
  }

  updateGuardian(actorId: string, id: string, payload: Partial<Guardian>) {
    this.rejectControlledFields(payload, ['id', 'userId', 'role', 'avatarUrl', 'bannerUrl', 'avatarObject', 'bannerObject'])
    let updated: Guardian | null = null

    this.database.update((data) => {
      const index = data.guardians.findIndex((guardian) => guardian.id === id)
      if (index < 0) throw new NotFoundException('Responsavel nao encontrado.')

      const current = data.guardians[index]
      const schoolId = payload.schoolId ?? current.schoolId
      const studentIds = payload.studentIds ?? current.studentIds
      this.ensureStudentMutationAllowed(data, actorId, current.schoolId)
      if (schoolId !== current.schoolId) this.ensureStudentMutationAllowed(data, actorId, schoolId)
      this.ensureSchoolExists(data, schoolId)
      this.ensureStudentsBelongToSchool(data, studentIds, schoolId)

      updated = {
        ...current,
        id,
        name: payload.name === undefined ? current.name : String(payload.name).trim(),
        schoolId,
        phone: payload.phone === undefined ? current.phone : String(payload.phone).trim(),
        studentIds,
        role: 'RESPONSAVEL',
        email: (payload.email ?? current.email).trim().toLowerCase(),
      }
      data.guardians[index] = updated

      for (const student of data.students) {
        student.guardianIds = student.guardianIds.filter((guardianId) => guardianId !== id)
        if (studentIds.includes(student.id)) student.guardianIds.push(id)
      }

      const userIndex = data.users.findIndex((user) => user.id === updated!.userId)
      if (userIndex >= 0) {
        data.users[userIndex] = {
          ...data.users[userIndex],
          name: updated.name,
          email: updated.email,
          login: updated.email,
          schoolId: updated.schoolId,
          phone: updated.phone,
          linkedGuardianId: updated.id,
        }
      }

      this.pushAudit(data, actorId, 'Atualizou responsavel', updated.name)
    })

    return updated!
  }

  async createEvaluation(actorId: string, payload: Partial<Evaluation>, idempotencyKey?: string) {
    this.ensureRequired(payload, ['title', 'classId', 'subject', 'scheduledAt'])
    this.rejectControlledFields(payload, ['id', 'schoolId', 'teacherId', 'status', 'corrected', 'participants', 'averageScore', 'createdById', 'createdByName', 'createdBy', 'idempotencyKey'])
    const operation = async () => {
      let evaluation: Evaluation | null = null
      let answerCards: EvaluationAnswerCard[] = []

      await this.database.updateCommitted((data) => {
        const actor = this.ensureCurrentUser(data, actorId)
        const roleCode = this.getCurrentRoleCode(data, actor)
        if (!this.canCreateEvaluationRole(roleCode)) throw new ForbiddenException('Seu perfil nao pode criar provas.')
        const classRoom = data.classes.find((item) => item.id === payload.classId)
        if (!classRoom) throw new BadRequestException('Turma informada nao existe.')
        if (!this.canAccessClassForMutation(data, actor, classRoom)) throw new ForbiddenException('Seu perfil nao tem permissao para criar provas nesta turma.')
        if (roleCode === 'PROFESSOR' && !this.classSubjectMatchesTeacher(data, actor, classRoom, payload.subject)) {
          throw new ForbiddenException('Professor nao vinculado a turma/disciplina informada.')
        }
        const questionIds = Array.isArray(payload.questionIds) ? payload.questionIds : []
        this.ensureQuestionIdsExist(data, questionIds)
        const payloadSnapshots = Array.isArray(payload.questionSnapshots) ? payload.questionSnapshots : []
        const questionSnapshots = questionIds
          .map((questionId) => data.questions.find((question) => question.id === questionId) ?? payloadSnapshots.find((question) => question.id === questionId))
          .filter((question): question is Question => Boolean(question))

        evaluation = {
          id: this.createId('sim'),
          title: payload.title!.trim(),
          schoolId: classRoom.schoolId,
          teacherId: actor.linkedTeacherId,
          classId: payload.classId!,
          subject: payload.subject!.trim(),
          questions: payload.questions ?? 20,
          scheduledAt: payload.scheduledAt!,
          status: 'planejado',
          corrected: 0,
          participants: 0,
          averageScore: 0,
          triLevel: payload.triLevel ?? 'Aguardando aplicacao',
          buildMode: payload.buildMode,
          questionIds,
          questionSnapshots,
          skillCodes: Array.isArray(payload.skillCodes) ? payload.skillCodes : [],
          descriptorCodes: Array.isArray(payload.descriptorCodes) ? payload.descriptorCodes : [],
          sourceSummary: payload.sourceSummary,
          createdById: actor.id,
          createdByName: actor.name,
          createdBy: {
            id: actor.id,
            name: actor.name,
            email: actor.email,
          },
        }
        const classStudents = data.students.filter((student) => (
          student.classId === classRoom.id
          && student.schoolId === classRoom.schoolId
          && student.status !== 'inativo'
        ))
        const now = new Date().toISOString()
        answerCards = this.answerCardCreationService.createCards({
          evaluation,
          classRoom,
          students: classStudents,
          teacherId: actor.linkedTeacherId ?? actor.id,
          now,
          createId: (prefix) => this.createId(prefix),
        })

        data.evaluations.unshift(evaluation)
        data.answerCards.unshift(...answerCards)
        this.pushAudit(data, actorId, 'Criou prova', `${evaluation.title} (${answerCards.length} cartoes)`)
      })
      const inlineLimit = this.getEvaluationCreateInlineCardsLimit()
      const responseEvaluation = { ...evaluation!, answerCardsCount: answerCards.length } as Evaluation & { answerCardsCount: number }
      return {
        evaluation: responseEvaluation,
        answerCards: answerCards.length <= inlineLimit ? answerCards : [],
      }
    }

    const schoolId = this.readDataForQuery().classes.find((item) => item.id === payload.classId)?.schoolId ?? null
    return this.runIdempotentOperation(actorId, schoolId, 'evaluation.create', String(payload.classId), payload, idempotencyKey, operation)
  }

  async getEvaluationDownload(actorId: string, id: string, kind = 'complete'): Promise<EvaluationDownloadFile> {
    let data = this.readDataForQuery()
    const downloadKind = this.normalizeEvaluationDownloadKind(kind)
    const actor = this.ensureCurrentUser(data, actorId)
    const roleCode = this.getCurrentRoleCode(data, actor)
    if (!['SUPERADMIN', 'ADMIN', 'ADMIN_ESCOLA', 'DIRETOR', 'COORDENADOR', 'PROFESSOR'].includes(roleCode)) {
      throw new ForbiddenException('Seu perfil nao pode baixar arquivos de provas.')
    }

    let evaluation = data.evaluations.find((item) => item.id === id)
    if (!evaluation) throw new NotFoundException('Prova nao encontrada.')
    if (!this.canAccessEvaluation(data, actor, evaluation)) {
      throw new ForbiddenException('Seu perfil nao pode baixar esta prova.')
    }

    let questions = this.resolveEvaluationQuestions(data, evaluation)

    if (!questions.length && Number(evaluation.questions) > 0) {
      data = this.database.update((current) => {
        const currentActor = this.ensureCurrentUser(current, actorId)
        const currentEvaluationIndex = current.evaluations.findIndex((item) => item.id === id)
        if (currentEvaluationIndex < 0) throw new NotFoundException('Prova nao encontrada.')
        const currentEvaluation = current.evaluations[currentEvaluationIndex]
        if (!this.canAccessEvaluation(current, currentActor, currentEvaluation)) {
          throw new ForbiddenException('Seu perfil nao pode baixar esta prova.')
        }

        const selectedQuestions = this.selectLegacyEvaluationQuestions(current, currentEvaluation, currentActor)
        if (!selectedQuestions.length) return

        current.evaluations[currentEvaluationIndex] = {
          ...currentEvaluation,
          questionIds: selectedQuestions.map((question) => question.id),
        }
        this.pushAudit(current, actorId, 'Vinculou questoes a prova legada', currentEvaluation.title)
      })

      evaluation = data.evaluations.find((item) => item.id === id) ?? evaluation
      questions = this.resolveEvaluationQuestions(data, evaluation)
    }

    if (downloadKind === 'answer_cards') {
      data = this.ensureEvaluationAnswerCards(actorId, evaluation.id)
      evaluation = data.evaluations.find((item) => item.id === id) ?? evaluation
      questions = this.resolveEvaluationQuestions(data, evaluation)
    }

    const classRoom = data.classes.find((item) => item.id === evaluation.classId)
    const uploadsRoot = resolve(process.cwd(), 'uploads', 'public')
    const exportsDir = join(uploadsRoot, 'evaluations')
    mkdirSync(exportsDir, { recursive: true })

    const filenamePrefix = downloadKind === 'answer_cards'
      ? 'cartoes-resposta'
      : downloadKind === 'answer_key'
        ? 'gabarito'
        : 'prova'
    const filename = `${filenamePrefix}-${this.safeDownloadSlug(evaluation.title || filenamePrefix)}-${evaluation.id}.pdf`
    const filePath = join(exportsDir, filename)
    const tempPath = join(exportsDir, `.${filename}.${randomUUID()}.tmp`)

    if (downloadKind === 'answer_cards') {
      const answerCards = data.answerCards.filter((card) => card.evaluationId === evaluation.id)
      const students = data.students.filter((student) => student.classId === evaluation.classId)
      await writeEvaluationAnswerCardsPdfFile({ evaluation, classRoom, questions, uploadsRoot, answerCards, students }, tempPath)
    } else if (downloadKind === 'answer_key') {
      await writeEvaluationAnswerKeyPdfFile({ evaluation, classRoom, questions, uploadsRoot }, tempPath)
    } else {
      await writeEvaluationPdfFile({ evaluation, classRoom, questions, uploadsRoot }, tempPath)
    }
    renameSync(tempPath, filePath)

    return {
      filePath,
      filename,
      contentType: 'application/pdf',
    }
  }

  private normalizeEvaluationDownloadKind(kind: string): EvaluationDownloadKind {
    const normalized = String(kind ?? 'complete').trim().toLowerCase().replace(/-/g, '_')
    if (normalized === 'complete' || normalized === 'prova' || normalized === 'evaluation') return 'complete'
    if (normalized === 'answer_cards' || normalized === 'cartoes' || normalized === 'cartoes_resposta') return 'answer_cards'
    if (normalized === 'answer_key' || normalized === 'gabarito') return 'answer_key'
    throw new BadRequestException('Tipo de download de prova invalido.')
  }

  private getEvaluationCreateInlineCardsLimit() {
    const configured = Number(this.configService.get<string>('EVALUATION_CREATE_INLINE_CARDS_LIMIT') ?? 300)
    if (!Number.isFinite(configured)) return 300
    return Math.max(0, Math.min(500, Math.trunc(configured)))
  }

  private ensureEvaluationAnswerCards(actorId: string, evaluationId: string) {
    return this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const evaluation = data.evaluations.find((item) => item.id === evaluationId)
      if (!evaluation) throw new NotFoundException('Prova nao encontrada.')
      if (!this.canAccessEvaluation(data, actor, evaluation)) throw new ForbiddenException('Seu perfil nao pode baixar estes cartoes.')
      const classRoom = data.classes.find((item) => item.id === evaluation.classId)
      if (!classRoom) throw new BadRequestException('Turma da prova nao encontrada.')

      const existingCards = data.answerCards.filter((card) => card.evaluationId === evaluation.id)
      const existingStudentIds = new Set(existingCards.map((card) => card.studentId))
      const missingStudents = data.students.filter((student) => (
        student.classId === classRoom.id
        && student.schoolId === classRoom.schoolId
        && student.status !== 'inativo'
        && !existingStudentIds.has(student.id)
      ))
      if (!missingStudents.length) return

      const now = new Date().toISOString()
      const createdCards = this.answerCardCreationService.createCards({
        evaluation,
        classRoom,
        students: missingStudents,
        teacherId: evaluation.teacherId ?? actor.linkedTeacherId ?? actor.id,
        now,
        createId: (prefix) => this.createId(prefix),
        startIndex: existingCards.length,
      })
      data.answerCards.push(...createdCards)
      this.pushAudit(data, actorId, 'Gerou cartoes resposta da prova', `${evaluation.title} (${createdCards.length} cartoes)`)
    })
  }

  getEvaluationCorrectionCardFile(actorId: string, correctionId: string): EvaluationDownloadFile {
    const data = this.readDataForQuery()
    const actor = this.ensureCurrentUser(data, actorId)
    const roleCode = this.getCurrentRoleCode(data, actor)
    if (!this.canReadCorrectionCardFileRole(roleCode)) throw new ForbiddenException('Seu perfil nao pode baixar cartoes corrigidos.')
    const correction = data.evaluationCorrections.find((item) => item.id === correctionId)
    if (!correction) throw new NotFoundException('Correcao nao encontrada.')
    const evaluation = data.evaluations.find((item) => item.id === correction.evaluationId)
    if (!evaluation) throw new NotFoundException('Prova da correcao nao encontrada.')
    if (!this.canAccessEvaluation(data, actor, evaluation)) throw new ForbiddenException('Sem acesso a esta correcao.')
    const imageObject = correction.imageObject
    if (!imageObject || imageObject.storageProvider !== 'local') throw new NotFoundException('Arquivo da correcao nao encontrado.')

    const uploadsRoot = resolve(process.cwd(), 'uploads', 'private')
    const filePath = resolve(uploadsRoot, imageObject.bucket, imageObject.key)
    const legacyUploadsRoot = resolve(process.cwd(), 'uploads')
    const legacyFilePath = resolve(legacyUploadsRoot, imageObject.bucket, imageObject.key)
    const canReadPrivate = filePath.startsWith(`${uploadsRoot}${sep}`) && existsSync(filePath)
    const canReadLegacy = legacyFilePath.startsWith(`${legacyUploadsRoot}${sep}`) && existsSync(legacyFilePath)
    if (!canReadPrivate && !canReadLegacy) throw new NotFoundException('Arquivo da correcao nao encontrado.')

    return {
      filePath: canReadPrivate ? filePath : legacyFilePath,
      filename: imageObject.originalName || `${correction.id}.jpg`,
      contentType: imageObject.contentType || 'application/octet-stream',
    }
  }

  deleteEvaluation(actorId: string, id: string) {
    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const index = data.evaluations.findIndex((evaluation) => evaluation.id === id)
      if (index < 0) throw new NotFoundException('Prova nao encontrada.')
      this.ensureEvaluationMutationAllowed(data, actor, data.evaluations[index])

      const [removed] = data.evaluations.splice(index, 1)
      this.pushAudit(data, actorId, 'Removeu prova', removed.title)
    })

    return { success: true }
  }

  async processEvaluationOmrCorrection(actorId: string, evaluationId: string, studentId: string, file: OmrImageFile) {
    if (!file) throw new BadRequestException('Envie a imagem ou PDF do cartao resposta.')
    const isSupportedFile = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf'
    if (!isSupportedFile) throw new BadRequestException('Envie uma imagem ou PDF valido do cartao resposta.')

    const snapshot = this.readDataForQuery()
    const actor = this.ensureCurrentUser(snapshot, actorId)
    const roleCode = this.getCurrentRoleCode(snapshot, actor)
    if (!this.canRunOmrRole(roleCode)) throw new ForbiddenException('Seu perfil nao pode executar correcao OMR.')
    const evaluation = snapshot.evaluations.find((item) => item.id === evaluationId)
    if (!evaluation) throw new NotFoundException('Prova nao encontrada.')
    if (!this.canAccessEvaluation(snapshot, actor, evaluation)) throw new ForbiddenException('Sem acesso a esta prova.')

    const classRoom = snapshot.classes.find((item) => item.id === evaluation.classId)
    if (!classRoom) throw new BadRequestException('Turma da prova nao encontrada.')
    const student = snapshot.students.find((item) => item.id === studentId)
    if (!student || student.classId !== classRoom.id) throw new BadRequestException('Aluno nao pertence a turma da prova.')

    const questions = this.resolveEvaluationQuestions(snapshot, evaluation)
    if (!questions.length) throw new BadRequestException('Esta prova nao possui questoes vinculadas para correcao.')
    const answerKey = this.buildEvaluationAnswerKey(questions)
    const answerCard = snapshot.answerCards.find((card) => card.evaluationId === evaluation.id && card.studentId === studentId) ?? null
    const imageObject = await this.saveEvaluationCorrectionImage(evaluationId, studentId, file)
    const answerCardId = answerCard?.cardId ?? this.createId('answer-card')
    const omrPayload = {
      examId: evaluation.id,
      versionId: this.getEvaluationVersionId(evaluation),
      answerCardId,
      studentId,
      classId: classRoom.id,
      templateVersion: 'liensina-omr-v1',
      answerKey,
    }
    let omrResponse: OmrServiceResponse
    try {
      omrResponse = await this.requestOmrCorrection(file, omrPayload)
    } catch (error) {
      this.deleteStoredLocalFile(imageObject, 'private')
      throw error
    }
    const resolvedTarget = this.resolveOmrTargetFromResponse(snapshot, evaluation, classRoom, omrResponse, {
      fallbackStudent: student,
      fallbackAnswerCard: answerCard,
      fallbackCardId: answerCardId,
      strictQrTarget: true,
    })
    if (resolvedTarget.student.id !== student.id) {
      this.deleteStoredLocalFile(imageObject, 'private')
      throw new BadRequestException('O cartao enviado pertence a outro aluno desta prova.')
    }
    const now = new Date().toISOString()
    const correction: EvaluationCorrection = {
      id: this.createId('evaluation-correction'),
      schoolId: classRoom.schoolId,
      evaluationId: evaluation.id,
      classId: classRoom.id,
      studentId,
      studentName: student.name,
      cardId: resolvedTarget.cardId ?? answerCardId,
      subject: evaluation.subject,
      status: omrResponse.shouldRetakeImage ? 'NEEDS_RETAKE' : 'SUGGESTED',
      imageUrl: '',
      imageObject,
      suggestedScore: this.toScore(omrResponse.suggestedScore),
      finalScore: null,
      correctCount: Number(omrResponse.correctCount) || 0,
      wrongCount: Number(omrResponse.wrongCount) || 0,
      blankCount: Number(omrResponse.blankCount) || 0,
      multipleCount: Number(omrResponse.multipleCount) || 0,
      totalQuestions: Number(omrResponse.totalQuestions) || answerKey.length,
      confidence: this.toConfidence(omrResponse.confidence),
      requiresReview: true,
      shouldRetakeImage: Boolean(omrResponse.shouldRetakeImage),
      failures: Array.isArray(omrResponse.failures) ? omrResponse.failures.map(String) : [],
      detectedAnswers: this.normalizeCorrectionAnswers(omrResponse.detectedAnswers, answerKey),
      answerKey,
      rawOmrResponse: omrResponse,
      teacherNotes: null,
      reviewedById: null,
      reviewedAt: null,
      createdById: actorId,
      createdAt: now,
      updatedAt: now,
    }
    correction.imageUrl = `/api/evaluation-corrections/${correction.id}/image`
    if (correction.imageObject) correction.imageObject.publicUrl = correction.imageUrl

    this.database.update((data) => {
      const existingIndex = data.evaluationCorrections.findIndex((item) => item.evaluationId === evaluationId && item.studentId === studentId)
      if (existingIndex >= 0) data.evaluationCorrections[existingIndex] = correction
      else data.evaluationCorrections.unshift(correction)
      const persistedCard = data.answerCards.find((card) => card.evaluationId === evaluationId && card.studentId === studentId)
      if (persistedCard) {
        persistedCard.status = 'USED'
        persistedCard.updatedAt = now
      }
      this.pushAudit(data, actorId, 'Gerou sugestao de correcao OMR', `${evaluation.title} - ${student.name}`)
    })

    return correction
  }

  async processEvaluationOmrBatch(actorId: string, evaluationId: string, files: OmrImageFile[], idempotencyKey?: string) {
    const snapshot = this.readDataForQuery()
    const actor = this.ensureCurrentUser(snapshot, actorId)
    const roleCode = this.getCurrentRoleCode(snapshot, actor)
    if (!this.canRunOmrRole(roleCode)) throw new ForbiddenException('Seu perfil nao pode executar correcao OMR.')
    const evaluation = snapshot.evaluations.find((item) => item.id === evaluationId)
    if (!evaluation) throw new NotFoundException('Prova nao encontrada.')
    if (!this.canAccessEvaluation(snapshot, actor, evaluation)) throw new ForbiddenException('Sem acesso a esta prova.')
    const classRoom = snapshot.classes.find((item) => item.id === evaluation.classId)
    if (!classRoom) throw new BadRequestException('Turma da prova nao encontrada.')
    const questions = this.resolveEvaluationQuestions(snapshot, evaluation)
    if (!questions.length) throw new BadRequestException('Esta prova nao possui questoes vinculadas para correcao.')
    const answerKey = this.buildEvaluationAnswerKey(questions)
    if (!Array.isArray(files) || files.length === 0) throw new BadRequestException('Envie ao menos um cartao resposta.')
    const maxBatchFiles = Math.max(1, Math.min(20, Number(this.configService.get<string>('OMR_MAX_BATCH_FILES') ?? 20) || 20))
    if (files.length > maxBatchFiles) throw new BadRequestException(`Lote OMR excede o limite de ${maxBatchFiles} arquivos.`)
    const totalSize = files.reduce((total, file) => total + Number(file.size ?? 0), 0)
    const maxBatchBytes = Math.max(1, Math.min(48, Number(this.configService.get<string>('OMR_MAX_BATCH_MB') ?? 48) || 48)) * 1024 * 1024
    if (totalSize > Math.min(maxOmrBatchTotalBytes, maxBatchBytes)) throw new BadRequestException('Lote OMR excede o limite total permitido.')

    const operation = async () => {
      const corrections: EvaluationCorrection[] = []
      const issues: OmrBatchIssue[] = []
      const savedObjects = new Map<number, StoredImageObject>()
      const persistedObjects = new Map<string, StoredImageObject>()
      const sortedAnswerCards = this.getEvaluationAnswerCardsInPrintOrder(snapshot, evaluation.id)
      const classStudents = snapshot.students.filter((student) => student.classId === classRoom.id)
      const usedStudentIds = new Set<string>()
      let globalPageIndex = 0

      try {
        for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
          const file = files[fileIndex]
          const omrPayload = {
            examId: evaluation.id,
            versionId: this.getEvaluationVersionId(evaluation),
            answerCardId: null,
            studentId: null,
            classId: classRoom.id,
            templateVersion: 'liensina-omr-v1',
            skipQr: true,
            answerKey,
          }

          const responses = await this.requestOmrBatchCorrection(file, omrPayload)
          for (const response of responses) {
            const sourcePage = this.getOmrSourcePage(response)
            const fallbackCard = sortedAnswerCards[globalPageIndex] ?? null
            const fallbackStudent = fallbackCard
              ? snapshot.students.find((student) => student.id === fallbackCard.studentId) ?? null
              : classStudents[globalPageIndex] ?? null
            globalPageIndex += 1

            let target: OmrResolvedTarget
            try {
              target = this.resolveOmrTargetFromResponse(snapshot, evaluation, classRoom, response, {
                fallbackStudent,
                fallbackAnswerCard: fallbackCard,
                fallbackCardId: fallbackCard?.cardId ?? null,
                strictQrTarget: false,
              })
            } catch (error) {
              issues.push({
                fileName: this.safeOriginalFileName(file.originalname),
                page: sourcePage,
                reason: error instanceof Error ? error.message : 'Nao foi possivel identificar o aluno do cartao.',
              })
              continue
            }

            if (usedStudentIds.has(target.student.id)) {
              issues.push({
                fileName: this.safeOriginalFileName(file.originalname),
                page: sourcePage,
                reason: `Cartao duplicado para ${target.student.name}.`,
              })
              continue
            }
            usedStudentIds.add(target.student.id)

            let sharedImageObject = savedObjects.get(fileIndex)
            if (!sharedImageObject) {
              sharedImageObject = await this.saveEvaluationCorrectionImage(evaluation.id, 'batch', file)
              savedObjects.set(fileIndex, sharedImageObject)
              persistedObjects.set(`${sharedImageObject.bucket}/${sharedImageObject.key}`, sharedImageObject)
            }

            const now = new Date().toISOString()
            const correction: EvaluationCorrection = {
              id: this.createId('evaluation-correction'),
              schoolId: classRoom.schoolId,
              evaluationId: evaluation.id,
              classId: classRoom.id,
              studentId: target.student.id,
              studentName: target.student.name,
              cardId: target.cardId,
              subject: evaluation.subject,
              status: response.shouldRetakeImage ? 'NEEDS_RETAKE' : 'SUGGESTED',
              imageUrl: '',
              imageObject: { ...sharedImageObject },
              suggestedScore: this.toScore(response.suggestedScore),
              finalScore: null,
              correctCount: Number(response.correctCount) || 0,
              wrongCount: Number(response.wrongCount) || 0,
              blankCount: Number(response.blankCount) || 0,
              multipleCount: Number(response.multipleCount) || 0,
              totalQuestions: Number(response.totalQuestions) || answerKey.length,
              confidence: this.toConfidence(response.confidence),
              requiresReview: true,
              shouldRetakeImage: Boolean(response.shouldRetakeImage),
              failures: Array.isArray(response.failures) ? response.failures.map(String) : [],
              detectedAnswers: this.normalizeCorrectionAnswers(response.detectedAnswers, answerKey),
              answerKey,
              rawOmrResponse: response,
              teacherNotes: null,
              reviewedById: null,
              reviewedAt: null,
              createdById: actorId,
              createdAt: now,
              updatedAt: now,
            }
            correction.imageUrl = `/api/evaluation-corrections/${correction.id}/image`
            if (correction.imageObject) correction.imageObject.publicUrl = correction.imageUrl
            corrections.push(correction)
          }
        }

        if (!corrections.length) {
          throw new BadRequestException(issues[0]?.reason ?? 'Nenhum cartao resposta do lote foi identificado para esta prova.')
        }

        await this.database.updateCommitted((data) => {
          const currentActor = this.ensureCurrentUser(data, actorId)
          const currentEvaluation = data.evaluations.find((item) => item.id === evaluationId)
          if (!currentEvaluation) throw new NotFoundException('Prova nao encontrada.')
          if (!this.canAccessEvaluation(data, currentActor, currentEvaluation)) throw new ForbiddenException('Sem acesso a esta prova.')

          const now = new Date().toISOString()
          for (const correction of corrections) {
            const existingIndex = data.evaluationCorrections.findIndex((item) => item.evaluationId === correction.evaluationId && item.studentId === correction.studentId)
            if (existingIndex >= 0) data.evaluationCorrections[existingIndex] = correction
            else data.evaluationCorrections.unshift(correction)

            const card = data.answerCards.find((item) => item.evaluationId === correction.evaluationId && item.studentId === correction.studentId)
            if (card) {
              card.status = 'USED'
              card.updatedAt = now
            }
          }

          this.pushAudit(data, actorId, 'Processou lote OMR', `${evaluation.title} (${corrections.length} cartoes)`)
        })

        return {
          evaluationId,
          status: issues.length ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED',
          totalSent: files.length,
          corrected: corrections.length,
          needsReview: corrections.filter((correction) => correction.requiresReview).length,
          errorCount: issues.length,
          receivedCount: files.length,
          processedCount: corrections.length,
          skippedCount: issues.length,
          corrections,
          failures: issues,
        }
      } catch (error) {
        for (const imageObject of persistedObjects.values()) this.deleteStoredLocalFile(imageObject, 'private')
        throw error
      }
    }

    return this.runIdempotentOperation(
      actorId,
      evaluation.schoolId ?? classRoom.schoolId ?? actor.schoolId,
      'omr.batch',
      evaluationId,
      { evaluationId, files: files.map((file) => ({ name: file.originalname, size: file.size, type: file.mimetype })) },
      idempotencyKey,
      operation,
    )
  }

  async reviewEvaluationCorrection(actorId: string, correctionId: string, payload: EvaluationCorrectionReviewPayload, idempotencyKey?: string) {
    const snapshot = this.readDataForQuery()
    const actor = this.ensureCurrentUser(snapshot, actorId)
    const correction = snapshot.evaluationCorrections.find((item) => item.id === correctionId)
    if (!correction) throw new NotFoundException('Correcao nao encontrada.')
    const evaluation = snapshot.evaluations.find((item) => item.id === correction.evaluationId)
    if (!evaluation) throw new NotFoundException('Prova da correcao nao encontrada.')
    if (!this.canAccessEvaluation(snapshot, actor, evaluation)) throw new ForbiddenException('Sem acesso a esta correcao.')
    const schoolId = correction.schoolId ?? evaluation.schoolId ?? snapshot.classes.find((classRoom) => classRoom.id === correction.classId)?.schoolId ?? actor.schoolId
    const operation = async () => {
      let updated: EvaluationCorrection | null = null

      await this.database.updateCommitted((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const correction = data.evaluationCorrections.find((item) => item.id === correctionId)
      if (!correction) throw new NotFoundException('Correcao nao encontrada.')
      const evaluation = data.evaluations.find((item) => item.id === correction.evaluationId)
      if (!evaluation) throw new NotFoundException('Prova da correcao nao encontrada.')
      if (!this.canAccessEvaluation(data, actor, evaluation)) throw new ForbiddenException('Sem acesso a esta correcao.')

      const status = payload.status ?? 'CONFIRMED'
      correction.status = status
      correction.finalScore = status === 'CONFIRMED'
        ? this.toScore(payload.finalScore ?? correction.suggestedScore)
        : payload.finalScore == null ? null : this.toScore(payload.finalScore)
      correction.detectedAnswers = Array.isArray(payload.detectedAnswers)
        ? payload.detectedAnswers
        : correction.detectedAnswers
      correction.teacherNotes = payload.teacherNotes == null ? correction.teacherNotes : String(payload.teacherNotes).slice(0, 1200)
      correction.reviewedById = actorId
      correction.reviewedAt = new Date().toISOString()
      correction.updatedAt = correction.reviewedAt

      this.recalculateEvaluationCorrectionSummary(data, correction.evaluationId)
      this.pushAudit(data, actorId, 'Revisou correcao de prova', evaluation.title)
      updated = { ...correction }
    })

      return updated!
    }

    return this.runIdempotentOperation(actorId, schoolId, 'evaluation-corrections.review', correctionId, payload, idempotencyKey, operation)
  }

  async confirmEvaluationCorrections(
    actorId: string,
    evaluationId: string,
    payload: { corrections?: Array<{ id: string; finalScore?: number | null; teacherNotes?: string | null }> },
    idempotencyKey?: string,
  ) {
    const snapshot = this.readDataForQuery()
    const actor = this.ensureCurrentUser(snapshot, actorId)
    const evaluation = snapshot.evaluations.find((item) => item.id === evaluationId)
    if (!evaluation) throw new NotFoundException('Prova nao encontrada.')
    if (!this.canAccessEvaluation(snapshot, actor, evaluation)) throw new ForbiddenException('Sem acesso a esta prova.')

    const schoolId = evaluation.schoolId ?? snapshot.classes.find((classRoom) => classRoom.id === evaluation.classId)?.schoolId ?? actor.schoolId
    const operation = async () => {
      let updatedCount = 0
      const changed: EvaluationCorrection[] = []

      await this.database.updateCommitted((data) => {
        const currentActor = this.ensureCurrentUser(data, actorId)
        const currentEvaluation = data.evaluations.find((item) => item.id === evaluationId)
        if (!currentEvaluation) throw new NotFoundException('Prova nao encontrada.')
        if (!this.canAccessEvaluation(data, currentActor, currentEvaluation)) throw new ForbiddenException('Sem acesso a esta prova.')
        const corrections = Array.isArray(payload.corrections) ? payload.corrections : []
        if (!corrections.length) throw new BadRequestException('Informe ao menos uma correcao para confirmar.')
        const now = new Date().toISOString()

        for (const item of corrections) {
          const correction = data.evaluationCorrections.find((current) => current.id === item.id && current.evaluationId === evaluationId)
          if (!correction) throw new NotFoundException('Correcao nao encontrada.')
          correction.status = 'CONFIRMED'
          correction.finalScore = item.finalScore == null ? this.toScore(correction.suggestedScore) : this.toScore(item.finalScore)
          correction.teacherNotes = item.teacherNotes == null ? correction.teacherNotes : String(item.teacherNotes).slice(0, 1200)
          correction.reviewedById = actorId
          correction.reviewedAt = now
          correction.updatedAt = now
          updatedCount += 1
          changed.push({ ...correction })
        }

        this.recalculateEvaluationCorrectionSummary(data, evaluationId)
        this.pushAudit(data, actorId, 'Confirmou correcoes de prova', currentEvaluation.title)
      })

      return { evaluationId, updatedCount, corrections: changed }
    }

    return this.runIdempotentOperation(actorId, schoolId, 'evaluation-corrections.confirm', evaluationId, payload, idempotencyKey, operation)
  }

  createQuestion(actorId: string, payload: CreateQuestionRequest & { status?: QuestionStatus }) {
    this.ensureRequired(payload, ['title', 'statement', 'gradeLevel', 'area', 'component', 'subject', 'difficulty', 'sourceType', 'sourceName', 'visibility'])
    this.rejectControlledFields(payload as unknown as Record<string, unknown>, ['id', 'schoolId', 'networkId', 'createdById', 'reviewedById', 'reviewedAt', 'createdAt', 'updatedAt', 'archivedAt', 'reviews', 'status'])
    if (payload.metadata?.requestedStatus) {
      throw new BadRequestException('Status de questao deve ser alterado apenas pelo fluxo de revisao.')
    }

    const questionId = this.createId('question')
    let created: Question | null = null

    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const roleCode = this.getCurrentRoleCode(data, actor)
      if (!['SUPERADMIN', 'ADMIN', 'ADMIN_ESCOLA', 'DIRETOR', 'COORDENADOR', 'PROFESSOR'].includes(roleCode)) {
        throw new ForbiddenException('Seu perfil nao pode criar questoes.')
      }
      const requestedVisibility = this.normalizeQuestionVisibility(payload.visibility)
      if ((requestedVisibility === 'GLOBAL' || requestedVisibility === 'NETWORK') && !this.isSuperAdminRole(roleCode)) {
        throw new ForbiddenException('Apenas administradores globais podem publicar questoes globais.')
      }
      if (!this.isSuperAdminRole(roleCode) && !actor.schoolId) {
        throw new ForbiddenException('Usuario sem escola vinculada nao pode criar questoes escolares.')
      }
      const status = this.normalizeQuestionStatus(undefined, 'PENDING_REVIEW')
      const sourceType = roleCode === 'PROFESSOR'
        ? 'TEACHER_CREATED'
        : this.normalizeQuestionSourceType(payload.sourceType)
      if (!this.isSuperAdminRole(roleCode) && ['INEP_ENEM', 'GLOBAL_CURATED'].includes(sourceType)) {
        throw new ForbiddenException('Fonte de questao restrita a curadoria global.')
      }
      const skills = (payload.skillIds ?? []).map((skillId) => {
        const skill = data.curriculumSkills.find((item) => item.id === skillId)
        if (!skill) throw new BadRequestException('Habilidade informada nao existe.')
        return { ...skill, relevance: 'PRIMARY' as const }
      })
      const descriptors = (payload.descriptorIds ?? []).map((descriptorId) => {
        const descriptor = data.assessmentDescriptors.find((item) => item.id === descriptorId)
        if (!descriptor) throw new BadRequestException('Descritor informado nao existe.')
        return this.toQuestionDescriptorSummary(data, descriptor, 'PRIMARY')
      })

      if (!skills.length) throw new BadRequestException('Informe pelo menos uma habilidade.')

      const options = (payload.options ?? []).map((option, index) => ({
        id: this.createId('question-option'),
        questionId,
        label: String(option.label ?? '').trim().toUpperCase() || String.fromCharCode(65 + index),
        text: String(option.text ?? '').trim(),
        order: Number(option.order ?? index + 1),
        isCorrect: Boolean(option.isCorrect),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }))
      if (options.length < 2) throw new BadRequestException('Informe pelo menos duas alternativas.')
      if (options.some((option) => !option.text)) throw new BadRequestException('Todas as alternativas devem ter texto.')
      if (options.filter((option) => option.isCorrect).length !== 1) throw new BadRequestException('Informe exatamente uma alternativa correta.')

      const now = new Date().toISOString()
      created = {
        id: questionId,
        schoolId: actor.schoolId ?? 'global-school',
        networkId: 'global-network',
        createdById: actor.id,
        title: String(payload.title).trim(),
        context: String(payload.context ?? '').trim(),
        statement: String(payload.statement).trim(),
        explanation: String(payload.explanation ?? '').trim(),
        type: this.normalizeQuestionType(payload.type),
        stage: this.normalizeEducationStage(payload.stage),
        gradeLevel: String(payload.gradeLevel).trim(),
        area: String(payload.area).trim(),
        component: String(payload.component).trim(),
        subject: String(payload.subject).trim(),
        difficulty: this.normalizeDifficulty(payload.difficulty),
        sourceType,
        sourceName: String(payload.sourceName).trim(),
        sourceYear: payload.sourceYear ? Number(payload.sourceYear) : new Date().getFullYear(),
        sourceExternalId: payload.sourceExternalId ? String(payload.sourceExternalId).trim() : null,
        sourceUrl: payload.sourceUrl ? String(payload.sourceUrl).trim() : null,
        licenseNotes: payload.licenseNotes ? String(payload.licenseNotes).trim() : null,
        visibility: requestedVisibility,
        status,
        isEditable: true,
        reviewedById: null,
        reviewedAt: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        metadata: { ...(payload.metadata ?? {}), requestedStatus: undefined },
        options,
        skills,
        descriptors,
        attachments: [],
        reviews: status === 'APPROVED'
          ? [{
              id: this.createId('question-review'),
              questionId,
              reviewerId: actor.id,
              status: 'APPROVED',
              comment: 'Questão aprovada no cadastro.',
              reviewedAt: now,
            }]
          : [],
      }

      data.questions.unshift(created)
      this.pushAudit(data, actorId, 'Criou questão', created.title)
    })

    return created!
  }

  deleteQuestion(actorId: string, id: string) {
    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const index = data.questions.findIndex((question) => question.id === id)
      if (index < 0) throw new NotFoundException('Questão não encontrada.')

      const question = data.questions[index]
      if (question.sourceType !== 'TEACHER_CREATED' || !question.isEditable) {
        throw new ForbiddenException('Somente questoes criadas pelo professor podem ser excluidas.')
      }
      this.ensureQuestionMutationAllowed(data, actor, question)

      const [removed] = data.questions.splice(index, 1)
      data.evaluations = data.evaluations.map((evaluation) => (
        evaluation.questionIds?.includes(id)
          ? {
              ...evaluation,
              questionIds: evaluation.questionIds.filter((questionId) => questionId !== id),
              questions: Math.max(0, evaluation.questionIds.filter((questionId) => questionId !== id).length || evaluation.questions - 1),
            }
          : evaluation
      ))
      this.pushAudit(data, actorId, 'Removeu questão', removed.title)
    })

    return { success: true }
  }

  reviewQuestion(actorId: string, id: string, payload: { action: 'APPROVE' | 'REJECT'; reason?: string | null }) {
    let updated: Question | null = null

    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      const roleCode = this.getCurrentRoleCode(data, actor)
      const role = data.roles.find((item) => item.id === actor.roleId || item.code === actor.roleId)
      const hasExplicitPermission = role?.permissions?.some((permission) => ['questions:review', 'CAN_REVIEW_QUESTIONS'].includes(permission)) ?? false
      if (!this.isSuperAdminRole(roleCode) && !this.isSchoolAdminRole(roleCode) && !hasExplicitPermission) {
        throw new ForbiddenException('Seu perfil nao pode revisar questoes.')
      }

      const question = data.questions.find((item) => item.id === id)
      if (!question) throw new NotFoundException('Questao nao encontrada.')
      if (!this.isSuperAdminRole(roleCode) && actor.schoolId && question.schoolId !== actor.schoolId) {
        throw new ForbiddenException('Sem permissao para revisar esta questao.')
      }
      if (question.createdById === actor.id || question.createdById === actor.linkedTeacherId) {
        throw new ForbiddenException('Criador da questao nao pode aprovar a propria questao.')
      }
      if (question.status === 'ARCHIVED') throw new BadRequestException('Questao arquivada nao pode ser revisada.')

      const now = new Date().toISOString()
      const approved = payload.action === 'APPROVE'
      question.status = approved ? 'APPROVED' : 'REJECTED'
      question.reviewedById = actor.id
      question.reviewedAt = now
      question.updatedAt = now
      question.reviews = [
        {
          id: this.createId('question-review'),
          questionId: question.id,
          reviewerId: actor.id,
          status: approved ? 'APPROVED' : 'REJECTED',
          comment: String(payload.reason ?? '').slice(0, 1200),
          reviewedAt: now,
        },
        ...(question.reviews ?? []),
      ]
      updated = { ...question }
      this.pushAudit(data, actorId, approved ? 'Aprovou questao' : 'Rejeitou questao', question.title)
    })

    return updated!
  }

  generateQuestionSelection(actorId: string, payload: GenerateQuestionSelectionRequest): GenerateQuestionSelectionResponse {
    const requestedQuantity = this.normalizeQuestionQuantity(payload.quantity)
    const subjectFilter = this.normalizeTextKey(payload.subject)
    if (!subjectFilter) throw new BadRequestException('Informe a disciplina para gerar questoes.')

    const gradeFilter = this.normalizeSelectionFilter(payload.gradeLevel)
    const difficultyFilter = this.normalizeSelectionFilter(payload.difficulty)
    const skillFilter = this.normalizeSelectionFilter(payload.skillCode)
    const descriptorFilter = this.normalizeSelectionFilter(payload.descriptorCode)
    const sourceMode = payload.sourceMode === 'enem' || payload.sourceMode === 'mixed' ? payload.sourceMode : 'system'
    const data = this.readDataForQuery()
    const actor = this.ensureCurrentUser(data, actorId)
    const roleCode = this.getCurrentRoleCode(data, actor)

    const sourcePool = data.questions.filter((question) => {
      if (question.status !== 'APPROVED') return false
      if (!this.canUseQuestionInSelection(question, actor, roleCode)) return false
      if (sourceMode === 'enem' && question.sourceType !== 'INEP_ENEM') return false
      if (sourceMode === 'system' && question.sourceType === 'INEP_ENEM') return false
      if (gradeFilter && !this.questionMatchesGradeFilter(question.gradeLevel, gradeFilter)) return false
      if (difficultyFilter && this.normalizeTextKey(question.difficulty) !== difficultyFilter) return false
      if (skillFilter && !question.skills.some((skill) => this.normalizeTextKey(skill.code) === skillFilter)) return false
      if (descriptorFilter && !question.descriptors.some((descriptor) => this.normalizeTextKey(descriptor.code) === descriptorFilter)) return false
      return this.questionMatchesSubjectFilter(question, subjectFilter)
    })

    if (!sourcePool.length) {
      return { questions: [], questionIds: [], totalEligible: 0 }
    }

    const selectedQuestions = sourceMode === 'mixed'
      ? this.buildMixedQuestionSelection(sourcePool, requestedQuantity)
      : this.shuffleItems(sourcePool).slice(0, requestedQuantity)

    return {
      questions: selectedQuestions,
      questionIds: selectedQuestions.map((question) => question.id),
      totalEligible: sourcePool.length,
    }
  }

  async generateEnemQuestions(actorId: string, payload: GenerateEnemQuestionsRequest): Promise<GenerateEnemQuestionsResponse> {
    const requestedQuantity = this.normalizeQuestionQuantity(payload.quantity)
    const years = this.normalizeEnemYears(payload.years)
    const disciplineFilter = this.normalizeEnemDisciplineFilter(payload.discipline ?? payload.subject)

    this.ensureCurrentUser(this.readDataForQuery(), actorId)

    const currentData = this.readDataForQuery()
    const cachedQuestions = currentData.questions.filter((question) =>
      question.sourceType === 'INEP_ENEM' &&
      question.sourceYear !== null &&
      years.includes(question.sourceYear) &&
      (!disciplineFilter || question.metadata.enemDiscipline === disciplineFilter),
    )
    const cachedYears = new Set(
      payload.refresh
        ? []
        : currentData.questions
          .filter((question) => question.sourceType === 'INEP_ENEM' && question.sourceYear !== null)
          .map((question) => question.sourceYear as number),
    )
    const missingYears = years.filter((year) => !cachedYears.has(year))
    const fetchedQuestions = missingYears.length > 0
      ? await this.fetchEnemDevQuestions(missingYears)
      : []
    const mappedFetchedQuestions = await Promise.all(
      fetchedQuestions.map((question) => this.toEnemQuestionWithEmbeddedImages(question, actorId)),
    )
    const eligibleFetchedQuestions = mappedFetchedQuestions.filter((question) =>
      !disciplineFilter || question.metadata.enemDiscipline === disciplineFilter,
    )
    const eligibleQuestions = [...cachedQuestions, ...eligibleFetchedQuestions]

    if (eligibleQuestions.length === 0) {
      throw new BadRequestException('Nenhuma questão do ENEM foi encontrada para os filtros informados.')
    }

    const selectedQuestions = this.shuffleItems(eligibleQuestions).slice(0, requestedQuantity)
    const selectedIds = new Set(selectedQuestions.map((question) => question.id))
    let persistedSelectedQuestions: Question[] = []
    let importedCount = 0

    this.database.update((data) => {
      this.ensureCurrentUser(data, actorId)
      importedCount = this.upsertEnemQuestions(data, mappedFetchedQuestions)
      this.updateEnemImportPlan(data, years)
      persistedSelectedQuestions = selectedQuestions
        .map((question) => data.questions.find((item) => item.id === question.id || item.sourceExternalId === question.sourceExternalId) ?? question)
        .filter((question) => selectedIds.has(question.id))
    })

    return {
      questions: persistedSelectedQuestions,
      requestedQuantity,
      selectedQuantity: persistedSelectedQuestions.length,
      fetchedCount: fetchedQuestions.length,
      importedCount,
      years,
      sourceType: 'INEP_ENEM',
    }
  }

  createMealItem(actorId: string, managementId: string, payload: CreateMealItemPayload) {
    const alimentoId = Number(payload.alimentoId)
    const quantidade = Number(payload.quantidade)
    const valorUnitario = Number(payload.valorUnitario)
    const fornecedorNome = String(payload.fornecedorNome ?? '').trim()
    const quantidadeMinima = Number(payload.quantidadeMinima ?? Math.max(1, Math.round(quantidade * 0.2)))
    const dataValidade = this.normalizeMealDate(payload.dataValidade)
    let updated: MealManagement | null = null

    if (!Number.isInteger(alimentoId) || alimentoId <= 0) throw new BadRequestException('Alimento informado e invalido.')
    if (!Number.isFinite(quantidade) || quantidade <= 0) throw new BadRequestException('Quantidade deve ser maior que zero.')
    if (!Number.isFinite(valorUnitario) || valorUnitario <= 0) throw new BadRequestException('Valor unitario deve ser maior que zero.')
    if (!fornecedorNome) throw new BadRequestException('Informe o fornecedor do alimento.')
    if (quantidadeMinima < 0) throw new BadRequestException('Quantidade minima nao pode ser negativa.')

    this.database.update((data) => {
      this.ensureRole(data, actorId, 'ADMIN')
      const index = data.mealManagements.findIndex((management) => management.id === managementId)
      if (index < 0) throw new NotFoundException('Gestao de merenda nao encontrada.')

      const management = data.mealManagements[index]
      const food = management.alimentosCadastrados.find((item) => item.id === alimentoId && item.ativo)
        ?? data.mealFoods.find((item) => item.id === alimentoId && item.ativo)
      if (!food) throw new BadRequestException('Alimento nao encontrado no catalogo da merenda.')
      if (!management.alimentosCadastrados.some((item) => item.id === food.id)) {
        management.alimentosCadastrados.push(food)
      }

      const valorTotal = Number((quantidade * valorUnitario).toFixed(2))
      const saldoAntes = management.orcamentoMensal.valorDisponivel
      const saldoDepois = Number((saldoAntes - valorTotal).toFixed(2))
      if (!management.orcamentoMensal.permitirUltrapassarLimite && saldoDepois < 0) {
        throw new BadRequestException('Compra ultrapassa o limite mensal da merenda.')
      }

      const itemId = this.createId('meal-item')
      const stockStatus = this.resolveMealStockStatus(quantidade, quantidadeMinima, dataValidade)
      const item = {
        id: itemId,
        alimentoId: food.id,
        nomeAlimento: food.nome,
        categoria: food.categoria,
        quantidade,
        unidadeMedida: food.unidadeMedida,
        valorUnitario,
        valorTotal,
        dataValidade,
        possuiValidade: Boolean(dataValidade ?? payload.possuiValidade),
        lote: payload.lote ? String(payload.lote).trim() : null,
        fornecedor: {
          id: this.createId('supplier'),
          nome: fornecedorNome,
        },
        statusEstoque: stockStatus,
        adicionadoPorId: actorId,
        adicionadoEm: new Date().toISOString(),
      }

      management.itensMerenda.unshift(item)
      management.estoqueMerenda.unshift({
        id: this.createId('meal-stock'),
        itemMerendaId: itemId,
        alimentoId: food.id,
        nomeAlimento: food.nome,
        quantidadeAtual: quantidade,
        quantidadeMinima,
        unidadeMedida: food.unidadeMedida,
        dataValidade,
        status: stockStatus,
      })
      management.movimentacoesOrcamento.unshift({
        id: this.createId('meal-budget-movement'),
        tipo: 'COMPRA',
        itemMerendaId: itemId,
        descricao: `Adicao de ${food.nome} ao estoque da merenda`,
        valor: valorTotal,
        saldoAntes,
        saldoDepois,
        responsavelId: actorId,
        dataMovimentacao: new Date().toISOString(),
      })

      updated = this.recalculateMealManagement(management)
      data.mealManagements[index] = updated
      this.pushAudit(data, actorId, 'Adicionou item de merenda', food.nome)
    })

    return updated!
  }

  listCalendarEvents(actorId: string) {
    const data = this.readDataForQuery()
    const actor = this.ensureCurrentUser(data, actorId)
    return this.getScopedDatabaseView(data, actor).calendarEvents
  }

  createCalendarEvent(actorId: string, payload: Partial<SchoolCalendarEvent>) {
    this.ensureRequired(payload, ['title', 'type', 'schoolId', 'startsAt', 'endsAt'])
    this.rejectControlledFields(payload, ['id', 'createdById'])
    let calendarEvent: SchoolCalendarEvent | null = null

    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
      this.ensureCalendarEventScopeAllowed(data, actor, payload)
      calendarEvent = this.buildCalendarEvent(data, { ...payload, createdById: actorId })
      data.calendarEvents.unshift(calendarEvent)
      this.pushAudit(data, actorId, 'Criou evento no calendario', calendarEvent.title)
    })

    return calendarEvent!
  }

  updateCalendarEvent(actorId: string, id: string, payload: Partial<SchoolCalendarEvent>) {
    this.rejectControlledFields(payload, ['id', 'createdById'])
    let updated: SchoolCalendarEvent | null = null

    this.database.update((data) => {
      const index = data.calendarEvents.findIndex((event) => event.id === id)
      if (index < 0) throw new NotFoundException('Evento de calendario nao encontrado.')

      const current = data.calendarEvents[index]
      const actor = this.ensureCurrentUser(data, actorId)
      this.ensureCalendarEventMutationAllowed(data, actorId, current)
      const candidate = { ...current, ...payload, id, createdById: current.createdById }
      this.ensureCalendarEventScopeAllowed(data, actor, candidate)
      updated = this.buildCalendarEvent(data, candidate, id)
      data.calendarEvents[index] = updated
      this.pushAudit(data, actorId, 'Atualizou evento no calendario', updated.title)
    })

    return updated!
  }

  deleteCalendarEvent(actorId: string, id: string) {
    this.database.update((data) => {
      const index = data.calendarEvents.findIndex((event) => event.id === id)
      if (index < 0) throw new NotFoundException('Evento de calendario nao encontrado.')

      this.ensureCalendarEventMutationAllowed(data, actorId, data.calendarEvents[index])
      const [removed] = data.calendarEvents.splice(index, 1)
      this.pushAudit(data, actorId, 'Removeu evento do calendario', removed.title)
    })

    return { success: true }
  }

  createRoomReservation(actorId: string, payload: Partial<RoomReservation>) {
    this.ensureRequired(payload, ['room', 'date', 'startTime', 'endTime', 'classId', 'purpose'])
    let roomReservation: RoomReservation | null = null

    this.database.update((data) => {
      const currentUser = this.ensureCurrentUser(data, actorId)
      const scoped = this.getScopedSchoolsData(data, currentUser)
      const allowedClassIds = new Set(scoped.classes.map((classRoom) => classRoom.id))
      const classRoom = data.classes.find((item) => item.id === String(payload.classId ?? '').trim())

      if (!classRoom) throw new BadRequestException('Turma informada nao existe.')
      if (!allowedClassIds.has(classRoom.id)) throw new ForbiddenException('Seu perfil nao pode reservar esta turma.')

      roomReservation = this.buildRoomReservation(data, payload)
      data.roomReservations.unshift(roomReservation)
      this.pushAudit(data, actorId, 'Reservou ambiente', `${roomReservation.room} - ${classRoom.name}`)
    })

    return roomReservation!
  }

  createLessonRecord(actorId: string, payload: Partial<LessonRecord>) {
    this.ensureRequired(payload, ['classId', 'subject', 'date', 'time', 'content', 'plan', 'resources', 'activity'])
    let lessonRecord: LessonRecord | null = null

    this.database.update((data) => {
      const currentUser = this.ensureCurrentUser(data, actorId)
      const roleCode = data.roles.find((role) => role.id === currentUser.roleId)?.code
        ?? data.roles.find((role) => role.id === currentUser.roleId)?.name
      if (!['ADMIN', 'DIRETOR', 'COORDENADOR', 'PROFESSOR'].includes(String(roleCode ?? ''))) {
        throw new ForbiddenException('Seu perfil nao pode registrar aulas.')
      }

      const scoped = this.getScopedSchoolsData(data, currentUser)
      const allowedClassIds = new Set(scoped.classes.map((classRoom) => classRoom.id))
      const classRoom = data.classes.find((item) => item.id === String(payload.classId ?? '').trim())

      if (!classRoom) throw new BadRequestException('Turma informada nao existe.')
      if (!allowedClassIds.has(classRoom.id)) throw new ForbiddenException('Seu perfil nao pode registrar aula nesta turma.')

      lessonRecord = this.buildLessonRecord(data, payload)
      data.lessonRecords.unshift(lessonRecord)
      this.pushAudit(data, actorId, 'Registrou aula', `${lessonRecord.subject} - ${classRoom.name}`)
    })

    return lessonRecord!
  }

  updateLessonRecord(actorId: string, id: string, payload: Partial<LessonRecord>) {
    let lessonRecord: LessonRecord | null = null

    this.database.update((data) => {
      const currentUser = this.ensureCurrentUser(data, actorId)
      const roleCode = data.roles.find((role) => role.id === currentUser.roleId)?.code
        ?? data.roles.find((role) => role.id === currentUser.roleId)?.name
      if (!['ADMIN', 'DIRETOR', 'COORDENADOR', 'PROFESSOR'].includes(String(roleCode ?? ''))) {
        throw new ForbiddenException('Seu perfil nao pode atualizar registros de aula.')
      }

      const index = data.lessonRecords.findIndex((record) => record.id === id)
      if (index < 0) throw new NotFoundException('Registro de aula nao encontrado.')

      const scoped = this.getScopedSchoolsData(data, currentUser)
      const allowedClassIds = new Set(scoped.classes.map((classRoom) => classRoom.id))
      const merged = { ...data.lessonRecords[index], ...payload }
      const classRoom = data.classes.find((item) => item.id === String(merged.classId ?? '').trim())

      if (!classRoom) throw new BadRequestException('Turma informada nao existe.')
      if (!allowedClassIds.has(classRoom.id)) throw new ForbiddenException('Seu perfil nao pode atualizar aula nesta turma.')

      lessonRecord = this.buildLessonRecord(data, merged, id)
      data.lessonRecords[index] = lessonRecord
      this.pushAudit(data, actorId, 'Atualizou aula', `${lessonRecord.subject} - ${classRoom.name}`)
    })

    return lessonRecord!
  }

  updateRole(actorId: string, id: string, payload: Partial<Role>) {
    this.rejectControlledFields(payload, ['id', 'code', 'name'])
    let updated: Role | null = null
    this.database.update((data) => {
      this.ensureGlobalAdmin(data, actorId)
      const index = data.roles.findIndex((role) => role.id === id)
      if (index < 0) throw new NotFoundException('Cargo nao encontrado.')
      const roleCode = data.roles[index].code
      const deniedPermissions = forbiddenRolePermissions[roleCode] ?? []
      const permissions = Array.isArray(payload.permissions)
        ? payload.permissions.filter((permission) => !deniedPermissions.includes(permission))
        : data.roles[index].permissions.filter((permission) => !deniedPermissions.includes(permission))
      updated = {
        ...data.roles[index],
        id,
        description: payload.description === undefined ? data.roles[index].description : String(payload.description).trim(),
        permissions,
      }
      data.roles[index] = updated
      this.revokeRefreshSessionsForRole(data, id)
      this.pushAudit(data, actorId, 'Atualizou permissoes do cargo', updated.name)
    })
    return updated!
  }

  updateUserRole(actorId: string, id: string, roleId: string) {
    let updated: UserAccount | null = null
    const data = this.database.update((data) => {
      const actor = this.ensureGlobalAdmin(data, actorId)
      if (actor.id === id) throw new ForbiddenException('Nao e permitido alterar o proprio cargo.')
      const role = this.resolveRole(data, roleId)
      if (!role) throw new BadRequestException('Cargo informado nao existe.')
      if (role.code === 'SUPERADMIN' && !this.isSuperAdminRole(this.getCurrentRoleCode(data, actor))) {
        throw new ForbiddenException('Apenas SUPERADMIN pode criar ou atribuir SUPERADMIN.')
      }
      const index = data.users.findIndex((user) => user.id === id)
      if (index < 0) throw new NotFoundException('Usuario nao encontrado.')
      updated = { ...data.users[index], roleId: role.id }
      data.users[index] = updated
      this.revokeRefreshSessionsForUser(data, id)
      this.pushAudit(data, actorId, 'Alterou cargo do usuario', updated.name)
    })
    return this.toPublicUserWithResolvedSchool(data, updated!)
  }

  updateUserSchool(actorId: string, id: string, schoolId: string | null | undefined) {
    let updated: UserAccount | null = null
    const data = this.database.update((data) => {
      this.ensureGlobalAdmin(data, actorId)
      const normalizedSchoolId = schoolId === null || schoolId === undefined || String(schoolId).trim() === '' || String(schoolId).trim() === 'network'
        ? null
        : String(schoolId).trim()
      const school = normalizedSchoolId ? this.ensureSchoolExists(data, normalizedSchoolId) : null
      const index = data.users.findIndex((user) => user.id === id)
      if (index < 0) throw new NotFoundException('Usuario nao encontrado.')
      updated = { ...data.users[index], schoolId: normalizedSchoolId }
      data.users[index] = updated
      this.revokeRefreshSessionsForUser(data, id)
      this.pushAudit(data, actorId, 'Alterou escola vinculada do usuario', `${updated.name} - ${school?.name ?? 'Sem escola vinculada'}`)
    })
    return this.toPublicUserWithResolvedSchool(data, updated!)
  }

  updateProfile(actorId: string, payload: Partial<UserAccount>) {
    this.rejectControlledFields(payload, ['id', 'roleId', 'schoolId', 'status', 'password', 'tokenVersion', 'passwordHash', 'refreshTokenHash', 'avatarUrl', 'bannerUrl', 'avatarObject', 'bannerObject', 'linkedTeacherId', 'linkedStudentId', 'linkedGuardianId'])
    let updated: UserAccount | null = null
    const data = this.database.update((data) => {
      const index = data.users.findIndex((user) => user.id === actorId)
      if (index < 0) throw new NotFoundException('Usuario nao encontrado.')
      const current = data.users[index]
      const profile = this.normalizeProfilePayload(payload, current, data.users)
      updated = {
        ...current,
        ...profile,
      }
      data.users[index] = updated
      this.syncLinkedProfile(data, current, updated)
      this.pushAudit(data, actorId, 'Atualizou o proprio perfil', updated.name)
    })
    return this.toPublicUserWithResolvedSchool(data, updated!)
  }

  async updateProfileAvatar(actorId: string, file: ProfileImageFile) {
    const current = this.getUserById(actorId)
    const avatarObject = await this.saveProfileImageFile(actorId, file, 'avatars')
    this.deleteProfileImageFile(current.avatarObject ?? current.avatarUrl)
    return this.updateProfileMedia(actorId, { avatarUrl: avatarObject.publicUrl, avatarObject })
  }

  async updateProfileBanner(actorId: string, file: ProfileImageFile) {
    const current = this.getUserById(actorId)
    const bannerObject = await this.saveProfileImageFile(actorId, file, 'banners')
    this.deleteProfileImageFile(current.bannerObject ?? current.bannerUrl)
    return this.updateProfileMedia(actorId, { bannerUrl: bannerObject.publicUrl, bannerObject })
  }

  deleteProfileAvatar(actorId: string) {
    const current = this.getUserById(actorId)
    this.deleteProfileImageFile(current.avatarObject ?? current.avatarUrl)
    return this.updateProfileMedia(actorId, { avatarUrl: '', avatarObject: null })
  }

  deleteProfileBanner(actorId: string) {
    const current = this.getUserById(actorId)
    this.deleteProfileImageFile(current.bannerObject ?? current.bannerUrl)
    return this.updateProfileMedia(actorId, { bannerUrl: '', bannerObject: null })
  }

  private updateProfileMedia(actorId: string, media: Pick<Partial<UserAccount>, 'avatarUrl' | 'bannerUrl' | 'avatarObject' | 'bannerObject'>) {
    let updated: UserAccount | null = null
    const data = this.database.update((data) => {
      const index = data.users.findIndex((user) => user.id === actorId)
      if (index < 0) throw new NotFoundException('Usuario nao encontrado.')
      const current = data.users[index]
      updated = { ...current, ...media }
      data.users[index] = updated
      this.syncLinkedProfile(data, current, updated)
      this.pushAudit(data, actorId, 'Atualizou midia do perfil', updated.name)
    })
    return this.toPublicUserWithResolvedSchool(data, updated!)
  }

  private syncNotificationsForUser(userId: string) {
    const currentData = this.readDataForQuery()
    const currentUser = this.ensureCurrentUser(currentData, userId)
    if (!this.shouldSyncNotificationsForUser(currentData, currentUser)) return currentData

    return this.database.update((data) => {
      const writableUser = this.ensureCurrentUser(data, userId)
      this.syncNotificationsForUserInData(data, writableUser)
    })
  }

  private shouldSyncNotificationsForUser(data: DatabaseShape, currentUser: UserAccount) {
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const highRiskStudents = scoped.students.filter((student) => student.status === 'matriculado' && student.desempenho === 'Baixo')

    for (const student of highRiskStudents) {
      const existing = data.notifications.find((notification) => (
        notification.userId === currentUser.id
        && notification.sourceType === 'student-risk'
        && notification.sourceId === student.id
      ))
      const title = `${student.name} em risco pedagogico`
      const description = `Frequencia ${student.attendanceRate}% e media ${student.averageScore.toFixed(1)}. Recomenda-se intervencao da coordenacao.`
      if (!existing || existing.title !== title || existing.description !== description || existing.tone !== 'danger') return true
    }

    return false
  }

  private syncNotificationsForUserInData(data: DatabaseShape, currentUser: UserAccount) {
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const highRiskStudents = scoped.students.filter((student) => student.status === 'matriculado' && student.desempenho === 'Baixo')
    const now = new Date().toISOString()

    for (const student of highRiskStudents) {
      const existing = data.notifications.find((notification) => (
        notification.userId === currentUser.id
        && notification.sourceType === 'student-risk'
        && notification.sourceId === student.id
      ))
      const title = `${student.name} em risco pedagogico`
      const description = `Frequencia ${student.attendanceRate}% e media ${student.averageScore.toFixed(1)}. Recomenda-se intervencao da coordenacao.`

      if (existing) {
        if (existing.title !== title || existing.description !== description || existing.tone !== 'danger') {
          existing.title = title
          existing.description = description
          existing.tone = 'danger'
          existing.updatedAt = now
        }
        continue
      }

      data.notifications.push({
        id: this.createId('notification'),
        userId: currentUser.id,
        title,
        description,
        tone: 'danger',
        sourceType: 'student-risk',
        sourceId: student.id,
        readAt: null,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  private buildNotificationsPayload(data: DatabaseShape, userId: string): NotificationsScreenPayload {
    const notifications = this.getUserNotifications(data, userId)

    return {
      notifications,
      unreadCount: notifications.filter((notification) => !notification.readAt).length,
      totalCount: notifications.length,
    }
  }

  private getUserNotifications(data: DatabaseShape, userId: string): AppNotification[] {
    return data.notifications
      .filter((notification) => notification.userId === userId)
      .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime())
  }

  private getUnreadNotificationCount(data: DatabaseShape, userId: string) {
    return data.notifications.filter((notification) => notification.userId === userId && !notification.readAt).length
  }

  private dashboardEvaluationDto(evaluation: Evaluation): Evaluation {
    return {
      id: evaluation.id,
      schoolId: evaluation.schoolId,
      teacherId: evaluation.teacherId,
      title: evaluation.title,
      classId: evaluation.classId,
      subject: evaluation.subject,
      questions: evaluation.questions,
      scheduledAt: evaluation.scheduledAt,
      status: evaluation.status,
      corrected: evaluation.corrected,
      participants: evaluation.participants,
      averageScore: evaluation.averageScore,
      triLevel: evaluation.triLevel,
      buildMode: evaluation.buildMode,
      createdById: evaluation.createdById,
      createdByName: evaluation.createdByName,
      createdBy: evaluation.createdBy,
    } as Evaluation
  }

  private buildDashboard(data: DatabaseShape = this.readDataForQuery(), alertPage: string | number = 1, alertLimit: string | number = 10) {
    const activeStudents = data.students.filter((student) => student.status === 'matriculado')
    const avgAttendance = this.average(activeStudents.map((student) => student.attendanceRate))
    const avgScore = this.average(activeStudents.map((student) => student.averageScore))
    const highRisk = activeStudents.filter((student) => student.desempenho === 'Baixo')
    const classNameById = new Map(data.classes.map((classRoom) => [classRoom.id, classRoom.name]))
    const studentsByClassId = new Map<string, Student[]>()
    const proficiencyCounts = { belowBasic: 0, basic: 0, adequate: 0, advanced: 0 }
    for (const student of activeStudents) {
      const classStudents = studentsByClassId.get(student.classId) ?? []
      classStudents.push(student)
      studentsByClassId.set(student.classId, classStudents)

      if (student.averageScore < 6) proficiencyCounts.belowBasic += 1
      else if (student.averageScore < 7.5) proficiencyCounts.basic += 1
      else if (student.averageScore < 9) proficiencyCounts.adequate += 1
      else proficiencyCounts.advanced += 1
    }
    const alerts = highRisk.map((student) => ({
      id: `alert-${student.id}`,
      title: `${student.name} em risco pedagogico`,
      description: `Frequencia ${student.attendanceRate}% e media ${student.averageScore.toFixed(1)}. Recomenda-se intervencao da coordenacao.`,
      tone: 'danger' as const,
      studentId: student.id,
      student: {
        id: student.id,
        name: student.name,
        classId: student.classId,
        className: classNameById.get(student.classId),
        attendanceRate: student.attendanceRate,
        averageScore: student.averageScore,
        avatarUrl: student.avatarUrl,
        bannerUrl: student.bannerUrl,
      },
    }))
    const alertsPage = this.paginate(alerts, alertPage, alertLimit, 10)

    return {
      metrics: [
        { id: 'schools', label: 'Escolas', value: String(data.schools.length), detail: 'Unidades ativas na rede', tone: 'blue' as const },
        { id: 'classes', label: 'Turmas', value: String(data.classes.length), detail: 'Turmas em acompanhamento', tone: 'green' as const },
        { id: 'attendance', label: 'Frequencia media', value: `${avgAttendance.toFixed(0)}%`, detail: 'Baseada nos alunos matriculados', tone: 'amber' as const },
        { id: 'risk', label: 'Risco alto', value: String(highRisk.length), detail: 'Alunos exigindo intervencao', tone: 'rose' as const },
      ],
      attendanceByClass: data.classes.map((classRoom) => {
        const students = studentsByClassId.get(classRoom.id) ?? []
        return { className: classRoom.name, frequencia: Math.round(this.average(students.map((student) => student.attendanceRate))), media: Number(this.average(students.map((student) => student.averageScore)).toFixed(1)) }
      }),
      proficiencyDistribution: [
        { level: 'Abaixo do basico', alunos: proficiencyCounts.belowBasic },
        { level: 'Basico', alunos: proficiencyCounts.basic },
        { level: 'Adequado', alunos: proficiencyCounts.adequate },
        { level: 'Avancado', alunos: proficiencyCounts.advanced },
      ],
      subjectRadar: [
        { subject: 'Portugues', acertos: 72 },
        { subject: 'Matematica', acertos: 64 },
        { subject: 'Ciencias', acertos: 78 },
        { subject: 'Humanas', acertos: 69 },
      ],
      alerts: alertsPage.items,
      alertsSummary: {
        danger: highRisk.length,
        warning: 0,
        info: 0,
      },
      alertsPagination: alertsPage.pagination,
    }
  }

  private ensureCurrentMonthMealManagements(actorId?: string) {
    const mesReferencia = this.getCurrentReferenceMonth()
    if (!this.hasMissingMealManagements(this.readDataForQuery(), mesReferencia)) return

    this.database.update((data) => {
      this.createMissingMealManagements(data, mesReferencia, actorId)
    })
  }

  private ensureMealManagementDataReady(actorId?: string) {
    const mesReferencia = this.getCurrentReferenceMonth()
    const currentData = this.readDataForQuery()
    const hasApprovedRequestsWaitingForStock = currentData.mealFoodRequests.some((request) => (
      request.status === 'APPROVED_BY_NUTRITIONIST' && !request.stockItemId
    ))

    if (!this.hasMissingMealManagements(currentData, mesReferencia) && !hasApprovedRequestsWaitingForStock) return

    this.database.update((data) => {
      this.createMissingMealManagements(data, mesReferencia, actorId)
      this.syncApprovedMealFoodRequestsToStock(data, actorId)
    })
  }

  private hasMissingMealManagements(data: DatabaseShape, mesReferencia: string) {
    const existingKeys = new Set(data.mealManagements.map((management) => `${management.escolaId}:${management.mesReferencia}`))
    return data.schools.some((school) => school.active !== false && !existingKeys.has(`${school.id}:${mesReferencia}`))
  }

  private createMissingMealManagements(data: DatabaseShape, mesReferencia: string, actorId?: string) {
    const existingKeys = new Set(data.mealManagements.map((management) => `${management.escolaId}:${management.mesReferencia}`))
    const created: MealManagement[] = []
    const fallbackResponsibleId = this.getFallbackMealResponsibleId(data, actorId)

    for (const school of data.schools) {
      if (school.active === false) continue

      const key = `${school.id}:${mesReferencia}`
      if (existingKeys.has(key)) continue

      const responsibleId = data.users.find((user) => user.schoolId === school.id)?.id ?? fallbackResponsibleId
      created.push(this.buildEmptyMealManagement(school.id, mesReferencia, responsibleId))
      existingKeys.add(key)
    }

    if (!created.length) return

    data.mealManagements.unshift(...created)
    if (actorId) this.pushAudit(data, actorId, 'Criou gestoes de merenda pendentes', `${created.length} escola(s) ${mesReferencia}`)
  }

  private buildEmptyMealManagement(escolaId: string, mesReferencia: string, responsibleId: string): MealManagement {
    return this.recalculateMealManagement({
      id: this.createId('meal-management'),
      escolaId,
      mesReferencia,
      status: 'ATIVO',
      orcamentoMensal: {
        id: this.createId('meal-budget'),
        valorLimite: defaultMealBudgetLimit,
        valorUtilizado: 0,
        valorDisponivel: defaultMealBudgetLimit,
        percentualUtilizado: 0,
        status: 'DENTRO_DO_LIMITE',
        alertaAoAtingirPercentual: defaultMealBudgetAlertPercent,
        permitirUltrapassarLimite: false,
      },
      responsaveisGestao: {
        diretorId: responsibleId,
        nutricionistaId: responsibleId,
        merendeiroId: responsibleId,
        responsavelFinanceiroId: responsibleId,
      },
      alimentosCadastrados: [],
      cardapios: [],
      itensMerenda: [],
      movimentacoesOrcamento: [],
      estoqueMerenda: [],
      resumo: {
        totalItens: 0,
        totalKgComprado: 0,
        valorTotalComprado: 0,
        orcamentoInicial: defaultMealBudgetLimit,
        orcamentoRestante: defaultMealBudgetLimit,
        percentualUtilizado: 0,
        statusOrcamento: 'DENTRO_DO_LIMITE',
        itensBaixoEstoque: 0,
        itensVencidos: 0,
      },
    })
  }

  private getFallbackMealResponsibleId(data: DatabaseShape, actorId?: string) {
    if (actorId && data.users.some((user) => user.id === actorId)) return actorId

    const adminRoleId = data.roles.find((role) => role.code === 'ADMIN')?.id
    return data.users.find((user) => user.roleId === adminRoleId)?.id
      ?? data.users[0]?.id
      ?? 'sistema'
  }

  private getCurrentReferenceMonth() {
    return new Date().toISOString().slice(0, 7)
  }

  private recalculateMealManagement(management: MealManagement): MealManagement {
    const valorUtilizado = Number(management.itensMerenda.reduce((sum, item) => sum + item.valorTotal, 0).toFixed(2))
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

  private resolveMealBudgetStatus(percentualUtilizado: number, valorDisponivel: number, alertPercent: number) {
    if (valorDisponivel < 0) return 'ULTRAPASSADO' as const
    if (percentualUtilizado >= alertPercent) return 'EM_ALERTA' as const
    return 'DENTRO_DO_LIMITE' as const
  }

  private resolveMealStockStatus(quantity: number, minimum: number, validity?: string | null): MealStockStatus {
    if (validity && new Date(`${validity}T00:00:00.000Z`) < new Date()) return 'VENCIDO'
    if (quantity <= minimum) return 'BAIXO'
    return 'DISPONIVEL'
  }

  private getMealManagementIndex(data: { mealManagements: MealManagement[] }, managementId: string) {
    const index = data.mealManagements.findIndex((management) => management.id === managementId)
    if (index < 0) throw new NotFoundException('Gestao de merenda nao encontrada.')
    return index
  }

  private getLatestMealManagementIndexForSchool(data: { mealManagements: MealManagement[] }, schoolId: string) {
    const index = data.mealManagements.findIndex((management) => management.escolaId === schoolId && management.status === 'ATIVO')
    if (index >= 0) return index
    const fallbackIndex = data.mealManagements.findIndex((management) => management.escolaId === schoolId)
    if (fallbackIndex < 0) throw new NotFoundException('Gestao de merenda nao encontrada para esta escola.')
    return fallbackIndex
  }

  private resolveFoodRequestSchoolId(data: DatabaseShape, actor: UserAccount, roleCode: RoleCode, value?: string | null) {
    const requestedSchoolId = String(value ?? '').trim()
    if (roleCode === 'DIRETOR') {
      if (!actor.schoolId) throw new BadRequestException('Diretor nao possui escola vinculada.')
      if (requestedSchoolId && requestedSchoolId !== actor.schoolId) {
        throw new ForbiddenException('Diretor so pode solicitar alimentos para a propria escola.')
      }
      return actor.schoolId
    }

    if (!requestedSchoolId) throw new BadRequestException('Informe a escola da solicitacao.')
    this.ensureSchoolExists(data, requestedSchoolId)
    return requestedSchoolId
  }

  private canCreatorMutateMealFoodRequest(status: FoodRequestStatus) {
    return status === 'PENDING_NUTRITIONIST_APPROVAL'
      || status === 'NEEDS_ADJUSTMENT'
      || status === 'REJECTED_BY_NUTRITIONIST'
  }

  private buildMealFoodRequest(
    data: DatabaseShape,
    payload: CreateMealFoodRequestPayload,
    schoolId: string,
    requestedBy: string,
    createdAt: string,
    id: string = this.createId('meal-request'),
  ): MealFoodRequest {
    const itemName = String(payload.itemName ?? '').trim()
    const quantity = Number(payload.quantity)
    const unitPrice = payload.unitPrice === undefined || payload.unitPrice === null || payload.unitPrice === 0 ? null : Number(payload.unitPrice)
    const reason = String(payload.reason ?? '').trim()
    const urgencyLevel = this.normalizeFoodRequestUrgency(payload.urgencyLevel)

    this.ensureSchoolExists(data, schoolId)
    if (!itemName) throw new BadRequestException('Informe o alimento solicitado.')
    if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('Quantidade deve ser maior que zero.')
    if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice <= 0)) throw new BadRequestException('Valor unitario deve ser maior que zero.')
    if (!reason) throw new BadRequestException('Informe o motivo da solicitacao.')

    return {
      id,
      schoolId,
      requestedBy,
      itemName,
      quantity,
      unit: this.normalizeMealUnit(payload.unit),
      unitPrice,
      reason,
      urgencyLevel,
      expirationDate: this.normalizeMealDate(payload.expirationDate),
      observation: payload.observation ? String(payload.observation).trim() : null,
      status: 'PENDING_NUTRITIONIST_APPROVAL',
      reviewedBy: null,
      reviewedAt: null,
      nutritionistObservation: null,
      rejectionReason: null,
      suggestedQuantity: null,
      suggestedUnit: null,
      suggestedUnitPrice: null,
      confirmedBy: null,
      confirmedAt: null,
      supplierName: null,
      purchaseValue: null,
      purchaseDate: null,
      stockItemId: null,
      createdAt,
      updatedAt: createdAt,
    }
  }

  private syncApprovedMealFoodRequestsToStock(data: DatabaseShape, actorId?: string) {
    const approvedRequests = data.mealFoodRequests.filter((request) => (
      request.status === 'APPROVED_BY_NUTRITIONIST' && !request.stockItemId
    ))

    for (const request of approvedRequests) {
      const requestIndex = data.mealFoodRequests.findIndex((item) => item.id === request.id)
      if (requestIndex < 0) continue

      const responsibleId = request.reviewedBy ?? actorId ?? request.requestedBy
      const historyActor = data.users.find((user) => user.id === responsibleId)
        ?? data.users.find((user) => user.id === actorId)
        ?? data.users.find((user) => user.id === request.requestedBy)

      const result = this.addFoodRequestToMealStock(data, request, responsibleId, {}, { createMenu: true, automaticApproval: true })
      data.mealFoodRequests[requestIndex] = result.request

      if (historyActor) {
        this.pushMealRequestHistory(
          data,
          historyActor,
          'ADDED_FOOD_REQUEST_TO_STOCK',
          result.request,
          request,
          result.request,
          `Solicitacao aprovada anteriormente entrou automaticamente no estoque e no cardapio: ${result.food.nome}`,
        )
      }
      this.pushAudit(data, responsibleId, 'Sincronizou solicitacao aprovada com estoque/cardapio', result.food.nome)
    }
  }

  private addFoodRequestToMealStock(
    data: DatabaseShape,
    request: MealFoodRequest,
    actorId: string,
    payload: AddMealFoodRequestToStockPayload = {},
    options: { createMenu?: boolean; automaticApproval?: boolean } = {},
  ) {
    this.createMissingMealManagements(data, this.getCurrentReferenceMonth(), actorId)

    const managementIndex = this.getLatestMealManagementIndexForSchool(data, request.schoolId)
    const management = data.mealManagements[managementIndex]
    const food = this.findOrCreateMealFoodFromRequest(data, management, request)
    const quantity = Number(request.suggestedQuantity && request.suggestedQuantity > 0 ? request.suggestedQuantity : request.quantity)
    const unitPrice = Math.max(0, Number(payload.valorUnitario ?? request.suggestedUnitPrice ?? request.unitPrice ?? 0))
    const valorTotal = Number((quantity * unitPrice).toFixed(2))
    const dataValidade = this.normalizeMealDate(payload.dataValidade ?? request.expirationDate)
    const quantidadeMinima = Math.max(0, Number(payload.quantidadeMinima ?? Math.max(1, Math.round(quantity * 0.2))))
    const fornecedorNome = String(payload.fornecedorNome ?? '').trim()
      || (options.automaticApproval ? 'Aprovacao nutricional automatica' : 'Fornecedor nao informado')
    const saldoAntes = management.orcamentoMensal.valorDisponivel
    const saldoDepois = Number((saldoAntes - valorTotal).toFixed(2))

    if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('Quantidade aprovada deve ser maior que zero.')
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new BadRequestException('Valor unitario deve ser maior ou igual a zero.')
    if (!Number.isFinite(quantidadeMinima) || quantidadeMinima < 0) throw new BadRequestException('Quantidade minima nao pode ser negativa.')
    if (!management.orcamentoMensal.permitirUltrapassarLimite && saldoDepois < 0) {
      throw new BadRequestException('Entrada ultrapassa o limite mensal da merenda.')
    }

    const itemId = this.createId('meal-item')
    const stockStatus = this.resolveMealStockStatus(quantity, quantidadeMinima, dataValidade)
    const now = new Date().toISOString()
    const item = {
      id: itemId,
      alimentoId: food.id,
      nomeAlimento: food.nome,
      categoria: food.categoria,
      quantidade: quantity,
      unidadeMedida: food.unidadeMedida,
      valorUnitario: unitPrice,
      valorTotal,
      dataValidade,
      possuiValidade: Boolean(dataValidade),
      lote: null,
      fornecedor: {
        id: this.createId('supplier'),
        nome: fornecedorNome,
      },
      statusEstoque: stockStatus,
      adicionadoPorId: actorId,
      adicionadoEm: now,
    }

    management.itensMerenda.unshift(item)
    management.estoqueMerenda.unshift({
      id: this.createId('meal-stock'),
      itemMerendaId: itemId,
      alimentoId: food.id,
      nomeAlimento: food.nome,
      quantidadeAtual: quantity,
      quantidadeMinima,
      unidadeMedida: food.unidadeMedida,
      dataValidade,
      status: stockStatus,
    })
    management.movimentacoesOrcamento.unshift({
      id: this.createId('meal-budget-movement'),
      tipo: valorTotal > 0 ? 'COMPRA' : 'AJUSTE',
      itemMerendaId: itemId,
      descricao: `Entrada no estoque: ${food.nome}${payload.observacao ? ` - ${String(payload.observacao).trim()}` : ''}`,
      valor: valorTotal,
      saldoAntes,
      saldoDepois,
      responsavelId: actorId,
      dataMovimentacao: now,
    })

    if (options.createMenu) {
      this.upsertAutomaticMealMenu(management, food, request)
    }

    const updatedRequest: MealFoodRequest = {
      ...request,
      status: 'ADDED_TO_STOCK',
      confirmedBy: actorId,
      confirmedAt: now,
      supplierName: fornecedorNome,
      purchaseValue: valorTotal,
      purchaseDate: this.normalizeMealDate(payload.dataCompra) ?? now.slice(0, 10),
      stockItemId: itemId,
      updatedAt: now,
    }

    const updatedManagement = this.recalculateMealManagement(management)
    data.mealManagements[managementIndex] = updatedManagement

    return {
      request: updatedRequest,
      management: updatedManagement,
      food,
      quantity,
    }
  }

  private upsertAutomaticMealMenu(management: MealManagement, food: MealFood, request: MealFoodRequest) {
    const tipoRefeicao = this.resolveAutomaticMealType(food, request)
    const turno = this.resolveAutomaticMealShift(tipoRefeicao)
    const diaSemana = this.resolveAutomaticMealWeekday(management, tipoRefeicao)
    const dayKey = this.normalizeTextKey(diaSemana)
    const existingMenu = management.cardapios.find((menu) => (
      menu.status !== 'CANCELADO'
      && menu.tipoRefeicao === tipoRefeicao
      && this.normalizeTextKey(menu.diaSemana) === dayKey
    ))

    if (existingMenu) {
      if (!existingMenu.alimentoIds.includes(food.id)) existingMenu.alimentoIds.push(food.id)
      existingMenu.status = 'APROVADO'
      existingMenu.observacao = this.appendAutomaticMenuObservation(existingMenu.observacao, request)
      return
    }

    management.cardapios.push({
      id: this.createId('meal-menu'),
      diaSemana,
      tipoRefeicao,
      turno,
      titulo: `Cardapio automatico: ${food.nome}`,
      alimentoIds: [food.id],
      observacao: `Gerado automaticamente a partir da solicitacao aprovada ${request.id}.`,
      status: 'APROVADO',
    })
  }

  private appendAutomaticMenuObservation(current: string | undefined, request: MealFoodRequest) {
    const addition = `Atualizado automaticamente pela solicitacao aprovada ${request.id}.`
    if (!current) return addition
    if (current.includes(request.id)) return current
    return `${current} ${addition}`
  }

  private resolveAutomaticMealType(food: MealFood, request: MealFoodRequest): MealType {
    const text = this.normalizeTextKey(`${food.nome} ${food.categoria} ${request.reason} ${request.observation ?? ''}`)
    if (/(leite|cafe|iogurte|cereal|aveia|pao|tapioca|biscoito)/.test(text)) return 'CAFE_DA_MANHA'
    if (/(fruta|banana|maca|melao|melancia|laranja|suco|vitamina|lanche|bolo)/.test(text)) return 'LANCHE'
    if (/(jantar|sopa|caldo|canja)/.test(text)) return 'JANTAR'
    return 'ALMOCO'
  }

  private resolveAutomaticMealShift(tipoRefeicao: MealType): MealShift {
    if (tipoRefeicao === 'CAFE_DA_MANHA' || tipoRefeicao === 'LANCHE') return 'MANHA'
    if (tipoRefeicao === 'JANTAR') return 'NOITE'
    return 'INTEGRAL'
  }

  private resolveAutomaticMealWeekday(management: MealManagement, tipoRefeicao: MealType) {
    const weekdays = ['Segunda-feira', 'Terca-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira']
    const weekdayNumberByName = new Map(weekdays.map((day, index) => [day, index + 1]))
    const today = new Date().getDay()
    const startDay = today >= 1 && today <= 5 ? today : 1

    return weekdays
      .map((diaSemana) => {
        const dayKey = this.normalizeTextKey(diaSemana)
        const dayNumber = weekdayNumberByName.get(diaSemana) ?? 1
        const dayMenus = management.cardapios.filter((menu) => menu.status !== 'CANCELADO' && this.normalizeTextKey(menu.diaSemana) === dayKey)
        const sameTypeCount = dayMenus.filter((menu) => menu.tipoRefeicao === tipoRefeicao).length
        return {
          diaSemana,
          menuCount: dayMenus.length,
          sameTypeCount,
          distance: (dayNumber - startDay + 5) % 5,
        }
      })
      .sort((first, second) => first.sameTypeCount - second.sameTypeCount || first.menuCount - second.menuCount || first.distance - second.distance)[0]
      .diaSemana
  }

  private findOrCreateMealFoodFromRequest(data: DatabaseShape, management: MealManagement, request: MealFoodRequest): MealFood {
    const key = this.normalizeMealFoodSearch(request.itemName)
    let food = data.mealFoods.find((item) => this.normalizeMealFoodSearch(item.nome) === key)

    if (!food) {
      const nextFoodId = Math.max(0, ...data.mealFoods.map((item) => item.id)) + 1
      food = this.buildMealFood({
        nome: request.itemName,
        categoria: 'SOLICITADO',
        unidadeMedida: request.suggestedUnit ?? request.unit,
        iconKey: 'utensils',
        ativo: true,
      }, nextFoodId)
      data.mealFoods.push(food)
    }

    if (!management.alimentosCadastrados.some((item) => item.id === food.id)) {
      management.alimentosCadastrados.push(food)
    }

    return food
  }

  private normalizeResponsibleId(data: { users: UserAccount[] }, value: unknown, schoolId: string, fallbackId: string) {
    const id = String(value ?? '').trim()
    if (id) {
      if (!data.users.some((user) => user.id === id)) throw new BadRequestException('Responsavel da merenda informado nao existe.')
      return id
    }

    return data.users.find((user) => user.schoolId === schoolId)?.id ?? fallbackId
  }

  private buildMealFood(payload: CreateMealFoodPayload, id: number): MealFood {
    this.ensureRequired(payload, ['nome', 'categoria', 'unidadeMedida'])

    return {
      id,
      nome: String(payload.nome).trim(),
      categoria: String(payload.categoria).trim().toUpperCase(),
      unidadeMedida: this.normalizeMealUnit(payload.unidadeMedida),
      iconKey: String(payload.iconKey ?? 'utensils').trim() || 'utensils',
      ativo: payload.ativo ?? true,
      criadoEm: new Date().toISOString(),
    }
  }

  private normalizeMealFoodSearch(value: unknown) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
  }

  private getMealFoodSearchScore(food: MealFood, query: string) {
    const name = this.normalizeMealFoodSearch(food.nome)
    const category = this.normalizeMealFoodSearch(food.categoria)
    const words = name.split(' ').filter(Boolean)

    if (name === query) return 0
    if (name.startsWith(query)) return 1
    if (words.some((word) => word.startsWith(query))) return 2
    if (name.includes(query)) return 3
    if (category.includes(query)) return 5

    const distance = Math.min(
      this.levenshteinDistance(name, query),
      ...words.map((word) => this.levenshteinDistance(word, query)),
    )
    const tolerance = Math.max(1, Math.floor(query.length * 0.35))

    return distance <= tolerance ? 10 + distance : Number.POSITIVE_INFINITY
  }

  private levenshteinDistance(left: string, right: string) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
    const current = Array.from({ length: right.length + 1 }, () => 0)

    for (let i = 1; i <= left.length; i += 1) {
      current[0] = i
      for (let j = 1; j <= right.length; j += 1) {
        current[j] = left[i - 1] === right[j - 1]
          ? previous[j - 1]
          : Math.min(previous[j - 1], previous[j], current[j - 1]) + 1
      }
      previous.splice(0, previous.length, ...current)
    }

    return previous[right.length]
  }

  private buildMealMenu(management: MealManagement, payload: UpsertMealMenuPayload, id: string = this.createId('meal-menu')): MealMenu {
    this.ensureRequired(payload, ['diaSemana', 'tipoRefeicao', 'turno', 'titulo'])
    const alimentoIds = Array.from(new Set((payload.alimentoIds ?? []).map((foodId) => Number(foodId))))
    if (!alimentoIds.length) throw new BadRequestException('Informe pelo menos um alimento do cardapio.')

    const invalidFood = alimentoIds.find((foodId) => !Number.isInteger(foodId) || !management.alimentosCadastrados.some((food) => food.id === foodId && food.ativo))
    if (invalidFood !== undefined) throw new BadRequestException('Cardapio contem alimento inexistente ou inativo.')

    return {
      id,
      diaSemana: String(payload.diaSemana).trim(),
      tipoRefeicao: this.normalizeMealType(payload.tipoRefeicao),
      turno: this.normalizeMealShift(payload.turno),
      titulo: String(payload.titulo).trim(),
      alimentoIds,
      observacao: payload.observacao ? String(payload.observacao).trim() : undefined,
      status: this.normalizeMealMenuStatus(payload.status),
    }
  }

  private normalizeReferenceMonth(value: unknown) {
    const month = String(value ?? '').trim()
    if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException('Mes de referencia deve usar AAAA-MM.')
    const parsed = new Date(`${month}-01T00:00:00.000Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 7) !== month) throw new BadRequestException('Mes de referencia invalido.')
    return month
  }

  private normalizeMealUnit(value: unknown): MealUnit {
    const unit = String(value ?? '').trim().toUpperCase()
    if (unit === 'UN') return 'UNIT'
    if (unit === 'KG' || unit === 'G' || unit === 'L' || unit === 'ML' || unit === 'UNIT' || unit === 'BOX' || unit === 'PACKAGE' || unit === 'DOZEN') return unit
    throw new BadRequestException('Unidade de medida da merenda invalida.')
  }

  private normalizeFoodRequestUrgency(value: unknown) {
    const urgency = String(value ?? '').trim().toUpperCase()
    if (urgency === 'LOW' || urgency === 'MEDIUM' || urgency === 'HIGH' || urgency === 'URGENT') return urgency
    throw new BadRequestException('Urgencia da solicitacao invalida.')
  }

  private normalizeMealType(value: unknown): MealType {
    const type = String(value ?? '').trim().toUpperCase()
    if (type === 'CAFE_DA_MANHA' || type === 'LANCHE' || type === 'ALMOCO' || type === 'JANTAR') return type
    throw new BadRequestException('Tipo de refeicao invalido.')
  }

  private normalizeMealShift(value: unknown): MealShift {
    const shift = String(value ?? '').trim().toUpperCase()
    if (shift === 'MANHA' || shift === 'TARDE' || shift === 'NOITE' || shift === 'INTEGRAL') return shift
    throw new BadRequestException('Turno da merenda invalido.')
  }

  private normalizeMealMenuStatus(value: unknown): MealMenuStatus {
    const status = String(value ?? 'APROVADO').trim().toUpperCase()
    if (status === 'RASCUNHO' || status === 'APROVADO' || status === 'CANCELADO') return status
    throw new BadRequestException('Status do cardapio invalido.')
  }

  private normalizeMealDate(value?: string | null) {
    const date = String(value ?? '').trim()
    if (!date) return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Data de validade invalida.')
    const parsed = new Date(`${date}T00:00:00.000Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new BadRequestException('Data de validade invalida.')
    }
    return date
  }

  private async issueAccessToken(user: UserAccount, sessionId: string) {
    const expiresIn = this.accessTokenTtlSeconds
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
    const payload: JwtPayload = { sub: user.id, typ: 'access', sid: sessionId, jti: randomUUID() }
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET')
    if (!secret) throw new Error('JWT_ACCESS_SECRET ausente.')

    return {
      token: await this.jwtService.signAsync(payload, {
        secret,
        expiresIn,
        issuer: this.configService.get<string>('JWT_ISSUER') ?? 'liensina-api',
        audience: this.configService.get<string>('JWT_AUDIENCE') ?? 'liensina-web',
      }),
      expiresIn,
      expiresAt,
    }
  }

  private createRefreshSession(userId: string, context: AuthContext, rotatedFromId?: string) {
    const sessionId = randomUUID()
    const jti = randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + this.refreshTokenTtlDays * 24 * 60 * 60 * 1000)
    const secret = this.configService.get<string>('JWT_REFRESH_SECRET')
    if (!secret) throw new Error('JWT_REFRESH_SECRET ausente.')
    const token = this.jwtService.sign(
      { sub: userId, typ: 'refresh', sid: sessionId, jti } satisfies JwtPayload,
      {
        secret,
        expiresIn: this.refreshTokenTtlDays * 24 * 60 * 60,
        issuer: this.configService.get<string>('JWT_ISSUER') ?? 'liensina-api',
        audience: this.configService.get<string>('JWT_AUDIENCE') ?? 'liensina-web',
      },
    )
    const session: RefreshSession = {
      id: sessionId,
      userId,
      jti,
      tokenHash: this.hashRefreshToken(token),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      rotatedFromId,
      userAgent: context.userAgent?.slice(0, 240),
      ipHash: this.hashContextValue(context.ip),
    }

    return { token, session }
  }

  private removeExpiredRefreshSessions(data: { refreshSessions: RefreshSession[] }) {
    const now = Date.now()
    data.refreshSessions = data.refreshSessions.filter((session) => {
      if (!session.revokedAt) return new Date(session.expiresAt).getTime() > now

      const revokedAt = new Date(session.revokedAt).getTime()
      return Number.isFinite(revokedAt) && now - revokedAt <= this.refreshRevokedRetentionMs
    })
  }

  private hashRefreshToken(token: string) {
    return createHash('sha256').update(token).digest('hex')
  }

  private hashContextValue(value?: string) {
    const normalized = String(value ?? '').trim()
    if (!normalized) return undefined
    return createHash('sha256').update(normalized).digest('hex')
  }

  private async verifyRefreshToken(token: string) {
    try {
      const secret = this.configService.get<string>('JWT_REFRESH_SECRET')
      if (!secret) throw new UnauthorizedException('Configuracao de refresh token ausente.')
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret,
        issuer: this.configService.get<string>('JWT_ISSUER') ?? 'liensina-api',
        audience: this.configService.get<string>('JWT_AUDIENCE') ?? 'liensina-web',
      })
      if (payload.typ !== 'refresh' || !payload.sub || !payload.sid || !payload.jti) {
        throw new UnauthorizedException('Refresh token invalido.')
      }
      return payload
    } catch {
      throw new UnauthorizedException('Refresh token invalido.')
    }
  }

  isSessionActive(userId: string, sessionId: string) {
    const now = Date.now()
    const session = this.readDataForQuery().refreshSessions.find((item) => item.id === sessionId && item.userId === userId)
    return Boolean(session && !session.revokedAt && new Date(session.expiresAt).getTime() > now)
  }

  private isPasswordValid(plainPassword: string, storedPassword: string) {
    const normalized = String(storedPassword ?? '')
    if (this.isPasswordHash(normalized)) return bcrypt.compareSync(plainPassword, normalized)
    return normalized === plainPassword
  }

  private isPasswordHash(value: string) {
    return passwordHashPattern.test(value)
  }

  private hashPassword(password: string) {
    return bcrypt.hashSync(password, passwordSaltRounds)
  }

  private normalizeInitialPassword(value?: string) {
    const password = String(value ?? '').trim()
    if (password.length < 8) throw new BadRequestException('Senha inicial deve conter pelo menos 8 caracteres.')
    if (password.length > 120) throw new BadRequestException('Senha inicial deve conter no maximo 120 caracteres.')
    return password
  }

  private get accessTokenTtlSeconds() {
    return parseDurationSeconds(this.configService.get<string>('JWT_ACCESS_EXPIRES_IN'), 15 * 60)
  }

  private get refreshTokenTtlDays() {
    const days = Number(this.configService.get<string>('REFRESH_TOKEN_DAYS') ?? 7)
    return Number.isFinite(days) && days > 0 ? days : 7
  }

  private get refreshRevokedRetentionMs() {
    const seconds = Number(this.configService.get<string>('REFRESH_TOKEN_REVOKED_RETENTION_SECONDS') ?? 24 * 60 * 60)
    return Math.max(60, Number.isFinite(seconds) ? seconds : 24 * 60 * 60) * 1000
  }

  private paginate<T>(items: T[], rawPage: string | number = 1, rawLimit: string | number = 10, defaultLimit = 10) {
    const page = Math.max(1, Number(rawPage) || 1)
    const limit = Math.min(100, Math.max(1, Number(rawLimit) || defaultLimit))
    const total = items.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * limit

    return {
      items: items.slice(start, start + limit),
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages,
      },
    }
  }

  private getScopedSchoolsData(data: DatabaseShape, currentUser: UserAccount) {
    const userVisualIndex = this.buildUserVisualIndex(data.users)
    const studentsWithVisuals = data.students.map((student) => this.withLinkedUserVisualsFromIndex(student, userVisualIndex))
    const teachersWithVisuals = data.teachers.map((teacher) => this.withLinkedUserVisualsFromIndex(teacher, userVisualIndex))
    const guardiansWithVisuals = data.guardians.map((guardian) => this.withLinkedUserVisualsFromIndex(guardian, userVisualIndex))
    const role = data.roles.find((item) => item.id === currentUser.roleId)
    const roleCode = role?.code ?? role?.name

    if (roleCode === 'SUPERADMIN' || roleCode === 'ADMIN') {
      return {
        schools: data.schools,
        classes: data.classes,
        teachers: teachersWithVisuals,
        students: studentsWithVisuals,
        guardians: guardiansWithVisuals,
      }
    }

    const linkedTeachers = teachersWithVisuals.filter((teacher) => teacher.id === currentUser.linkedTeacherId || teacher.userId === currentUser.id)
    const teacherIds = new Set(linkedTeachers.map((teacher) => teacher.id))
    const studentIds = new Set(studentsWithVisuals
      .filter((student) => student.id === currentUser.linkedStudentId || student.userId === currentUser.id)
      .map((student) => student.id))
    const guardianIds = new Set(guardiansWithVisuals
      .filter((guardian) => guardian.id === currentUser.linkedGuardianId || guardian.userId === currentUser.id)
      .map((guardian) => guardian.id))

    if (roleCode === 'ADMIN_ESCOLA' || roleCode === 'DIRETOR' || roleCode === 'COORDENADOR') {
      const schoolIds = new Set(data.schools.filter((school) => currentUser.schoolId === school.id).map((school) => school.id))
      const classes = data.classes.filter((classRoom) => schoolIds.has(classRoom.schoolId))
      const classIds = new Set(classes.map((classRoom) => classRoom.id))

      return {
        schools: data.schools.filter((school) => schoolIds.has(school.id)),
        classes,
        teachers: teachersWithVisuals.filter((teacher) => schoolIds.has(teacher.schoolId)),
        students: studentsWithVisuals.filter((student) => schoolIds.has(student.schoolId) || classIds.has(student.classId)),
        guardians: guardiansWithVisuals.filter((guardian) => schoolIds.has(guardian.schoolId)),
      }
    }

    if (roleCode === 'PROFESSOR') {
      const classes = data.classes.filter((classRoom) => (
        teacherIds.has(classRoom.teacherId)
        || (classRoom.teacherIds ?? []).some((teacherId) => teacherIds.has(teacherId))
        || linkedTeachers.some((teacher) => this.teacherMatchesClassByDiscipline(teacher, classRoom))
      ))
      const classIds = new Set(classes.map((classRoom) => classRoom.id))
      const schoolIds = new Set([
        ...linkedTeachers.map((teacher) => teacher.schoolId),
        ...classes.map((classRoom) => classRoom.schoolId),
      ].filter(Boolean))
      const students = studentsWithVisuals.filter((student) => classIds.has(student.classId))
      const guardianIdsFromStudents = new Set(students.flatMap((student) => student.guardianIds ?? []))

      return {
        schools: data.schools.filter((school) => schoolIds.has(school.id)),
        classes,
        teachers: teachersWithVisuals.filter((teacher) => teacherIds.has(teacher.id)),
        students,
        guardians: guardiansWithVisuals.filter((guardian) => guardianIdsFromStudents.has(guardian.id)),
      }
    }

    if (roleCode === 'ALUNO') {
      const students = studentsWithVisuals.filter((student) => studentIds.has(student.id))
      const classIds = new Set(students.map((student) => student.classId))
      const schoolIds = new Set(students.map((student) => student.schoolId))
      const classes = data.classes.filter((classRoom) => classIds.has(classRoom.id))
      const teacherIdsFromClasses = new Set(classes.flatMap((classRoom) => [classRoom.teacherId, ...(classRoom.teacherIds ?? [])].filter(Boolean)))

      return {
        schools: data.schools.filter((school) => schoolIds.has(school.id)),
        classes,
        teachers: teachersWithVisuals.filter((teacher) => teacherIdsFromClasses.has(teacher.id)),
        students,
        guardians: [],
      }
    }

    if (roleCode === 'RESPONSAVEL') {
      const guardians = guardiansWithVisuals.filter((guardian) => guardianIds.has(guardian.id))
      const linkedStudentIds = new Set(guardians.flatMap((guardian) => guardian.studentIds ?? []))
      const students = studentsWithVisuals.filter((student) => linkedStudentIds.has(student.id) || (student.guardianIds ?? []).some((guardianId) => guardianIds.has(guardianId)))
      const classIds = new Set(students.map((student) => student.classId))
      const schoolIds = new Set(students.map((student) => student.schoolId))
      const classes = data.classes.filter((classRoom) => classIds.has(classRoom.id))
      const teacherIdsFromClasses = new Set(classes.flatMap((classRoom) => [classRoom.teacherId, ...(classRoom.teacherIds ?? [])].filter(Boolean)))

      return {
        schools: data.schools.filter((school) => schoolIds.has(school.id)),
        classes,
        teachers: teachersWithVisuals.filter((teacher) => teacherIdsFromClasses.has(teacher.id)),
        students,
        guardians,
      }
    }

    return {
      schools: [],
      classes: [],
      teachers: [],
      students: [],
      guardians: [],
    }
  }

  private getScopedDatabaseView(data: DatabaseShape, currentUser: UserAccount): DatabaseShape {
    const scoped = this.getScopedSchoolsData(data, currentUser)
    const roleCode = this.getCurrentRoleCode(data, currentUser)
    const schoolIds = new Set(scoped.schools.map((school) => school.id))
    const classIds = new Set(scoped.classes.map((classRoom) => classRoom.id))
    const studentIds = new Set(scoped.students.map((student) => student.id))
    const evaluationIds = new Set(data.evaluations
      .filter((evaluation) => classIds.has(evaluation.classId) || this.canAccessEvaluation(data, currentUser, evaluation))
      .map((evaluation) => evaluation.id))
    const canViewAllMeals = this.isSuperAdminRole(roleCode) || roleCode === 'NUTRITIONIST'

    return {
      ...data,
      users: this.getScopedUsers(data, currentUser),
      schools: scoped.schools,
      classes: scoped.classes,
      teachers: scoped.teachers,
      students: scoped.students,
      guardians: scoped.guardians,
      evaluations: data.evaluations.filter((evaluation) => evaluationIds.has(evaluation.id)),
      answerCards: data.answerCards.filter((card) => evaluationIds.has(card.evaluationId) || studentIds.has(card.studentId) || classIds.has(card.classId)),
      evaluationCorrections: data.evaluationCorrections.filter((correction) => evaluationIds.has(correction.evaluationId) || studentIds.has(correction.studentId) || classIds.has(correction.classId)),
      lessonRecords: data.lessonRecords.filter((record) => classIds.has(record.classId)),
      roomReservations: data.roomReservations.filter((reservation) => classIds.has(reservation.classId)),
      calendarEvents: data.calendarEvents.filter((event) => (
        schoolIds.has(event.schoolId)
        || (event.classId ? classIds.has(event.classId) : false)
        || event.createdById === currentUser.id
      )),
      mealManagements: canViewAllMeals
        ? data.mealManagements
        : data.mealManagements.filter((management) => schoolIds.has(management.escolaId)),
      mealFoodRequests: canViewAllMeals
        ? data.mealFoodRequests
        : data.mealFoodRequests.filter((request) => schoolIds.has(request.schoolId)),
      mealRequestHistory: canViewAllMeals
        ? data.mealRequestHistory
        : data.mealRequestHistory.filter((history) => schoolIds.has(history.schoolId)),
      auditEvents: this.getScopedAuditEvents(data, currentUser),
    }
  }

  private getScopedUsers(data: DatabaseShape, currentUser: UserAccount) {
    const roleCode = this.getCurrentRoleCode(data, currentUser)
    if (this.isSuperAdminRole(roleCode)) return data.users

    const scoped = this.getScopedSchoolsData(data, currentUser)
    const schoolIds = new Set(scoped.schools.map((school) => school.id))
    const teacherIds = new Set(scoped.teachers.map((teacher) => teacher.id))
    const studentIds = new Set(scoped.students.map((student) => student.id))
    const guardianIds = new Set(scoped.guardians.map((guardian) => guardian.id))

    return data.users.filter((user) => (
      user.id === currentUser.id
      || (user.schoolId ? schoolIds.has(user.schoolId) : false)
      || (user.linkedTeacherId ? teacherIds.has(user.linkedTeacherId) : false)
      || (user.linkedStudentId ? studentIds.has(user.linkedStudentId) : false)
      || (user.linkedGuardianId ? guardianIds.has(user.linkedGuardianId) : false)
    ))
  }

  private getVisibleRoles(data: DatabaseShape, currentUser: UserAccount) {
    const roleCode = this.getCurrentRoleCode(data, currentUser)
    if (this.isSuperAdminRole(roleCode)) return data.roles
    return data.roles.filter((role) => role.id === currentUser.roleId)
  }

  private getScopedAuditEvents(data: DatabaseShape, currentUser: UserAccount) {
    const roleCode = this.getCurrentRoleCode(data, currentUser)
    if (this.isSuperAdminRole(roleCode)) return data.auditEvents
    return []
  }

  private buildUserVisualIndex(users: UserAccount[]) {
    const byId = new Map(users.map((user) => [user.id, user]))
    const byLinkedEntityId = new Map<string, UserAccount[]>()
    const addLinkedUser = (entityId: string | undefined, user: UserAccount) => {
      if (!entityId) return
      const current = byLinkedEntityId.get(entityId) ?? []
      current.push(user)
      byLinkedEntityId.set(entityId, current)
    }

    for (const user of users) {
      addLinkedUser(user.linkedStudentId, user)
      addLinkedUser(user.linkedTeacherId, user)
      addLinkedUser(user.linkedGuardianId, user)
    }

    return { byId, byLinkedEntityId }
  }

  private withLinkedUserVisualsFromIndex<T extends { id: string; userId: string; avatarUrl?: string; bannerUrl?: string; avatarObject?: StoredImageObject | null; bannerObject?: StoredImageObject | null }>(
    entity: T,
    index: { byId: Map<string, UserAccount>; byLinkedEntityId: Map<string, UserAccount[]> },
  ): T {
    const linkedUsers = [
      index.byId.get(entity.userId),
      ...(index.byLinkedEntityId.get(entity.id) ?? []),
    ].filter((user, position, users): user is UserAccount => Boolean(user) && users.findIndex((item) => item?.id === user?.id) === position)
    const primaryUser = index.byId.get(entity.userId)
    const userWithAvatar = linkedUsers.find((user) => user.avatarUrl || user.avatarObject)
    const userWithBanner = linkedUsers.find((user) => user.bannerUrl || user.bannerObject)
    const avatarSource = primaryUser?.avatarUrl || primaryUser?.avatarObject ? primaryUser : userWithAvatar
    const bannerSource = primaryUser?.bannerUrl || primaryUser?.bannerObject ? primaryUser : userWithBanner

    return {
      ...entity,
      avatarUrl: entity.avatarUrl || avatarSource?.avatarUrl || avatarSource?.avatarObject?.publicUrl,
      bannerUrl: entity.bannerUrl || bannerSource?.bannerUrl || bannerSource?.bannerObject?.publicUrl,
      avatarObject: entity.avatarObject ?? avatarSource?.avatarObject,
      bannerObject: entity.bannerObject ?? bannerSource?.bannerObject,
    }
  }

  private withLinkedUserVisuals<T extends { id: string; userId: string; avatarUrl?: string; bannerUrl?: string; avatarObject?: unknown; bannerObject?: unknown }>(
    entity: T,
    users: UserAccount[],
  ): T {
    const linkedUsers = users.filter((user) =>
      user.id === entity.userId ||
      user.linkedStudentId === entity.id ||
      user.linkedTeacherId === entity.id ||
      user.linkedGuardianId === entity.id,
    )
    const primaryUser = linkedUsers.find((user) => user.id === entity.userId)
    const userWithAvatar = linkedUsers.find((user) => user.avatarUrl || user.avatarObject)
    const userWithBanner = linkedUsers.find((user) => user.bannerUrl || user.bannerObject)
    const avatarSource = primaryUser?.avatarUrl || primaryUser?.avatarObject ? primaryUser : userWithAvatar
    const bannerSource = primaryUser?.bannerUrl || primaryUser?.bannerObject ? primaryUser : userWithBanner

    return {
      ...entity,
      avatarUrl: entity.avatarUrl || avatarSource?.avatarUrl || avatarSource?.avatarObject?.publicUrl,
      bannerUrl: entity.bannerUrl || bannerSource?.bannerUrl || bannerSource?.bannerObject?.publicUrl,
      avatarObject: entity.avatarObject ?? avatarSource?.avatarObject,
      bannerObject: entity.bannerObject ?? bannerSource?.bannerObject,
    }
  }

  private splitAcademicTokens(value?: string | null) {
    return String(value ?? '')
      .split(/[,;|/]+|\s+-\s+/)
      .map((item) => this.normalizeTextKey(item))
      .filter(Boolean)
  }

  private teacherMatchesClassByDiscipline(teacher: Teacher, classRoom: ClassRoom) {
    const teacherTokens = this.splitAcademicTokens(teacher.specialty)
    const classTokens = (classRoom.bnccFocus ?? []).flatMap((focus) => this.splitAcademicTokens(focus))
    if (!teacherTokens.length || !classTokens.length) return false

    return teacherTokens.some((teacherToken) => classTokens.some((classToken) => (
      teacherToken === classToken
      || teacherToken.includes(classToken)
      || classToken.includes(teacherToken)
    )))
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

  private ensureCurrentUser(data: { users: UserAccount[] }, userId: string) {
    const currentUser = data.users.find((user) => user.id === userId)
    if (!currentUser) throw new UnauthorizedException('Usuario nao encontrado.')
    return currentUser
  }

  private ensureRole(data: { users: UserAccount[]; roles: Role[] }, userId: string, code: RoleCode) {
    const currentUser = this.ensureCurrentUser(data, userId)
    const role = data.roles.find((item) => item.id === currentUser.roleId)
    const roleCode = role?.code ?? role?.name
    if (code === 'ADMIN' && roleCode && this.isSuperAdminRole(roleCode)) return currentUser
    if (roleCode !== code) {
      throw new ForbiddenException('Apenas administradores podem registrar compras da merenda.')
    }
    return currentUser
  }

  private getCurrentRoleCode(data: { roles: Role[] }, currentUser: UserAccount): RoleCode {
    const role = data.roles.find((item) => item.id === currentUser.roleId)
    const roleCode = role?.code ?? role?.name
    if (!roleCode || !validRoleCodes.has(roleCode)) {
      throw new ForbiddenException('Cargo do usuario invalido ou nao configurado.')
    }
    return roleCode
  }

  private isSuperAdminRole(roleCode: RoleCode) {
    return roleCode === 'SUPERADMIN'
  }

  private isSchoolAdminRole(roleCode: RoleCode) {
    return roleCode === 'ADMIN_ESCOLA' || roleCode === 'ADMIN'
  }

  private isSchoolManagementRole(roleCode: RoleCode) {
    return this.isSchoolAdminRole(roleCode) || roleCode === 'DIRETOR' || roleCode === 'COORDENADOR'
  }

  private ensureGlobalAdmin(data: { users: UserAccount[]; roles: Role[] }, actorId: string) {
    const actor = this.ensureCurrentUser(data, actorId)
    if (!this.isSuperAdminRole(this.getCurrentRoleCode(data, actor))) {
      throw new ForbiddenException('Sem permissao: apenas SUPERADMIN pode executar esta operacao global.')
    }
    return actor
  }

  private resolveRole(data: { roles: Role[] }, roleIdOrCode: string) {
    const normalized = String(roleIdOrCode ?? '').trim()
    const upper = normalized.toUpperCase()
    return data.roles.find((role) => role.id === normalized || role.code === upper || role.name === upper) ?? null
  }

  private revokeRefreshSessionsForUser(data: { refreshSessions: RefreshSession[] }, userId: string) {
    const now = new Date().toISOString()
    for (const session of data.refreshSessions) {
      if (session.userId === userId && !session.revokedAt) session.revokedAt = now
    }
  }

  private revokeRefreshSessionsForRole(data: { users: UserAccount[]; refreshSessions: RefreshSession[] }, roleId: string) {
    const userIds = new Set(data.users.filter((user) => user.roleId === roleId).map((user) => user.id))
    const now = new Date().toISOString()
    for (const session of data.refreshSessions) {
      if (userIds.has(session.userId) && !session.revokedAt) session.revokedAt = now
    }
  }

  private rejectControlledFields(payload: Record<string, unknown>, fields: string[]) {
    const present = fields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== undefined)
    if (present.length) throw new BadRequestException(`Campos nao permitidos: ${present.join(', ')}`)
  }

  private canCreateEvaluationRole(roleCode: RoleCode) {
    return this.isSuperAdminRole(roleCode) || this.isSchoolAdminRole(roleCode) || roleCode === 'PROFESSOR'
  }

  private canRunOmrRole(roleCode: RoleCode) {
    return this.isSuperAdminRole(roleCode) || this.isSchoolAdminRole(roleCode) || roleCode === 'PROFESSOR'
  }

  private canReadCorrectionCardFileRole(roleCode: RoleCode) {
    return this.isSuperAdminRole(roleCode) || this.isSchoolManagementRole(roleCode) || roleCode === 'PROFESSOR'
  }

  private canAccessClassForMutation(data: DatabaseShape, actor: UserAccount, classRoom: ClassRoom) {
    const roleCode = this.getCurrentRoleCode(data, actor)
    if (this.isSuperAdminRole(roleCode)) return true
    if (this.isSchoolAdminRole(roleCode)) return Boolean(actor.schoolId) && actor.schoolId === classRoom.schoolId
    if (roleCode !== 'PROFESSOR') return false
    const scoped = this.getScopedSchoolsData(data, actor)
    return scoped.classes.some((item) => item.id === classRoom.id)
  }

  private ensureStudentMutationAllowed(data: DatabaseShape, actorId: string, schoolId: string) {
    const actor = this.ensureCurrentUser(data, actorId)
    const roleCode = this.getCurrentRoleCode(data, actor)
    if (this.isSuperAdminRole(roleCode)) return
    if (this.isSchoolAdminRole(roleCode) && actor.schoolId === schoolId) return
    throw new ForbiddenException('Sem permissao para alterar dados academicos de alunos.')
  }

  private ensureCalendarEventScopeAllowed(data: DatabaseShape, actor: UserAccount, payload: Partial<SchoolCalendarEvent>) {
    const roleCode = this.getCurrentRoleCode(data, actor)
    if (this.isSuperAdminRole(roleCode)) return
    const scoped = this.getScopedSchoolsData(data, actor)
    const schoolId = String(payload.schoolId ?? '').trim()
    const classId = payload.classId ? String(payload.classId).trim() : null
    if (!scoped.schools.some((school) => school.id === schoolId)) {
      throw new ForbiddenException('Sem permissao para criar evento nesta escola.')
    }
    if (classId && !scoped.classes.some((classRoom) => classRoom.id === classId && classRoom.schoolId === schoolId)) {
      throw new ForbiddenException('Sem permissao para criar evento nesta turma.')
    }
  }

  private classSubjectMatchesTeacher(data: DatabaseShape, actor: UserAccount, classRoom: ClassRoom, subject: unknown) {
    const subjectKey = this.normalizeTextKey(subject)
    const teacherIds = new Set([actor.linkedTeacherId, ...data.teachers.filter((teacher) => teacher.userId === actor.id).map((teacher) => teacher.id)].filter(Boolean) as string[])
    if (!teacherIds.size) return false
    const classHasTeacher = teacherIds.has(classRoom.teacherId) || (classRoom.teacherIds ?? []).some((teacherId) => teacherIds.has(teacherId))
    const classSubjects = (classRoom.bnccFocus ?? []).map((focus) => this.normalizeTextKey(focus))
    const subjectMatchesClass = !subjectKey || !classSubjects.length || classSubjects.some((focus) => focus.includes(subjectKey) || subjectKey.includes(focus))
    if (classHasTeacher && subjectMatchesClass) return true

    const teachers = data.teachers.filter((teacher) => teacherIds.has(teacher.id))
    return teachers.some((teacher) => {
      const specialty = this.normalizeTextKey(teacher.specialty)
      return specialty && (specialty.includes(subjectKey) || subjectKey.includes(specialty))
    })
  }

  private createStableSubjectId(subject: unknown) {
    const normalized = this.normalizeTextKey(subject).replace(/\s+/g, '-')
    return `subject-${normalized || 'geral'}`
  }

  private async runIdempotentOperation<T>(
    actorId: string,
    schoolId: string | null | undefined,
    operation: string,
    resourceId: string | null | undefined,
    payload: unknown,
    idempotencyKey: string | undefined,
    handler: () => Promise<T>,
  ): Promise<T> {
    const payloadHash = this.hashStablePayload(payload)
    const providedKey = String(idempotencyKey ?? '').trim()
    const key = providedKey || `auto:${this.hashStablePayload({
      actorId,
      schoolId: schoolId ?? null,
      operation,
      resourceId: resourceId ?? null,
      payloadHash,
    })}`
    const scopeKey = this.hashStablePayload({
      actorId,
      schoolId: schoolId ?? null,
      operation,
      resourceId: resourceId ?? null,
      key,
    })
    const reservation = await this.database.reserveIdempotencyRecord({
      scopeKey,
      key,
      actorId,
      schoolId: schoolId ?? null,
      operation,
      resourceId: resourceId ?? null,
      payloadHash,
    })

    if (reservation.state === 'conflict') throw new ConflictException('Idempotency-Key reutilizada com payload diferente.')
    if (reservation.state === 'processing') throw new ConflictException('Operacao equivalente ja esta em processamento.')
    if (reservation.state === 'completed') return reservation.response as T

    try {
      const response = await handler()
      await this.database.completeIdempotencyRecord(scopeKey, response)
      return response
    } catch (error) {
      await this.database.failIdempotencyRecord(scopeKey, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private hashStablePayload(value: unknown) {
    return createHash('sha256').update(this.stableJson(value)).digest('hex')
  }

  private stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map((item) => this.stableJson(item)).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${this.stableJson(record[key])}`).join(',')}}`
  }

  private ensureCalendarEventMutationAllowed(data: { users: UserAccount[]; roles: Role[] }, actorId: string, event: SchoolCalendarEvent) {
    const currentUser = this.ensureCurrentUser(data, actorId)
    const role = data.roles.find((item) => item.id === currentUser.roleId)
    const roleCode = role?.code ?? role?.name
    if (roleCode && this.isSuperAdminRole(roleCode)) return
    if (event.createdById && event.createdById === currentUser.id) return
    throw new ForbiddenException('Apenas o criador do evento ou um Admin pode alterar este evento.')
  }

  private buildCalendarEvent(data: { schools: School[]; classes: ClassRoom[] }, payload: Partial<SchoolCalendarEvent>, id: string = this.createId('cal')): SchoolCalendarEvent {
    const allDay = payload.allDay ?? false
    const type = this.normalizeCalendarType(payload.type)
    const schoolId = String(payload.schoolId ?? '').trim()
    const classId = payload.classId ? String(payload.classId).trim() : null
    const createdById = String(payload.createdById ?? '').trim()
    const startsAt = this.normalizeCalendarDateValue(payload.startsAt, allDay)
    const endsAt = this.normalizeCalendarDateValue(payload.endsAt, allDay)

    if (!createdById) throw new BadRequestException('Autor do evento nao informado.')
    if (!data.schools.some((school) => school.id === schoolId)) throw new BadRequestException('Escola informada nao existe.')
    if (classId && !data.classes.some((classRoom) => classRoom.id === classId && classRoom.schoolId === schoolId)) {
      throw new BadRequestException('Turma informada nao pertence a escola selecionada.')
    }
    if (allDay ? endsAt < startsAt : endsAt <= startsAt) throw new BadRequestException('Data final precisa ser posterior ao inicio do evento.')

    return {
      id,
      title: String(payload.title ?? '').trim(),
      type,
      schoolId,
      classId,
      createdById,
      startsAt,
      endsAt,
      allDay,
      location: String(payload.location ?? '').trim(),
      description: String(payload.description ?? '').trim(),
    }
  }

  private normalizeCalendarType(type: unknown): CalendarEventType {
    const normalized = String(type ?? '').trim() as CalendarEventType
    if (!this.calendarEventTypes.has(normalized)) throw new BadRequestException('Tipo de evento de calendario invalido.')
    return normalized
  }

  private normalizeCalendarDateValue(value: unknown, allDay: boolean) {
    const normalized = String(value ?? '').trim()
    const pattern = allDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
    if (!pattern.test(normalized)) {
      throw new BadRequestException(allDay ? 'Datas de eventos de dia inteiro devem usar AAAA-MM-DD.' : 'Datas de eventos com horario devem usar AAAA-MM-DDTHH:mm.')
    }
    return normalized
  }

  private buildRoomReservation(data: { classes: ClassRoom[]; roomReservations: RoomReservation[] }, payload: Partial<RoomReservation>, id: string = this.createId('room-reservation')): RoomReservation {
    const room = String(payload.room ?? '').trim()
    const classId = String(payload.classId ?? '').trim()
    const date = this.normalizeReservationDate(payload.date)
    const startTime = this.normalizeReservationTime(payload.startTime)
    const endTime = this.normalizeReservationTime(payload.endTime)
    const purpose = String(payload.purpose ?? '').trim()

    if (room.length < 2) throw new BadRequestException('Informe o ambiente da reserva.')
    if (room.length > 120) throw new BadRequestException('Ambiente deve conter no maximo 120 caracteres.')
    if (purpose.length < 3) throw new BadRequestException('Informe a finalidade da reserva.')
    if (purpose.length > 500) throw new BadRequestException('Finalidade deve conter no maximo 500 caracteres.')
    if (!data.classes.some((classRoom) => classRoom.id === classId)) throw new BadRequestException('Turma informada nao existe.')
    if (this.parseReservationTime(endTime) <= this.parseReservationTime(startTime)) {
      throw new BadRequestException('Horario final precisa ser posterior ao inicio da reserva.')
    }

    const reservation = { id, room, date, startTime, endTime, classId, purpose }
    if (this.hasRoomReservationConflict(data.classes, data.roomReservations, reservation)) {
      throw new BadRequestException('Ja existe uma reserva para esta sala neste horario.')
    }

    return reservation
  }

  private buildLessonRecord(data: { classes: ClassRoom[] }, payload: Partial<LessonRecord>, id: string = this.createId('lesson')): LessonRecord {
    const classId = String(payload.classId ?? '').trim()
    const subject = this.normalizeBoundedText(payload.subject, 'Materia', 2, 120)
    const date = this.normalizeLessonDate(payload.date)
    const time = this.normalizeLessonTime(payload.time)
    const content = this.normalizeBoundedText(payload.content, 'Conteudo ministrado', 3, 2000)
    const plan = this.normalizeBoundedText(payload.plan, 'Plano de aula', 3, 2000)
    const resources = this.normalizeBoundedText(payload.resources, 'Recursos utilizados', 2, 1000)
    const activity = this.normalizeBoundedText(payload.activity, 'Atividade realizada', 3, 2000)
    const notes = this.normalizeOptionalBoundedText(payload.notes, 'Observacoes', 1000)
    const attendance = payload.attendance && typeof payload.attendance === 'object'
      ? Object.fromEntries(Object.entries(payload.attendance).map(([studentId, present]) => [String(studentId), Boolean(present)]))
      : undefined

    if (!data.classes.some((classRoom) => classRoom.id === classId)) throw new BadRequestException('Turma informada nao existe.')

    return { id, classId, subject, date, time, content, plan, resources, activity, notes, attendance }
  }

  private hasRoomReservationConflict(classes: ClassRoom[], reservations: RoomReservation[], reservation: RoomReservation) {
    const roomKey = this.normalizeTextKey(reservation.room)
    const start = this.parseReservationTime(reservation.startTime)
    const end = this.parseReservationTime(reservation.endTime)
    const schoolByClassId = new Map(classes.map((classRoom) => [classRoom.id, classRoom.schoolId]))
    const reservationSchoolId = schoolByClassId.get(reservation.classId)

    return reservations.some((current) => (
      current.id !== reservation.id &&
      schoolByClassId.get(current.classId) === reservationSchoolId &&
      current.date === reservation.date &&
      this.normalizeTextKey(current.room) === roomKey &&
      this.parseReservationTime(current.startTime) < end &&
      start < this.parseReservationTime(current.endTime)
    ))
  }

  private normalizeReservationDate(value: unknown) {
    const date = String(value ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Data da reserva deve usar AAAA-MM-DD.')

    const parsed = new Date(`${date}T00:00:00.000Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new BadRequestException('Data da reserva invalida.')
    }

    return date
  }

  private normalizeLessonDate(value: unknown) {
    const date = String(value ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Data da aula deve usar AAAA-MM-DD.')

    const parsed = new Date(`${date}T00:00:00.000Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new BadRequestException('Data da aula invalida.')
    }

    return date
  }

  private normalizeReservationTime(value: unknown) {
    const time = String(value ?? '').trim()
    if (!/^\d{2}:\d{2}$/.test(time)) throw new BadRequestException('Horario da reserva deve usar HH:mm.')

    const [hour, minute] = time.split(':').map(Number)
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new BadRequestException('Horario da reserva invalido.')
    }

    return time
  }

  private normalizeLessonTime(value: unknown) {
    const time = String(value ?? '').trim()
    if (!/^\d{2}:\d{2}$/.test(time)) throw new BadRequestException('Horario da aula deve usar HH:mm.')

    const [hour, minute] = time.split(':').map(Number)
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new BadRequestException('Horario da aula invalido.')
    }

    return time
  }

  private normalizeBoundedText(value: unknown, label: string, minLength: number, maxLength: number) {
    const text = String(value ?? '').trim()
    if (text.length < minLength) throw new BadRequestException(`${label} deve ter pelo menos ${minLength} caracteres.`)
    if (text.length > maxLength) throw new BadRequestException(`${label} deve conter no maximo ${maxLength} caracteres.`)
    return text
  }

  private normalizeOptionalBoundedText(value: unknown, label: string, maxLength: number) {
    const text = String(value ?? '').trim()
    if (text.length > maxLength) throw new BadRequestException(`${label} deve conter no maximo ${maxLength} caracteres.`)
    return text
  }

  private parseReservationTime(value: string) {
    const [hour, minute] = value.split(':').map(Number)
    return hour * 60 + minute
  }

  private normalizeSelectionFilter(value: unknown) {
    const normalized = this.normalizeTextKey(value)
    return !normalized || normalized === 'all' ? null : normalized
  }

  private canAccessEvaluation(data: DatabaseShape, actor: UserAccount, evaluation: Evaluation) {
    const roleCode = this.getCurrentRoleCode(data, actor)
    if (this.isSuperAdminRole(roleCode)) return true
    if (!['ADMIN_ESCOLA', 'DIRETOR', 'COORDENADOR', 'PROFESSOR'].includes(roleCode)) return false

    const scoped = this.getScopedSchoolsData(data, actor)
    return scoped.classes.some((classRoom) => classRoom.id === evaluation.classId)
  }

  private ensureEvaluationMutationAllowed(data: DatabaseShape, actor: UserAccount, evaluation: Evaluation) {
    const roleCode = this.getCurrentRoleCode(data, actor)
    if (!this.canAccessEvaluation(data, actor, evaluation)) {
      throw new ForbiddenException('Sem acesso a esta prova.')
    }
    if (this.isSuperAdminRole(roleCode) || this.isSchoolAdminRole(roleCode)) return
    if (roleCode === 'PROFESSOR' && evaluation.createdById === actor.id) return
    throw new ForbiddenException('Seu perfil nao pode alterar esta prova.')
  }

  private resolveEvaluationQuestions(data: DatabaseShape, evaluation: Evaluation) {
    const snapshots = evaluation.questionSnapshots ?? []
    const snapshotById = new Map(snapshots.map((question) => [question.id, question]))
    const questions = (evaluation.questionIds ?? [])
      .map((questionId) => data.questions.find((question) => question.id === questionId) ?? snapshotById.get(questionId))
      .filter((question): question is Question => Boolean(question))

    return questions.length ? questions : snapshots
  }

  private buildEvaluationAnswerKey(questions: Question[]): EvaluationAnswerKeyItem[] {
    return questions.map((question, index) => {
      const correctOption = [...(question.options ?? [])]
        .sort((first, second) => first.order - second.order)
        .find((option) => option.isCorrect)

      if (!correctOption) {
        throw new BadRequestException(`Questao ${index + 1} nao possui gabarito cadastrado.`)
      }

      return {
        questionNumber: index + 1,
        questionId: question.id,
        correctOption: String(correctOption.label ?? '').trim().toUpperCase(),
      }
    })
  }

  private getEvaluationVersionId(evaluation: Evaluation) {
    const questionSignature = (evaluation.questionIds ?? []).join(',')
    const hash = createHash('sha1').update(`${evaluation.id}:${questionSignature}:${evaluation.questions}`).digest('hex').slice(0, 12)
    return `${evaluation.id}:v-${hash}`
  }

  private getEvaluationAnswerCardsInPrintOrder(data: DatabaseShape, evaluationId: string) {
    return data.answerCards
      .filter((card) => card.evaluationId === evaluationId && card.status !== 'CANCELLED')
      .sort((first, second) => first.cardId.localeCompare(second.cardId, 'pt-BR') || first.studentName.localeCompare(second.studentName, 'pt-BR'))
  }

  private getOmrSourcePage(response: OmrServiceResponse) {
    const metadata = response.metadata && typeof response.metadata === 'object'
      ? response.metadata as Record<string, unknown>
      : {}
    const page = Number(metadata.sourcePage)
    return Number.isFinite(page) && page > 0 ? page : null
  }

  private readQrPayloadValue(payload: Record<string, unknown> | null, keys: string[]) {
    return this.qrCodeService.readPayloadString(payload, keys)
  }

  private normalizeOmrResponseId(value: unknown) {
    const normalized = String(value ?? '').trim()
    return normalized && normalized !== 'null' && normalized !== 'undefined' ? normalized : ''
  }

  private resolveOmrTargetFromResponse(
    data: DatabaseShape,
    evaluation: Evaluation,
    classRoom: ClassRoom,
    omrResponse: OmrServiceResponse,
    options: {
      fallbackStudent?: Student | null
      fallbackAnswerCard?: EvaluationAnswerCard | null
      fallbackCardId?: string | null
      strictQrTarget?: boolean
    } = {},
  ): OmrResolvedTarget {
    const qrPayload = this.qrCodeService.extractPayload(omrResponse)
    const qrExamId = this.readQrPayloadValue(qrPayload, ['prova_id', 'examId'])
    if (qrExamId && qrExamId !== evaluation.id) {
      throw new BadRequestException('Cartao resposta pertence a outra prova.')
    }
    const qrClassId = this.readQrPayloadValue(qrPayload, ['turma_id', 'classId'])
    if (qrClassId && qrClassId !== classRoom.id) {
      throw new BadRequestException('Cartao resposta pertence a outra turma.')
    }

    const responseRecord = omrResponse as Record<string, unknown>
    const answerCards = this.getEvaluationAnswerCardsInPrintOrder(data, evaluation.id)
    const cardsByCardId = new Map(answerCards.flatMap((card) => [[card.cardId, card], [card.id, card]] as Array<[string, EvaluationAnswerCard]>))
    const cardsByStudentId = new Map(answerCards.map((card) => [card.studentId, card]))

    const payloadCardId = this.readQrPayloadValue(qrPayload, ['cartao_id', 'answerCardId', 'cardId'])
    const payloadStudentId = this.readQrPayloadValue(qrPayload, ['aluno_id', 'studentId'])
    const responseCardId = this.normalizeOmrResponseId(responseRecord.answerCardId)
    const responseStudentId = this.normalizeOmrResponseId(responseRecord.studentId)
    let cardId = payloadCardId || responseCardId || this.normalizeOmrResponseId(options.fallbackCardId)
    let studentId = payloadStudentId || responseStudentId || this.normalizeOmrResponseId(options.fallbackStudent?.id)
    let answerCard = (cardId && cardsByCardId.get(cardId)) || options.fallbackAnswerCard || null
    let student = (studentId && data.students.find((item) => item.id === studentId)) || null

    if (answerCard && answerCard.evaluationId !== evaluation.id) {
      throw new BadRequestException('Cartao resposta nao pertence a esta prova.')
    }
    if (answerCard && answerCard.classId !== classRoom.id) {
      throw new BadRequestException('Cartao resposta nao pertence a turma da prova.')
    }

    if (answerCard && student && answerCard.studentId !== student.id) {
      if (options.strictQrTarget || payloadCardId || payloadStudentId || responseCardId || responseStudentId) {
        throw new BadRequestException('Cartao resposta identifica aluno diferente do informado.')
      }
      student = null
    }

    if (!student && answerCard) {
      student = data.students.find((item) => item.id === answerCard!.studentId) ?? null
      studentId = student?.id ?? ''
    }
    if (!answerCard && student) {
      answerCard = cardsByStudentId.get(student.id) ?? null
      cardId = answerCard?.cardId ?? cardId
    }
    if (!student && options.fallbackStudent) {
      student = options.fallbackStudent
      studentId = student.id
    }
    if (!answerCard && options.fallbackAnswerCard) {
      answerCard = options.fallbackAnswerCard
      cardId = answerCard.cardId
    }

    if (!student || !studentId) throw new BadRequestException('Nao foi possivel identificar o aluno do cartao resposta.')
    if (student.classId !== classRoom.id) throw new BadRequestException('Aluno identificado nao pertence a turma da prova.')

    return {
      student,
      answerCard,
      cardId: cardId || answerCard?.cardId || null,
    }
  }

  private async requestOmrCorrection(file: OmrImageFile, payload: { answerKey: EvaluationAnswerKeyItem[]; [key: string]: unknown }) {
    return this.requestOmrService<OmrServiceResponse>(file, payload, '/v1/omr/process', 15_000)
  }

  private async requestOmrBatchCorrection(file: OmrImageFile, payload: { answerKey: EvaluationAnswerKeyItem[]; [key: string]: unknown }) {
    const body = await this.requestOmrService<unknown>(file, payload, '/v1/omr/process-batch', 90_000)
    if (Array.isArray(body)) return body as OmrServiceResponse[]
    if (body && typeof body === 'object' && Array.isArray((body as { corrections?: unknown[] }).corrections)) {
      return (body as { corrections: OmrServiceResponse[] }).corrections
    }
    throw new BadRequestException('Servico OMR retornou lote em formato invalido.')
  }

  private async requestOmrService<T>(
    file: OmrImageFile,
    payload: { answerKey: EvaluationAnswerKeyItem[]; [key: string]: unknown },
    endpoint: '/v1/omr/process' | '/v1/omr/process-batch',
    defaultTimeoutMs: number,
  ): Promise<T> {
    if (Date.now() < this.omrCircuitOpenUntil) {
      throw new BadRequestException('Servico OMR temporariamente indisponivel.')
    }

    const configuredBaseUrl = String(this.configService.get<string>('OMR_SERVICE_URL') ?? '').trim()
    if (!configuredBaseUrl) throw new BadRequestException('Servico OMR nao configurado.')
    const baseUrl = configuredBaseUrl.replace(/\/+$/, '')
    let omrUrl: URL
    try {
      omrUrl = new URL(`${baseUrl}${endpoint}`)
      if (!['http:', 'https:'].includes(omrUrl.protocol)) throw new Error('Protocolo invalido.')
      if (process.env.NODE_ENV === 'production' && this.isBlockedRemoteHostname(omrUrl.hostname)) {
        throw new Error('Host OMR invalido em producao.')
      }
    } catch {
      throw new BadRequestException('Servico OMR configurado com URL invalida.')
    }
    const detected = this.detectUploadContentType(file.buffer, true)
    const formData = new FormData()
    formData.append('payload', JSON.stringify(payload))
    formData.append('image', new Blob([new Uint8Array(file.buffer)], { type: detected.contentType }), this.safeOriginalFileName(file.originalname || `cartao-resposta.${detected.extension}`))
    const internalToken = String(this.configService.get<string>('OMR_INTERNAL_TOKEN') ?? '').trim()
    const timeoutMs = Math.max(1000, Math.min(120_000, Number(
      this.configService.get<string>('OMR_REQUEST_TIMEOUT_MS')
        ?? this.configService.get<string>('OMR_TIMEOUT_MS')
        ?? defaultTimeoutMs,
    ) || defaultTimeoutMs))
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(omrUrl, {
        method: 'POST',
        body: formData,
        headers: internalToken ? { 'x-liensina-omr-token': internalToken } : undefined,
        signal: abortController.signal,
      })
    } catch (error) {
      this.recordOmrFailure()
      throw new BadRequestException(error instanceof Error && error.name === 'AbortError'
        ? 'Servico OMR excedeu o tempo limite.'
        : 'Servico OMR indisponivel.')
    } finally {
      clearTimeout(timeout)
    }

    const responseText = await response.text()
    let body: unknown = {}
    try {
      body = responseText ? JSON.parse(responseText) : {}
    } catch {
      body = { message: responseText }
    }

    if (!response.ok) {
      this.recordOmrFailure()
      const message = typeof body === 'object' && body && 'detail' in body
        ? JSON.stringify((body as { detail: unknown }).detail).slice(0, 300)
        : response.statusText
      throw new BadRequestException(`Servico OMR recusou a imagem: ${message}`)
    }

    this.resetOmrCircuit()
    return body as T
  }

  private recordOmrFailure() {
    this.omrFailureCount += 1
    if (this.omrFailureCount < 3) return
    const openMs = Math.max(1000, Math.min(5 * 60_000, Number(this.configService.get<string>('OMR_CIRCUIT_OPEN_MS') ?? 30_000) || 30_000))
    this.omrCircuitOpenUntil = Date.now() + openMs
  }

  private resetOmrCircuit() {
    this.omrFailureCount = 0
    this.omrCircuitOpenUntil = 0
  }

  private normalizeCorrectionAnswers(value: unknown, answerKey: EvaluationAnswerKeyItem[]): EvaluationCorrectionDetectedAnswer[] {
    const rows = Array.isArray(value) ? value : []
    return answerKey.map((key) => {
      const row = rows.find((item) => Number((item as { questionNumber?: unknown }).questionNumber) === key.questionNumber) as Partial<EvaluationCorrectionDetectedAnswer> | undefined
      const status = row?.status === 'ok' || row?.status === 'blank' || row?.status === 'multiple' || row?.status === 'low_confidence' || row?.status === 'unreadable'
        ? row.status
        : 'unreadable'
      const detectedOption = row?.detectedOption == null ? null : String(row.detectedOption).toUpperCase()
      const correctOption = String(row?.correctOption ?? key.correctOption).toUpperCase()

      return {
        questionNumber: key.questionNumber,
        questionId: row?.questionId ?? key.questionId,
        detectedOption,
        correctOption,
        isCorrect: Boolean(row?.isCorrect),
        status,
        confidence: this.toConfidence(row?.confidence ?? 0),
        markedOptions: Array.isArray(row?.markedOptions) ? row.markedOptions.map(String) : [],
        optionScores: Array.isArray(row?.optionScores)
          ? row.optionScores.map((score) => ({ option: String(score.option), fillRatio: Number(score.fillRatio) || 0 }))
          : [],
      }
    })
  }

  private detectUploadContentType(buffer: Buffer, allowPdf: boolean) {
    if (buffer.length < 12) throw new BadRequestException('Arquivo vazio ou invalido.')
    const header = buffer.subarray(0, 16)
    const prefix = header.toString('utf8').trimStart().toLowerCase()
    if (prefix.startsWith('<svg') || prefix.startsWith('<?xml') || prefix.startsWith('<!doctype') || prefix.startsWith('<html')) {
      throw new BadRequestException('Formato de arquivo nao permitido.')
    }
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return { contentType: 'image/jpeg', extension: 'webp' }
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: 'image/png', extension: 'webp' }
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { contentType: 'image/webp', extension: 'webp' }
    if (allowPdf && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return { contentType: 'application/pdf', extension: 'pdf' }
    throw new BadRequestException('Assinatura real do arquivo nao e permitida.')
  }

  private async prepareOmrStoredFile(file: OmrImageFile): Promise<SafeStoredFile> {
    const detected = this.detectUploadContentType(file.buffer, true)
    if (detected.contentType === 'application/pdf') {
      return {
        buffer: file.buffer,
        contentType: detected.contentType,
        extension: detected.extension,
        sizeBytes: file.buffer.length,
      }
    }
    return this.reencodeImageFile(file, maxStoredOmrImagePixels, maxStoredOmrImageDimension)
  }

  private async reencodeImageFile(file: ProfileImageFile, maxPixels: number, maxDimension: number): Promise<SafeStoredFile> {
    this.detectUploadContentType(file.buffer, false)
    let metadata: sharp.Metadata
    try {
      metadata = await sharp(file.buffer, { limitInputPixels: maxPixels }).metadata()
    } catch {
      throw new BadRequestException('Imagem invalida ou corrompida.')
    }
    if (!metadata.width || !metadata.height) throw new BadRequestException('Imagem invalida.')
    if ((metadata.pages ?? 1) > 1) throw new BadRequestException('Imagens animadas ou multipagina nao sao permitidas.')
    if (metadata.width * metadata.height > maxPixels) throw new BadRequestException('Resolucao da imagem excede o limite permitido.')

    try {
      const buffer = await sharp(file.buffer, { limitInputPixels: maxPixels })
        .rotate()
        .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 86, effort: 4 })
        .toBuffer()
      return {
        buffer,
        contentType: 'image/webp',
        extension: 'webp',
        sizeBytes: buffer.length,
      }
    } catch {
      throw new BadRequestException('Nao foi possivel processar a imagem enviada.')
    }
  }

  private safeOriginalFileName(value: unknown) {
    const base = String(value ?? 'arquivo')
      .replace(/[/\\]/g, '_')
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["<>|:*?]/g, '_')
      .trim()
    return base.slice(0, 120) || 'arquivo'
  }

  private async saveEvaluationCorrectionImage(evaluationId: string, studentId: string, file: OmrImageFile): Promise<StoredImageObject> {
    const storedFile = await this.prepareOmrStoredFile(file)
    const bucket = this.getOmrMediaBucket()
    const key = `evaluations/${evaluationId}/students/${studentId}/${randomUUID()}.${storedFile.extension}`
    const uploadsDir = join(process.cwd(), 'uploads', 'private', bucket)
    const filePath = join(uploadsDir, key)

    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, storedFile.buffer)

    return {
      storageProvider: 'local',
      bucket,
      key,
      publicUrl: '',
      contentType: storedFile.contentType,
      sizeBytes: storedFile.sizeBytes,
      originalName: this.safeOriginalFileName(file.originalname),
      uploadedAt: new Date().toISOString(),
    }
  }

  private getOmrMediaBucket() {
    return String(this.configService.get<string>('OMR_MEDIA_BUCKET') ?? 'liensina-omr-corrections')
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'liensina-omr-corrections'
  }

  private recalculateEvaluationCorrectionSummary(data: DatabaseShape, evaluationId: string) {
    const evaluation = data.evaluations.find((item) => item.id === evaluationId)
    if (!evaluation) return
    const confirmed = data.evaluationCorrections.filter((correction) => correction.evaluationId === evaluationId && correction.status === 'CONFIRMED' && correction.finalScore != null)
    evaluation.corrected = confirmed.length
    evaluation.participants = Math.max(evaluation.participants ?? 0, confirmed.length)
    evaluation.averageScore = confirmed.length
      ? Number((confirmed.reduce((total, correction) => total + Number(correction.finalScore ?? 0), 0) / confirmed.length).toFixed(2))
      : 0
    if (confirmed.length > 0 && evaluation.status === 'planejado') evaluation.status = 'corrigindo'
  }

  private toScore(value: unknown) {
    return Math.max(0, Math.min(10, Number(Number(value ?? 0).toFixed(2)) || 0))
  }

  private toConfidence(value: unknown) {
    return Math.max(0, Math.min(1, Number(Number(value ?? 0).toFixed(4)) || 0))
  }

  private selectLegacyEvaluationQuestions(data: DatabaseShape, evaluation: Evaluation, actor: UserAccount) {
    const target = this.normalizeQuestionQuantity(evaluation.questions)
    if (target <= 0) return []

    const roleCode = this.getCurrentRoleCode(data, actor)
    const subjectFilter = this.normalizeTextKey(evaluation.subject)
    const classRoom = data.classes.find((item) => item.id === evaluation.classId)
    const gradeFilter = this.normalizeTextKey(classRoom?.grade)
    const schoolId = classRoom?.schoolId

    const subjectPool = data.questions.filter((question) => {
      if (question.status !== 'APPROVED') return false
      if (!this.canUseQuestionInSelection(question, actor, roleCode)) return false
      return subjectFilter ? this.questionMatchesSubjectFilter(question, subjectFilter) : true
    })

    const gradePool = gradeFilter
      ? subjectPool.filter((question) => this.questionMatchesGradeFilter(question.gradeLevel, gradeFilter))
      : []
    const schoolPool = schoolId
      ? subjectPool.filter((question) => question.schoolId === schoolId)
      : []

    const candidatePool = gradePool.length >= target
      ? gradePool
      : schoolPool.length >= target
        ? schoolPool
        : subjectPool.length
          ? subjectPool
          : data.questions.filter((question) => question.status === 'APPROVED' && this.canUseQuestionInSelection(question, actor, roleCode))

    return this.stableQuestionSelection(candidatePool, evaluation.id).slice(0, target)
  }

  private stableQuestionSelection(questions: Question[], seed: string) {
    return [...questions].sort((first, second) => {
      const firstKey = createHash('sha256').update(`${seed}:${first.id}`).digest('hex')
      const secondKey = createHash('sha256').update(`${seed}:${second.id}`).digest('hex')
      return firstKey.localeCompare(secondKey)
    })
  }

  private safeDownloadSlug(value: unknown) {
    return this.normalizeTextKey(value)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      || 'prova'
  }

  private questionMatchesGradeFilter(questionGrade: unknown, gradeFilter: string) {
    const target = this.normalizeGradeKey(gradeFilter)
    const current = this.normalizeGradeKey(questionGrade)
    if (!target || !current) return true
    if (target === current) return true
    if (target.startsWith('em')) return current.startsWith('em') || current.includes('ensino medio') || current.includes('serie')

    const targetYear = target.match(/^ef([1-9])$/)?.[1]
    return Boolean(targetYear && (current === `ef${targetYear}` || current.includes(`${targetYear}o ano`) || current.includes(`${targetYear} ano`)))
  }

  private normalizeGradeKey(value: unknown) {
    const text = this.normalizeTextKey(value)
    if (!text) return ''
    const direct = text.replace(/\s+/g, '')
    if (/^e[fm][1-9]$/.test(direct)) return direct

    const year = text.match(/\b([1-9])\b/)?.[1]
    if (text.includes('medio') && year && Number(year) >= 1 && Number(year) <= 3) return `em${year}`
    if (text.includes('fundamental') && year && Number(year) >= 1 && Number(year) <= 9) return `ef${year}`
    if (text.includes('serie') && year && Number(year) >= 1 && Number(year) <= 3) return `em${year}`
    if (text.includes('ano') && year && Number(year) >= 1 && Number(year) <= 9) return `ef${year}`

    return text
  }

  private canUseQuestionInSelection(question: Question, actor: UserAccount, roleCode: RoleCode) {
    if (question.sourceType === 'INEP_ENEM' || question.visibility === 'GLOBAL' || question.visibility === 'NETWORK') return true
    if (question.visibility === 'PRIVATE') {
      return question.createdById === actor.id || question.createdById === actor.linkedTeacherId
    }
    if (roleCode === 'SUPERADMIN' || roleCode === 'ADMIN' || roleCode === 'ADMIN_ESCOLA' || roleCode === 'DIRETOR' || roleCode === 'COORDENADOR') {
      return !actor.schoolId || question.schoolId === actor.schoolId
    }
    return question.schoolId === actor.schoolId || question.createdById === actor.id || question.createdById === actor.linkedTeacherId
  }

  private ensureQuestionMutationAllowed(data: DatabaseShape, actor: UserAccount, question: Question) {
    const roleCode = this.getCurrentRoleCode(data, actor)
    if (this.isSuperAdminRole(roleCode)) return
    if (this.isSchoolAdminRole(roleCode) && actor.schoolId && actor.schoolId === question.schoolId) return
    if (question.createdById === actor.id || question.createdById === actor.linkedTeacherId) return
    throw new ForbiddenException('Sem permissao para alterar esta questao.')
  }

  private questionMatchesSubjectFilter(question: Question, subjectFilter: string) {
    const targetLanguage = this.getQuestionLanguageFromText(subjectFilter)
    const source = this.normalizeTextKey([
      question.subject,
      question.component,
      question.area,
      question.sourceName,
      this.metadataAcademicText(question.metadata),
    ].join(' '))

    const specificSubject = this.getSpecificSubjectFilter(subjectFilter)
    if (specificSubject) return this.inferSpecificQuestionSubject(question) === specificSubject

    if (source.includes(subjectFilter)) return true

    if (targetLanguage) {
      const questionLanguage = this.getQuestionLanguage(question)
      if (targetLanguage === 'portugues') {
        return questionLanguage ? questionLanguage === 'portugues' : this.getQuestionSubjectGroup(source) === 'linguagens'
      }
      return questionLanguage === targetLanguage
    }

    const targetGroup = this.getQuestionSubjectGroup(subjectFilter)
    const questionGroup = this.getQuestionSubjectGroup(source)
    return Boolean(targetGroup && questionGroup && targetGroup === questionGroup)
  }

  private getSpecificSubjectFilter(value: unknown): 'fisica' | 'quimica' | 'historia' | null {
    const text = this.normalizeTextKey(value)
    if (text === 'fisica') return 'fisica'
    if (text === 'quimica') return 'quimica'
    if (text === 'historia') return 'historia'
    return null
  }

  private inferSpecificQuestionSubject(question: Question): 'fisica' | 'quimica' | 'historia' | null {
    const source = this.normalizeTextKey([
      question.subject,
      question.component,
      question.area,
      question.sourceName,
      this.metadataAcademicText(question.metadata),
    ].join(' '))
    const text = this.normalizeTextKey([
      source,
      question.title,
      question.context,
      question.statement,
      question.explanation,
      question.options.map((option) => option.text).join(' '),
      question.skills.map((skill) => `${skill.code} ${skill.description} ${skill.knowledgeObject}`).join(' '),
      question.descriptors.map((descriptor) => `${descriptor.code} ${descriptor.description}`).join(' '),
    ].join(' '))
    const skillNumbers = this.getQuestionSkillNumbers(question)
    const hasSkill = (skillNumber: number) => skillNumbers.includes(skillNumber)
    const areaIsNature = this.getQuestionSubjectGroup(question.area) === 'natureza'
      || this.getQuestionSubjectGroup(question.subject) === 'natureza'
      || source.includes('natureza')
    const areaIsHuman = this.getQuestionSubjectGroup(question.area) === 'humanas'
      || this.getQuestionSubjectGroup(question.subject) === 'humanas'
      || source.includes('humanas')
    const physicsTerms = ['velocidade', 'forca', 'energia', 'aceleracao', 'movimento', 'pressao', 'potencia', 'circuito', 'eletrica', 'onda', 'calor', 'temperatura']
    const chemistryTerms = ['mol', 'reacao', 'atomo', 'molecula', 'substancia', 'quimica', 'solucao', 'ion', 'oxidacao', 'estequiometria']
    const historyTerms = ['era vargas', 'revolucao francesa', 'ditadura militar', 'guerra fria', 'colonizacao', 'iluminismo', 'escravidao', 'industrializacao', 'republica velha', 'revolucao', 'guerra', 'ditadura', 'imperio']

    if (source.includes('quimica')) return 'quimica'
    if (source.includes('fisica') && !source.includes('educacao fisica')) return 'fisica'
    if (source.includes('historia')) return 'historia'
    if (areaIsNature && ((hasSkill(17) && this.hasAnyTextTerm(text, ['velocidade', 'forca', 'energia'])) || this.hasAnyTextTerm(text, physicsTerms))) return 'fisica'
    if (areaIsNature && ((hasSkill(21) && this.hasAnyTextTerm(text, ['mol', 'reacao', 'atomo'])) || this.hasAnyTextTerm(text, chemistryTerms))) return 'quimica'
    if (areaIsHuman && this.hasAnyTextTerm(text, historyTerms)) return 'historia'
    return null
  }

  private hasAnyTextTerm(text: string, terms: string[]) {
    return terms.some((term) => text.includes(this.normalizeTextKey(term)))
  }

  private getQuestionSkillNumbers(question: Question) {
    const metadataValues = Object.entries(question.metadata ?? {})
      .filter(([key]) => /habilidade|skill|ability|competencia|competence/i.test(key))
      .flatMap(([, value]) => Array.isArray(value) ? value : [value])

    return [
      ...question.skills.map((skill) => skill.code),
      ...metadataValues.map((value) => String(value ?? '')),
    ].flatMap((value) => String(value).match(/\d+/g) ?? []).map(Number)
  }

  private getQuestionSubjectGroup(value: unknown) {
    const text = this.normalizeTextKey(value)
    if (!text) return null
    if (text.includes('matematica')) return 'matematica'
    if (/(linguagens|portugues|literatura|redacao|ingles|espanhol|educacao fisica)/.test(text)) return 'linguagens'
    if (/(humanas|historia|geografia|filosofia|sociologia|sociais)/.test(text)) return 'humanas'
    if (/(natureza|biologia|fisica|quimica|ciencias naturais)/.test(text) || text === 'ciencias') return 'natureza'
    return null
  }

  private getQuestionLanguage(question: Question) {
    const explicitLanguage = this.getQuestionLanguageFromText([
      question.subject,
      question.component,
      question.area,
      question.sourceName,
      this.metadataAcademicText(question.metadata),
    ].join(' '))
    if (explicitLanguage) return explicitLanguage

    if (question.sourceType !== 'INEP_ENEM' && this.getQuestionSubjectGroup(question.subject) !== 'linguagens') return null
    return this.inferQuestionLanguageFromContent(question)
  }

  private getQuestionLanguageFromText(value: unknown): 'ingles' | 'espanhol' | 'portugues' | null {
    const text = this.normalizeTextKey(value)
    if (/\b(ingles|lingua inglesa|english|foreign language english|idioma ingles)\b/.test(text)) return 'ingles'
    if (/\b(espanhol|lingua espanhola|spanish|espanol|castellano|idioma espanhol)\b/.test(text)) return 'espanhol'
    if (/\b(portugues|lingua portuguesa|literatura|redacao)\b/.test(text)) return 'portugues'
    return null
  }

  private metadataAcademicText(metadata: Question['metadata']) {
    return Object.values(metadata ?? {})
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value) => ['string', 'number', 'boolean'].includes(typeof value))
      .map((value) => String(value))
      .join(' ')
  }

  private inferQuestionLanguageFromContent(question: Question): 'ingles' | 'espanhol' | null {
    const text = this.normalizeTextKey([
      question.statement,
      question.context,
      question.options.map((option) => option.text).join(' '),
    ].join(' ').slice(0, 6000))
    const tokens = text.match(/[a-z]+/g) ?? []
    const englishWords = new Set(['the', 'and', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'for', 'with', 'on', 'from', 'by', 'about', 'people', 'world', 'not', 'can', 'will', 'would', 'have', 'has', 'had', 'this', 'that', 'they', 'their', 'them', 'you', 'your', 'we', 'our', 'what', 'when', 'where', 'why', 'how', 'which', 'who', 'because', 'there'])
    const spanishWords = new Set(['el', 'los', 'las', 'una', 'unas', 'unos', 'que', 'para', 'con', 'por', 'como', 'pero', 'mas', 'muy', 'esta', 'este', 'estos', 'estas', 'son', 'fue', 'era', 'tiene', 'tienen', 'desde', 'sobre', 'cuando', 'donde', 'porque', 'usted', 'nosotros', 'ellos', 'ellas', 'mundo', 'personas', 'tambien'])
    const englishScore = tokens.reduce((score, token) => score + (englishWords.has(token) ? 1 : 0), 0)
    const spanishScore = tokens.reduce((score, token) => score + (spanishWords.has(token) ? 1 : 0), 0)

    if (englishScore >= 8 && englishScore >= spanishScore + 4) return 'ingles'
    if (spanishScore >= 8 && spanishScore >= englishScore + 4) return 'espanhol'
    return null
  }

  private buildMixedQuestionSelection(questions: Question[], target: number) {
    const enemPool = this.shuffleItems(questions.filter((question) => question.sourceType === 'INEP_ENEM'))
    const systemPool = this.shuffleItems(questions.filter((question) => question.sourceType !== 'INEP_ENEM'))
    const enemTarget = Math.ceil(target / 2)
    const selected = [...enemPool.slice(0, enemTarget), ...systemPool.slice(0, target - enemTarget)]
    const selectedIds = new Set(selected.map((question) => question.id))
    const remainder = this.shuffleItems(questions.filter((question) => !selectedIds.has(question.id))).slice(0, target - selected.length)
    return this.shuffleItems([...selected, ...remainder]).slice(0, target)
  }

  private ensureSchoolExists(data: { schools: School[] }, schoolId: string) {
    const school = data.schools.find((item) => item.id === schoolId)
    if (!school) throw new BadRequestException('Escola informada nao existe.')
    return school
  }

  private getClassRoomForSchool(classes: ClassRoom[], classId: string, schoolId: string) {
    const classRoom = classes.find((item) => item.id === classId)
    if (!classRoom) throw new BadRequestException('Turma informada nao existe.')
    if (classRoom.schoolId !== schoolId) throw new BadRequestException('Turma informada nao pertence a escola selecionada.')
    return classRoom
  }

  private normalizeQuestionQuantity(value: unknown) {
    const quantity = Number(value)
    if (!Number.isInteger(quantity) || quantity < 1) throw new BadRequestException('Quantidade de questoes invalida.')
    return Math.min(quantity, 180)
  }

  private normalizeEnemYears(value: unknown) {
    const requestedYears = Array.isArray(value) && value.length > 0 ? value.map((year) => Number(year)) : defaultEnemYears
    const years = Array.from(new Set(requestedYears))
      .filter((year) => Number.isInteger(year) && year >= 2009 && year <= 2023)
      .sort((first, second) => first - second)

    if (!years.length) throw new BadRequestException('Informe anos do ENEM entre 2009 e 2023.')
    return years
  }

  private normalizeEnemDisciplineFilter(value: unknown) {
    const normalized = this.normalizeTextKey(value)
    if (!normalized) return null
    if (normalized.includes('matematica')) return 'matematica'
    if (normalized.includes('linguagem') || normalized.includes('portugues') || normalized.includes('redacao')) return 'linguagens'
    if (normalized.includes('natureza') || normalized.includes('biologia') || normalized.includes('fisica') || normalized.includes('quimica')) return 'ciencias-natureza'
    if (normalized.includes('humana') || normalized.includes('historia') || normalized.includes('geografia') || normalized.includes('filosofia') || normalized.includes('sociologia')) return 'ciencias-humanas'
    if (normalized === 'ciencias-natureza' || normalized === 'ciencias-humanas' || normalized === 'linguagens') return normalized
    return null
  }

  private async fetchEnemDevQuestions(years: number[]) {
    const questions: EnemDevQuestion[] = []

    for (const year of years) {
      questions.push(...await this.fetchEnemDevQuestionsByYear(year))
    }

    return questions
  }

  private async fetchEnemDevQuestionsByYear(year: number) {
    const questions: EnemDevQuestion[] = []
    let offset = 0
    let hasMore = true

    while (hasMore) {
      const url = `${enemApiBaseUrl}/${year}/questions?limit=${enemQuestionPageLimit}&offset=${offset}`
      const page = await this.fetchJsonWithTimeout<EnemDevQuestionPage>(url)
      const pageQuestions = Array.isArray(page.questions) ? page.questions : []
      questions.push(...pageQuestions)

      const pageLimit = Number(page.metadata?.limit ?? enemQuestionPageLimit)
      offset += Number.isFinite(pageLimit) && pageLimit > 0 ? pageLimit : enemQuestionPageLimit
      hasMore = Boolean(page.metadata?.hasMore) && pageQuestions.length > 0
    }

    return questions
  }

  private async fetchJsonWithTimeout<T>(url: string): Promise<T> {
    let lastError: unknown = null

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)

      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) throw new BadRequestException(`Nao foi possivel buscar questoes do ENEM em ${url}.`)
        return await response.json() as T
      } catch (error) {
        lastError = error
        if (attempt === 6) break
        await new Promise((resolveRetry) => setTimeout(resolveRetry, attempt * 3000))
      } finally {
        clearTimeout(timeout)
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new BadRequestException(`Nao foi possivel buscar questoes do ENEM em ${url}.`)
  }

  private async fetchImageWithTimeout(url: string): Promise<DownloadedQuestionImage | null> {
    if (!(await this.isAllowedRemoteQuestionImageUrl(url))) return null
    const controller = new AbortController()
    const timeoutMs = Math.max(1000, Math.min(30_000, Number(this.configService.get<string>('REMOTE_FETCH_TIMEOUT_MS') ?? 10_000) || 10_000))
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        headers: { Accept: 'image/*' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) return null
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      if (contentLength > maxRemoteQuestionImageBytes) return null

      const buffer = await this.readBoundedResponse(response, maxRemoteQuestionImageBytes)
      if (!buffer) return null
      const detected = this.detectUploadContentType(buffer, false)
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(detected.contentType)) return null
      const mimeType = detected.contentType
      return {
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        mimeType,
        sizeBytes: buffer.byteLength,
      }
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  private async isAllowedRemoteQuestionImageUrl(rawUrl: string) {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return false
    }
    if (url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    if (this.isBlockedRemoteHostname(url.hostname)) return false
    const allowedHosts = String(this.configService.get<string>('ENEM_IMAGE_ALLOWED_HOSTS') ?? 'api.enem.dev,enem.dev')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
    const hostname = url.hostname.toLowerCase()
    if (!allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return false

    try {
      const addresses = await lookup(hostname, { all: true, verbatim: true })
      return addresses.length > 0 && addresses.every((address) => !this.isBlockedRemoteAddress(address.address))
    } catch {
      return false
    }
  }

  private async readBoundedResponse(response: Response, maxBytes: number) {
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let received = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        received += chunk.byteLength
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return null
        }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks, received)
    } finally {
      reader.releaseLock()
    }
  }

  private isBlockedRemoteHostname(hostname: string) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (normalized === 'localhost' || normalized === '0.0.0.0' || normalized === '127.0.0.1' || normalized === '::1') return true
    if (normalized === '169.254.169.254') return true
    if (isIP(normalized)) return this.isBlockedRemoteAddress(normalized)
    if (normalized.endsWith('.localhost')) return true
    return false
  }

  private isBlockedRemoteAddress(address: string): boolean {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
    if (normalized === 'localhost' || normalized === '0.0.0.0' || normalized === '127.0.0.1' || normalized === '::1') return true
    if (normalized === '169.254.169.254') return true
    if (normalized.startsWith('::ffff:')) return this.isBlockedRemoteAddress(normalized.slice('::ffff:'.length))
    if (normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    const parts = normalized.split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    const [first, second] = parts
    return first === 10
      || first === 127
      || first === 0
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
  }

  private async toEnemQuestionWithEmbeddedImages(apiQuestion: EnemDevQuestion, actorId: string): Promise<Question> {
    return this.embedQuestionImages(await Promise.resolve(this.toEnemQuestion(apiQuestion, actorId)))
  }

  private async embedQuestionImages(question: Question): Promise<Question> {
    const imageCache = new Map<string, DownloadedQuestionImage | null>()
    const getImage = async (url: string) => {
      if (!/^https?:\/\//i.test(url)) return null
      if (!imageCache.has(url)) imageCache.set(url, await this.fetchImageWithTimeout(url))
      return imageCache.get(url) ?? null
    }
    const embedMarkdownImages = async (value: string) => {
      const text = String(value ?? '')
      enemMarkdownImagePattern.lastIndex = 0
      const urls = Array.from(text.matchAll(enemMarkdownImagePattern)).map((match) => String(match[2] ?? ''))
      let output = text

      for (const url of Array.from(new Set(urls))) {
        const image = await getImage(url)
        if (image) output = output.split(url).join(image.dataUrl)
      }

      return output
    }

    const options = await Promise.all(question.options.map(async (option) => ({
      ...option,
      text: await embedMarkdownImages(option.text),
    })))
    const attachments = await Promise.all((question.attachments ?? []).map(async (attachment) => {
      const image = await getImage(attachment.fileUrl)
      if (!image) return attachment

      return {
        ...attachment,
        fileUrl: image.dataUrl,
        metadata: {
          ...attachment.metadata,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          sourceUrl: attachment.fileUrl,
          storedInDatabase: true,
        },
      }
    }))

    return {
      ...question,
      context: await embedMarkdownImages(question.context),
      statement: await embedMarkdownImages(question.statement),
      options,
      attachments,
      metadata: {
        ...question.metadata,
        imageStorage: attachments.some((attachment) => /^data:image\//i.test(attachment.fileUrl)) ? 'database' : question.metadata.imageStorage,
      },
    }
  }

  private toEnemQuestion(apiQuestion: EnemDevQuestion, actorId: string): Question {
    const year = Number(apiQuestion.year)
    const index = Number(apiQuestion.index)
    if (!Number.isInteger(year) || !Number.isInteger(index)) throw new BadRequestException('Questão ENEM sem ano ou índice válido.')

    const now = new Date().toISOString()
    const discipline = this.resolveEnemDiscipline(apiQuestion.discipline)
    const questionId = `question-enem-dev-${year}-${index}`
    const sourceExternalId = `enem-dev-${year}-${index}`
    const correctAlternative = String(apiQuestion.correctAlternative ?? '').trim().toUpperCase()
    const files = Array.isArray(apiQuestion.files) ? apiQuestion.files.filter(Boolean) : []
    const alternatives = Array.isArray(apiQuestion.alternatives) ? apiQuestion.alternatives : []
    const optionFiles = alternatives.map((alternative) => alternative.file).filter((file): file is string => Boolean(file))
    const options = alternatives.map((alternative, alternativeIndex) => {
      const label = String(alternative.letter ?? String.fromCharCode(65 + alternativeIndex)).trim().toUpperCase()
      const text = String(alternative.text ?? '').trim() || (alternative.file ? `Imagem da alternativa ${label}` : '')

      return {
        id: `${questionId}-option-${label.toLowerCase()}`,
        questionId,
        label,
        text,
        order: alternativeIndex + 1,
        isCorrect: Boolean(alternative.isCorrect) || label === correctAlternative,
        createdAt: now,
        updatedAt: now,
      }
    })
    const attachments = [...files, ...optionFiles].map((fileUrl, fileIndex) => ({
      id: `${questionId}-attachment-${fileIndex + 1}`,
      questionId,
      fileUrl,
      fileType: 'IMAGE' as const,
      position: files.includes(fileUrl) ? 'CONTEXT' as const : 'OPTION' as const,
      altText: files.includes(fileUrl) ? `Imagem de apoio da questão ${index} do ENEM ${year}` : `Imagem de alternativa da questão ${index} do ENEM ${year}`,
      order: fileIndex + 1,
      metadata: { source: 'enem.dev' },
      createdAt: now,
    }))

    return {
      id: questionId,
      schoolId: 'global-school',
      networkId: 'global-network',
      createdById: actorId,
      title: String(apiQuestion.title ?? `Questão ${index} - ENEM ${year}`).trim(),
      context: String(apiQuestion.context ?? '').trim(),
      statement: String(apiQuestion.alternativesIntroduction ?? apiQuestion.title ?? `Questão ${index} - ENEM ${year}`).trim(),
      explanation: correctAlternative ? `Gabarito informado pela API ENEM: alternativa ${correctAlternative}.` : '',
      type: 'MULTIPLE_CHOICE',
      stage: 'MEDIO',
      gradeLevel: 'Ensino Médio',
      area: discipline.area,
      component: discipline.component,
      subject: discipline.subject,
      difficulty: 'MEDIUM',
      sourceType: 'INEP_ENEM',
      sourceName: 'ENEM via API enem.dev',
      sourceYear: year,
      sourceExternalId,
      sourceUrl: `${enemApiBaseUrl}/${year}/questions`,
      licenseNotes: 'Questão importada da API pública enem.dev para uso no banco de questões.',
      visibility: 'GLOBAL',
      status: 'APPROVED',
      isEditable: false,
      reviewedById: actorId,
      reviewedAt: now,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      metadata: {
        estimatedTimeSeconds: 180,
        hasImage: attachments.length > 0,
        hasTable: this.containsTableLikeText(apiQuestion.context),
        hasFormula: this.containsFormulaLikeText(`${apiQuestion.context ?? ''} ${apiQuestion.alternativesIntroduction ?? ''}`),
        keywords: ['enem', String(year), discipline.keyword],
        enemYear: year,
        enemIndex: index,
        enemDiscipline: String(apiQuestion.discipline ?? '').trim(),
        enemLanguage: apiQuestion.language ?? null,
        correctAlternative,
        sourceApi: 'enem.dev',
      },
      options,
      skills: [],
      descriptors: [],
      attachments,
      reviews: [{
        id: `${questionId}-review-1`,
        questionId,
        reviewerId: actorId,
        status: 'APPROVED',
        comment: 'Questão importada automaticamente da API ENEM.',
        reviewedAt: now,
      }],
    }
  }

  private upsertEnemQuestions(data: DatabaseShape, questions: Question[]) {
    let importedCount = 0

    for (const question of questions) {
      if (question.options.length < 2 || question.options.filter((option) => option.isCorrect).length !== 1) continue

      const existingIndex = data.questions.findIndex((item) =>
        item.id === question.id ||
        (question.sourceExternalId !== null && item.sourceExternalId === question.sourceExternalId),
      )

      if (existingIndex >= 0) {
        const existing = data.questions[existingIndex]
        data.questions[existingIndex] = {
          ...question,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
        }
      } else {
        data.questions.push(question)
        importedCount += 1
      }
    }

    return importedCount
  }

  private updateEnemImportPlan(data: DatabaseShape, years: number[]) {
    const now = new Date().toISOString()
    const yearSet = new Set(years)
    const planIndex = data.questionImportPlans.findIndex((plan) => plan.id === 'question-import-plan-inep-enem')
    const itemsToImport = defaultEnemYears.map((year) => {
      const importedCount = data.questions.filter((question) => question.sourceType === 'INEP_ENEM' && question.sourceYear === year).length
      return {
        sourceYear: year,
        examDay: 0,
        notebookColor: 'API',
        quantity: importedCount,
        importedCount,
        sourceUrl: `${enemApiBaseUrl}/${year}/questions`,
        status: importedCount > 0 ? 'IMPORTED' as const : yearSet.has(year) ? 'PENDING_IMPORT' as const : 'PENDING_IMPORT' as const,
      }
    })
    const plan = {
      id: 'question-import-plan-inep-enem',
      sourceType: 'INEP_ENEM' as const,
      officialSource: 'API ENEM.DEV',
      availableOfficialYears: defaultEnemYears,
      unavailableOfficialYears: [],
      reasonUnavailable: 'A integracao automatica usa a API enem.dev para os anos de 2009 a 2023.',
      recommendedAction: 'Buscar questões por ano em https://api.enem.dev/v1/exams/{ano}/questions, persistir no banco com sourceYear, sourceExternalId, disciplina, número da questão, arquivos e gabarito.',
      itemsToImport,
      active: true,
      metadata: {
        sourceApi: 'https://api.enem.dev/v1/exams',
        supportedYears: defaultEnemYears,
        lastSyncedAt: now,
      },
      createdAt: data.questionImportPlans[planIndex]?.createdAt ?? now,
      updatedAt: now,
    }

    if (planIndex >= 0) data.questionImportPlans[planIndex] = plan
    else data.questionImportPlans.push(plan)
  }

  private resolveEnemDiscipline(value: unknown) {
    const normalized = this.normalizeTextKey(value)

    if (normalized.includes('matematica')) {
      return { area: 'Matematica e suas Tecnologias', component: 'Matematica', subject: 'Matematica', keyword: 'matematica' }
    }
    if (normalized.includes('linguagens')) {
      return { area: 'Linguagens e suas Tecnologias', component: 'Linguagens', subject: 'Linguagens', keyword: 'linguagens' }
    }
    if (normalized.includes('natureza')) {
      return { area: 'Ciencias da Natureza e suas Tecnologias', component: 'Ciencias da Natureza', subject: 'Ciencias da Natureza', keyword: 'ciencias da natureza' }
    }
    if (normalized.includes('humanas')) {
      return { area: 'Ciencias Humanas e Sociais Aplicadas', component: 'Ciencias Humanas', subject: 'Ciencias Humanas', keyword: 'ciencias humanas' }
    }

    return { area: 'ENEM', component: 'ENEM', subject: 'ENEM', keyword: 'enem' }
  }

  private containsTableLikeText(value: unknown) {
    const text = String(value ?? '')
    return text.includes('|') || /tabela|quadro|grafico/i.test(text)
  }

  private containsFormulaLikeText(value: unknown) {
    return /[=²³√∑π∆]|\\frac|\\sqrt|\d+\s*[x*/+-]\s*\d+/i.test(String(value ?? ''))
  }

  private shuffleItems<T>(items: T[]) {
    const shuffled = [...items]

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1))
      ;[shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]]
    }

    return shuffled
  }

  private normalizeTextKey(value: unknown) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, ' ')
      .trim()
  }

  private ensureQuestionIdsExist(data: { questions: Question[] }, questionIds: string[]) {
    const invalidQuestionId = questionIds.find((questionId) => !data.questions.some((question) => question.id === questionId))
    if (invalidQuestionId) throw new BadRequestException('A prova contém questão inexistente no banco.')
  }

  private toQuestionDescriptorSummary(
    data: { assessmentMatrices: AssessmentMatrix[]; assessmentPrograms: AssessmentProgram[] },
    descriptor: AssessmentDescriptor,
    relevance: 'PRIMARY' | 'SECONDARY',
  ): QuestionDescriptorSummary {
    const matrix = data.assessmentMatrices.find((item) => item.id === descriptor.matrixId)
    const program = matrix ? data.assessmentPrograms.find((item) => item.id === matrix.programId) : undefined

    return {
      ...descriptor,
      program: program?.code ?? 'Programa',
      matrix: matrix?.name ?? 'Matriz avaliativa',
      relevance,
    }
  }

  private normalizeEducationStage(value: unknown): EducationStage {
    const stage = String(value ?? '').trim().toUpperCase()
    if (stage === 'INFANTIL' || stage === 'FUNDAMENTAL' || stage === 'MEDIO' || stage === 'EJA') return stage
    throw new BadRequestException('Etapa de ensino invalida.')
  }

  private normalizeQuestionType(value: unknown): QuestionType {
    const type = String(value ?? '').trim().toUpperCase()
    if (type === 'MULTIPLE_CHOICE') return type
    throw new BadRequestException('Tipo de questão inválido.')
  }

  private normalizeDifficulty(value: unknown): Difficulty {
    const difficulty = String(value ?? '').trim().toUpperCase()
    if (difficulty === 'EASY' || difficulty === 'MEDIUM' || difficulty === 'HARD') return difficulty
    throw new BadRequestException('Dificuldade invalida.')
  }

  private normalizeQuestionSourceType(value: unknown): QuestionSourceType {
    const sourceType = String(value ?? '').trim().toUpperCase()
    if (
      sourceType === 'TEACHER_CREATED' ||
      sourceType === 'SECRETARY_CREATED' ||
      sourceType === 'AI_GENERATED' ||
      sourceType === 'INEP_ENEM' ||
      sourceType === 'IMPORTED_SPREADSHEET' ||
      sourceType === 'SCHOOL_BANK' ||
      sourceType === 'GLOBAL_CURATED'
    ) return sourceType
    throw new BadRequestException('Fonte da questão inválida.')
  }

  private normalizeQuestionVisibility(value: unknown): QuestionVisibility {
    const visibility = String(value ?? '').trim().toUpperCase()
    if (visibility === 'PRIVATE' || visibility === 'SCHOOL' || visibility === 'NETWORK' || visibility === 'GLOBAL') return visibility
    throw new BadRequestException('Visibilidade da questão inválida.')
  }

  private normalizeQuestionStatus(value: unknown, fallback: QuestionStatus): QuestionStatus {
    const status = String(value ?? fallback).trim().toUpperCase()
    if (status === 'DRAFT' || status === 'PENDING_REVIEW' || status === 'APPROVED' || status === 'REJECTED' || status === 'ARCHIVED') return status
    return fallback
  }

  private ensureGuardiansBelongToSchool(data: { guardians: Guardian[] }, guardianIds: string[], schoolId: string) {
    const invalid = guardianIds.find((guardianId) => !data.guardians.some((guardian) => guardian.id === guardianId && guardian.schoolId === schoolId))
    if (invalid) throw new BadRequestException('Responsavel informado nao pertence a escola selecionada.')
  }

  private ensureStudentsBelongToSchool(data: { students: Student[] }, studentIds: string[], schoolId: string) {
    const invalid = studentIds.find((studentId) => !data.students.some((student) => student.id === studentId && student.schoolId === schoolId))
    if (invalid) throw new BadRequestException('Aluno informado nao pertence a escola selecionada.')
  }

  private getRoleId(roles: Role[], code: RoleCode) {
    const role = roles.find((item) => item.code === code)
    if (!role) throw new BadRequestException(`Cargo ${code} nao configurado.`)
    return role.id
  }

  private buildRegistrationNumber(data: { students: Student[] }, requested?: string) {
    if (requested?.trim()) return requested.trim()

    const year = new Date().getFullYear()
    const registrations = data.students
      .map((student) => Number(student.registrationNumber || student.registration))
      .filter((value) => Number.isFinite(value))
    const next = registrations.length ? Math.max(...registrations) + 1 : Number(`${year}00001`)

    return String(next)
  }

  private pushAudit(data: { users: UserAccount[]; auditEvents: Array<{ id: string; actor: string; action: string; target: string; createdAt: string }> }, actorId: string, action: string, target: string) {
    const actor = data.users.find((user) => user.id === actorId)?.name ?? 'Sistema'
    data.auditEvents.unshift({ id: this.createId('aud'), actor, action, target, createdAt: new Date().toISOString() })
    data.auditEvents = data.auditEvents.slice(0, 80)
  }

  private pushMealRequestHistory(
    data: { mealRequestHistory: MealRequestHistory[]; roles: Role[] },
    actor: UserAccount,
    action: MealRequestHistoryAction,
    request: MealFoodRequest,
    oldValue: unknown,
    newValue: unknown,
    description: string,
  ) {
    const roleCode = this.getCurrentRoleCode(data, actor)
    data.mealRequestHistory.unshift({
      id: this.createId('meal-request-history'),
      action,
      entityType: 'FOOD_REQUEST',
      entityId: request.id,
      userId: actor.id,
      userRole: roleCode,
      schoolId: request.schoolId,
      oldValue,
      newValue,
      description,
      createdAt: new Date().toISOString(),
    })
    data.mealRequestHistory = data.mealRequestHistory.slice(0, 300)
  }

  private describeFoodRequestHistory(action: MealRequestHistoryAction, request: MealFoodRequest) {
    if (action === 'APPROVED_FOOD_REQUEST') return `Nutricionista aprovou a solicitacao de ${request.quantity} ${request.unit} de ${request.itemName}`
    if (action === 'REJECTED_FOOD_REQUEST') return `Nutricionista reprovou a solicitacao de ${request.itemName}`
    if (action === 'REQUESTED_FOOD_ADJUSTMENT') return `Nutricionista pediu ajuste na solicitacao de ${request.itemName}`
    if (action === 'CANCELLED_FOOD_REQUEST') return `Criador cancelou a solicitacao de ${request.itemName}`
    if (action === 'ADDED_FOOD_REQUEST_TO_STOCK') return `Admin adicionou ${request.itemName} ao estoque oficial`
    return `Solicitacao de ${request.itemName} atualizada`
  }

  private ensureRequired<T extends object>(payload: T, keys: Array<keyof T>) {
    const missing = keys.filter((key) => !String(payload[key] ?? '').trim())
    if (missing.length) throw new BadRequestException(`Campos obrigatorios ausentes: ${missing.join(', ')}`)
  }

  private normalizeProfilePayload(payload: Partial<UserAccount>, current: UserAccount, users: UserAccount[]): Partial<UserAccount> {
    const normalized: Partial<UserAccount> = {}

    if (payload.name !== undefined) {
      const name = String(payload.name).trim()
      if (name.length < 3) throw new BadRequestException('Nome deve conter pelo menos 3 caracteres.')
      if (name.length > 120) throw new BadRequestException('Nome deve conter no maximo 120 caracteres.')
      normalized.name = name
    }

    if (payload.email !== undefined) {
      const email = String(payload.email).trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('E-mail invalido.')
      if (email.length > 160) throw new BadRequestException('E-mail deve conter no maximo 160 caracteres.')
      const emailInUse = users.some((user) =>
        user.id !== current.id &&
        (user.email.toLowerCase() === email || user.login?.toLowerCase() === email),
      )
      if (emailInUse) throw new BadRequestException('Ja existe usuario com este e-mail.')
      normalized.email = email
    }

    if (payload.phone !== undefined) normalized.phone = this.normalizePhone(payload.phone)
    if (payload.cpf !== undefined) normalized.cpf = this.normalizeCpf(payload.cpf)
    if (payload.birthDate !== undefined) normalized.birthDate = this.normalizeBirthDate(payload.birthDate)

    return normalized
  }

  private normalizePhone(value?: string) {
    const digits = String(value ?? '').replace(/\D/g, '')
    if (digits && (digits.length < 10 || digits.length > 11)) {
      throw new BadRequestException('Telefone deve ter DDD e 10 ou 11 digitos.')
    }
    return digits
  }

  private normalizeCpf(value?: string) {
    const digits = String(value ?? '').replace(/\D/g, '')
    if (!digits) return ''
    if (!this.isValidCpf(digits)) throw new BadRequestException('CPF invalido.')
    return digits
  }

  private isValidCpf(digits: string) {
    if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false

    const calculateDigit = (factor: number) => {
      let total = 0
      for (let index = 0; index < factor - 1; index += 1) {
        total += Number(digits[index]) * (factor - index)
      }
      const remainder = (total * 10) % 11
      return remainder === 10 ? 0 : remainder
    }

    return calculateDigit(10) === Number(digits[9]) && calculateDigit(11) === Number(digits[10])
  }

  private normalizeBirthDate(value?: string) {
    const birthDate = String(value ?? '').trim()
    if (!birthDate) return ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) throw new BadRequestException('Data de aniversario invalida.')

    const date = new Date(`${birthDate}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birthDate) {
      throw new BadRequestException('Data de aniversario invalida.')
    }

    const today = new Date()
    const minDate = new Date(Date.UTC(today.getUTCFullYear() - 120, today.getUTCMonth(), today.getUTCDate()))
    if (date > today) throw new BadRequestException('Data de aniversario nao pode ser futura.')
    if (date < minDate) throw new BadRequestException('Data de aniversario deve estar dentro dos ultimos 120 anos.')

    return birthDate
  }

  private syncLinkedProfile(data: { teachers: Teacher[]; guardians: Guardian[]; students: Student[] }, previous: UserAccount, updated: UserAccount) {
    if (previous.linkedTeacherId) {
      const teacher = data.teachers.find((item) => item.id === previous.linkedTeacherId)
      if (teacher) {
        teacher.name = updated.name
        teacher.email = updated.email
        teacher.avatarUrl = updated.avatarUrl
        teacher.bannerUrl = updated.bannerUrl
        teacher.avatarObject = updated.avatarObject
        teacher.bannerObject = updated.bannerObject
      }
    }

    if (previous.linkedGuardianId) {
      const guardian = data.guardians.find((item) => item.id === previous.linkedGuardianId)
      if (guardian) {
        guardian.name = updated.name
        guardian.email = updated.email
        guardian.phone = updated.phone
        guardian.avatarUrl = updated.avatarUrl
        guardian.bannerUrl = updated.bannerUrl
        guardian.avatarObject = updated.avatarObject
        guardian.bannerObject = updated.bannerObject
      }
    }

    if (previous.linkedStudentId) {
      const student = data.students.find((item) => item.id === previous.linkedStudentId)
      if (student) {
        student.name = updated.name
        student.avatarUrl = updated.avatarUrl
        student.bannerUrl = updated.bannerUrl
        student.avatarObject = updated.avatarObject
        student.bannerObject = updated.bannerObject
      }
    }
  }

  private async saveProfileImageFile(actorId: string, file: ProfileImageFile, folder: 'avatars' | 'banners'): Promise<StoredImageObject> {
    const storedFile = await this.reencodeImageFile(file, maxProfileImagePixels, maxProfileImageDimension)
    const bucket = this.getProfileMediaBucket()
    const key = `profile/${folder}/${actorId}/${randomUUID()}.${storedFile.extension}`
    const uploadsDir = join(process.cwd(), 'uploads', 'public', bucket)

    const filePath = join(uploadsDir, key)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, storedFile.buffer)

    return {
      storageProvider: 'local',
      bucket,
      key,
      publicUrl: `/uploads/${bucket}/${key}`,
      contentType: storedFile.contentType,
      sizeBytes: storedFile.sizeBytes,
      originalName: this.safeOriginalFileName(file.originalname),
      uploadedAt: new Date().toISOString(),
    }
  }

  private deleteProfileImageFile(file?: string | StoredImageObject | null) {
    const cleanUrl = typeof file === 'object' && file
      ? `/uploads/${file.bucket}/${file.key}`
      : String(file ?? '').split(/[?#]/)[0]
    if (!cleanUrl.startsWith('/uploads/')) return

    const relativePath = cleanUrl.replace(/^\/uploads\//, '')
    if (!relativePath) return

    const uploadsRoot = resolve(process.cwd(), 'uploads')
    const filePath = resolve(uploadsRoot, relativePath)

    if (filePath !== uploadsRoot && !filePath.startsWith(`${uploadsRoot}${sep}`)) return

    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch {
      // Removing the database reference should not fail because an old file is unavailable.
    }
  }

  private deleteStoredLocalFile(file: StoredImageObject, visibility: 'public' | 'private') {
    if (file.storageProvider !== 'local') return
    const root = resolve(process.cwd(), 'uploads', visibility)
    const filePath = resolve(root, file.bucket, file.key)
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return
    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch {
      // Best-effort cleanup for rejected processing.
    }
  }

  private getProfileMediaBucket() {
    return String(this.configService.get<string>('PROFILE_MEDIA_BUCKET') ?? 'liensina-profile-media')
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'liensina-profile-media'
  }

  private average(values: number[]) {
    if (!values.length) return 0
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  private createId(_prefix: string) {
    return randomUUID()
  }

  private resolveUserSchoolId(data: DatabaseShape, user: UserAccount) {
    if (user.schoolId && data.schools.some((school) => school.id === user.schoolId)) return user.schoolId

    if (user.linkedTeacherId) {
      const teacher = data.teachers.find((item) => item.id === user.linkedTeacherId || item.userId === user.id)
      if (teacher?.schoolId) return teacher.schoolId
    }

    if (user.linkedStudentId) {
      const student = data.students.find((item) => item.id === user.linkedStudentId || item.userId === user.id)
      if (student?.schoolId) return student.schoolId
    }

    if (user.linkedGuardianId) {
      const guardian = data.guardians.find((item) => item.id === user.linkedGuardianId || item.userId === user.id)
      if (guardian?.schoolId) return guardian.schoolId
    }

    const teacher = data.teachers.find((item) => item.userId === user.id)
    if (teacher?.schoolId) return teacher.schoolId

    const student = data.students.find((item) => item.userId === user.id)
    if (student?.schoolId) return student.schoolId

    const guardian = data.guardians.find((item) => item.userId === user.id)
    if (guardian?.schoolId) return guardian.schoolId

    return null
  }

  private toPublicUserWithResolvedSchool(data: DatabaseShape, user: UserAccount): PublicUserAccount {
    return {
      ...this.toPublicUser(user),
      schoolId: this.resolveUserSchoolId(data, user),
    }
  }

  private toPublicUser(user: UserAccount): PublicUserAccount {
    const { password: _password, cpf: _cpf, birthDate: _birthDate, ...publicUser } = user
    return publicUser
  }
}
