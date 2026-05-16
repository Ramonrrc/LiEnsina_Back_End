import { resolve } from 'node:path'

import type { ConfigService } from '@nestjs/config'

export type DatabaseDriver = 'sqlite' | 'postgres'

export type DatabaseConfig = {
  driver: DatabaseDriver
  sqlitePath: string
  postgresUrl?: string
  postgresSsl: boolean
}

export function getDatabaseConfig(configService: Pick<ConfigService, 'get'>): DatabaseConfig {
  const configuredDriver = String(configService.get<string>('DATABASE_DRIVER') ?? '').trim().toLowerCase()
  const configuredUrl = String(configService.get<string>('DATABASE_URL') ?? '').trim()
  const driver: DatabaseDriver = configuredDriver === 'postgres' || configuredDriver === 'postgresql' || configuredUrl
    ? 'postgres'
    : 'sqlite'

  const configuredPath = configService.get<string>('DATABASE_PATH') ?? 'data/liensina.sqlite'
  const sqlitePath = configuredPath.endsWith('.json') ? configuredPath.replace(/\.json$/i, '.sqlite') : configuredPath
  const sslMode = String(configService.get<string>('DATABASE_SSL') ?? '').trim().toLowerCase()
  const postgresSsl = sslMode === 'true' || sslMode === 'require'

  return {
    driver,
    sqlitePath: resolve(process.cwd(), sqlitePath),
    postgresUrl: configuredUrl || undefined,
    postgresSsl,
  }
}
