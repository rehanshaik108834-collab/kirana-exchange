import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('shop_geo_read_model')
export class ShopGeoReadModel {
  @PrimaryColumn({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ type: 'numeric', precision: 9, scale: 6 })
  lat: string;

  @Column({ type: 'numeric', precision: 9, scale: 6 })
  lng: string;

  @Column({ type: 'varchar', length: 64 })
  state: string;

  @Column({ name: 'gst_scheme', type: 'varchar', length: 20, default: 'UNREGISTERED' })
  gstScheme: string;

  @Column({ name: 'swap_radius_km', type: 'numeric', precision: 4, scale: 2, default: '2.00' })
  swapRadiusKm: string;

  @Column({ name: 'reputation_score', type: 'numeric', precision: 5, scale: 2, default: '100.00' })
  reputationScore: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
