import { CombinedGraphQLErrors } from '@apollo/client';

/** API error codes the UI reacts to. Messages come from the server's whitelist. */
export function errorCode(error: unknown): string | undefined {
  if (CombinedGraphQLErrors.is(error)) return error.errors[0]?.extensions?.['code'] as string | undefined;
  return undefined;
}

export function errorMessage(error: unknown): string {
  if (CombinedGraphQLErrors.is(error)) return error.errors[0]?.message ?? 'Something went wrong.';
  return "Can't reach the server. Check your connection and try again.";
}
