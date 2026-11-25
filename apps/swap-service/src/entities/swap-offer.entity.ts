import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type SwapOfferStatus = 'PENDING' | 'COUNTERED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

@Entity('swap_offers')
export class SwapOffer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;

  @Column({ name: 'seller_shop_id', type: 'uuid' })
  sellerShopId: string;

  @Column({ name: 'buyer_shop_id', type: 'uuid' })
  buyerShopId: string;

  @Column({ type: 'int' })
  qty: number;

  @Column({ name: 'offered_price', type: 'numeric', precision: 10, scale: 2 })
  offeredPrice: string;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status: SwapOfferStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
