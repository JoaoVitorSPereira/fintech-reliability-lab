import { DecimalScalar } from '../../graphql/scalars/decimal.scalar';
import {
  Field,
  ID,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { TransferKind } from '../../generated/prisma/enums';
import { Money } from '../accounts/accounts.models';

registerEnumType(TransferKind, { name: 'TransferKind' });

@ObjectType('Transfer')
export class TransferModel {
  @Field(() => ID)
  id: string;

  @Field(() => TransferKind, {
    description:
      'SIMULATED_DEPOSIT means no real money moved: there is no payment rail.',
  })
  kind: TransferKind;

  @Field(() => ID)
  fromAccountId: string;

  @Field(() => ID)
  toAccountId: string;

  @Field(() => Money)
  amount: Money;

  @Field()
  description: string;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class TransferResult {
  @Field(() => TransferModel)
  transfer: TransferModel;

  @Field({
    description:
      'True when this idempotency key was already processed: nothing moved this time; this is the original result.',
  })
  replayed: boolean;
}

@InputType()
export class CreateTransferInput {
  @Field(() => ID)
  fromAccountId: string;

  @Field(() => ID)
  toAccountId: string;

  @Field(() => DecimalScalar, { description: 'Decimal string, e.g. "150.25".' })
  amount: string;

  @Field({
    description:
      'Generate once per transfer the user intends (e.g. a UUID) and reuse it on every retry.',
  })
  idempotencyKey: string;

  @Field({ nullable: true })
  description?: string;
}

@InputType()
export class SimulateDepositInput {
  @Field(() => ID)
  accountId: string;

  @Field(() => DecimalScalar, {
    description: 'Decimal string, at most 50000.00.',
  })
  amount: string;

  @Field()
  idempotencyKey: string;
}
