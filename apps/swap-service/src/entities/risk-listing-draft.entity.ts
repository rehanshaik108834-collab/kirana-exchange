import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('risk_listing_drafts')
export class RiskListingDraft {
  @PrimaryColumn({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'risk_type', type: 'varchar', length: 20 })
  riskType: string;

  @Column({ name: 'days_of_cover', type: 'numeric', precision: 8, scale: 2 })
  daysOfCover: string;

  @Column({ name: 'expected_unsold_qty', type: 'int', default: 1 })
  expectedUnsoldQty: number;

  @Column({ name: 'recommended_action', type: 'varchar', length: 32 })
  recommendedAction: string;

  @Column({ type: 'boolean', default: false })
  dismissed: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
