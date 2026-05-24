import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { loadEnvFile, resolveSqlitePath } from './database-env.mjs'

loadEnvFile()

const snapshotPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : ''
if (!snapshotPath || !existsSync(snapshotPath)) {
  throw new Error('Informe um snapshot local valido. Exemplo: npm run db:restore:local -- C:\\caminho\\seguro\\snapshot-local')
}

const sqlitePath = resolveSqlitePath()
mkdirSync(dirname(sqlitePath), { recursive: true })
copyFileSync(snapshotPath, sqlitePath)

console.log(`Rollback concluido. SQLite restaurado em ${sqlitePath}`)
console.log('Para subir usando SQLite, defina DATABASE_DRIVER=sqlite e DATABASE_PATH apontando para esse arquivo.')
