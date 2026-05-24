import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { ResourceAccessService } from './resource-access.service'
import { LiensinaService } from './liensina.service'
import type { DatabaseShape, EvaluationCorrection, RoleCode } from './liensina.types'

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

  async reserveIdempotencyRecord(input: {
    scopeKey: string
    key: string
    actorId: string
    schoolId?: string | null
    operation: string
    resourceId?: string | null
    payloadHash: string
  }): Promise<{ state: 'started' } | { state: 'completed'; response: unknown } | { state: 'conflict' } | { state: 'processing' }> {
    const existing = this.data.idempotencyRecords.find((record) => record.scopeKey === input.scopeKey)
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) return { state: 'conflict' }
      if (existing.status === 'COMPLETED') return { state: 'completed', response: existing.response }
      return { state: 'processing' }
    }
    const now = new Date().toISOString()
    this.data.idempotencyRecords.push({
      id: input.scopeKey,
      scopeKey: input.scopeKey,
      key: input.key,
      actorId: input.actorId,
      schoolId: input.schoolId ?? null,
      operation: input.operation,
      resourceId: input.resourceId ?? null,
      payloadHash: input.payloadHash,
      status: 'PROCESSING',
      createdAt: now,
      updatedAt: now,
      expiresAt: '2999-01-01T00:00:00.000Z',
      lockedUntil: '2999-01-01T00:00:00.000Z',
    })
    return { state: 'started' }
  }

  async completeIdempotencyRecord(scopeKey: string, response: unknown) {
    const record = this.data.idempotencyRecords.find((item) => item.scopeKey === scopeKey)
    if (record) {
      record.status = 'COMPLETED'
      record.response = response
      record.lockedUntil = null
    }
  }

  async failIdempotencyRecord(scopeKey: string) {
    const record = this.data.idempotencyRecords.find((item) => item.scopeKey === scopeKey)
    if (record) record.status = 'FAILED'
  }
}

function role(code: RoleCode) {
  return { id: code, code, name: code, description: code, permissions: [] }
}

function correction(id: string, evaluationId: string, studentId: string, classId: string, schoolId: string): EvaluationCorrection {
  return {
    id,
    schoolId,
    evaluationId,
    classId,
    studentId,
    studentName: studentId,
    cardId: null,
    subject: 'Matematica',
    status: 'CONFIRMED',
    imageUrl: null,
    imageObject: null,
    suggestedScore: 8,
    finalScore: 8,
    correctCount: 8,
    wrongCount: 2,
    blankCount: 0,
    multipleCount: 0,
    totalQuestions: 10,
    confidence: 1,
    requiresReview: false,
    shouldRetakeImage: false,
    failures: [],
    detectedAnswers: [],
    answerKey: [],
    rawOmrResponse: {},
    teacherNotes: null,
    reviewedById: 'teacher-user-a',
    reviewedAt: '2026-05-01T00:00:00.000Z',
    createdById: 'teacher-user-a',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  }
}

