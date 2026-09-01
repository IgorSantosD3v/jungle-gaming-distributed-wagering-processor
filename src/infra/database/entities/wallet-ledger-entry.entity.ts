import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { LedgerDirection } from '../../../domain/ledger/ledger-direction';

/**
 * Sem colunas de update — a imutabilidade do ledger é estrutural: nenhum repositório
 * expõe um `update()` para esta entidade (ver WalletLedgerRepository).
 * UNIQUE(transaction_id) força "no máximo um lançamento por transação" no schema.
 */
@Entity({ name: 'wallet_ledger_entries' })
@Index('uq_ledger_transaction', ['transactionId'], { unique: true })
@Index('ix_ledger_wallet_created', ['walletId', 'createdAt'])
export class WalletLedgerEntryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ type: 'varchar' })
  direction!: LedgerDirection;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'balance_before', type: 'numeric', precision: 18, scale: 2 })
  balanceBefore!: string;

  @Column({ name: 'balance_after', type: 'numeric', precision: 18, scale: 2 })
  balanceAfter!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
