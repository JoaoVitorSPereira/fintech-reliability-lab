import { Logger } from '@nestjs/common';
import type { ExecutionResult, GraphQLError } from 'graphql';
import type { Context } from 'graphql-ws';
import { AppError } from '../shared/errors/app-error';
import { formatGraphqlError } from './format-error';
import type { Metrics } from '../infrastructure/metrics/metrics';
import type { AuthService, Viewer } from '../modules/identity/auth.service';

const RECHECK_MS = 60_000;
const UNAUTHORIZED = 4401; // graphql-ws convention for "re-authenticate"

type Extra = {
  viewer?: Viewer;
  recheck?: NodeJS.Timeout;
  socket?: { close(code: number, reason: string): void };
};
// graphql-ws types `extra` as unknown; with the `ws` server it is { socket, request }.
type WsContext = Context<Record<string, unknown> | undefined, unknown>;
const extraOf = (ctx: WsContext) => ctx.extra as Extra;

let openConnections = 0;
const logger = new Logger('Subscriptions');

function authorizationFrom(ctx: WsContext): string | undefined {
  const value = ctx.connectionParams?.['authorization'];
  return typeof value === 'string' ? value : undefined;
}

// The WebSocket is authenticated ONCE at connection_init with the same
// access token the HTTP link uses (sent in connectionParams, never in the
// URL, which ends up in proxy logs). Sessions can be revoked later, so the
// session is re-checked every minute and the socket closed with 4401 when
// it's gone; the client then refreshes its token and reconnects.
export function subscriptionConfig(auth: AuthService, metrics?: Metrics) {
  return {
    'graphql-ws': {
      connectionInitWaitTimeout: 5_000,
      onConnect: async (ctx: WsContext) => {
        const viewer = await auth.authenticate(authorizationFrom(ctx));
        if (!viewer) return false; // graphql-ws closes with 4403 Forbidden
        const extra = extraOf(ctx);
        extra.viewer = viewer;
        extra.recheck = setInterval(() => {
          void auth.authenticate(authorizationFrom(ctx)).then((still) => {
            if (!still) extra.socket?.close(UNAUTHORIZED, 'Unauthorized');
          });
        }, RECHECK_MS);
        openConnections++;
        metrics?.wsConnections.inc();
        logger.log(`connection opened (${openConnections} open)`);
        return true;
      },
      // Apollo's formatError doesn't run on the WebSocket transport, so apply
      // the same whitelist here: AppErrors keep their code, anything else is
      // masked (and logged, since the HTTP logging plugin doesn't see it).
      onNext: (
        _ctx: WsContext,
        _id: string,
        _payload: unknown,
        _args: unknown,
        result: ExecutionResult,
      ) => {
        if (!result.errors?.length) return result;
        const errors = (result.errors as readonly GraphQLError[]).map(
          (error) => {
            if (!(error.originalError instanceof AppError))
              logger.error(
                error.originalError ?? error,
                'unhandled subscription error',
              );
            return formatGraphqlError(error.toJSON(), error);
          },
        );
        return { ...result, errors };
      },
      onClose: (ctx: WsContext) => {
        const extra = extraOf(ctx);
        if (extra.recheck) clearInterval(extra.recheck);
        if (extra.viewer) {
          openConnections--;
          metrics?.wsConnections.dec();
          metrics?.wsDisconnects.inc();
          logger.log(`connection closed (${openConnections} open)`);
        }
      },
    },
  };
}

/** GraphQL context for both transports; the auth guard reads req.headers. */
export function graphqlContext(input: { req?: unknown } & Partial<WsContext>) {
  if (input.req) return { req: input.req };
  return {
    req: {
      headers: {
        authorization: input.connectionParams
          ? authorizationFrom(input as WsContext)
          : undefined,
      },
    },
  };
}
