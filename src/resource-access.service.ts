import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'

import { DatabaseService } from './database.service'
import { normalizeRoleCode } from './role-utils'
import type {
  AppNotification,
  ClassRoom,
  DatabaseShape,
  Evaluation,
  EvaluationAnswerCard,
  EvaluationCorrection,
  EvaluationCorrectionStatus,
  Guardian,
  LessonRecord,
  PublicUserAccount,
  Question,
  Role,
  RoleCode,
  RoomReservation,
  School,
  SchoolCalendarEvent,
  Student,
  Teacher,
  UserAccount,
} from './liensina.types'
import type { CreateTeacherAssignmentDto, ManualCorrectionDto, QuestionBankPageQueryDto, ResourceListQueryDto } from './resource-query.dto'

type PaginationMeta = {
  page: number
  limit: number
  total: number
  totalPages: number
}

type PageResult<T, K extends string> = Record<K, T[]> & {
  pagination: PaginationMeta
}

type SubjectDto = {
  id: string
  code: string
  name: string
  schoolId?: string
  classIds: string[]
  teacherIds: string[]
}

type TeacherAssignmentDto = {
  id: string
  teacherId: string
  schoolId: string
  classId: string
  subjectId: string
  subject: string
}

type GradeDto = {
  id: string
  studentId: string
  studentName: string
  schoolId: string
  classId: string
  evaluationId: string
  evaluationTitle: string
  subject: string
  score: number | null
  status: EvaluationCorrectionStatus
  scheduledAt: string | null
  correctCount: number
  totalQuestions: number
  reviewedAt: string | null
}

type AttendanceDto = {
  id: string
  studentId: string
  studentName: string
  schoolId: string
  classId: string
  lessonRecordId: string
  subject: string
  date: string
  present: boolean
}

type StudentLessonRecordDto = Pick<LessonRecord, 'id' | 'classId' | 'subject' | 'date' | 'time' | 'attendance'>

type AccessContext = {
  data: DatabaseShape
  actor: UserAccount
  roleCode: RoleCode
  scope: ScopedResourceSet
}

type ScopedResourceSet = {
  schools: School[]
  classes: ClassRoom[]
  teachers: Teacher[]
  guardians: Guardian[]
  students: Student[]
  schoolIds: Set<string>
  classIds: Set<string>
  teacherIds: Set<string>
  guardianIds: Set<string>
  studentIds: Set<string>
}

const roleSections: Record<RoleCode, string[]> = {
  SUPERADMIN: ['dashboard', 'schools', 'people', 'evaluations', 'evaluation-corrections', 'meals', 'access', 'notifications', 'settings'],
  ADMIN: ['dashboard', 'schools', 'people', 'evaluations', 'evaluation-corrections', 'meals', 'notifications', 'settings'],
  ADMIN_ESCOLA: ['dashboard', 'schools', 'people', 'evaluations', 'evaluation-corrections', 'meals', 'notifications', 'settings'],
  DIRETOR: ['dashboard', 'schools', 'people', 'evaluations', 'evaluation-corrections', 'meals', 'notifications', 'settings'],
  COORDENADOR: ['pedagogy', 'evaluations', 'evaluation-corrections', 'calendar', 'notifications', 'settings'],
  PROFESSOR: ['teacher-subjects', 'room-reservations', 'evaluations', 'evaluation-corrections', 'calendar', 'notifications', 'settings'],
  ALUNO: ['student-performance', 'student-grades', 'calendar', 'notifications', 'settings'],
  RESPONSAVEL: ['child-performance', 'child-attendance', 'calendar', 'notifications', 'settings'],
  NUTRITIONIST: ['food-requests', 'meals', 'notifications', 'settings'],
}

const roleActions: Record<RoleCode, string[]> = {
  SUPERADMIN: [
    'schools:read', 'schools:write', 'users:read', 'users:write', 'roles:read', 'roles:write',
    'students:read', 'students:write', 'teachers:read', 'teachers:write', 'classes:read',
    'classes:write', 'subjects:read', 'teacher-assignments:read', 'teacher-assignments:write',
    'exams:read', 'exams:write', 'exam-corrections:read', 'exam-corrections:write',
    'grades:read', 'grades:write', 'attendance:read', 'attendance:write',
    'lesson-records:read', 'lesson-records:write', 'calendar-events:read',
    'calendar-events:write', 'dashboard:read', 'pedagogical-metrics:read',
    'audit:read:global',
  ],
  ADMIN: [
    'schools:read', 'users:read', 'users:write:own_school', 'students:read', 'students:write',
    'teachers:read', 'teachers:write', 'classes:read', 'classes:write', 'subjects:read',
    'teacher-assignments:read', 'teacher-assignments:write', 'exams:read', 'exams:write',
    'exam-corrections:read', 'exam-corrections:write', 'grades:read', 'grades:write',
    'attendance:read', 'attendance:write', 'lesson-records:read', 'lesson-records:write',
    'calendar-events:read', 'calendar-events:write', 'dashboard:read', 'pedagogical-metrics:read',
  ],
  ADMIN_ESCOLA: [
    'schools:read', 'users:read', 'users:write:own_school', 'students:read', 'students:write',
    'teachers:read', 'teachers:write', 'classes:read', 'classes:write', 'subjects:read',
    'teacher-assignments:read', 'teacher-assignments:write', 'exams:read', 'exams:write',
    'exam-corrections:read', 'exam-corrections:write', 'grades:read', 'grades:write',
    'attendance:read', 'attendance:write', 'lesson-records:read', 'lesson-records:write',
    'calendar-events:read', 'calendar-events:write', 'dashboard:read', 'pedagogical-metrics:read',
  ],
  DIRETOR: [
    'schools:read', 'users:read', 'students:read', 'teachers:read', 'classes:read', 'subjects:read',
    'teacher-assignments:read', 'exams:read', 'exams:write', 'exam-corrections:read',
    'grades:read', 'attendance:read', 'lesson-records:read', 'calendar-events:read',
    'calendar-events:write', 'dashboard:read', 'pedagogical-metrics:read',
  ],
  COORDENADOR: [
    'schools:read', 'students:read', 'teachers:read', 'classes:read', 'subjects:read',
    'teacher-assignments:read', 'exams:read', 'exam-corrections:read', 'grades:read',
    'attendance:read', 'lesson-records:read', 'calendar-events:read', 'calendar-events:write',
    'dashboard:read', 'pedagogical-metrics:read',
  ],
  PROFESSOR: [
    'schools:read', 'students:read', 'classes:read', 'subjects:read', 'teacher-assignments:read',
    'exams:read', 'exams:write', 'exam-corrections:read', 'exam-corrections:write',
    'grades:read', 'grades:write', 'attendance:read', 'attendance:write',
    'lesson-records:read', 'lesson-records:write', 'calendar-events:read', 'calendar-events:write',
    'dashboard:read', 'pedagogical-metrics:read',
  ],
  ALUNO: [
    'schools:read', 'students:self:read', 'classes:self:read', 'subjects:self:read',
    'exams:self:read', 'grades:self:read', 'attendance:self:read', 'lesson-records:self:read',
    'calendar-events:read', 'dashboard:self:read', 'pedagogical-metrics:self:read',
  ],
  RESPONSAVEL: [
    'students:dependents:read', 'classes:dependents:read', 'subjects:dependents:read',
    'exams:dependents:read', 'grades:dependents:read', 'attendance:dependents:read',
    'lesson-records:dependents:read', 'calendar-events:read', 'dashboard:dependents:read',
    'pedagogical-metrics:dependents:read',
  ],
  NUTRITIONIST: ['meals:read', 'meals:write', 'notifications:read'],
}

function isSuperAdminRole(roleCode: RoleCode) {
  return roleCode === 'SUPERADMIN'
}

function isNetworkAdminRole(roleCode: RoleCode) {
  return roleCode === 'SUPERADMIN' || roleCode === 'ADMIN'
}

function isSchoolAdminRole(roleCode: RoleCode) {
  return roleCode === 'ADMIN_ESCOLA' || roleCode === 'ADMIN'
}

function isSchoolManagementRole(roleCode: RoleCode) {
  return isSchoolAdminRole(roleCode) || roleCode === 'DIRETOR' || roleCode === 'COORDENADOR'
}

@Injectable()
export class ResourceAccessService {
  private readonly contextCache = new Map<string, AccessContext>()

  constructor(private readonly database: DatabaseService) {}

  private readDataForQuery() {
    const database = this.database as DatabaseService & { readForQuery?: () => DatabaseShape }
    return typeof database.readForQuery === 'function' ? database.readForQuery() : this.database.read()
  }

  getMe(userId: string) {
    const { data, actor } = this.getContext(userId)
    return {
      currentUser: this.publicUser(data, actor, true),
      currentRole: data.roles.find((role) => role.id === actor.roleId) ?? null,
      alertCount: data.notifications.filter((notification) => notification.userId === actor.id && !notification.readAt).length,
    }
  }

  getPermissions(userId: string) {
    const { data, actor, roleCode } = this.getContext(userId)
    const role = data.roles.find((item) => item.id === actor.roleId) ?? null
    const rolePermissions = role?.permissions ?? []

    return {
      role,
      roleCode,
      permissions: Array.from(new Set([...rolePermissions, ...roleActions[roleCode]])),
      allowedSections: roleSections[roleCode],
    }
  }

  getMeSchools(userId: string, query: ResourceListQueryDto = {}) {
    const { roleCode, scope } = this.getContext(userId)
    const schools = this.searchItems(scope.schools, query.search, (school) => school.name)
    return this.page('schools', schools.map((school) => this.schoolDto(school, roleCode, query.view)), query)
  }

