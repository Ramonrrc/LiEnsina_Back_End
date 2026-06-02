import { Type } from 'class-transformer'
import { Allow, ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength, registerDecorator, ValidateNested, type ValidationArguments, type ValidationOptions } from 'class-validator'
import type { AttachmentPosition, AttachmentType, CalendarEventType, Difficulty, EducationStage, EvaluationBuildMode, EvaluationCorrectionDetectedAnswer, FoodRequestUrgency, MealMenuStatus, MealShift, MealType, MealUnit, QuestionSelectionSourceMode, QuestionSourceType, QuestionType, QuestionVisibility, RoleCode } from './liensina.types'

export class LoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  email!: string

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  password!: string
}

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25
}

export class ResourceListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string

  @IsOptional()
  @IsString()
  schoolId?: string

  @IsOptional()
  @IsString()
  classId?: string

  @IsOptional()
  @IsString()
  subjectId?: string

  @IsOptional()
  @IsString()
  subject?: string

  @IsOptional()
  @IsString()
  discipline?: string

  @IsOptional()
  @IsString()
  teacherId?: string

  @IsOptional()
  @IsString()
  studentId?: string

  @IsOptional()
  @IsString()
  role?: string

  @IsOptional()
  @IsIn(['planejado', 'em_aplicacao', 'corrigindo', 'concluido', 'all'])
  examStatus?: string

  @IsOptional()
  @IsString()
  view?: string

  @IsOptional()
  @IsIn(['SUGGESTED', 'CONFIRMED', 'NEEDS_RETAKE', 'REJECTED', 'all'])
  status?: string
}

export class QuestionBankPageQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  search?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(40)
  gradeLevel?: string | null

  @IsOptional()
  @IsIn(['EASY', 'MEDIUM', 'HARD', 'all'])
  difficulty?: Difficulty | 'all' | null

  @IsOptional()
  @IsIn(['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED', 'all'])
  status?: string | null

  @IsOptional()
  @IsIn(['TEACHER_CREATED', 'SECRETARY_CREATED', 'AI_GENERATED', 'INEP_ENEM', 'IMPORTED_SPREADSHEET', 'SCHOOL_BANK', 'GLOBAL_CURATED', 'all'])
  sourceType?: QuestionSourceType | 'all' | null

  @IsOptional()
  @IsString()
  @MaxLength(120)
  schoolId?: string | 'all' | null

  @IsOptional()
  @IsString()
  @MaxLength(120)
  createdById?: string | 'all' | null

  @IsOptional()
  @IsString()
  @MaxLength(80)
  skillCode?: string | 'all' | null

  @IsOptional()
  @IsString()
  @MaxLength(80)
  descriptorCode?: string | 'all' | null

  @IsOptional()
  @IsString()
  @MaxLength(120)
  subject?: string | 'all' | null

  @IsOptional()
  @IsIn(['system', 'enem', 'mixed', 'all'])
  sourceMode?: QuestionSelectionSourceMode | 'all' | null

  @IsOptional()
  @IsIn(['true', 'false', true, false])
  includeFacets?: boolean | string | null

  @IsOptional()
  @IsIn(['bank', 'auto'])
  facetsMode?: 'bank' | 'auto' | null
}

export class CreateTeacherAssignmentDto {
  @IsString()
  teacherId!: string

  @IsString()
  schoolId!: string

  @IsString()
  classId!: string

  @IsString()
  subjectId!: string
}

export class ManualCorrectionDto {
  @IsString()
  evaluationId!: string

  @IsString()
  studentId!: string

  @IsOptional()
  @Type(() => Number)
  finalScore?: number

  @IsOptional()
  @IsIn(['SUGGESTED', 'CONFIRMED', 'NEEDS_RETAKE', 'REJECTED'])
  status?: 'SUGGESTED' | 'CONFIRMED' | 'NEEDS_RETAKE' | 'REJECTED'

  @IsOptional()
  @IsString()
  teacherNotes?: string
}

export class EvaluationMutationDto {
  @IsString()
  @MaxLength(160)
  title!: string

  @IsString()
  @MaxLength(120)
  classId!: string

  @IsString()
  @MaxLength(120)
  subject!: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(180)
  questions?: number

  @IsString()
  @MaxLength(80)
  scheduledAt!: string

