import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import type { Request } from 'express'

import { LiensinaService } from './liensina.service'
import type { JwtPayload, UserAccount } from './liensina.types'

export interface RequestWithUser extends Request {
  user?: UserAccount
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly liensinaService: LiensinaService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>()
    const token = this.extractToken(request)
    if (!token) throw new UnauthorizedException('Token ausente.')

    try {
      const secret = this.configService.get<string>('JWT_ACCESS_SECRET')
      if (!secret) throw new UnauthorizedException('Configuracao de token ausente.')
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret,
        issuer: this.configService.get<string>('JWT_ISSUER') ?? 'liensina-api',
        audience: this.configService.get<string>('JWT_AUDIENCE') ?? 'liensina-web',
      })
      if (payload.typ !== 'access') throw new UnauthorizedException('Token invalido.')
      if (!payload.sid || !payload.jti) throw new UnauthorizedException('Token invalido.')
      if (!this.liensinaService.isSessionActive(payload.sub, payload.sid)) {
        throw new UnauthorizedException('Sessao revogada ou expirada.')
      }
      request.user = this.liensinaService.getUserById(payload.sub)
      return true
    } catch {
      throw new UnauthorizedException('Token invalido ou expirado.')
    }
  }

  private extractToken(request: Request) {
    const [type, token] = request.headers.authorization?.split(' ') ?? []
    return type === 'Bearer' ? token : null
  }
}
