import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const initSqlJs = require('sql.js')

const databasePath = resolve(
  process.cwd(),
  process.env.DATABASE_PATH || process.argv[2] || 'data/liensina.sqlite',
)
const now = new Date().toISOString()

const collections = [
  'users',
  'refreshSessions',
  'notifications',
  'roles',
  'schools',
  'teachers',
  'guardians',
  'students',
  'classes',
  'evaluations',
  'curriculumBases',
  'curriculumSkills',
  'assessmentPrograms',
  'assessmentMatrices',
  'assessmentDescriptors',
  'questions',
  'questionImportPlans',
  'lessonRecords',
  'calendarEvents',
  'mealFoods',
  'mealManagements',
  'auditEvents',
]

function stableId(key) {
  const hex = createHash('sha1').update(`liensina-pedagogy:${key}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function readCollection(db, name) {
  const result = db.exec(`SELECT payload FROM collections WHERE name = '${name}'`)
  const raw = result[0]?.values?.[0]?.[0]
  if (!raw) return []

  try {
    const parsed = JSON.parse(String(raw))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeCollection(db, name, items) {
  db.run(
    'INSERT OR REPLACE INTO collections (name, payload, updated_at) VALUES (?, ?, ?)',
    [name, JSON.stringify(items), now],
  )
}

function upsertMany(current, incoming) {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, { ...(byId.get(item.id) ?? {}), ...item })
  return Array.from(byId.values())
}

function desempenhoFromScore(score) {
  if (score < 6) return 'Baixo'
  if (score < 7.5) return 'Medio'
  return 'Otimo'
}

function triLevelFromScore(score) {
  if (score < 6) return 'Abaixo do basico'
  if (score < 7.5) return 'Basico'
  if (score < 9) return 'Adequado'
  return 'Avancado'
}

function pickQuestions(questions, subject, offset = 0) {
  const subjectKey = normalizeText(subject)
  const matches = questions.filter((question) => {
    const haystack = normalizeText(
      `${question.subject} ${question.component} ${question.area} ${question.title}`,
    )
    return haystack.includes(subjectKey) || subjectKey.includes(haystack)
  })
  const pool = matches.length >= 6 ? matches : questions
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)]
  return rotated.slice(0, 8)
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

const school = {
  id: stableId('school:pedagogical-demo'),
  name: 'Escola Municipal Horizonte do Saber',
  city: 'São Paulo',
  address: 'Rua das Aprendizagens, 120 - Centro',
  director: 'Helena Duarte',
  inepCode: '35199001',
  active: true,
}

const teacherSpecs = [
  ['ana-rocha', 'Ana Rocha', 'ana.rocha@liensina.local', 'Matemática; Física'],
  ['bruno-lima', 'Bruno Lima', 'bruno.lima@liensina.local', 'Língua Portuguesa; Redação'],
  ['carla-mendes', 'Carla Mendes', 'carla.mendes@liensina.local', 'Ciências; Biologia'],
  ['diego-santos', 'Diego Santos', 'diego.santos@liensina.local', 'História; Geografia'],
  ['elisa-nunes', 'Elisa Nunes', 'elisa.nunes@liensina.local', 'Química; Projeto de vida'],
  ['fabio-costa', 'Fábio Costa', 'fabio.costa@liensina.local', 'Matemática; Tecnologia'],
]

const teachers = teacherSpecs.map(([key, name, email, specialty]) => ({
  id: stableId(`teacher:${key}`),
  userId: stableId(`user:teacher:${key}`),
  name,
  email,
  schoolId: school.id,
  specialty,
  active: true,
}))

const classSpecs = [
  {
    key: 'ef6-a',
    name: '6º Ano A - Manhã',
    grade: 'EF6',
    shift: 'Manha',
    teacher: 0,
    subjects: ['Matemática', 'Língua Portuguesa'],
    baseAttendance: 74,
    baseScore: 5.8,
    schedule: 'Segunda, quarta e sexta - 07:10 às 11:40',
  },
  {
    key: 'ef7-b',
    name: '7º Ano B - Tarde',
    grade: 'EF7',
    shift: 'Tarde',
    teacher: 2,
    subjects: ['Ciências', 'Geografia'],
    baseAttendance: 83,
    baseScore: 6.7,
    schedule: 'Segunda a sexta - 13:00 às 17:30',
  },
  {
    key: 'ef8-a',
    name: '8º Ano A - Manhã',
    grade: 'EF8',
    shift: 'Manha',
    teacher: 5,
    subjects: ['Matemática', 'Ciências'],
    baseAttendance: 69,
    baseScore: 5.4,
    schedule: 'Segunda a sexta - 07:10 às 11:40',
  },
  {
    key: 'ef9-c',
    name: '9º Ano C - Tarde',
    grade: 'EF9',
    shift: 'Tarde',
    teacher: 1,
    subjects: ['Língua Portuguesa', 'História'],
    baseAttendance: 88,
    baseScore: 7.5,
    schedule: 'Segunda a sexta - 13:00 às 17:30',
  },
  {
    key: 'em1-a',
    name: '1ª Série EM A - Manhã',
    grade: 'EM1',
    shift: 'Manha',
    teacher: 0,
    subjects: ['Matemática', 'Física'],
    baseAttendance: 78,
    baseScore: 6.1,
    schedule: 'Segunda a sexta - 07:00 às 12:20',
  },
  {
    key: 'em2-b',
    name: '2ª Série EM B - Noite',
    grade: 'EM2',
    shift: 'Noite',
    teacher: 4,
    subjects: ['Química', 'Biologia'],
    baseAttendance: 91,
    baseScore: 8.0,
    schedule: 'Segunda a sexta - 19:00 às 22:30',
  },
  {
    key: 'em3-a',
    name: '3ª Série EM A - Manhã',
    grade: 'EM3',
    shift: 'Manha',
    teacher: 1,
    subjects: ['Redação', 'Matemática'],
    baseAttendance: 81,
    baseScore: 6.9,
    schedule: 'Segunda a sexta - 07:00 às 12:20',
  },
  {
    key: 'apoio-intensivo',
    name: 'Apoio Intensivo - Diagnóstico',
    grade: 'EF9',
    shift: 'Tarde',
    teacher: 3,
    subjects: ['Língua Portuguesa', 'Matemática'],
    baseAttendance: 0,
    baseScore: 0,
    schedule: 'Grupo em formação',
    empty: true,
  },
]

const classes = classSpecs.map((item) => {
  const teacher = teachers[item.teacher]
  return {
    id: stableId(`class:${item.key}`),
    name: item.name,
    grade: item.grade,
    shift: item.shift,
    schoolId: school.id,
    teacherId: teacher.id,
    teacherIds: [teacher.id],
    academicYear: 2026,
    schedule: item.schedule,
    bnccFocus: item.subjects,
  }
})

const firstNames = [
  'Alice', 'Bernardo', 'Clara', 'Davi', 'Eduarda', 'Felipe', 'Giovana', 'Heitor',
  'Isabela', 'João', 'Lara', 'Miguel', 'Nina', 'Otávio', 'Pietra', 'Rafael',
  'Sofia', 'Theo', 'Valentina', 'Yasmin', 'Arthur', 'Beatriz', 'Caio', 'Helena',
]
const lastNames = [
  'Almeida', 'Barros', 'Campos', 'Dias', 'Esteves', 'Ferreira', 'Gomes', 'Lopes',
  'Martins', 'Nogueira', 'Oliveira', 'Pereira', 'Queiroz', 'Ribeiro', 'Silva', 'Teixeira',
]

const students = classSpecs.flatMap((classSpec, classIndex) => {
  if (classSpec.empty) return []
  const classRoom = classes[classIndex]
  return Array.from({ length: 8 }, (_, studentIndex) => {
    const key = `student:${classSpec.key}:${studentIndex + 1}`
    const scoreWave = [-1.1, -0.6, -0.2, 0.1, 0.5, 0.9, -0.8, 0.3][studentIndex]
    const attendanceWave = [-14, -8, -4, 1, 5, 9, -11, 3][studentIndex]
    const averageScore = Math.max(3.8, Math.min(9.6, Number((classSpec.baseScore + scoreWave).toFixed(1))))
    const attendanceRate = Math.max(52, Math.min(98, Math.round(classSpec.baseAttendance + attendanceWave)))
    const registrationNumber = `PD${String(classIndex + 1).padStart(2, '0')}${String(studentIndex + 1).padStart(2, '0')}`
    const name = `${firstNames[(classIndex * 4 + studentIndex) % firstNames.length]} ${lastNames[(classIndex * 3 + studentIndex) % lastNames.length]}`

    return {
      id: stableId(key),
      userId: stableId(`user:${key}`),
      name,
      login: `${school.inepCode}-${registrationNumber}`,
      role: 'ALUNO',
      registration: registrationNumber,
      registrationNumber,
      schoolId: school.id,
      classId: classRoom.id,
      guardianIds: [],
      status: 'matriculado',
      attendanceRate,
      averageScore,
      desempenho: desempenhoFromScore(averageScore),
    }
  })
})

function buildEvaluations(questions) {
  const datePlans = [
    ['semana-atual-1', '2026-05-05', 0.25],
    ['semana-atual-2', '2026-05-08', 0.45],
    ['semana-anterior', '2026-04-29', -0.35],
    ['mes-anterior', '2026-04-16', -0.15],
    ['bimestre-1', '2026-02-20', -0.55],
    ['ano-anterior', '2025-11-12', -0.75],
  ]

  return classSpecs.flatMap((classSpec, classIndex) => {
    if (classSpec.empty) return []
    const classRoom = classes[classIndex]
    const participants = students.filter((student) => student.classId === classRoom.id).length

    return datePlans.map(([dateKey, scheduledAt, offset], planIndex) => {
      const subject = classSpec.subjects[planIndex % classSpec.subjects.length]
      const pickedQuestions = pickQuestions(questions, subject, classIndex + planIndex)
      const score = Math.max(4.1, Math.min(9.4, Number((classSpec.baseScore + Number(offset)).toFixed(1))))
      const descriptorCodes = unique(
        pickedQuestions.flatMap((question) => (question.descriptors ?? []).map((descriptor) => descriptor.code)),
      ).slice(0, 5)
      const skillCodes = unique(
        pickedQuestions.flatMap((question) => (question.skills ?? []).map((skill) => skill.code)),
      ).slice(0, 5)

      return {
        id: stableId(`evaluation:${classSpec.key}:${dateKey}`),
        title: `Diagnóstico ${subject} - ${classRoom.name} (${scheduledAt.slice(5)})`,
        classId: classRoom.id,
        subject,
        questions: pickedQuestions.length || 8,
        scheduledAt,
        status: 'concluido',
        corrected: participants,
        participants,
        averageScore: score,
        triLevel: triLevelFromScore(score),
        buildMode: 'mixed',
        questionIds: pickedQuestions.map((question) => question.id),
        skillCodes,
        descriptorCodes,
        sourceSummary: `Seed pedagógico: ${subject} - ${classRoom.name}`,
      }
    })
  })
}

function buildLessonRecords() {
  const recordDates = [
    ['maio-semana', '2026-05-06', '08:00'],
    ['maio-projeto', '2026-05-08', '10:00'],
    ['abril-semana', '2026-04-29', '09:00'],
    ['abril-planejamento', '2026-04-17', '14:00'],
  ]

  return classSpecs.flatMap((classSpec, classIndex) => {
    if (classSpec.empty || classSpec.key === 'em3-a') return []
    const classRoom = classes[classIndex]

    return recordDates.map(([dateKey, date, time], recordIndex) => {
      const subject = classSpec.subjects[recordIndex % classSpec.subjects.length]
      return {
        id: stableId(`lesson-record:${classSpec.key}:${dateKey}`),
        classId: classRoom.id,
        subject,
        date,
        time,
        content: `Sequência diagnóstica de ${subject} com foco nas habilidades prioritárias da turma.`,
        plan: `Retomada guiada, atividade em grupo e correção comentada para ${classRoom.name}.`,
        resources: recordIndex % 2 === 0 ? 'Projetor, lista impressa e banco de questões LiEnsina' : 'Quadro, rubrica e material de apoio',
        activity: recordIndex % 2 === 0 ? 'Resolução de itens por descritor' : 'Produção orientada e discussão coletiva',
        notes: recordIndex === 0 ? 'Alunos com alerta encaminhados para acompanhamento pedagógico.' : '',
      }
    })
  })
}

async function main() {
  mkdirSync(dirname(databasePath), { recursive: true })
  const SQL = await initSqlJs()
  const db = existsSync(databasePath)
    ? new SQL.Database(readFileSync(databasePath))
    : new SQL.Database()

  db.run(`
    CREATE TABLE IF NOT EXISTS collections (
      name TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  const data = Object.fromEntries(collections.map((name) => [name, readCollection(db, name)]))
  const evaluations = buildEvaluations(data.questions)
  const lessonRecords = buildLessonRecords()

  data.schools = upsertMany(data.schools, [school])
  data.teachers = upsertMany(data.teachers, teachers)
  data.classes = upsertMany(data.classes, classes)
  data.students = upsertMany(data.students, students)
  data.evaluations = upsertMany(data.evaluations, evaluations)
  data.lessonRecords = upsertMany(data.lessonRecords, lessonRecords)

  for (const name of collections) writeCollection(db, name, data[name] ?? [])

  writeFileSync(databasePath, Buffer.from(db.export()))
  console.log(
    [
      `Seed pedagógico aplicado em ${databasePath}`,
      `${classes.length} turmas`,
      `${students.length} alunos`,
      `${teachers.length} professores`,
      `${evaluations.length} avaliações`,
      `${lessonRecords.length} registros de aula`,
    ].join(' | '),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
