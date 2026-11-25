import { Column, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('groupbuy_commitments')
export class GroupBuyCommitment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'window_id', type: 'uuid' })
  windowId: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ type: 'int' })
  qty: number;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
