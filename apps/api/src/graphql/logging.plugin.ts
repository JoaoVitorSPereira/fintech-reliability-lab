import type {
  ApolloServerPlugin,
  GraphQLRequestListener,
} from '@apollo/server';
import { unwrapResolverError } from '@apollo/server/errors';
import { Plugin } from '@nestjs/apollo';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Metrics } from '../infrastructure/metrics/metrics';
import { AppError } from '../shared/errors/app-error';

// GraphQL answers HTTP 200 even when resolvers fail, so HTTP access logs alone
// say "success". This logs the real outcome per operation.
// Variables are never logged: they will carry amounts and account ids.
@Plugin()
export class GraphqlLoggingPlugin implements ApolloServerPlugin {
  constructor(
    @InjectPinoLogger('GraphQL') private readonly logger: PinoLogger,
    private readonly metrics: Metrics,
  ) {}

  async requestDidStart(): Promise<GraphQLRequestListener<object>> {
    const startedAt = performance.now();
    const logger = this.logger;
    const errorCodes: unknown[] = [];
    const metrics = this.metrics;

    return {
      async didEncounterErrors({ errors }) {
        for (const error of errors) {
          const original = unwrapResolverError(error);
          if (original instanceof AppError) {
            errorCodes.push(original.code);
          } else if (error.extensions['code'] && !error.originalError) {
            // Request-level errors (parse/validation): client's problem.
            errorCodes.push(error.extensions['code']);
          } else {
            // Unexpected: this is the only place the real error is visible.
            errorCodes.push('INTERNAL_SERVER_ERROR');
            logger.error({ err: original }, 'unhandled resolver error');
          }
        }
      },
      // Root fields only: their names come from the schema (bounded), and
      // they show which use case is slow without per-field overhead.
      async executionDidStart() {
        return {
          willResolveField({ info }) {
            if (info.path.prev !== undefined) return;
            const end = metrics.resolverDuration.startTimer({
              field: `${info.parentType.name}.${info.fieldName}`,
            });
            return () => end();
          },
        };
      },
      async willSendResponse({ operationName, operation }) {
        const outcome = errorCodes.includes('INTERNAL_SERVER_ERROR')
          ? 'server_error'
          : errorCodes.length
            ? 'client_error'
            : 'ok';
        metrics.graphqlDuration.observe(
          { type: operation?.operation ?? 'unknown', outcome },
          (performance.now() - startedAt) / 1000,
        );
        logger.info(
          {
            operationName: operationName ?? null,
            operationType: operation?.operation ?? null,
            durationMs: Math.round(performance.now() - startedAt),
            errorCodes,
          },
          'graphql operation',
        );
      },
    };
  }
}
