import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// The header is client input: bound its size and charset so it can't bloat or
// forge log lines. It's a tracing aid only, never used for auth or idempotency.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function resolveRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader('x-request-id', requestId);
  return requestId;
}
