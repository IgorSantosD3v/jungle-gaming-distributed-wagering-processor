import { createHash } from 'node:crypto';

/**
 * payloadHash = SHA-256 de um JSON canônico (chaves ordenadas alfabeticamente,
 * sem espaços) do SUBCONJUNTO de campos de negócio da requisição. O header
 * Idempotency-Key e metadados de transporte (ex.: messageId da fila) NUNCA entram
 * no hash — só o conteúdo que, se mudasse, mudaria o resultado financeiro.
 *
 * Campos incluídos: providerId, externalTransactionId, playerId, walletId, roundId,
 * gameId, kind, money.amount, money.currency, referenceExternalTransactionId.
 */
export interface WagerTransactionBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        result[key] = canonicalize(v);
      }
    }
    return result;
  }
  return value;
}

export function computePayloadHash(payload: WagerTransactionBusinessPayload): string {
  const canonicalJson = JSON.stringify(canonicalize(payload));
  return createHash('sha256').update(canonicalJson).digest('hex');
}
