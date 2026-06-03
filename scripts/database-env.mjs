import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function loadEnvFile(filePath) {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const candidatePaths = filePath
    ? [resolve(process.cwd(), filePath)]
    : [
        resolve(process.cwd(), '.env'),
        resolve(scriptDir, '..', '.env'),
        resolve(scriptDir, '..', '..', '.env'),
      ]

  for (const absolutePath of candidatePaths) {
    loadSingleEnvFile(absolutePath)
  }
}

function loadSingleEnvFile(absolutePath) {
  if (!existsSync(absolutePath)) return

  const content = readFileSync(absolutePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()
    const value = rawValue.replace(/^['"]|['"]$/g, '')
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

export function resolveSqlitePath() {
  const configuredPath = process.env.SQLITE_SOURCE_PATH || process.env.DATABASE_PATH || 'data/liensina.sqlite'
  return resolve(process.cwd(), configuredPath.replace(/\.json$/i, '.sqlite'))
}

export function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL nao foi definida. Configure a URL do PostgreSQL local ou do Neon antes de executar.')
  }
  return databaseUrl
}

export function postgresSslConfig() {
  const sslMode = String(process.env.DATABASE_SSL || '').trim().toLowerCase()
  return sslMode === 'true' || sslMode === 'require' ? { rejectUnauthorized: false } : undefined
}
