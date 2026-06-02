import type { RoleCode } from './liensina.types'

const roleAliases: Array<{ code: RoleCode; matches: string[] }> = [
  { code: 'SUPERADMIN', matches: ['SUPERADMIN', 'SUPER ADMIN', 'SUPER ADMINISTRADOR', 'ROOT'] },
  { code: 'ADMIN_ESCOLA', matches: ['ADMIN ESCOLA', 'ADMINISTRADOR ESCOLAR', 'ADMINISTRADORA ESCOLAR', 'ADMINESCOLA', 'SCHOOL ADMIN'] },
  { code: 'ADMIN', matches: ['ADMIN', 'ADMINISTRADOR', 'ADMINISTRADORA'] },
  { code: 'DIRETOR', matches: ['DIRETOR', 'DIRETORA', 'DIRECAO', 'DIRETORIA'] },
  { code: 'COORDENADOR', matches: ['COORDENADOR', 'COORDENADORA', 'COORDENACAO', 'PEDAGOGO', 'PEDAGOGA', 'PEDAGOGICO', 'PEDAGOGICA'] },
  { code: 'PROFESSOR', matches: ['PROFESSOR', 'PROFESSORA', 'DOCENTE', 'TEACHER'] },
  { code: 'ALUNO', matches: ['ALUNO', 'ALUNA', 'ESTUDANTE', 'STUDENT'] },
  { code: 'RESPONSAVEL', matches: ['RESPONSAVEL', 'RESPONSAVEIS', 'PAI', 'MAE', 'PAIS', 'GUARDIAN'] },
  { code: 'NUTRITIONIST', matches: ['NUTRITIONIST', 'NUTRICIONISTA', 'NUTRICAO', 'NUTRICAO ESCOLAR'] },
]

function normalizeRoleText(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

export function normalizeRoleCode(...values: unknown[]): RoleCode | null {
  for (const value of values) {
    const normalized = normalizeRoleText(value)
    if (!normalized) continue
    const compact = normalized.replace(/\s+/g, '')
    const tokens = normalized.split(/\s+/)

    for (const { code, matches } of roleAliases) {
      if (matches.some((match) => {
        const normalizedMatch = normalizeRoleText(match)
        return normalized === normalizedMatch || compact === normalizedMatch.replace(/\s+/g, '') || tokens.includes(normalizedMatch)
      })) {
        return code
      }
    }
  }

  return null
}