  @IsOptional()
  @IsString()
  @MaxLength(80)
  omrCardVersion?: string

  @IsOptional()
  @IsIn(['automatic_bank', 'manual_bank', 'teacher_created', 'mixed'])
  buildMode?: EvaluationBuildMode

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  questionIds?: string[]

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  skillCodes?: string[]

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  descriptorCodes?: string[]

  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceSummary?: string
}

export class EvaluationCorrectionReviewDto {
  @IsOptional()
  @IsIn(['SUGGESTED', 'CONFIRMED', 'NEEDS_RETAKE', 'REJECTED'])
  status?: 'SUGGESTED' | 'CONFIRMED' | 'NEEDS_RETAKE' | 'REJECTED'

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10)
  finalScore?: number | null

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(180)
  detectedAnswers?: EvaluationCorrectionDetectedAnswer[]

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  teacherNotes?: string | null
}

export class EvaluationCorrectionConfirmManyItemDto {
  @IsString()
  @MaxLength(120)
  id!: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10)
  finalScore?: number | null

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  teacherNotes?: string | null
}

export class EvaluationCorrectionConfirmManyDto {
  @IsArray()
  @ArrayMaxSize(120)
  @ValidateNested({ each: true })
  @Type(() => EvaluationCorrectionConfirmManyItemDto)
  corrections!: EvaluationCorrectionConfirmManyItemDto[]
}

export class CreateMealFoodRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  schoolId?: string

  @IsString()
  @MaxLength(160)
  itemName!: string

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(1_000_000)
  quantity!: number

  @IsIn(['KG', 'G', 'L', 'ML', 'UNIT', 'BOX', 'PACKAGE', 'DOZEN'])
  unit!: MealUnit

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000)
  unitPrice?: number | null

  @IsString()
  @MaxLength(1000)
  reason!: string

  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
  urgencyLevel!: FoodRequestUrgency

  @IsOptional()
  @IsDateString()
  expirationDate?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observation?: string | null
}

export class UpdateMealFoodRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  schoolId?: string

  @IsOptional()
  @IsString()
  @MaxLength(160)
  itemName?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(1_000_000)
  quantity?: number

  @IsOptional()
  @IsIn(['KG', 'G', 'L', 'ML', 'UNIT', 'BOX', 'PACKAGE', 'DOZEN'])
  unit?: MealUnit

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000)
  unitPrice?: number | null

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string

  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
  urgencyLevel?: FoodRequestUrgency

  @IsOptional()
  @IsDateString()
  expirationDate?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observation?: string | null
}

export class MealManagementResponsiblesDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  diretorId?: string

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nutricionistaId?: string

  @IsOptional()
  @IsString()
  @MaxLength(120)
  merendeiroId?: string

  @IsOptional()
  @IsString()
  @MaxLength(120)
  responsavelFinanceiroId?: string
}

export class CreateMealFoodDto {
  @IsString()
  @MaxLength(160)
  nome!: string

  @IsString()
  @MaxLength(100)
  categoria!: string

  @IsIn(['KG', 'G', 'L', 'ML', 'UNIT', 'BOX', 'PACKAGE', 'DOZEN'])
  unidadeMedida!: MealUnit

  @IsOptional()
  @IsString()
  @MaxLength(80)
  iconKey?: string

  @IsOptional()
  @IsBoolean()
  ativo?: boolean
}

export class CreateMealManagementDto {
  @IsString()
  @MaxLength(120)
  escolaId!: string

  @IsString()
  @MaxLength(20)
  mesReferencia!: string

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(100_000_000)
  valorLimite!: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  alertaAoAtingirPercentual?: number

  @IsOptional()
  @IsBoolean()
  permitirUltrapassarLimite?: boolean

  @IsOptional()
  @ValidateNested()
  @Type(() => MealManagementResponsiblesDto)
  responsaveisGestao?: MealManagementResponsiblesDto

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateMealFoodDto)
  alimentosCadastrados?: CreateMealFoodDto[]
}

export class UpdateMealBudgetDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(100_000_000)
  valorLimite?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  alertaAoAtingirPercentual?: number

  @IsOptional()
  @IsBoolean()
  permitirUltrapassarLimite?: boolean
}

