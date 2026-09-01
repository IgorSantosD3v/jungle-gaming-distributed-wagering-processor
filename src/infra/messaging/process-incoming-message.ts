import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { InboxMessageEntity } from '../database/entities/messaging.entity';
import { submitWagerTransaction } from '../../application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction';
import { Money } from '../../domain/money/money';
import { IdempotencyConflictError } from '../../application/wagering/wagering.errors';
import { DomainError } from '../../domain/money/money.errors';
import { MetricsService } from '../observability/metrics.service';
import { recordTransactionMetrics } from '../observability/record-transaction-metrics';

export const WAGER_TRANSACTIONS_CONSUMER_NAME = 'wager-transactions-consumer';

export interface WagerTransactionRequestedEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

export interface MessageLogContext {
  correlationId?: string;
  providerId?: string;
  walletId?: string;
  transactionId?: string;
}

/**
 * Três caminhos, explicitamente distintos (seção 10 do desafio):
 *  - "ack": erro de negócio (terminal) ou sucesso — o resultado já está persistido,
 *    reenviar não mudaria nada. A mensagem é confirmada (deletada da fila).
 *  - "retry": falha transitória de infraestrutura (Postgres fora do ar, timeout de
 *    lock, deadlock) — a mesma mensagem pode dar certo numa próxima tentativa.
 *    NÃO é confirmada; a visibilidade é reagendada com backoff (ver consumer).
 *  - "dead_letter": erro permanente — payload malformado, JSON inválido, campos
 *    obrigatórios ausentes. Reenviar nunca vai ajudar. Mandada para a DLQ
 *    imediatamente pelo próprio código (não esperamos o maxReceiveCount do SQS
 *    esgotar sozinho) e confirmada na fila principal.
 */
export type MessageProcessingOutcome =
  | { action: 'ack'; note?: string; context?: MessageLogContext }
  | { action: 'retry'; reason: string; context?: MessageLogContext }
  | { action: 'dead_letter'; reason: string; context?: MessageLogContext };

/**
 * Processa uma mensagem da fila de entrada. Não sabe nada sobre SQS (não recebe
 * nem manda ReceiptHandle, não faz ChangeMessageVisibility/DeleteMessage) — só
 * decide o que ACONTECEU e o que deveria acontecer com a mensagem. O consumidor
 * real (`WagerTransactionsConsumer`) é a única camada que fala com o SQS de
 * verdade; esta função é pura o suficiente para ser testada diretamente contra
 * um Postgres real, sem precisar de LocalStack.
 */
