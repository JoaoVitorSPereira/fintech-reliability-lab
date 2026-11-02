// Expected, client-facing failures. Each code is part of the API contract:
// the mobile app switches on `code`, never on `message`.
// Anything thrown that is NOT an AppError is a bug and gets masked as
// INTERNAL_SERVER_ERROR (see graphql/format-error.ts).
export type AppErrorCode =
  | 'BAD_USER_INPUT'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_TAKEN'
  | 'TOO_MANY_ATTEMPTS'
  | 'NOT_FOUND';

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
