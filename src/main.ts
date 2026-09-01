import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // SIGTERM: sinal padrão do Docker/Kubernetes ao parar um container.
  // SIGINT: o que o Ctrl+C manda no terminal — sem isso explícito aqui, um
  // Ctrl+C local NUNCA aciona os onModuleDestroy() dos workers (o desligamento
  // ainda seria "limpo" no sentido de não travar, mas silenciosamente puloria
  // o dreno de mensagens em andamento do WagerTransactionsConsumer).
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`Distributed Wagering Processor listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