/** OPENING é interno — nunca aceito vindo de fora, seja API ou fila (seção 6.3). */
const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A seção 2 exige que mensagens da fila passem pelas MESMAS validações de
 * domínio que a entrada HTTP, mesmo sendo um canal interno confiável — a API
 * já garante isso via decorators do DTO (`@IsUUID()`, `@IsString()` etc.);
 * este é o equivalente para a fila. Sem isso, um `playerId`/`walletId`
 * malformado (não-UUID) chegaria direto em `submitWagerTransaction`, o
 * Postgres lançaria um erro cru de sintaxe ("invalid input syntax for type
 * uuid") que NÃO é um `DomainError`, e a mensagem seria classificada como
 * `retry` (transitório) quando na verdade é um erro permanente — ficaria
 * tentando de novo à toa em vez de ir direto para `dead_letter`.
 */
function validateEnvelopeData(data: WagerTransactionRequestedEnvelope['data'] | undefined): string | undefined {
  if (!data || typeof data !== 'object') return 'data is missing or not an object';
  if (!data.providerId || typeof data.providerId !== 'string') return 'providerId is missing or not a string';
  if (!data.externalTransactionId || typeof data.externalTransactionId !== 'string') return 'externalTransactionId is missing or not a string';
  if (!data.idempotencyKey || typeof data.idempotencyKey !== 'string') return 'idempotencyKey is missing or not a string';
  if (!data.playerId || !UUID_PATTERN.test(data.playerId)) return 'playerId is missing or not a valid UUID';
  if (!data.walletId || !UUID_PATTERN.test(data.walletId)) return 'walletId is missing or not a valid UUID';
  if (!data.roundId || typeof data.roundId !== 'string') return 'roundId is missing or not a string';
  if (!data.gameId || typeof data.gameId !== 'string') return 'gameId is missing or not a string';
  if (!data.money || typeof data.money.amount !== 'string' || typeof data.money.currency !== 'string') return 'money is missing or malformed';
  if (data.referenceExternalTransactionId !== undefined && typeof data.referenceExternalTransactionId !== 'string') {
    return 'referenceExternalTransactionId must be a string when present';
  }
  return undefined;
}

export async function processIncomingMessage(
  dataSource: DataSource,
  metrics: MetricsService,
  consumerName: string,
  rawBody: string,
): Promise<MessageProcessingOutcome> {
  let envelope: WagerTransactionRequestedEnvelope;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || !parsed.messageId || !parsed.data) {
      throw new Error('Missing required envelope fields (messageId, data)');
    }
    envelope = parsed as WagerTransactionRequestedEnvelope;
  } catch (err) {
    // Payload permanentemente inválido — nenhuma quantidade de retry resolve isso.
    return { action: 'dead_letter', reason: `malformed_payload: ${(err as Error).message}` };
  }

  // Validação explícita do `kind` — sem isso, uma mensagem com "kind": "OPENING"
  // (ou qualquer string arbitrária) chegaria direto em `submitWagerTransaction` e,
  // por não ser "BET", cairia no branch de CREDIT em `applyDirectMutation`,
  // creditando a wallet sem nenhum débito correspondente. A API já bloqueia isso
  // via DTO (`@IsEnum`); a fila precisa da mesma barreira.
  if (!SUBMITTABLE_KINDS.has(envelope.data?.kind as string)) {
    return {
      action: 'dead_letter',
      reason: `invalid_or_internal_kind: "${envelope.data?.kind}" is not a submittable WagerTransactionKind`,
      context: { correlationId: envelope.messageId, providerId: envelope.data?.providerId, walletId: envelope.data?.walletId },
    };
  }

  const validationError = validateEnvelopeData(envelope.data);
  if (validationError) {
    return {
      action: 'dead_letter',
      reason: `invalid_envelope_data: ${validationError}`,
      context: { correlationId: envelope.messageId, providerId: envelope.data?.providerId, walletId: envelope.data?.walletId },
    };
  }

  const context: MessageLogContext = {
    correlationId: envelope.messageId,
    providerId: envelope.data?.providerId,
    walletId: envelope.data?.walletId,
  };

  const payloadHash = createHash('sha256').update(JSON.stringify(envelope.data)).digest('hex');

  try {
    let transactionId: string | undefined;

    await dataSource.transaction(async (manager) => {
      const txInboxRepo = manager.getRepository(InboxMessageEntity);
      const existingInbox = await txInboxRepo.findOneBy({ consumerName, messageId: envelope.messageId });
      if (existingInbox?.processedAt) {
        // Redelivery de uma mensagem que já processamos por completo (ex.: o worker
        // anterior morreu DEPOIS do commit mas ANTES de conseguir dar ack) — não
        // reprocessa, apenas confirma que está tudo certo para dar ack de novo.
        return;
      }
      if (!existingInbox) {
        await txInboxRepo.insert({ consumerName, messageId: envelope.messageId, payloadHash, receivedAt: new Date() });
      }

      const result = await submitWagerTransaction(manager, {
        idempotencyKey: envelope.data.idempotencyKey,
        providerId: envelope.data.providerId,
        externalTransactionId: envelope.data.externalTransactionId,
        playerId: envelope.data.playerId,
        walletId: envelope.data.walletId,
        roundId: envelope.data.roundId,
        gameId: envelope.data.gameId,
        kind: envelope.data.kind,
        money: Money.from(envelope.data.money),
        referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
        correlationId: envelope.messageId,
      });
      transactionId = result.transactionId;
      recordTransactionMetrics(metrics, envelope.data.kind, result);

      await txInboxRepo.update({ consumerName, messageId: envelope.messageId }, { processedAt: new Date() });
    });

    return { action: 'ack', context: { ...context, transactionId } };
  } catch (err) {
    if (err instanceof IdempotencyConflictError || err instanceof DomainError) {
      // Erro de negócio/validação — terminal. O resultado (REJECTED, por exemplo)
      // já foi persistido pelo caso de uso antes de lançar; reenviar não ajuda.
      return { action: 'ack', note: `business_error: ${err.message}`, context };
    }
    if (metrics.isDeadlockError(err)) {
      metrics.lockConflictsTotal.inc();
    }
    return { action: 'retry', reason: (err as Error).message, context };
  }
}
