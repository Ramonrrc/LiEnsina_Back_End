import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

const forbiddenPathPattern = /(^|\/)(\.env|\.env\..+)$|(data\/backups|\.sqlite(?:3)?(?:\.|$)|\.dump$|\.backup(?:-|$)|\.bak$|\.sql$|credenciais|credentials|secret|private[_-]?key)/i
const allowedPathPattern = /(^|\/)\.env\.example$|docs\/.*\.example\.sql$|^migrations\/\d{8}_.+\.sql$/i
const skippedContentPathPattern = /(^|\/)(node_modules|dist|coverage|\.codex-tmp|\.git)\//i
const allowedContentPathPattern = /^(MIGRATION_LOCAL_STORE_TO_POSTGRES\.md|src\/security-auth\.test\.ts)$/i
const suspiciousContentPatterns = [
  /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
  /\bDATABASE_URL\s*[:=]\s*['"]?[^'"\s]+:\/\/[^'"\s]+:[^'"\s]+@/,
  /\b(?:JWT_ACCESS_SECRET|JWT_REFRESH_SECRET|OMR_INTERNAL_TOKEN|API_KEY|PRIVATE_KEY|PASSWORD|TOKEN|SECRET)\b\s*[:=]\s*['"]?(?!replace_|process\.env|config\.get|readEnv|strong|weak|JWT_|OMR_|DATABASE_|REDIS_|POSTGRES_|AUTH_|CORS_|SWAGGER_)[^\s'"]{20,}/,
]

function listGitFiles(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    return []
  }
}

const files = new Set([
  ...listGitFiles(['ls-files']),
  ...listGitFiles(['ls-files', '--others', '--exclude-standard']),
  ...listGitFiles(['ls-files', '--others', '--ignored', '--exclude-standard']),
])

const pathOffenders = [...files].filter((file) => {
  const normalized = file.replace(/\\/g, '/')
  return forbiddenPathPattern.test(normalized) && !allowedPathPattern.test(normalized)
})

const contentOffenders = []
for (const file of files) {
  const normalized = file.replace(/\\/g, '/')
  if (allowedPathPattern.test(normalized) || !existsSync(file)) continue
  if (skippedContentPathPattern.test(normalized) || allowedContentPathPattern.test(normalized)) continue
  try {
    const stats = statSync(file)
    if (!stats.isFile() || stats.size > 1024 * 1024) continue
    const content = readFileSync(file, 'utf8')
    if (suspiciousContentPatterns.some((pattern) => pattern.test(content))) contentOffenders.push(file)
  } catch {
    // Arquivos binarios ou inacessiveis sao ignorados pela verificacao de conteudo.
  }
}

if (pathOffenders.length || contentOffenders.length) {
  console.error('Arquivos ou conteudos sensiveis foram encontrados:')
  for (const file of pathOffenders) console.error(`- caminho bloqueado: ${file}`)
  for (const file of contentOffenders) console.error(`- conteudo suspeito: ${file}`)
  console.error('Remova-os do Git/workspace compartilhado e armazene backups/secrets fora do repositorio, com criptografia.')
  process.exit(1)
}
