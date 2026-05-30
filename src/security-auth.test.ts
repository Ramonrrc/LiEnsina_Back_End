import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JwtService } from '@nestjs/jwt'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'

import { AuthGuard } from './auth.guard'
import { DatabaseService } from './database.service'
import { validateAppEnv } from './env.validation'
import { LiensinaService } from './liensina.service'
import { CreateLessonRecordDto, CreateMealItemDto, CreateMealManagementDto, CreateQuestionDto, CreateTeacherDto, GenerateQuestionSelectionDto, QuestionBankPageQueryDto, UpdateStudentDto } from './resource-query.dto'
import type { DatabaseShape, RoleCode } from './liensina.types'

class MemoryDatabase {
  constructor(private data: DatabaseShape) {}

  read(): DatabaseShape {
    return structuredClone(this.data)
  }

  update(mutator: (data: DatabaseShape) => void): DatabaseShape {
    mutator(this.data)
    return this.read()
  }

  async updateCommitted(mutator: (data: DatabaseShape) => void): Promise<DatabaseShape> {
    return this.update(mutator)
  }

  async reserveIdempotencyRecord(): Promise<{ state: 'started' }> {
    return { state: 'started' }
  }

  async completeIdempotencyRecord() {}

  async failIdempotencyRecord() {}
}

class MemoryConfig {
  constructor(private readonly values: Record<string, string>) {}

  get<T = string>(key: string): T | undefined {
    return this.values[key] as T | undefined
  }

  getOrThrow<T = string>(key: string): T {
    const value = this.values[key]
    if (!value) throw new Error(`${key} missing`)
    return value as T
  }
}

const strongAccessSecret = 'AccessSecret_64_chars_minimum_for_tests_1234567890_ABCDEFGHIJKLMNOPQRSTUVWXYZ!'
const strongRefreshSecret = 'RefreshSecret_64_chars_minimum_for_tests_1234567890_ABCDEFGHIJKLMNOPQRSTUVWXYZ!'

function role(code: RoleCode) {
  return { id: code, code, name: code, description: code, permissions: [] }
}

function makeDatabase(): DatabaseShape {
  return {
    roles: ['SUPERADMIN', 'ADMIN', 'DIRETOR', 'COORDENADOR', 'PROFESSOR', 'ALUNO', 'RESPONSAVEL', 'NUTRITIONIST'].map((code) => role(code as RoleCode)),
    users: [
      { id: 'admin-user', name: 'Admin', email: 'admin@local.test', login: 'admin@local.test', password: 'StrongPass123!', roleId: 'SUPERADMIN', schoolId: null, status: 'ativo', phone: '' },
      { id: 'other-user', name: 'Other', email: 'other@local.test', login: 'other@local.test', password: 'StrongPass123!', roleId: 'ALUNO', schoolId: null, status: 'ativo', phone: '' },
    ],
    refreshSessions: [],
    idempotencyRecords: [],
    notifications: [],
    schools: [],
    teachers: [],
    guardians: [],
    students: [],
    classes: [],
    evaluations: [],
    answerCards: [],
    evaluationCorrections: [],
    curriculumBases: [],
    curriculumSkills: [],
    assessmentPrograms: [],
    assessmentMatrices: [],
    assessmentDescriptors: [],
    questions: [],
    questionImportPlans: [],
    lessonRecords: [],
    roomReservations: [],
    calendarEvents: [],
    mealFoods: [],
    mealManagements: [],
    mealFoodRequests: [],
    mealRequestHistory: [],
    auditEvents: [],
  }
}

function service(database = new MemoryDatabase(makeDatabase())) {
  const config = new MemoryConfig({
    JWT_ACCESS_SECRET: strongAccessSecret,
    JWT_REFRESH_SECRET: strongRefreshSecret,
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_ISSUER: 'liensina-api',
    JWT_AUDIENCE: 'liensina-web',
    REFRESH_TOKEN_DAYS: '7',
  })
  return {
    config,
    database,
    liensina: new LiensinaService(database as never, new JwtService(), config as never),
  }
}

