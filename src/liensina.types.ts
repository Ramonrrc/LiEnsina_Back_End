export type Desempenho = 'Otimo' | 'Medio' | 'Baixo'
export type EvaluationStatus = 'planejado' | 'em_aplicacao' | 'corrigindo' | 'concluido'
export type EvaluationBuildMode = 'automatic_bank' | 'manual_bank' | 'teacher_created' | 'mixed'
export type EvaluationCorrectionStatus = 'SUGGESTED' | 'CONFIRMED' | 'NEEDS_RETAKE' | 'REJECTED'
export type UserStatus = 'ativo' | 'pendente' | 'bloqueado'
export type CalendarEventType = 'aula' | 'reuniao' | 'avaliacao' | 'prazo' | 'evento'
export type RoleCode = 'SUPERADMIN' | 'ADMIN' | 'ADMIN_ESCOLA' | 'DIRETOR' | 'COORDENADOR' | 'PROFESSOR' | 'ALUNO' | 'RESPONSAVEL' | 'NUTRITIONIST'
export type IdempotencyStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
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
export type QuestionSelectionSourceMode = 'system' | 'enem' | 'mixed'
export type SkillRelevance = 'PRIMARY' | 'SECONDARY'
export type DescriptorRelevance = 'PRIMARY' | 'SECONDARY'
export type ReviewStatus = 'APPROVED' | 'REJECTED' | 'NEEDS_CHANGES'
export type AttachmentType = 'IMAGE' | 'PDF' | 'AUDIO' | 'VIDEO'
export type AttachmentPosition = 'CONTEXT' | 'STATEMENT' | 'OPTION' | 'EXPLANATION'
export type MealShift = 'MANHA' | 'TARDE' | 'NOITE' | 'INTEGRAL'
export type MealType = 'CAFE_DA_MANHA' | 'LANCHE' | 'ALMOCO' | 'JANTAR'
export type MealUnit = 'KG' | 'G' | 'L' | 'ML' | 'UNIT' | 'BOX' | 'PACKAGE' | 'DOZEN'
export type MealStockStatus = 'DISPONIVEL' | 'BAIXO' | 'VENCIDO' | 'DESCARTADO'
export type MealMovementType = 'ENTRADA' | 'SAIDA' | 'AJUSTE' | 'DESCARTE' | 'TRANSFERENCIA'
export type MealPurchaseStatus = 'PENDENTE' | 'APROVADA' | 'ENTREGUE' | 'CANCELADA'
export type MealMenuStatus = 'RASCUNHO' | 'APROVADO' | 'CANCELADO'
export type MealPriority = 'BAIXA' | 'MEDIA' | 'ALTA' | 'URGENTE'
export type MealRequestStatus = 'PENDENTE' | 'APROVADA' | 'RECUSADA' | 'ENTREGUE'
export type MealOccurrenceType = 'PRODUTO_VENCIDO' | 'FALTA_DE_ESTOQUE' | 'PRODUTO_DANIFICADO' | 'SOBRA_EXCESSIVA' | 'BAIXA_QUALIDADE' | 'OUTRO'
export type MealBudgetStatus = 'DENTRO_DO_LIMITE' | 'EM_ALERTA' | 'ULTRAPASSADO'
export type MealManagementStatus = 'ATIVO' | 'PAUSADO' | 'ENCERRADO'
export type FoodRequestStatus =
  | 'PENDING_NUTRITIONIST_APPROVAL'
  | 'APPROVED_BY_NUTRITIONIST'
  | 'REJECTED_BY_NUTRITIONIST'
  | 'NEEDS_ADJUSTMENT'
  | 'PENDING_PURCHASE'
  | 'PURCHASED'
  | 'ADDED_TO_STOCK'
  | 'CANCELLED'
export type FoodRequestUrgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
export type MealRequestHistoryAction =
  | 'CREATED_FOOD_REQUEST'
  | 'UPDATED_FOOD_REQUEST'
  | 'APPROVED_FOOD_REQUEST'
  | 'REJECTED_FOOD_REQUEST'
  | 'REQUESTED_FOOD_ADJUSTMENT'
  | 'CANCELLED_FOOD_REQUEST'
  | 'ADDED_FOOD_REQUEST_TO_STOCK'
  | 'CORRECTED_MEAL_STOCK'
  | 'REMOVED_MEAL_STOCK_ITEM'
export type NotificationTone = 'warning' | 'danger' | 'info'
export type NotificationSourceType = 'student-risk' | 'system'

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
  avatarObject?: StoredImageObject | null
  bannerObject?: StoredImageObject | null
  linkedTeacherId?: string
  linkedStudentId?: string
  linkedGuardianId?: string
}

