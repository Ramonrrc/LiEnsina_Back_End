import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import helmet from 'helmet'

import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)
  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  app.use(helmet())
  app.enableCors({ origin: origins.length ? origins : true, credentials: true })
  app.setGlobalPrefix('api')

  const swagger = new DocumentBuilder()
    .setTitle('LiEnsina API')
    .setDescription('API escolar para escolas, turmas, alunos, simulados, cargos e dashboard.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build()
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger))

  const host = config.get<string>('HOST') ?? '0.0.0.0'
  const port = Number(config.get<string>('PORT') ?? 3000)
  await app.listen(port, host)
  new Logger('Bootstrap').log(`LiEnsina_Back_End em http://${host}:${port}`)
}

void bootstrap()
