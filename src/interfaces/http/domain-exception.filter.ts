import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../../domain/money/money.errors';
import { WalletNotFoundError, WalletAlreadyExistsError, IdempotencyConflictError } from '../../application/wagering/wagering.errors';
import { WagerTransactionNotFoundError } from '../../application/wagering/get-wager-transaction.use-case';

/**
 * A API precisa distinguir com clareza — e de forma consistente entre todos os
 * endpoints — payload inválido (400), conflito de idempotência (409), rejeição de
 * regra de negócio (422, tratado no controller via result.status, não aqui),
 * aceite pendente (202, idem) e falha transitória de infraestrutura (503).
 * Este filtro cobre os erros de domínio/aplicação lançados como exceções.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof WalletNotFoundError || exception instanceof WagerTransactionNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({ code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof WalletAlreadyExistsError || exception instanceof IdempotencyConflictError) {
      response.status(HttpStatus.CONFLICT).json({ code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof DomainError) {
      response.status(HttpStatus.BAD_REQUEST).json({ code: exception.code, message: exception.message });
      return;
    }

    // Erro não mapeado: tratamos como falha transitória de infraestrutura (Postgres/SQS
    // fora do ar, timeout de lock, etc.) — nunca vaza stack trace para o provedor.
    //
    // IMPORTANTE: nunca logamos o objeto `exception` bruto. Um erro do driver do
    // Postgres (QueryFailedError) carrega `.query` e `.parameters` — a query SQL
    // completa com os valores reais, incluindo dinheiro e IDs. Extraímos só
    // `name`/`message`/`stack`, nunca o objeto inteiro.
    const err = exception as { name?: string; message?: string; stack?: string } | undefined;
    this.logger.error(
      { event: 'unhandled_error', errorName: err?.name ?? 'UnknownError', errorMessage: err?.message ?? String(exception) },
      err?.stack,
    );
    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({ code: 'INFRA_TEMPORARILY_UNAVAILABLE', message: 'Temporarily unavailable, please retry.' });
  }
}