export type PublicUserAccount = Omit<UserAccount, 'password'>

export interface StoredImageObject {
  storageProvider: 'local' | 'bucket'
  bucket: string
  key: string
  publicUrl: string
  contentType: string
  sizeBytes: number
  originalName: string
  uploadedAt: string
}

export interface RefreshSession {
  id: string
  userId: string
  jti?: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  revokedAt?: string
  rotatedFromId?: string
  userAgent?: string
  ip?: string
  ipHash?: string
}

export interface IdempotencyRecord {
  id: string
  scopeKey: string
  key: string
  actorId: string
  schoolId: string | null
  operation: string
  resourceId: string | null
  payloadHash: string
  status: IdempotencyStatus
  response?: unknown
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
  lockedUntil?: string | null
}

export interface AppNotification {
  id: string
  userId: string
  title: string
  description: string
  tone: NotificationTone
  sourceType: NotificationSourceType
  sourceId: string
  readAt: string | null
  createdAt: string
  updatedAt: string
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
  avatarUrl?: string
  bannerUrl?: string
  avatarObject?: StoredImageObject | null
  bannerObject?: StoredImageObject | null
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
  avatarUrl?: string
  bannerUrl?: string
  avatarObject?: StoredImageObject | null
  bannerObject?: StoredImageObject | null
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
  avatarUrl?: string
  bannerUrl?: string
  avatarObject?: StoredImageObject | null
  bannerObject?: StoredImageObject | null
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
  schoolId?: string
  teacherId?: string
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
  questionSnapshots?: Question[]
  skillCodes?: string[]
  descriptorCodes?: string[]
  sourceSummary?: string
  omrCardVersion?: string
  idempotencyKey?: string
  createdById?: string
  createdByName?: string
  createdBy?: {
    id?: string
    name?: string
    email?: string
  }
}

export interface EvaluationAnswerCard {
  id: string
  cardId: string
  schoolId: string
  classId: string
  subject: string
  evaluationId: string
  studentId: string
  studentName: string
  teacherId: string
  qrPayload: string
  status: 'GENERATED' | 'PRINTED' | 'USED' | 'CANCELLED'
  createdAt: string
  updatedAt: string
}

export interface EvaluationAnswerKeyItem {
  questionNumber: number
  questionId: string
  correctOption: string
}

export interface EvaluationCorrectionOptionScore {
  option: string
  fillRatio: number
}

export interface EvaluationCorrectionDetectedAnswer {
  questionNumber: number
  questionId: string | null
  detectedOption: string | null
  correctOption: string
  isCorrect: boolean
  status: 'ok' | 'blank' | 'multiple' | 'low_confidence' | 'unreadable'
  confidence: number
  markedOptions: string[]
  optionScores: EvaluationCorrectionOptionScore[]
}

export interface EvaluationCorrection {
  id: string
  schoolId?: string
  evaluationId: string
  classId: string
  studentId: string
  studentName?: string
  cardId?: string | null
  subject?: string
  status: EvaluationCorrectionStatus
  imageUrl: string | null
  imageObject: StoredImageObject | null
  suggestedScore: number
  finalScore: number | null
  correctCount: number
  wrongCount: number
  blankCount: number
  multipleCount: number
  totalQuestions: number
  confidence: number
  requiresReview: boolean
  shouldRetakeImage: boolean
  failures: string[]
  detectedAnswers: EvaluationCorrectionDetectedAnswer[]
  answerKey: EvaluationAnswerKeyItem[]
  rawOmrResponse: Record<string, unknown>
  teacherNotes: string | null
  reviewedById: string | null
  reviewedAt: string | null
  createdById: string
  createdAt: string
  updatedAt: string
}

export interface EvaluationCorrectionReviewPayload {
  status?: EvaluationCorrectionStatus
  finalScore?: number | null
  detectedAnswers?: EvaluationCorrectionDetectedAnswer[]
  teacherNotes?: string | null
}

export interface LessonRecord {
  id: string
  classId: string
  subject: string
  date: string
  time: string
  content: string
  plan: string
  resources: string
  activity: string
  notes: string
  attendance?: Record<string, boolean>
}

