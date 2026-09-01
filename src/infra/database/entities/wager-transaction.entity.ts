import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction';
import { FailureCode } from '../../../domain/wager-transaction/failure-code';

/**
 * `idempotency_key` tem UNIQUE constraint (ver migration) — é a fonte da verdade
 * da idempotência de negócio. `(provider_id, external_transaction_id)` também é
 * único, e é usado para resolver referências de REFUND/ROLLBACK.
 */
@Entity({ name: 'wager_transactions' })
@Index('uq_wagertx_idempotency_key', ['idempotencyKey'], { unique: true })
@Index('uq_wagertx_provider_external', ['providerId', 'externalTransactionId'], { unique: true })
@Index('ix_wagertx_wallet', ['walletId'])
@Index('ix_wagertx_status', ['status'])
export class WagerTransactionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id' })
  providerId!: string;

  @Column({ name: 'external_transaction_id' })
  externalTransactionId!: string;

  @Column({ name: 'idempotency_key' })
  idempotencyKey!: string;

  @Column({ name: 'payload_hash' })
  payloadHash!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({ name: 'round_id' })
  roundId!: string;

  @Column({ name: 'game_id' })
  gameId!: string;

  @Column({ type: 'varchar' })
  kind!: WagerTransactionKind;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'reference_external_transaction_id', nullable: true })
  referenceExternalTransactionId?: string;

  @Column({ name: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Column({ type: 'varchar' })
  status!: WagerTransactionStatus;

  @Column({ name: 'failure_code', type: 'varchar', nullable: true })
  failureCode?: FailureCode;

  @Column({ name: 'reference_attempts', type: 'integer', default: 0 })
  referenceAttempts!: number;

  @Column({ name: 'next_reference_attempt_at', type: 'timestamptz', nullable: true })
  nextReferenceAttemptAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date;
}
