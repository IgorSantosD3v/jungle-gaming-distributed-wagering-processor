import { EntityManager } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { Money } from '../../domain/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction';
import { FailureCode } from '../../domain/wager-transaction/failure-code';
import { InsufficientBalanceError } from '../../domain/wallet/wallet.errors';
import { CurrencyMismatchError } from '../../domain/money/money.errors';
import { computePayloadHash } from '../../common/idempotency/payload-hash';
import { WalletEntity } from '../../infra/database/entities/wallet.entity';
import { WagerTransactionEntity } from '../../infra/database/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../infra/database/entities/wallet-ledger-entry.entity';
import { walletToDomain, walletToEntity, wagerTransactionToDomain, wagerTransactionToEntity, ledgerEntryToEntity } from '../../infra/database/mappers';
import { writeToOutbox } from '../../infra/messaging/outbox-writer';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference.event';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';
import { IdempotencyConflictError, WalletNotFoundError } from './wagering.errors';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: ReturnType<Money['toJSON']>;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

/** REFUND só referencia BET. ROLLBACK referencia BET, WIN ou REFUND. WIN pode opcionalmente referenciar BET. */
const VALID_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
};

/**
 * Fluxo central do desafio. Roda inteiro dentro de UMA transação SQL (ver `manager`
 * injetado pelo caller — HTTP controller ou consumidor SQS chamam
 * `dataSource.transaction(manager => submitWagerTransaction(manager, command))`).
 *
 * Ordem de operações e por quê (nesta ordem exata — invertê-la reintroduz um deadlock,
 * ver ARCHITECTURE.md § "Concorrência" para o caso registrado):
 *  1. SELECT ... FOR UPDATE da wallet — ANTES de qualquer INSERT que referencie essa
 *     wallet via chave estrangeira. Um INSERT em wager_transactions já pega um lock de
 *     leitura (FOR KEY SHARE) na wallet referenciada só por causa da FK; se isso
 *     acontecesse antes do FOR UPDATE explícito, duas transações concorrentes na MESMA
 *     wallet pegariam esse lock de leitura ao mesmo tempo e depois ficariam esperando
 *     uma a outra para conseguir o lock exclusivo — um deadlock. Travando a wallet
 *     primeiro, cada transação só disputa UM lock por vez, na mesma ordem sempre.
 *  2. INSERT da wager_transaction com `ON CONFLICT (idempotency_key) DO NOTHING` — não
 *     usa uma constraint UNIQUE "crua" (que lançaria um erro real do Postgres e
 *     abortaria a transação inteira, impedindo qualquer SELECT depois). Com
 *     ON CONFLICT DO NOTHING, uma colisão de idempotency_key simplesmente não insere
 *     nada e não lança erro — verificamos o resultado do INSERT para saber se "ganhamos"
 *     o direito de processar ou se é um replay.
 *  3. Mutação de domínio (debit/credit/reverse) em memória.
 *  4. Persistência de wallet + ledger + transaction + evento de outbox — tudo
 *     ainda dentro da mesma transação, então ou tudo comita, ou nada comita.
 */