  getMeClasses(userId: string, query: ResourceListQueryDto = {}) {
    const { roleCode, scope } = this.getContext(userId)
    return this.page('classes', scope.classes.map((classRoom) => this.classDto(classRoom, roleCode, query.view)), query)
  }

  getMeSubjects(userId: string, query: ResourceListQueryDto = {}) {
    const context = this.getContext(userId)
    return this.page('subjects', this.getVisibleSubjects(context), query)
  }

  listRoles(userId: string) {
    const { data, actor, roleCode } = this.getContext(userId)
    return {
      roles: isSuperAdminRole(roleCode)
        ? data.roles
        : data.roles.filter((role) => role.id === actor.roleId),
    }
  }

  listSchools(userId: string, query: ResourceListQueryDto = {}): PageResult<School, 'schools'> {
    const { roleCode, scope } = this.getContext(userId)
    let schools = scope.schools
    const schoolFilter = this.cleanFilter(query.schoolId)
    if (schoolFilter) {
      this.ensureAllowedId(scope.schoolIds, schoolFilter, 'escola')
      schools = schools.filter((school) => school.id === schoolFilter)
    }
    schools = this.searchItems(schools, query.search, (school) => school.name)
    return this.page('schools', schools.map((school) => this.schoolDto(school, roleCode)), query)
  }

  getSchool(userId: string, schoolId: string) {
    const { data, roleCode, scope } = this.getContext(userId)
    this.ensureAllowedId(scope.schoolIds, schoolId, 'escola')
    const school = data.schools.find((item) => item.id === schoolId)
    if (!school) throw new NotFoundException('Escola nao encontrada.')
    return this.schoolDto(school, roleCode)
  }

  listUsers(userId: string, query: ResourceListQueryDto = {}): PageResult<PublicUserAccount, 'users'> {
    const { data, actor, roleCode, scope } = this.getContext(userId)
    const roleById = new Map(data.roles.map((role) => [role.id, role]))
    const requestedRole = this.cleanFilter(query.role)?.toUpperCase()
    const schoolFilter = this.cleanFilter(query.schoolId)

    if (requestedRole && !data.roles.some((role) => role.code === requestedRole || role.name === requestedRole)) {
      throw new BadRequestException('Filtro de perfil invalido.')
    }

    if (schoolFilter && !isSuperAdminRole(roleCode)) this.ensureAllowedId(scope.schoolIds, schoolFilter, 'escola')

    let users = data.users.filter((user) => {
      if (isSuperAdminRole(roleCode)) return true
      if (user.id === actor.id) return true
      if (isSchoolManagementRole(roleCode)) return Boolean(user.schoolId && scope.schoolIds.has(user.schoolId))
      return false
    })

    if (requestedRole) {
      users = users.filter((user) => {
        const role = roleById.get(user.roleId)
        return role?.code === requestedRole || role?.name === requestedRole
      })
    }
    if (schoolFilter) users = users.filter((user) => user.schoolId === schoolFilter)
    users = this.searchItems(users, query.search, (user) => `${user.name} ${user.email} ${user.login ?? ''}`)

    return this.page('users', users.map((user) => this.publicUser(data, user, isSuperAdminRole(roleCode) || user.id === actor.id)), query)
  }

  getUser(userId: string, targetUserId: string) {
    const { data, actor, roleCode, scope } = this.getContext(userId)
    const user = data.users.find((item) => item.id === targetUserId)
    if (!user) throw new NotFoundException('Usuario nao encontrado.')
    const canRead = isSuperAdminRole(roleCode)
      || user.id === actor.id
      || (isSchoolManagementRole(roleCode) && Boolean(user.schoolId && scope.schoolIds.has(user.schoolId)))
    if (!canRead) throw new NotFoundException('Usuario nao encontrado.')
    return this.publicUser(data, user, isSuperAdminRole(roleCode) || user.id === actor.id)
  }

  listTeachers(userId: string, query: ResourceListQueryDto = {}): PageResult<Teacher, 'teachers'> {
    const { roleCode, scope } = this.getContext(userId)
    let teachers = scope.teachers
    const schoolFilter = this.cleanFilter(query.schoolId)
    if (schoolFilter) {
      this.ensureAllowedId(scope.schoolIds, schoolFilter, 'escola')
      teachers = teachers.filter((teacher) => teacher.schoolId === schoolFilter)
    }
    const subjectFilter = this.cleanFilter(query.subject ?? query.subjectId ?? query.discipline)
    if (subjectFilter) teachers = teachers.filter((teacher) => this.subjectMatches(teacher.specialty, subjectFilter))
    teachers = this.searchItems(teachers, query.search, (teacher) => `${teacher.name} ${teacher.email} ${teacher.specialty}`)
    return this.page('teachers', teachers.map((teacher) => this.teacherDto(teacher, roleCode)), query)
  }

  getTeacher(userId: string, teacherId: string) {
    const { data, roleCode, scope } = this.getContext(userId)
    this.ensureAllowedId(scope.teacherIds, teacherId, 'professor')
    const teacher = data.teachers.find((item) => item.id === teacherId)
    if (!teacher) throw new NotFoundException('Professor nao encontrado.')
    return this.teacherDto(teacher, roleCode)
  }

  getTeacherClasses(userId: string, teacherId: string) {
    const { roleCode, scope } = this.getContext(userId)
    this.ensureAllowedId(scope.teacherIds, teacherId, 'professor')
    return {
      classes: scope.classes
        .filter((classRoom) => this.classHasTeacher(classRoom, teacherId))
        .map((classRoom) => this.classDto(classRoom, roleCode)),
    }
  }

  getTeacherSubjects(userId: string, teacherId: string) {
    const context = this.getContext(userId)
    this.ensureAllowedId(context.scope.teacherIds, teacherId, 'professor')
    return {
      subjects: this.getVisibleSubjects(context).filter((subject) => subject.teacherIds.includes(teacherId)),
    }
  }

  listGuardians(userId: string, query: ResourceListQueryDto = {}): PageResult<Guardian, 'guardians'> {
    const { roleCode, scope } = this.getContext(userId)
    let guardians = scope.guardians
    const schoolFilter = this.cleanFilter(query.schoolId)
    if (schoolFilter) {
      this.ensureAllowedId(scope.schoolIds, schoolFilter, 'escola')
      guardians = guardians.filter((guardian) => guardian.schoolId === schoolFilter)
    }
    guardians = this.searchItems(guardians, query.search, (guardian) => `${guardian.name} ${guardian.email}`)
    return this.page('guardians', guardians.map((guardian) => this.guardianDto(guardian, roleCode)), query)
  }

  listStudents(userId: string, query: ResourceListQueryDto = {}): PageResult<Student, 'students'> {
    const { roleCode, scope } = this.getContext(userId)
    let students = scope.students
    const schoolFilter = this.cleanFilter(query.schoolId)
    const classFilter = this.cleanFilter(query.classId)
    if (schoolFilter) {
      this.ensureAllowedId(scope.schoolIds, schoolFilter, 'escola')
      students = students.filter((student) => student.schoolId === schoolFilter)
    }
    if (classFilter) {
      this.ensureAllowedId(scope.classIds, classFilter, 'turma')
      students = students.filter((student) => student.classId === classFilter)
    }
    students = this.searchItems(students, query.search, (student) => `${student.name} ${student.login} ${student.registrationNumber}`)
    return this.page('students', students.map((student) => this.studentDto(student, roleCode, query.view)), query)
  }

  getStudent(userId: string, studentId: string) {
    const { data, roleCode, scope } = this.getContext(userId)
    this.ensureAllowedId(scope.studentIds, studentId, 'aluno')
    const student = data.students.find((item) => item.id === studentId)
    if (!student) throw new NotFoundException('Aluno nao encontrado.')
    return this.studentDto(student, roleCode)
  }

  listClasses(userId: string, query: ResourceListQueryDto = {}): PageResult<ClassRoom, 'classes'> {
    const { roleCode, scope } = this.getContext(userId)
    let classes = scope.classes
    const schoolFilter = this.cleanFilter(query.schoolId)
    if (schoolFilter) {
      this.ensureAllowedId(scope.schoolIds, schoolFilter, 'escola')
      classes = classes.filter((classRoom) => classRoom.schoolId === schoolFilter)
    }
    const subjectFilter = this.cleanFilter(query.subject ?? query.subjectId)
    if (subjectFilter) classes = classes.filter((classRoom) => this.classAllowsSubject(classRoom, subjectFilter))
    classes = this.searchItems(classes, query.search, (classRoom) => classRoom.name)
    return this.page('classes', classes.map((classRoom) => this.classDto(classRoom, roleCode)), query)
  }

  getClass(userId: string, classId: string) {
    const { data, roleCode, scope } = this.getContext(userId)
    this.ensureAllowedId(scope.classIds, classId, 'turma')
    const classRoom = data.classes.find((item) => item.id === classId)
    if (!classRoom) throw new NotFoundException('Turma nao encontrada.')
    return this.classDto(classRoom, roleCode)
  }

  getClassStudents(userId: string, classId: string, query: ResourceListQueryDto = {}) {
    const { roleCode, scope } = this.getContext(userId)
    this.ensureAllowedId(scope.classIds, classId, 'turma')
    const students = scope.students.filter((student) => student.classId === classId)
    return this.page('students', students.map((student) => this.studentDto(student, roleCode)), query)
  }

  getClassTeachers(userId: string, classId: string) {
    const { roleCode, scope } = this.getContext(userId)
    this.ensureAllowedId(scope.classIds, classId, 'turma')
    const classRoom = scope.classes.find((item) => item.id === classId)
    const teacherIds = new Set([classRoom?.teacherId, ...(classRoom?.teacherIds ?? [])].filter(Boolean) as string[])
    return {
      teachers: scope.teachers
        .filter((teacher) => teacherIds.has(teacher.id))
        .map((teacher) => this.teacherDto(teacher, roleCode)),
    }
  }

