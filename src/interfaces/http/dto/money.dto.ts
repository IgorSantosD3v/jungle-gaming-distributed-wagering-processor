import { IsString, Matches } from 'class-validator';

/**
 * Validação de CONTRATO (borda HTTP/fila) — distinta da validação do Value Object
 * Money. Aqui, além do formato decimal de 2 casas, o contrato de ENTRADA exige
 * valor não-negativo (ver seção 6.1: "valores negativos em contratos de entrada"
 * são rejeitados). O sinal/direção do movimento é expresso pelo `kind`, não pelo
 * valor — Money internamente ainda pode representar negativos (ex.: negate()),
 * mas isso é uso interno do domínio, não de payload externo.
 */
export class MoneyDto {
  @IsString()
  // Exatamente 2 casas decimais, sem notação científica, sem sinal negativo.
  @Matches(/^\d+\.\d{2}$/, { message: 'amount must be a non-negative decimal string with exactly 2 decimal places, e.g. "25.00"' })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO-4217 code, e.g. "BRL"' })
  currency!: string;
}
