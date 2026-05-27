#!/usr/bin/env node
require('ts-node/register/transpile-only')

const { performance } = require('node:perf_hooks')
const { availableParallelism } = require('node:os')
const { LiensinaService } = require('../src/liensina.service')

const optionLabels = ['A', 'B', 'C', 'D', 'E']

function intEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function classSizesEnv() {
  const raw = String(process.env.BENCH_CLASS_SIZES ?? '').trim()
  if (raw) {
    const parsed = raw
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item > 0)
      .map((item) => Math.min(item, 500))
    if (parsed.length) return parsed
  }

  const classCount = intEnv('BENCH_CLASSES', 1, 1, 20)
  const studentsPerClass = intEnv('BENCH_STUDENTS_PER_CLASS', intEnv('BENCH_STUDENTS', 100, 1, 500), 1, 500)
  return Array.from({ length: classCount }, () => studentsPerClass)
}

function nowIso() {
  return new Date().toISOString()
}

class MemoryDatabase {
  constructor(data) {
    this.data = data
  }

  read() {
    return structuredClone(this.data)
  }

  update(mutator) {
    mutator(this.data)
    return this.read()
  }

  async updateCommitted(mutator) {
    return this.update(mutator)
  }

  async reserveIdempotencyRecord(input) {
    const existing = this.data.idempotencyRecords.find((record) => record.scopeKey === input.scopeKey)
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) return { state: 'conflict' }
      if (existing.status === 'COMPLETED') return { state: 'completed', response: existing.response }
      return { state: 'processing' }
    }
    const stamp = nowIso()
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
      createdAt: stamp,
      updatedAt: stamp,
      expiresAt: '2999-01-01T00:00:00.000Z',
      lockedUntil: '2999-01-01T00:00:00.000Z',
    })
    return { state: 'started' }
  }

  async completeIdempotencyRecord(scopeKey, response) {
    const record = this.data.idempotencyRecords.find((item) => item.scopeKey === scopeKey)
    if (!record) return
    record.status = 'COMPLETED'
    record.response = response
    record.lockedUntil = null
    record.updatedAt = nowIso()
  }

  async failIdempotencyRecord(scopeKey) {
    const record = this.data.idempotencyRecords.find((item) => item.scopeKey === scopeKey)
    if (!record) return
    record.status = 'FAILED'
    record.lockedUntil = null
    record.updatedAt = nowIso()
  }
}

function role(code) {
  return { id: code, code, name: code, description: code, permissions: [] }
}

function makeQuestion(index) {
  const correct = optionLabels[index % optionLabels.length]
  return {
    id: `question-${String(index + 1).padStart(3, '0')}`,
    schoolId: 'school-bench',
    networkId: 'network-bench',
    createdById: 'teacher-user',
    title: `Questao ${index + 1}`,
    context: '',
    statement: `Enunciado sintetico da questao ${index + 1}.`,
    explanation: `Explicacao da questao ${index + 1}.`,
    type: 'MULTIPLE_CHOICE',
    stage: 'FUNDAMENTAL',
    gradeLevel: 'EF6',
    area: 'Matematica',
    component: 'Matematica',
    subject: 'Matematica',
    difficulty: 'MEDIUM',
    sourceType: 'SCHOOL_BANK',
    sourceName: 'Benchmark local',
    sourceYear: 2026,
    sourceExternalId: null,
    sourceUrl: null,
    licenseNotes: null,
    visibility: 'SCHOOL',
    status: 'APPROVED',
    isEditable: true,
    reviewedById: 'admin-user',
    reviewedAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    archivedAt: null,
    metadata: { estimatedTimeSeconds: 90, hasImage: false, hasTable: false, hasFormula: false },
    options: optionLabels.map((label, optionIndex) => ({
      id: `question-${index + 1}-${label}`,
      questionId: `question-${String(index + 1).padStart(3, '0')}`,
      label,
      text: `Alternativa ${label}`,
      order: optionIndex + 1,
      isCorrect: label === correct,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })),
    skills: [],
    descriptors: [],
    attachments: [],
    reviews: [],
  }
}