  getClassSubjects(userId: string, classId: string) {
    const context = this.getContext(userId)
    this.ensureAllowedId(context.scope.classIds, classId, 'turma')
    return {
      subjects: this.getVisibleSubjects(context).filter((subject) => subject.classIds.includes(classId)),
    }
  }

  listSubjects(userId: string, query: ResourceListQueryDto = {}): PageResult<SubjectDto, 'subjects'> {
    const context = this.getContext(userId)
    let subjects = this.getVisibleSubjects(context)
    const schoolFilter = this.cleanFilter(query.schoolId)
    const classFilter = this.cleanFilter(query.classId)
    const teacherFilter = this.cleanFilter(query.teacherId)
    if (schoolFilter) {
      this.ensureAllowedId(context.scope.schoolIds, schoolFilter, 'escola')
      subjects = subjects.filter((subject) => subject.schoolId === schoolFilter)
    }
    if (classFilter) {
      this.ensureAllowedId(context.scope.classIds, classFilter, 'turma')
      subjects = subjects.filter((subject) => subject.classIds.includes(classFilter))
    }
    if (teacherFilter) {
      this.ensureAllowedId(context.scope.teacherIds, teacherFilter, 'professor')
      subjects = subjects.filter((subject) => subject.teacherIds.includes(teacherFilter))
    }
    const subjectFilter = this.cleanFilter(query.subjectId ?? query.subject)
    if (subjectFilter) subjects = subjects.filter((subject) => subject.id === subjectFilter || subject.code === subjectFilter || this.subjectMatches(subject.name, subjectFilter))
    subjects = this.searchItems(subjects, query.search, (subject) => `${subject.name} ${subject.code}`)
    return this.page('subjects', subjects, query)
  }

  listTeacherAssignments(userId: string, query: ResourceListQueryDto = {}): PageResult<TeacherAssignmentDto, 'teacherAssignments'> {
    const context = this.getContext(userId)
    let assignments = this.getVisibleTeacherAssignments(context)
    const schoolFilter = this.cleanFilter(query.schoolId)
    const classFilter = this.cleanFilter(query.classId)
    const teacherFilter = this.cleanFilter(query.teacherId)
    if (schoolFilter) {
      this.ensureAllowedId(context.scope.schoolIds, schoolFilter, 'escola')
      assignments = assignments.filter((assignment) => assignment.schoolId === schoolFilter)
    }
    if (classFilter) {
      this.ensureAllowedId(context.scope.classIds, classFilter, 'turma')
      assignments = assignments.filter((assignment) => assignment.classId === classFilter)
    }
    if (teacherFilter) {
      this.ensureAllowedId(context.scope.teacherIds, teacherFilter, 'professor')
      assignments = assignments.filter((assignment) => assignment.teacherId === teacherFilter)
    }
    return this.page('teacherAssignments', assignments, query)
  }

  listMyTeacherAssignments(userId: string, query: ResourceListQueryDto = {}) {
    const context = this.getContext(userId)
    const teacherIds = context.scope.teacherIds
    const assignments = this.getVisibleTeacherAssignments(context).filter((assignment) => teacherIds.has(assignment.teacherId))
    return this.page('teacherAssignments', assignments, query)
  }

  createTeacherAssignment(userId: string, payload: CreateTeacherAssignmentDto) {
    const context = this.getContext(userId)
    if (!isSuperAdminRole(context.roleCode)) throw new ForbiddenException('Apenas SUPERADMIN pode criar vinculos de professor.')
    const teacher = context.data.teachers.find((item) => item.id === payload.teacherId)
    const classRoom = context.data.classes.find((item) => item.id === payload.classId)
    if (!teacher) throw new NotFoundException('Professor nao encontrado.')
    if (!classRoom) throw new NotFoundException('Turma nao encontrada.')
    if (teacher.schoolId !== payload.schoolId || classRoom.schoolId !== payload.schoolId) {
      throw new BadRequestException('Professor e turma precisam pertencer a escola informada.')
    }

    this.database.update((data) => {
      const storedClass = data.classes.find((item) => item.id === payload.classId)
      if (!storedClass) throw new NotFoundException('Turma nao encontrada.')
      storedClass.teacherIds = Array.from(new Set([storedClass.teacherId, ...(storedClass.teacherIds ?? []), payload.teacherId].filter(Boolean) as string[]))
      if (!storedClass.teacherId) storedClass.teacherId = payload.teacherId
    })

    return {
      id: this.assignmentId(payload.teacherId, payload.classId, payload.subjectId),
      teacherId: payload.teacherId,
      schoolId: payload.schoolId,
      classId: payload.classId,
      subjectId: payload.subjectId,
      subject: this.subjectLabel(payload.subjectId),
    }
  }

  deleteTeacherAssignment(userId: string, assignmentId: string) {
    const context = this.getContext(userId)
    if (!isSuperAdminRole(context.roleCode)) throw new ForbiddenException('Apenas SUPERADMIN pode remover vinculos de professor.')
    const [teacherId, classId] = assignmentId.split(':')
    if (!teacherId || !classId) throw new BadRequestException('Vinculo invalido.')

    this.database.update((data) => {
      const classRoom = data.classes.find((item) => item.id === classId)
      if (!classRoom) throw new NotFoundException('Turma nao encontrada.')
      classRoom.teacherIds = (classRoom.teacherIds ?? []).filter((item) => item !== teacherId)
      if (classRoom.teacherId === teacherId) classRoom.teacherId = classRoom.teacherIds[0] ?? ''
    })

    return { success: true }
  }

  listExams(userId: string, query: ResourceListQueryDto = {}): PageResult<Evaluation, 'exams'> {
    const context = this.getContext(userId)
    let exams = context.data.evaluations.filter((evaluation) => this.canReadExam(context, evaluation))
    exams = this.filterExamList(context, exams, query)
    const view = query.view === 'detail' ? 'detail' : 'list'
    const page = this.page('exams', exams, query)
    return {
      exams: page.exams.map((evaluation) => this.examDto(evaluation, context.roleCode, view)),
      pagination: page.pagination,
    }
  }

  getExam(userId: string, examId: string) {
    const context = this.getContext(userId)
    const evaluation = context.data.evaluations.find((item) => item.id === examId)
    if (!evaluation || !this.canReadExam(context, evaluation)) throw new NotFoundException('Prova nao encontrada.')
    return this.examDto(evaluation, context.roleCode, 'detail')
  }

  updateExam(userId: string, examId: string, payload: Partial<Evaluation>) {
    this.rejectPayloadFields(payload, [
      'id',
      'schoolId',
      'teacherId',
      'createdById',
      'createdByName',
      'createdBy',
      'corrected',
      'participants',
      'averageScore',
      'finalScore',
      'status',
      'approvedBy',
      'approvedAt',
      'permissions',
      'ownership',
      'tenantId',
    ])
    let updated: Evaluation | null = null
    this.database.update((data) => {
      const context = this.getContextFromData(data, userId)
      const index = data.evaluations.findIndex((item) => item.id === examId)
      if (index < 0) throw new NotFoundException('Prova nao encontrada.')
      const current = data.evaluations[index]
      if (!this.canWriteExam(context, current)) throw new ForbiddenException('Sem permissao para alterar esta prova.')
      const nextClassId = String(payload.classId ?? current.classId)
      const classRoom = data.classes.find((item) => item.id === nextClassId)
      if (!classRoom) throw new BadRequestException('Turma da prova nao encontrada.')
      const nextSubject = payload.subject ? this.subjectLabel(payload.subject) : current.subject
      const next: Evaluation = {
        id: current.id,
        schoolId: classRoom.schoolId,
        teacherId: current.teacherId,
        title: payload.title === undefined ? current.title : String(payload.title).trim(),
        classId: nextClassId,
        subject: nextSubject,
        questions: payload.questions === undefined ? current.questions : Number(payload.questions),
        omrCardVersion: current.omrCardVersion,
        scheduledAt: payload.scheduledAt === undefined ? current.scheduledAt : String(payload.scheduledAt),
        status: current.status,
        corrected: current.corrected,
        participants: current.participants,
        averageScore: current.averageScore,
        triLevel: current.triLevel,
        buildMode: current.buildMode,
        questionIds: current.questionIds,
        questionSnapshots: current.questionSnapshots,
        skillCodes: current.skillCodes,
        descriptorCodes: current.descriptorCodes,
        sourceSummary: current.sourceSummary,
        idempotencyKey: current.idempotencyKey,
        createdById: current.createdById,
        createdByName: current.createdByName,
        createdBy: current.createdBy,
      }
      if (!this.canWriteExam(context, next)) throw new ForbiddenException('Sem permissao para mover esta prova para o escopo solicitado.')
      data.evaluations[index] = next
      updated = next
    })
    return updated!
  }

  getExamQuestions(userId: string, examId: string) {
    const context = this.getContext(userId)
    const evaluation = context.data.evaluations.find((item) => item.id === examId)
    if (!evaluation || !this.canReadExam(context, evaluation)) throw new NotFoundException('Prova nao encontrada.')
    if (context.roleCode === 'ALUNO' || context.roleCode === 'RESPONSAVEL') return { questions: [] }
    const snapshots = evaluation.questionSnapshots ?? []
    const snapshotById = new Map(snapshots.map((question) => [question.id, question]))
    return {
      questions: (evaluation.questionIds ?? [])
        .map((questionId) => context.data.questions.find((question) => question.id === questionId) ?? snapshotById.get(questionId))
        .filter((question): question is Question => Boolean(question)),
    }
  }

