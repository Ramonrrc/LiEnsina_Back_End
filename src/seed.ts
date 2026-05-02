import type { DatabaseShape } from './liensina.types'

const allPermissions = ['dashboard:ler', 'escolas:gerenciar', 'turmas:gerenciar', 'alunos:gerenciar', 'simulados:gerenciar', 'diario:registrar', 'relatorios:tri', 'cargos:gerenciar', 'auditoria:ler']

export function createSeedData(): DatabaseShape {
  return {
    roles: [
      { id: 'role-secretaria', name: 'Secretaria', description: 'Gestao global da rede, escolas, cargos e documentos oficiais.', permissions: allPermissions },
      { id: 'role-diretor', name: 'Diretor', description: 'Gestao estrategica da escola, indicadores, turmas e alertas.', permissions: ['dashboard:ler', 'turmas:gerenciar', 'alunos:gerenciar', 'simulados:gerenciar', 'relatorios:tri', 'auditoria:ler'] },
      { id: 'role-professor', name: 'Professor', description: 'Diario eletronico, chamada, notas e acompanhamento da turma.', permissions: ['dashboard:ler', 'diario:registrar', 'simulados:gerenciar', 'relatorios:tri'] },
      { id: 'role-apoio', name: 'Apoio Escolar', description: 'Apoio administrativo com acesso reduzido.', permissions: ['dashboard:ler'] },
    ],
    schools: [
      { id: 'esc-centro', name: 'Escola Municipal LiEnsina Centro', city: 'Teresina', address: 'Rua das Laranjeiras, 120 - Centro', director: 'Marina Castro', inepCode: '22000011', active: true },
      { id: 'esc-norte', name: 'Unidade Escolar Horizonte Norte', city: 'Teresina', address: 'Avenida das Escolas, 850 - Zona Norte', director: 'Rafael Matos', inepCode: '22000022', active: true },
      { id: 'esc-sul', name: 'Centro Educacional Caminhos do Saber', city: 'Teresina', address: 'Rua Projetada, 44 - Zona Sul', director: 'Luciana Rocha', inepCode: '22000033', active: true },
    ],
    teachers: [
      { id: 'prof-ana', name: 'Ana Beatriz Lima', email: 'ana.lima@liensina.local', schoolId: 'esc-centro', specialty: 'Lingua Portuguesa' },
      { id: 'prof-carlos', name: 'Carlos Eduardo Nunes', email: 'carlos.nunes@liensina.local', schoolId: 'esc-centro', specialty: 'Matematica' },
      { id: 'prof-helena', name: 'Helena Duarte', email: 'helena.duarte@liensina.local', schoolId: 'esc-norte', specialty: 'Ciencias da Natureza' },
      { id: 'prof-joao', name: 'Joao Pedro Alves', email: 'joao.alves@liensina.local', schoolId: 'esc-sul', specialty: 'Historia e Geografia' },
    ],
    classes: [
      { id: 'turma-5a', name: '5 Ano A', grade: '5 ano', shift: 'Manha', schoolId: 'esc-centro', teacherId: 'prof-ana', academicYear: 2026, schedule: 'Segunda a sexta, 07:30 as 11:30', bnccFocus: ['EF05LP01', 'EF05LP03', 'EF05MA07'] },
      { id: 'turma-6b', name: '6 Ano B', grade: '6 ano', shift: 'Tarde', schoolId: 'esc-centro', teacherId: 'prof-carlos', academicYear: 2026, schedule: 'Segunda a sexta, 13:00 as 17:00', bnccFocus: ['EF06MA03', 'EF06MA11', 'EF06LP04'] },
      { id: 'turma-4a', name: '4 Ano A', grade: '4 ano', shift: 'Manha', schoolId: 'esc-norte', teacherId: 'prof-helena', academicYear: 2026, schedule: 'Segunda a sexta, 07:20 as 11:20', bnccFocus: ['EF04CI05', 'EF04MA10'] },
      { id: 'turma-7c', name: '7 Ano C', grade: '7 ano', shift: 'Tarde', schoolId: 'esc-sul', teacherId: 'prof-joao', academicYear: 2026, schedule: 'Segunda a sexta, 13:10 as 17:10', bnccFocus: ['EF07HI01', 'EF07GE03'] },
    ],
    students: [
      { id: 'alu-001', name: 'Livia Sousa', registration: '2026001', schoolId: 'esc-centro', classId: 'turma-5a', status: 'matriculado', attendanceRate: 96, averageScore: 8.4, riskLevel: 'baixo' },
      { id: 'alu-002', name: 'Miguel Rocha', registration: '2026002', schoolId: 'esc-centro', classId: 'turma-5a', status: 'matriculado', attendanceRate: 72, averageScore: 5.7, riskLevel: 'alto' },
      { id: 'alu-003', name: 'Sofia Martins', registration: '2026003', schoolId: 'esc-centro', classId: 'turma-5a', status: 'matriculado', attendanceRate: 89, averageScore: 7.1, riskLevel: 'medio' },
      { id: 'alu-004', name: 'Arthur Silva', registration: '2026004', schoolId: 'esc-centro', classId: 'turma-6b', status: 'matriculado', attendanceRate: 91, averageScore: 8.9, riskLevel: 'baixo' },
      { id: 'alu-005', name: 'Clara Mendes', registration: '2026005', schoolId: 'esc-centro', classId: 'turma-6b', status: 'matriculado', attendanceRate: 78, averageScore: 6.2, riskLevel: 'medio' },
      { id: 'alu-006', name: 'Davi Oliveira', registration: '2026006', schoolId: 'esc-norte', classId: 'turma-4a', status: 'matriculado', attendanceRate: 68, averageScore: 5.2, riskLevel: 'alto' },
      { id: 'alu-007', name: 'Isabela Costa', registration: '2026007', schoolId: 'esc-norte', classId: 'turma-4a', status: 'matriculado', attendanceRate: 94, averageScore: 9.1, riskLevel: 'baixo' },
      { id: 'alu-008', name: 'Bernardo Alves', registration: '2026008', schoolId: 'esc-sul', classId: 'turma-7c', status: 'matriculado', attendanceRate: 87, averageScore: 7.4, riskLevel: 'medio' },
      { id: 'alu-009', name: 'Helena Freitas', registration: '2026009', schoolId: 'esc-sul', classId: 'turma-7c', status: 'matriculado', attendanceRate: 97, averageScore: 8.8, riskLevel: 'baixo' },
    ],
    evaluations: [
      { id: 'sim-001', title: 'Simulado BNCC - Leitura e Interpretacao', classId: 'turma-5a', subject: 'Lingua Portuguesa', questions: 24, scheduledAt: '2026-05-12', status: 'corrigindo', corrected: 21, participants: 28, averageScore: 7.2, triLevel: 'Basico' },
      { id: 'sim-002', title: 'Avaliacao Diagnostica de Matematica', classId: 'turma-6b', subject: 'Matematica', questions: 30, scheduledAt: '2026-05-20', status: 'planejado', corrected: 0, participants: 31, averageScore: 0, triLevel: 'Aguardando aplicacao' },
      { id: 'sim-003', title: 'Ciencias - Cadeias Alimentares', classId: 'turma-4a', subject: 'Ciencias', questions: 18, scheduledAt: '2026-04-18', status: 'concluido', corrected: 26, participants: 26, averageScore: 8.1, triLevel: 'Adequado' },
    ],
    calendarEvents: [
      { id: 'cal-planejamento-maio', title: 'Planejamento pedagogico de maio', type: 'reuniao', schoolId: 'esc-centro', classId: null, startsAt: '2026-05-06T09:00', endsAt: '2026-05-06T10:30', allDay: false, location: 'Sala da coordenacao', description: 'Alinhamento de simulados, frequencia e intervencoes.' },
      { id: 'cal-feira-ciencias', title: 'Feira de Ciencias da rede', type: 'evento', schoolId: 'esc-norte', classId: 'turma-4a', startsAt: '2026-05-28', endsAt: '2026-05-28', allDay: true, location: 'Patio principal', description: 'Mostra dos projetos de Ciencias da Natureza.' },
    ],
    users: [
      { id: 'usr-secretaria', name: 'Secretaria Geral', email: 'secretaria@liensina.local', password: 'secretaria@liensina.local', roleId: 'role-secretaria', schoolId: null, status: 'ativo', phone: '(86) 99999-1000' },
      { id: 'usr-diretor', name: 'Marina Castro', email: 'diretor@liensina.local', password: 'diretor@liensina.local', roleId: 'role-diretor', schoolId: 'esc-centro', status: 'ativo', phone: '(86) 99999-2000' },
      { id: 'usr-professor', name: 'Ana Beatriz Lima', email: 'professor@liensina.local', password: 'professor@liensina.local', roleId: 'role-professor', schoolId: 'esc-centro', status: 'ativo', phone: '(86) 99999-3000' },
      { id: 'usr-apoio', name: 'Equipe de Apoio', email: 'apoio@liensina.local', password: 'apoio@liensina.local', roleId: 'role-apoio', schoolId: 'esc-norte', status: 'ativo', phone: '(86) 99999-4000' },
    ],
    auditEvents: [
      { id: 'aud-001', actor: 'Secretaria Geral', action: 'Criou calendario de simulados da rede', target: 'Simulados 2026', createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString() },
      { id: 'aud-002', actor: 'Marina Castro', action: 'Revisou alerta de evasao', target: 'Miguel Rocha', createdAt: new Date(Date.now() - 1000 * 60 * 160).toISOString() },
      { id: 'aud-003', actor: 'Ana Beatriz Lima', action: 'Atualizou diario de classe', target: '5 Ano A', createdAt: new Date(Date.now() - 1000 * 60 * 300).toISOString() },
    ],
  }
}