function makeDatabase({ classSizes, questions }) {
  const roles = ['SUPERADMIN', 'ADMIN', 'ADMIN_ESCOLA', 'DIRETOR', 'COORDENADOR', 'PROFESSOR', 'ALUNO', 'RESPONSAVEL', 'NUTRITIONIST'].map(role)
  const classes = classSizes.map((studentCount, index) => ({
    id: `class-bench-${index + 1}`,
    name: `Turma Benchmark ${index + 1}`,
    grade: 'EF6',
    shift: 'Manha',
    schoolId: 'school-bench',
    teacherId: 'teacher-bench',
    teacherIds: ['teacher-bench'],
    academicYear: 2026,
    schedule: 'Segunda',
    bnccFocus: ['Matematica'],
    benchmarkStudentCount: studentCount,
  }))
  const students = classSizes.flatMap((studentCount, classIndex) => (
    Array.from({ length: studentCount }, (_, studentIndex) => {
      const globalIndex = classSizes.slice(0, classIndex).reduce((total, current) => total + current, 0) + studentIndex
      return {
        id: `student-${String(globalIndex + 1).padStart(4, '0')}`,
        userId: `student-user-${globalIndex + 1}`,
        name: `Aluno ${globalIndex + 1}`,
        login: `student-${globalIndex + 1}`,
        role: 'ALUNO',
        registration: `MAT-${globalIndex + 1}`,
        registrationNumber: `MAT-${globalIndex + 1}`,
        schoolId: 'school-bench',
        classId: `class-bench-${classIndex + 1}`,
        guardianIds: [],
        status: 'matriculado',
        attendanceRate: 95,
        averageScore: 0,
        desempenho: 'Medio',
      }
    })
  ))
  return {
    roles,
    users: [
      { id: 'admin-user', name: 'Admin', email: 'admin@bench.local', login: 'admin@bench.local', password: 'StrongPass123!', roleId: 'ADMIN', schoolId: null, status: 'ativo', phone: '' },
      { id: 'teacher-user', name: 'Professor Bench', email: 'teacher@bench.local', login: 'teacher@bench.local', password: 'StrongPass123!', roleId: 'PROFESSOR', schoolId: 'school-bench', status: 'ativo', phone: '', linkedTeacherId: 'teacher-bench' },
    ],
    refreshSessions: [],
    idempotencyRecords: [],
    notifications: [],
    schools: [{ id: 'school-bench', name: 'Escola Benchmark', city: 'Local', address: 'Local', director: 'Diretor', inepCode: '99999999', active: true }],
    teachers: [{ id: 'teacher-bench', userId: 'teacher-user', name: 'Professor Bench', email: 'teacher@bench.local', schoolId: 'school-bench', specialty: 'Matematica', active: true }],
    guardians: [],
    students,
    classes,
    evaluations: [],
    answerCards: [],
    evaluationCorrections: [],
    curriculumBases: [],
    curriculumSkills: [],
    assessmentPrograms: [],
    assessmentMatrices: [],
    assessmentDescriptors: [],
    questions: Array.from({ length: questions }, (_, index) => makeQuestion(index)),
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

function makeOmrResponse(database, file, payload, delayMs) {
  const studentId = String(file.originalname).replace(/\.(jpg|jpeg|png|webp|pdf)$/i, '')
  const answerCard = database.data.answerCards.find((card) => card.evaluationId === payload.examId && card.studentId === studentId)
  const detectedAnswers = payload.answerKey.map((item) => ({
    questionNumber: item.questionNumber,
    questionId: item.questionId ?? null,
    detectedOption: item.correctOption,
    correctOption: item.correctOption,
    isCorrect: true,
    status: 'ok',
    confidence: 0.99,
    markedOptions: [item.correctOption],
    optionScores: optionLabels.map((option) => ({ option, fillRatio: option === item.correctOption ? 0.92 : 0.03 })),
  }))
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve([{
        examId: payload.examId,
        versionId: payload.versionId,
        answerCardId: answerCard?.cardId ?? null,
        studentId,
        classId: payload.classId,
        suggestedScore: 10,
        correctCount: payload.answerKey.length,
        wrongCount: 0,
        blankCount: 0,
        multipleCount: 0,
        totalQuestions: payload.answerKey.length,
        confidence: 0.99,
        requiresReview: false,
        shouldRetakeImage: false,
        failures: [],
        detectedAnswers,
        metadata: { benchmark: true },
      }])
    }, delayMs)
  })
}

async function runLimited(items, concurrency, worker) {
  let index = 0
  const results = []
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current], current)
    }
  }))
  return results
}

