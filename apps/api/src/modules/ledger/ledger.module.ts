import { Global, Module } from '@nestjs/common';
import { LedgerReconciliation } from './ledger-reconciliation.service';
import { LedgerService } from './ledger.service';

@Global()
@Module({
  providers: [LedgerService, LedgerReconciliation],
  exports: [LedgerService],
})
export class LedgerModule {}