function validationMessages(dto: new () => object, payload: unknown) {
  const instance = plainToInstance(dto, payload)
  return validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  }).flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...((error.children ?? []).flatMap((child) => [
      ...Object.values(child.constraints ?? {}),
      ...((child.children ?? []).flatMap((grandChild) => Object.values(grandChild.constraints ?? {}))),
    ])),
  ])
}

type TenantIntegrityHarness = {
  buildTenantLookup(data: DatabaseShape): unknown
  assertTenantIntegrity(data: DatabaseShape, lookup: unknown): void
}

describe('Security env validation', () => {
  it('recusa secrets iguais ou fracos', () => {
    assert.throws(() => validateAppEnv({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: strongAccessSecret,
      JWT_REFRESH_SECRET: strongAccessSecret,
      AUTH_COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://app.example.test',
      POSTGRES_PASSWORD: 'StrongPostgresPassword_123456!',
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: 'postgresql://liensina@db.example.test:5432/liensina',
      RATE_LIMIT_REDIS_URL: 'redis://:StrongRedisPassword_123456!@redis.example.test:6379/0',
      OMR_INTERNAL_TOKEN: strongRefreshSecret,
    }), /devem ser diferentes/)

    assert.throws(() => validateAppEnv({
      JWT_ACCESS_SECRET: 'weak',
      JWT_REFRESH_SECRET: strongRefreshSecret,
    }), /JWT_ACCESS_SECRET/)
  })

  it('recusa producao sem PostgreSQL explicito', () => {
    assert.throws(() => validateAppEnv({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: strongAccessSecret,
      JWT_REFRESH_SECRET: strongRefreshSecret,
      AUTH_COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://app.example.test',
      POSTGRES_PASSWORD: 'StrongPostgresPassword_123456!',
      RATE_LIMIT_REDIS_URL: 'redis://:StrongRedisPassword_123456!@redis.example.test:6379/0',
      OMR_INTERNAL_TOKEN: strongRefreshSecret,
    }), /DATABASE_URL/)

    assert.throws(() => validateAppEnv({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: strongAccessSecret,
      JWT_REFRESH_SECRET: strongRefreshSecret,
      AUTH_COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://app.example.test',
      DATABASE_DRIVER: 'sqlite',
      DATABASE_URL: 'postgresql://liensina@db.example.test:5432/liensina',
      RATE_LIMIT_REDIS_URL: 'redis://:StrongRedisPassword_123456!@redis.example.test:6379/0',
      OMR_INTERNAL_TOKEN: strongRefreshSecret,
    }), /DATABASE_DRIVER/)
  })

  it('recusa producao sem rate limit distribuido ou com seeds padrao', () => {
    assert.throws(() => validateAppEnv({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: strongAccessSecret,
      JWT_REFRESH_SECRET: strongRefreshSecret,
      AUTH_COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://app.example.test',
      POSTGRES_PASSWORD: 'StrongPostgresPassword_123456!',
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: 'postgresql://liensina@db.example.test:5432/liensina',
      OMR_INTERNAL_TOKEN: strongRefreshSecret,
    }), /RATE_LIMIT_REDIS_URL/)

    assert.throws(() => validateAppEnv({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: strongAccessSecret,
      JWT_REFRESH_SECRET: strongRefreshSecret,
      AUTH_COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://app.example.test',
      POSTGRES_PASSWORD: 'StrongPostgresPassword_123456!',
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: 'postgresql://liensina@db.example.test:5432/liensina',
      RATE_LIMIT_REDIS_URL: 'redis://:StrongRedisPassword_123456!@redis.example.test:6379/0',
      OMR_INTERNAL_TOKEN: strongRefreshSecret,
      SEED_DEFAULT_ADMIN: 'true',
    }), /Seeds padrao/)
  })
})

