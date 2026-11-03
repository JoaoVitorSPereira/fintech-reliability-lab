import { Module } from '@nestjs/common';
import { TransfersResolver } from './transfers.resolver';
import { TransfersService } from './transfers.service';

@Module({ providers: [TransfersService, TransfersResolver] })
export class TransfersModule {}
