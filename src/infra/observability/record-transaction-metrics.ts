import { MetricsService } from './metrics.service';
import { SubmitWagerTransactionResult } from '../../application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction';

/** Chamado em todo ponto de entrada que processa uma WagerTransaction (HTTP e SQS). */
export function recordTransactionMetrics(
  metrics: MetricsService,
  kind: WagerTransactionKind | string,
  result: SubmitWagerTransactionResult,
): void {
  metrics.transactionsTotal.labels(kind, result.status).inc();
  if (result.idempotentReplay) {
    metrics.idempotentReplaysTotal.inc();
  }
}
