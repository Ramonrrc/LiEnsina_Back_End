import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'

import { AppController } from './app.controller'
import { AuthGuard } from './auth.guard'
import { DatabaseService } from './database.service'
import { LiensinaService } from './liensina.service'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({
        secret: process.env.JWT_SECRET ?? 'liensina-local-secret',
        signOptions: { expiresIn: '12h' },
      }),
    }),
  ],
  controllers: [AppController],
  providers: [DatabaseService, LiensinaService, AuthGuard],
})
export class AppModule {}
