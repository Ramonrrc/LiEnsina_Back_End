import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import initSqlJs from 'sql.js'
import pg from 'pg'

import { loadEnvFile, postgresSslConfig, requireDatabaseUrl, resolveSqlitePath } from './database-env.mjs'

const { Pool } = pg

loadEnvFile()

const sqlitePath = resolveSqlitePath()
const databaseUrl = requireDatabaseUrl()
const overwrite = String(process.env.POSTGRES_MIGRATION_OVERWRITE || '').toLowerCase() === 'true'

if (!existsSync(sqlitePath)) {
  throw new Error(`SQLite nao encontrado em ${sqlitePath}`)
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(dirname(sqlitePath), 'backups')
const backupPath = join(backupDir, `${basename(sqlitePath)}.backup-${timestamp}`)
mkdirSync(backupDir, { recursive: true })
copyFileSync(sqlitePath, backupPath)

const SQL = await initSqlJs({
  locateFile: (file) => resolve(process.cwd(), 'node_modules/sql.js/dist', file),
})
const sqlite = new SQL.Database(readFileSync(sqlitePath))
const result = sqlite.exec('SELECT name, payload, updated_at FROM collections ORDER BY name')
const rows = result[0]?.values ?? []
const collections = rows.map(([name, payload, updatedAt]) => {
  const parsedPayload = JSON.parse(String(payload))
  if (!Array.isArray(parsedPayload)) {
    throw new Error(`Payload da colecao ${name} nao e um array JSON valido.`)
  }
  return {
    name: String(name),
    payload: parsedPayload,
    updatedAt: String(updatedAt || new Date().toISOString()),
  }
})

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: postgresSslConfig(),
})
const client = await pool.connect()

try {
  await client.query('BEGIN')
  await client.query(`
    CREATE TABLE IF NOT EXISTS collections (
      name text PRIMARY KEY,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT collections_payload_is_array CHECK (jsonb_typeof(payload) = 'array')
    )
  `)
  await client.query('CREATE INDEX IF NOT EXISTS collections_updated_at_idx ON collections (updated_at)')
  await client.query('CREATE INDEX IF NOT EXISTS collections_payload_gin_idx ON collections USING gin (payload jsonb_path_ops)')

  const existing = await client.query('SELECT count(*)::int AS total FROM collections')
  if (existing.rows[0]?.total > 0 && !overwrite) {
    throw new Error('O PostgreSQL ja possui dados em collections. Defina POSTGRES_MIGRATION_OVERWRITE=true para substituir conscientemente.')
  }

  if (overwrite) await client.query('DELETE FROM collections')

  for (const collection of collections) {
    await client.query(
      `
        INSERT INTO collections (name, payload, updated_at)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (name)
        DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
      `,
      [collection.name, JSON.stringify(collection.payload), collection.updatedAt],
    )
  }

  const verification = await client.query(`
    SELECT name, jsonb_array_length(payload) AS total
    FROM collections
    ORDER BY name
  `)

  const sourceCounts = Object.fromEntries(collections.map((collection) => [collection.name, collection.payload.length]))
  const targetCounts = Object.fromEntries(verification.rows.map((row) => [row.name, Number(row.total)]))
  const mismatches = Object.entries(sourceCounts).filter(([name, total]) => targetCounts[name] !== total)

  if (mismatches.length > 0) {
    throw new Error(`A verificacao encontrou divergencias antes do commit: ${JSON.stringify(mismatches)}`)
  }

  await client.query('COMMIT')

  const manifestPath = join(backupDir, `migration-sqlite-postgres-${timestamp}.json`)
  writeFileSync(manifestPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    sqliteSource: sqlitePath,
    sqliteBackup: backupPath,
    sqliteBackupSizeBytes: statSync(backupPath).size,
    collections: sourceCounts,
    postgresCollections: targetCounts,
    mismatches,
  }, null, 2))

  console.log(`Migracao concluida. Backup: ${backupPath}`)
  console.log(`Manifesto: ${manifestPath}`)
} catch (error) {
  await client.query('ROLLBACK')
  console.error('Migracao abortada. O SQLite original foi preservado.')
  throw error
} finally {
  client.release()
  await pool.end()
  sqlite.close()
}
