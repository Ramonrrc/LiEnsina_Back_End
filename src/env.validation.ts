type RawEnv = Record<string, unknown>

const weakSecretValues = new Set([
  'secret',
  'changeme',
  'change-me',
  'liensina-local-secret',
  'troque-por-um-segredo-longo-com-64-caracteres-ou-mais',
  'troque-por-um-segredo-longo-com-64-caracteres-fortes-ou-mais',
  'troque-por-outro-segredo-longo-com-64-caracteres-fortes-ou-mais',
  'troque-por-um-token-interno-forte-com-64-caracteres-ou-mais',
])

function readEnv(env: RawEnv, key: string) {
  return String(env[key] ?? '').trim()
}

function isProduction(env: RawEnv) {
  return readEnv(env, 'NODE_ENV') === 'production'
}

function isStrongSecret(value: string) {
  if (value.length < 64) return false
  if (weakSecretValues.has(value.toLowerCase())) return false
  const hasLower = /[a-z]/.test(value)
  const hasUpper = /[A-Z]/.test(value)
  const hasDigit = /\d/.test(value)
  const hasSymbol = /[^a-zA-Z0-9]/.test(value)
  return [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length >= 3
}

function parseDurationSeconds(value: string, fallback: number) {
  const match = value.match(/^(\d+)(s|m|h|d)?$/i)
  if (!match) return fallback

  const amount = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  if (unit === 'd') return amount * 24 * 60 * 60
  if (unit === 'h') return amount * 60 * 60
  if (unit === 'm') return amount * 60
  return amount
}

function parseDatabasePassword(databaseUrl: string) {
  try {
    return new URL(databaseUrl).password
  } catch {
    return ''
  }
}

function assertStrongSecret(env: RawEnv, key: string, errors: string[]) {
  const value = readEnv(env, key)
  if (!value) {
    errors.push(`${key} e obrigatoria.`)
    return
  }
  if (!isStrongSecret(value)) {
    errors.push(`${key} deve ter pelo menos 64 caracteres fortes e nao pode usar valores padrao.`)
  }
}

function assertStrongProductionPassword(env: RawEnv, errors: string[]) {
  const explicitPassword = readEnv(env, 'POSTGRES_PASSWORD')
  const urlPassword = parseDatabasePassword(readEnv(env, 'DATABASE_URL'))
  const password = explicitPassword || urlPassword

  if (!password) {
    errors.push('POSTGRES_PASSWORD ou senha em DATABASE_URL e obrigatoria em producao.')
    return
  }
  if (password.length < 20 || weakSecretValues.has(password.toLowerCase()) || password === 'liensina_dev_password') {
    errors.push('POSTGRES_PASSWORD/DATABASE_URL deve usar senha forte em producao.')
  }
}

function assertCors(env: RawEnv, errors: string[]) {
  const origins = readEnv(env, 'CORS_ORIGINS')
  if (!origins) {
    errors.push('CORS_ORIGINS e obrigatoria em producao.')
    return
  }
  if (origins.split(',').map((origin) => origin.trim()).some((origin) => origin === '*' || origin === 'null')) {
    errors.push('CORS_ORIGINS nao pode conter wildcard ou origem null.')
  }
}

function assertProductionDatabase(env: RawEnv, errors: string[]) {
  const driver = readEnv(env, 'DATABASE_DRIVER').toLowerCase()
  const url = readEnv(env, 'DATABASE_URL')

  if (driver && driver !== 'postgres' && driver !== 'postgresql') {
    errors.push('DATABASE_DRIVER deve ser postgres em producao.')
  }
  if (!url) {
    errors.push('DATABASE_URL e obrigatoria em producao.')
  }
}

function assertProductionRateLimit(env: RawEnv, errors: string[]) {
  const redisUrl = readEnv(env, 'RATE_LIMIT_REDIS_URL') || readEnv(env, 'REDIS_URL')
  if (!redisUrl) {
    errors.push('RATE_LIMIT_REDIS_URL ou REDIS_URL e obrigatoria em producao para rate limit distribuido.')
    return
  }
  try {
    const url = new URL(redisUrl)
    if (!['redis:', 'rediss:'].includes(url.protocol)) {
      errors.push('RATE_LIMIT_REDIS_URL deve usar redis:// ou rediss://.')
    }
    const password = url.password || readEnv(env, 'REDIS_PASSWORD')
    if (!password || password.length < 20 || weakSecretValues.has(password.toLowerCase())) {
      errors.push('REDIS_PASSWORD/RATE_LIMIT_REDIS_URL deve usar senha forte em producao.')
    }
  } catch {
    errors.push('RATE_LIMIT_REDIS_URL/REDIS_URL invalida.')
  }
}

function assertNoDefaultSeeds(env: RawEnv, errors: string[]) {
  const seedDefaultAdmin = readEnv(env, 'SEED_DEFAULT_ADMIN').toLowerCase()
  const seedDevUsers = readEnv(env, 'SEED_DEV_USERS').toLowerCase()
  if (seedDefaultAdmin === 'true' || seedDevUsers === 'true') {
    errors.push('Seeds padrao nao podem estar habilitados em producao.')
  }
}

export function validateAppEnv(env: RawEnv) {
  const errors: string[] = []
  const production = isProduction(env)

  assertStrongSecret(env, 'JWT_ACCESS_SECRET', errors)
  assertStrongSecret(env, 'JWT_REFRESH_SECRET', errors)

  const accessSecret = readEnv(env, 'JWT_ACCESS_SECRET')
  const refreshSecret = readEnv(env, 'JWT_REFRESH_SECRET')
  if (accessSecret && refreshSecret && accessSecret === refreshSecret) {
    errors.push('JWT_ACCESS_SECRET e JWT_REFRESH_SECRET devem ser diferentes.')
  }

  const accessTtl = parseDurationSeconds(readEnv(env, 'JWT_ACCESS_EXPIRES_IN') || '15m', 15 * 60)
  if (accessTtl < 60 || accessTtl > 15 * 60) {
    errors.push('JWT_ACCESS_EXPIRES_IN deve ficar entre 1m e 15m.')
  }

  if (production) {
    assertProductionDatabase(env, errors)
    assertStrongProductionPassword(env, errors)
    assertProductionRateLimit(env, errors)
    assertNoDefaultSeeds(env, errors)
    assertCors(env, errors)
    if (readEnv(env, 'AUTH_COOKIE_SECURE') !== 'true') {
      errors.push('AUTH_COOKIE_SECURE deve ser true em producao.')
    }
    if (!readEnv(env, 'OMR_INTERNAL_TOKEN') || !isStrongSecret(readEnv(env, 'OMR_INTERNAL_TOKEN'))) {
      errors.push('OMR_INTERNAL_TOKEN forte e obrigatorio em producao.')
    }
    if (!readEnv(env, 'OMR_SERVICE_URL')) {
      errors.push('OMR_SERVICE_URL e obrigatoria em producao.')
    }
    if (readEnv(env, 'SWAGGER_ENABLED') === 'true') {
      if (!readEnv(env, 'SWAGGER_BASIC_USER') || !isStrongSecret(readEnv(env, 'SWAGGER_BASIC_PASSWORD'))) {
        errors.push('Swagger em producao exige SWAGGER_BASIC_USER e SWAGGER_BASIC_PASSWORD forte.')
      }
    }
  }

  if (errors.length) {
    throw new Error(`Configuracao insegura do LiEnsina:\n- ${errors.join('\n- ')}`)
  }

  return {
    ...env,
    JWT_ACCESS_EXPIRES_IN: readEnv(env, 'JWT_ACCESS_EXPIRES_IN') || '15m',
    JWT_ISSUER: readEnv(env, 'JWT_ISSUER') || 'liensina-api',
    JWT_AUDIENCE: readEnv(env, 'JWT_AUDIENCE') || 'liensina-web',
    REFRESH_TOKEN_DAYS: readEnv(env, 'REFRESH_TOKEN_DAYS') || '7',
    REFRESH_TOKEN_REVOKED_RETENTION_SECONDS: readEnv(env, 'REFRESH_TOKEN_REVOKED_RETENTION_SECONDS') || '86400',
  }
}