  addExamQuestions(userId: string, examId: string, payload: { questionIds?: string[] }) {
    const questionIds = Array.from(new Set((payload.questionIds ?? []).map((id) => String(id).trim()).filter(Boolean)))
    if (!questionIds.length) throw new BadRequestException('Informe ao menos uma questao.')
    let updated: Evaluation | null = null
    this.database.update((data) => {
      const context = this.getContextFromData(data, userId)
      const index = data.evaluations.findIndex((item) => item.id === examId)
      if (index < 0) throw new NotFoundException('Prova nao encontrada.')
      if (!this.canWriteExam(context, data.evaluations[index])) throw new ForbiddenException('Sem permissao para alterar esta prova.')
      const missing = questionIds.find((questionId) => !data.questions.some((question) => question.id === questionId))
      if (missing) throw new BadRequestException(`Questao nao encontrada: ${missing}`)
      data.evaluations[index] = {
        ...data.evaluations[index],
        questionIds: Array.from(new Set([...(data.evaluations[index].questionIds ?? []), ...questionIds])),
      }
      updated = data.evaluations[index]
    })
    return updated!
  }

  listAnswerCards(userId: string, query: ResourceListQueryDto = {}): PageResult<EvaluationAnswerCard, 'answerCards'> {
    const context = this.getContext(userId)
    const visibleExamIds = new Set(context.data.evaluations.filter((evaluation) => this.canReadExam(context, evaluation)).map((evaluation) => evaluation.id))
    let cards = context.data.answerCards.filter((card) => visibleExamIds.has(card.evaluationId))
    if (context.roleCode === 'ALUNO' || context.roleCode === 'RESPONSAVEL') {
      cards = cards.filter((card) => context.scope.studentIds.has(card.studentId))
    }
    const examFilter = this.cleanFilter(query.subjectId === 'exam' ? undefined : undefined)
    void examFilter
    const page = this.page('answerCards', cards, query)
    return {
      answerCards: page.answerCards.map((card) => this.answerCardDto(card, context.roleCode)),
      pagination: page.pagination,
    }
  }

  listExamCorrections(userId: string, query: ResourceListQueryDto = {}): PageResult<EvaluationCorrection, 'examCorrections'> {
    const context = this.getContext(userId)
    const visibleExamIds = new Set(context.data.evaluations.filter((evaluation) => this.canReadExam(context, evaluation)).map((evaluation) => evaluation.id))
    let corrections = context.data.evaluationCorrections.filter((correction) => visibleExamIds.has(correction.evaluationId))
    if (context.roleCode === 'ALUNO' || context.roleCode === 'RESPONSAVEL') {
      corrections = corrections.filter((correction) => context.scope.studentIds.has(correction.studentId))
    }
    const studentFilter = this.cleanFilter(query.studentId)
    const classFilter = this.cleanFilter(query.classId)
    const statusFilter = this.cleanFilter(query.status)
    if (studentFilter) {
      this.ensureAllowedId(context.scope.studentIds, studentFilter, 'aluno')
      corrections = corrections.filter((correction) => correction.studentId === studentFilter)
    }
    if (classFilter) {
      this.ensureAllowedId(context.scope.classIds, classFilter, 'turma')
      corrections = corrections.filter((correction) => correction.classId === classFilter)
    }
    if (statusFilter) {
      this.ensureCorrectionStatus(statusFilter)
      corrections = corrections.filter((correction) => correction.status === statusFilter)
    }
    const view = query.view === 'detail' ? 'detail' : 'list'
    const page = this.page('examCorrections', corrections, query)
    return {
      examCorrections: page.examCorrections.map((correction) => this.correctionDto(correction, context.roleCode, view)),
      pagination: page.pagination,
    }
  }

  getExamCorrection(userId: string, correctionId: string) {
    const context = this.getContext(userId)
    const correction = context.data.evaluationCorrections.find((item) => item.id === correctionId)
    if (!correction || !this.canReadCorrection(context, correction)) throw new NotFoundException('Correcao nao encontrada.')
    return this.correctionDto(correction, context.roleCode, 'detail')
  }

  createManualCorrection(userId: string, payload: ManualCorrectionDto) {
    let created: EvaluationCorrection | null = null
    this.database.update((data) => {
      const context = this.getContextFromData(data, userId)
      const evaluation = data.evaluations.find((item) => item.id === payload.evaluationId)
      if (!evaluation) throw new NotFoundException('Prova nao encontrada.')
      if (!this.canExecuteCorrection(context, evaluation)) throw new ForbiddenException('Sem permissao para corrigir esta prova.')
      const classRoom = data.classes.find((item) => item.id === evaluation.classId)
      const student = data.students.find((item) => item.id === payload.studentId)
      if (!classRoom || !student || student.classId !== classRoom.id || student.schoolId !== classRoom.schoolId) {
        throw new BadRequestException('Aluno nao pertence a turma da prova.')
      }
      const now = new Date().toISOString()
      created = {
        id: `evaluation-correction-${randomUUID()}`,
        schoolId: classRoom.schoolId,
        evaluationId: evaluation.id,
        classId: classRoom.id,
        studentId: student.id,
        studentName: student.name,
        cardId: null,
        subject: evaluation.subject,
        status: payload.status ?? 'CONFIRMED',
        imageUrl: null,
        imageObject: null,
        suggestedScore: this.score(payload.finalScore ?? 0),
        finalScore: this.score(payload.finalScore ?? 0),
        correctCount: 0,
        wrongCount: 0,
        blankCount: 0,
        multipleCount: 0,
        totalQuestions: Number(evaluation.questions ?? 0),
        confidence: 1,
        requiresReview: false,
        shouldRetakeImage: false,
        failures: [],
        detectedAnswers: [],
        answerKey: [],
        rawOmrResponse: {},
        teacherNotes: payload.teacherNotes ? String(payload.teacherNotes).slice(0, 1200) : null,
        reviewedById: userId,
        reviewedAt: now,
        createdById: userId,
        createdAt: now,
        updatedAt: now,
      }
      data.evaluationCorrections.unshift(created)
    })
    return created!
  }

  listGrades(userId: string, query: ResourceListQueryDto = {}): PageResult<GradeDto, 'grades'> {
    const context = this.getContext(userId)
    let grades = this.visibleGrades(context)
    const studentFilter = this.cleanFilter(query.studentId)
    const classFilter = this.cleanFilter(query.classId)
    const statusFilter = this.cleanFilter(query.status)
    if (studentFilter) {
      this.ensureAllowedId(context.scope.studentIds, studentFilter, 'aluno')
      grades = grades.filter((grade) => grade.studentId === studentFilter)
    }
    if (classFilter) {
      this.ensureAllowedId(context.scope.classIds, classFilter, 'turma')
      grades = grades.filter((grade) => grade.classId === classFilter)
    }
    if (statusFilter) {
      this.ensureCorrectionStatus(statusFilter)
      grades = grades.filter((grade) => grade.status === statusFilter)
    }
    return this.page('grades', grades.map((grade) => this.gradeDto(grade, query.view)), query)
  }

  getGrade(userId: string, gradeId: string) {
    const context = this.getContext(userId)
    const grade = this.visibleGrades(context).find((item) => item.id === gradeId)
    if (!grade) throw new NotFoundException('Nota nao encontrada.')
    return grade
  }

  getStudentGrades(userId: string, studentId: string, query: ResourceListQueryDto = {}) {
    this.ensureAllowedId(this.getContext(userId).scope.studentIds, studentId, 'aluno')
    return this.listGrades(userId, { ...query, studentId })
  }

  listAttendance(userId: string, query: ResourceListQueryDto = {}): PageResult<AttendanceDto, 'attendance'> {
    const context = this.getContext(userId)
    let attendance = this.visibleAttendance(context)
    const studentFilter = this.cleanFilter(query.studentId)
    const classFilter = this.cleanFilter(query.classId)
    if (studentFilter) {
      this.ensureAllowedId(context.scope.studentIds, studentFilter, 'aluno')
      attendance = attendance.filter((item) => item.studentId === studentFilter)
    }
    if (classFilter) {
      this.ensureAllowedId(context.scope.classIds, classFilter, 'turma')
      attendance = attendance.filter((item) => item.classId === classFilter)
    }
    return this.page('attendance', attendance, query)
  }

  getAttendance(userId: string, attendanceId: string) {
    const context = this.getContext(userId)
    const attendance = this.visibleAttendance(context).find((item) => item.id === attendanceId)
    if (!attendance) throw new NotFoundException('Frequencia nao encontrada.')
    return attendance
  }

  getStudentAttendance(userId: string, studentId: string, query: ResourceListQueryDto = {}) {
    this.ensureAllowedId(this.getContext(userId).scope.studentIds, studentId, 'aluno')
    return this.listAttendance(userId, { ...query, studentId })
  }

  listLessonRecords(userId: string, query: ResourceListQueryDto = {}): PageResult<LessonRecord, 'lessonRecords'> {
    const context = this.getContext(userId)
    let records = context.data.lessonRecords.filter((record) => context.scope.classIds.has(record.classId))
    const classFilter = this.cleanFilter(query.classId)
    if (classFilter) {
      this.ensureAllowedId(context.scope.classIds, classFilter, 'turma')
      records = records.filter((record) => record.classId === classFilter)
    }
    const subjectFilter = this.cleanFilter(query.subject ?? query.subjectId)
    if (subjectFilter) records = records.filter((record) => this.subjectMatches(record.subject, subjectFilter))
    const page = this.page('lessonRecords', records, query)
    return {
      lessonRecords: page.lessonRecords.map((record) => this.lessonRecordDto(record, context) as LessonRecord),
      pagination: page.pagination,
    }
  }

