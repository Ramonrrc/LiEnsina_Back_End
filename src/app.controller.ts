import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors, UnauthorizedException } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Request, Response } from 'express'

import { AuthGuard, type RequestWithUser } from './auth.guard'
import { DatabaseService } from './database.service'
import { LiensinaService } from './liensina.service'
import type { AddMealFoodRequestToStockPayload, ClassRoom, CreateMealFoodPayload, CreateMealFoodRequestPayload, CreateMealItemPayload, CreateMealManagementPayload, CreateQuestionRequest, Evaluation, EvaluationCorrectionReviewPayload, GenerateQuestionSelectionRequest, Guardian, LessonRecord, ReviewMealFoodRequestPayload, Role, RoomReservation, School, SchoolCalendarEvent, Student, Teacher, UpdateMealBudgetPayload, UpdateMealFoodRequestPayload, UpsertMealMenuPayload, UserAccount } from './liensina.types'

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

@Controller()
export class AppController {
  constructor(
    private readonly liensinaService: LiensinaService,
    private readonly databaseService: DatabaseService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', app: 'LiEnsina_Back_End', database: this.databaseService.getDriver(), timestamp: new Date().toISOString() }
  }

  @Post('auth/login')
  async login(
    @Body() body: { email: string; password: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.liensinaService.login(body.email ?? '', body.password ?? '', this.getAuthContext(request))
    this.setRefreshCookie(response, result.refreshToken, result.refreshExpiresAt)
    const { refreshToken: _refreshToken, refreshExpiresAt: _refreshExpiresAt, ...publicResult } = result
    return publicResult
  }

  @Post('auth/refresh')
  async refresh(
    @Body() body: { refreshToken?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = this.getRefreshToken(request, body)
    if (!refreshToken) throw new UnauthorizedException('Refresh token ausente.')

    const result = await this.liensinaService.refreshLogin(refreshToken, this.getAuthContext(request))
    this.setRefreshCookie(response, result.refreshToken, result.refreshExpiresAt)
    const { refreshToken: _refreshToken, refreshExpiresAt: _refreshExpiresAt, ...publicResult } = result
    return publicResult
  }

  @Post('auth/logout')
  logout(
    @Body() body: { refreshToken?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = this.getRefreshToken(request, body)
    const result = this.liensinaService.logout(refreshToken ?? '')
    this.clearRefreshCookie(response)
    return result
  }

  @UseGuards(AuthGuard)
  @Get('bootstrap')
  bootstrap(@Req() request: RequestWithUser) {
    return this.liensinaService.getBootstrap(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('session')
  session(@Req() request: RequestWithUser) {
    return this.liensinaService.getSession(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('screens/dashboard')
  dashboardScreen(
    @Req() request: RequestWithUser,
    @Query('alertPage') alertPage = '1',
    @Query('alertLimit') alertLimit = '10',
  ) {
    return this.liensinaService.getDashboardScreen(request.user!.id, alertPage, alertLimit)
  }

  @UseGuards(AuthGuard)
  @Get('screens/notifications')
  notificationsScreen(@Req() request: RequestWithUser) {
    return this.liensinaService.getNotificationsScreen(request.user!.id)
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
  @Get('screens/schools')
  schoolsScreen(@Req() request: RequestWithUser) {
    return this.liensinaService.getSchoolsScreen(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('screens/evaluations')
  evaluationsScreen(@Req() request: RequestWithUser) {
    return this.liensinaService.getEvaluationsScreen(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('screens/calendar')
  calendarScreen(@Req() request: RequestWithUser) {
    return this.liensinaService.getCalendarScreen(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('screens/meals')
  mealsScreen(@Req() request: RequestWithUser) {
    return this.liensinaService.getMealsScreen(request.user!.id)
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
  createMealManagement(@Req() request: RequestWithUser, @Body() body: CreateMealManagementPayload) {
    return this.liensinaService.createMealManagement(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('meal-managements/:id/budget')
  updateMealBudget(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateMealBudgetPayload) {
    return this.liensinaService.updateMealBudget(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('meal-managements/:id/foods')
  createMealFood(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: CreateMealFoodPayload) {
    return this.liensinaService.createMealFood(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('meal-managements/:id/menus')
  createMealMenu(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpsertMealMenuPayload) {
    return this.liensinaService.createMealMenu(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('meal-managements/:id/menus/:menuId')
  updateMealMenu(@Req() request: RequestWithUser, @Param('id') id: string, @Param('menuId') menuId: string, @Body() body: Partial<UpsertMealMenuPayload>) {
    return this.liensinaService.updateMealMenu(request.user!.id, id, menuId, body)
  }

  @UseGuards(AuthGuard)
  @Delete('meal-managements/:id/menus/:menuId')
  deleteMealMenu(@Req() request: RequestWithUser, @Param('id') id: string, @Param('menuId') menuId: string) {
    return this.liensinaService.deleteMealMenu(request.user!.id, id, menuId)
  }

  @UseGuards(AuthGuard)
  @Get('screens/access')
  accessScreen(@Req() request: RequestWithUser) {
    return this.liensinaService.getAccessScreen(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Get('screens/settings')
  settingsScreen(@Req() request: RequestWithUser) {
    return this.liensinaService.getSettingsScreen(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Post('schools')
  createSchool(@Req() request: RequestWithUser, @Body() body: Partial<School>) {
    return this.liensinaService.createSchool(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('schools/:id')
  updateSchool(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: Partial<School>) {
    return this.liensinaService.updateSchool(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('classes')
  createClassRoom(@Req() request: RequestWithUser, @Body() body: Partial<ClassRoom>) {
    return this.liensinaService.createClassRoom(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('classes/:id')
  updateClassRoom(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: Partial<ClassRoom>) {
    return this.liensinaService.updateClassRoom(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Get('teachers')
  listTeachers(
    @Req() request: RequestWithUser,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
    @Query('search') search = '',
    @Query('schoolId') schoolId = 'all',
    @Query('discipline') discipline = 'all',
  ) {
    return this.liensinaService.listTeachersPage(request.user!.id, page, limit, search, schoolId, discipline)
  }

  @UseGuards(AuthGuard)
  @Post('teachers')
  createTeacher(@Req() request: RequestWithUser, @Body() body: Partial<Teacher> & { classId?: string; password?: string; phone?: string }) {
    return this.liensinaService.createTeacher(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('teachers/:id')
  updateTeacher(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: Partial<Teacher> & { classId?: string }) {
    return this.liensinaService.updateTeacher(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Get('students')
  listStudents(
    @Req() request: RequestWithUser,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
    @Query('search') search = '',
    @Query('schoolId') schoolId = 'all',
    @Query('discipline') discipline = 'all',
  ) {
    return this.liensinaService.listStudentsPage(request.user!.id, page, limit, search, schoolId, discipline)
  }

  @UseGuards(AuthGuard)
  @Post('students')
  createStudent(@Req() request: RequestWithUser, @Body() body: Partial<Student> & { password?: string }) {
    return this.liensinaService.createStudent(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('students/:id')
  updateStudent(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: Partial<Student>) {
    return this.liensinaService.updateStudent(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('guardians')
  createGuardian(@Req() request: RequestWithUser, @Body() body: Partial<Guardian> & { password?: string }) {
    return this.liensinaService.createGuardian(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('guardians/:id')
  updateGuardian(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: Partial<Guardian>) {
    return this.liensinaService.updateGuardian(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('evaluations')
  createEvaluation(@Req() request: RequestWithUser, @Body() body: Partial<Evaluation>) {
    return this.liensinaService.createEvaluation(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Get('evaluations/:id/download')
  async downloadEvaluation(@Req() request: RequestWithUser, @Param('id') id: string, @Res() response: Response) {
    const file = await this.liensinaService.getEvaluationDownload(request.user!.id, id)
    response.setHeader('Content-Type', file.contentType)
    response.setHeader('Content-Disposition', this.contentDispositionAttachment(file.filename))
    response.setHeader('Cache-Control', 'no-store')
    return response.sendFile(file.filePath)
  }

  @UseGuards(AuthGuard)
  @Delete('evaluations/:id')
  deleteEvaluation(@Req() request: RequestWithUser, @Param('id') id: string) {
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
  processEvaluationOmr(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Param('studentId') studentId: string,
    @UploadedFile() file?: UploadedOmrImageFile,
  ) {
    if (!file) throw new BadRequestException('Envie a imagem ou PDF do cartao resposta.')
    return this.liensinaService.processEvaluationOmrCorrection(request.user!.id, id, studentId, file)
  }

  @UseGuards(AuthGuard)
  @Patch('evaluation-corrections/:id/review')
  reviewEvaluationCorrection(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: EvaluationCorrectionReviewPayload) {
    return this.liensinaService.reviewEvaluationCorrection(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('questions')
  createQuestion(@Req() request: RequestWithUser, @Body() body: CreateQuestionRequest) {
    return this.liensinaService.createQuestion(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Post('questions/generate-selection')
  generateQuestionSelection(@Req() request: RequestWithUser, @Body() body: GenerateQuestionSelectionRequest) {
    return this.liensinaService.generateQuestionSelection(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Delete('questions/:id')
  deleteQuestion(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.liensinaService.deleteQuestion(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Post('meal-managements/:id/items')
  createMealItem(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: CreateMealItemPayload) {
    return this.liensinaService.createMealItem(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('meal-food-requests')
  createMealFoodRequest(@Req() request: RequestWithUser, @Body() body: CreateMealFoodRequestPayload) {
    return this.liensinaService.createMealFoodRequest(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('meal-food-requests/:id')
  updateMealFoodRequest(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateMealFoodRequestPayload) {
    return this.liensinaService.updateMealFoodRequest(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Delete('meal-food-requests/:id')
  deleteMealFoodRequest(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.liensinaService.deleteMealFoodRequest(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Post('meal-food-requests/:id/review')
  reviewMealFoodRequest(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: ReviewMealFoodRequestPayload) {
    return this.liensinaService.reviewMealFoodRequest(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Post('meal-food-requests/:id/add-to-stock')
  addMealFoodRequestToStock(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: AddMealFoodRequestToStockPayload) {
    return this.liensinaService.addMealFoodRequestToStock(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Get('room-reservations')
  listRoomReservations(@Req() request: RequestWithUser) {
    return this.liensinaService.listRoomReservations(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Post('room-reservations')
  createRoomReservation(@Req() request: RequestWithUser, @Body() body: Partial<RoomReservation>) {
    return this.liensinaService.createRoomReservation(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Get('lesson-records')
  listLessonRecords(@Req() request: RequestWithUser) {
    return this.liensinaService.listLessonRecords(request.user!.id)
  }

  @UseGuards(AuthGuard)
  @Post('lesson-records')
  createLessonRecord(@Req() request: RequestWithUser, @Body() body: Partial<LessonRecord>) {
    return this.liensinaService.createLessonRecord(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Get('calendar-events')
  listCalendarEvents() {
    return this.liensinaService.listCalendarEvents()
  }

  @UseGuards(AuthGuard)
  @Post('calendar-events')
  createCalendarEvent(@Req() request: RequestWithUser, @Body() body: Partial<SchoolCalendarEvent>) {
    return this.liensinaService.createCalendarEvent(request.user!.id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('calendar-events/:id')
  updateCalendarEvent(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: Partial<SchoolCalendarEvent>) {
    return this.liensinaService.updateCalendarEvent(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Delete('calendar-events/:id')
  deleteCalendarEvent(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.liensinaService.deleteCalendarEvent(request.user!.id, id)
  }

  @UseGuards(AuthGuard)
  @Patch('roles/:id')
  updateRole(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: Partial<Role>) {
    return this.liensinaService.updateRole(request.user!.id, id, body)
  }

  @UseGuards(AuthGuard)
  @Patch('users/:id/role')
  updateUserRole(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: { roleId: string }) {
    return this.liensinaService.updateUserRole(request.user!.id, id, body.roleId)
  }

  @UseGuards(AuthGuard)
  @Patch('users/:id/school')
  updateUserSchool(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: { schoolId: string | null }) {
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
  updateProfile(@Req() request: RequestWithUser, @Body() body: Partial<UserAccount>) {
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

  private getRefreshToken(request: Request, body?: { refreshToken?: string }) {
    return body?.refreshToken || this.readCookie(request, refreshCookieName)
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
      sameSite: 'lax',
      path: '/api/auth',
      expires: new Date(expiresAt),
    })
  }

  private clearRefreshCookie(response: Response) {
    response.clearCookie(refreshCookieName, {
      httpOnly: true,
      secure: this.shouldUseSecureRefreshCookie(),
      sameSite: 'lax',
      path: '/api/auth',
    })
  }

  private shouldUseSecureRefreshCookie() {
    if (process.env.AUTH_COOKIE_SECURE === 'true') return true
    if (process.env.AUTH_COOKIE_SECURE === 'false') return false
    return process.env.NODE_ENV === 'production'
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

