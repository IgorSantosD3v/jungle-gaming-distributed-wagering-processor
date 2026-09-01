import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { computePayloadHash } from '../../src/common/idempotency/payload-hash';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed.event';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction';
import { Money } from '../../src/domain/money/money';

describe('InboxMessage', () => {
  it('starts unprocessed and can be marked processed', () => {
    const inbox = InboxMessage.receive({ messageId: 'm1', consumerName: 'c1', payloadHash: 'h1' });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed();
    expect(inbox.isProcessed()).toBe(true);
  });
});

describe('OutboxMessage', () => {
  function buildEvent() {
    const tx = WagerTransaction.create({
      id: 'tx1',
      providerId: 'p',
      externalTransactionId: 'e1',
      idempotencyKey: 'p:e1',
      payloadHash: 'h',
      walletId: 'w1',
      playerId: 'pl1',
      roundId: 'r1',
      gameId: 'g1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: new Date(),
    });
    tx.markProcessed(undefined, new Date());
    return WagerTransactionProcessed.from(tx, { correlationId: 'corr1' });
  }

  it('enqueue() starts pending with zero attempts', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());
    expect(outbox.isPending()).toBe(true);
    expect(outbox.attempts).toBe(0);
    expect(outbox.isDue(new Date())).toBe(true); // nunca tentado -> sempre due
  });

  it('scheduleRetry() increments attempts and pushes nextAttemptAt into the future', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());
    const now = new Date();
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(outbox.isDue(now)).toBe(false);
    expect(outbox.isDue(new Date(outbox.nextAttemptAt!.getTime() + 1))).toBe(true);
  });

  it('markPublished() makes it no longer pending/due', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());
    outbox.markPublished();
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date())).toBe(false);
  });

  it('backoff is exponential and capped', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());
    const now = new Date();
    let previousDelay = 0;
    for (let i = 0; i < 6; i++) {
      outbox.scheduleRetry(now);
      const delay = outbox.nextAttemptAt!.getTime() - now.getTime();
      expect(delay).toBeGreaterThanOrEqual(previousDelay);
      previousDelay = delay;
    }
  });
});

describe('computePayloadHash', () => {
  it('is stable regardless of key order', () => {
    const a = computePayloadHash({
      providerId: 'p',
      externalTransactionId: 'e1',
      playerId: 'pl',
      walletId: 'w1',
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    const b = computePayloadHash({
      money: { currency: 'BRL', amount: '10.00' },
      kind: 'BET',
      gameId: 'g1',
      roundId: 'r1',
      walletId: 'w1',
      playerId: 'pl',
      externalTransactionId: 'e1',
      providerId: 'p',
    });
    expect(a).toBe(b);
  });

  it('changes when any business field changes', () => {
    const base = {
      providerId: 'p',
      externalTransactionId: 'e1',
      playerId: 'pl',
      walletId: 'w1',
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const changed = { ...base, money: { amount: '10.01', currency: 'BRL' } };
    expect(computePayloadHash(base)).not.toBe(computePayloadHash(changed));
  });
});
