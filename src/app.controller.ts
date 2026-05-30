import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, Param, Patch, Post, Query, Req, Res, UploadedFile, UploadedFiles, UseGuards, UseInterceptors, UnauthorizedException } from '@nestjs/common'
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express'
import type { Request, Response } from 'express'

import { AuthGuard, type RequestWithUser } from './auth.guard'
import { DatabaseService } from './database.service'
import { LiensinaService } from './liensina.service'
import { RateLimitService } from './rate-limit.service'
import { ResourceAccessService } from './resource-access.service'
import {
  AddMealFoodRequestToStockDto,
  CalendarEventMutationDto,
  ClassRoomMutationDto,
  CreateCalendarEventDto,
  CreateClassRoomDto,
  CreateGuardianDto,
  CreateLessonRecordDto,
  CreateMealFoodDto,
  CreateMealFoodRequestDto,
  CreateMealItemDto,
  CreateMealMenuDto,
  CreateMealManagementDto,
  CreateQuestionDto,
  CreateRoomReservationDto,
  CreateSchoolDto,
  CreateStudentDto,
  CreateTeacherDto,
  EvaluationCorrectionConfirmManyDto,
  EvaluationCorrectionReviewDto,
  EvaluationMutationDto,
  GenerateQuestionSelectionDto,
  LessonRecordMutationDto,
  LoginDto,
  MealMenuMutationDto,
  ProfileMutationDto,
  QuestionBankPageQueryDto,
  QuestionReviewDto,
  ResourceListQueryDto,
  ReviewMealFoodRequestDto,
  RoleMutationDto,
  SchoolMutationDto,
  UpdateGuardianDto,
  UpdateMealBudgetDto,
  UpdateMealFoodRequestDto,
  UpdateStudentDto,
  UpdateTeacherDto,
  UpdateUserRoleDto,
  UpdateUserSchoolDto,
} from './resource-query.dto'
import type { CreateQuestionRequest } from './liensina.types'

type UploadedProfileImageFile = {
  buffer: Buffer
  originalname: string
  mimetype: string
  size: number
}

type UploadedOmrImageFile = UploadedProfileImageFile

const refreshCookieName = 'liensina_refresh_token'
const maxAvatarUploadBytes = 10 * 1024 * 1024
const maxBannerUploadBytes = 15 * 1024 * 1024
const maxOmrUploadBytes = 16 * 1024 * 1024
const maxOmrBatchFiles = 20
const maxOmrBatchUploadBytes = 48 * 1024 * 1024

@Controller()
export class AppController {
  constructor(
    private readonly liensinaService: LiensinaService,
    private readonly databaseService: DatabaseService,
    private readonly rateLimitService: RateLimitService,
    private readonly resourceAccessService: ResourceAccessService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok' }
  }

