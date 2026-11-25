import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('shop_contacts')
export class ShopContact {
  @PrimaryColumn({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ name: 'email_enabled', type: 'boolean', default: true })
  emailEnabled: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
