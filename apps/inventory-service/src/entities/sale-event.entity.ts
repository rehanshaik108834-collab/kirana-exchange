import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('sales_events')
export class SaleEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @Column({ type: 'int' })
  qty: number;

  // Set explicitly by the service (device time for offline sales, bounded), not by insert time.
  @Column({ name: 'sold_at', type: 'timestamptz', default: () => 'NOW()' })
  soldAt: Date;

  @Column({ name: 'stockout_flag', type: 'boolean', default: false })
  stockoutFlag: boolean;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;
}
