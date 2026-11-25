import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ProductTierSchedule } from '../pricing';

export type GroupBuyWindowStatus = 'OPEN' | 'EXTENDED' | 'ALLOCATING' | 'COMPLETED' | 'CANCELLED';

@Entity('groupbuy_windows')
export class GroupBuyWindow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'distributor_id', type: 'varchar', length: 64 })
  distributorId: string;

  @Column({ type: 'varchar', length: 64 })
  state: string;

  @Column({ name: 'cutoff_at', type: 'timestamptz' })
  cutoffAt: Date;

  @Column({ name: 'min_order_value', type: 'numeric', precision: 12, scale: 2 })
  minOrderValue: string;

  @Column({ name: 'delivery_fee', type: 'numeric', precision: 10, scale: 2, default: '0.00' })
  deliveryFee: string;

  @Column({ name: 'price_tiers', type: 'jsonb' })
  priceTiers: ProductTierSchedule[];

  @Column({ name: 'extended_once', type: 'boolean', default: false })
  extendedOnce: boolean;

  @Column({ type: 'varchar', length: 20, default: 'OPEN' })
  status: GroupBuyWindowStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
