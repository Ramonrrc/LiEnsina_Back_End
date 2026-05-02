import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { createSeedData } from './seed'
import type { DatabaseShape } from './liensina.types'

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name)
  private readonly databasePath: string
  private data!: DatabaseShape

  constructor(private readonly configService: ConfigService) {
    this.databasePath = resolve(process.cwd(), this.configService.get<string>('DATABASE_PATH') ?? 'data/liensina-db.json')
  }

  onModuleInit() {
    if (existsSync(this.databasePath)) {
      this.data = this.normalizeDatabase(JSON.parse(readFileSync(this.databasePath, 'utf8')) as Partial<DatabaseShape>)
      this.persist()
    } else {
      this.data = this.normalizeDatabase(createSeedData())
      this.persist()
    }

    this.logger.log(`Banco LiEnsina inicializado em ${this.databasePath}`)
  }

  read(): DatabaseShape {
    return structuredClone(this.data)
  }

  update(mutator: (data: DatabaseShape) => void): DatabaseShape {
    mutator(this.data)
    this.persist()
    return this.read()
  }

  private normalizeDatabase(data: Partial<DatabaseShape>): DatabaseShape {
    return { ...createSeedData(), ...data, calendarEvents: data.calendarEvents ?? [] }
  }

  private persist() {
    mkdirSync(dirname(this.databasePath), { recursive: true })
    writeFileSync(this.databasePath, JSON.stringify(this.data, null, 2), 'utf8')
  }
}