export class CreateMealMenuDto {
  @IsString()
  @MaxLength(40)
  diaSemana!: string

  @IsIn(['CAFE_DA_MANHA', 'LANCHE', 'ALMOCO', 'JANTAR'])
  tipoRefeicao!: MealType

  @IsIn(['MANHA', 'TARDE', 'NOITE', 'INTEGRAL'])
  turno!: MealShift

  @IsString()
  @MaxLength(160)
  titulo!: string

  @IsArray()
  @ArrayMaxSize(80)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  alimentoIds!: number[]

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  observacao?: string
}

export class CreateMealItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  alimentoId!: number

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(1_000_000)
  quantidade!: number

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000)
  valorUnitario!: number

  @IsOptional()
  @IsDateString()
  dataValidade?: string | null

  @IsOptional()
  @IsBoolean()
  possuiValidade?: boolean

  @IsOptional()
  @IsString()
  @MaxLength(120)
  lote?: string | null

  @IsString()
  @MaxLength(160)
  fornecedorNome!: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  quantidadeMinima?: number
}

export class ReviewMealFoodRequestDto {
  @IsIn(['APPROVE', 'REJECT', 'REQUEST_ADJUSTMENT'])
  action!: 'APPROVE' | 'REJECT' | 'REQUEST_ADJUSTMENT'

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  nutritionistObservation?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  rejectionReason?: string | null

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(1_000_000)
  suggestedQuantity?: number | null

  @IsOptional()
  @IsIn(['KG', 'G', 'L', 'ML', 'UNIT', 'BOX', 'PACKAGE', 'DOZEN'])
  suggestedUnit?: MealUnit | null

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000)
  suggestedUnitPrice?: number | null
}

export class AddMealFoodRequestToStockDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  fornecedorNome?: string | null

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000)
  valorUnitario?: number | null

  @IsOptional()
  @IsDateString()
  dataCompra?: string | null

  @IsOptional()
  @IsDateString()
  dataValidade?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  observacao?: string | null

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  quantidadeMinima?: number | null
}

export class EmptyBodyDto {
  @Allow()
  readonly __empty?: never
}

export class SchoolMutationDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string
  @IsOptional() @IsString() @MaxLength(120) city?: string
  @IsOptional() @IsString() @MaxLength(240) address?: string
  @IsOptional() @IsString() @MaxLength(160) director?: string
  @IsOptional() @IsString() @MaxLength(40) inepCode?: string
  @IsOptional() @IsBoolean() active?: boolean
}

export class CreateSchoolDto {
  @IsString() @MaxLength(160) name!: string
  @IsString() @MaxLength(120) city!: string
  @IsString() @MaxLength(240) address!: string
  @IsString() @MaxLength(160) director!: string
  @IsString() @MaxLength(40) inepCode!: string
  @IsOptional() @IsBoolean() active?: boolean
}

export class ClassRoomMutationDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string
  @IsOptional() @IsString() @MaxLength(40) grade?: string
  @IsOptional() @IsIn(['Manha', 'Tarde', 'Noite']) shift?: 'Manha' | 'Tarde' | 'Noite'
  @IsOptional() @IsString() @MaxLength(120) schoolId?: string
  @IsOptional() @IsString() @MaxLength(120) teacherId?: string
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(120, { each: true }) teacherIds?: string[]
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) academicYear?: number
  @IsOptional() @IsString() @MaxLength(1000) schedule?: string
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(120, { each: true }) bnccFocus?: string[]
}

export class CreateClassRoomDto {
  @IsString() @MaxLength(120) name!: string
  @IsString() @MaxLength(40) grade!: string
  @IsOptional() @IsIn(['Manha', 'Tarde', 'Noite']) shift?: 'Manha' | 'Tarde' | 'Noite'
  @IsString() @MaxLength(120) schoolId!: string
  @IsString() @MaxLength(120) teacherId!: string
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(120, { each: true }) teacherIds?: string[]
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) academicYear?: number
  @IsString() @MaxLength(1000) schedule!: string
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(120, { each: true }) bnccFocus?: string[]
}

