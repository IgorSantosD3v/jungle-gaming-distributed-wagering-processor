import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { SubmitWagerTransactionDto } from './dto/wager-transaction.dto';
import { Money } from '../../domain/money/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction';
import { submitWagerTransaction, SubmitWagerTransactionResult } from '../../application/wagering/submit-wager-transaction.use-case';
import { getWagerTransactionById, getWagerTransactionByExternalId } from '../../application/wagering/get-wager-transaction.use-case';
import { AuthGuard } from '../../common/auth/auth.guard';
import { MetricsService } from '../../infra/observability/metrics.service';
import { recordTransactionMetrics } from '../../infra/observability/record-transaction-metrics';

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({ code: 'VALIDATION_INVALID_PAYLOAD', message: 'Idempotency-Key header is required' });
    }

    const startedAt = process.hrtime.bigint();
    let result: SubmitWagerTransactionResult;
    try {
      result = await this.dataSource.transaction((manager) =>
        submitWagerTransaction(manager, {
          idempotencyKey,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          playerId: dto.playerId,
          walletId: dto.walletId,
          roundId: dto.roundId,
          gameId: dto.gameId,
          kind: dto.kind as unknown as WagerTransactionKind,
          money: Money.from(dto.money),
          referenceExternalTransactionId: dto.referenceExternalTransactionId,
          correlationId: crypto.randomUUID(),
        }),
      );
    } catch (err) {
      if (this.metrics.isDeadlockError(err)) this.metrics.lockConflictsTotal.inc();
      throw err;
    }
    const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    this.metrics.transactionProcessingDurationSeconds.labels(dto.kind).set(elapsedSeconds);
    recordTransactionMetrics(this.metrics, dto.kind, result);

    res.status(httpStatusFor(result));
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    };
  }

  @Get('wagering/transactions/:transactionId')
  @HttpCode(HttpStatus.OK)
  async getById(@Param('transactionId') transactionId: string) {
    const tx = await this.dataSource.transaction((manager) => getWagerTransactionById(manager, transactionId));
    return serialize(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @HttpCode(HttpStatus.OK)
  async getByExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    const tx = await this.dataSource.transaction((manager) => getWagerTransactionByExternalId(manager, providerId, externalTransactionId));
    return serialize(tx);
  }
}

/**
 * PROCESSED -> 201 (recurso financeiro criado/aplicado)
 * PENDING_REFERENCE -> 202 (aceito, processamento pendente)
 * REJECTED -> 422 (regra de negócio violada, payload sintaticamente válido)
 * Replay idempotente -> sempre 200, independente do status subjacente.
 */
function httpStatusFor(result: SubmitWagerTransactionResult): number {
  if (result.idempotentReplay) return HttpStatus.OK;
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.CREATED;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    default:
      return HttpStatus.OK;
  }
}

function serialize(tx: { id: string; status: string; money: Money; failureCode?: string; referenceTransactionId?: string; processedAt?: Date }) {
  return {
    transactionId: tx.id,
    status: tx.status,
    money: tx.money.toJSON(),
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt?.toISOString(),
  };
}
