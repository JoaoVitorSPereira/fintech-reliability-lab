import { Args, ID, Int, Query, Resolver } from '@nestjs/graphql';
import { CurrentViewer } from '../identity/auth.guard';
import type { Viewer } from '../identity/auth.service';
import { AccountModel, TransactionConnection } from './accounts.models';
import { AccountsService, toAccountView } from './accounts.service';

@Resolver(() => AccountModel)
export class AccountsResolver {
  constructor(private readonly accountsService: AccountsService) {}

  @Query(() => [AccountModel])
  async accounts(@CurrentViewer() viewer: Viewer): Promise<AccountModel[]> {
    return (await this.accountsService.listOwned(viewer)).map(toAccountView);
  }

  @Query(() => AccountModel)
  async account(
    @CurrentViewer() viewer: Viewer,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AccountModel> {
    return toAccountView(await this.accountsService.getOwned(viewer, id));
  }

  @Query(() => TransactionConnection, {
    description: 'Statement for one of your accounts, newest first.',
  })
  transactions(
    @CurrentViewer() viewer: Viewer,
    @Args('accountId', { type: () => ID }) accountId: string,
    @Args('first', { type: () => Int }) first: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<TransactionConnection> {
    return this.accountsService.statement(viewer, accountId, first, after);
  }
}