function makeDatabase(): DatabaseShape {
  const roles = ['SUPERADMIN', 'ADMIN', 'ADMIN_ESCOLA', 'DIRETOR', 'COORDENADOR', 'PROFESSOR', 'ALUNO', 'RESPONSAVEL', 'NUTRITIONIST'].map((code) => role(code as RoleCode))

  return {
    roles,
    users: [
      { id: 'admin-user', name: 'Admin', email: 'admin@local', login: 'admin@local', password: 'secret', roleId: 'ADMIN', schoolId: null, status: 'ativo', phone: '' },
      { id: 'school-admin-user-a', name: 'Admin Escola A', email: 'admin.a@local', login: 'admin.a@local', password: 'secret', roleId: 'ADMIN_ESCOLA', schoolId: 'school-a', status: 'ativo', phone: '' },
      { id: 'school-admin-user-b', name: 'Admin Escola B', email: 'admin.b@local', login: 'admin.b@local', password: 'secret', roleId: 'ADMIN_ESCOLA', schoolId: 'school-b', status: 'ativo', phone: '' },
      { id: 'director-user-a', name: 'Diretor A', email: 'diretor.a@local', login: 'diretor.a@local', password: 'secret', roleId: 'DIRETOR', schoolId: 'school-a', status: 'ativo', phone: '' },
      { id: 'director-user-b', name: 'Diretor B', email: 'diretor.b@local', login: 'diretor.b@local', password: 'secret', roleId: 'DIRETOR', schoolId: 'school-b', status: 'ativo', phone: '' },
      { id: 'coord-user-a', name: 'Coord A', email: 'coord.a@local', login: 'coord.a@local', password: 'secret', roleId: 'COORDENADOR', schoolId: 'school-a', status: 'ativo', phone: '' },
      { id: 'teacher-user-a', name: 'Teacher A', email: 'teacher.a@local', login: 'teacher.a@local', password: 'secret', roleId: 'PROFESSOR', schoolId: 'school-a', status: 'ativo', phone: '', linkedTeacherId: 'teacher-a' },
      { id: 'teacher-user-b', name: 'Teacher B', email: 'teacher.b@local', login: 'teacher.b@local', password: 'secret', roleId: 'PROFESSOR', schoolId: 'school-b', status: 'ativo', phone: '', linkedTeacherId: 'teacher-b' },
      { id: 'student-user-a', name: 'Student A', email: 'student.a@local', login: 'student-a', password: 'secret', roleId: 'ALUNO', schoolId: 'school-a', status: 'ativo', phone: '', linkedStudentId: 'student-a' },
      { id: 'student-user-b', name: 'Student B', email: 'student.b@local', login: 'student-b', password: 'secret', roleId: 'ALUNO', schoolId: 'school-b', status: 'ativo', phone: '', linkedStudentId: 'student-b' },
      { id: 'guardian-user-a', name: 'Guardian A', email: 'guardian.a@local', login: 'guardian.a@local', password: 'secret', roleId: 'RESPONSAVEL', schoolId: 'school-a', status: 'ativo', phone: '', linkedGuardianId: 'guardian-a' },
      { id: 'guardian-user-b', name: 'Guardian B', email: 'guardian.b@local', login: 'guardian.b@local', password: 'secret', roleId: 'RESPONSAVEL', schoolId: 'school-b', status: 'ativo', phone: '', linkedGuardianId: 'guardian-b' },
    ],
    refreshSessions: [],
    idempotencyRecords: [],
    notifications: [],
    schools: [
      { id: 'school-a', name: 'Escola A', city: 'A', address: 'Rua A', director: 'Diretor A', inepCode: '111', active: true },
      { id: 'school-b', name: 'Escola B', city: 'B', address: 'Rua B', director: 'Diretor B', inepCode: '222', active: true },
    ],
    teachers: [
      { id: 'teacher-a', userId: 'teacher-user-a', name: 'Teacher A', email: 'teacher.a@local', schoolId: 'school-a', specialty: 'Matematica', active: true },
      { id: 'teacher-b', userId: 'teacher-user-b', name: 'Teacher B', email: 'teacher.b@local', schoolId: 'school-b', specialty: 'Historia', active: true },
    ],
    guardians: [
      { id: 'guardian-a', userId: 'guardian-user-a', name: 'Guardian A', email: 'guardian.a@local', role: 'RESPONSAVEL', schoolId: 'school-a', phone: '', studentIds: ['student-a'] },
      { id: 'guardian-b', userId: 'guardian-user-b', name: 'Guardian B', email: 'guardian.b@local', role: 'RESPONSAVEL', schoolId: 'school-b', phone: '', studentIds: ['student-b'] },
    ],
    students: [
      { id: 'student-a', userId: 'student-user-a', name: 'Student A', login: 'student-a', role: 'ALUNO', registration: 'A1', registrationNumber: 'A1', schoolId: 'school-a', classId: 'class-a', guardianIds: ['guardian-a'], status: 'matriculado', attendanceRate: 95, averageScore: 8, desempenho: 'Otimo' },
      { id: 'student-b', userId: 'student-user-b', name: 'Student B', login: 'student-b', role: 'ALUNO', registration: 'B1', registrationNumber: 'B1', schoolId: 'school-b', classId: 'class-b', guardianIds: ['guardian-b'], status: 'matriculado', attendanceRate: 70, averageScore: 5, desempenho: 'Baixo' },
    ],
    classes: [
      { id: 'class-a', name: 'Turma A', grade: 'EF6', shift: 'Manha', schoolId: 'school-a', teacherId: 'teacher-a', teacherIds: ['teacher-a'], academicYear: 2026, schedule: 'Segunda', bnccFocus: ['Matematica'] },
      { id: 'class-b', name: 'Turma B', grade: 'EF6', shift: 'Manha', schoolId: 'school-b', teacherId: 'teacher-b', teacherIds: ['teacher-b'], academicYear: 2026, schedule: 'Terca', bnccFocus: ['Historia'] },
    ],
    evaluations: [
      { id: 'exam-a', title: 'Prova A', schoolId: 'school-a', teacherId: 'teacher-a', createdById: 'teacher-user-a', classId: 'class-a', subject: 'Matematica', questions: 10, scheduledAt: '2026-05-01', status: 'planejado', corrected: 1, participants: 1, averageScore: 8, triLevel: 'A' },
      { id: 'exam-b', title: 'Prova B', schoolId: 'school-b', teacherId: 'teacher-b', createdById: 'teacher-user-b', classId: 'class-b', subject: 'Historia', questions: 10, scheduledAt: '2026-05-01', status: 'planejado', corrected: 1, participants: 1, averageScore: 5, triLevel: 'B' },
    ],
    answerCards: [],
    evaluationCorrections: [
      correction('grade-a', 'exam-a', 'student-a', 'class-a', 'school-a'),
      correction('grade-b', 'exam-b', 'student-b', 'class-b', 'school-b'),
    ],
    curriculumBases: [],
    curriculumSkills: [],
    assessmentPrograms: [],
    assessmentMatrices: [],
    assessmentDescriptors: [],
    questions: [],
    questionImportPlans: [],
    lessonRecords: [
      { id: 'lesson-a', classId: 'class-a', subject: 'Matematica', date: '2026-05-01', time: '08:00', content: 'Frações', plan: 'Plano', resources: 'Quadro', activity: 'Lista', notes: '', attendance: { 'student-a': true } },
      { id: 'lesson-b', classId: 'class-b', subject: 'Historia', date: '2026-05-01', time: '08:00', content: 'Brasil', plan: 'Plano', resources: 'Livro', activity: 'Resumo', notes: '', attendance: { 'student-b': false } },
    ],
    roomReservations: [],
    calendarEvents: [],
    mealFoods: [],
    mealManagements: [],
    mealFoodRequests: [],
    mealRequestHistory: [],
    auditEvents: [],
  }
}

