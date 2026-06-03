import { createReadStream, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { loadEnvFile } from './database-env.mjs'

loadEnvFile()

const dumpPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : ''
if (!dumpPath || !existsSync(dumpPath)) {
  throw new Error('Informe um dump valido. Exemplo: npm run db:restore:postgres -- data/backups/postgres/liensina-postgres.dump')
}

const database = process.env.POSTGRES_DB || 'liensina'
const user = process.env.POSTGRES_USER || 'liensina'
const container = process.env.POSTGRES_CONTAINER || findPostgresContainer()

await restoreDump(container, user, database, dumpPath)

console.log(`Dump restaurado no PostgreSQL: ${dumpPath}`)

function findPostgresContainer() {
  const result = spawnSync('docker', [
    'ps',
    '--filter',
    'name=postgres',
    '--format',
    '{{.Names}}',
  ], { encoding: 'utf8' })

  if (result.status !== 0) {
    throw new Error(`Nao foi possivel listar containers Docker: ${result.stderr || result.stdout}`)
  }

  const containers = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (containers.length === 0) {
    throw new Error('Nenhum container Postgres em execucao encontrado. Defina POSTGRES_CONTAINER ou suba o docker-compose.')
  }

  return containers.find((name) => name.includes('liensina')) || containers[0]
}

function restoreDump(containerName, dbUser, dbName, sourcePath) {
  return new Promise((resolvePromise, reject) => {
    const restore = spawn('docker', [
      'exec',
      '-i',
      containerName,
      'pg_restore',
      '-U',
      dbUser,
      '-d',
      dbName,
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
    ])
    const input = createReadStream(sourcePath)
    const stderr = []

    input.pipe(restore.stdin)
    restore.stderr.on('data', (chunk) => stderr.push(chunk))
    restore.on('error', reject)
    input.on('error', reject)
    restore.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      reject(new Error(`pg_restore falhou com codigo ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
    })
  })
}
