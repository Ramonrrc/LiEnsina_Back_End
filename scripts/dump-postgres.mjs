import { createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadEnvFile } from './database-env.mjs'

loadEnvFile()

const scriptDir = dirname(fileURLToPath(import.meta.url))
const backendDir = resolve(scriptDir, '..')
const projectDir = resolve(backendDir, '..')
const outputDir = resolve(process.env.POSTGRES_DUMP_DIR || join(projectDir, '..', 'Backups_LiEnsina', 'postgres'))
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputPath = resolve(process.argv[2] || join(outputDir, `liensina-postgres-${timestamp}.dump`))
const manifestPath = `${outputPath}.json`

const database = process.env.POSTGRES_DB || 'liensina'
const user = process.env.POSTGRES_USER || 'liensina'
const container = process.env.POSTGRES_CONTAINER || findPostgresContainer()

mkdirSync(dirname(outputPath), { recursive: true })

await runDump(container, user, database, outputPath)

writeFileSync(manifestPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  database,
  user,
  container,
  format: 'pg_dump custom',
  dump: outputPath,
  sizeBytes: statSync(outputPath).size,
}, null, 2))

console.log(`Dump PostgreSQL criado: ${outputPath}`)
console.log(`Manifesto: ${manifestPath}`)

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

function runDump(containerName, dbUser, dbName, targetPath) {
  return new Promise((resolvePromise, reject) => {
    const dump = spawn('docker', [
      'exec',
      containerName,
      'pg_dump',
      '-U',
      dbUser,
      '-d',
      dbName,
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ])
    const output = createWriteStream(targetPath)
    const stderr = []
    let finished = false
    let exitCode = null

    const completeIfReady = () => {
      if (!finished || exitCode === null) return
      if (exitCode === 0) {
        resolvePromise()
        return
      }

      reject(new Error(`pg_dump falhou com codigo ${exitCode}: ${Buffer.concat(stderr).toString('utf8')}`))
    }

    dump.stdout.pipe(output)
    dump.stderr.on('data', (chunk) => stderr.push(chunk))
    dump.on('error', reject)
    output.on('error', reject)
    output.on('finish', () => {
      finished = true
      completeIfReady()
    })
    dump.on('close', (code) => {
      exitCode = code
      completeIfReady()
    })
  })
}
