export type RiskLevel = 'baixo' | 'medio' | 'alto'
export type EvaluationStatus = 'planejado' | 'em_aplicacao' | 'corrigindo' | 'concluido'
export type UserStatus = 'ativo' | 'pendente' | 'bloqueado'
export type CalendarEventType = 'aula' | 'reuniao' | 'avaliacao' | 'prazo' | 'evento'

export interface Role { id: string; name: string; description: string; permissions: string[] }
export interface UserAccount { id: string; name: string; email: string; password: string; roleId: string; schoolId: string | null; status: UserStatus; phone: string; avatarUrl?: string }
export type PublicUserAccount = Omit<UserAccount, 'password'>
export interface School { id: string; name: string; city: string; address: string; director: string; inepCode: string; active: boolean }
export interface Teacher { id: string; name: string; email: string; schoolId: string; specialty: string }
export interface Student { id: string; name: string; registration: string; schoolId: string; classId: string; status: 'matriculado' | 'transferido' | 'inativo'; attendanceRate: number; averageScore: number; riskLevel: RiskLevel }
export interface ClassRoom { id: string; name: string; grade: string; shift: 'Manha' | 'Tarde' | 'Noite'; schoolId: string; teacherId: string; academicYear: number; schedule: string; bnccFocus: string[] }
export interface Evaluation { id: string; title: string; classId: string; subject: string; questions: number; scheduledAt: string; status: EvaluationStatus; corrected: number; participants: number; averageScore: number; triLevel: string }
export interface SchoolCalendarEvent { id: string; title: string; type: CalendarEventType; schoolId: string; classId: string | null; startsAt: string; endsAt: string; allDay: boolean; location: string; description: string }
export interface AuditEvent { id: string; actor: string; action: string; target: string; createdAt: string }
export interface DatabaseShape { users: UserAccount[]; roles: Role[]; schools: School[]; teachers: Teacher[]; students: Student[]; classes: ClassRoom[]; evaluations: Evaluation[]; calendarEvents: SchoolCalendarEvent[]; auditEvents: AuditEvent[] }
export interface JwtPayload { sub: string; email: string }

