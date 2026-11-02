import type {
  ApolloServerPlugin,
  GraphQLRequestListener,
} from '@apollo/server';
import { Plugin } from '@nestjs/apollo';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

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
          errorCodes.push(error.extensions['code']);
          if (error.extensions['code'] === 'INTERNAL_SERVER_ERROR') {
            logger.error({ err: error.originalError ?? error }, error.message);
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
