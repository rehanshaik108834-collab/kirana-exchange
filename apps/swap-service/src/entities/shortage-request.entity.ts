import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type ShortageRequestStatus = 'OPEN' | 'MATCHED' | 'FULFILLED' | 'EXPIRED';

@Entity('shortage_requests')
export class ShortageRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ type: 'varchar', length: 64 })
  state: string;

  @Column({ name: 'reorder_qty', type: 'int' })
  reorderQty: number;

  @Column({ name: 'max_unit_price', type: 'numeric', precision: 10, scale: 2, nullable: true })
  maxUnitPrice: string | null;

  @Column({ type: 'varchar', length: 20, default: 'OPEN' })
  status: ShortageRequestStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
