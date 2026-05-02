import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { randomUUID } from 'node:crypto'

import { DatabaseService } from './database.service'
import type { CalendarEventType, ClassRoom, Evaluation, PublicUserAccount, Role, School, SchoolCalendarEvent, UserAccount } from './liensina.types'

@Injectable()
export class LiensinaService {
  private readonly calendarEventTypes = new Set<CalendarEventType>(['aula', 'reuniao', 'avaliacao', 'prazo', 'evento'])

  constructor(
    private readonly database: DatabaseService,
    private readonly jwtService: JwtService,
  ) {}

  async login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase()
    const user = this.database.read().users.find((item) => item.email.toLowerCase() === normalizedEmail)

    if (!user || user.password !== password || user.status !== 'ativo') {
      throw new UnauthorizedException('Credenciais invalidas para o LiEnsina.')
    }

    return {
      token: await this.jwtService.signAsync({ sub: user.id, email: user.email }),
      user: this.toPublicUser(user),
    }
  }

  getUserById(userId: string) {
    const user = this.database.read().users.find((item) => item.id === userId)
    if (!user) throw new UnauthorizedException('Usuario nao encontrado.')
    return user
  }

  getBootstrap(userId: string) {
    const data = this.database.read()
    const currentUser = data.users.find((user) => user.id === userId)
    if (!currentUser) throw new UnauthorizedException('Usuario nao encontrado.')

    return {
      currentUser: this.toPublicUser(currentUser),
      dashboard: this.buildDashboard(),
      roles: data.roles,
      users: data.users.map((user) => this.toPublicUser(user)),
      schools: data.schools,
      teachers: data.teachers,
      students: data.students,
      classes: data.classes,
      evaluations: data.evaluations,
      calendarEvents: data.calendarEvents,
      auditEvents: data.auditEvents,
    }
  }

  createSchool(actorId: string, payload: Partial<School>) {
    this.ensureRequired(payload, ['name', 'city', 'address', 'director', 'inepCode'])
    const school: School = {
      id: this.createId('esc'),
      name: payload.name!.trim(),
      city: payload.city!.trim(),
      address: payload.address!.trim(),
      director: payload.director!.trim(),
      inepCode: payload.inepCode!.trim(),
      active: payload.active ?? true,
    }
    this.database.update((data) => {
      data.schools.unshift(school)
      this.pushAudit(data, actorId, 'Criou escola', school.name)
    })
    return school
  }

  updateSchool(actorId: string, id: string, payload: Partial<School>) {
    let updated: School | null = null
    this.database.update((data) => {
      const index = data.schools.findIndex((school) => school.id === id)
      if (index < 0) throw new NotFoundException('Escola nao encontrada.')
      updated = { ...data.schools[index], ...payload, id }
      data.schools[index] = updated
      this.pushAudit(data, actorId, 'Atualizou escola', updated.name)
    })
    return updated!
  }

  createClassRoom(actorId: string, payload: Partial<ClassRoom>) {
    this.ensureRequired(payload, ['name', 'grade', 'schoolId', 'teacherId', 'schedule'])
    const classRoom: ClassRoom = {
      id: this.createId('turma'),
      name: payload.name!.trim(),
      grade: payload.grade!.trim(),
      shift: payload.shift ?? 'Manha',
      schoolId: payload.schoolId!,
      teacherId: payload.teacherId!,
      academicYear: payload.academicYear ?? new Date().getFullYear(),
      schedule: payload.schedule!.trim(),
      bnccFocus: payload.bnccFocus ?? [],
    }
    this.database.update((data) => {
      data.classes.unshift(classRoom)
      this.pushAudit(data, actorId, 'Criou turma', classRoom.name)
    })
    return classRoom
  }

  updateClassRoom(actorId: string, id: string, payload: Partial<ClassRoom>) {
    let updated: ClassRoom | null = null
    this.database.update((data) => {
      const index = data.classes.findIndex((classRoom) => classRoom.id === id)
      if (index < 0) throw new NotFoundException('Turma nao encontrada.')
      updated = { ...data.classes[index], ...payload, id }
      data.classes[index] = updated
      this.pushAudit(data, actorId, 'Atualizou turma', updated.name)
    })
    return updated!
  }

  createEvaluation(actorId: string, payload: Partial<Evaluation>) {
    this.ensureRequired(payload, ['title', 'classId', 'subject', 'scheduledAt'])
    const evaluation: Evaluation = {
      id: this.createId('sim'),
      title: payload.title!.trim(),
      classId: payload.classId!,
      subject: payload.subject!.trim(),
      questions: payload.questions ?? 20,
      scheduledAt: payload.scheduledAt!,
      status: payload.status ?? 'planejado',
      corrected: payload.corrected ?? 0,
      participants: payload.participants ?? 0,
      averageScore: payload.averageScore ?? 0,
      triLevel: payload.triLevel ?? 'Aguardando aplicacao',
    }
    this.database.update((data) => {
      data.evaluations.unshift(evaluation)
      this.pushAudit(data, actorId, 'Criou simulado', evaluation.title)
    })
    return evaluation
  }

  listCalendarEvents() {
    return this.database.read().calendarEvents
  }

  createCalendarEvent(actorId: string, payload: Partial<SchoolCalendarEvent>) {
    this.ensureRequired(payload, ['title', 'type', 'schoolId', 'startsAt', 'endsAt'])
    let calendarEvent: SchoolCalendarEvent | null = null

    this.database.update((data) => {
      calendarEvent = this.buildCalendarEvent(data, payload)
      data.calendarEvents.unshift(calendarEvent)
      this.pushAudit(data, actorId, 'Criou evento no calendario', calendarEvent.title)
    })

    return calendarEvent!
  }

  updateCalendarEvent(actorId: string, id: string, payload: Partial<SchoolCalendarEvent>) {
    let updated: SchoolCalendarEvent | null = null

    this.database.update((data) => {
      const index = data.calendarEvents.findIndex((event) => event.id === id)
      if (index < 0) throw new NotFoundException('Evento de calendario nao encontrado.')

      updated = this.buildCalendarEvent(data, { ...data.calendarEvents[index], ...payload, id }, id)
      data.calendarEvents[index] = updated
      this.pushAudit(data, actorId, 'Atualizou evento no calendario', updated.title)
    })

    return updated!
  }

  deleteCalendarEvent(actorId: string, id: string) {
    this.database.update((data) => {
      const index = data.calendarEvents.findIndex((event) => event.id === id)
      if (index < 0) throw new NotFoundException('Evento de calendario nao encontrado.')

      const [removed] = data.calendarEvents.splice(index, 1)
      this.pushAudit(data, actorId, 'Removeu evento do calendario', removed.title)
    })

    return { success: true }
  }

  updateRole(actorId: string, id: string, payload: Partial<Role>) {
    let updated: Role | null = null
    this.database.update((data) => {
      const index = data.roles.findIndex((role) => role.id === id)
      if (index < 0) throw new NotFoundException('Cargo nao encontrado.')
      updated = { ...data.roles[index], ...payload, id }
      data.roles[index] = updated
      this.pushAudit(data, actorId, 'Atualizou permissoes do cargo', updated.name)
    })
    return updated!
  }

  updateUserRole(actorId: string, id: string, roleId: string) {
    let updated: UserAccount | null = null
    this.database.update((data) => {
      if (!data.roles.some((role) => role.id === roleId)) throw new BadRequestException('Cargo informado nao existe.')
      const index = data.users.findIndex((user) => user.id === id)
      if (index < 0) throw new NotFoundException('Usuario nao encontrado.')
      updated = { ...data.users[index], roleId }
      data.users[index] = updated
      this.pushAudit(data, actorId, 'Alterou cargo do usuario', updated.name)
    })
    return this.toPublicUser(updated!)
  }

  updateProfile(actorId: string, payload: Partial<UserAccount>) {
    let updated: UserAccount | null = null
    this.database.update((data) => {
      const index = data.users.findIndex((user) => user.id === actorId)
      if (index < 0) throw new NotFoundException('Usuario nao encontrado.')
      updated = { ...data.users[index], name: payload.name ?? data.users[index].name, phone: payload.phone ?? data.users[index].phone, avatarUrl: payload.avatarUrl ?? data.users[index].avatarUrl }
      data.users[index] = updated
      this.pushAudit(data, actorId, 'Atualizou o proprio perfil', updated.name)
    })
    return this.toPublicUser(updated!)
  }

  private buildDashboard() {
    const data = this.database.read()
    const activeStudents = data.students.filter((student) => student.status === 'matriculado')
    const avgAttendance = this.average(activeStudents.map((student) => student.attendanceRate))
    const avgScore = this.average(activeStudents.map((student) => student.averageScore))
    const highRisk = activeStudents.filter((student) => student.riskLevel === 'alto')

    return {
      metrics: [
        { id: 'schools', label: 'Escolas', value: String(data.schools.length), detail: 'Unidades ativas na rede', tone: 'blue' as const },
        { id: 'classes', label: 'Turmas', value: String(data.classes.length), detail: 'Turmas em acompanhamento', tone: 'green' as const },
        { id: 'attendance', label: 'Frequencia media', value: `${avgAttendance.toFixed(0)}%`, detail: 'Baseada nos alunos matriculados', tone: 'amber' as const },
        { id: 'risk', label: 'Risco alto', value: String(highRisk.length), detail: 'Alunos exigindo intervencao', tone: 'rose' as const },
      ],
      attendanceByClass: data.classes.map((classRoom) => {
        const students = activeStudents.filter((student) => student.classId === classRoom.id)
        return { className: classRoom.name, frequencia: Math.round(this.average(students.map((student) => student.attendanceRate))), media: Number(this.average(students.map((student) => student.averageScore)).toFixed(1)) }
      }),
      proficiencyDistribution: [
        { level: 'Abaixo do basico', alunos: activeStudents.filter((student) => student.averageScore < 6).length },
        { level: 'Basico', alunos: activeStudents.filter((student) => student.averageScore >= 6 && student.averageScore < 7.5).length },
        { level: 'Adequado', alunos: activeStudents.filter((student) => student.averageScore >= 7.5 && student.averageScore < 9).length },
        { level: 'Avancado', alunos: activeStudents.filter((student) => student.averageScore >= 9).length },
      ],
      subjectRadar: [
        { subject: 'Portugues', acertos: 72 },
        { subject: 'Matematica', acertos: 64 },
        { subject: 'Ciencias', acertos: 78 },
        { subject: 'Humanas', acertos: 69 },
      ],
      alerts: highRisk.map((student) => ({ id: `alert-${student.id}`, title: `${student.name} em risco pedagogico`, description: `Frequencia ${student.attendanceRate}% e media ${student.averageScore.toFixed(1)}. Recomenda-se intervencao da coordenacao.`, tone: 'danger' as const })),
    }
  }

  private buildCalendarEvent(data: { schools: School[]; classes: ClassRoom[] }, payload: Partial<SchoolCalendarEvent>, id = this.createId('cal')): SchoolCalendarEvent {
    const allDay = payload.allDay ?? false
    const type = this.normalizeCalendarType(payload.type)
    const schoolId = String(payload.schoolId ?? '').trim()
    const classId = payload.classId ? String(payload.classId).trim() : null
    const startsAt = this.normalizeCalendarDateValue(payload.startsAt, allDay)
    const endsAt = this.normalizeCalendarDateValue(payload.endsAt, allDay)

    if (!data.schools.some((school) => school.id === schoolId)) throw new BadRequestException('Escola informada nao existe.')
    if (classId && !data.classes.some((classRoom) => classRoom.id === classId && classRoom.schoolId === schoolId)) {
      throw new BadRequestException('Turma informada nao pertence a escola selecionada.')
    }
    if (allDay ? endsAt < startsAt : endsAt <= startsAt) throw new BadRequestException('Data final precisa ser posterior ao inicio do evento.')

    return {
      id,
      title: String(payload.title ?? '').trim(),
      type,
      schoolId,
      classId,
      startsAt,
      endsAt,
      allDay,
      location: String(payload.location ?? '').trim(),
      description: String(payload.description ?? '').trim(),
    }
  }

  private normalizeCalendarType(type: unknown): CalendarEventType {
    const normalized = String(type ?? '').trim() as CalendarEventType
    if (!this.calendarEventTypes.has(normalized)) throw new BadRequestException('Tipo de evento de calendario invalido.')
    return normalized
  }

  private normalizeCalendarDateValue(value: unknown, allDay: boolean) {
    const normalized = String(value ?? '').trim()
    const pattern = allDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
    if (!pattern.test(normalized)) {
      throw new BadRequestException(allDay ? 'Datas de eventos de dia inteiro devem usar AAAA-MM-DD.' : 'Datas de eventos com horario devem usar AAAA-MM-DDTHH:mm.')
    }
    return normalized
  }

  private pushAudit(data: { users: UserAccount[]; auditEvents: Array<{ id: string; actor: string; action: string; target: string; createdAt: string }> }, actorId: string, action: string, target: string) {
    const actor = data.users.find((user) => user.id === actorId)?.name ?? 'Sistema'
    data.auditEvents.unshift({ id: this.createId('aud'), actor, action, target, createdAt: new Date().toISOString() })
    data.auditEvents = data.auditEvents.slice(0, 80)
  }

  private ensureRequired<T extends object>(payload: T, keys: Array<keyof T>) {
    const missing = keys.filter((key) => !String(payload[key] ?? '').trim())
    if (missing.length) throw new BadRequestException(`Campos obrigatorios ausentes: ${missing.join(', ')}`)
  }

  private average(values: number[]) {
    if (!values.length) return 0
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  private createId(prefix: string) {
    return `${prefix}-${randomUUID().slice(0, 8)}`
  }

  private toPublicUser(user: UserAccount): PublicUserAccount {
    const { password: _password, ...publicUser } = user
    return publicUser
  }
}