describe('JWT refresh sessions', () => {
  it('rotaciona refresh token e bloqueia reutilizacao do token antigo', async () => {
    const { liensina } = service()
    const login = await liensina.login('admin@local.test', 'StrongPass123!')
    const refreshed = await liensina.refreshLogin(login.refreshToken)

    assert.ok(refreshed.refreshToken)
    assert.notEqual(refreshed.refreshToken, login.refreshToken)
    await assert.rejects(() => liensina.refreshLogin(login.refreshToken), /reutilizado|revogado|invalido/i)
  })

  it('logout revoga refresh token e impede novo access token', async () => {
    const { liensina } = service()
    const login = await liensina.login('admin@local.test', 'StrongPass123!')

    assert.deepEqual(liensina.logout(login.refreshToken), { success: true })
    await assert.rejects(() => liensina.refreshLogin(login.refreshToken), /revogado|invalido/i)
  })

  it('access token nao pode ser usado como refresh token', async () => {
    const { liensina } = service()
    const login = await liensina.login('admin@local.test', 'StrongPass123!')

    await assert.rejects(() => liensina.refreshLogin(login.token), /Refresh token invalido/)
  })

  it('refresh token nao pode ser usado como access token e logout invalida a sessao', async () => {
    const { config, liensina } = service()
    const jwt = new JwtService()
    const guard = new AuthGuard(jwt, liensina, config as never)
    const login = await liensina.login('admin@local.test', 'StrongPass123!')
    const accessRequest = { headers: { authorization: `Bearer ${login.token}` } }
    const refreshRequest = { headers: { authorization: `Bearer ${login.refreshToken}` } }
    const contextFor = (request: unknown) => ({
      switchToHttp: () => ({ getRequest: () => request }),
    })

    await assert.doesNotReject(() => guard.canActivate(contextFor(accessRequest) as never))
    await assert.rejects(() => guard.canActivate(contextFor(refreshRequest) as never), /Token invalido|expirado/)
    liensina.logout(login.refreshToken)
    await assert.rejects(() => guard.canActivate(contextFor(accessRequest) as never), /Token invalido|expirado/)
  })

  it('usuario bloqueado nao continua usando refresh token', async () => {
    const database = new MemoryDatabase(makeDatabase())
    const { liensina } = service(database)
    const login = await liensina.login('admin@local.test', 'StrongPass123!')
    database.update((data) => {
      data.users[0].status = 'bloqueado'
    })

    await assert.rejects(() => liensina.refreshLogin(login.refreshToken), /bloqueado|inativo/)
  })

  it('alteracao de role revoga sessoes antigas do usuario afetado', async () => {
    const database = new MemoryDatabase(makeDatabase())
    const { liensina } = service(database)
    const login = await liensina.login('other@local.test', 'StrongPass123!')

    liensina.updateUserRole('admin-user', 'other-user', 'PROFESSOR')

    await assert.rejects(() => liensina.refreshLogin(login.refreshToken), /revogado|invalido|reutilizado/i)
  })
})

