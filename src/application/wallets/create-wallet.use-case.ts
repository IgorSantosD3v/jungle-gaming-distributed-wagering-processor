import { EntityManager } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { Money } from '../../domain/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction';
import { WalletEntity } from '../../infra/database/entities/wallet.entity';
import { WagerTransactionEntity } from '../../infra/database/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../infra/database/entities/wallet-ledger-entry.entity';
import { walletToEntity, wagerTransactionToEntity, ledgerEntryToEntity } from '../../infra/database/mappers';
import { writeToOutbox } from '../../infra/messaging/outbox-writer';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event';
import { WalletAlreadyExistsError } from '../wagering/wagering.errors';
import { computePayloadHash } from '../../common/idempotency/payload-hash';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: ReturnType<Money['toJSON']>;
  version: number;
}

/**
 * Criar wallet duplicada para o mesmo playerId + currency é conflito (409) — garantido
 * pela UNIQUE(player_id, currency) no schema; aqui apenas traduzimos a violação.
 */
export async function createWallet(manager: EntityManager, command: CreateWalletCommand): Promise<CreateWalletResult> {
  const walletId = uuid();
  // A wallet nasce JÁ com o saldo inicial, em version 1 — o crédito de abertura é
  // parte de "vir a existir", não uma mutação aplicada depois (por isso não usamos
  // wallet.credit(), que incrementaria a version para 2; o exemplo de resposta do
  // desafio mostra explicitamente version: 1 mesmo com initialBalance > 0).
  const wallet = Wallet.open({ id: walletId, playerId: command.playerId, initialBalance: command.initialBalance });

  const walletRepo = manager.getRepository(WalletEntity);
  try {
    await walletRepo.insert(walletToEntity(wallet));
  } catch (err: unknown) {
    if (isUniqueViolation(err, 'uq_wallets_player_currency')) {
      throw new WalletAlreadyExistsError(command.playerId, command.initialBalance.currency);
    }
    throw err;
  }

  if (command.initialBalance.isPositive()) {
    // OPENING é interno: nasce e é processado atomicamente aqui, nunca via API/fila.
    const openingTx = WagerTransaction.create({
      id: uuid(),
      providerId: 'internal',
      externalTransactionId: `opening:${walletId}`,
      idempotencyKey: `internal:opening:${walletId}`,
      payloadHash: computePayloadHash({
        providerId: 'internal',
        externalTransactionId: `opening:${walletId}`,
        playerId: command.playerId,
        walletId,
        roundId: 'internal',
        gameId: 'internal',
        kind: WagerTransactionKind.Opening,
        money: command.initialBalance.toJSON(),
      }),
      walletId,
      playerId: command.playerId,
      roundId: 'internal',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: command.initialBalance,
      createdAt: new Date(),
    });

    openingTx.markProcessed(undefined, new Date());

    // Lançamento de ledger construído diretamente (não via wallet.credit()): o saldo
    // "antes" da abertura é zero e "depois" é o saldo com que a wallet já nasceu —
    // sem que isso conte como uma mutação de version no aggregate.
    const entry = WalletLedgerEntry.create({
      id: uuid(),
      walletId,
      transactionId: openingTx.id,
      direction: LedgerDirection.Credit,
      money: command.initialBalance,
      balanceBefore: Money.zero(command.initialBalance.currency),
      balanceAfter: wallet.balance,
    });

    await manager.getRepository(WagerTransactionEntity).insert(wagerTransactionToEntity(openingTx));
    await manager.getRepository(WalletLedgerEntryEntity).insert(ledgerEntryToEntity(entry));
    await writeToOutbox(manager, WagerTransactionProcessed.from(openingTx, { correlationId: command.correlationId }));
    await writeToOutbox(manager, WalletBalanceChanged.from(wallet, entry, { correlationId: command.correlationId }));
  }

  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const e = err as { code?: string; driverError?: { code?: string; constraint?: string }; constraint?: string };
  const code = e?.driverError?.code ?? e?.code;
  const constraint = e?.driverError?.constraint ?? e?.constraint;
  return code === '23505' && constraint === constraintName;
}
