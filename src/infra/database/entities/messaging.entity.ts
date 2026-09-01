import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** UNIQUE(consumer_name, message_id) no schema garante a deduplicação — não em memória. */
@Entity({ name: 'inbox_messages' })
@Index('uq_inbox_consumer_message', ['consumerName', 'messageId'], { unique: true })
export class InboxMessageEntity {
  @PrimaryColumn({ name: 'message_id' })
  messageId!: string;

  @PrimaryColumn({ name: 'consumer_name' })
  consumerName!: string;

  @Column({ name: 'payload_hash' })
  payloadHash!: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date;
}

@Entity({ name: 'outbox_messages' })
@Index('ix_outbox_pending', ['publishedAt', 'nextAttemptAt'])
export class OutboxMessageEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Column({ name: 'event_type' })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date;
}
