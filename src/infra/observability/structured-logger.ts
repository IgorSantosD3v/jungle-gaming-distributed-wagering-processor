import { LoggerService } from '@nestjs/common';

/**
 * Campos padronizados que a seção 12 do desafio exige em todo log relevante:
 * correlationId, messageId, transactionId, walletId, providerId. Nenhum campo é
 * obrigatório em toda chamada — só os que fizerem sentido para aquele evento.
 */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  event?: string;
  [key: string]: unknown;
}

/**
 * Campos que NUNCA são escritos no log, mesmo se alguém passar por engano —
 * "sem dados sensíveis ou payloads financeiros completos nos logs" (seção 12).
 * Isso cobre tanto objetos estruturados passados por nós quanto o `exception`
 * bruto de erros do driver do Postgres (que inclui `parameters` com valores
 * reais da query, incluindo dinheiro).
 */
const REDACTED_KEYS = new Set([
  'money',
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'payload',
  'parameters',
  'query',
  'body',
]);
const REDACTED_PLACEHOLDER = '[REDACTED]';

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k) ? REDACTED_PLACEHOLDER : redact(v, depth + 1);
  }
  return out;
}

/**
 * Cada linha de log é um único objeto JSON — não texto livre. Registrado como o
 * logger da aplicação inteira em main.ts (NestFactory.create(..., { logger })),
 * o que faz TODO `new Logger(contexto)` usado em qualquer arquivo (controllers,
 * workers, o bootstrap do próprio Nest) passar por aqui automaticamente.
 */
export class StructuredLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  private write(level: string, message: unknown, context?: string, trace?: string): void {
    const line: Record<string, unknown> = {
      level,
      timestamp: new Date().toISOString(),
    };
    if (context) line.context = context;

    if (typeof message === 'string') {
      line.message = message;
    } else {
      Object.assign(line, redact(message) as Record<string, unknown>);
    }
    if (trace) line.trace = trace;

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  }
}