describe('PostgreSQL tenant integrity', () => {
  it('permite questoes globais sem escola real sem liberar questoes escolares invalidas', () => {
    const database = new DatabaseService(new MemoryConfig({}) as never) as unknown as TenantIntegrityHarness

    const globalData = makeDatabase()
    globalData.questions.push({
      id: 'question-global',
      schoolId: 'global-school',
      visibility: 'GLOBAL',
      sourceType: 'GLOBAL_CURATED',
      createdById: 'system-liensina',
    } as never)

    assert.doesNotThrow(() => database.assertTenantIntegrity(globalData, database.buildTenantLookup(globalData)))

    const privateData = makeDatabase()
    privateData.questions.push({
      id: 'question-private',
      schoolId: 'global-school',
      visibility: 'PRIVATE',
      sourceType: 'TEACHER_CREATED',
      createdById: 'teacher-user',
    } as never)

    assert.throws(() => database.assertTenantIntegrity(privateData, database.buildTenantLookup(privateData)), /Violacao de tenant/)
  })

  it('bloqueia persistencia relacional com vinculo cruzado entre escolas', () => {
    const data = makeDatabase()
    data.schools.push(
      { id: 'school-a', name: 'Escola A', city: 'A', address: 'Rua A', director: 'Diretor A', inepCode: '111', active: true },
      { id: 'school-b', name: 'Escola B', city: 'B', address: 'Rua B', director: 'Diretor B', inepCode: '222', active: true },
    )
    data.classes.push(
      { id: 'class-a', name: 'Turma A', grade: 'EF6', shift: 'Manha', schoolId: 'school-a', teacherIds: [], academicYear: 2026, schedule: '', bnccFocus: [] } as never,
      { id: 'class-b', name: 'Turma B', grade: 'EF6', shift: 'Manha', schoolId: 'school-b', teacherIds: [], academicYear: 2026, schedule: '', bnccFocus: [] } as never,
    )
    data.students.push({
      id: 'student-b',
      name: 'Aluno B',
      login: 'student-b',
      role: 'ALUNO',
      registration: 'B1',
      registrationNumber: 'B1',
      schoolId: 'school-b',
      classId: 'class-b',
      guardianIds: [],
      status: 'matriculado',
      attendanceRate: 100,
      averageScore: 0,
      desempenho: 'Neutro',
    } as never)
    data.answerCards.push({
      id: 'card-cross-tenant',
      schoolId: 'school-a',
      classId: 'class-a',
      studentId: 'student-b',
    } as never)

    const database = new DatabaseService(new MemoryConfig({}) as never) as unknown as TenantIntegrityHarness
    const lookup = database.buildTenantLookup(data)

    assert.throws(() => database.assertTenantIntegrity(data, lookup), /Violacao de tenant/)
  })
})

