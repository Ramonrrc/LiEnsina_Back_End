import { Logger, ValidationPipe } from '@nestjs/common'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { json, static as serveStatic, urlencoded, type NextFunction, type Request, type Response } from 'express'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import helmet from 'helmet'

import { AppModule } from './app.module'

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false

  const [first, second] = parts
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

function isAllowedDevOrigin(origin: string) {
  const isLocalHttpMode = process.env.AUTH_COOKIE_SECURE === 'false'
  if (process.env.NODE_ENV === 'production' && !isLocalHttpMode) return false

  try {
    const url = new URL(origin)
    const allowedDevPorts = new Set(['4173', '5173', '5174'])
    return (
      url.protocol === 'http:' &&
      allowedDevPorts.has(url.port) &&
      (isLoopbackHost(url.hostname) || isPrivateIpv4(url.hostname))
    )
  } catch {
    return false
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)
  const corsLogger = new Logger('Cors')
  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const allowedOrigins = new Set(origins)

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
  app.use(json({ limit: config.get<string>('MAX_JSON_BODY_SIZE') ?? '1mb' }))
  app.use(urlencoded({ extended: false, limit: config.get<string>('MAX_FORM_BODY_SIZE') ?? '256kb' }))
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }))

  const publicUploadsDir = join(process.cwd(), 'uploads', 'public')
  mkdirSync(publicUploadsDir, { recursive: true })
  app.use('/uploads', serveStatic(publicUploadsDir, {
    fallthrough: false,
    setHeaders: (response) => {
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Cache-Control', 'public, max-age=3600')
    },
  }))
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin) || isAllowedDevOrigin(origin)) {
        callback(null, true)
        return
      }

      corsLogger.warn(`Origem CORS bloqueada: ${origin.slice(0, 200)}`)
      callback(new Error('Origem CORS nao permitida.'))
    },
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  })
  app.setGlobalPrefix('api')

  if (config.get<string>('SWAGGER_ENABLED') === 'true' || process.env.NODE_ENV !== 'production') {
    const swaggerUser = config.get<string>('SWAGGER_BASIC_USER')
    const swaggerPassword = config.get<string>('SWAGGER_BASIC_PASSWORD')
    if (process.env.NODE_ENV === 'production') {
      app.use('/docs', (request: Request, response: Response, next: NextFunction) => {
        const authorization = request.headers.authorization ?? ''
        const [scheme, token] = authorization.split(' ')
        const credentials = token ? Buffer.from(token, 'base64').toString('utf8') : ''
        const [user, password] = credentials.split(':')
        if (scheme === 'Basic' && user === swaggerUser && password === swaggerPassword) return next()
        response.setHeader('WWW-Authenticate', 'Basic realm="LiEnsina API Docs"')
        return response.status(401).send('Swagger protegido.')
      })
    }

    const swagger = new DocumentBuilder()
      .setTitle('LiEnsina API')
      .setDescription('API escolar para escolas, turmas, alunos, simulados, cargos e dashboard.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build()
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger))
  }

  const host = config.get<string>('HOST') ?? '0.0.0.0'
  const port = Number(config.get<string>('PORT') ?? 3000)
  await app.listen(port, host)
  new Logger('Bootstrap').log(`LiEnsina_Back_End em http://${host}:${port}`)
}

void bootstrap()