export class CreateTeacherDto {
  @IsString() @MaxLength(160) name!: string
  @IsEmail() @MaxLength(160) email!: string
  @IsString() @MaxLength(120) schoolId!: string
  @IsString() @MaxLength(120) specialty!: string
  @IsString() @MinLength(8) @MaxLength(120) password!: string
  @IsOptional() @IsString() @MaxLength(80) phone?: string
  @IsOptional() @IsString() @MaxLength(120) classId?: string
}

export class UpdateTeacherDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string
  @IsOptional() @IsEmail() @MaxLength(160) email?: string
  @IsOptional() @IsString() @MaxLength(120) schoolId?: string
  @IsOptional() @IsString() @MaxLength(120) specialty?: string
  @IsOptional() @IsBoolean() active?: boolean
  @IsOptional() @IsString() @MaxLength(120) classId?: string
}

export class CreateStudentDto {
  @IsString() @MaxLength(160) name!: string
  @IsString() @MaxLength(120) schoolId!: string
  @IsString() @MaxLength(120) classId!: string
  @IsString() @MinLength(8) @MaxLength(120) password!: string
  @IsOptional() @IsString() @MaxLength(80) registration?: string
  @IsOptional() @IsString() @MaxLength(80) registrationNumber?: string
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) guardianIds?: string[]
}

export class UpdateStudentDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string
  @IsOptional() @IsString() @MaxLength(120) schoolId?: string
  @IsOptional() @IsString() @MaxLength(120) classId?: string
  @IsOptional() @IsString() @MaxLength(80) registration?: string
  @IsOptional() @IsString() @MaxLength(80) registrationNumber?: string
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) guardianIds?: string[]
}

export class CreateGuardianDto {
  @IsString() @MaxLength(160) name!: string
  @IsEmail() @MaxLength(160) email!: string
  @IsString() @MaxLength(120) schoolId!: string
  @IsString() @MinLength(8) @MaxLength(120) password!: string
  @IsOptional() @IsString() @MaxLength(80) phone?: string
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) studentIds?: string[]
}

export class UpdateGuardianDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string
  @IsOptional() @IsEmail() @MaxLength(160) email?: string
  @IsOptional() @IsString() @MaxLength(120) schoolId?: string
  @IsOptional() @IsString() @MaxLength(80) phone?: string
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) studentIds?: string[]
}

export class UpdateEvaluationDto {
  @IsOptional() @IsString() @MaxLength(160) title?: string
  @IsOptional() @IsString() @MaxLength(120) classId?: string
  @IsOptional() @IsString() @MaxLength(120) subject?: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(180) questions?: number
  @IsOptional() @IsString() @MaxLength(80) scheduledAt?: string
  @IsOptional() @IsString() @MaxLength(80) omrCardVersion?: string
  @IsOptional() @IsIn(['automatic_bank', 'manual_bank', 'teacher_created', 'mixed']) buildMode?: EvaluationBuildMode
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(120, { each: true }) questionIds?: string[]
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) @MaxLength(80, { each: true }) skillCodes?: string[]
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) @MaxLength(80, { each: true }) descriptorCodes?: string[]
  @IsOptional() @IsString() @MaxLength(500) sourceSummary?: string
}

export class AddExamQuestionsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  questionIds!: string[]
}

export class QuestionReviewDto {
  @IsIn(['APPROVE', 'REJECT'])
  action!: 'APPROVE' | 'REJECT'

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  reason?: string | null
}

export class QuestionOptionInputDto {
  @IsString()
  @MaxLength(8)
  label!: string

  @IsString()
  @MaxLength(5000)
  text!: string

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  order!: number

  @IsBoolean()
  isCorrect!: boolean
}

export class QuestionMetadataInputDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7200)
  estimatedTimeSeconds?: number

  @IsOptional()
  @IsBoolean()
  hasImage?: boolean

  @IsOptional()
  @IsBoolean()
  hasTable?: boolean

  @IsOptional()
  @IsBoolean()
  hasFormula?: boolean

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  keywords?: string[]
}

export class QuestionAttachmentInputDto {
  @IsString()
  @MaxLength(1000)
  fileUrl!: string

  @IsIn(['IMAGE', 'PDF', 'AUDIO', 'VIDEO'])
  fileType!: AttachmentType

  @IsIn(['CONTEXT', 'STATEMENT', 'OPTION', 'EXPLANATION'])
  position!: AttachmentPosition

  @IsString()
  @MaxLength(500)
  altText!: string

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  order!: number
}

