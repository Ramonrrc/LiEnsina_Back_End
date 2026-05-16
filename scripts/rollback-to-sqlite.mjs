import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { loadEnvFile, resolveSqlitePath } from './database-env.mjs'

loadEnvFile()

const backupPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : ''
if (!backupPath || !existsSync(backupPath)) {
  throw new Error('Informe um backup SQLite valido. Exemplo: npm run db:rollback:sqlite -- data/backups/liensina.sqlite.backup-2026-05-11T12-00-00-000Z')
}

const sqlitePath = resolveSqlitePath()
mkdirSync(dirname(sqlitePath), { recursive: true })
copyFileSync(backupPath, sqlitePath)

console.log(`Rollback concluido. SQLite restaurado em ${sqlitePath}`)
console.log('Para subir usando SQLite, defina DATABASE_DRIVER=sqlite e DATABASE_PATH apontando para esse arquivo.')