export async function submitWagerTransaction(
  manager: EntityManager,
  command: SubmitWagerTransactionCommand,
): Promise<SubmitWagerTransactionResult> {
  const payloadHash = computePayloadHash({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money.toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });

  const txRepo = manager.getRepository(WagerTransactionEntity);

  // ---- 1. Lock pessimista da wallet — SEMPRE primeiro (ver comentário acima) ----
  const walletRepo = manager.getRepository(WalletEntity);
  const walletEntity = await walletRepo.findOne({ where: { id: command.walletId }, lock: { mode: 'pessimistic_write' } });
  if (!walletEntity) {
    throw new WalletNotFoundError(command.walletId);
  }
  const wallet = walletToDomain(walletEntity);

  // ---- 2. Tenta "ganhar" o direito de processar via INSERT ... ON CONFLICT DO NOTHING ----
  const newTx = WagerTransaction.create({
    id: uuid(),
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    idempotencyKey: command.idempotencyKey,
    payloadHash,
    walletId: command.walletId,
    playerId: command.playerId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    referenceExternalTransactionId: command.referenceExternalTransactionId,
    createdAt: new Date(),
  });

  // IMPORTANTE: usamos SQL puro com RETURNING aqui, não o InsertQueryBuilder do
  // TypeORM. Como `id` é gerado pela aplicação (uuid() em JS, não pelo banco),
  // `insertResult.identifiers` do TypeORM apenas ecoa de volta os valores que
  // passamos em `.values(...)` — ele NÃO reflete se a linha foi de fato inserida
  // ou descartada pelo ON CONFLICT DO NOTHING. Isso causava um bug real: `owns`
  // sempre dava `true`, mesmo em conflito genuíno. RETURNING de uma query SQL
  // direta, em contraste, só devolve as linhas que o Postgres realmente gravou.
  const txEntity = wagerTransactionToEntity(newTx);
  const insertRows: Array<{ id: string }> = await manager.query(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency,
        reference_external_transaction_id, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      txEntity.id,
      txEntity.providerId,
      txEntity.externalTransactionId,
      txEntity.idempotencyKey,
      txEntity.payloadHash,
      txEntity.walletId,
      txEntity.playerId,
      txEntity.roundId,
      txEntity.gameId,
      txEntity.kind,
      txEntity.amount,
      txEntity.currency,
      txEntity.referenceExternalTransactionId ?? null,
      txEntity.status,
      txEntity.createdAt,
    ],
  );
  const owns = insertRows.length > 0;

  if (!owns) {
    // Outra requisição (ou uma redelivery) já criou esta transação. Como já detemos o
    // lock exclusivo da wallet neste ponto, e a transação vencedora só consegue chegar
    // a um status terminal depois de também ter adquirido (e liberado, via commit) esse
    // MESMO lock, esta leitura já enxerga o estado final e consistente.
    const existing = await txRepo.findOneByOrFail({ idempotencyKey: command.idempotencyKey });
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError(command.idempotencyKey);
    }
    return buildReplayResult(manager, existing);
  }

  if (wallet.playerId !== command.playerId || wallet.currency !== command.money.currency) {
    newTx.reject(FailureCode.CURRENCY_MISMATCH);
    await persistRejection(manager, newTx);
    return toResult(newTx, wallet.balance, false);
  }

  // ---- 3a. LOSS: registra o resultado sem mover saldo ----
  if (newTx.kind === WagerTransactionKind.Loss) {
    newTx.markProcessed(undefined, new Date());
    await txRepo.update({ id: newTx.id }, wagerTransactionToEntity(newTx));
    await writeToOutbox(manager, WagerTransactionProcessed.from(newTx, { correlationId: command.correlationId }));
    return toResult(newTx, wallet.balance, false);
  }

  // ---- 3b. Kinds com referência (REFUND, ROLLBACK, WIN opcional) ----
  const allowedRefKinds = VALID_REFERENCE_KINDS[newTx.kind];
  if (command.referenceExternalTransactionId && allowedRefKinds) {
    return handleReferencedTransaction(manager, newTx, wallet, command, allowedRefKinds);
  }

  // ---- 3c. BET / WIN sem referência ----
  return applyDirectMutation(manager, newTx, wallet, command);
}

async function applyDirectMutation(
  manager: EntityManager,
  tx: WagerTransaction,
  wallet: Wallet,
  command: SubmitWagerTransactionCommand,
): Promise<SubmitWagerTransactionResult> {
  try {
    const mutation = tx.kind === WagerTransactionKind.Bet ? wallet.debit(command.money) : wallet.credit(command.money);
    tx.markProcessed(undefined, new Date());
    await persistProcessed(manager, tx, wallet, mutation.direction, mutation.balanceBefore, mutation.balanceAfter, command.money, command.correlationId);
    return toResult(tx, wallet.balance, false);
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      tx.reject(FailureCode.INSUFFICIENT_BALANCE);
      await persistRejection(manager, tx, command.correlationId);
      return toResult(tx, wallet.balance, false);
    }
    if (err instanceof CurrencyMismatchError) {
      tx.reject(FailureCode.CURRENCY_MISMATCH);
      await persistRejection(manager, tx, command.correlationId);
      return toResult(tx, wallet.balance, false);
    }
    throw err;
  }
}