  getLessonRecord(userId: string, lessonRecordId: string) {
    const context = this.getContext(userId)
    const record = context.data.lessonRecords.find((item) => item.id === lessonRecordId && context.scope.classIds.has(item.classId))
    if (!record) throw new NotFoundException('Registro de aula nao encontrado.')
    return this.lessonRecordDto(record, context)
  }

  listCalendarEvents(userId: string, query: ResourceListQueryDto = {}): PageResult<SchoolCalendarEvent, 'calendarEvents'> {
    const context = this.getContext(userId)
    let events = context.data.calendarEvents.filter((event) => (
      context.scope.schoolIds.has(event.schoolId) && (!event.classId || context.scope.classIds.has(event.classId))
    ))
    const schoolFilter = this.cleanFilter(query.schoolId)
    const classFilter = this.cleanFilter(query.classId)
    if (schoolFilter) {
      this.ensureAllowedId(context.scope.schoolIds, schoolFilter, 'escola')
      events = events.filter((event) => event.schoolId === schoolFilter)
    }
    if (classFilter) {
      this.ensureAllowedId(context.scope.classIds, classFilter, 'turma')
      events = events.filter((event) => event.classId === classFilter)
    }
    return this.page('calendarEvents', events, query)
  }

  getCalendarEvent(userId: string, eventId: string) {
    const context = this.getContext(userId)
    const event = context.data.calendarEvents.find((item) => (
      item.id === eventId && context.scope.schoolIds.has(item.schoolId) && (!item.classId || context.scope.classIds.has(item.classId))
    ))
    if (!event) throw new NotFoundException('Evento nao encontrado.')
    return event
  }

  listRoomReservations(userId: string, query: ResourceListQueryDto = {}): PageResult<RoomReservation, 'roomReservations'> {
    const context = this.getContext(userId)
    if (context.roleCode === 'ALUNO' || context.roleCode === 'RESPONSAVEL') {
      return this.page('roomReservations', [], query)
    }
    const reservations = context.data.roomReservations.filter((reservation) => context.scope.classIds.has(reservation.classId))
    return this.page('roomReservations', reservations, query)
  }

  listCurriculumSkills(userId: string, query: ResourceListQueryDto = {}) {
    const context = this.getContext(userId)
    if (context.roleCode === 'ALUNO' || context.roleCode === 'RESPONSAVEL') return this.page('curriculumSkills', [], query)
    return this.page('curriculumSkills', context.data.curriculumSkills.filter((skill) => skill.active), query)
  }

  listAssessmentDescriptors(userId: string, query: ResourceListQueryDto = {}) {
    const context = this.getContext(userId)
    if (context.roleCode === 'ALUNO' || context.roleCode === 'RESPONSAVEL') return this.page('assessmentDescriptors', [], query)
    return this.page('assessmentDescriptors', context.data.assessmentDescriptors.filter((descriptor) => descriptor.active), query)
  }

  listQuestionImportPlans(userId: string, query: ResourceListQueryDto = {}) {
    const context = this.getContext(userId)
    if (!isSuperAdminRole(context.roleCode) && !isSchoolManagementRole(context.roleCode)) return this.page('questionImportPlans', [], query)
    return this.page('questionImportPlans', context.data.questionImportPlans.filter((plan) => plan.active), query)
  }

  listQuestions(userId: string, query: QuestionBankPageQueryDto = {}) {
    const context = this.getContext(userId)
    const readableQuestions = context.data.questions.filter((question) => this.canReadQuestion(context, question))
    const systemQuestions = readableQuestions.filter((question) => question.sourceType !== 'INEP_ENEM')
    const enemQuestions = readableQuestions.filter((question) => question.sourceType === 'INEP_ENEM')
    let questions = readableQuestions

    const sourceMode = this.cleanFilter(query.sourceMode)
    if (sourceMode === 'system') questions = systemQuestions
    else if (sourceMode === 'enem') questions = enemQuestions

    const gradeLevelFilter = this.cleanFilter(query.gradeLevel)
    if (gradeLevelFilter) questions = questions.filter((question) => this.normalize(question.gradeLevel) === this.normalize(gradeLevelFilter))

    const difficultyFilter = this.cleanFilter(query.difficulty)
    if (difficultyFilter) questions = questions.filter((question) => question.difficulty === difficultyFilter)

    const statusFilter = this.cleanFilter(query.status)
    if (statusFilter) questions = questions.filter((question) => question.status === statusFilter)

    const sourceTypeFilter = this.cleanFilter(query.sourceType)
    if (sourceTypeFilter) questions = questions.filter((question) => question.sourceType === sourceTypeFilter)

    const schoolFilter = this.cleanFilter(query.schoolId)
    if (schoolFilter) {
      if (!isSuperAdminRole(context.roleCode)) this.ensureAllowedId(context.scope.schoolIds, schoolFilter, 'escola')
      questions = questions.filter((question) => question.schoolId === schoolFilter)
    }

    const createdByFilter = this.cleanFilter(query.createdById)
    if (createdByFilter) questions = questions.filter((question) => question.createdById === createdByFilter)

    const skillFilter = this.cleanFilter(query.skillCode)
    if (skillFilter) {
      questions = questions.filter((question) => (
        question.skills.some((skill) => skill.id === skillFilter || skill.code === skillFilter)
      ))
    }

    const descriptorFilter = this.cleanFilter(query.descriptorCode)
    if (descriptorFilter) {
      questions = questions.filter((question) => (
        question.descriptors.some((descriptor) => descriptor.id === descriptorFilter || descriptor.code === descriptorFilter)
      ))
    }

    const subjectFilter = this.cleanFilter(query.subject)
    if (subjectFilter) {
      questions = questions.filter((question) => (
        this.subjectMatches(question.subject, subjectFilter) ||
        this.subjectMatches(question.component, subjectFilter) ||
        this.subjectMatches(question.area, subjectFilter)
      ))
    }

    questions = this.searchItems(questions, query.search ?? undefined, (question) => [
      question.title,
      question.context,
      question.statement,
      question.explanation,
      question.subject,
      question.component,
      question.area,
      question.sourceName,
      question.sourceExternalId,
      question.options.map((option) => option.text).join(' '),
      question.skills.map((skill) => `${skill.code} ${skill.description}`).join(' '),
      question.descriptors.map((descriptor) => `${descriptor.program} ${descriptor.code} ${descriptor.description}`).join(' '),
    ].join(' '))

    const page = this.page('questions', questions, query as ResourceListQueryDto)

    return {
      ...page,
      totals: {
        all: readableQuestions.length,
        system: systemQuestions.length,
        enem: enemQuestions.length,
        filtered: questions.length,
      },
      facets: this.buildQuestionFacets(readableQuestions),
    }
  }

  getPedagogicalMetrics(userId: string, query: ResourceListQueryDto = {}) {
    const context = this.getContext(userId)
    const students = context.scope.students
    const grades = this.visibleGrades(context)
    const attendanceRows = this.visibleAttendance(context)
    const attendanceByStudent = new Map<string, AttendanceDto[]>()
    for (const row of attendanceRows) {
      attendanceByStudent.set(row.studentId, [...(attendanceByStudent.get(row.studentId) ?? []), row])
    }
    const studentMetrics = students.map((student) => {
      const studentGrades = grades.filter((grade) => grade.studentId === student.id)
      const attendance = attendanceByStudent.get(student.id) ?? []
      const averageGrade = studentGrades.length
        ? studentGrades.reduce((sum, grade) => sum + Number(grade.score ?? 0), 0) / studentGrades.length
        : Number(student.averageScore ?? 0)
      const attendanceRate = attendance.length
        ? (attendance.filter((item) => item.present).length / attendance.length) * 100
        : Number(student.attendanceRate ?? 100)
      return {
        studentId: student.id,
        studentName: student.name,
        schoolId: student.schoolId,
        classId: student.classId,
        averageGrade: Number(averageGrade.toFixed(2)),
        attendanceRate: Number(attendanceRate.toFixed(2)),
        risk: averageGrade < 6 || attendanceRate < 75,
      }
    })
    const classFilter = this.cleanFilter(query.classId)
    const filtered = classFilter
      ? studentMetrics.filter((metric) => {
          this.ensureAllowedId(context.scope.classIds, classFilter, 'turma')
          return metric.classId === classFilter
        })
      : studentMetrics
    return {
      metrics: filtered,
      totals: {
        students: filtered.length,
        lowGrades: filtered.filter((item) => item.averageGrade < 6).length,
        lowAttendance: filtered.filter((item) => item.attendanceRate < 75).length,
        studentsAtRisk: filtered.filter((item) => item.risk).length,
      },
    }
  }

  private getContext(userId: string): AccessContext {
    const database = this.database as DatabaseService & { getRevision?: () => number }
    const revision = typeof database.getRevision === 'function' ? database.getRevision() : 0
    const cacheKey = `${userId}:${revision}`
    const cached = this.contextCache.get(cacheKey)
    if (cached) return cached

    const context = this.getContextFromData(this.readDataForQuery(), userId)
    if (this.contextCache.size > 100) this.contextCache.clear()
    this.contextCache.set(cacheKey, context)
    return context
  }

  private getContextFromData(data: DatabaseShape, userId: string): AccessContext {
    const actor = data.users.find((user) => user.id === userId)
    if (!actor) throw new UnauthorizedException('Usuario nao encontrado.')
    if (actor.status !== 'ativo') throw new UnauthorizedException('Usuario bloqueado ou inativo.')
    const roleCode = this.getRoleCode(data, actor)
    const scope = this.buildScope(data, actor, roleCode)
    return { data, actor, roleCode, scope }
  }

