import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { loadEnvFile, resolveSqlitePath } from './database-env.mjs'

loadEnvFile()

const sqlitePath = resolveSqlitePath()
if (!existsSync(sqlitePath)) {
  throw new Error(`SQLite nao encontrado em ${sqlitePath}`)
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(dirname(sqlitePath), 'backups')
const backupPath = join(backupDir, `${basename(sqlitePath)}.backup-${timestamp}`)
mkdirSync(backupDir, { recursive: true })
copyFileSync(sqlitePath, backupPath)

const manifestPath = `${backupPath}.json`
writeFileSync(manifestPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  source: sqlitePath,
  backup: backupPath,
  sizeBytes: statSync(backupPath).size,
}, null, 2))

console.log(`Backup SQLite criado: ${backupPath}`)
