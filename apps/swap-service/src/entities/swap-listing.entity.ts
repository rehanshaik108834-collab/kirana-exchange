import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type SwapListingStatus = 'OPEN' | 'RESERVED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

@Entity('swap_listings')
export class SwapListing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ name: 'batch_id', type: 'uuid', unique: true })
  batchId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ type: 'varchar', length: 64 })
  state: string;

  @Column({ type: 'int' })
  qty: number;

  @Column({ name: 'cost_price', type: 'numeric', precision: 10, scale: 2 })
  costPrice: string;

  @Column({ name: 'suggested_price', type: 'numeric', precision: 10, scale: 2 })
  suggestedPrice: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  price: string;

  @Column({ name: 'batch_expiry_date', type: 'date' })
  batchExpiryDate: string;

  @Column({ type: 'varchar', length: 20, default: 'OPEN' })
  status: SwapListingStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
