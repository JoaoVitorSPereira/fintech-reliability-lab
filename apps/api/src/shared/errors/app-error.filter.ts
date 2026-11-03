import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import type { GqlContextType } from '@nestjs/graphql';
import type { Response } from 'express';
import { AppError, type AppErrorCode } from './app-error';

// Record<AppErrorCode, …>: adding a code without a status fails to compile.
const HTTP_STATUS: Record<AppErrorCode, number> = {
  BAD_USER_INPUT: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  TOO_MANY_ATTEMPTS: 429,
  INSUFFICIENT_FUNDS: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
};

// AppErrors are expected outcomes (wrong password, expired session), not
// failures. Without this filter Nest logs each one at ERROR with a stack
// trace, which buries real incidents and trips alerts.
@Catch(AppError)
export class AppErrorFilter implements ExceptionFilter {
  catch(error: AppError, host: ArgumentsHost) {
    // GraphQL: hand it back to Apollo; formatGraphqlError shapes the response.
    if (host.getType<GqlContextType>() === 'graphql') return error;

    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HTTP_STATUS[error.code])
      .json({ code: error.code, message: error.message });
  }
}
