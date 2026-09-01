import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { WalletEntity } from '../../infra/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../infra/database/entities/wallet-ledger-entry.entity';
import { Money } from '../../domain/money/money';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletNotFoundError } from '../wagering/wagering.errors';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: ReturnType<Money['toJSON']>;
  calculatedBalance: ReturnType<Money['toJSON']>;
  difference: ReturnType<Money['toJSON']>;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Reconstrói o saldo somando/subtraindo TODOS os lançamentos do ledger da wallet e
 * compara com o saldo materializado na tabela wallets. É a checagem da invariante
 * final exigida pelo desafio: wallet.balance == saldo reconstruído pelo ledger.
 * Divergências não são corrigidas aqui — apenas relatadas (logadas e contabilizadas
 * em métrica pela camada de observabilidade, ver ARCHITECTURE.md).
 */
export async function reconcileWallet(manager: EntityManager, walletId: string): Promise<ReconciliationResult> {
  const walletEntity = await manager.getRepository(WalletEntity).findOneBy({ id: walletId });
  if (!walletEntity) throw new WalletNotFoundError(walletId);

  const entries = await manager.getRepository(WalletLedgerEntryEntity).find({ where: { walletId }, order: { createdAt: 'ASC' } });

  let calculated = new Decimal(0);
  for (const entry of entries) {
    calculated = entry.direction === LedgerDirection.Credit ? calculated.plus(entry.amount) : calculated.minus(entry.amount);
  }

  const stored = Money.from({ amount: walletEntity.balance, currency: walletEntity.currency });
  const calculatedMoney = Money.fromDecimal(calculated, walletEntity.currency);
  const difference = stored.subtract(calculatedMoney);

  return {
    walletId,
    storedBalance: stored.toJSON(),
    calculatedBalance: calculatedMoney.toJSON(),
    difference: difference.toJSON(),
    consistent: difference.isZero(),
    checkedEntries: entries.length,
  };
}
