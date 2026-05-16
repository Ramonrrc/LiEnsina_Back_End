#!/usr/bin/env node
const { createRequire } = await import('node:module')

const require = createRequire(import.meta.url)
require('ts-node/register/transpile-only')

const { NestFactory } = require('@nestjs/core')
const { AppModule } = require('../src/app.module')
const { DatabaseService } = require('../src/database.service')
const { LiensinaService } = require('../src/liensina.service')

const allYears = Array.from({ length: 2023 - 2009 + 1 }, (_, index) => 2009 + index)
const fromYear = Number(process.env.ENEM_FROM_YEAR ?? allYears[0])
const toYear = Number(process.env.ENEM_TO_YEAR ?? allYears[allYears.length - 1])
const years = allYears.filter((year) => year >= fromYear && year <= toYear)

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getAdminUser(data) {
  const adminRole = data.roles.find((role) => role.code === 'ADMIN')
  if (!adminRole) throw new Error('Perfil ADMIN nao encontrado no banco.')

  const admin = data.users.find((user) => user.roleId === adminRole.id && user.status === 'ativo')
  if (!admin) throw new Error('Usuario ADMIN ativo nao encontrado no banco.')

  return admin
}

function countEnemByYear(questions) {
  return allYears.map((year) => ({
    year,
    count: questions.filter((question) => question.sourceType === 'INEP_ENEM' && question.sourceYear === year).length,
  }))
}

async function main() {
  process.env.DATABASE_DRIVER = 'postgres'
  process.env.DATABASE_SSL = process.env.DATABASE_SSL ?? 'false'

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  })

  try {
    const database = app.get(DatabaseService)
    const liensina = app.get(LiensinaService)
    const actor = getAdminUser(database.read())

    console.log(`Importando ENEM 2009-2023 no PostgreSQL como ${actor.email || actor.login || actor.id}.`)

    for (const year of years) {
      const existingForYear = database.read().questions.filter(
        (question) => question.sourceType === 'INEP_ENEM' && question.sourceYear === year,
      ).length
      if (existingForYear >= 170 && process.env.ENEM_REFRESH !== 'true') {
        console.log(`ENEM ${year} | ja importado=${existingForYear} | pulando`)
        continue
      }

      const result = await liensina.generateEnemQuestions(actor.id, {
        years: [year],
        quantity: 180,
        refresh: process.env.ENEM_REFRESH === 'true',
      })

      const data = database.read()
      const importedForYear = data.questions.filter(
        (question) => question.sourceType === 'INEP_ENEM' && question.sourceYear === year,
      ).length

      console.log(
        [
          `ENEM ${year}`,
          `buscadas=${result.fetchedCount}`,
          `novas=${result.importedCount}`,
          `persistidas_no_ano=${importedForYear}`,
        ].join(' | '),
      )

      await wait(3000)
    }

    const finalData = database.read()
    const enemQuestions = finalData.questions.filter((question) => question.sourceType === 'INEP_ENEM')
    const withImages = enemQuestions.filter((question) =>
      question.attachments?.some((attachment) => /^data:image\//i.test(String(attachment.fileUrl ?? ''))) ||
      /^.*data:image\//is.test(`${question.context ?? ''} ${question.statement ?? ''} ${question.options?.map((option) => option.text).join(' ') ?? ''}`),
    )

    console.log('Resumo por ano:')
    for (const item of countEnemByYear(finalData.questions)) {
      console.log(`${item.year}: ${item.count}`)
    }

    console.log(`Total de questoes no banco: ${finalData.questions.length}`)
    console.log(`Total ENEM: ${enemQuestions.length}`)
    console.log(`Questoes ENEM com imagem embutida: ${withImages.length}`)
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
