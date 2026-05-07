export type Desempenho = 'Otimo' | 'Medio' | 'Baixo'
export type EvaluationStatus = 'planejado' | 'em_aplicacao' | 'corrigindo' | 'concluido'
export type EvaluationBuildMode = 'automatic_bank' | 'manual_bank' | 'teacher_created' | 'mixed'
export type UserStatus = 'ativo' | 'pendente' | 'bloqueado'
export type CalendarEventType = 'aula' | 'reuniao' | 'avaliacao' | 'prazo' | 'evento'
export type RoleCode = 'ADMIN' | 'DIRETOR' | 'COORDENADOR' | 'PROFESSOR' | 'ALUNO' | 'RESPONSAVEL'
export type EducationStage = 'INFANTIL' | 'FUNDAMENTAL' | 'MEDIO' | 'EJA'
export type QuestionType = 'MULTIPLE_CHOICE'
export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD'
export type QuestionSourceType =
  | 'TEACHER_CREATED'
  | 'SECRETARY_CREATED'
  | 'AI_GENERATED'
  | 'INEP_ENEM'
  | 'IMPORTED_SPREADSHEET'
  | 'SCHOOL_BANK'
  | 'GLOBAL_CURATED'
export type QuestionVisibility = 'PRIVATE' | 'SCHOOL' | 'NETWORK' | 'GLOBAL'
export type QuestionStatus = 'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'ARCHIVED'
export type SkillRelevance = 'PRIMARY' | 'SECONDARY'
export type DescriptorRelevance = 'PRIMARY' | 'SECONDARY'
export type ReviewStatus = 'APPROVED' | 'REJECTED' | 'NEEDS_CHANGES'
export type AttachmentType = 'IMAGE' | 'PDF' | 'AUDIO' | 'VIDEO'
export type AttachmentPosition = 'CONTEXT' | 'STATEMENT' | 'OPTION' | 'EXPLANATION'
export type MealShift = 'MANHA' | 'TARDE' | 'NOITE' | 'INTEGRAL'
export type MealType = 'CAFE_DA_MANHA' | 'LANCHE' | 'ALMOCO' | 'JANTAR'
export type MealStockStatus = 'DISPONIVEL' | 'BAIXO' | 'VENCIDO' | 'DESCARTADO'
export type MealMovementType = 'ENTRADA' | 'SAIDA' | 'AJUSTE' | 'DESCARTE' | 'TRANSFERENCIA'
export type MealPurchaseStatus = 'PENDENTE' | 'APROVADA' | 'ENTREGUE' | 'CANCELADA'
export type MealMenuStatus = 'RASCUNHO' | 'APROVADO' | 'CANCELADO'
export type MealPriority = 'BAIXA' | 'MEDIA' | 'ALTA' | 'URGENTE'
export type MealRequestStatus = 'PENDENTE' | 'APROVADA' | 'RECUSADA' | 'ENTREGUE'
export type MealOccurrenceType = 'PRODUTO_VENCIDO' | 'FALTA_DE_ESTOQUE' | 'PRODUTO_DANIFICADO' | 'SOBRA_EXCESSIVA' | 'BAIXA_QUALIDADE' | 'OUTRO'
export type MealBudgetStatus = 'DENTRO_DO_LIMITE' | 'EM_ALERTA' | 'ULTRAPASSADO'
export type MealManagementStatus = 'ATIVO' | 'PAUSADO' | 'ENCERRADO'

export interface Role {
  id: string
  code: RoleCode
  name: RoleCode
  description: string
  permissions: string[]
}

export interface UserAccount {
  id: string
  name: string
  email: string
  login?: string
  password: string
  roleId: string
  schoolId: string | null
  status: UserStatus
  phone: string
  cpf?: string
  birthDate?: string
  avatarUrl?: string
  bannerUrl?: string
  linkedTeacherId?: string
  linkedStudentId?: string
  linkedGuardianId?: string
}

export type PublicUserAccount = Omit<UserAccount, 'password'>

export interface RefreshSession {
  id: string
  userId: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  revokedAt?: string
  rotatedFromId?: string
  userAgent?: string
  ip?: string
}

export interface School {
  id: string
  name: string
  city: string
  address: string
  director: string
  inepCode: string
  active: boolean
}

export interface Teacher {
  id: string
  userId: string
  name: string
  email: string
  schoolId: string
  specialty: string
  active: boolean
}

export interface Guardian {
  id: string
  userId: string
  name: string
  email: string
  role: 'RESPONSAVEL'
  schoolId: string
  phone: string
  studentIds: string[]
}

export interface Student {
  id: string
  userId: string
  name: string
  login: string
  role: 'ALUNO'
  registration: string
  registrationNumber: string
  schoolId: string
  classId: string
  guardianIds: string[]
  status: 'matriculado' | 'transferido' | 'inativo'
  attendanceRate: number
  averageScore: number
  desempenho: Desempenho
}

export interface ClassRoom {
  id: string
  name: string
  grade: string
  shift: 'Manha' | 'Tarde' | 'Noite'
  schoolId: string
  teacherId: string
  teacherIds: string[]
  academicYear: number
  schedule: string
  bnccFocus: string[]
}

