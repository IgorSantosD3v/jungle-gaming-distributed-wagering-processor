import { EntityManager } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { IntegrationEvent } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { OutboxMessageEntity } from '../database/entities/messaging.entity';

/**
 * Insere o evento na outbox usando o MESMO EntityManager/transação da mutação
 * financeira — é isso que torna a publicação atômica com o commit (seção 11 do
 * desafio). Nunca publica direto no SQS a partir do caso de uso.
 */
export async function writeToOutbox(manager: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
  const outboxMessage = OutboxMessage.enqueue(event);
  const entity = new OutboxMessageEntity();
  entity.id = outboxMessage.id || uuid();
  entity.aggregateId = event.aggregateId;
  entity.eventType = event.eventType;
  entity.payload = event.toJSON() as unknown as Record<string, unknown>;
  entity.occurredAt = event.occurredAt;
  entity.attempts = 0;
  // O TypeORM tenta tipar `jsonb` como QueryDeepPartialEntity recursivo; para um
  // payload de evento (JSON livre por natureza) o cast é seguro e documentado aqui.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await manager.getRepository(OutboxMessageEntity).insert(entity as any);
}
