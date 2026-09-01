import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MetricsService } from './metrics.service';

/**
 * GET /metrics — formato texto do Prometheus. Não exige autenticação, assim como
 * os endpoints de health (mesma categoria: diagnóstico operacional).
 *
 * `outbox_lag_seconds` e `sqs_dlq_depth` são recalculados a cada scrape, não
 * mantidos por um loop em background — evita um poll contínuo só para métricas
 * que ninguém está olhando entre um scrape e outro.
 */
@Controller('metrics')
export class MetricsController {
  private readonly sqs: SQSClient;

  constructor(
    private readonly metrics: MetricsService,
    private readonly dataSource: DataSource,
  ) {
    this.sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT, region: process.env.AWS_REGION ?? 'us-east-1' });
  }

  @Get()
  async getMetrics(@Res() res: Response): Promise<void> {
    await this.refreshExternalGauges();
    res.set('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }

  private async refreshExternalGauges(): Promise<void> {
    try {
      const rows: Array<{ lag_seconds: number | null }> = await this.dataSource.query(
        `SELECT EXTRACT(EPOCH FROM (now() - min(occurred_at))) AS lag_seconds
           FROM outbox_messages WHERE published_at IS NULL`,
      );
      this.metrics.outboxLagSeconds.set(Number(rows[0]?.lag_seconds ?? 0));
    } catch {
      // Postgres indisponível no momento do scrape — mantém o último valor conhecido
      // em vez de derrubar o endpoint de métricas inteiro.
    }

    const dlqUrl = process.env.SQS_DLQ_URL;
    if (dlqUrl) {
      try {
        const attrs = await this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
        );
        this.metrics.dlqDepth.set(Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0));
      } catch {
        // LocalStack/SQS indisponível — idem, mantém o último valor conhecido.
      }
    }
  }
}
