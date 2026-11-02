import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext, type GqlContextType } from '@nestjs/graphql';
import type { Request } from 'express';
import { AppError } from '../../shared/errors/app-error';
import { AuthService, type Viewer } from './auth.service';

const IS_PUBLIC = 'identity:isPublic';

/** Opt OUT of authentication. Everything else is protected by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

type AuthenticatedRequest = Request & { viewer?: Viewer };

function requestFrom(context: ExecutionContext): AuthenticatedRequest {
  return context.getType<GqlContextType>() === 'graphql'
    ? GqlExecutionContext.create(context).getContext<{
        req: AuthenticatedRequest;
      }>().req
    : context.switchToHttp().getRequest<AuthenticatedRequest>();
}

/** The authenticated caller. Only valid on non-@Public handlers. */
export const CurrentViewer = createParamDecorator(
  (_: unknown, context: ExecutionContext): Viewer => {
    const viewer = requestFrom(context).viewer;
    if (!viewer)
      throw new Error('CurrentViewer used on an unauthenticated route');
    return viewer;
  },
);

// Registered as a global guard: a new resolver someone forgets to protect is
// protected anyway. Forgetting @Public() fails loudly in development; forgetting
// a guard would fail silently in production.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = requestFrom(context);
    const viewer = await this.auth.authenticate(request.headers.authorization);
    if (!viewer) {
      if (context.getType() === 'http') throw new UnauthorizedException();
      throw new AppError('UNAUTHENTICATED', 'Authentication required.');
    }

    request.viewer = viewer;
    return true;
  }
}
