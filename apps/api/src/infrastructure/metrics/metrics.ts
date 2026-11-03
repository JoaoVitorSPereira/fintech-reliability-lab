import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

// Prometheus instruments. Label values are always from a small closed set
// (schema field names, provider names, error codes). Never user input,
// ids, amounts or operation names sent by clients: those blow up cardinality
// and could leak data.
export class Metrics {
  readonly registry = new Registry();

  readonly graphqlDuration = new Histogram({
    name: 'graphql_operation_duration_seconds',
    help: 'GraphQL operation duration',
    labelNames: ['type', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly resolverDuration = new Histogram({
    name: 'graphql_resolver_duration_seconds',
    help: 'Duration of root Query/Mutation field resolvers',
    labelNames: ['field'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  readonly dbQueryDuration = new Histogram({
    name: 'db_query_duration_seconds',
    help: 'Duration of individual SQL statements issued by Prisma',
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
    registers: [this.registry],
  });

  readonly dataloaderBatchSize = new Histogram({
    name: 'dataloader_batch_size',
    help: 'Keys per DataLoader batch (1 = no batching benefit)',
    labelNames: ['loader'] as const,
    buckets: [1, 2, 5, 10, 25, 50, 100],
    registers: [this.registry],
  });

  readonly wsConnections = new Gauge({
    name: 'ws_connections',
    help: 'Open GraphQL WebSocket connections',
    registers: [this.registry],
  });
  readonly wsDisconnects = new Counter({
    name: 'ws_disconnects_total',
    help: 'Closed GraphQL WebSocket connections',
    registers: [this.registry],
  });

  readonly providerDuration = new Histogram({
    name: 'market_provider_request_duration_seconds',
    help: 'Market-data provider HTTP latency',
    labelNames: ['provider', 'outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly providerRateLimited = new Counter({
    name: 'market_provider_rate_limited_total',
    help: '429/418 responses and locally refused calls (budget, cooldown, circuit)',
    labelNames: ['provider', 'reason'] as const,
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox events published',
    registers: [this.registry],
  });
  readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox publish attempts that failed',
    registers: [this.registry],
  });
  readonly eventRecoveries = new Counter({
    name: 'event_recovery_requests_total',
    help: 'missedEvents calls from reconnecting clients',
    labelNames: ['stream'] as const,
    registers: [this.registry],
  });

  readonly authFailures = new Counter({
    name: 'auth_failures_total',
    help: 'Rejected logins and refreshes',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly refreshAttempts = new Counter({
    name: 'auth_refresh_attempts_total',
    help: 'Refresh token exchanges by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly financialFailures = new Counter({
    name: 'financial_operation_failures_total',
    help: 'Rejected transfers, deposits and orders by error code',
    labelNames: ['operation', 'code'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  /** Gauges computed on scrape (e.g. outbox backlog), so they're never stale. */
  gaugeOnScrape(
    name: string,
    help: string,
    read: () => Promise<number> | number,
  ): void {
    new Gauge({
      name,
      help,
      registers: [this.registry],
      async collect() {
        this.set(await read());
      },
    });
  }
}
