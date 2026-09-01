import { EntityManager } from 'typeorm';
import { WagerTransactionEntity } from '../../infra/database/entities/wager-transaction.entity';
import { wagerTransactionToDomain } from '../../infra/database/mappers';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { DomainError } from '../../domain/money/money.errors';

export class WagerTransactionNotFoundError extends DomainError {
  constructor(identifier: string) {
    super(`Wager transaction "${identifier}" not found`, 'WAGER_TRANSACTION_NOT_FOUND');
  }
}

export async function getWagerTransactionById(manager: EntityManager, id: string): Promise<WagerTransaction> {
  const entity = await manager.getRepository(WagerTransactionEntity).findOneBy({ id });
  if (!entity) throw new WagerTransactionNotFoundError(id);
  return wagerTransactionToDomain(entity);
}

export async function getWagerTransactionByExternalId(
  manager: EntityManager,
  providerId: string,
  externalTransactionId: string,
): Promise<WagerTransaction> {
  const entity = await manager.getRepository(WagerTransactionEntity).findOneBy({ providerId, externalTransactionId });
  if (!entity) throw new WagerTransactionNotFoundError(`${providerId}:${externalTransactionId}`);
  return wagerTransactionToDomain(entity);
}
