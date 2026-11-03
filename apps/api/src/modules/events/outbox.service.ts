import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { uuidv7 } from '../../shared/uuid';
import type { AggregateType } from './domain-event';

type Tx = Prisma.TransactionClient;

export type NewEvent = {
  aggregateType: AggregateType;
  aggregateId: string;
  sequence: number;
  type: string;
  version: number;
  payload: Prisma.InputJsonObject;
  correlationId?: string | null;
};

// The only rule: call this with the SAME transaction client as the state
// change. Then the event exists if and only if the change committed.
// Publishing to Redis/WebSockets from inside the transaction would break
// that: a rollback after publishing would announce something that never
// happened, and a crash after commit would lose the announcement.
@Injectable()
export class OutboxService {
  async append(tx: Tx, events: NewEvent[]): Promise<void> {
    if (events.length === 0) return;
    await tx.outboxEvent.createMany({
      data: events.map((event) => ({
        id: uuidv7(),
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        sequence: event.sequence,
        type: event.type,
        version: event.version,
        payload: event.payload,
        correlationId: event.correlationId ?? null,
      })),
    });
  }
}