describe('OMR authorization order', () => {
  it('bloqueia perfil sem permissao antes de preparar arquivo pesado', async () => {
    const database = new MemoryDatabase(makeDatabase())
    database.update((data) => {
      data.users.push({
        id: 'student-user',
        name: 'Aluno',
        email: 'student@local.test',
        login: 'student@local.test',
        password: 'StrongPass123!',
        roleId: 'ALUNO',
        schoolId: 'school-a',
        status: 'ativo',
        phone: '',
        linkedStudentId: 'student-a',
      })
    })
    const { liensina } = service(database)
    let prepareCalled = false
    ;(liensina as unknown as { prepareOmrUpload: () => Promise<never> }).prepareOmrUpload = async () => {
      prepareCalled = true
      throw new Error('prepare should not run')
    }

    await assert.rejects(
      () => liensina.processEvaluationOmrCorrection('student-user', 'exam-a', 'student-a', {
        buffer: Buffer.from('%PDF-1.7'),
        mimetype: 'application/pdf',
        originalname: 'cartao.pdf',
        size: 8,
      }),
      /perfil nao pode executar/i,
    )
    assert.equal(prepareCalled, false)
  })

  it('bloqueia lote OMR para coordenador antes de gerar cartoes ou decodificar arquivos', async () => {
    const database = new MemoryDatabase(makeDatabase())
    database.update((data) => {
      data.schools.push({ id: 'school-a', name: 'Escola A', city: 'A', address: 'Rua A', director: 'Diretor', inepCode: '111', active: true })
      data.users.push({
        id: 'coord-user',
        name: 'Coord',
        email: 'coord@local.test',
        login: 'coord@local.test',
        password: 'StrongPass123!',
        roleId: 'COORDENADOR',
        schoolId: 'school-a',
        status: 'ativo',
        phone: '',
      })
      data.users.push({
        id: 'teacher-user',
        name: 'Professor',
        email: 'teacher@local.test',
        login: 'teacher@local.test',
        password: 'StrongPass123!',
        roleId: 'PROFESSOR',
        schoolId: 'school-a',
        status: 'ativo',
        phone: '',
        linkedTeacherId: 'teacher-a',
      })
      data.teachers.push({ id: 'teacher-a', userId: 'teacher-user', name: 'Professor', email: 'teacher@local.test', schoolId: 'school-a', specialty: 'Matematica', active: true })
      data.classes.push({ id: 'class-a', name: 'Turma A', grade: 'EF6', shift: 'Manha', schoolId: 'school-a', teacherId: 'teacher-a', teacherIds: ['teacher-a'], academicYear: 2026, schedule: 'Segunda', bnccFocus: ['Matematica'] })
      data.evaluations.push({ id: 'exam-a', title: 'Prova A', schoolId: 'school-a', teacherId: 'teacher-a', createdById: 'teacher-user', classId: 'class-a', subject: 'Matematica', questions: 1, scheduledAt: '2026-05-01', status: 'planejado', corrected: 0, participants: 0, averageScore: 0, triLevel: 'A' })
    })
    const { liensina } = service(database)
    let prepareCalled = false
    let ensureCardsCalled = false
    ;(liensina as unknown as { prepareOmrUpload: () => Promise<never> }).prepareOmrUpload = async () => {
      prepareCalled = true
      throw new Error('prepare should not run')
    }
    ;(liensina as unknown as { ensureAnswerCardsForEvaluation: () => never }).ensureAnswerCardsForEvaluation = () => {
      ensureCardsCalled = true
      throw new Error('ensure cards should not run')
    }

    await assert.rejects(
      () => liensina.processEvaluationOmrBatch('coord-user', 'exam-a', [{
        buffer: Buffer.from('%PDF-1.7'),
        mimetype: 'application/pdf',
        originalname: 'lote.pdf',
        size: 8,
      }]),
      /perfil nao pode executar/i,
    )
    assert.equal(prepareCalled, false)
    assert.equal(ensureCardsCalled, false)
  })
})

describe('SSRF guard', () => {
  it('bloqueia localhost, metadata e IP privado mesmo com HTTPS', async () => {
    const { liensina } = service()
    const guard = liensina as unknown as { isAllowedRemoteQuestionImageUrl: (url: string) => Promise<boolean> }

    assert.equal(await guard.isAllowedRemoteQuestionImageUrl('https://localhost/imagem.png'), false)
    assert.equal(await guard.isAllowedRemoteQuestionImageUrl('https://169.254.169.254/latest/meta-data'), false)
    assert.equal(await guard.isAllowedRemoteQuestionImageUrl('https://10.0.0.1/imagem.png'), false)
    assert.equal(await guard.isAllowedRemoteQuestionImageUrl('https://127.0.0.1/imagem.png'), false)
  })
})

