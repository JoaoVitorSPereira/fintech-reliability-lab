import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus';
import { OutboxPublisher } from './outbox-publisher.service';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  providers: [OutboxService, OutboxPublisher, EventBus],
  exports: [OutboxService, OutboxPublisher, EventBus],
})
export class EventsModule {}
