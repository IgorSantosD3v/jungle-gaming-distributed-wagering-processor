import { EntityManager } from 'typeorm';
import { WalletEntity } from '../../infra/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../infra/database/entities/wallet-ledger-entry.entity';
import { walletToDomain, ledgerEntryToDomain } from '../../infra/database/mappers';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { WalletNotFoundError } from '../wagering/wagering.errors';

export async function getWallet(manager: EntityManager, walletId: string): Promise<Wallet> {
  const entity = await manager.getRepository(WalletEntity).findOneBy({ id: walletId });
  if (!entity) throw new WalletNotFoundError(walletId);
  return walletToDomain(entity);
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

/**
 * Cursor opaco e estável: base64 de um ULID/UUID de sequência monotônica combinada
 * com created_at não seria suficiente sozinho (empates de timestamp), então usamos
 * `id` (UUID gerado em ordem de inserção não é garantidamente ordenável) — por isso
 * a paginação real usa uma coluna auxiliar `created_at` + `id` como tie-breaker,
 * ambos codificados no cursor.
 */
export async function getWalletLedger(
  manager: EntityManager,
  walletId: string,
  limit: number,
  cursor?: string,
): Promise<LedgerPage> {
  const repo = manager.getRepository(WalletLedgerEntryEntity);
  const qb = repo
    .createQueryBuilder('e')
    .where('e.wallet_id = :walletId', { walletId })
    .orderBy('e.created_at', 'ASC')
    .addOrderBy('e.id', 'ASC')
    .limit(limit + 1);

  if (cursor) {
    const decoded = decodeCursor(cursor);
    qb.andWhere('(e.created_at, e.id) > (:createdAt, :id)', { createdAt: decoded.createdAt, id: decoded.id });
  }

  const rows = await qb.getMany();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    entries: page.map(ledgerEntryToDomain),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
}
