import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  AccountPurpose,
  LedgerTransactionKind,
} from '../../generated/prisma/enums';
import { PageInfo } from '../../graphql/pagination';

registerEnumType(LedgerTransactionKind, { name: 'TransactionKind' });
registerEnumType(AccountPurpose, { name: 'AccountPurpose' });

@ObjectType({
  description:
    'An exact amount. `amount` is a decimal string ("1050.25"); never parse it into a float.',
})
export class Money {
  @Field()
  amount: string;

  @Field({ description: 'ISO 4217 code.' })
  currency: string;
}

@ObjectType('Account')
export class AccountModel {
  @Field(() => ID)
  id: string;

  @Field()
  currency: string;

  @Field(() => AccountPurpose, {
    description: 'PORTFOLIO_* accounts hold simulated paper-trading cash.',
  })
  purpose: AccountPurpose;

  @Field(() => Money, {
    description: 'Authoritative: read from the database on every request.',
  })
  balance: Money;

  @Field()
  createdAt: Date;
}

@ObjectType('Transaction', {
  description: "One line of an account's statement (a ledger entry).",
})
export class TransactionModel {
  @Field(() => ID)
  id: string;

  @Field(() => ID, {
    description: 'The ledger transaction this line belongs to.',
  })
  transactionId: string;

  @Field(() => LedgerTransactionKind)
  kind: LedgerTransactionKind;

  @Field()
  description: string;

  @Field(() => Money, {
    description: 'Positive = money in, negative = money out.',
  })
  amount: Money;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class TransactionConnection {
  @Field(() => [TransactionModel])
  nodes: TransactionModel[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}
