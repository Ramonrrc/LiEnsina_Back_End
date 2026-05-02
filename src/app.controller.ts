import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'

import { AuthGuard, type RequestWithUser } from './auth.guard'
import { LiensinaService } from './liensina.service'
import type { ClassRoom, Evaluation, Role, School, SchoolCalendarEvent, UserAccount } from './liensina.types'

@Controller()
export class AppController {
  constructor(private readonly liensinaService: LiensinaService) {}

  @Get('health')
  health() {
    return { status: 'ok', app: 'LiEnsina_Back_End', database: 'json', timestamp: new Date().toISOString() }
  }

  @Post('auth/login')
  login(@Body() body: { email: string; password: string }) {
    return this.liensinaService.login(body.email ?? '', body.password ?? '')
  }

  @UseGuards(AuthGuard)
  @Get('bootstrap')
  bootstrap(@Req() request: RequestWithUser) {
    return this.liensinaService.getBootstrap(request.user!.id)
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
  @Post('evaluations')
  createEvaluation(@Req() request: RequestWithUser, @Body() body: Partial<Evaluation>) {
    return this.liensinaService.createEvaluation(request.user!.id, body)
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
  @Patch('profile')
  updateProfile(@Req() request: RequestWithUser, @Body() body: Partial<UserAccount>) {
    return this.liensinaService.updateProfile(request.user!.id, body)
  }
}

