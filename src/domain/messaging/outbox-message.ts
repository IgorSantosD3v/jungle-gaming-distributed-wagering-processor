import { IntegrationEvent } from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const MAX_BACKOFF_SECONDS = 300; // 5 min — teto do backoff exponencial
const BASE_BACKOFF_SECONDS = 2;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      envelope.eventId,
      envelope.aggregateId,
      envelope.eventType,
      envelope as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (!this._nextAttemptAt) return true; // nunca tentado ainda
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date = new Date()): void {
    this._publishedAt = at;
  }

  /** Incrementa attempts e agenda o próximo envio com backoff exponencial + jitter. */
  scheduleRetry(now: Date = new Date()): void {
    this._attempts += 1;
    const exponent = Math.min(this._attempts, 8); // evita overflow do 2^n
    const backoffSeconds = Math.min(BASE_BACKOFF_SECONDS * 2 ** exponent, MAX_BACKOFF_SECONDS);
    const jitterMs = Math.floor(Math.random() * 1000);
    this._nextAttemptAt = new Date(now.getTime() + backoffSeconds * 1000 + jitterMs);
  }
}
