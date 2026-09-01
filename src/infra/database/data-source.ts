import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { InboxMessageEntity, OutboxMessageEntity } from './entities/messaging.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'wagering',
  password: process.env.DB_PASSWORD ?? 'wagering',
  database: process.env.DB_NAME ?? 'wagering',
  entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity],
  migrations: ['src/infra/database/migrations/*.ts'],
  // Migrations são a única forma de alterar o schema — nunca synchronize em nenhum ambiente.
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
});