async function handleReferencedTransaction(
  manager: EntityManager,
  tx: WagerTransaction,
  wallet: Wallet,
  command: SubmitWagerTransactionCommand,
  allowedRefKinds: WagerTransactionKind[],
): Promise<SubmitWagerTransactionResult> {
  const txRepo = manager.getRepository(WagerTransactionEntity);

  const referenceEntity = await txRepo.findOneBy({
    providerId: command.providerId,
    externalTransactionId: command.referenceExternalTransactionId!,
  });

  if (!referenceEntity) {
    tx.markPendingReference();
    await txRepo.update({ id: tx.id }, wagerTransactionToEntity(tx));
    await writeToOutbox(manager, WagerTransactionPendingReference.from(tx, { correlationId: command.correlationId }));
    return toResult(tx, wallet.balance, false);
  }

  const reference = wagerTransactionToDomain(referenceEntity);

  const scopeOk =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.roundId === tx.roundId &&
    reference.money.currency === tx.money.currency;

  if (!scopeOk) {
    tx.reject(FailureCode.REFERENCE_SCOPE_MISMATCH);
    await persistRejection(manager, tx, command.correlationId);
    return toResult(tx, wallet.balance, false);
  }

  if (reference.status !== WagerTransactionStatus.Processed || !allowedRefKinds.includes(reference.kind)) {
    tx.reject(FailureCode.INVALID_REFERENCE_KIND);
    await persistRejection(manager, tx, command.correlationId);
    return toResult(tx, wallet.balance, false);
  }

  // "O valor de REFUND/ROLLBACK deve ser igual ao valor da referência" (seção 7) —
  // essa regra é só para REFUND/ROLLBACK. WIN pode referenciar uma BET
  // opcionalmente, mas o valor do prêmio normalmente é DIFERENTE do valor
  // apostado (por isso não faz sentido exigir igualdade aqui).
  const requiresEqualAmount = tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback;
  if (requiresEqualAmount && !tx.money.equals(reference.money)) {
    tx.reject(FailureCode.AMOUNT_MISMATCH_WITH_REFERENCE);
    await persistRejection(manager, tx, command.correlationId);
    return toResult(tx, wallet.balance, false);
  }

  // Uma referência não pode ser revertida duas vezes pelo MESMO tipo de operação.
  // Estamos sob o lock da wallet, então esta leitura é segura contra a corrida.
  const alreadyReversed = await txRepo.exist({
    where: { referenceTransactionId: reference.id, kind: tx.kind, status: WagerTransactionStatus.Processed },
  });
  if (alreadyReversed) {
    tx.reject(FailureCode.ALREADY_REVERSED);
    await persistRejection(manager, tx, command.correlationId);
    return toResult(tx, wallet.balance, false);
  }

  try {
    const direction = tx.ledgerDirectionFor(reference);
    const mutation = wallet.reverse(direction, tx.money);
    tx.markProcessed(reference.id, new Date());
    await persistProcessed(manager, tx, wallet, mutation.direction, mutation.balanceBefore, mutation.balanceAfter, tx.money, command.correlationId);
    return toResult(tx, wallet.balance, false);
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      // Mesma causa raiz (saldo insuficiente), mas failureCode DISTINTO: uma reversão
      // que estouraria o saldo é operacionalmente diferente de uma aposta sem saldo.
      tx.reject(FailureCode.REVERSAL_WOULD_OVERDRAW);
      await persistRejection(manager, tx, command.correlationId);
      return toResult(tx, wallet.balance, false);
    }
    throw err;
  }
}

async function persistProcessed(
  manager: EntityManager,
  tx: WagerTransaction,
  wallet: Wallet,
  direction: LedgerDirection,
  balanceBefore: Money,
  balanceAfter: Money,
  money: Money,
  correlationId: string,
): Promise<void> {
  const walletRepo = manager.getRepository(WalletEntity);
  const txRepo = manager.getRepository(WagerTransactionEntity);

  const entry = WalletLedgerEntry.create({
    id: uuid(),
    walletId: wallet.id,
    transactionId: tx.id,
    direction,
    money,
    balanceBefore,
    balanceAfter,
  });

  await walletRepo.update({ id: wallet.id }, walletToEntity(wallet));
  await manager.insert(WalletLedgerEntryEntity, ledgerEntryToEntity(entry));
  await txRepo.update({ id: tx.id }, wagerTransactionToEntity(tx));

  await writeToOutbox(manager, WagerTransactionProcessed.from(tx, { correlationId }));
  await writeToOutbox(manager, WalletBalanceChanged.from(wallet, entry, { correlationId }));
}

async function persistRejection(manager: EntityManager, tx: WagerTransaction, correlationId = 'internal'): Promise<void> {
  const txRepo = manager.getRepository(WagerTransactionEntity);
  await txRepo.update({ id: tx.id }, wagerTransactionToEntity(tx));
  await writeToOutbox(manager, WagerTransactionRejected.from(tx, { correlationId }));
}

async function buildReplayResult(manager: EntityManager, existing: WagerTransactionEntity): Promise<SubmitWagerTransactionResult> {
  const tx = wagerTransactionToDomain(existing);
  const walletRepo = manager.getRepository(WalletEntity);

  if (tx.affectsBalance() && tx.status === WagerTransactionStatus.Processed) {
    const ledgerRepo = manager.getRepository(WalletLedgerEntryEntity);
    const entry = await ledgerRepo.findOneBy({ transactionId: tx.id });
    if (entry) {
      return toResult(tx, Money.from({ amount: entry.balanceAfter, currency: entry.currency }), true);
    }
  }
  // LOSS, REJECTED, FAILED ou PENDING_REFERENCE nunca moveram o saldo: o saldo atual
  // da wallet é equivalente ao saldo "observado" no momento original.
  const walletEntity = await walletRepo.findOneByOrFail({ id: tx.walletId });
  return toResult(tx, walletToDomain(walletEntity).balance, true);
}

function toResult(tx: WagerTransaction, balance: Money, idempotentReplay: boolean): SubmitWagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: balance.toJSON(),
    idempotentReplay,
    failureCode: tx.failureCode,
  };
}

