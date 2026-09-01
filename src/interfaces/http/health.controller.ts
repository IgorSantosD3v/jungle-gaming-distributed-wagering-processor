import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

/** Endpoints de health não exigem autenticação (seção 2). */
@Controller('health')
export class HealthController {
  private readonly sqs: SQSClient;

  constructor(private readonly dataSource: DataSource) {
    this.sqs = new SQSClient({
      endpoint: process.env.SQS_ENDPOINT,
      region: process.env.AWS_REGION ?? 'us-east-1',
    });
  }

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [dbOk, sqsOk] = await Promise.all([this.checkDatabase(), this.checkSqs()]);
    const ready = dbOk && sqsOk;
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'degraded', postgres: dbOk, sqs: sqsOk };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private async checkSqs(): Promise<boolean> {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) return false;
    try {
      await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
      return true;
    } catch {
      return false;
    }
  }
}
