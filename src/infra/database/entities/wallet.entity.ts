import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Mapeamento de persistência da Wallet. `balance` é armazenado como NUMERIC(18,2) —
 * nunca float/double — e reidratado como Decimal via decimal.js na camada de domínio.
 * A constraint de unicidade (player_id, currency) e o CHECK balance >= 0 estão na
 * migration, não apenas aqui (ver seção "Restrições invioláveis" do desafio).
 */
@Entity({ name: 'wallets' })
@Index('uq_wallets_player_currency', ['playerId', 'currency'], { unique: true })
export class WalletEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  balance!: string;

  // Gerenciado manualmente pelo aggregate Wallet (incrementa só quando o saldo muda).
  // Não usa @VersionColumn do TypeORM porque a concorrência real é garantida por
  // SELECT ... FOR UPDATE explícito, não por optimistic locking automático.
  @Column({ type: 'integer', default: 1 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
