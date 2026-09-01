#!/bin/sh
set -e

echo "Creating SQS queues in LocalStack..."

# ---------------------------------------------------------------------------
# Fila de ENTRADA: provedores de jogos enviam pedidos de transação aqui.
# Consumida por WagerTransactionsConsumer.
# ---------------------------------------------------------------------------
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

echo "DLQ ARN: $DLQ_ARN"

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=30

# RedrivePolicy é um JSON dentro de outro JSON (o valor do atributo é uma STRING que
# contém JSON). Passar isso via um arquivo evita por completo o parser de atalho
# "Key=Value,Key2=Value2" do AWS CLI, que quebra ao ver as vírgulas internas do
# RedrivePolicy e tenta interpretá-las como novos pares.
cat > /tmp/redrive-policy.json <<EOF
{
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
}
EOF

# maxReceiveCount=5: depois de 5 tentativas sem ack, a mensagem vai para a DLQ.
awslocal sqs set-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --attributes file:///tmp/redrive-policy.json

# ---------------------------------------------------------------------------
# Fila de SAÍDA: eventos de domínio publicados por nós (WagerTransactionProcessed,
# WagerTransactionRejected, WalletBalanceChanged, WagerTransactionPendingReference)
# via OutboxPublisherWorker (seção 11 do desafio). SEPARADA da fila de entrada
# de propósito — publicar e consumir na mesma fila criaria um loop em que nossos
# próprios eventos de saída seriam recebidos de volta como se fossem pedidos de
# entrada. Nenhum consumidor nosso lê esta fila; ela existe para quem quiser
# assinar as notificações do sistema (ex.: um serviço de relatórios).
# ---------------------------------------------------------------------------
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS queues ready:"
echo "  wager-transactions.fifo (entrada) -> wager-transactions-dlq.fifo"
echo "  wager-events.fifo (saída, eventos de domínio)"