function services() {
  const database = new MemoryDatabase(makeDatabase())
  const access = new ResourceAccessService(database as never)
  const liensina = new LiensinaService(database as never, {} as never, { get: () => undefined } as never)
  return { access, liensina }
}

describe('ResourceAccessService RBAC/ABAC', () => {
  it('diretor ve somente alunos, professores e provas da propria escola', () => {
    const { access } = services()

    assert.deepEqual(access.listStudents('director-user-a').students.map((student) => student.id), ['student-a'])
    assert.deepEqual(access.listTeachers('director-user-a').teachers.map((teacher) => teacher.id), ['teacher-a'])
    assert.deepEqual(access.listExams('director-user-a').exams.map((exam) => exam.id), ['exam-a'])
    assert.throws(() => access.getStudent('director-user-a', 'student-b'), /Sem permissao|nao encontrado/)
  })

  it('coordenador ve metricas da propria escola, mas nao edita aluno nem gera prova', async () => {
    const { access, liensina } = services()

    const metrics = access.getPedagogicalMetrics('coord-user-a')
    assert.equal(metrics.totals.students, 1)
    assert.equal(metrics.metrics[0].schoolId, 'school-a')
    assert.throws(() => liensina.updateStudent('coord-user-a', 'student-a', { name: 'Outro nome' }), /permissao/)
    await assert.rejects(() => liensina.createEvaluation('coord-user-a', { title: 'Nova', classId: 'class-a', subject: 'Matematica', scheduledAt: '2026-05-20' }), /criar provas/)
  })

  it('professor ve somente turmas e disciplinas vinculadas e nao acessa correcao de outra turma', () => {
    const { access } = services()

    assert.deepEqual(access.listClasses('teacher-user-a').classes.map((classRoom) => classRoom.id), ['class-a'])
    assert.deepEqual(access.listSubjects('teacher-user-a').subjects.map((subject) => subject.code), ['MATEMATICA'])
    assert.throws(() => access.getExamCorrection('teacher-user-a', 'grade-b'), /Correcao nao encontrada/)
  })

  it('endpoint de minhas materias prioriza materias com turmas vinculadas', () => {
    const { liensina } = services()

    const page = liensina.listTeacherSubjectCardsPage('teacher-user-a', 1, 6)

    assert.ok(page.subjectCards.length > 1)
    assert.match(page.subjectCards[0].subject, /matem/i)
    assert.deepEqual(page.subjectCards[0].classes.map((classRoom) => classRoom.id), ['class-a'])
  })

  it('professor gera prova apenas para turma/disciplina vinculada', async () => {
    const { liensina } = services()

    const created = await liensina.createEvaluation('teacher-user-a', { title: 'Prova autorizada', classId: 'class-a', subject: 'Matematica', scheduledAt: '2026-05-20' })
    assert.equal(created.evaluation.classId, 'class-a')
    await assert.rejects(() => liensina.createEvaluation('teacher-user-a', { title: 'Prova proibida', classId: 'class-b', subject: 'Historia', scheduledAt: '2026-05-20' }), /permissao|escola/)
  })

  it('professor cria evento para escola vinculada e opcionalmente para turma vinculada', () => {
    const { liensina } = services()

    const schoolEvent = liensina.createCalendarEvent('teacher-user-a', {
      title: 'Evento escolar',
      type: 'evento',
      schoolId: 'school-a',
      startsAt: '2026-05-20T08:00',
      endsAt: '2026-05-20T09:00',
      allDay: false,
    })
    const classEvent = liensina.createCalendarEvent('teacher-user-a', {
      title: 'Aula especial',
      type: 'evento',
      schoolId: 'school-a',
      classId: 'class-a',
      startsAt: '2026-05-21T08:00',
      endsAt: '2026-05-21T09:00',
      allDay: false,
    })

    assert.equal(schoolEvent.classId, null)
    assert.equal(classEvent.classId, 'class-a')
    assert.throws(() => liensina.createCalendarEvent('teacher-user-a', {
      title: 'Evento em outra turma',
      type: 'evento',
      schoolId: 'school-b',
      classId: 'class-b',
      startsAt: '2026-05-20T08:00',
      endsAt: '2026-05-20T09:00',
      allDay: false,
    }), /escola|turma/)
  })

  it('aluno ve apenas suas proprias notas e frequencia e nao edita dados academicos', () => {
    const { access, liensina } = services()

    assert.deepEqual(access.listGrades('student-user-a').grades.map((grade) => grade.studentId), ['student-a'])
    assert.deepEqual(access.listAttendance('student-user-a').attendance.map((row) => row.studentId), ['student-a'])
    assert.throws(() => access.getStudent('student-user-a', 'student-b'), /Sem permissao|nao encontrado/)
    assert.throws(() => liensina.updateStudent('student-user-a', 'student-a', { name: 'Outro nome' }), /permissao/)
  })

  it('campos sem permissao sao omitidos do JSON em vez de mascarados vazios', () => {
    const { access, liensina } = services()

    const studentsPayload = JSON.parse(JSON.stringify(access.listStudents('teacher-user-a')))
    const student = studentsPayload.students[0]
    assert.equal(Object.prototype.hasOwnProperty.call(student, 'login'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(student, 'registrationNumber'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(student, 'guardianIds'), false)

    const correctionsPayload = JSON.parse(JSON.stringify(access.listExamCorrections('student-user-a')))
    const correction = correctionsPayload.examCorrections[0]
    assert.equal(Object.prototype.hasOwnProperty.call(correction, 'imageUrl'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(correction, 'rawOmrResponse'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(correction, 'detectedAnswers'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(correction, 'answerKey'), false)

    const studentLessonPayload = JSON.parse(JSON.stringify(access.listLessonRecords('student-user-a')))
    const studentLesson = studentLessonPayload.lessonRecords[0]
    assert.equal(Object.prototype.hasOwnProperty.call(studentLesson, 'content'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(studentLesson, 'plan'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(studentLesson, 'resources'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(studentLesson, 'activity'), false)
    assert.deepEqual(Object.keys(studentLesson.attendance), ['student-a'])

    const coordinatorLessonPayload = JSON.parse(JSON.stringify(access.listLessonRecords('coord-user-a')))
    assert.equal(coordinatorLessonPayload.lessonRecords[0].content, 'Frações')
    assert.equal(coordinatorLessonPayload.lessonRecords[0].plan, 'Plano')
    assert.equal(coordinatorLessonPayload.lessonRecords[0].resources, 'Quadro')

    const gradesStudentPayload = JSON.parse(JSON.stringify(liensina.listStudentsPage('student-user-a', 1, 25, '', 'all', 'all', 'all', 'identity')))
    const gradesStudent = gradesStudentPayload.students[0]
    assert.deepEqual(Object.keys(gradesStudent).sort(), ['classId', 'id', 'name', 'schoolId'])

    const gradesClassPayload = JSON.parse(JSON.stringify(access.getMeClasses('student-user-a', { view: 'summary' })))
    const gradesClass = gradesClassPayload.classes[0]
    assert.deepEqual(Object.keys(gradesClass).sort(), ['grade', 'id', 'name', 'schoolId', 'shift'])

    const gradesSchoolPayload = JSON.parse(JSON.stringify(access.getMeSchools('student-user-a', { view: 'identity' })))
    const gradesSchool = gradesSchoolPayload.schools[0]
    assert.deepEqual(Object.keys(gradesSchool).sort(), ['id', 'name'])
  })

  it('correcoes e notas aceitam filtro de status no back-end', () => {
    const data = makeDatabase()
    data.evaluationCorrections.push({
      ...correction('grade-a-review', 'exam-a', 'student-a', 'class-a', 'school-a'),
      status: 'SUGGESTED',
      finalScore: null,
    })
    const access = new ResourceAccessService(new MemoryDatabase(data) as never)

    assert.deepEqual(access.listExamCorrections('student-user-a', { status: 'CONFIRMED' }).examCorrections.map((item) => item.id), ['grade-a'])
    assert.deepEqual(access.listGrades('student-user-a', { status: 'CONFIRMED' }).grades.map((item) => item.id), ['grade-a'])
    const summaryGradePayload = JSON.parse(JSON.stringify(access.listGrades('student-user-a', { status: 'CONFIRMED', view: 'summary' })))
    assert.deepEqual(Object.keys(summaryGradePayload.grades[0]).sort(), [
      'classId',
      'correctCount',
      'evaluationId',
      'evaluationTitle',
      'id',
      'reviewedAt',
      'scheduledAt',
      'score',
      'status',
      'studentId',
      'subject',
      'totalQuestions',
    ])
    assert.throws(() => access.listExamCorrections('student-user-a', { status: 'INVALIDO' }), /Status de correcao invalido/)
  })

  it('responsavel ve apenas dependentes e nao lanca nota ou frequencia', () => {
    const { access } = services()

    assert.deepEqual(access.listStudents('guardian-user-a').students.map((student) => student.id), ['student-a'])
    assert.deepEqual(access.listGrades('guardian-user-a').grades.map((grade) => grade.studentId), ['student-a'])
    assert.throws(() => access.getStudent('guardian-user-a', 'student-b'), /Sem permissao|nao encontrado/)
    assert.throws(() => access.createManualCorrection('guardian-user-a', { evaluationId: 'exam-a', studentId: 'student-a', finalScore: 10 }), /permissao/)
  })

  it('admin acessa dados globais pelos endpoints REST organizados', () => {
    const { access } = services()

    assert.equal(access.listStudents('admin-user').students.length, 2)
    assert.equal(access.listTeachers('admin-user').teachers.length, 2)
    assert.equal(access.listExams('admin-user').exams.length, 2)
    assert.equal(access.listSchools('admin-user').schools.length, 2)
  })

  it('admin escolar fica limitado a propria escola e nao executa rotas globais', () => {
    const { access, liensina } = services()

    assert.deepEqual(access.listSchools('school-admin-user-a').schools.map((school) => school.id), ['school-a'])
    assert.deepEqual(access.listStudents('school-admin-user-a').students.map((student) => student.id), ['student-a'])
    const visibleUsers = access.listUsers('school-admin-user-a').users
    assert.ok(visibleUsers.length > 1)
    assert.ok(visibleUsers.every((user) => user.id === 'school-admin-user-a' || user.schoolId === 'school-a'))
    assert.throws(() => access.getUser('school-admin-user-a', 'school-admin-user-b'), /nao encontrado|Sem permissao/)
    assert.deepEqual(access.listRoles('school-admin-user-a').roles.map((item) => item.code), ['ADMIN_ESCOLA'])
    assert.throws(() => liensina.updateUserRole('school-admin-user-a', 'student-user-a', 'SUPERADMIN'), /permissao/)
  })

  it('confirmacao de correcao e idempotente por chave e rejeita payload divergente', async () => {
    const { liensina } = services()
    const payload = { corrections: [{ id: 'grade-a', finalScore: 9 }] }

    const first = await liensina.confirmEvaluationCorrections('teacher-user-a', 'exam-a', payload, 'confirm-grade-a')
    const retry = await liensina.confirmEvaluationCorrections('teacher-user-a', 'exam-a', payload, 'confirm-grade-a')

    assert.equal(first.updatedCount, 1)
    assert.deepEqual(retry, first)
    await assert.rejects(
      () => liensina.confirmEvaluationCorrections('teacher-user-a', 'exam-a', { corrections: [{ id: 'grade-a', finalScore: 7 }] }, 'confirm-grade-a'),
      /payload diferente/i,
    )
  })

  it('bloqueia mass assignment em campos controlados pelo servidor', async () => {
    const { liensina } = services()

    assert.throws(() => liensina.createStudent('admin-user', {
      name: 'Aluno forjado',
      schoolId: 'school-a',
      classId: 'class-a',
      password: 'StrongPass123!',
      status: 'aprovado' as never,
      averageScore: 10,
    }), /Campos nao permitidos/)

    await assert.rejects(() => liensina.createEvaluation('admin-user', {
      title: 'Prova forjada',
      classId: 'class-a',
      subject: 'Matematica',
      scheduledAt: '2026-05-20',
      status: 'APPROVED' as never,
      schoolId: 'school-b',
    }), /Campos nao permitidos/)

    assert.throws(() => liensina.updateProfile('admin-user', {
      roleId: 'ADMIN',
      schoolId: 'school-b',
      status: 'ativo',
    }), /Campos nao permitidos/)

    const forgedCalendarPayload = {
      title: 'Evento forjado',
      type: 'evento',
      schoolId: 'school-a',
      startsAt: '2026-05-20T08:00',
      endsAt: '2026-05-20T09:00',
      createdById: 'director-user-b',
    } as never
    assert.throws(() => liensina.createCalendarEvent('admin-user', forgedCalendarPayload), /Campos nao permitidos/)
  })

  it('arquivo do cartao corrigido so e entregue para usuario com vinculo da correcao', () => {
    const data = makeDatabase()
    const key = 'tests/secure-card-test.jpg'
    const bucket = 'liensina-omr-corrections'
    const filePath = join(process.cwd(), 'uploads', bucket, key)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, Buffer.from('fake-image'))
    data.evaluationCorrections[0].imageUrl = `/uploads/${bucket}/${key}`
    data.evaluationCorrections[0].imageObject = {
      storageProvider: 'local',
      bucket,
      key,
      publicUrl: `/uploads/${bucket}/${key}`,
      contentType: 'image/jpeg',
      sizeBytes: 10,
      originalName: 'cartao-a.jpg',
      uploadedAt: '2026-05-01T00:00:00.000Z',
    }

    try {
      const database = new MemoryDatabase(data)
      const liensina = new LiensinaService(database as never, {} as never, { get: () => undefined } as never)

      const file = liensina.getEvaluationCorrectionCardFile('teacher-user-a', 'grade-a')
      assert.equal(file.filePath, filePath)
      assert.equal(file.contentType, 'image/jpeg')
      assert.equal(file.filename, 'cartao-a.jpg')
      assert.throws(() => liensina.getEvaluationCorrectionCardFile('teacher-user-a', 'grade-b'), /Correcao nao encontrada|Sem acesso/)
      assert.throws(() => liensina.getEvaluationCorrectionCardFile('student-user-a', 'grade-a'), /perfil/)
    } finally {
      rmSync(filePath, { force: true })
    }
  })
})
