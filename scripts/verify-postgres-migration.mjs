import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import initSqlJs from 'sql.js'
import pg from 'pg'

import { loadEnvFile, postgresSslConfig, requireDatabaseUrl, resolveSqlitePath } from './database-env.mjs'

const { Pool } = pg

loadEnvFile()

const sqlitePath = resolveSqlitePath()
const SQL = await initSqlJs({
  locateFile: (file) => resolve(process.cwd(), 'node_modules/sql.js/dist', file),
})
const sqlite = new SQL.Database(readFileSync(sqlitePath))
const sqliteRows = sqlite.exec('SELECT name, payload FROM collections ORDER BY name')[0]?.values ?? []
const sqliteCounts = Object.fromEntries(sqliteRows.map(([name, payload]) => [String(name), JSON.parse(String(payload)).length]))

const pool = new Pool({
  connectionString: requireDatabaseUrl(),
  ssl: postgresSslConfig(),
})
const postgresRows = await pool.query(`
  SELECT name, jsonb_array_length(payload) AS total
  FROM collections
  ORDER BY name
`)
const postgresCounts = Object.fromEntries(postgresRows.rows.map((row) => [String(row.name), Number(row.total)]))
const mismatches = Object.entries(sqliteCounts).filter(([name, total]) => postgresCounts[name] !== total)

await pool.end()
sqlite.close()

console.table(Object.keys(sqliteCounts).map((name) => ({
  collection: name,
  sqlite: sqliteCounts[name],
  postgres: postgresCounts[name] ?? null,
  ok: sqliteCounts[name] === postgresCounts[name],
})))

if (mismatches.length > 0) {
  throw new Error(`Verificacao falhou: ${JSON.stringify(mismatches)}`)
}

console.log('Verificacao concluida: SQLite e PostgreSQL possuem as mesmas contagens por colecao.')
