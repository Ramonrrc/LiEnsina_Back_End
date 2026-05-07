import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>()
    const token = this.extractToken(request)
    if (!token) throw new UnauthorizedException('Token ausente.')

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token)
      if (payload.typ !== 'access') throw new UnauthorizedException('Token invalido.')
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
