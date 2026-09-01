import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { MoneyDto } from './money.dto';
import { WagerTransactionKind } from '../../../domain/wager-transaction/wager-transaction';

/** OPENING é interno e propositalmente excluído deste enum — não pode ser submetido pela API/fila. */
enum SubmittableWagerTransactionKind {
  Bet = WagerTransactionKind.Bet,
  Win = WagerTransactionKind.Win,
  Loss = WagerTransactionKind.Loss,
  Refund = WagerTransactionKind.Refund,
  Rollback = WagerTransactionKind.Rollback,
}

export class SubmitWagerTransactionDto {
  @IsString()
  providerId!: string;

  @IsString()
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  roundId!: string;

  @IsString()
  gameId!: string;

  @IsEnum(SubmittableWagerTransactionKind)
  kind!: SubmittableWagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}