export class CreateQuestionDto {
  @IsString()
  @MaxLength(180)
  title!: string

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  context?: string

  @IsString()
  @MaxLength(12000)
  statement!: string

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  explanation?: string

  @IsIn(['MULTIPLE_CHOICE'])
  type!: QuestionType

  @IsIn(['INFANTIL', 'FUNDAMENTAL', 'MEDIO', 'EJA'])
  stage!: EducationStage

  @IsString()
  @MaxLength(40)
  gradeLevel!: string

  @IsString()
  @MaxLength(120)
  area!: string

  @IsString()
  @MaxLength(120)
  component!: string

  @IsString()
  @MaxLength(120)
  subject!: string

  @IsIn(['EASY', 'MEDIUM', 'HARD'])
  difficulty!: Difficulty

  @IsIn(['TEACHER_CREATED', 'SECRETARY_CREATED', 'AI_GENERATED', 'INEP_ENEM', 'IMPORTED_SPREADSHEET', 'SCHOOL_BANK', 'GLOBAL_CURATED'])
  sourceType!: QuestionSourceType

  @IsString()
  @MaxLength(180)
  sourceName!: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2100)
  sourceYear?: number | null

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sourceExternalId?: string | null

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(1000)
  sourceUrl?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  licenseNotes?: string | null

  @IsIn(['PRIVATE', 'SCHOOL', 'NETWORK', 'GLOBAL'])
  visibility!: QuestionVisibility

  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionInputDto)
  options!: QuestionOptionInputDto[]

  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  skillIds!: string[]

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  descriptorIds?: string[]

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => QuestionAttachmentInputDto)
  attachments?: QuestionAttachmentInputDto[]

  @IsOptional()
  @ValidateNested()
  @Type(() => QuestionMetadataInputDto)
  metadata?: QuestionMetadataInputDto
}

export class GenerateQuestionSelectionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  quantity!: number

  @IsString()
  @MaxLength(120)
  subject!: string

  @IsOptional()
  @IsString()
  @MaxLength(40)
  gradeLevel?: string | null

  @IsOptional()
  @IsIn(['EASY', 'MEDIUM', 'HARD'])
  difficulty?: Difficulty | null

  @IsIn(['system', 'enem', 'mixed'])
  sourceMode!: QuestionSelectionSourceMode

  @IsOptional()
  @IsString()
  @MaxLength(80)
  skillCode?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(80)
  descriptorCode?: string | null
}

export class MealMenuMutationDto {
  @IsOptional() @IsString() @MaxLength(40) diaSemana?: string
  @IsOptional() @IsIn(['CAFE_DA_MANHA', 'LANCHE', 'ALMOCO', 'JANTAR']) tipoRefeicao?: MealType
  @IsOptional() @IsIn(['MANHA', 'TARDE', 'NOITE', 'INTEGRAL']) turno?: MealShift
  @IsOptional() @IsString() @MaxLength(160) titulo?: string
  @IsOptional() @IsArray() @ArrayMaxSize(80) @Type(() => Number) @IsInt({ each: true }) alimentoIds?: number[]
  @IsOptional() @IsString() @MaxLength(1200) observacao?: string
  @IsOptional() @IsIn(['RASCUNHO', 'APROVADO', 'CANCELADO']) status?: MealMenuStatus
}

export class CreateRoomReservationDto {
  @IsString() @MaxLength(80) room!: string
  @IsString() @MaxLength(40) date!: string
  @IsString() @MaxLength(20) startTime!: string
  @IsString() @MaxLength(20) endTime!: string
  @IsString() @MaxLength(120) classId!: string
  @IsString() @MaxLength(500) purpose!: string
}

export class RoomReservationMutationDto {
  @IsOptional() @IsString() @MaxLength(80) room?: string
  @IsOptional() @IsString() @MaxLength(40) date?: string
  @IsOptional() @IsString() @MaxLength(20) startTime?: string
  @IsOptional() @IsString() @MaxLength(20) endTime?: string
  @IsOptional() @IsString() @MaxLength(120) classId?: string
  @IsOptional() @IsString() @MaxLength(500) purpose?: string
}