async function main() {
  const questions = intEnv('BENCH_QUESTIONS', 100, 1, 100)
  const classSizes = classSizesEnv()
  const totalStudents = classSizes.reduce((total, current) => total + current, 0)
  const batchSize = intEnv('BENCH_BATCH_SIZE', 20, 1, 20)
  const requestConcurrency = intEnv(
    'BENCH_REQUEST_CONCURRENCY',
    intEnv('BENCH_PARALLEL_BATCHES', Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))), 1, 32),
    1,
    32,
  )
  const confirmConcurrency = intEnv('BENCH_CONFIRM_CONCURRENCY', Math.min(requestConcurrency, classSizes.length), 1, 20)
  const omrDelayMs = intEnv('BENCH_OMR_DELAY_MS', 20, 0, 10_000)
  const data = makeDatabase({ classSizes, questions })
  const database = new MemoryDatabase(data)
  const config = { get: (key) => process.env[key] }
  const liensina = new LiensinaService(database, {}, config)
  liensina.requestOmrBatchCorrection = (file, payload) => makeOmrResponse(database, file, payload, omrDelayMs)
  liensina.saveEvaluationCorrectionImage = async (evaluationId, studentId, file) => ({
    bucket: 'benchmark',
    key: `${evaluationId}/${studentId}/${file.originalname}`,
    contentType: file.mimetype,
    size: file.size,
    checksum: 'benchmark',
    createdAt: nowIso(),
    publicUrl: '',
  })

  const startedAt = performance.now()
  const createdEvaluations = await runLimited(data.classes, Math.min(requestConcurrency, data.classes.length), (classRoom, index) => (
    liensina.createEvaluation('teacher-user', {
      title: `Benchmark ${questions} questoes - ${classRoom.name}`,
      classId: classRoom.id,
      subject: 'Matematica',
      scheduledAt: '2026-05-25',
      questions,
      buildMode: 'manual_bank',
      questionIds: data.questions.slice(0, questions).map((question) => question.id),
    }, `bench-create-${index}`)
  ))
  const createMs = performance.now() - startedAt

  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])
  const correctionRequests = createdEvaluations.flatMap(({ evaluation }, classIndex) => {
    const classStudents = data.students.filter((student) => student.classId === evaluation.classId)
    const files = classStudents.map((student) => ({
      buffer: jpegBytes,
      mimetype: 'image/jpeg',
      originalname: `${student.id}.jpg`,
      size: jpegBytes.length,
    }))
    const chunks = []
    for (let start = 0; start < files.length; start += batchSize) {
      chunks.push({
        classIndex,
        classId: evaluation.classId,
        evaluationId: evaluation.id,
        files: files.slice(start, start + batchSize),
      })
    }
    return chunks
  })

  const correctionStartedAt = performance.now()
  const batchResults = await runLimited(correctionRequests, requestConcurrency, async (request, index) => {
    const requestStartedAt = performance.now()
    const result = await liensina.processEvaluationOmrBatch('teacher-user', request.evaluationId, request.files, `bench-omr-${index}`)
    return {
      ...result,
      classId: request.classId,
      elapsedMs: performance.now() - requestStartedAt,
    }
  })
  const correctionMs = performance.now() - correctionStartedAt
  const correctionCount = batchResults.reduce((total, result) => total + result.corrected, 0)

  const confirmStartedAt = performance.now()
  const confirmedResults = await runLimited(createdEvaluations, confirmConcurrency, ({ evaluation }, index) => {
    const corrections = database.data.evaluationCorrections.filter((correction) => correction.evaluationId === evaluation.id)
    return liensina.confirmEvaluationCorrections('teacher-user', evaluation.id, {
      corrections: corrections.map((correction) => ({ id: correction.id, finalScore: correction.suggestedScore })),
    }, `bench-confirm-${index}`)
  })
  const confirmMs = performance.now() - confirmStartedAt
  const totalMs = performance.now() - startedAt
  const requestTimes = batchResults.map((result) => result.elapsedMs)

  const output = {
    machine: {
      cpuCores: availableParallelism(),
      node: process.version,
    },
    config: {
      questions,
      classes: classSizes.length,
      classSizes,
      totalStudents,
      batchSize,
      correctionRequests: correctionRequests.length,
      requestConcurrency,
      confirmConcurrency,
      omrBatchConcurrency: process.env.OMR_BATCH_CONCURRENCY ?? 'auto',
      omrDelayMs,
    },
    timingsMs: {
      createEvaluation: Number(createMs.toFixed(2)),
      processCorrections: Number(correctionMs.toFixed(2)),
      confirmCorrections: Number(confirmMs.toFixed(2)),
      total: Number(totalMs.toFixed(2)),
    },
    throughput: {
      correctedStudents: correctionCount,
      correctionsPerSecond: Number((correctionCount / (correctionMs / 1000)).toFixed(2)),
      confirmedStudents: confirmedResults.reduce((total, result) => total + result.updatedCount, 0),
    },
    requestTimingsMs: {
      min: Number(Math.min(...requestTimes).toFixed(2)),
      avg: Number((requestTimes.reduce((total, current) => total + current, 0) / requestTimes.length).toFixed(2)),
      max: Number(Math.max(...requestTimes).toFixed(2)),
    },
  }

  console.log(JSON.stringify(output, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
