import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from './infra/database/database.module';
import { WalletsController } from './interfaces/http/wallets.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { HealthController } from './interfaces/http/health.controller';
import { DomainExceptionFilter } from './interfaces/http/domain-exception.filter';
import { WagerTransactionsConsumer } from './infra/messaging/wager-transactions.consumer';
import { OutboxPublisherWorker } from './infra/messaging/outbox-publisher.worker';
import { PendingReferenceWorker } from './infra/pending-reference/pending-reference.worker';
import { MetricsService } from './infra/observability/metrics.service';
import { MetricsController } from './infra/observability/metrics.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    MetricsService,
    WagerTransactionsConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker,
  ],
})
export class AppModule {}
