import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type GroupBuyAllocationStatus = 'ALLOCATED' | 'DELIVERED' | 'CANCELLED';

@Entity('groupbuy_allocations')
export class GroupBuyAllocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'window_id', type: 'uuid' })
  windowId: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ type: 'int' })
  qty: number;

  @Column({ name: 'unit_tier_price', type: 'numeric', precision: 10, scale: 2 })
  unitTierPrice: string;

  @Column({ name: 'delivery_share', type: 'numeric', precision: 10, scale: 2 })
  deliveryShare: string;

  @Column({ name: 'landed_cost', type: 'numeric', precision: 10, scale: 2 })
  landedCost: string;

  @Column({ type: 'varchar', length: 20, default: 'ALLOCATED' })
  status: GroupBuyAllocationStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
