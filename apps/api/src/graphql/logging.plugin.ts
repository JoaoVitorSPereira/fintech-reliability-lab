import type {
  ApolloServerPlugin,
  GraphQLRequestListener,
} from '@apollo/server';
import { unwrapResolverError } from '@apollo/server/errors';
import { Plugin } from '@nestjs/apollo';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppError } from '../shared/errors/app-error';

// GraphQL answers HTTP 200 even when resolvers fail, so HTTP access logs alone
// say "success". This logs the real outcome per operation.
// Variables are never logged: they will carry amounts and account ids.
@Plugin()
export class GraphqlLoggingPlugin implements ApolloServerPlugin {
  constructor(
    @InjectPinoLogger('GraphQL') private readonly logger: PinoLogger,
  ) {}

  async requestDidStart(): Promise<GraphQLRequestListener<object>> {
    const startedAt = performance.now();
    const logger = this.logger;
    const errorCodes: unknown[] = [];

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
      async willSendResponse({ operationName, operation }) {
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
