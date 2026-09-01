import { Money } from '../../domain/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';

export function walletToDomain(e: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: e.id,
    playerId: e.playerId,
    currency: e.currency,
    balance: Money.from({ amount: e.balance, currency: e.currency }),
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  });
}

export function walletToEntity(wallet: Wallet, existing?: WalletEntity): WalletEntity {
  const e = existing ?? new WalletEntity();
  e.id = wallet.id;
  e.playerId = wallet.playerId;
  e.currency = wallet.currency;
  e.balance = wallet.balance.toJSON().amount;
  e.version = wallet.version;
  e.createdAt = wallet.createdAt;
  e.updatedAt = wallet.updatedAt;
  return e;
}

export function wagerTransactionToDomain(e: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: e.id,
    providerId: e.providerId,
    externalTransactionId: e.externalTransactionId,
    idempotencyKey: e.idempotencyKey,
    payloadHash: e.payloadHash,
    walletId: e.walletId,
    playerId: e.playerId,
    roundId: e.roundId,
    gameId: e.gameId,
    kind: e.kind,
    money: Money.from({ amount: e.amount, currency: e.currency }),
    referenceExternalTransactionId: e.referenceExternalTransactionId,
    createdAt: e.createdAt,
    status: e.status,
    referenceTransactionId: e.referenceTransactionId,
    failureCode: e.failureCode,
    processedAt: e.processedAt,
  });
}

export function wagerTransactionToEntity(tx: WagerTransaction, existing?: WagerTransactionEntity): WagerTransactionEntity {
  const e = existing ?? new WagerTransactionEntity();
  e.id = tx.id;
  e.providerId = tx.providerId;
  e.externalTransactionId = tx.externalTransactionId;
  e.idempotencyKey = tx.idempotencyKey;
  e.payloadHash = tx.payloadHash;
  e.walletId = tx.walletId;
  e.playerId = tx.playerId;
  e.roundId = tx.roundId;
  e.gameId = tx.gameId;
  e.kind = tx.kind;
  e.amount = tx.money.toJSON().amount;
  e.currency = tx.money.toJSON().currency;
  e.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  e.referenceTransactionId = tx.referenceTransactionId;
  e.status = tx.status;
  e.failureCode = tx.failureCode;
  e.createdAt = tx.createdAt;
  e.processedAt = tx.processedAt;
  return e;
}

export function ledgerEntryToDomain(e: WalletLedgerEntryEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    money: Money.from({ amount: e.amount, currency: e.currency }),
    balanceBefore: Money.from({ amount: e.balanceBefore, currency: e.currency }),
    balanceAfter: Money.from({ amount: e.balanceAfter, currency: e.currency }),
    createdAt: e.createdAt,
  });
}

export function ledgerEntryToEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
  const e = new WalletLedgerEntryEntity();
  e.id = entry.id;
  e.walletId = entry.walletId;
  e.transactionId = entry.transactionId;
  e.direction = entry.direction;
  e.amount = entry.money.toJSON().amount;
  e.currency = entry.money.currency;
  e.balanceBefore = entry.balanceBefore.toJSON().amount;
  e.balanceAfter = entry.balanceAfter.toJSON().amount;
  e.createdAt = entry.createdAt;
  return e;
}