  private buildScope(data: DatabaseShape, actor: UserAccount, roleCode: RoleCode): ScopedResourceSet {
    const teacherIds = new Set(data.teachers
      .filter((teacher) => teacher.id === actor.linkedTeacherId || teacher.userId === actor.id)
      .map((teacher) => teacher.id))
    const guardianIds = new Set(data.guardians
      .filter((guardian) => guardian.id === actor.linkedGuardianId || guardian.userId === actor.id)
      .map((guardian) => guardian.id))
    const ownStudentIds = new Set(data.students
      .filter((student) => student.id === actor.linkedStudentId || student.userId === actor.id)
      .map((student) => student.id))

    if (isNetworkAdminRole(roleCode)) return this.scopeFromResources(data, data.schools, data.classes, data.teachers, data.guardians, data.students)

    if (isSchoolManagementRole(roleCode)) {
      const schools = data.schools.filter((school) => actor.schoolId === school.id)
      const schoolIds = new Set(schools.map((school) => school.id))
      return this.scopeFromResources(
        data,
        schools,
        data.classes.filter((classRoom) => schoolIds.has(classRoom.schoolId)),
        data.teachers.filter((teacher) => schoolIds.has(teacher.schoolId)),
        data.guardians.filter((guardian) => schoolIds.has(guardian.schoolId)),
        data.students.filter((student) => schoolIds.has(student.schoolId)),
      )
    }

    if (roleCode === 'PROFESSOR') {
      const classes = data.classes.filter((classRoom) => (
        teacherIds.has(classRoom.teacherId) || (classRoom.teacherIds ?? []).some((teacherId) => teacherIds.has(teacherId))
      ))
      const classIds = new Set(classes.map((classRoom) => classRoom.id))
      const schools = data.schools.filter((school) => classes.some((classRoom) => classRoom.schoolId === school.id) || school.id === actor.schoolId)
      const students = data.students.filter((student) => classIds.has(student.classId))
      const studentGuardianIds = new Set(students.flatMap((student) => student.guardianIds ?? []))
      return this.scopeFromResources(
        data,
        schools,
        classes,
        data.teachers.filter((teacher) => teacherIds.has(teacher.id)),
        data.guardians.filter((guardian) => studentGuardianIds.has(guardian.id)),
        students,
      )
    }

    if (roleCode === 'ALUNO') {
      const students = data.students.filter((student) => ownStudentIds.has(student.id))
      const classIds = new Set(students.map((student) => student.classId))
      const schoolIds = new Set(students.map((student) => student.schoolId))
      return this.scopeFromResources(
        data,
        data.schools.filter((school) => schoolIds.has(school.id)),
        data.classes.filter((classRoom) => classIds.has(classRoom.id)),
        [],
        [],
        students,
      )
    }

    if (roleCode === 'RESPONSAVEL') {
      const guardians = data.guardians.filter((guardian) => guardianIds.has(guardian.id))
      const linkedStudentIds = new Set(guardians.flatMap((guardian) => guardian.studentIds ?? []))
      const students = data.students.filter((student) => linkedStudentIds.has(student.id) || (student.guardianIds ?? []).some((guardianId) => guardianIds.has(guardianId)))
      const classIds = new Set(students.map((student) => student.classId))
      const schoolIds = new Set(students.map((student) => student.schoolId))
      return this.scopeFromResources(
        data,
        data.schools.filter((school) => schoolIds.has(school.id)),
        data.classes.filter((classRoom) => classIds.has(classRoom.id)),
        [],
        guardians,
        students,
      )
    }

    return this.scopeFromResources(data, [], [], [], [], [])
  }

  private scopeFromResources(
    _data: DatabaseShape,
    schools: School[],
    classes: ClassRoom[],
    teachers: Teacher[],
    guardians: Guardian[],
    students: Student[],
  ): ScopedResourceSet {
    return {
      schools,
      classes,
      teachers,
      guardians,
      students,
      schoolIds: new Set(schools.map((school) => school.id)),
      classIds: new Set(classes.map((classRoom) => classRoom.id)),
      teacherIds: new Set(teachers.map((teacher) => teacher.id)),
      guardianIds: new Set(guardians.map((guardian) => guardian.id)),
      studentIds: new Set(students.map((student) => student.id)),
    }
  }

  private getRoleCode(data: { roles: Role[] }, user: UserAccount): RoleCode {
    const role = data.roles.find((item) => item.id === user.roleId)
    return normalizeRoleCode(role?.code, role?.name, user.roleId) ?? 'ALUNO'
  }

  private ensureAllowedId(allowedIds: Set<string>, id: string, resourceLabel: string) {
    if (!allowedIds.has(id)) throw new ForbiddenException(`Sem permissao para acessar este recurso: ${resourceLabel}.`)
  }

