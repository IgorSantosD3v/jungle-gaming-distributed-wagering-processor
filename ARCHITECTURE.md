# ARCHITECTURE.md

## 1. Autenticação (seção 2)

**Decisão: não implementada.** O guard (`AuthGuard`) é um no-op explícito e documentado
em `src/common/auth/auth.guard.ts`. Motivo: autenticação não vale pontos na tabela da
seção 14 e o timebox de 3 dias foi priorizado inteiramente para correção financeira,
concorrência e idempotência — que somam 55 dos 100 pontos e têm falhas eliminatórias.

Desenho que seria adotado em produção: Keycloak como Identity Provider, cada game
provider como um client OIDC com `client_credentials` grant, escopo `wagering:write`
por provider. O `AuthGuard` real validaria o JWT via JWKS do Keycloak e populariam
`request.identity` com o `sub` (= providerId autenticado). O `WageringController`
então validaria que `dto.providerId === request.identity.sub`, impedindo um provider
de submeter transações em nome de outro. Os endpoints `/health/*` continuariam
abertos.

## 2. Concorrência (seção 8)

**Decisão: locking pessimista (`SELECT ... FOR UPDATE`) na linha da wallet, dentro de
uma transação SQL real, não optimistic locking com retry.**

Por quê: a unidade de concorrência é a `walletId`. Com `FOR UPDATE`, a segunda
transação que tentar tocar a mesma wallet simplesmente **espera** (bloqueia) até a
primeira commitar ou dar rollback — não há corrida para perder, não há "lost update"
possível, e não precisa de lógica de retry com backoff no caminho crítico (que optimistic
locking exigiria). O custo é serialização por wallet (uma wallet "quente" processa uma
transação de cada vez), o que é aceitável porque **wallets diferentes continuam
paralelas** (locks são por linha, não globais — a restrição "não usar lock global
compartilhado por todas as wallets" da seção 5 é respeitada).

O campo `wallet.version` continua existindo e é incrementado no aggregate a cada
mudança de saldo, mas é **auditoria/API**, não o mecanismo de concorrência em si —
por isso não é um `@VersionColumn` do TypeORM (que implementaria optimistic locking
automático, que não é a estratégia escolhida).

**Decisão explícita:** o crédito de abertura (`initialBalance` em `POST /wallets`)
**não** conta como uma mutação para efeito de `version` — a wallet nasce
diretamente com `version: 1` e o saldo já aplicado, em vez de "nascer em zero e
depois ser creditada" (o que bateria a version para 2). Isso segue o próprio
exemplo de resposta do desafio (seção 9), que mostra `"version": 1` mesmo com
`initialBalance` de `1000.00`. A transação `OPENING` e o lançamento de ledger
correspondente (`balanceBefore: 0.00 -> balanceAfter: <saldo inicial>`) continuam
gravados normalmente para auditoria — só a `version` do aggregate não conta essa
abertura como uma mutação separada.

Idempotência de negócio (a mesma `idempotency_key` nunca cria duas linhas) usa
`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` (não uma constraint `UNIQUE`
"crua" capturada via exceção — ver §2.1 abaixo, por quê). Uma colisão simplesmente
não insere nada, sem lançar erro; checamos se o `INSERT` afetou alguma linha para
saber se "ganhamos" o direito de processar ou se é um replay. Isso é o que garante
que "a mesma aposta enviada 50 vezes em paralelo" produz um único débito mesmo com
50 conexões concorrentes.

**Cenário obrigatório (100.00, duas apostas de 80.00):** coberto em
`test/concurrency/concurrent-bets.spec.ts`. As duas transações competem pelo lock da
wallet; a que chega primeiro debita e chega a 20.00; a segunda, ao adquirir o lock,
vê o saldo já em 20.00 e é rejeitada com `INSUFFICIENT_BALANCE`.

### 2.1 Bug real encontrado e corrigido durante os testes de concorrência: ordem de lock errada causava deadlock

A primeira versão do código fazia o `INSERT` da `wager_transaction` **antes** do
`SELECT ... FOR UPDATE` na wallet. Isso é sutilmente errado: um `INSERT` numa tabela
com uma chave estrangeira (`wager_transactions.wallet_id REFERENCES wallets(id)`) já
adquire, implicitamente, um lock de leitura (`FOR KEY SHARE`) na linha da wallet
referenciada, só para garantir que ela não seja apagada por outra transação
enquanto a FK aponta pra ela.

Sob concorrência real na mesma wallet, isso produzia um deadlock clássico: duas
transações pegavam esse lock de leitura implícito ao mesmo tempo (compatível entre
si — locks de leitura não conflitam), e depois cada uma tentava adquirir o lock
exclusivo (`FOR UPDATE`) explícito, esperando a outra soltar o lock de leitura
primeiro. As duas ficavam esperando uma pela outra — o Postgres detectou
(`error: deadlock detected`, code `40P01`) e abortou uma delas.

Um segundo problema, relacionado: quando o `INSERT` batia numa `idempotency_key`
duplicada (uma constraint `UNIQUE` "crua"), o Postgres lançava um erro real, o que
marca a transação inteira como abortada no lado do banco — qualquer `SELECT`
seguinte na mesma transação falhava com `current transaction is aborted` (code
`25P02`), mesmo com o erro original já "tratado" no `catch` do JavaScript.

**A correção, registrada no código:** (1) sempre travar a wallet com
`FOR UPDATE` **antes** de qualquer `INSERT` que a referencie via FK — assim cada
transação disputa um único lock por vez, sempre na mesma ordem, o que elimina a
possibilidade de deadlock por definição; (2) trocar o `INSERT` capturado via
try/catch por `INSERT ... ON CONFLICT DO NOTHING`, que nunca lança um erro real do
banco para o caso esperado de colisão de idempotência. Essa combinação foi
encontrada e corrigida rodando `test/concurrency` de verdade contra um PostgreSQL
real — é exatamente o tipo de bug que testes com mock de banco nunca pegariam, e é
parte do motivo pelo qual o desafio proíbe isso como falha eliminatória.

Um terceiro problema apareceu na primeira tentativa de correção: o `INSERT ...
ON CONFLICT DO NOTHING` foi implementado via `InsertQueryBuilder` do TypeORM, e o
código checava `insertResult.identifiers.length > 0` para saber se a linha tinha
sido realmente inserida. Isso é confiável quando o banco gera a chave primária
(`SERIAL`, `gen_random_uuid()` como default), mas **não** quando ela é fornecida
pela aplicação — que é o nosso caso (`id: uuid()` gerado em JavaScript). Nesse
cenário, o TypeORM apenas ecoa de volta o valor que foi passado em `.values(...)`,
sem checar se o `ON CONFLICT DO NOTHING` de fato descartou a linha. `owns` dava
`true` mesmo em conflito genuíno, e o código seguia tentando processar uma
transação cujo `id` nunca chegou a existir na tabela — o que aparecia mais adiante
como uma violação de chave estrangeira ao gravar o lançamento no ledger, e como um
teste de conflito de idempotência que deveria falhar e não falhava. A correção
final usa SQL puro com `RETURNING id` (`manager.query(...)`) em vez do query
builder: `RETURNING` só devolve as linhas que o Postgres de fato gravou, sem
ambiguidade nenhuma.

## 3. Idempotência

Duas camadas independentes, cada uma resolvendo um problema diferente:

1. **Idempotência de negócio** — `UNIQUE(idempotency_key)` em `wager_transactions`,
   aplicada via `INSERT ... ON CONFLICT DO NOTHING` (ver §2.1 — nunca via exceção
   capturada de uma violação de constraint crua). Fonte da verdade: o header
   `Idempotency-Key`. `payloadHash` é um SHA-256 de um JSON canônico (chaves
   ordenadas) do subconjunto de campos de negócio — nunca do header nem de
   metadados de transporte (ver `src/common/idempotency/payload-hash.ts`). Mesma
   key + mesmo hash = replay (`idempotentReplay: true`, mesmo resultado). Mesma
   key + hash diferente = conflito (409), nunca tratado como replay.

2. **Deduplicação de transporte** — `UNIQUE(consumer_name, message_id)` em
   `inbox_messages`. Resolve um problema diferente: o SQS pode entregar a **mesma
   mensagem física** mais de uma vez (at-least-once) mesmo que o conteúdo de negócio
   seja idêntico. O inbox garante que o *efeito de processar aquela entrega específica*
   não se repete, independentemente da idempotência de negócio (que também protegeria,
   mas o inbox evita até reprocessar a checagem).

Repetir uma operação já `PROCESSED` retorna o saldo **observado no momento original**
(lido do `balanceAfter` do lançamento de ledger daquela transação), não o saldo atual
da wallet — que pode ter mudado por outras transações desde então. Para transações que
nunca afetaram o saldo (`LOSS`, `REJECTED`, `PENDING_REFERENCE`), não há lançamento
histórico para consultar; como essas nunca moveram o saldo, o saldo atual da wallet é
usado como equivalente — uma simplificação documentada aqui, não escondida.

## 4. Money e precisão

`Money` (`src/domain/money/money.ts`) nunca usa `number`/`float`/`double`. Internamente
usa `Decimal` (decimal.js); externamente, sempre string decimal com escala fixa de 2
casas. Persistido em colunas `NUMERIC(18,2)` — nunca `FLOAT`/`DOUBLE PRECISION`.

Entradas de contrato (HTTP/fila) são **mais estritas** que o Value Object: o DTO
(`MoneyDto`) rejeita valores negativos (a direção do movimento vem do `kind`, não do
sinal), enquanto `Money` internamente aceita negativos porque o domínio precisa deles
(ex.: `negate()`, deltas de reversão calculados em memória antes de virar um
lançamento sempre não-negativo no ledger).

## 5. ORM e mapeamento

**Decisão: TypeORM** (não MikroORM). Ambos são aceitos pelo desafio; TypeORM foi
escolhido por: (a) controle explícito e simples de `EntityManager.transaction()` com
lock mode `pessimistic_write`, que é exatamente o primitivo que a estratégia de
concorrência escolhida (seção 2 acima) precisa; (b) suporte direto a SQL cru dentro da
mesma transação (`manager.query(...)`) para o `SELECT ... FOR UPDATE SKIP LOCKED` do
publicador da outbox, sem cerimônia adicional.

O domínio (`src/domain/**`) não importa nada de `typeorm` — os mappers em
`src/infra/database/mappers.ts` são a única ponte entre entidade e objeto de domínio,
via `rehydrate()`/getters, nunca expondo os construtores privados do domínio para a
camada de infraestrutura.

## 6. Transactional Outbox

Escrita do evento na tabela `outbox_messages` acontece **na mesma transação SQL** que
a mutação financeira (`src/infra/messaging/outbox-writer.ts`, chamado de dentro do
`EntityManager` da transação do caso de uso) — nunca há uma janela em que o saldo já
mudou mas o evento "não existe ainda" de forma durável.

**Fila de saída separada da fila de entrada.** `WagerTransactionsConsumer` escuta
`wager-transactions.fifo` (`SQS_QUEUE_URL`) para receber pedidos de transação dos
provedores. `OutboxPublisherWorker` publica os eventos de domínio
(`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`,
`WagerTransactionPendingReference`) numa fila **diferente**, `wager-events.fifo`
(`SQS_EVENTS_QUEUE_URL`). Isso não é incidental: publicar e consumir na mesma fila
criaria um loop em que os próprios eventos de saída do sistema seriam recebidos de
volta pelo consumidor como se fossem novos pedidos de aposta — um bug real que
apareceu durante os testes manuais deste projeto (o consumidor tentava extrair um
`messageId` de um envelope de evento, que não tem esse campo, e violava a
constraint `NOT NULL` de `inbox_messages`). `wager-events.fifo` existe para quem
quiser assinar as notificações do sistema (ex.: um serviço de relatórios ou
auditoria) — nenhum componente deste próprio serviço a consome.

O `OutboxPublisherWorker` roda em loop, pega lotes com
`SELECT ... FOR UPDATE SKIP LOCKED` (permite múltiplos publishers/instâncias
concorrentes sem duplicar trabalho nem se bloquearem), publica no SQS e marca
`published_at`. Se o processo morre entre o commit financeiro e a publicação, outra
instância (ou a mesma, ao reiniciar) simplesmente encontra a linha ainda com
`published_at IS NULL` e publica. Uma publicação duplicada (ex.: crash entre o SQS
confirmar o envio e o `UPDATE` marcar `published_at`) é seguro porque o consumidor é
idempotente (idempotency_key + inbox).

## 6.1 Bugs reais encontrados na revisão final deste projeto

Até uma revisão final, o caminho de código que resolve referências (REFUND,
ROLLBACK, e o WIN opcional) nunca tinha sido exercitado de ponta a ponta por
um teste — só o caminho "referência ainda não existe" (`PENDING_REFERENCE`)
tinha cobertura. Escrever `test/integration/business-rules.spec.ts` para
fechar esse gap revelou dois bugs reais:

1. **Checagem de valor aplicada ao WIN por engano.** A regra "o valor deve
   ser igual ao valor da referência" (seção 7) é só para REFUND/ROLLBACK, mas
   estava sendo aplicada a qualquer transação com referência, inclusive WIN —
   que normalmente tem um valor diferente da BET que referencia (o prêmio
   quase nunca é igual ao valor apostado). Corrigido restringindo a exigência
   a `kind === REFUND || kind === ROLLBACK`.

2. **O consumidor SQS não validava o `kind` da mensagem.** A API já bloqueava
   `OPENING` via `@IsEnum` no DTO, mas `processIncomingMessage` (o caminho da
   fila) aceitava qualquer string em `data.kind` sem checagem. Uma mensagem
   com `"kind": "OPENING"` chegaria em `submitWagerTransaction` e, por não
   ser `"BET"`, cairia no branch de `credit()` em `applyDirectMutation` —
   creditando a wallet sem nenhum débito correspondente, uma violação direta
   de "OPENING é interno: não pode ser submetido pela API nem pela fila"
   (seção 6.3). Corrigido com uma validação explícita logo no início de
   `processIncomingMessage`: qualquer `kind` fora de
   `{BET, WIN, LOSS, REFUND, ROLLBACK}` — incluindo `OPENING` — vai direto
   para `dead_letter`, sem tocar no banco. Testado em
   `test/integration/consumer-crash-recovery.spec.ts`
   ("kind OPENING ... NEVER credits the wallet").

## 7. Referências fora de ordem (seção 7.1)

Quando REFUND/ROLLBACK chega antes da transação que referencia, a transação fica
`PENDING_REFERENCE` e nenhuma mutação de saldo acontece. O `PendingReferenceWorker`
reprocessa periodicamente (backoff exponencial, base 3s, teto 120s), reutilizando o
mesmo `submitWagerTransaction` usado pela API/fila — não existe um caminho de código
separado e potencialmente divergente para "resolver referência tardia".

**Limite de tentativas: 8** (constante `MAX_REFERENCE_ATTEMPTS`). Com backoff
`3 * 2^n` capado em 120s, 8 tentativas cobrem pouco mais de 10 minutos de espera total
— tempo considerado suficiente para entregas fora de ordem em um broker at-least-once
real (a desordem esperada é de segundos, não minutos). Esgotado o limite, a transação
vira `REJECTED` com `REFERENCE_NOT_FOUND_TIMEOUT`, permanecendo auditável (nunca
apagada).

## 7.1 Processamento SQS — três categorias de erro, explicitamente (seção 10)

`WagerTransactionsConsumer` delega a decisão real para `processIncomingMessage`
(`src/infra/messaging/process-incoming-message.ts`), uma função pura testável sem
SQS — só recebe o corpo bruto da mensagem e devolve uma de três ações. O
consumidor (a camada fina que fala com o SQS de verdade) executa o efeito
correspondente:

| Ação | Quando | O que o consumidor faz |
|---|---|---|
| `ack` | Erro de negócio (terminal, ex.: `IdempotencyConflictError`) ou sucesso | `DeleteMessage` — o resultado já está persistido, reenviar não muda nada |
| `retry` | Falha transitória (Postgres fora do ar, timeout de lock, deadlock) | `ChangeMessageVisibility` com backoff real: `5 * 2^tentativa` segundos, capado em 60s — não apenas "esperar o VisibilityTimeout fixo de 30s passar sempre" |
| `dead_letter` | Erro permanente — JSON inválido, campos obrigatórios ausentes | `SendMessage` direto para `SQS_DLQ_URL` + `DeleteMessage` da fila principal — **imediato**, não esperamos o `maxReceiveCount` do SQS esgotar sozinho para um payload que já sabemos, de cara, que nunca vai processar |

Essa terceira via (dead-letter imediata pelo próprio código) é uma mudança
deliberada em relação a uma versão anterior deste projeto, que deixava até
payloads malformados serem redescobertos e reentregues pelo SQS até o
`maxReceiveCount` (5 tentativas, ~2-3 minutos) esgotar sozinho antes de cair na
DLQ via redrive policy. Isso ainda funciona como rede de segurança (a redrive
policy continua configurada em `docker/localstack-init.sh`), mas agora é a
exceção, não o caminho principal — mensagens que sabemos ser irrecuperáveis são
identificadas e roteadas em milissegundos, não minutos.

`processIncomingMessage` é o que torna testável, sem mocks de SQS, o cenário
"worker morto depois do commit e antes do ack" (seção 13): chamar a função duas
vezes com o EXATO mesmo corpo de mensagem simula precisamente uma redelivery —
ver `test/integration/consumer-crash-recovery.spec.ts`.

## 8. Taxonomia de failure codes

Ver `src/domain/wager-transaction/failure-code.ts`. Convenção de prefixo
(`BUSINESS_*`, `VALIDATION_*`, `CONFLICT_*`, `INFRA_*`, `REFERENCE_*`) permite ao
provedor decidir mecanicamente se deve reenviar. Dois códigos merecem destaque por
serem exigidos explicitamente pelo desafio como **distintos** apesar de ambos serem
"saldo insuficiente" na causa raiz:

- `INSUFFICIENT_BALANCE` — uma aposta (BET) comum sem saldo.
- `REVERSAL_WOULD_OVERDRAW` — uma reversão (ROLLBACK/REFUND) que deixaria o saldo
  negativo. Operacionalmente diferente: geralmente indica que o jogador já gastou o
  dinheiro que estava sendo revertido em outra coisa, um cenário que o time de
  operações trata de forma distinta de uma aposta simplesmente recusada.

## 9. Mapeamento de status HTTP

| Situação | HTTP |
|---|---|
| Payload sintaticamente inválido (DTO) | 400 |
| `Idempotency-Key` ausente | 400 |
| Conflito de idempotência (mesma key, payload diferente) | 409 |
| Wallet duplicada (mesmo player+currency) | 409 |
| Replay idempotente (qualquer status subjacente) | 200 |
| `PROCESSED` (primeira vez) | 201 |
| `PENDING_REFERENCE` (primeira vez) | 202 |
| `REJECTED` (regra de negócio) | 422 |
| Recurso não encontrado (wallet/transação) | 404 |
| Erro não mapeado / infraestrutura fora do ar | 503 |

Ver `src/interfaces/http/domain-exception.filter.ts` e
`WageringController#httpStatusFor`.

## 10. Observabilidade

**Logs estruturados (JSON)** — `StructuredLogger`
(`src/infra/observability/structured-logger.ts`), registrado como o logger da
aplicação inteira em `main.ts`. Cada linha de log é um único objeto JSON, não
texto livre; isso vale automaticamente para todo `new Logger(contexto)` usado em
qualquer arquivo, incluindo o próprio bootstrap do Nest. Nos pontos de negócio
(controller de wagering, consumidor SQS, os dois workers), os logs carregam os
campos padronizados exigidos pela seção 12 quando fazem sentido para aquele
evento: `correlationId`, `messageId` (via `context` do evento), `transactionId`,
`walletId`, `providerId`. Nenhum log inclui o valor monetário em si nem o
payload financeiro completo — `StructuredLogger` redige automaticamente chaves
como `money`, `amount`, `balance`, `payload`, `parameters` e `query` (essa
última é o que impediria, por exemplo, que um erro bruto do driver do Postgres
vazasse a query SQL completa com os valores reais nos logs).

**Métricas Prometheus** (`GET /metrics`, formato texto padrão, sem autenticação —
mesma categoria dos health checks) via `prom-client`, centralizadas em
`MetricsService` (`src/infra/observability/`):

| Métrica | Tipo | O que mede |
|---|---|---|
| `wager_transactions_total{kind,status}` | Counter | Transações processadas, por tipo e status final |
| `wager_idempotent_replays_total` | Counter | Duplicatas de negócio detectadas (replay) |
| `wager_pending_reference_retries_total` | Counter | Tentativas de reprocessamento de `PENDING_REFERENCE` |
| `wager_pending_reference_timeouts_total` | Counter | Transações rejeitadas por esgotar o limite de tentativas de referência |
| `outbox_published_total` | Counter | Eventos publicados com sucesso |
| `outbox_publish_retries_total` | Counter | Falhas de publicação que geraram retry agendado |
| `outbox_lag_seconds` | Gauge | Idade do evento pendente mais antigo na outbox |
| `wallet_lock_conflicts_total` | Counter | Deadlocks detectados pelo Postgres (SQLSTATE `40P01`) |
| `sqs_redeliveries_total` | Counter | Mensagens SQS não confirmadas, deixadas para reentrega (categoria `retry`) |
| `sqs_dlq_depth` | Gauge | Profundidade aproximada da dead-letter queue |
| `wager_transaction_processing_duration_seconds{kind}` | Gauge | Latência da última chamada a `submitWagerTransaction` no endpoint HTTP |
| `wallet_reconciliation_divergences_total` | Counter | Divergências encontradas entre saldo materializado e saldo reconstruído pelo ledger (deveria ficar sempre em zero — ver `POST /wallets/:id/reconciliation`) |

`outbox_lag_seconds` e `sqs_dlq_depth` são recalculadas a cada scrape do
`/metrics` (consulta ao Postgres e ao SQS no momento da requisição), não por um
loop de background separado — evita manter mais um poll contínuo só para números
que ninguém está olhando entre um scrape e outro.

Health checks (`/health/live`, `/health/ready`) permanecem como estavam,
separados de liveness/readiness.

## 11. Limitações conhecidas / próximos passos

- **OpenTelemetry**: não implementado (opcional pelo desafio) — as métricas
  Prometheus (§10) cobrem o essencial de diagnóstico sem a complexidade de tracing
  distribuído, que não se justificava para o escopo de um único serviço.
- **Ledger de partidas dobradas (double-entry)**: não implementado (diferencial
  opcional explícito no desafio — o ledger atual é single-entry por wallet, que
  satisfaz todas as invariantes exigidas).
- **Reversão parcial**: fora de escopo, conforme o próprio desafio define.
- **`REVOKE UPDATE/DELETE ON wallet_ledger_entries`**: recomendado para produção
  (defesa em profundidade no nível de permissão do banco), não aplicado na migration
  para não complicar o setup local do avaliador — a imutabilidade real vem de nenhum
  código de aplicação expor um caminho de update para essa tabela.
- **Teste de carga** (`bun run test:load`): não implementado — diferencial opcional.

## 12. Testes que fecham cenários específicos da seção 13

Além dos arquivos já descritos no README, quatro specs cobrem cenários exigidos
pela seção 13 que exigiram extrair lógica de negócio para funções puras
testáveis, fora dos workers do NestJS:

- `test/integration/business-rules.spec.ts` — a tabela de regras de negócio da
  seção 7 (BET/WIN/LOSS/REFUND/ROLLBACK) de ponta a ponta contra Postgres real:
  o caminho feliz de cada operação, as rejeições esperadas (referência do tipo
  errado, valor divergente, reversão duplicada, escopo diferente,
  `REVERSAL_WOULD_OVERDRAW`), e a invariante final
  `wallet.balance == saldo reconstruído pelo ledger` depois de uma mistura de
  operações. Foi escrevendo este arquivo que o bug do §6.1 foi encontrado.
- `test/integration/consumer-crash-recovery.spec.ts` — "worker morto depois do
  commit e antes do ack", testado chamando `processIncomingMessage` duas vezes
  com o mesmo corpo de mensagem (simula a redelivery que o SQS faria de
  verdade), e confirmando que nenhum efeito financeiro se repete.
- `test/integration/outbox-concurrent-publishers.spec.ts` — "dois publishers
  concorrentes sobre a mesma outbox" (chamando `publishOutboxBatch` duas vezes
  em paralelo) e "reinício do serviço com comprovação da consistência final"
  (processa transações sem publicar, depois "reinicia" com uma instância nova
  do publisher e confirma reconciliação consistente antes e depois).
- `test/concurrency/three-instances.spec.ts` — três (e cinco) processos
  literalmente separados do sistema operacional (via `Bun.spawn`, não apenas
  conexões concorrentes dentro do mesmo processo Bun) disputando a mesma
  wallet, cada um com sua própria conexão independente ao Postgres.
