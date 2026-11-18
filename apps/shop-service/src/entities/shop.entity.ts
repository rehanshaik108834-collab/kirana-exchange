import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type GstScheme = 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';

@Entity('shops')
@Index('idx_shops_state', ['state'])
export class Shop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'owner_id', type: 'uuid', unique: true })
  ownerId: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'text' })
  address: string;

  @Column({ type: 'numeric', precision: 9, scale: 6 })
  lat: string;

  @Column({ type: 'numeric', precision: 9, scale: 6 })
  lng: string;

  @Column({ type: 'varchar', length: 64 })
  state: string;

  @Column({ name: 'gst_scheme', type: 'varchar', length: 20 })
  gstScheme: GstScheme;

  @Column({ name: 'operating_hours', type: 'jsonb', default: () => "'{}'::jsonb" })
  operatingHours: Record<string, any>;

  @Column({ name: 'swap_radius_km', type: 'numeric', precision: 4, scale: 2, default: 2.0 })
  swapRadiusKm: string;

  @Column({ name: 'reputation_score', type: 'numeric', precision: 5, scale: 2, default: 100.0 })
  reputationScore: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