  private rejectPayloadFields(payload: object | null | undefined, fields: string[]) {
    if (!payload || typeof payload !== 'object') return
    const blocked = fields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field))
    if (blocked.length) throw new BadRequestException(`Campos nao permitidos no payload: ${blocked.join(', ')}`)
  }

  private cleanFilter(value?: string | number | null) {
    const normalized = String(value ?? '').trim()
    return normalized && normalized !== 'all' ? normalized : ''
  }

  private ensureCorrectionStatus(status: string): asserts status is EvaluationCorrectionStatus {
    if (!['SUGGESTED', 'CONFIRMED', 'NEEDS_RETAKE', 'REJECTED'].includes(status)) {
      throw new BadRequestException('Status de correcao invalido.')
    }
  }

  private page<T, K extends string>(key: K, items: T[], query: ResourceListQueryDto = {}, defaultLimit = 25): PageResult<T, K> {
    const rawPage = Math.trunc(Number(query.page ?? 1)) || 1
    const rawLimit = Math.trunc(Number(query.limit ?? defaultLimit)) || defaultLimit
    const page = Math.max(1, rawPage)
    const limit = Math.min(100, Math.max(1, rawLimit))
    const total = items.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * limit

    return {
      [key]: items.slice(start, start + limit),
      pagination: { page: safePage, limit, total, totalPages },
    } as PageResult<T, K>
  }

  private searchItems<T>(items: T[], search: string | undefined, selector: (item: T) => string) {
    const query = this.normalize(search)
    if (!query) return items
    return items.filter((item) => this.normalize(selector(item)).includes(query))
  }

  private publicUser(data: DatabaseShape, user: UserAccount, includePrivateProfile = false): PublicUserAccount {
    const { password: _password, cpf: _cpf, birthDate: _birthDate, phone: _phone, ...safe } = user
    const schoolId = this.resolveUserSchoolId(data, user)
    if (includePrivateProfile) {
      const { password: __password, ...publicUser } = user
      return { ...publicUser, schoolId }
    }
    return {
      ...safe,
      schoolId,
      phone: undefined,
      cpf: undefined,
      birthDate: undefined,
    } as unknown as PublicUserAccount
  }

  private schoolDto(school: School, roleCode: RoleCode, view = 'default'): School {
    if (view === 'identity') {
      return {
        id: school.id,
        name: school.name,
      } as unknown as School
    }
    if (isSuperAdminRole(roleCode) || isSchoolAdminRole(roleCode) || roleCode === 'DIRETOR') return school
    return { ...school, address: undefined, director: undefined, inepCode: undefined } as unknown as School
  }

  private teacherDto(teacher: Teacher, roleCode: RoleCode): Teacher {
    if (isSuperAdminRole(roleCode) || isSchoolManagementRole(roleCode)) return teacher
    return { ...teacher, userId: undefined, email: undefined } as unknown as Teacher
  }

  private guardianDto(guardian: Guardian, roleCode: RoleCode): Guardian {
    if (isSuperAdminRole(roleCode) || isSchoolAdminRole(roleCode) || roleCode === 'RESPONSAVEL') return guardian
    return { ...guardian, userId: undefined, email: undefined, phone: undefined, studentIds: undefined } as unknown as Guardian
  }

  private studentDto(student: Student, roleCode: RoleCode, view = 'default'): Student {
    if (view === 'identity') {
      return {
        id: student.id,
        name: student.name,
        schoolId: student.schoolId,
        classId: student.classId,
        avatarUrl: student.avatarUrl,
      } as unknown as Student
    }
    if (isSuperAdminRole(roleCode) || isSchoolManagementRole(roleCode)) return student
    return {
      ...student,
      userId: undefined,
      login: undefined,
      registration: undefined,
      registrationNumber: undefined,
      guardianIds: roleCode === 'RESPONSAVEL' ? student.guardianIds : undefined,
    } as unknown as Student
  }

  private classDto(classRoom: ClassRoom, roleCode: RoleCode, view = 'default'): ClassRoom {
    if (view === 'summary') {
      return {
        id: classRoom.id,
        name: classRoom.name,
        grade: classRoom.grade,
        shift: classRoom.shift,
        schoolId: classRoom.schoolId,
      } as unknown as ClassRoom
    }
    if (isSuperAdminRole(roleCode) || isSchoolManagementRole(roleCode) || roleCode === 'PROFESSOR') return classRoom
    return { ...classRoom, schedule: undefined } as unknown as ClassRoom
  }

  private examDto(evaluation: Evaluation, roleCode: RoleCode, view: 'list' | 'detail' = 'list'): Evaluation {
    if (roleCode === 'ALUNO' || roleCode === 'RESPONSAVEL') {
      const { questionIds: _questionIds, questionSnapshots: _questionSnapshots, skillCodes: _skillCodes, descriptorCodes: _descriptorCodes, ...safe } = evaluation
      return safe
    }
    if (view === 'detail') return evaluation
    const { questionSnapshots: _questionSnapshots, ...safe } = evaluation
    return safe
  }

  private answerCardDto(card: EvaluationAnswerCard, roleCode: RoleCode): EvaluationAnswerCard {
    void roleCode
    return { ...card, qrPayload: undefined, teacherId: undefined } as unknown as EvaluationAnswerCard
  }

  private correctionDto(correction: EvaluationCorrection, roleCode: RoleCode, view: 'list' | 'detail' = 'list'): EvaluationCorrection {
    const safeCorrection = {
      ...correction,
      hasImage: Boolean(correction.imageObject || correction.imageUrl),
      imageUrl: undefined,
      imageObject: undefined,
      rawOmrResponse: undefined,
      answerKey: view === 'detail' ? correction.answerKey : undefined,
      detectedAnswers: view === 'detail' ? correction.detectedAnswers : undefined,
    } as unknown as EvaluationCorrection

    if (roleCode !== 'ALUNO' && roleCode !== 'RESPONSAVEL') return safeCorrection
    if (roleCode === 'ALUNO' && view === 'detail') {
      return {
        ...safeCorrection,
        hasImage: undefined,
        teacherNotes: correction.teacherNotes ?? null,
      } as unknown as EvaluationCorrection
    }
    return {
      ...safeCorrection,
      hasImage: undefined,
      detectedAnswers: undefined,
      answerKey: undefined,
      teacherNotes: correction.teacherNotes ?? null,
    } as unknown as EvaluationCorrection
  }

  private gradeDto(grade: GradeDto, view = 'default'): GradeDto {
    if (view === 'summary') {
      return {
        id: grade.id,
        studentId: grade.studentId,
        classId: grade.classId,
        evaluationId: grade.evaluationId,
        evaluationTitle: grade.evaluationTitle,
        subject: grade.subject,
        score: grade.score,
        status: grade.status,
        scheduledAt: grade.scheduledAt,
        correctCount: grade.correctCount,
        totalQuestions: grade.totalQuestions,
        reviewedAt: grade.reviewedAt,
      } as GradeDto
    }
    return grade
  }

  private lessonRecordDto(record: LessonRecord, context: AccessContext): LessonRecord | StudentLessonRecordDto {
    if (context.roleCode !== 'ALUNO' && context.roleCode !== 'RESPONSAVEL') return record
    return {
      id: record.id,
      classId: record.classId,
      subject: record.subject,
      date: record.date,
      time: record.time,
      attendance: Object.fromEntries(Object.entries(record.attendance ?? {}).filter(([studentId]) => context.scope.studentIds.has(studentId))),
    }
  }

  private buildQuestionFacets(questions: Question[]) {
    return {
      gradeLevels: this.uniqueSorted(questions.map((question) => question.gradeLevel)),
      sourceTypes: this.uniqueSorted(questions.map((question) => question.sourceType)),
      schoolIds: this.uniqueSorted(questions.map((question) => question.schoolId)),
      createdByIds: this.uniqueSorted(questions.map((question) => question.createdById)),
      subjects: this.uniqueSorted(questions.flatMap((question) => [question.subject, question.component, question.area])),
      skills: this.uniqueByCode(questions.flatMap((question) => question.skills)),
      descriptors: this.uniqueByCode(questions.flatMap((question) => question.descriptors)),
    }
  }

  private uniqueSorted(values: Array<string | null | undefined>) {
    return Array.from(new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right))
  }

  private uniqueByCode<T extends { id: string; code: string }>(items: T[]) {
    const seen = new Set<string>()
    const unique: T[] = []
    for (const item of items) {
      const key = item.code || item.id
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(item)
    }
    return unique.sort((left, right) => left.code.localeCompare(right.code))
  }

  private filterExamList(context: AccessContext, exams: Evaluation[], query: ResourceListQueryDto) {
    const schoolFilter = this.cleanFilter(query.schoolId)
    const classFilter = this.cleanFilter(query.classId)
    const teacherFilter = this.cleanFilter(query.teacherId)
    const subjectFilter = this.cleanFilter(query.subject ?? query.subjectId)
    const examStatusFilter = this.cleanFilter(query.examStatus)

    if (schoolFilter) {
      this.ensureAllowedId(context.scope.schoolIds, schoolFilter, 'escola')
      exams = exams.filter((exam) => this.examSchoolId(context.data, exam) === schoolFilter)
    }
    if (classFilter) {
      this.ensureAllowedId(context.scope.classIds, classFilter, 'turma')
      exams = exams.filter((exam) => exam.classId === classFilter)
    }
    if (teacherFilter) {
      this.ensureAllowedId(context.scope.teacherIds, teacherFilter, 'professor')
      exams = exams.filter((exam) => exam.teacherId === teacherFilter || exam.createdById === teacherFilter)
    }
    if (subjectFilter) exams = exams.filter((exam) => this.subjectMatches(exam.subject, subjectFilter))
    if (examStatusFilter) exams = exams.filter((exam) => exam.status === examStatusFilter)
    return this.searchItems(exams, query.search, (exam) => `${exam.title} ${exam.subject}`)
  }

  private canReadExam(context: AccessContext, evaluation: Evaluation) {
    if (isSuperAdminRole(context.roleCode)) return true
    const schoolId = this.examSchoolId(context.data, evaluation)
    if (schoolId && !context.scope.schoolIds.has(schoolId)) return false
    if (!context.scope.classIds.has(evaluation.classId)) return false
    if (context.roleCode === 'PROFESSOR') return this.teacherCanReadExam(context, evaluation)
    return isSchoolManagementRole(context.roleCode) || ['ALUNO', 'RESPONSAVEL'].includes(context.roleCode)
  }

  private canWriteExam(context: AccessContext, evaluation: Evaluation) {
    if (isSuperAdminRole(context.roleCode)) return true
    if (context.roleCode === 'DIRETOR') return this.canReadExam(context, evaluation)
    if (context.roleCode !== 'PROFESSOR') return false
    return this.teacherCanReadExam(context, evaluation)
  }

  private canExecuteCorrection(context: AccessContext, evaluation: Evaluation) {
    if (isSuperAdminRole(context.roleCode)) return true
    if (context.roleCode !== 'PROFESSOR') return false
    return this.teacherCanReadExam(context, evaluation)
  }

  private teacherCanReadExam(context: AccessContext, evaluation: Evaluation) {
    const classRoom = context.data.classes.find((item) => item.id === evaluation.classId)
    if (!classRoom) return false
    const teachers = context.data.teachers.filter((teacher) => context.scope.teacherIds.has(teacher.id))
    return teachers.some((teacher) => {
      if (teacher.schoolId !== classRoom.schoolId) return false
      if (evaluation.teacherId === teacher.id || evaluation.createdById === context.actor.id || evaluation.createdById === teacher.userId) return true
      if (!this.classHasTeacher(classRoom, teacher.id)) return false
      return this.subjectMatches(teacher.specialty, evaluation.subject) || this.classAllowsSubject(classRoom, evaluation.subject)
    })
  }

  private canReadCorrection(context: AccessContext, correction: EvaluationCorrection) {
    const evaluation = context.data.evaluations.find((item) => item.id === correction.evaluationId)
    if (!evaluation || !this.canReadExam(context, evaluation)) return false
    if (context.roleCode === 'ALUNO' || context.roleCode === 'RESPONSAVEL') return context.scope.studentIds.has(correction.studentId)
    return true
  }

  private canReadQuestion(context: AccessContext, question: Question) {
    if (question.sourceType === 'INEP_ENEM' || question.visibility === 'GLOBAL' || question.visibility === 'NETWORK') return true
    if (question.visibility === 'PRIVATE') {
      return question.createdById === context.actor.id || question.createdById === context.actor.linkedTeacherId
    }
    if (isSuperAdminRole(context.roleCode)) return true
    if (context.scope.schoolIds.has(question.schoolId)) return true
    return question.createdById === context.actor.id || question.createdById === context.actor.linkedTeacherId
  }

  private visibleGrades(context: AccessContext): GradeDto[] {
    return context.data.evaluationCorrections
      .filter((correction) => this.canReadCorrection(context, correction))
      .map((correction) => {
        const evaluation = context.data.evaluations.find((item) => item.id === correction.evaluationId)
        const student = context.data.students.find((item) => item.id === correction.studentId)
        return {
          id: correction.id,
          studentId: correction.studentId,
          studentName: correction.studentName ?? student?.name ?? '',
          schoolId: correction.schoolId ?? student?.schoolId ?? '',
          classId: correction.classId,
          evaluationId: correction.evaluationId,
          evaluationTitle: evaluation?.title ?? '',
          subject: correction.subject ?? evaluation?.subject ?? '',
          score: correction.finalScore ?? correction.suggestedScore ?? null,
          status: correction.status,
          scheduledAt: evaluation?.scheduledAt ?? null,
          correctCount: correction.correctCount,
          totalQuestions: correction.totalQuestions,
          reviewedAt: correction.reviewedAt,
        }
      })
  }

  private visibleAttendance(context: AccessContext): AttendanceDto[] {
    const studentsById = new Map(context.scope.students.map((student) => [student.id, student]))
    const rows: AttendanceDto[] = []
    for (const record of context.data.lessonRecords) {
      if (!context.scope.classIds.has(record.classId)) continue
      for (const [studentId, present] of Object.entries(record.attendance ?? {})) {
        const student = studentsById.get(studentId)
        if (!student) continue
        rows.push({
          id: `${record.id}:${studentId}`,
          studentId,
          studentName: student.name,
          schoolId: student.schoolId,
          classId: record.classId,
          lessonRecordId: record.id,
          subject: record.subject,
          date: record.date,
          present: Boolean(present),
        })
      }
    }
    return rows
  }

  private getVisibleSubjects(context: AccessContext): SubjectDto[] {
    const subjectsById = new Map<string, SubjectDto>()
    for (const classRoom of context.scope.classes) {
      const classTeacherIds = [classRoom.teacherId, ...(classRoom.teacherIds ?? [])].filter((teacherId) => context.scope.teacherIds.has(teacherId))
      const classSubjects = this.classSubjects(classRoom)
      const subjects = context.roleCode === 'PROFESSOR'
        ? classTeacherIds.flatMap((teacherId) => {
            const teacher = context.data.teachers.find((item) => item.id === teacherId)
            const teacherSubjects = this.subjectsFromText(teacher?.specialty)
            const matching = teacherSubjects.filter((subject) => !classSubjects.length || classSubjects.some((classSubject) => this.subjectMatches(classSubject.name, subject.name)))
            return matching.length ? matching : teacherSubjects
          })
        : classSubjects

      for (const subject of subjects) {
        const id = `${classRoom.schoolId}:${subject.id}`
        const current = subjectsById.get(id) ?? { ...subject, id, schoolId: classRoom.schoolId, classIds: [], teacherIds: [] }
        if (!current.classIds.includes(classRoom.id)) current.classIds.push(classRoom.id)
        for (const teacherId of classTeacherIds) {
          if (!current.teacherIds.includes(teacherId)) current.teacherIds.push(teacherId)
        }
        subjectsById.set(id, current)
      }
    }
    return Array.from(subjectsById.values()).sort((first, second) => first.name.localeCompare(second.name, 'pt-BR'))
  }

  private getVisibleTeacherAssignments(context: AccessContext): TeacherAssignmentDto[] {
    const assignments: TeacherAssignmentDto[] = []
    for (const classRoom of context.scope.classes) {
      const teacherIds = [classRoom.teacherId, ...(classRoom.teacherIds ?? [])].filter((teacherId) => context.scope.teacherIds.has(teacherId))
      for (const teacherId of Array.from(new Set(teacherIds))) {
        const teacher = context.data.teachers.find((item) => item.id === teacherId)
        const teacherSubjects = this.subjectsFromText(teacher?.specialty)
        const classSubjects = this.classSubjects(classRoom)
        const subjects = teacherSubjects.filter((subject) => !classSubjects.length || classSubjects.some((classSubject) => this.subjectMatches(classSubject.name, subject.name)))
        for (const subject of subjects.length ? subjects : teacherSubjects) {
          assignments.push({
            id: this.assignmentId(teacherId, classRoom.id, subject.id),
            teacherId,
            schoolId: classRoom.schoolId,
            classId: classRoom.id,
            subjectId: subject.id,
            subject: subject.name,
          })
        }
      }
    }
    return assignments
  }

  private assignmentId(teacherId: string, classId: string, subjectId: string) {
    return `${teacherId}:${classId}:${subjectId}`
  }

  private classHasTeacher(classRoom: ClassRoom, teacherId: string) {
    return classRoom.teacherId === teacherId || (classRoom.teacherIds ?? []).includes(teacherId)
  }

  private examSchoolId(data: DatabaseShape, evaluation: Evaluation) {
    return evaluation.schoolId ?? data.classes.find((classRoom) => classRoom.id === evaluation.classId)?.schoolId ?? ''
  }

  private classAllowsSubject(classRoom: ClassRoom, subject: string) {
    const subjects = this.classSubjects(classRoom)
    return !subjects.length || subjects.some((item) => this.subjectMatches(item.name, subject))
  }

  private classSubjects(classRoom: ClassRoom): SubjectDto[] {
    const fromFocus = (classRoom.bnccFocus ?? []).flatMap((value) => this.subjectsFromText(value))
    if (fromFocus.length) return this.uniqueSubjects(fromFocus)
    return this.uniqueSubjects(this.subjectsForGrade(classRoom.grade).map((name) => this.subjectFromLabel(name)))
  }

  private subjectsFromText(value?: string | null): SubjectDto[] {
    const parts = String(value ?? '')
      .split(/[,;|/]+|\s+-\s+|\s+(?:e|ou)\s+/i)
      .map((item) => item.trim())
      .filter(Boolean)
    const subjects = (parts.length ? parts : [String(value ?? '')]).map((part) => this.subjectFromLabel(part)).filter((subject) => subject.name)
    return this.uniqueSubjects(subjects)
  }

  private uniqueSubjects(subjects: SubjectDto[]) {
    const byCode = new Map<string, SubjectDto>()
    for (const subject of subjects) byCode.set(subject.code, subject)
    return Array.from(byCode.values())
  }

  private subjectFromLabel(value: string): SubjectDto {
    const code = this.subjectCode(value) ?? this.normalize(value).replace(/\s+/g, '_').toUpperCase()
    return { id: code, code, name: this.subjectLabel(value), classIds: [], teacherIds: [] }
  }

  private subjectLabel(value?: string | null) {
    const code = this.subjectCode(value)
    const labels: Record<string, string> = {
      LINGUA_PORTUGUESA: 'Lingua Portuguesa',
      LINGUA_INGLESA: 'Lingua Inglesa',
      LINGUA_ESPANHOLA: 'Lingua Espanhola',
      MATEMATICA: 'Matematica',
      CIENCIAS: 'Ciencias',
      HISTORIA: 'Historia',
      GEOGRAFIA: 'Geografia',
      BIOLOGIA: 'Biologia',
      FISICA: 'Fisica',
      QUIMICA: 'Quimica',
      FILOSOFIA: 'Filosofia',
      SOCIOLOGIA: 'Sociologia',
      ARTE: 'Arte',
      EDUCACAO_FISICA: 'Educacao Fisica',
      REDACAO: 'Redacao',
      LITERATURA: 'Literatura',
      ENSINO_RELIGIOSO: 'Ensino Religioso',
      PROJETO_DE_VIDA: 'Projeto de Vida',
    }
    return code ? labels[code] ?? code : String(value ?? '').trim()
  }

  private subjectCode(value?: string | null): string | null {
    const text = this.normalize(value)
    if (!text) return null
    if (/educacao fisica|ed fisica/.test(text)) return 'EDUCACAO_FISICA'
    if (/lingua portuguesa|portugues|portuguesa/.test(text)) return 'LINGUA_PORTUGUESA'
    if (/lingua inglesa|ingles|inglesa|english/.test(text)) return 'LINGUA_INGLESA'
    if (/lingua espanhola|espanhol|espanhola|espanol|spanish/.test(text)) return 'LINGUA_ESPANHOLA'
    if (/ensino religioso|religiao|religioso/.test(text)) return 'ENSINO_RELIGIOSO'
    if (/projeto de vida|projeto vida/.test(text)) return 'PROJETO_DE_VIDA'
    if (/literatura/.test(text)) return 'LITERATURA'
    if (/redacao/.test(text)) return 'REDACAO'
    if (/matematica/.test(text)) return 'MATEMATICA'
    if (/biologia/.test(text)) return 'BIOLOGIA'
    if (/(^|\s)fisica(\s|$)/.test(text)) return 'FISICA'
    if (/quimica/.test(text)) return 'QUIMICA'
    if (/historia/.test(text)) return 'HISTORIA'
    if (/geografia/.test(text)) return 'GEOGRAFIA'
    if (/filosofia/.test(text)) return 'FILOSOFIA'
    if (/sociologia/.test(text)) return 'SOCIOLOGIA'
    if (/ciencias/.test(text)) return 'CIENCIAS'
    if (/(^|\s)arte(s)?(\s|$)/.test(text)) return 'ARTE'
    return null
  }

  private subjectMatches(left?: string | null, right?: string | null) {
    const leftCode = this.subjectCode(left)
    const rightCode = this.subjectCode(right)
    if (leftCode || rightCode) return Boolean(leftCode && rightCode && leftCode === rightCode)
    const normalizedLeft = this.normalize(left)
    const normalizedRight = this.normalize(right)
    return Boolean(normalizedLeft && normalizedRight && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)))
  }

  private subjectsForGrade(grade?: string | null) {
    const normalized = String(grade ?? '').trim().toUpperCase()
    if (/^EM[1-3]$/.test(normalized)) return ['Lingua Portuguesa', 'Redacao', 'Literatura', 'Matematica', 'Historia', 'Geografia', 'Filosofia', 'Sociologia', 'Biologia', 'Fisica', 'Quimica', 'Arte', 'Educacao Fisica', 'Lingua Inglesa']
    if (/^EF[6-9]$/.test(normalized)) return ['Lingua Portuguesa', 'Matematica', 'Ciencias', 'Historia', 'Geografia', 'Arte', 'Educacao Fisica', 'Lingua Inglesa']
    return ['Lingua Portuguesa', 'Matematica', 'Ciencias', 'Historia', 'Geografia', 'Arte', 'Educacao Fisica']
  }

  private normalize(value?: string | null) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .toLowerCase()
  }

  private score(value: unknown) {
    const score = Number(value)
    if (!Number.isFinite(score) || score < 0 || score > 10) throw new BadRequestException('Nota deve estar entre 0 e 10.')
    return Number(score.toFixed(2))
  }

  private resolveUserSchoolId(data: DatabaseShape, user: UserAccount) {
    if (user.schoolId && data.schools.some((school) => school.id === user.schoolId)) return user.schoolId
    if (user.linkedTeacherId) return data.teachers.find((teacher) => teacher.id === user.linkedTeacherId)?.schoolId ?? null
    if (user.linkedStudentId) return data.students.find((student) => student.id === user.linkedStudentId)?.schoolId ?? null
    if (user.linkedGuardianId) return data.guardians.find((guardian) => guardian.id === user.linkedGuardianId)?.schoolId ?? null
    return null
  }
}
