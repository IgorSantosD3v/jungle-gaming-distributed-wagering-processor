import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateWalletDto, LedgerQueryDto } from './dto/wallet.dto';
import { Money } from '../../domain/money/money';
import { createWallet } from '../../application/wallets/create-wallet.use-case';
import { getWallet, getWalletLedger } from '../../application/wallets/get-wallet.use-case';
import { reconcileWallet } from '../../application/wallets/reconciliation.use-case';
import { AuthGuard } from '../../common/auth/auth.guard';
import { MetricsService } from '../../infra/observability/metrics.service';

const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateWalletDto) {
    const initialBalance = dto.initialBalance ? Money.from(dto.initialBalance) : Money.zero('BRL');
    let result;
    try {
      result = await this.dataSource.transaction((manager) =>
        createWallet(manager, { playerId: dto.playerId, initialBalance, correlationId: crypto.randomUUID() }),
      );
    } catch (err) {
      if (this.metrics.isDeadlockError(err)) this.metrics.lockConflictsTotal.inc();
      throw err;
    }
    // A abertura (OPENING) é uma WagerTransaction PROCESSED como qualquer outra —
    // conta na mesma métrica que as transações submetidas via /wagering/transactions,
    // pra "transações por status" (seção 12) refletir o sistema inteiro, não só a fila.
    if (initialBalance.isPositive()) {
      this.metrics.transactionsTotal.labels('OPENING', 'PROCESSED').inc();
    }
    return result;
  }

  @Get(':walletId')
  async getOne(@Param('walletId') walletId: string) {
    const wallet = await this.dataSource.transaction((manager) => getWallet(manager, walletId));
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  @Get(':walletId/ledger')
  async getLedger(@Param('walletId') walletId: string, @Query() query: LedgerQueryDto) {
    const limit = Math.min(query.limit ? Number(query.limit) : DEFAULT_LEDGER_LIMIT, MAX_LEDGER_LIMIT);
    const page = await this.dataSource.transaction((manager) => getWalletLedger(manager, walletId, limit, query.cursor));
    return {
      entries: page.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    return this.dataSource.transaction((manager) => reconcileWallet(manager, walletId));
  }
}
