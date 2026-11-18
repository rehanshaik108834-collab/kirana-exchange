import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 14, unique: true })
  ean: string;

  @Column({ length: 200 })
  name: string;

  @Column({ length: 120 })
  brand: string;

  @Column({ name: 'pack_size', length: 64 })
  packSize: string;

  @Column({ length: 80 })
  category: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  mrp: string;

  @Column({ name: 'gst_rate', type: 'numeric', precision: 4, scale: 2 })
  gstRate: string;

  @Column({ name: 'shelf_life_days', type: 'int', default: 180 })
  shelfLifeDays: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'merged_into_id', type: 'uuid', nullable: true })
  mergedIntoId: string | null;

  @ManyToOne(() => Product, { nullable: true })
  @JoinColumn({ name: 'merged_into_id' })
  mergedInto?: Product | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
