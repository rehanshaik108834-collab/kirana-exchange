import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type SagaStockStep = 'RESERVE' | 'RELEASE' | 'COMMIT_TRANSFER';
export type SagaOperationStatus = 'APPLIED' | 'FAILED' | 'NOOP_NOT_RESERVED';

@Entity('saga_stock_operations')
export class SagaStockOperation {
  @PrimaryColumn({ name: 'transaction_id', type: 'uuid' })
  transactionId: string;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  step: SagaStockStep;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId: string;

  @Column({ type: 'int' })
  qty: number;

  @Column({ type: 'varchar', length: 32 })
  status: SagaOperationStatus;

  @Column({ name: 'result_payload', type: 'jsonb', default: () => "'{}'::jsonb" })
  resultPayload: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