describe('DTO allowlist de rotas sensiveis', () => {
  it('bloqueia status critico em metadata de questao', () => {
    const messages = validationMessages(CreateQuestionDto, {
      title: 'Questao',
      context: '',
      statement: 'Quanto e 2+2?',
      explanation: 'Soma simples.',
      type: 'MULTIPLE_CHOICE',
      stage: 'FUNDAMENTAL',
      gradeLevel: '5',
      area: 'Matematica',
      component: 'Matematica',
      subject: 'Matematica',
      difficulty: 'EASY',
      sourceType: 'TEACHER_CREATED',
      sourceName: 'Professor',
      sourceYear: null,
      sourceExternalId: null,
      sourceUrl: null,
      licenseNotes: null,
      visibility: 'SCHOOL',
      options: [
        { label: 'A', text: '4', order: 1, isCorrect: true },
        { label: 'B', text: '5', order: 2, isCorrect: false },
      ],
      skillIds: ['skill-a'],
      descriptorIds: [],
      attachments: [],
      metadata: { requestedStatus: 'APPROVED' },
    })

    assert.ok(messages.some((message) => message.includes('requestedStatus')))
  })

  it('bloqueia status critico direto no payload de questao', () => {
    const messages = validationMessages(CreateQuestionDto, {
      title: 'Questao',
      statement: 'Quanto e 2+2?',
      type: 'MULTIPLE_CHOICE',
      stage: 'FUNDAMENTAL',
      gradeLevel: '5',
      area: 'Matematica',
      component: 'Matematica',
      subject: 'Matematica',
      difficulty: 'EASY',
      sourceType: 'TEACHER_CREATED',
      sourceName: 'Professor',
      visibility: 'SCHOOL',
      options: [
        { label: 'A', text: '4', order: 1, isCorrect: true },
        { label: 'B', text: '5', order: 2, isCorrect: false },
      ],
      skillIds: ['skill-a'],
      status: 'APPROVED',
    })

    assert.ok(messages.some((message) => message.includes('status')))
  })

  it('limita lote de alimentos no cadastro de gestao de merenda', () => {
    const messages = validationMessages(CreateMealManagementDto, {
      escolaId: 'school-a',
      mesReferencia: '2026-05',
      valorLimite: 1000,
      alimentosCadastrados: Array.from({ length: 201 }, (_, index) => ({
        nome: `Alimento ${index}`,
        categoria: 'Geral',
        unidadeMedida: 'KG',
      })),
    })

    assert.ok(messages.some((message) => message.includes('alimentosCadastrados')))
  })

  it('limita geracao/seleção de questoes para evitar abuso de custo', () => {
    const messages = validationMessages(GenerateQuestionSelectionDto, {
      quantity: 999,
      subject: 'Matematica',
      sourceMode: 'mixed',
    })

    assert.ok(messages.some((message) => message.includes('quantity')))
  })

  it('bloqueia campos extras em item de merenda', () => {
    const messages = validationMessages(CreateMealItemDto, {
      alimentoId: 1,
      quantidade: 10,
      valorUnitario: 5,
      fornecedorNome: 'Fornecedor',
      status: 'APPROVED',
    })

    assert.ok(messages.some((message) => message.includes('status')))
  })

  it('bloqueia campos administrativos no cadastro de professor', () => {
    const messages = validationMessages(CreateTeacherDto, {
      name: 'Professor',
      email: 'professor@local.test',
      schoolId: 'school-a',
      specialty: 'Matematica',
      password: 'StrongPass123!',
      roleId: 'ADMIN',
      status: 'ativo',
    })

    assert.ok(messages.some((message) => message.includes('roleId')))
    assert.ok(messages.some((message) => message.includes('status')))
  })

  it('bloqueia mass assignment de media em aluno', () => {
    const messages = validationMessages(UpdateStudentDto, {
      name: 'Aluno',
      averageScore: 10,
      createdById: 'attacker',
    })

    assert.ok(messages.some((message) => message.includes('averageScore')))
    assert.ok(messages.some((message) => message.includes('createdById')))
  })

  it('valida mapa de frequencia no registro de aula', () => {
    const messages = validationMessages(CreateLessonRecordDto, {
      classId: 'class-a',
      subject: 'Matematica',
      date: '2026-05-21',
      time: '08:00',
      content: 'Conteudo',
      plan: 'Plano',
      resources: 'Quadro',
      activity: 'Exercicios',
      attendance: {
        'student-a': true,
        'student-b': 'sim',
      },
    })

    assert.ok(messages.some((message) => message.includes('attendance')))
  })

  it('bloqueia paginação exagerada no banco de questoes', () => {
    const messages = validationMessages(QuestionBankPageQueryDto, {
      page: 1,
      limit: 999999,
      sourceMode: 'mixed',
    })

    assert.ok(messages.some((message) => message.includes('limit')))
  })
})