function IsAttendanceMap(validationOptions?: ValidationOptions) {
  return function decorateAttendanceMap(object: object, propertyName: string) {
    registerDecorator({
      name: 'isAttendanceMap',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null) return true
          if (typeof value !== 'object' || Array.isArray(value)) return false
          const entries = Object.entries(value as Record<string, unknown>)
          if (entries.length > 120) return false
          return entries.every(([studentId, present]) => (
            studentId.length > 0 &&
            studentId.length <= 120 &&
            typeof present === 'boolean'
          ))
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} deve mapear no maximo 120 IDs de alunos para booleanos.`
        },
      },
    })
  }
}

export class CreateLessonRecordDto {
  @IsString() @MaxLength(120) classId!: string
  @IsString() @MaxLength(120) subject!: string
  @IsString() @MaxLength(40) date!: string
  @IsString() @MaxLength(20) time!: string
  @IsString() @MaxLength(5000) content!: string
  @IsString() @MaxLength(5000) plan!: string
  @IsString() @MaxLength(2000) resources!: string
  @IsString() @MaxLength(3000) activity!: string
  @IsOptional() @IsString() @MaxLength(2000) notes?: string
  @IsOptional() @IsAttendanceMap() attendance?: Record<string, boolean>
}

export class LessonRecordMutationDto {
  @IsOptional() @IsString() @MaxLength(120) classId?: string
  @IsOptional() @IsString() @MaxLength(120) subject?: string
  @IsOptional() @IsString() @MaxLength(40) date?: string
  @IsOptional() @IsString() @MaxLength(20) time?: string
  @IsOptional() @IsString() @MaxLength(5000) content?: string
  @IsOptional() @IsString() @MaxLength(5000) plan?: string
  @IsOptional() @IsString() @MaxLength(2000) resources?: string
  @IsOptional() @IsString() @MaxLength(3000) activity?: string
  @IsOptional() @IsString() @MaxLength(2000) notes?: string
  @IsOptional() @IsAttendanceMap() attendance?: Record<string, boolean>
}

export class CreateCalendarEventDto {
  @IsString() @MaxLength(160) title!: string
  @IsIn(['aula', 'reuniao', 'avaliacao', 'prazo', 'evento']) type!: CalendarEventType
  @IsString() @MaxLength(120) schoolId!: string
  @IsOptional() @IsString() @MaxLength(120) classId?: string | null
  @IsString() @MaxLength(80) startsAt!: string
  @IsString() @MaxLength(80) endsAt!: string
  @IsOptional() @IsBoolean() allDay?: boolean
  @IsOptional() @IsString() @MaxLength(240) location?: string
  @IsOptional() @IsString() @MaxLength(3000) description?: string
}

export class CalendarEventMutationDto {
  @IsOptional() @IsString() @MaxLength(160) title?: string
  @IsOptional() @IsIn(['aula', 'reuniao', 'avaliacao', 'prazo', 'evento']) type?: CalendarEventType
  @IsOptional() @IsString() @MaxLength(120) schoolId?: string
  @IsOptional() @IsString() @MaxLength(120) classId?: string | null
  @IsOptional() @IsString() @MaxLength(80) startsAt?: string
  @IsOptional() @IsString() @MaxLength(80) endsAt?: string
  @IsOptional() @IsBoolean() allDay?: boolean
  @IsOptional() @IsString() @MaxLength(240) location?: string
  @IsOptional() @IsString() @MaxLength(3000) description?: string
}

export class RoleMutationDto {
  @IsOptional() @IsIn(['ADMIN', 'DIRETOR', 'COORDENADOR', 'PROFESSOR', 'ALUNO', 'RESPONSAVEL', 'NUTRITIONIST']) name?: RoleCode
  @IsOptional() @IsString() @MaxLength(500) description?: string
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(120, { each: true }) permissions?: string[]
}

export class UpdateUserRoleDto {
  @IsString()
  @MaxLength(120)
  roleId!: string
}

export class UpdateUserSchoolDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  schoolId!: string | null
}

export class ProfileMutationDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string
  @IsOptional() @IsEmail() @MaxLength(160) email?: string
  @IsOptional() @IsString() @MaxLength(80) phone?: string
  @IsOptional() @IsString() @MaxLength(80) cpf?: string
  @IsOptional() @IsString() @MaxLength(40) birthDate?: string
}
