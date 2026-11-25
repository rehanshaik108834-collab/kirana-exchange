import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export type SwapSagaState =
  | 'INITIATED'
  | 'RESERVING_STOCK'
  | 'AWAITING_HANDOVER'
  | 'HANDOVER_CONFIRMED'
  | 'COMMITTING_TRANSFER'
  | 'COMPENSATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'FAILED_NO_STOCK'
  | 'CANCELLED_COMPENSATED';

export const DEFAULT_TAX_DISCLAIMER =
  'Documented intra-state peer sale. Confirm GST treatment with your accountant.';

@Entity('swap_transactions')
export class SwapTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'offer_id', type: 'uuid', unique: true })
  offerId: string;

  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;

  @Column({ name: 'seller_shop_id', type: 'uuid' })
  sellerShopId: string;

  @Column({ name: 'buyer_shop_id', type: 'uuid' })
  buyerShopId: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'shop_state', type: 'varchar', length: 64, default: 'Unknown' })
  shopState: string;

  @Column({ type: 'int' })
  qty: number;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  price: string;

  @Column({ name: 'cost_price', type: 'numeric', precision: 10, scale: 2 })
  costPrice: string;

  @Column({ name: 'expiry_date', type: 'date' })
  expiryDate: string;

  @Column({ type: 'varchar', length: 32 })
  state: SwapSagaState;

  @Column({ name: 'handover_code_hash', type: 'char', length: 64, nullable: true })
  handoverCodeHash: string | null;

  @Column({ name: 'handover_expires_at', type: 'timestamptz', nullable: true })
  handoverExpiresAt: Date | null;

  @Column({ name: 'seller_confirmed_at', type: 'timestamptz', nullable: true })
  sellerConfirmedAt: Date | null;

  @Column({ name: 'buyer_confirmed_at', type: 'timestamptz', nullable: true })
  buyerConfirmedAt: Date | null;

  @Column({ name: 'bill_record_id', type: 'uuid', nullable: true })
  billRecordId: string | null;

  @Column({ name: 'tax_disclaimer', type: 'text', default: DEFAULT_TAX_DISCLAIMER })
  taxDisclaimer: string;

  @Column({ name: 'cancel_reason', type: 'varchar', length: 32, nullable: true })
  cancelReason: string | null;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @VersionColumn({ type: 'int', default: 1 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
