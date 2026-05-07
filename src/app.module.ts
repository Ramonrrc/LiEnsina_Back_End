import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'

import { AppController } from './app.controller'
import { AuthGuard } from './auth.guard'
import { DatabaseService } from './database.service'
import { LiensinaService } from './liensina.service'

function parseDurationSeconds(value: string | undefined, fallback: number) {
  const match = String(value ?? '').trim().match(/^(\d+)(s|m|h|d)?$/i)
  if (!match) return fallback

  const amount = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  if (unit === 'd') return amount * 24 * 60 * 60
  if (unit === 'h') return amount * 60 * 60
  if (unit === 'm') return amount * 60
  return amount
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? 'liensina-local-secret',
        signOptions: {
          expiresIn: parseDurationSeconds(config.get<string>('JWT_ACCESS_EXPIRES_IN'), 30 * 60),
          issuer: config.get<string>('JWT_ISSUER') ?? 'liensina-api',
          audience: config.get<string>('JWT_AUDIENCE') ?? 'liensina-web',
        },
        verifyOptions: {
          issuer: config.get<string>('JWT_ISSUER') ?? 'liensina-api',
          audience: config.get<string>('JWT_AUDIENCE') ?? 'liensina-web',
        },
      }),
    }),
  ],
  controllers: [AppController],
  providers: [DatabaseService, LiensinaService, AuthGuard],
})
export class AppModule {}
