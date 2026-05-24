import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'

type Bucket = {
  count: number
  resetAt: number
}

export type RateLimitRule = {
  key: string
  limit: number
  windowMs: number
}

const slidingWindowRateLimitScript = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[3]) then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`

const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name)
  private readonly buckets = new Map<string, Bucket>()
  private readonly locks = new Map<string, Bucket>()
  private readonly redis?: Redis
  private readonly production: boolean

  constructor(private readonly configService: ConfigService) {
    this.production = this.configService.get<string>('NODE_ENV') === 'production'
    const redisUrl = this.configService.get<string>('RATE_LIMIT_REDIS_URL') || this.configService.get<string>('REDIS_URL')

    if (redisUrl) {
      this.redis = new Redis(redisUrl, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        lazyConnect: false,
      })
      this.redis.on('error', (error) => {
        this.logger.warn(`Redis/Valkey de rate limit indisponivel: ${error.message}`)
      })
    }
  }

  async onModuleDestroy() {
    if (this.redis) await this.redis.quit().catch(() => undefined)
  }

  async assertAllowed(rules: RateLimitRule[]) {
    if (this.redis) {
      try {
        await this.assertAllowedRedis(rules)
        return
      } catch (error) {
        if (this.production) {
          this.logger.error('Rate limit distribuido falhou em producao; bloqueando fail-closed.')
          throw new HttpException('Controle de abuso temporariamente indisponivel.', HttpStatus.SERVICE_UNAVAILABLE)
        }
        this.logger.warn(`Rate limit Redis falhou; usando fallback local em desenvolvimento: ${(error as Error).message}`)
      }
    }

    if (this.production) {
      throw new HttpException('Rate limit distribuido e obrigatorio em producao.', HttpStatus.SERVICE_UNAVAILABLE)
    }

    this.assertAllowedMemory(rules)
  }

  async acquireLock(key: string, ttlMs: number, conflictMessage = 'Operacao ja esta em processamento.') {
    const safeTtlMs = Math.max(1000, Math.min(ttlMs, 30 * 60_000))
    if (this.redis) {
      try {
        return await this.acquireRedisLock(key, safeTtlMs, conflictMessage)
      } catch (error) {
        if (error instanceof HttpException) throw error
        if (this.production) {
          this.logger.error('Lock distribuido falhou em producao; bloqueando fail-closed.')
          throw new HttpException('Controle de concorrencia temporariamente indisponivel.', HttpStatus.SERVICE_UNAVAILABLE)
        }
        this.logger.warn(`Lock Redis falhou; usando fallback local em desenvolvimento: ${(error as Error).message}`)
      }
    }

    if (this.production) {
      throw new HttpException('Lock distribuido e obrigatorio em producao.', HttpStatus.SERVICE_UNAVAILABLE)
    }

    return this.acquireMemoryLock(key, safeTtlMs, conflictMessage)
  }

  private async assertAllowedRedis(rules: RateLimitRule[]) {
    if (!this.redis) return
    const now = Date.now()

    for (const rule of rules) {
      const redisKey = `liensina:rate-limit:${rule.key}`
      const member = `${now}:${Math.random().toString(36).slice(2)}`
      const result = await this.redis.call(
        'EVAL',
        slidingWindowRateLimitScript,
        1,
        redisKey,
        now,
        rule.windowMs,
        rule.limit,
        member,
      )

      if (Number(result) !== 1) {
        throw new HttpException('Muitas requisicoes. Tente novamente em instantes.', HttpStatus.TOO_MANY_REQUESTS)
      }
    }
  }

  private assertAllowedMemory(rules: RateLimitRule[]) {
    const now = Date.now()

    for (const rule of rules) {
      const bucket = this.buckets.get(rule.key)
      if (!bucket || bucket.resetAt <= now) {
        this.buckets.set(rule.key, { count: 1, resetAt: now + rule.windowMs })
        continue
      }

      bucket.count += 1
      if (bucket.count > rule.limit) {
        throw new HttpException('Muitas requisicoes. Tente novamente em instantes.', HttpStatus.TOO_MANY_REQUESTS)
      }
    }

    if (this.buckets.size > 50000) this.cleanup(now)
  }

  private cleanup(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
    for (const [key, lock] of this.locks) {
      if (lock.resetAt <= now) this.locks.delete(key)
    }
  }

  private async acquireRedisLock(key: string, ttlMs: number, conflictMessage: string) {
    if (!this.redis) return async () => undefined
    const redisKey = `liensina:lock:${key}`
    const token = randomUUID()
    const acquired = await this.redis.set(redisKey, token, 'PX', ttlMs, 'NX')
    if (acquired !== 'OK') throw new HttpException(conflictMessage, HttpStatus.CONFLICT)

    return async () => {
      await this.redis?.call(
        'EVAL',
        releaseLockScript,
        1,
        redisKey,
        token,
      ).catch((error) => {
        this.logger.warn(`Falha ao liberar lock distribuido ${key}: ${(error as Error).message}`)
      })
    }
  }

  private acquireMemoryLock(key: string, ttlMs: number, conflictMessage: string) {
    const now = Date.now()
    const lock = this.locks.get(key)
    if (lock && lock.resetAt > now) throw new HttpException(conflictMessage, HttpStatus.CONFLICT)
    this.locks.set(key, { count: 1, resetAt: now + ttlMs })
    if (this.locks.size > 50000) this.cleanup(now)
    return async () => {
      this.locks.delete(key)
    }
  }
}