  @Post('auth/login')
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.assertAuthAttemptAllowed(request, 'auth:login', body?.email)
    const result = await this.liensinaService.login(body?.email ?? '', body?.password ?? '', this.getAuthContext(request))
    this.setRefreshCookie(response, result.refreshToken, result.refreshExpiresAt)
    const { refreshToken: _refreshToken, refreshExpiresAt: _refreshExpiresAt, ...publicResult } = result
    return publicResult
  }

  @Post('auth/refresh')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertCsrfRequestAllowed(request)
    await this.assertAuthAttemptAllowed(request, 'auth:refresh')
    const refreshToken = this.getRefreshToken(request)
    if (!refreshToken) throw new UnauthorizedException('Refresh token ausente.')

    const result = await this.liensinaService.refreshLogin(refreshToken, this.getAuthContext(request))
    this.setRefreshCookie(response, result.refreshToken, result.refreshExpiresAt)
    const { refreshToken: _refreshToken, refreshExpiresAt: _refreshExpiresAt, ...publicResult } = result
    return publicResult
  }

  @Post('auth/logout')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertCsrfRequestAllowed(request)
    await this.assertAuthAttemptAllowed(request, 'auth:logout')
    const refreshToken = this.getRefreshToken(request)
    const result = this.liensinaService.logout(refreshToken ?? '')
    this.clearRefreshCookie(response)
    return result
  }

  @UseGuards(AuthGuard)
  @Get('session')
  session(@Req() request: RequestWithUser) {
    return this.liensinaService.getSession(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('me')
  me(@Req() request: RequestWithUser) {
    return this.resourceAccessService.getMe(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('me/permissions')
  mePermissions(@Req() request: RequestWithUser) {
    return this.resourceAccessService.getPermissions(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('me/schools')
  listMySchools(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.getMeSchools(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/classes')
  listMyClasses(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.getMeClasses(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/teachers')
  listMyTeachers(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listTeachers(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/guardians')
  listMyGuardians(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listGuardians(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/students')
  listMyStudents(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listStudents(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/exams')
  listMyExams(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listExams(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/exams/:id/download')
  async downloadMyEvaluation(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Query('kind') kind = 'complete',
    @Query('type') type = '',
    @Res() response: Response,
  ) {
    const file = await this.liensinaService.getStudentEvaluationDownload(request.user!.id, id, type || kind)
    response.setHeader('Content-Type', file.contentType)
    response.setHeader('Content-Disposition', this.contentDispositionAttachment(file.filename))
    response.setHeader('Cache-Control', 'no-store')
    return response.sendFile(file.filePath)
  }

  @UseGuards(AuthGuard)
  @Get('me/exam-corrections')
  listMyExamCorrections(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listExamCorrections(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/exam-corrections/:id')
  getMyExamCorrection(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.resourceAccessService.getExamCorrection(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Get('me/exam-corrections/:id/image')
  downloadMyEvaluationCorrectionImage(@Req() request: RequestWithUser, @Param('id') id: string, @Res() response: Response) {
    const file = this.liensinaService.getStudentEvaluationCorrectionCardFile(request.user!.id, id)
    response.setHeader('Content-Type', file.contentType)
    response.setHeader('Content-Disposition', this.contentDispositionAttachment(file.filename))
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    return response.sendFile(file.filePath)
  }

  @UseGuards(AuthGuard)
  @Get('me/answer-cards')
  listMyAnswerCards(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listAnswerCards(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/grades')
  listMyGrades(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listGrades(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/student-subjects')
  listMyStudentSubjects(
    @Req() request: RequestWithUser,
    @Query('page') page = '1',
    @Query('limit') limit = '6',
    @Query('search') search = '',
  ) {
    return this.liensinaService.listStudentSubjectCardsPage(request.user!.id, page, limit, search)
  }

  @UseGuards(AuthGuard)
  @Get('me/lesson-records')
  listMyLessonRecords(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listLessonRecords(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/room-reservations')
  listMyRoomReservations(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listRoomReservations(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/calendar-events')
  listMyCalendarEvents(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listCalendarEvents(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('me/teacher-subjects')
  listMyTeacherSubjects(@Req() request: RequestWithUser, @Query('page') page = '1', @Query('limit') limit = '6') {
    return this.liensinaService.listTeacherSubjectCardsPage(request.user!.id, page, limit)
  }

  @UseGuards(AuthGuard)
  @Get('me/meal-managements/school-page')
  listMyMealManagementSchoolPage(@Req() request: RequestWithUser, @Query('page') page = '1', @Query('limit') limit = '5', @Query('search') search = '') {
    return this.liensinaService.listMealManagementSchoolPage(request.user!.id, page, limit, search)
  }

  @UseGuards(AuthGuard)
  @Get('me/meal-managements')
  listMyMealManagements(@Req() request: RequestWithUser) {
    return this.liensinaService.listMealManagements(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('dashboard')
  dashboardScreen(
    @Req() request: RequestWithUser,
    @Query('alertPage') alertPage = '1',
    @Query('alertLimit') alertLimit = '10',
  ) {
    return this.liensinaService.getDashboardScreen(request.user!.id, alertPage, alertLimit)
  }

  @UseGuards(AuthGuard)
  @Get('notifications')
  notifications(@Req() request: RequestWithUser) {
    return this.liensinaService.getNotificationsScreen(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Patch('notifications/read-all')
  markAllNotificationsRead(@Req() request: RequestWithUser) {
    return this.liensinaService.markAllNotificationsRead(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Patch('notifications/:id/read')
  markNotificationRead(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.liensinaService.markNotificationRead(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Patch('notifications/:id/unread')
  markNotificationUnread(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.liensinaService.markNotificationUnread(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Get('meal-managements')
  listMealManagements(@Req() request: RequestWithUser) {
    return this.liensinaService.listMealManagements(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('meal-managements/school-page')
  listMealManagementSchoolPage(@Req() request: RequestWithUser, @Query('page') page = '1', @Query('limit') limit = '5', @Query('search') search = '') {
    return this.liensinaService.listMealManagementSchoolPage(request.user!.id, page, limit, search)
  }

  @UseGuards(AuthGuard)
  @Get('meal-foods')
  searchMealFoods(@Req() request: RequestWithUser, @Query('search') search = '', @Query('limit') limit = '5') {
    return this.liensinaService.searchMealFoods(request.user!.id, search, limit)
  }

  @UseGuards(AuthGuard)
  @Post('meal-managements')
  createMealManagement(@Req() request: RequestWithUser, @Body() body: CreateMealManagementDto) {
    return this.liensinaService.createMealManagement(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('meal-managements/:id/budget')
  updateMealBudget(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateMealBudgetDto) {
    return this.liensinaService.updateMealBudget(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('meal-managements/:id/foods')
  createMealFood(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: CreateMealFoodDto) {
    return this.liensinaService.createMealFood(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('meal-managements/:id/menus')
  createMealMenu(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: CreateMealMenuDto) {
    return this.liensinaService.createMealMenu(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('meal-managements/:id/menus/:menuId')
  updateMealMenu(@Req() request: RequestWithUser, @Param('id') id: string, @Param('menuId') menuId: string, @Body() body: MealMenuMutationDto) {
    return this.liensinaService.updateMealMenu(request.user!.id, id, menuId, body)
  }

  @UseGuards(AuthGuard)
  @Delete('meal-managements/:id/menus/:menuId')
  deleteMealMenu(@Req() request: RequestWithUser, @Param('id') id: string, @Param('menuId') menuId: string) {
    return this.liensinaService.deleteMealMenu(request.user!.id, id, menuId)
  }

  @UseGuards(AuthGuard)
  @Get('roles')
  listRoles(@Req() request: RequestWithUser) {
    return this.resourceAccessService.listRoles(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('users')
  listUsers(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listUsers(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('schools')
  listSchools(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listSchools(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('classes')
  listClasses(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listClasses(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('guardians')
  listGuardians(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listGuardians(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('exams')
  listExams(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listExams(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('exam-corrections')
  listExamCorrections(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listExamCorrections(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('answer-cards')
  listAnswerCards(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listAnswerCards(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('grades')
  listGrades(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listGrades(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('teacher-subjects')
  listTeacherSubjects(@Req() request: RequestWithUser, @Query('page') page = '1', @Query('limit') limit = '6') {
    return this.liensinaService.listTeacherSubjectCardsPage(request.user!.id, page, limit)
  }

  @UseGuards(AuthGuard)
  @Get('curriculum-skills')
  listCurriculumSkills(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listCurriculumSkills(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('assessment-descriptors')
  listAssessmentDescriptors(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listAssessmentDescriptors(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('question-import-plans')
  listQuestionImportPlans(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listQuestionImportPlans(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Get('questions')
  listQuestions(@Req() request: RequestWithUser, @Query() query: QuestionBankPageQueryDto) {
    return this.resourceAccessService.listQuestions(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Post('schools')
  createSchool(@Req() request: RequestWithUser, @Body() body: CreateSchoolDto) {
    return this.liensinaService.createSchool(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('schools/:id')
  updateSchool(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: SchoolMutationDto) {
    return this.liensinaService.updateSchool(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('classes')
  createClassRoom(@Req() request: RequestWithUser, @Body() body: CreateClassRoomDto) {
    return this.liensinaService.createClassRoom(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('classes/:id')
  updateClassRoom(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: ClassRoomMutationDto) {
    return this.liensinaService.updateClassRoom(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Get('teachers')
  listTeachers(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listTeachers(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Post('teachers')
  createTeacher(@Req() request: RequestWithUser, @Body() body: CreateTeacherDto) {
    return this.liensinaService.createTeacher(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('teachers/:id')
  updateTeacher(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateTeacherDto) {
    return this.liensinaService.updateTeacher(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Get('students')
  listStudents(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listStudents(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Post('students')
  createStudent(@Req() request: RequestWithUser, @Body() body: CreateStudentDto) {
    return this.liensinaService.createStudent(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('students/:id')
  updateStudent(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateStudentDto) {
    return this.liensinaService.updateStudent(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('guardians')
  createGuardian(@Req() request: RequestWithUser, @Body() body: CreateGuardianDto) {
    return this.liensinaService.createGuardian(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('guardians/:id')
  updateGuardian(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateGuardianDto) {
    return this.liensinaService.updateGuardian(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('evaluations')
  async createEvaluation(@Req() request: RequestWithUser, @Body() body: EvaluationMutationDto, @Headers('idempotency-key') idempotencyKey?: string) {
    await this.assertSensitiveMutationAllowed(request, 'evaluations:create')
    return this.liensinaService.createEvaluation(request.user!.id, body, idempotencyKey)
  }

  @UseGuards(AuthGuard)
  @Get('evaluations/:id/download')
  async downloadEvaluation(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Query('kind') kind = 'complete',
    @Query('type') type = '',
    @Res() response: Response,
  ) {
    const file = await this.liensinaService.getEvaluationDownload(request.user!.id, id, type || kind)
    response.setHeader('Content-Type', file.contentType)
    response.setHeader('Content-Disposition', this.contentDispositionAttachment(file.filename))
    response.setHeader('Cache-Control', 'no-store')
    return response.sendFile(file.filePath)
  }

  @UseGuards(AuthGuard)
  @Delete('evaluations/:id')
  async deleteEvaluation(@Req() request: RequestWithUser, @Param('id') id: string) {
    await this.assertSensitiveMutationAllowed(request, 'evaluations:delete', id)
    return this.liensinaService.deleteEvaluation(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Post('evaluations/:id/students/:studentId/omr')
  @UseInterceptors(FileInterceptor('image', {
    limits: { fileSize: maxOmrUploadBytes },
    fileFilter: (_req, file, callback) => {
      const isSupported = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf'
      if (!isSupported) {
        callback(new BadRequestException('Envie uma imagem ou PDF valido do cartao resposta.'), false)
        return
      }
      callback(null, true)
    },
  }))
  async processEvaluationOmr(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Param('studentId') studentId: string,
    @UploadedFile() file?: UploadedOmrImageFile,
  ) {
    if (!file) throw new BadRequestException('Envie a imagem ou PDF do cartao resposta.')
    await this.assertSensitiveMutationAllowed(request, 'omr:single', id)
    return this.liensinaService.processEvaluationOmrCorrection(request.user!.id, id, studentId, file)
  }

  @UseGuards(AuthGuard)
  @Post('evaluations/:id/omr/batch')
  @UseInterceptors(FilesInterceptor('images', maxOmrBatchFiles, {
    limits: { fileSize: maxOmrUploadBytes, files: maxOmrBatchFiles },
    fileFilter: (_req, file, callback) => {
      const isSupported = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf'
      if (!isSupported) {
        callback(new BadRequestException('Envie imagens ou PDFs validos dos cartoes resposta.'), false)
        return
      }
      callback(null, true)
    },
  }))
  async processEvaluationOmrBatch(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @UploadedFiles() files: UploadedOmrImageFile[] = [],
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!files.length) throw new BadRequestException('Envie ao menos um cartao resposta.')
    if (files.length > maxOmrBatchFiles) throw new BadRequestException(`Lote OMR excede o limite de ${maxOmrBatchFiles} arquivos.`)
    const totalSize = files.reduce((total, file) => total + Number(file.size ?? 0), 0)
    if (totalSize > maxOmrBatchUploadBytes) throw new BadRequestException('Lote OMR excede o limite total permitido.')
    await this.assertSensitiveMutationAllowed(request, 'omr:batch', id)
    return this.liensinaService.processEvaluationOmrBatch(request.user!.id, id, files, idempotencyKey)
  }

  @UseGuards(AuthGuard)
  @Get('evaluation-corrections/:id')
  getEvaluationCorrection(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.resourceAccessService.getExamCorrection(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Get('evaluation-corrections/:id/image')
  downloadEvaluationCorrectionImage(@Req() request: RequestWithUser, @Param('id') id: string, @Res() response: Response) {
    const file = this.liensinaService.getEvaluationCorrectionCardFile(request.user!.id, id)
    response.setHeader('Content-Type', file.contentType)
    response.setHeader('Content-Disposition', this.contentDispositionAttachment(file.filename))
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    return response.sendFile(file.filePath)
  }

  @UseGuards(AuthGuard)
  @Patch('evaluation-corrections/:id/review')
  async reviewEvaluationCorrection(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: EvaluationCorrectionReviewDto, @Headers('idempotency-key') idempotencyKey?: string) {
    await this.assertSensitiveMutationAllowed(request, 'evaluation-corrections:review', id)
    return this.liensinaService.reviewEvaluationCorrection(request.user!.id, id, body, idempotencyKey)
  }

  @UseGuards(AuthGuard)
  @Post('evaluations/:id/corrections/confirm')
  async confirmEvaluationCorrections(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Body() body: EvaluationCorrectionConfirmManyDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    await this.assertSensitiveMutationAllowed(request, 'evaluation-corrections:confirm', id)
    return this.liensinaService.confirmEvaluationCorrections(request.user!.id, id, body, idempotencyKey)
  }

  @UseGuards(AuthGuard)
  @Post('questions')
  async createQuestion(@Req() request: RequestWithUser, @Body() body: CreateQuestionDto) {
    await this.assertSensitiveMutationAllowed(request, 'questions:create')
    const safeBody: CreateQuestionRequest = {
      ...body,
      context: body.context ?? '',
      explanation: body.explanation ?? '',
      sourceYear: body.sourceYear ?? null,
      sourceExternalId: body.sourceExternalId ?? null,
      sourceUrl: body.sourceUrl ?? null,
      licenseNotes: body.licenseNotes ?? null,
      descriptorIds: body.descriptorIds ?? [],
      attachments: body.attachments ?? [],
      metadata: body.metadata ? { ...body.metadata } : {},
    }
    return this.liensinaService.createQuestion(request.user!.id, safeBody)
  }

  @UseGuards(AuthGuard)
  @Post('questions/generate-selection')
  async generateQuestionSelection(@Req() request: RequestWithUser, @Body() body: GenerateQuestionSelectionDto) {
    await this.assertSensitiveMutationAllowed(request, 'questions:generate-selection')
    return this.liensinaService.generateQuestionSelection(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Delete('questions/:id')
  async deleteQuestion(@Req() request: RequestWithUser, @Param('id') id: string) {
    await this.assertSensitiveMutationAllowed(request, 'questions:delete', id)
    return this.liensinaService.deleteQuestion(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Patch('questions/:id/review')
  async reviewQuestion(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: QuestionReviewDto) {
    await this.assertSensitiveMutationAllowed(request, 'questions:review', id)
    return this.liensinaService.reviewQuestion(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('meal-managements/:id/items')
  createMealItem(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: CreateMealItemDto) {
    return this.liensinaService.createMealItem(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('meal-food-requests')
  createMealFoodRequest(@Req() request: RequestWithUser, @Body() body: CreateMealFoodRequestDto) {
    return this.liensinaService.createMealFoodRequest(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('meal-food-requests/:id')
  updateMealFoodRequest(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateMealFoodRequestDto) {
    return this.liensinaService.updateMealFoodRequest(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Delete('meal-food-requests/:id')
  deleteMealFoodRequest(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.liensinaService.deleteMealFoodRequest(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Post('meal-food-requests/:id/review')
  reviewMealFoodRequest(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: ReviewMealFoodRequestDto) {
    return this.liensinaService.reviewMealFoodRequest(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('meal-food-requests/:id/add-to-stock')
  addMealFoodRequestToStock(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: AddMealFoodRequestToStockDto) {
    return this.liensinaService.addMealFoodRequestToStock(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Get('room-reservations')
  listRoomReservations(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listRoomReservations(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Post('room-reservations')
  createRoomReservation(@Req() request: RequestWithUser, @Body() body: CreateRoomReservationDto) {
    return this.liensinaService.createRoomReservation(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Get('lesson-records')
  listLessonRecords(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listLessonRecords(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Post('lesson-records')
  createLessonRecord(@Req() request: RequestWithUser, @Body() body: CreateLessonRecordDto) {
    return this.liensinaService.createLessonRecord(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('lesson-records/:id')
  updateLessonRecord(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: LessonRecordMutationDto) {
    return this.liensinaService.updateLessonRecord(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Get('calendar-events')
  listCalendarEvents(@Req() request: RequestWithUser, @Query() query: ResourceListQueryDto) {
    return this.resourceAccessService.listCalendarEvents(request.user!.id, query)
  }

  @UseGuards(AuthGuard)
  @Post('calendar-events')
  createCalendarEvent(@Req() request: RequestWithUser, @Body() body: CreateCalendarEventDto) {
    return this.liensinaService.createCalendarEvent(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('calendar-events/:id')
  updateCalendarEvent(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: CalendarEventMutationDto) {
    return this.liensinaService.updateCalendarEvent(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Delete('calendar-events/:id')
  deleteCalendarEvent(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.liensinaService.deleteCalendarEvent(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Patch('roles/:id')
  updateRole(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: RoleMutationDto) {
    return this.liensinaService.updateRole(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('users/:id/role')
  updateUserRole(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateUserRoleDto) {
    return this.liensinaService.updateUserRole(request.user!.id, id, body.roleId)
  }

  @UseGuards(AuthGuard)
  @Patch('users/:id/school')
  updateUserSchool(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateUserSchoolDto) {
    return this.liensinaService.updateUserSchool(request.user!.id, id, body.schoolId)
  }

  @UseGuards(AuthGuard)
  @Get('users/search')
  searchUsers(
    @Req() request: RequestWithUser,
    @Query('search') search = '',
    @Query('schoolId') schoolId = 'all',
    @Query('kind') kind = 'all',
    @Query('limit') limit = '10',
  ) {
    return this.liensinaService.searchAccessUsers(request.user!.id, search, schoolId, kind, limit)
  }

  @UseGuards(AuthGuard)
  @Patch('profile')
  updateProfile(@Req() request: RequestWithUser, @Body() body: ProfileMutationDto) {
    return this.liensinaService.updateProfile(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('profile/avatar')
  @UseInterceptors(FileInterceptor('avatar', {
    limits: { fileSize: maxAvatarUploadBytes },
    fileFilter: (_request: unknown, file: { mimetype: string }, callback: (error: Error | null, acceptFile: boolean) => void) => {
      if (!file.mimetype.startsWith('image/')) {
        callback(new BadRequestException('Envie uma imagem valida para o avatar.'), false)
        return
      }
      callback(null, true)
    },
  }))
  updateProfileAvatar(@Req() request: RequestWithUser, @UploadedFile() file?: UploadedProfileImageFile) {
    if (!file) throw new BadRequestException('Envie uma imagem para atualizar o avatar.')
    return this.liensinaService.updateProfileAvatar(request.user!.id, file)
  }

  @UseGuards(AuthGuard)
  @Delete('profile/avatar')
  deleteProfileAvatar(@Req() request: RequestWithUser) {
    return this.liensinaService.deleteProfileAvatar(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Patch('profile/banner')
  @UseInterceptors(FileInterceptor('banner', {
    limits: { fileSize: maxBannerUploadBytes },
    fileFilter: (_request: unknown, file: { mimetype: string }, callback: (error: Error | null, acceptFile: boolean) => void) => {
      if (!file.mimetype.startsWith('image/')) {
        callback(new BadRequestException('Envie uma imagem valida para o banner.'), false)
        return
      }
      callback(null, true)
    },
  }))
  updateProfileBanner(@Req() request: RequestWithUser, @UploadedFile() file?: UploadedProfileImageFile) {
    if (!file) throw new BadRequestException('Envie uma imagem para atualizar o banner.')
    return this.liensinaService.updateProfileBanner(request.user!.id, file)
  }

  @UseGuards(AuthGuard)
  @Delete('profile/banner')
  deleteProfileBanner(@Req() request: RequestWithUser) {
    return this.liensinaService.deleteProfileBanner(request.user!.id)
  }

  private getAuthContext(request: Request) {
    return {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    }
  }

  private getRefreshToken(request: Request) {
    return this.readCookie(request, refreshCookieName)
  }

  private readCookie(request: Request, name: string) {
    const cookieHeader = request.headers.cookie ?? ''
    const cookies = cookieHeader.split(';').map((value) => value.trim()).filter(Boolean)
    const prefix = `${name}=`
    const cookie = cookies.find((value) => value.startsWith(prefix))
    if (!cookie) return undefined
    return decodeURIComponent(cookie.slice(prefix.length))
  }

  private setRefreshCookie(response: Response, token: string, expiresAt: string) {
    response.cookie(refreshCookieName, token, {
      httpOnly: true,
      secure: this.shouldUseSecureRefreshCookie(),
      sameSite: 'strict',
      path: '/api/auth',
      expires: new Date(expiresAt),
    })
  }

  private clearRefreshCookie(response: Response) {
    response.clearCookie(refreshCookieName, {
      httpOnly: true,
      secure: this.shouldUseSecureRefreshCookie(),
      sameSite: 'strict',
      path: '/api/auth',
    })
  }

  private shouldUseSecureRefreshCookie() {
    if (process.env.AUTH_COOKIE_SECURE === 'true') return true
    if (process.env.AUTH_COOKIE_SECURE === 'false') return false
    return process.env.NODE_ENV === 'production'
  }

  private assertCsrfRequestAllowed(request: Request) {
    if (request.headers['x-liensina-csrf'] !== '1') {
      throw new ForbiddenException('Cabecalho CSRF obrigatorio.')
    }

    const origin = request.headers.origin ?? this.getOriginFromReferer(request.headers.referer)
    if (!origin) return
    if (this.isTrustedRequestOrigin(String(origin))) return
    throw new ForbiddenException('Origem nao autorizada.')
  }

  private getOriginFromReferer(referer: string | undefined) {
    if (!referer) return undefined
    try {
      const url = new URL(referer)
      return url.origin
    } catch {
      return undefined
    }
  }

  private isTrustedRequestOrigin(origin: string) {
    const allowedOrigins = new Set((process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean))
    if (allowedOrigins.has(origin)) return true

    try {
      const url = new URL(origin)
      const isLocalHttpMode = process.env.AUTH_COOKIE_SECURE === 'false' || process.env.NODE_ENV !== 'production'
      const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
      const localPorts = new Set(['4173', '5173', '5174'])
      return isLocalHttpMode && url.protocol === 'http:' && localPorts.has(url.port) && localHosts.has(url.hostname)
    } catch {
      return false
    }
  }

  private async assertSensitiveMutationAllowed(request: RequestWithUser, operation: string, resourceId = 'global') {
    const userId = request.user?.id ?? 'anonymous'
    const tenantId = request.user?.schoolId ?? 'network'
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown'
    await this.rateLimitService.assertAllowed([
      { key: `${operation}:user:${userId}:resource:${resourceId}`, limit: 12, windowMs: 60_000 },
      { key: `${operation}:tenant:${tenantId}`, limit: 120, windowMs: 60_000 },
      { key: `${operation}:ip:${ip}`, limit: 60, windowMs: 60_000 },
    ])
  }

  private async assertAuthAttemptAllowed(request: Request, operation: string, identity = 'anonymous') {
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown'
    const normalizedIdentity = String(identity ?? 'anonymous').trim().toLowerCase() || 'anonymous'
    await this.rateLimitService.assertAllowed([
      { key: `${operation}:ip:${ip}`, limit: operation === 'auth:login' ? 10 : 30, windowMs: 60_000 },
      { key: `${operation}:identity:${normalizedIdentity}`, limit: operation === 'auth:login' ? 8 : 30, windowMs: 60_000 },
    ])
  }

  private contentDispositionAttachment(filename: string) {
    const asciiFallback = filename
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_')
      || 'prova.pdf'

    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  }
}

