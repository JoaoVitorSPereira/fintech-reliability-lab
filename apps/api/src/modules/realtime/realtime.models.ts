import {
  Field,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { AccountModel, TransactionModel } from '../accounts/accounts.models';
import { DataQuality } from '../market-data/market-data.models';
import { SimulatedOrderModel } from '../trading/trading.models';

export enum EventStreamType {
  ACCOUNT = 'ACCOUNT',
  PORTFOLIO = 'PORTFOLIO',
}
registerEnumType(EventStreamType, { name: 'EventStreamType' });

@ObjectType({
  description:
    'A balance change. `account.balance` is re-read from the database, not computed from the event.',
})
export class AccountUpdate {
  @Field(() => ID)
  eventId: string;

  @Field(() => Int, {
    description:
      'Gapless per account. A jump means events were missed: call missedEvents or refetch.',
  })
  sequence: number;

  @Field(() => AccountModel)
  account: AccountModel;

  @Field(() => TransactionModel)
  transaction: TransactionModel;
}

@ObjectType()
export class SimulatedOrderUpdate {
  @Field(() => ID)
  eventId: string;

  @Field(() => Int, { description: 'Gapless per portfolio.' })
  sequence: number;

  @Field(() => SimulatedOrderModel)
  order: SimulatedOrderModel;
}

@ObjectType({
  description:
    'Streamed from Binance. Throttled per asset; not every tick is delivered.',
})
export class MarketPriceUpdate {
  @Field(() => ID)
  assetId: string;

  @Field()
  price: string;

  @Field()
  currency: string;

  @Field(() => String, { nullable: true })
  change24h: string | null;

  @Field()
  sourceTimestamp: Date;

  @Field(() => DataQuality)
  dataQuality: DataQuality;
}

@InputType()
export class EventStreamInput {
  @Field(() => EventStreamType)
  type: EventStreamType;

  @Field(() => ID)
  id: string;
}

@ObjectType('DomainEventRecord', {
  description: 'A stored event, for catching up after a disconnect.',
})
export class DomainEventRecord {
  @Field(() => ID)
  id: string;

  @Field()
  type: string;

  @Field(() => Int)
  version: number;

  @Field(() => Int)
  sequence: number;

  @Field()
  occurredAt: Date;

  @Field({ description: 'The versioned event payload as JSON.' })
  payloadJson: string;
}
