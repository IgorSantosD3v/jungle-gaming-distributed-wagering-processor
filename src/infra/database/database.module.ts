import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { InboxMessageEntity, OutboxMessageEntity } from './entities/messaging.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'wagering',
      password: process.env.DB_PASSWORD ?? 'wagering',
      database: process.env.DB_NAME ?? 'wagering',
      entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity],
      synchronize: false, // schema só muda via migration, nunca automaticamente
      logging: process.env.DB_LOGGING === 'true',
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
