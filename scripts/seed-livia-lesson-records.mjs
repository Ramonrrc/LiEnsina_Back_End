import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const initSqlJs = require('sql.js')

const databasePath = resolve(
  process.cwd(),
  process.env.DATABASE_PATH || process.argv[2] || 'data/liensina.sqlite',
)
const now = new Date().toISOString()
const targetSchoolName = 'Escola Municipal LiEnsina Centro'
const targetStudentName = 'Livia Sousa'

const lessonDrafts = [
  {
    key: '2026-05-04-lingua-portuguesa',
    subject: 'Lingua Portuguesa',
    date: '2026-05-04',
    time: '07:30',
    content: 'Leitura compartilhada de conto curto e identificacao de personagens, narrador e conflito.',
    plan: 'Retomar elementos da narrativa, orientar leitura em voz alta e conduzir debate com evidencias do texto.',
    resources: 'Livro didatico, quadro branco, caderno e fichas de leitura.',
    activity: 'Produzir um paragrafo resumindo o conflito principal e justificar com uma passagem do texto.',
    notes: 'Livia participou da leitura e concluiu o registro com boa organizacao.',
  },
  {
    key: '2026-05-05-matematica',
    subject: 'Matematica',
    date: '2026-05-05',
    time: '08:20',
    content: 'Resolucao de problemas com fracoes equivalentes e comparacao de quantidades.',
    plan: 'Apresentar situacoes-problema, resolver exemplos coletivos e organizar pratica em duplas.',
    resources: 'Material dourado, cartoes de fracoes, quadro branco e lista impressa.',
    activity: 'Resolver cinco problemas contextualizados e explicar uma estrategia para a turma.',
    notes: 'A turma precisou de reforco na justificativa dos resultados.',
  },
  {
    key: '2026-05-06-ciencias',
    subject: 'Ciencias',
    date: '2026-05-06',
    time: '09:10',
    content: 'Ciclo da agua, mudancas de estado fisico e impactos no cotidiano.',
    plan: 'Explorar esquema visual do ciclo da agua, levantar hipoteses e registrar vocabulario-chave.',
    resources: 'Projetor, imagens, copos transparentes e caderno de ciencias.',
    activity: 'Montar um mapa simples do ciclo da agua com setas e legenda.',
    notes: 'Livia relacionou evaporacao com situacoes observadas em casa.',
  },
  {
    key: '2026-05-07-lingua-portuguesa-producao',
    subject: 'Lingua Portuguesa',
    date: '2026-05-07',
    time: '10:00',
    content: 'Planejamento de producao textual com foco em introducao, desenvolvimento e conclusao.',
    plan: 'Organizar roteiro de escrita, revisar conectivos e orientar producao individual acompanhada.',
    resources: 'Roteiro impresso, quadro branco, dicionario e caderno.',
    activity: 'Escrever a primeira versao de um relato pessoal com revisao por pares.',
    notes: 'Boa evolucao no uso de conectivos; manter acompanhamento da pontuacao.',
  },
  {
    key: '2026-05-08-matematica-geometria',
    subject: 'Matematica',
    date: '2026-05-08',
    time: '10:50',
    content: 'Figuras geometricas planas, classificacao de poligonos e perimetro.',
    plan: 'Revisar nomenclaturas, medir lados em figuras impressas e calcular perimetros em grupo.',
    resources: 'Regua, folhas quadriculadas, formas impressas e quadro branco.',
    activity: 'Classificar poligonos e calcular o perimetro de tres figuras propostas.',
    notes: 'Livia calculou perimetros corretamente apos a revisao inicial.',
  },
]

function stableId(key) {
  const hex = createHash('sha1').update(`liensina-livia-lessons:${key}`).digest('hex')
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
  const statement = db.prepare('SELECT payload FROM collections WHERE name = ?')
  try {
    statement.bind([name])
    if (!statement.step()) return []

    const raw = statement.getAsObject().payload
    if (!raw) return []

    const parsed = JSON.parse(String(raw))
    return Array.isArray(parsed) ? parsed : []
  } finally {
    statement.free()
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

if (!existsSync(databasePath)) {
  throw new Error(`Banco nao encontrado em ${databasePath}`)
}

const SQL = await initSqlJs()
const db = new SQL.Database(readFileSync(databasePath))

const schools = readCollection(db, 'schools')
const students = readCollection(db, 'students')
const classes = readCollection(db, 'classes')
const lessonRecords = readCollection(db, 'lessonRecords')
const auditEvents = readCollection(db, 'auditEvents')

const school = schools.find((item) => normalizeText(item.name) === normalizeText(targetSchoolName))
if (!school) throw new Error(`Escola nao encontrada: ${targetSchoolName}`)

const student = students.find((item) => (
  normalizeText(item.name) === normalizeText(targetStudentName) &&
  item.schoolId === school.id
))
if (!student) throw new Error(`Aluno nao encontrado na escola ${targetSchoolName}: ${targetStudentName}`)

const classRoom = classes.find((item) => item.id === student.classId && item.schoolId === school.id)
if (!classRoom) throw new Error(`Turma do aluno nao encontrada: ${targetStudentName}`)

const incomingLessonRecords = lessonDrafts.map((lesson) => ({
  id: stableId(`${school.id}:${student.id}:${classRoom.id}:${lesson.key}`),
  classId: classRoom.id,
  subject: lesson.subject,
  date: lesson.date,
  time: lesson.time,
  content: lesson.content,
  plan: lesson.plan,
  resources: lesson.resources,
  activity: lesson.activity,
  notes: lesson.notes,
}))

writeCollection(db, 'lessonRecords', upsertMany(lessonRecords, incomingLessonRecords))
writeCollection(db, 'auditEvents', upsertMany(auditEvents, [{
  id: stableId(`audit:${school.id}:${student.id}:lesson-record-history`),
  actor: 'Sistema',
  action: 'Inseriu historico de registro de aula',
  target: `${targetStudentName} - ${classRoom.name}`,
  createdAt: now,
}]))

writeFileSync(databasePath, Buffer.from(db.export()))

console.log(JSON.stringify({
  databasePath,
  school: school.name,
  student: student.name,
  classRoom: classRoom.name,
  insertedOrUpdated: incomingLessonRecords.length,
}, null, 2))
