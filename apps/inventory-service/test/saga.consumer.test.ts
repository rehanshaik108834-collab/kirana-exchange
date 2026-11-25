import { KIRANA_SAGA_COMMANDS_EXCHANGE } from '@kirana/common';
import { describe, expect, it, vi } from 'vitest';
import {
  CMD_COMMIT_TRANSFER,
  CMD_RELEASE_STOCK,
  CMD_RESERVE_STOCK,
  INVENTORY_SAGA_COMMANDS_QUEUE,
  InventorySagaConsumer,
} from '../src/saga.consumer';

describe('InventorySagaConsumer', () => {
  const envelope = (type: string, payload: Record<string, unknown>) => ({
    id: '11111111-1111-4111-8111-111111111111',
    type,
    version: 1,
    occurredAt: '2026-04-01T00:00:00Z',
    correlationId: '22222222-2222-4222-8222-222222222222',
    producer: 'saga-orchestrator',
    payload,
  });

  it('binds exclusively to kirana.saga.commands exchange for all 3 saga commands', () => {
    const consumer = new InventorySagaConsumer({} as any);
    const sub = consumer.getSubscription();
    expect(sub.queue).toBe(INVENTORY_SAGA_COMMANDS_QUEUE);
    expect(sub.sourceExchange).toBe(KIRANA_SAGA_COMMANDS_EXCHANGE);
    expect(sub.bindingKeys).toEqual([CMD_RESERVE_STOCK, CMD_RELEASE_STOCK, CMD_COMMIT_TRANSFER]);
  });

  it('dispatches ReserveStockCmd, ReleaseStockCmd, and CommitTransferCmd to SagaInventoryService', async () => {
    const sagaInventory = {
      handleReserveStockCommand: vi.fn().mockResolvedValue({ outcome: 'RESERVED' }),
      handleReleaseStockCommand: vi.fn().mockResolvedValue({ outcome: 'RELEASED' }),
      handleCommitTransferCommand: vi.fn().mockResolvedValue({ outcome: 'TRANSFER_COMMITTED' }),
    };
    const manager = {} as any;
    const consumer = new InventorySagaConsumer(sagaInventory as any);

    await consumer.handleCommand(
      envelope(CMD_RESERVE_STOCK, {
        transactionId: 'tx-1',
        batchId: 'b-1',
        sellerShopId: 's-1',
        qty: 5,
      }),
      manager,
    );
    expect(sagaInventory.handleReserveStockCommand).toHaveBeenCalledWith(
      {
        transactionId: 'tx-1',
        batchId: 'b-1',
        sellerShopId: 's-1',
        qty: 5,
        expectedVersion: undefined,
      },
      '22222222-2222-4222-8222-222222222222',
      manager,
    );

    await consumer.handleCommand(
      envelope(CMD_RELEASE_STOCK, {
        transactionId: 'tx-1',
        batchId: 'b-1',
        sellerShopId: 's-1',
        qty: 5,
      }),
      manager,
    );
    expect(sagaInventory.handleReleaseStockCommand).toHaveBeenCalledWith(
      { transactionId: 'tx-1', batchId: 'b-1', sellerShopId: 's-1', qty: 5 },
      '22222222-2222-4222-8222-222222222222',
      manager,
    );

    await consumer.handleCommand(
      envelope(CMD_COMMIT_TRANSFER, {
        transactionId: 'tx-1',
        sellerBatchId: 'b-1',
        sellerShopId: 's-1',
        buyerShopId: 's-2',
        productId: 'p-1',
        qty: 5,
      }),
      manager,
    );
    expect(sagaInventory.handleCommitTransferCommand).toHaveBeenCalledWith(
      {
        transactionId: 'tx-1',
        sellerBatchId: 'b-1',
        sellerShopId: 's-1',
        buyerShopId: 's-2',
        productId: 'p-1',
        qty: 5,
        costPrice: undefined,
        expiryDate: undefined,
      },
      '22222222-2222-4222-8222-222222222222',
      manager,
    );
  });
});