export interface Evaluation {
  id: string
  title: string
  classId: string
  subject: string
  questions: number
  scheduledAt: string
  status: EvaluationStatus
  corrected: number
  participants: number
  averageScore: number
  triLevel: string
  buildMode?: EvaluationBuildMode
  questionIds?: string[]
  skillCodes?: string[]
  descriptorCodes?: string[]
  sourceSummary?: string
}

export interface CurriculumBase {
  id: string
  name: string
  code: string
  description: string
  sourceUrl: string | null
  isOfficial: boolean
  active: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface CurriculumSkill {
  id: string
  baseId: string
  code: string
  description: string
  stage: EducationStage
  gradeLevel: string
  area: string
  component: string
  thematicUnit: string
  knowledgeObject: string
  competence: string | null
  sourceUrl: string | null
  active: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface AssessmentProgram {
  id: string
  name: string
  code: string
  description: string
  sourceUrl: string | null
  isOfficial: boolean
  active: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface AssessmentMatrix {
  id: string
  programId: string
  name: string
  year: number
  stage: EducationStage
  gradeLevel: string
  subject: string
  area: string
  sourceUrl: string | null
  active: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface AssessmentDescriptor {
  id: string
  matrixId: string
  code: string
  description: string
  topic: string
  axis: string
  order: number
  active: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface QuestionMetadata {
  estimatedTimeSeconds?: number
  hasImage?: boolean
  hasTable?: boolean
  hasFormula?: boolean
  keywords?: string[]
  [key: string]: unknown
}

export interface QuestionOption {
  id: string
  questionId: string
  label: string
  text: string
  order: number
  isCorrect: boolean
  createdAt: string
  updatedAt: string
}

export interface QuestionAttachment {
  id: string
  questionId: string
  fileUrl: string
  fileType: AttachmentType
  position: AttachmentPosition
  altText: string
  order: number
  metadata: Record<string, unknown>
  createdAt: string
}

export interface QuestionReview {
  id: string
  questionId: string
  reviewerId: string
  status: ReviewStatus
  comment: string
  reviewedAt: string
}

export interface QuestionSkillSummary extends CurriculumSkill {
  relevance: SkillRelevance
}

export interface QuestionDescriptorSummary extends AssessmentDescriptor {
  program: string
  matrix: string
  relevance: DescriptorRelevance
}

export interface Question {
  id: string
  schoolId: string
  networkId: string
  createdById: string
  title: string
  context: string
  statement: string
  explanation: string
  type: QuestionType
  stage: EducationStage
  gradeLevel: string
  area: string
  component: string
  subject: string
  difficulty: Difficulty
  sourceType: QuestionSourceType
  sourceName: string
  sourceYear: number | null
  sourceExternalId: string | null
  sourceUrl: string | null
  licenseNotes: string | null
  visibility: QuestionVisibility
  status: QuestionStatus
  isEditable: boolean
  reviewedById: string | null
  reviewedAt: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  metadata: QuestionMetadata
  options: QuestionOption[]
  skills: QuestionSkillSummary[]
  descriptors: QuestionDescriptorSummary[]
  attachments: QuestionAttachment[]
  reviews: QuestionReview[]
}

export interface QuestionImportPlanItem {
  sourceYear: number
  examDay: number
  notebookColor: string
  quantity: number
  importedCount: number
  sourceUrl: string
  status: 'PENDING_IMPORT' | 'IMPORTED' | 'UNAVAILABLE'
}

export interface QuestionImportPlan {
  id: string
  sourceType: QuestionSourceType
  officialSource: string
  availableOfficialYears: number[]
  unavailableOfficialYears: number[]
  reasonUnavailable: string
  recommendedAction: string
  itemsToImport: QuestionImportPlanItem[]
  active: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface CreateQuestionRequest {
  title: string
  context: string
  statement: string
  explanation: string
  type: QuestionType
  stage: EducationStage
  gradeLevel: string
  area: string
  component: string
  subject: string
  difficulty: Difficulty
  sourceType: QuestionSourceType
  sourceName: string
  sourceYear: number | null
  sourceExternalId: string | null
  sourceUrl: string | null
  licenseNotes: string | null
  visibility: QuestionVisibility
  options: Array<Pick<QuestionOption, 'label' | 'text' | 'order' | 'isCorrect'>>
  skillIds: string[]
  descriptorIds: string[]
  attachments: QuestionAttachment[]
  metadata: QuestionMetadata
}

export interface GenerateEnemQuestionsRequest {
  quantity: number
  subject?: string
  discipline?: string
  years?: number[]
  refresh?: boolean
}

export interface GenerateEnemQuestionsResponse {
  questions: Question[]
  requestedQuantity: number
  selectedQuantity: number
  fetchedCount: number
  importedCount: number
  years: number[]
  sourceType: 'INEP_ENEM'
}

export interface SchoolCalendarEvent {
  id: string
  title: string
  type: CalendarEventType
  schoolId: string
  classId: string | null
  startsAt: string
  endsAt: string
  allDay: boolean
  location: string
  description: string
}

export interface AuditEvent {
  id: string
  actor: string
  action: string
  target: string
  createdAt: string
}

export interface MealFood {
  id: number
  nome: string
  categoria: string
  unidadeMedida: 'KG' | 'UN' | 'L'
  iconKey: string
  ativo: boolean
  criadoEm: string
}

export interface MealBudget {
  id: string
  valorLimite: number
  valorUtilizado: number
  valorDisponivel: number
  percentualUtilizado: number
  status: MealBudgetStatus
  alertaAoAtingirPercentual: number
  permitirUltrapassarLimite: boolean
}

export interface MealManagementResponsibles {
  diretorId: string
  nutricionistaId: string
  merendeiroId: string
  responsavelFinanceiroId: string
}

export interface MealSupplier {
  id: string
  nome: string
}

export interface MealItem {
  id: string
  alimentoId: number
  nomeAlimento: string
  categoria: string
  quantidade: number
  unidadeMedida: 'KG' | 'UN' | 'L'
  valorUnitario: number
  valorTotal: number
  dataValidade: string | null
  possuiValidade: boolean
  lote: string | null
  fornecedor: MealSupplier
  statusEstoque: MealStockStatus
  adicionadoPorId: string
  adicionadoEm: string
}

export interface MealBudgetMovement {
  id: string
  tipo: 'COMPRA' | 'AJUSTE'
  itemMerendaId: string
  descricao: string
  valor: number
  saldoAntes: number
  saldoDepois: number
  responsavelId: string
  dataMovimentacao: string
}

export interface MealMenu {
  id: string
  diaSemana: string
  tipoRefeicao: MealType
  turno: MealShift
  titulo: string
  alimentoIds: number[]
  observacao?: string
  status: MealMenuStatus
}

export interface MealStockItem {
  id: string
  itemMerendaId: string
  alimentoId: number
  nomeAlimento: string
  quantidadeAtual: number
  quantidadeMinima: number
  unidadeMedida: 'KG' | 'UN' | 'L'
  dataValidade: string | null
  status: MealStockStatus
}

export interface MealSummary {
  totalItens: number
  totalKgComprado: number
  valorTotalComprado: number
  orcamentoInicial: number
  orcamentoRestante: number
  percentualUtilizado: number
  statusOrcamento: MealBudgetStatus
  itensBaixoEstoque: number
  itensVencidos: number
}

export interface MealManagement {
  id: string
  escolaId: string
  mesReferencia: string
  status: MealManagementStatus
  orcamentoMensal: MealBudget
  responsaveisGestao: MealManagementResponsibles
  alimentosCadastrados: MealFood[]
  cardapios: MealMenu[]
  itensMerenda: MealItem[]
  movimentacoesOrcamento: MealBudgetMovement[]
  estoqueMerenda: MealStockItem[]
  resumo: MealSummary
}

export interface CreateMealItemPayload {
  alimentoId: number
  quantidade: number
  valorUnitario: number
  dataValidade?: string | null
  possuiValidade?: boolean
  lote?: string | null
  fornecedorNome: string
  quantidadeMinima?: number
}

export interface CreateMealFoodPayload {
  nome: string
  categoria: string
  unidadeMedida: 'KG' | 'UN' | 'L'
  iconKey?: string
  ativo?: boolean
}

export interface CreateMealManagementPayload {
  escolaId: string
  mesReferencia: string
  valorLimite: number
  alertaAoAtingirPercentual?: number
  permitirUltrapassarLimite?: boolean
  responsaveisGestao?: Partial<MealManagementResponsibles>
  alimentosCadastrados?: CreateMealFoodPayload[]
}

export interface UpdateMealBudgetPayload {
  valorLimite?: number
  alertaAoAtingirPercentual?: number
  permitirUltrapassarLimite?: boolean
}

export interface UpsertMealMenuPayload {
  diaSemana: string
  tipoRefeicao: MealType
  turno: MealShift
  titulo: string
  alimentoIds: number[]
  observacao?: string
  status?: MealMenuStatus
}

export interface DatabaseShape {
  users: UserAccount[]
  refreshSessions: RefreshSession[]
  roles: Role[]
  schools: School[]
  teachers: Teacher[]
  guardians: Guardian[]
  students: Student[]
  classes: ClassRoom[]
  evaluations: Evaluation[]
  curriculumBases: CurriculumBase[]
  curriculumSkills: CurriculumSkill[]
  assessmentPrograms: AssessmentProgram[]
  assessmentMatrices: AssessmentMatrix[]
  assessmentDescriptors: AssessmentDescriptor[]
  questions: Question[]
  questionImportPlans: QuestionImportPlan[]
  calendarEvents: SchoolCalendarEvent[]
  mealFoods: MealFood[]
  mealManagements: MealManagement[]
  auditEvents: AuditEvent[]
}

export interface MealManagementsPagePayload {
  schools: School[]
  mealManagements: MealManagement[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export interface JwtPayload {
  sub: string
  email: string
  typ: 'access'
}