export interface RoomReservation {
  id: string
  room: string
  date: string
  startTime: string
  endTime: string
  classId: string
  purpose: string
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
  context?: string
  statement: string
  explanation?: string
  type: QuestionType
  stage: EducationStage
  gradeLevel: string
  area: string
  component: string
  subject: string
  difficulty: Difficulty
  sourceType: QuestionSourceType
  sourceName: string
  sourceYear?: number | null
  sourceExternalId?: string | null
  sourceUrl?: string | null
  licenseNotes?: string | null
  visibility: QuestionVisibility
  options: Array<Pick<QuestionOption, 'label' | 'text' | 'order' | 'isCorrect'>>
  skillIds: string[]
  descriptorIds?: string[]
  attachments?: unknown[]
  metadata?: Partial<QuestionMetadata> & { requestedStatus?: QuestionStatus }
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

export interface GenerateQuestionSelectionRequest {
  quantity: number
  subject: string
  gradeLevel?: string | null
  difficulty?: Difficulty | null
  sourceMode: QuestionSelectionSourceMode
  skillCode?: string | null
  descriptorCode?: string | null
}

export interface GenerateQuestionSelectionResponse {
  questions: Question[]
  questionIds: string[]
  totalEligible: number
}

export interface SchoolCalendarEvent {
  id: string
  title: string
  type: CalendarEventType
  schoolId: string
  classId: string | null
  createdById: string
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
  unidadeMedida: MealUnit
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
  unidadeMedida: MealUnit
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
  unidadeMedida: MealUnit
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

export interface MealFoodRequest {
  id: string
  schoolId: string
  requestedBy: string
  itemName: string
  quantity: number
  unit: MealUnit
  unitPrice?: number | null
  reason: string
  urgencyLevel: FoodRequestUrgency
  expirationDate: string | null
  observation: string | null
  status: FoodRequestStatus
  reviewedBy?: string | null
  reviewedAt?: string | null
  nutritionistObservation?: string | null
  rejectionReason?: string | null
  suggestedQuantity?: number | null
  suggestedUnit?: MealUnit | null
  suggestedUnitPrice?: number | null
  confirmedBy?: string | null
  confirmedAt?: string | null
  supplierName?: string | null
  purchaseValue?: number | null
  purchaseDate?: string | null
  stockItemId?: string | null
  createdAt: string
  updatedAt: string
}

export interface MealRequestHistory {
  id: string
  action: MealRequestHistoryAction
  entityType: 'FOOD_REQUEST' | 'MEAL_STOCK'
  entityId: string
  userId: string
  userRole: RoleCode
  schoolId: string
  oldValue?: unknown
  newValue?: unknown
  description: string
  createdAt: string
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

export interface CreateMealFoodRequestPayload {
  schoolId?: string
  itemName: string
  quantity: number
  unit: MealUnit
  unitPrice?: number | null
  reason: string
  urgencyLevel: FoodRequestUrgency
  expirationDate?: string | null
  observation?: string | null
}

export type UpdateMealFoodRequestPayload = Partial<CreateMealFoodRequestPayload>

export interface ReviewMealFoodRequestPayload {
  action: 'APPROVE' | 'REJECT' | 'REQUEST_ADJUSTMENT'
  nutritionistObservation?: string | null
  rejectionReason?: string | null
  suggestedQuantity?: number | null
  suggestedUnit?: MealUnit | null
  suggestedUnitPrice?: number | null
}

export interface AddMealFoodRequestToStockPayload {
  fornecedorNome?: string | null
  valorUnitario?: number | null
  dataCompra?: string | null
  dataValidade?: string | null
  observacao?: string | null
  quantidadeMinima?: number | null
}

export interface CreateMealFoodPayload {
  nome: string
  categoria: string
  unidadeMedida: MealUnit
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
  idempotencyRecords: IdempotencyRecord[]
  notifications: AppNotification[]
  roles: Role[]
  schools: School[]
  teachers: Teacher[]
  guardians: Guardian[]
  students: Student[]
  classes: ClassRoom[]
  evaluations: Evaluation[]
  answerCards: EvaluationAnswerCard[]
  evaluationCorrections: EvaluationCorrection[]
  curriculumBases: CurriculumBase[]
  curriculumSkills: CurriculumSkill[]
  assessmentPrograms: AssessmentProgram[]
  assessmentMatrices: AssessmentMatrix[]
  assessmentDescriptors: AssessmentDescriptor[]
  questions: Question[]
  questionImportPlans: QuestionImportPlan[]
  lessonRecords: LessonRecord[]
  roomReservations: RoomReservation[]
  calendarEvents: SchoolCalendarEvent[]
  mealFoods: MealFood[]
  mealManagements: MealManagement[]
  mealFoodRequests: MealFoodRequest[]
  mealRequestHistory: MealRequestHistory[]
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

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
}

export interface TeachersPagePayload {
  teachers: Teacher[]
  pagination: PaginationMeta
}

export interface StudentsPagePayload {
  students: Student[]
  pagination: PaginationMeta
}

export interface NotificationsScreenPayload {
  notifications: AppNotification[]
  unreadCount: number
  totalCount: number
}

export interface JwtPayload {
  sub: string
  typ: 'access' | 'refresh'
  sid?: string
  jti?: string
}
