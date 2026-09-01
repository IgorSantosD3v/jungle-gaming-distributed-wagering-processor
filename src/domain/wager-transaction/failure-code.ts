/**
 * Taxonomia de códigos de falha — cada código diz ao provedor se ele deve
 * reenviar (retry), corrigir o payload, ou desistir (é definitivo).
 *
 * Convenção de prefixo:
 *  - VALIDATION_*  -> payload/contrato inválido, não reenviar sem corrigir
 *  - BUSINESS_*    -> regra de negócio violada, não reenviar
 *  - REFERENCE_*   -> problema ao resolver a transação referenciada
 *  - CONFLICT_*    -> idempotência
 *  - INFRA_*       -> falha transitória, pode reenviar
 */
export enum FailureCode {
  // Regras de negócio (terminais, não retryable pelo provedor sem mudar o pedido)
  INSUFFICIENT_BALANCE = 'BUSINESS_INSUFFICIENT_BALANCE',
  REVERSAL_WOULD_OVERDRAW = 'BUSINESS_REVERSAL_WOULD_OVERDRAW',
  CURRENCY_MISMATCH = 'BUSINESS_CURRENCY_MISMATCH',
  ALREADY_REVERSED = 'BUSINESS_ALREADY_REVERSED',
  INVALID_REFERENCE_KIND = 'BUSINESS_INVALID_REFERENCE_KIND',
  REFERENCE_SCOPE_MISMATCH = 'BUSINESS_REFERENCE_SCOPE_MISMATCH',
  AMOUNT_MISMATCH_WITH_REFERENCE = 'BUSINESS_AMOUNT_MISMATCH_WITH_REFERENCE',

  // Resolução de referência
  REFERENCE_NOT_FOUND_YET = 'REFERENCE_NOT_FOUND_YET', // estado transitório -> PENDING_REFERENCE
  REFERENCE_NOT_FOUND_TIMEOUT = 'REFERENCE_NOT_FOUND_TIMEOUT', // esgotou tentativas -> REJECTED

  // Idempotência
  IDEMPOTENCY_PAYLOAD_CONFLICT = 'CONFLICT_IDEMPOTENCY_PAYLOAD_MISMATCH',
  WALLET_ALREADY_EXISTS = 'CONFLICT_WALLET_ALREADY_EXISTS',

  // Validação de contrato
  INVALID_PAYLOAD = 'VALIDATION_INVALID_PAYLOAD',

  // Infraestrutura (transitório)
  INFRA_UNAVAILABLE = 'INFRA_TEMPORARILY_UNAVAILABLE',
  INFRA_LOCK_TIMEOUT = 'INFRA_LOCK_TIMEOUT',
}
