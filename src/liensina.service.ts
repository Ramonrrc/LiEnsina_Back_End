import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import * as bcrypt from 'bcryptjs'

import { DatabaseService } from './database.service'
import type { AssessmentDescriptor, AssessmentMatrix, AssessmentProgram, CalendarEventType, ClassRoom, CreateMealFoodPayload, CreateMealItemPayload, CreateMealManagementPayload, CreateQuestionRequest, DatabaseShape, Difficulty, EducationStage, Evaluation, EvaluationBuildMode, GenerateEnemQuestionsRequest, GenerateEnemQuestionsResponse, Guardian, JwtPayload, MealFood, MealManagement, MealMenu, MealMenuStatus, MealShift, MealStockStatus, MealType, PublicUserAccount, Question, QuestionDescriptorSummary, QuestionSourceType, QuestionStatus, QuestionType, QuestionVisibility, RefreshSession, Role, RoleCode, School, SchoolCalendarEvent, Student, Teacher, UpdateMealBudgetPayload, UpsertMealMenuPayload, UserAccount } from './liensina.types'

type ProfileImageFile = {
  buffer: Buffer
  originalname: string
  mimetype: string
  size: number
}

export type AuthContext = {
  userAgent?: string
  ip?: string
}

const passwordHashPattern = /^\$2[aby]\$\d{2}\$/
const passwordSaltRounds = 12
const defaultRefreshReuseGraceSeconds = 15
const enemApiBaseUrl = 'https://api.enem.dev/v1/exams'
const defaultEnemYears = Array.from({ length: 2023 - 2009 + 1 }, (_, index) => 2009 + index)
const enemQuestionPageLimit = 50
const enemMarkdownImagePattern = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi

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

  constructor(
    private readonly database: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(email: string, password: string, context: AuthContext = {}) {
    const normalizedLogin = email.trim().toLowerCase()
    const data = this.database.read()
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
    let publicUser = this.toPublicUser(user)

    this.database.update((currentData) => {
      this.removeExpiredRefreshSessions(currentData)
      const storedUser = this.ensureCurrentUser(currentData, user.id)
      if (storedUser.status !== 'ativo') throw new UnauthorizedException('Usuario bloqueado ou inativo.')
      if (!this.isPasswordHash(storedUser.password)) storedUser.password = this.hashPassword(password)

      const refreshSession = this.createRefreshSession(storedUser.id, context)
      currentData.refreshSessions.push(refreshSession.session)
      refreshToken = refreshSession.token
      refreshExpiresAt = refreshSession.session.expiresAt
      publicUser = this.toPublicUser(storedUser)
      this.pushAudit(currentData, storedUser.id, 'Login realizado', storedUser.name)
    })

    const accessToken = await this.issueAccessToken(user)

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
    const tokenHash = this.hashRefreshToken(refreshToken)
    let user: UserAccount | null = null
    let nextRefreshToken = ''
    let refreshExpiresAt = ''

    this.database.update((data) => {
      this.removeExpiredRefreshSessions(data)
      const activeSession = data.refreshSessions.find((item) => item.tokenHash === tokenHash && !item.revokedAt)
      const recentlyRotatedSession = activeSession
        ? null
        : data.refreshSessions.find((item) => item.tokenHash === tokenHash && this.isRecentRefreshReuse(item, context))
      const session = activeSession ?? recentlyRotatedSession
      if (!session) throw new UnauthorizedException('Refresh token invalido.')
      if (new Date(session.expiresAt).getTime() <= Date.now()) throw new UnauthorizedException('Refresh token expirado.')

      const storedUser = this.ensureCurrentUser(data, session.userId)
      if (storedUser.status !== 'ativo') throw new UnauthorizedException('Usuario bloqueado ou inativo.')

      if (!session.revokedAt) session.revokedAt = new Date().toISOString()
      const nextSession = this.createRefreshSession(storedUser.id, context, session.id)
      data.refreshSessions.push(nextSession.session)
      nextRefreshToken = nextSession.token
      refreshExpiresAt = nextSession.session.expiresAt
      user = storedUser
    })

    if (!user) throw new UnauthorizedException('Usuario nao encontrado.')
    const accessToken = await this.issueAccessToken(user)

    return {
      token: accessToken.token,
      expiresIn: accessToken.expiresIn,
      expiresAt: accessToken.expiresAt,
      refreshToken: nextRefreshToken,
      refreshExpiresAt,
      user: this.toPublicUser(user),
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
    const user = this.database.read().users.find((item) => item.id === userId)
    if (!user) throw new UnauthorizedException('Usuario nao encontrado.')
    if (user.status !== 'ativo') throw new UnauthorizedException('Usuario bloqueado ou inativo.')
    return user
  }

  getBootstrap(userId: string) {
    const data = this.database.read()
    const currentUser = this.ensureCurrentUser(data, userId)

    return {
      currentUser: this.toPublicUser(currentUser),
      dashboard: this.buildDashboard(data),
      roles: data.roles,
      users: data.users.map((user) => this.toPublicUser(user)),
      schools: data.schools,
      teachers: data.teachers,
      guardians: data.guardians,
      students: data.students,
      classes: data.classes,
      evaluations: data.evaluations,
      calendarEvents: data.calendarEvents,
      mealManagements: data.mealManagements,
      auditEvents: data.auditEvents,
    }
  }

  getSession(userId: string) {
    const data = this.database.read()
    const currentUser = this.ensureCurrentUser(data, userId)
    const dashboard = this.buildDashboard(data)

    return {
      currentUser: this.toPublicUser(currentUser),
      currentRole: data.roles.find((role) => role.id === currentUser.roleId) ?? null,
      alertCount: dashboard.alerts.length,
    }
  }

  getDashboardScreen(userId: string) {
    const data = this.database.read()
    this.ensureCurrentUser(data, userId)

    return {
      dashboard: this.buildDashboard(data),
      evaluations: data.evaluations,
      auditEvents: data.auditEvents,
    }
  }

  getSchoolsScreen(userId: string) {
    const data = this.database.read()
    this.ensureCurrentUser(data, userId)

    return {
      schools: data.schools,
      teachers: data.teachers,
      guardians: data.guardians,
      students: data.students,
      classes: data.classes,
    }
  }

  getEvaluationsScreen(userId: string) {
    const data = this.database.read()
    this.ensureCurrentUser(data, userId)

    return {
      evaluations: data.evaluations,
      classes: data.classes,
      curriculumBases: data.curriculumBases,
      curriculumSkills: data.curriculumSkills,
      assessmentPrograms: data.assessmentPrograms,
      assessmentMatrices: data.assessmentMatrices,
      assessmentDescriptors: data.assessmentDescriptors,
      questionBank: data.questions,
      questionImportPlans: data.questionImportPlans,
    }
  }

  getCalendarScreen(userId: string) {
    const data = this.database.read()
    this.ensureCurrentUser(data, userId)

    return {
      calendarEvents: data.calendarEvents,
      schools: data.schools,
      classes: data.classes,
      evaluations: data.evaluations,
    }
  }

  getMealsScreen(userId: string) {
    const data = this.database.read()
    const currentUser = this.ensureCurrentUser(data, userId)
    const managements = currentUser.schoolId
      ? data.mealManagements.filter((management) => management.escolaId === currentUser.schoolId)
      : data.mealManagements
    const schoolIds = new Set(managements.map((management) => management.escolaId))

    return {
      schools: data.schools.filter((school) => schoolIds.has(school.id) || !currentUser.schoolId),
      mealManagements: managements,
    }
  }

  listMealManagements(userId: string) {
    return this.getMealsScreen(userId)
  }

  listMealManagementSchoolPage(userId: string, rawPage: string | number = 1, rawLimit: string | number = 5) {
    const data = this.database.read()
    const currentUser = this.ensureCurrentUser(data, userId)
    const page = Math.max(1, Number(rawPage) || 1)
    const limit = Math.min(20, Math.max(1, Number(rawLimit) || 5))
    const managements = currentUser.schoolId
      ? data.mealManagements.filter((management) => management.escolaId === currentUser.schoolId)
      : data.mealManagements
    const total = managements.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * limit
    const pageManagements = managements.slice(start, start + limit)
    const schoolIds = new Set(pageManagements.map((management) => management.escolaId))

    return {
      schools: data.schools.filter((school) => schoolIds.has(school.id)),
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
    const data = this.database.read()
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

  getAccessScreen(userId: string) {
    const data = this.database.read()
    this.ensureCurrentUser(data, userId)

    return {
      roles: data.roles,
      users: data.users.map((user) => this.toPublicUser(user)),
      schools: data.schools,
    }
  }

  getSettingsScreen(userId: string) {
    const data = this.database.read()
    const currentUser = this.ensureCurrentUser(data, userId)

    return {
      currentUser: this.toPublicUser(currentUser),
    }
  }

  createSchool(actorId: string, payload: Partial<School>) {
    this.ensureRequired(payload, ['name', 'city', 'address', 'director', 'inepCode'])
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
      data.schools.unshift(school)
      this.pushAudit(data, actorId, 'Criou escola', school.name)
    })
    return school
  }

  updateSchool(actorId: string, id: string, payload: Partial<School>) {
    let updated: School | null = null
    this.database.update((data) => {
      const index = data.schools.findIndex((school) => school.id === id)
      if (index < 0) throw new NotFoundException('Escola nao encontrada.')
      updated = { ...data.schools[index], ...payload, id }
      data.schools[index] = updated
      this.pushAudit(data, actorId, 'Atualizou escola', updated.name)
    })
    return updated!
  }

  createClassRoom(actorId: string, payload: Partial<ClassRoom>) {
    this.ensureRequired(payload, ['name', 'grade', 'schoolId', 'teacherId', 'schedule'])
    const teacherIds = Array.from(new Set([payload.teacherId!, ...(payload.teacherIds ?? [])].filter(Boolean)))
    const classRoom: ClassRoom = {
      id: this.createId('turma'),
      name: payload.name!.trim(),
      grade: payload.grade!.trim(),
      shift: payload.shift ?? 'Manha',
      schoolId: payload.schoolId!,
      teacherId: payload.teacherId!,
      teacherIds,
      academicYear: payload.academicYear ?? new Date().getFullYear(),
      schedule: payload.schedule!.trim(),
      bnccFocus: payload.bnccFocus ?? [],
    }
    this.database.update((data) => {
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
    let updated: ClassRoom | null = null
    this.database.update((data) => {
      const index = data.classes.findIndex((classRoom) => classRoom.id === id)
      if (index < 0) throw new NotFoundException('Turma nao encontrada.')
      const teacherId = payload.teacherId ?? data.classes[index].teacherId
      const teacherIds = Array.from(new Set([teacherId, ...(payload.teacherIds ?? data.classes[index].teacherIds ?? [])].filter(Boolean)))
      const schoolId = payload.schoolId ?? data.classes[index].schoolId
      if (!teacherIds.every((item) => data.teachers.some((teacher) => teacher.id === item && teacher.schoolId === schoolId))) {
        throw new BadRequestException('Todos os professores da turma precisam pertencer a escola selecionada.')
      }
      updated = { ...data.classes[index], ...payload, id, teacherId, teacherIds }
      data.classes[index] = updated
      this.pushAudit(data, actorId, 'Atualizou turma', updated.name)
    })
    return updated!
  }

  createTeacher(actorId: string, payload: Partial<Teacher> & { classId?: string; password?: string; phone?: string }) {
    this.ensureRequired(payload, ['name', 'email', 'schoolId', 'specialty', 'password'])
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
    let updated: Teacher | null = null

    this.database.update((data) => {
      const index = data.teachers.findIndex((teacher) => teacher.id === id)
      if (index < 0) throw new NotFoundException('Professor nao encontrado.')

      const schoolId = payload.schoolId ?? data.teachers[index].schoolId
      this.ensureSchoolExists(data, schoolId)
      updated = { ...data.teachers[index], ...payload, id, schoolId, email: (payload.email ?? data.teachers[index].email).trim().toLowerCase() }
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
    const studentId = randomUUID()
    const userId = randomUUID()
    let student: Student | null = null

    this.database.update((data) => {
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
        status: payload.status ?? 'matriculado',
        attendanceRate: payload.attendanceRate ?? 100,
        averageScore: payload.averageScore ?? 0,
        desempenho: payload.desempenho ?? 'Otimo',
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
    let updated: Student | null = null

    this.database.update((data) => {
      const index = data.students.findIndex((student) => student.id === id)
      if (index < 0) throw new NotFoundException('Aluno nao encontrado.')

      const schoolId = payload.schoolId ?? data.students[index].schoolId
      this.ensureSchoolExists(data, schoolId)
      const classId = payload.classId ?? data.students[index].classId
      this.getClassRoomForSchool(data.classes, classId, schoolId)
      const guardianIds = payload.guardianIds ?? data.students[index].guardianIds
      this.ensureGuardiansBelongToSchool(data, guardianIds, schoolId)

      updated = { ...data.students[index], ...payload, id, schoolId, classId, guardianIds }
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
    const guardianId = randomUUID()
    const userId = randomUUID()
    const studentIds = payload.studentIds ?? []
    let guardian: Guardian | null = null

    this.database.update((data) => {
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
    let updated: Guardian | null = null

    this.database.update((data) => {
      const index = data.guardians.findIndex((guardian) => guardian.id === id)
      if (index < 0) throw new NotFoundException('Responsavel nao encontrado.')

      const schoolId = payload.schoolId ?? data.guardians[index].schoolId
      const studentIds = payload.studentIds ?? data.guardians[index].studentIds
      this.ensureSchoolExists(data, schoolId)
      this.ensureStudentsBelongToSchool(data, studentIds, schoolId)

      updated = {
        ...data.guardians[index],
        ...payload,
        id,
        schoolId,
        studentIds,
        role: 'RESPONSAVEL',
        email: (payload.email ?? data.guardians[index].email).trim().toLowerCase(),
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

  createEvaluation(actorId: string, payload: Partial<Evaluation>) {
    this.ensureRequired(payload, ['title', 'classId', 'subject', 'scheduledAt'])
    const evaluation: Evaluation = {
      id: this.createId('sim'),
      title: payload.title!.trim(),
      classId: payload.classId!,
      subject: payload.subject!.trim(),
      questions: payload.questions ?? 20,
      scheduledAt: payload.scheduledAt!,
      status: payload.status ?? 'planejado',
      corrected: payload.corrected ?? 0,
      participants: payload.participants ?? 0,
      averageScore: payload.averageScore ?? 0,
      triLevel: payload.triLevel ?? 'Aguardando aplicacao',
      buildMode: payload.buildMode,
      questionIds: Array.isArray(payload.questionIds) ? payload.questionIds : [],
      skillCodes: Array.isArray(payload.skillCodes) ? payload.skillCodes : [],
      descriptorCodes: Array.isArray(payload.descriptorCodes) ? payload.descriptorCodes : [],
      sourceSummary: payload.sourceSummary,
    }
    this.database.update((data) => {
      this.ensureQuestionIdsExist(data, evaluation.questionIds ?? [])
      data.evaluations.unshift(evaluation)
      this.pushAudit(data, actorId, 'Criou prova', evaluation.title)
    })
    return evaluation
  }

  deleteEvaluation(actorId: string, id: string) {
    this.database.update((data) => {
      const index = data.evaluations.findIndex((evaluation) => evaluation.id === id)
      if (index < 0) throw new NotFoundException('Prova nao encontrada.')

      const [removed] = data.evaluations.splice(index, 1)
      this.pushAudit(data, actorId, 'Removeu prova', removed.title)
    })

    return { success: true }
  }

  createQuestion(actorId: string, payload: CreateQuestionRequest & { status?: QuestionStatus }) {
    this.ensureRequired(payload, ['title', 'statement', 'gradeLevel', 'area', 'component', 'subject', 'difficulty', 'sourceType', 'sourceName', 'visibility'])

    const requestedStatus = payload.status ?? this.normalizeQuestionStatus(payload.metadata?.requestedStatus, 'DRAFT')
    const questionId = this.createId('question')
    let created: Question | null = null

    this.database.update((data) => {
      const actor = this.ensureCurrentUser(data, actorId)
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
      if (!descriptors.length) throw new BadRequestException('Informe pelo menos um descritor.')

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
        sourceType: this.normalizeQuestionSourceType(payload.sourceType),
        sourceName: String(payload.sourceName).trim(),
        sourceYear: payload.sourceYear ? Number(payload.sourceYear) : new Date().getFullYear(),
        sourceExternalId: payload.sourceExternalId ? String(payload.sourceExternalId).trim() : null,
        sourceUrl: payload.sourceUrl ? String(payload.sourceUrl).trim() : null,
        licenseNotes: payload.licenseNotes ? String(payload.licenseNotes).trim() : null,
        visibility: this.normalizeQuestionVisibility(payload.visibility),
        status: requestedStatus,
        isEditable: true,
        reviewedById: requestedStatus === 'APPROVED' ? actor.id : null,
        reviewedAt: requestedStatus === 'APPROVED' ? now : null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        metadata: { ...(payload.metadata ?? {}), requestedStatus: undefined },
        options,
        skills,
        descriptors,
        attachments: [],
        reviews: requestedStatus === 'APPROVED'
          ? [{
              id: this.createId('question-review'),
              questionId,
              reviewerId: actor.id,
              status: 'APPROVED',
              comment: 'Questao aprovada no cadastro.',
              reviewedAt: now,
            }]
          : [],
      }

      data.questions.unshift(created)
      this.pushAudit(data, actorId, 'Criou questao', created.title)
    })

    return created!
  }

  async generateEnemQuestions(actorId: string, payload: GenerateEnemQuestionsRequest): Promise<GenerateEnemQuestionsResponse> {
    const requestedQuantity = this.normalizeQuestionQuantity(payload.quantity)
    const years = this.normalizeEnemYears(payload.years)
    const disciplineFilter = this.normalizeEnemDisciplineFilter(payload.discipline ?? payload.subject)

    this.ensureCurrentUser(this.database.read(), actorId)

    const currentData = this.database.read()
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
      throw new BadRequestException('Nenhuma questao do ENEM foi encontrada para os filtros informados.')
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

  listCalendarEvents() {
    return this.database.read().calendarEvents
  }

  createCalendarEvent(actorId: string, payload: Partial<SchoolCalendarEvent>) {
    this.ensureRequired(payload, ['title', 'type', 'schoolId', 'startsAt', 'endsAt'])
    let calendarEvent: SchoolCalendarEvent | null = null

    this.database.update((data) => {
      calendarEvent = this.buildCalendarEvent(data, payload)
      data.calendarEvents.unshift(calendarEvent)
      this.pushAudit(data, actorId, 'Criou evento no calendario', calendarEvent.title)
    })

    return calendarEvent!
  }

  updateCalendarEvent(actorId: string, id: string, payload: Partial<SchoolCalendarEvent>) {
    let updated: SchoolCalendarEvent | null = null

    this.database.update((data) => {
      const index = data.calendarEvents.findIndex((event) => event.id === id)
      if (index < 0) throw new NotFoundException('Evento de calendario nao encontrado.')

      updated = this.buildCalendarEvent(data, { ...data.calendarEvents[index], ...payload, id }, id)
      data.calendarEvents[index] = updated
      this.pushAudit(data, actorId, 'Atualizou evento no calendario', updated.title)
    })

    return updated!
  }

  deleteCalendarEvent(actorId: string, id: string) {
    this.database.update((data) => {
      const index = data.calendarEvents.findIndex((event) => event.id === id)
      if (index < 0) throw new NotFoundException('Evento de calendario nao encontrado.')

      const [removed] = data.calendarEvents.splice(index, 1)
      this.pushAudit(data, actorId, 'Removeu evento do calendario', removed.title)
    })

    return { success: true }
  }

  updateRole(actorId: string, id: string, payload: Partial<Role>) {
    let updated: Role | null = null
    this.database.update((data) => {
      const index = data.roles.findIndex((role) => role.id === id)
      if (index < 0) throw new NotFoundException('Cargo nao encontrado.')
      updated = { ...data.roles[index], ...payload, id }
      data.roles[index] = updated
      this.pushAudit(data, actorId, 'Atualizou permissoes do cargo', updated.name)
    })
    return updated!
  }

  updateUserRole(actorId: string, id: string, roleId: string) {
    let updated: UserAccount | null = null
    this.database.update((data) => {
      if (!data.roles.some((role) => role.id === roleId)) throw new BadRequestException('Cargo informado nao existe.')
      const index = data.users.findIndex((user) => user.id === id)
      if (index < 0) throw new NotFoundException('Usuario nao encontrado.')
      updated = { ...data.users[index], roleId }
      data.users[index] = updated
      this.pushAudit(data, actorId, 'Alterou cargo do usuario', updated.name)
    })
    return this.toPublicUser(updated!)
  }

  updateProfile(actorId: string, payload: Partial<UserAccount>) {
    let updated: UserAccount | null = null
    this.database.update((data) => {
      const index = data.users.findIndex((user) => user.id === actorId)
      if (index < 0) throw new NotFoundException('Usuario nao encontrado.')
      const current = data.users[index]
      const profile = this.normalizeProfilePayload(payload, current, data.users)
      updated = {
        ...current,
        ...profile,
        avatarUrl: payload.avatarUrl ?? current.avatarUrl,
        bannerUrl: payload.bannerUrl ?? current.bannerUrl,
      }
      data.users[index] = updated
      this.syncLinkedProfile(data, current, updated)
      this.pushAudit(data, actorId, 'Atualizou o proprio perfil', updated.name)
    })
    return this.toPublicUser(updated!)
  }

  updateProfileAvatar(actorId: string, file: ProfileImageFile) {
    const current = this.getUserById(actorId)
    const avatarUrl = this.saveProfileImageFile(actorId, file, 'avatars')
    this.deleteProfileImageFile(current.avatarUrl)
    return this.updateProfile(actorId, { avatarUrl })
  }

  updateProfileBanner(actorId: string, file: ProfileImageFile) {
    const current = this.getUserById(actorId)
    const bannerUrl = this.saveProfileImageFile(actorId, file, 'banners')
    this.deleteProfileImageFile(current.bannerUrl)
    return this.updateProfile(actorId, { bannerUrl })
  }

  deleteProfileAvatar(actorId: string) {
    const current = this.getUserById(actorId)
    this.deleteProfileImageFile(current.avatarUrl)
    return this.updateProfile(actorId, { avatarUrl: '' })
  }

  deleteProfileBanner(actorId: string) {
    const current = this.getUserById(actorId)
    this.deleteProfileImageFile(current.bannerUrl)
    return this.updateProfile(actorId, { bannerUrl: '' })
  }

  private buildDashboard(data: DatabaseShape = this.database.read()) {
    const activeStudents = data.students.filter((student) => student.status === 'matriculado')
    const avgAttendance = this.average(activeStudents.map((student) => student.attendanceRate))
    const avgScore = this.average(activeStudents.map((student) => student.averageScore))
    const highRisk = activeStudents.filter((student) => student.desempenho === 'Baixo')

    return {
      metrics: [
        { id: 'schools', label: 'Escolas', value: String(data.schools.length), detail: 'Unidades ativas na rede', tone: 'blue' as const },
        { id: 'classes', label: 'Turmas', value: String(data.classes.length), detail: 'Turmas em acompanhamento', tone: 'green' as const },
        { id: 'attendance', label: 'Frequencia media', value: `${avgAttendance.toFixed(0)}%`, detail: 'Baseada nos alunos matriculados', tone: 'amber' as const },
        { id: 'risk', label: 'Risco alto', value: String(highRisk.length), detail: 'Alunos exigindo intervencao', tone: 'rose' as const },
      ],
      attendanceByClass: data.classes.map((classRoom) => {
        const students = activeStudents.filter((student) => student.classId === classRoom.id)
        return { className: classRoom.name, frequencia: Math.round(this.average(students.map((student) => student.attendanceRate))), media: Number(this.average(students.map((student) => student.averageScore)).toFixed(1)) }
      }),
      proficiencyDistribution: [
        { level: 'Abaixo do basico', alunos: activeStudents.filter((student) => student.averageScore < 6).length },
        { level: 'Basico', alunos: activeStudents.filter((student) => student.averageScore >= 6 && student.averageScore < 7.5).length },
        { level: 'Adequado', alunos: activeStudents.filter((student) => student.averageScore >= 7.5 && student.averageScore < 9).length },
        { level: 'Avancado', alunos: activeStudents.filter((student) => student.averageScore >= 9).length },
      ],
      subjectRadar: [
        { subject: 'Portugues', acertos: 72 },
        { subject: 'Matematica', acertos: 64 },
        { subject: 'Ciencias', acertos: 78 },
        { subject: 'Humanas', acertos: 69 },
      ],
      alerts: highRisk.map((student) => ({ id: `alert-${student.id}`, title: `${student.name} em risco pedagogico`, description: `Frequencia ${student.attendanceRate}% e media ${student.averageScore.toFixed(1)}. Recomenda-se intervencao da coordenacao.`, tone: 'danger' as const })),
    }
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

  private normalizeMealUnit(value: unknown): 'KG' | 'UN' | 'L' {
    const unit = String(value ?? '').trim().toUpperCase()
    if (unit === 'UN' || unit === 'L' || unit === 'KG') return unit
    throw new BadRequestException('Unidade de medida da merenda invalida.')
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

  private async issueAccessToken(user: UserAccount) {
    const expiresIn = this.accessTokenTtlSeconds
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
    const payload: JwtPayload = { sub: user.id, email: user.email, typ: 'access' }

    return {
      token: await this.jwtService.signAsync(payload),
      expiresIn,
      expiresAt,
    }
  }

  private createRefreshSession(userId: string, context: AuthContext, rotatedFromId?: string) {
    const token = randomBytes(64).toString('base64url')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + this.refreshTokenTtlDays * 24 * 60 * 60 * 1000)
    const session: RefreshSession = {
      id: randomUUID(),
      userId,
      tokenHash: this.hashRefreshToken(token),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      rotatedFromId,
      userAgent: context.userAgent?.slice(0, 240),
      ip: context.ip?.slice(0, 80),
    }

    return { token, session }
  }

  private removeExpiredRefreshSessions(data: { refreshSessions: RefreshSession[] }) {
    const now = Date.now()
    data.refreshSessions = data.refreshSessions.filter((session) => {
      if (new Date(session.expiresAt).getTime() <= now) return false
      if (!session.revokedAt) return true

      const revokedAt = new Date(session.revokedAt).getTime()
      return Number.isFinite(revokedAt) && now - revokedAt <= this.refreshReuseGraceMs
    })
  }

  private isRecentRefreshReuse(session: RefreshSession, context: AuthContext) {
    if (!session.revokedAt) return false

    const revokedAt = new Date(session.revokedAt).getTime()
    if (!Number.isFinite(revokedAt)) return false
    if (Date.now() - revokedAt > this.refreshReuseGraceMs) return false

    if (session.userAgent && context.userAgent && session.userAgent !== context.userAgent.slice(0, 240)) return false
    return true
  }

  private hashRefreshToken(token: string) {
    return createHash('sha256').update(token).digest('hex')
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
    return parseDurationSeconds(this.configService.get<string>('JWT_ACCESS_EXPIRES_IN'), 30 * 60)
  }

  private get refreshTokenTtlDays() {
    const days = Number(this.configService.get<string>('REFRESH_TOKEN_DAYS') ?? 7)
    return Number.isFinite(days) && days > 0 ? days : 7
  }

  private get refreshReuseGraceMs() {
    const seconds = Number(this.configService.get<string>('REFRESH_TOKEN_REUSE_GRACE_SECONDS') ?? defaultRefreshReuseGraceSeconds)
    return (Number.isFinite(seconds) && seconds >= 0 ? seconds : defaultRefreshReuseGraceSeconds) * 1000
  }

  private ensureCurrentUser(data: { users: UserAccount[] }, userId: string) {
    const currentUser = data.users.find((user) => user.id === userId)
    if (!currentUser) throw new UnauthorizedException('Usuario nao encontrado.')
    return currentUser
  }

  private ensureRole(data: { users: UserAccount[]; roles: Role[] }, userId: string, code: RoleCode) {
    const currentUser = this.ensureCurrentUser(data, userId)
    const role = data.roles.find((item) => item.id === currentUser.roleId)
    if (role?.code !== code && role?.name !== code) {
      throw new ForbiddenException('Apenas administradores podem registrar compras da merenda.')
    }
    return currentUser
  }

  private buildCalendarEvent(data: { schools: School[]; classes: ClassRoom[] }, payload: Partial<SchoolCalendarEvent>, id: string = this.createId('cal')): SchoolCalendarEvent {
    const allDay = payload.allDay ?? false
    const type = this.normalizeCalendarType(payload.type)
    const schoolId = String(payload.schoolId ?? '').trim()
    const classId = payload.classId ? String(payload.classId).trim() : null
    const startsAt = this.normalizeCalendarDateValue(payload.startsAt, allDay)
    const endsAt = this.normalizeCalendarDateValue(payload.endsAt, allDay)

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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new BadRequestException(`Nao foi possivel buscar questoes do ENEM em ${url}.`)
      return await response.json() as T
    } finally {
      clearTimeout(timeout)
    }
  }

  private async fetchImageWithTimeout(url: string): Promise<DownloadedQuestionImage | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetch(url, {
        headers: { Accept: 'image/*' },
        signal: controller.signal,
      })
      if (!response.ok) return null

      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const mimeType = this.normalizeImageMimeType(response.headers.get('content-type'), url)
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

  private normalizeImageMimeType(contentType: string | null, url: string) {
    const mimeType = String(contentType ?? '').split(';')[0].trim().toLowerCase()
    if (mimeType.startsWith('image/')) return mimeType

    const path = url.split('?')[0].toLowerCase()
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
    if (path.endsWith('.webp')) return 'image/webp'
    if (path.endsWith('.gif')) return 'image/gif'
    if (path.endsWith('.svg')) return 'image/svg+xml'
    return 'image/png'
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
    if (!Number.isInteger(year) || !Number.isInteger(index)) throw new BadRequestException('Questao ENEM sem ano ou indice valido.')

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
      altText: files.includes(fileUrl) ? `Imagem de apoio da questao ${index} do ENEM ${year}` : `Imagem de alternativa da questao ${index} do ENEM ${year}`,
      order: fileIndex + 1,
      metadata: { source: 'enem.dev' },
      createdAt: now,
    }))

    return {
      id: questionId,
      schoolId: 'global-school',
      networkId: 'global-network',
      createdById: actorId,
      title: String(apiQuestion.title ?? `Questao ${index} - ENEM ${year}`).trim(),
      context: String(apiQuestion.context ?? '').trim(),
      statement: String(apiQuestion.alternativesIntroduction ?? apiQuestion.title ?? `Questao ${index} - ENEM ${year}`).trim(),
      explanation: correctAlternative ? `Gabarito informado pela API ENEM: alternativa ${correctAlternative}.` : '',
      type: 'MULTIPLE_CHOICE',
      stage: 'MEDIO',
      gradeLevel: 'Ensino Medio',
      area: discipline.area,
      component: discipline.component,
      subject: discipline.subject,
      difficulty: 'MEDIUM',
      sourceType: 'INEP_ENEM',
      sourceName: 'ENEM via API enem.dev',
      sourceYear: year,
      sourceExternalId,
      sourceUrl: `${enemApiBaseUrl}/${year}/questions`,
      licenseNotes: 'Questao importada da API publica enem.dev para uso no banco de questoes.',
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
        comment: 'Questao importada automaticamente da API ENEM.',
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
      recommendedAction: 'Buscar questoes por ano em https://api.enem.dev/v1/exams/{ano}/questions, persistir no banco com sourceYear, sourceExternalId, disciplina, numero da questao, arquivos e gabarito.',
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
    if (invalidQuestionId) throw new BadRequestException('A prova contem questao inexistente no banco.')
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
    throw new BadRequestException('Tipo de questao invalido.')
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
    throw new BadRequestException('Fonte da questao invalida.')
  }

  private normalizeQuestionVisibility(value: unknown): QuestionVisibility {
    const visibility = String(value ?? '').trim().toUpperCase()
    if (visibility === 'PRIVATE' || visibility === 'SCHOOL' || visibility === 'NETWORK' || visibility === 'GLOBAL') return visibility
    throw new BadRequestException('Visibilidade da questao invalida.')
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
      }
    }

    if (previous.linkedGuardianId) {
      const guardian = data.guardians.find((item) => item.id === previous.linkedGuardianId)
      if (guardian) {
        guardian.name = updated.name
        guardian.email = updated.email
        guardian.phone = updated.phone
      }
    }

    if (previous.linkedStudentId) {
      const student = data.students.find((item) => item.id === previous.linkedStudentId)
      if (student) student.name = updated.name
    }
  }

  private saveProfileImageFile(actorId: string, file: ProfileImageFile, folder: 'avatars' | 'banners') {
    if (!file.mimetype.startsWith('image/')) throw new BadRequestException('Envie uma imagem valida para o perfil.')

    const extensionFromMime = file.mimetype.split('/')[1]?.replace('jpeg', 'jpg')
    const extensionFromName = extname(file.originalname).replace(/^\./, '').toLowerCase()
    const extension = (extensionFromMime || extensionFromName || 'jpg').replace(/[^a-z0-9]/g, '')
    const uploadsDir = join(process.cwd(), 'uploads', folder)
    const fileName = `${actorId}-${randomUUID()}.${extension}`

    mkdirSync(uploadsDir, { recursive: true })
    writeFileSync(join(uploadsDir, fileName), file.buffer)

    return `/uploads/${folder}/${fileName}`
  }

  private deleteProfileImageFile(fileUrl?: string) {
    const cleanUrl = String(fileUrl ?? '').split(/[?#]/)[0]
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

  private average(values: number[]) {
    if (!values.length) return 0
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  private createId(_prefix: string) {
    return randomUUID()
  }

  private toPublicUser(user: UserAccount): PublicUserAccount {
    const { password: _password, ...publicUser } = user
    return publicUser
  }
}
