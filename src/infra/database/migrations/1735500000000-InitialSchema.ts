import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1735500000000 implements MigrationInterface {
  name = 'InitialSchema1735500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ---------------------------------------------------------------------
    // wallets
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE wallets (
        id           UUID PRIMARY KEY,
        player_id    UUID NOT NULL,
        currency     CHAR(3) NOT NULL,
        balance      NUMERIC(18,2) NOT NULL,
        version      INTEGER NOT NULL DEFAULT 1,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        -- Invariante "saldo nunca negativo" garantida pelo próprio banco, não só pela aplicação.
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1)
      );
    `);

    // ---------------------------------------------------------------------
    // wager_transactions
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE wager_transactions (
        id                                UUID PRIMARY KEY,
        provider_id                       VARCHAR NOT NULL,
        external_transaction_id           VARCHAR NOT NULL,
        idempotency_key                   VARCHAR NOT NULL,
        payload_hash                      VARCHAR NOT NULL,
        wallet_id                         UUID NOT NULL REFERENCES wallets(id),
        player_id                         UUID NOT NULL,
        round_id                          VARCHAR NOT NULL,
        game_id                           VARCHAR NOT NULL,
        kind                              VARCHAR NOT NULL
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
        currency                          CHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR,
        reference_transaction_id          UUID REFERENCES wager_transactions(id),
        status                            VARCHAR NOT NULL
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      VARCHAR,
        reference_attempts                INTEGER NOT NULL DEFAULT 0,
        next_reference_attempt_at         TIMESTAMPTZ,
        created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at                      TIMESTAMPTZ,
        -- Idempotência de negócio: a mesma key nunca pode criar duas linhas.
        CONSTRAINT uq_wagertx_idempotency_key UNIQUE (idempotency_key),
        -- Permite resolver referências por (providerId, externalTransactionId) com garantia de unicidade.
        CONSTRAINT uq_wagertx_provider_external UNIQUE (provider_id, external_transaction_id),
        -- REFUND/ROLLBACK exigem referência; os demais kinds não a usam.
        CONSTRAINT ck_wagertx_reference_required CHECK (
          (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR (kind NOT IN ('REFUND','ROLLBACK'))
        )
      );
      CREATE INDEX ix_wagertx_wallet ON wager_transactions(wallet_id);
      CREATE INDEX ix_wagertx_status ON wager_transactions(status);
      CREATE INDEX ix_wagertx_pending_reference ON wager_transactions(next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);

    // Uma referência não pode ser revertida duas vezes pelo MESMO tipo de operação
    // (ex.: dois REFUND para a mesma BET). Índice parcial único por (reference_transaction_id, kind).
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_wagertx_reference_kind_once
        ON wager_transactions (reference_transaction_id, kind)
        WHERE reference_transaction_id IS NOT NULL AND status = 'PROCESSED';
    `);

    // ---------------------------------------------------------------------
    // wallet_ledger_entries (imutável)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE wallet_ledger_entries (
        id              UUID PRIMARY KEY,
        wallet_id       UUID NOT NULL REFERENCES wallets(id),
        transaction_id  UUID NOT NULL REFERENCES wager_transactions(id),
        direction       VARCHAR NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount          NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
        currency        CHAR(3) NOT NULL,
        balance_before  NUMERIC(18,2) NOT NULL CHECK (balance_before >= 0),
        balance_after   NUMERIC(18,2) NOT NULL CHECK (balance_after >= 0),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- No máximo um lançamento por transação.
        CONSTRAINT uq_ledger_transaction UNIQUE (transaction_id),
        -- Aritmética do lançamento verificada também pelo banco (defesa em profundidade —
        -- a verificação primária é WalletLedgerEntry.create() no domínio).
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
      CREATE INDEX ix_ledger_wallet_created ON wallet_ledger_entries(wallet_id, created_at);
    `);
    // Sem UPDATE/DELETE trigger necessário: nenhum código de aplicação expõe update
    // para esta tabela. Opcoes mais estritas (REVOKE UPDATE, DELETE ON wallet_ledger_entries
    // FROM app_role) sao recomendadas em producao e documentadas no ARCHITECTURE.md.

    // ---------------------------------------------------------------------
    // inbox_messages — deduplicação persistente de mensagens da fila
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE inbox_messages (
        message_id     VARCHAR NOT NULL,
        consumer_name  VARCHAR NOT NULL,
        payload_hash   VARCHAR NOT NULL,
        received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at   TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // ---------------------------------------------------------------------
    // outbox_messages — transactional outbox
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE outbox_messages (
        id               UUID PRIMARY KEY,
        aggregate_id     UUID NOT NULL,
        event_type       VARCHAR NOT NULL,
        payload          JSONB NOT NULL,
        occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempts         INTEGER NOT NULL DEFAULT 0,
        next_attempt_at  TIMESTAMPTZ,
        published_at     TIMESTAMPTZ
      );
      CREATE INDEX ix_outbox_pending ON outbox_messages(next_attempt_at)
        WHERE published_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_messages`);
    await queryRunner.query(`DROP TABLE IF EXISTS inbox_messages`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    await queryRunner.query(`DROP TABLE IF EXISTS wager_transactions`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallets`);
  }
}
