import { Type } from 'class-transformer';
import { IsDefined, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { MoneyDto } from './money.dto';

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsOptional()
  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance?: MoneyDto;
}

export class LedgerQueryDto {
  @IsOptional()
  cursor?: string;

  @IsOptional()
  limit?: string;
}
