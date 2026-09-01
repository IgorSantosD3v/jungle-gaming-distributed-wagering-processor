/**
 * Não é um arquivo de teste — é um script que test/concurrency/three-instances.spec.ts
 * roda como PROCESSO SEPARADO (via Bun.spawn), várias vezes ao mesmo tempo, cada
 * um com sua própria conexão independente ao Postgres. Isso é a interpretação
 * literal de "três ou mais instâncias/processos simultâneos" (seção 8/13) — não
 * apenas conexões concorrentes dentro do mesmo processo Node/Bun.
 *
 * Uso: bun run submit-bet-process.ts <walletId> <playerId> <externalTransactionId> <amount>
 * Imprime uma única linha JSON em stdout com o resultado e sai.
 */
import 'reflect-metadata';
import { AppDataSource } from '../../../src/infra/database/data-source';
import { submitWagerTransaction } from '../../../src/application/wagering/submit-wager-transaction.use-case';
import { Money } from '../../../src/domain/money/money';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction/wager-transaction';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [walletId, playerId, externalTransactionId, amount] = args;
  if (!walletId || !playerId || !externalTransactionId || !amount) {
    throw new Error(`Missing required arguments. Usage: submit-bet-process.ts <walletId> <playerId> <externalTransactionId> <amount>. Got: ${JSON.stringify(args)}`);
  }
  const dataSource = await AppDataSource.initialize();
  try {
    const result = await dataSource.transaction((manager) =>
      submitWagerTransaction(manager, {
        idempotencyKey: `provider-a:${externalTransactionId}`,
        providerId: 'provider-a',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'r1',
        gameId: 'g1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount, currency: 'BRL' }),
        correlationId: `process-test:${externalTransactionId}`,
      }),
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: (err as Error).message }) + '\n');
  process.exit(1);
});
