import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity('inventory_batches')
export class InventoryBatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'batch_code', length: 64 })
  batchCode: string;

  @Column({ type: 'int' })
  qty: number;

  @Column({ name: 'reserved_qty', type: 'int', default: 0 })
  reservedQty: number;

  @Column({ name: 'cost_price', type: 'numeric', precision: 10, scale: 2 })
  costPrice: string;

  @Column({ name: 'expiry_date', type: 'date' })
  expiryDate: string;

  @Column({ name: 'days_of_cover', type: 'numeric', precision: 8, scale: 2, nullable: true })
  daysOfCover: string | null;

  @VersionColumn({ type: 'int', default: 1 })
  version: number;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
