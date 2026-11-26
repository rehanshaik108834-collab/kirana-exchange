import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { InventoryController } from '../src/inventory.controller';

const SHOP_A = '11111111-1111-4111-8111-111111111111';
const SHOP_B = '22222222-2222-4222-8222-222222222222';
const PROD_1 = '33333333-3333-4333-8333-333333333333';
const BATCH_1 = '44444444-4444-4444-8444-444444444444';
const IDEM_KEY = '55555555-5555-4555-8555-555555555555';

describe('Cross-Shop IDOR Authorization Sweep — InventoryController', () => {
  function makeController() {
    const service = {
      listBatchesForShop: vi.fn().mockResolvedValue([]),
      addStockBatch: vi.fn().mockResolvedValue({ id: BATCH_1 }),
      recordSale: vi.fn().mockResolvedValue({ sale: {}, batch: {} }),
      reserveStock: vi.fn().mockResolvedValue({ id: BATCH_1 }),
      releaseStock: vi.fn().mockResolvedValue({ id: BATCH_1 }),
      bulkImportBatches: vi.fn().mockResolvedValue({ importedCount: 1 }),
    };
    return { controller: new InventoryController(service as any), service };
  }

  it('denies Shop A from reading or mutating Shop B across all 6 inventory endpoints', async () => {
    const { controller, service } = makeController();

    await expect(controller.listBatches(SHOP_B, 'shop_owner', SHOP_A)).rejects.toThrow(
      ForbiddenException,
    );

    await expect(
      controller.addBatch(
        {
          shopId: SHOP_B,
          productId: PROD_1,
          batchCode: 'B1',
          qty: 10,
          costPrice: 20,
          expiryDate: '2026-12-31',
        },
        IDEM_KEY,
        'corr-1',
        'shop_owner',
        SHOP_A,
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      controller.recordSale(
        { shopId: SHOP_B, batchId: BATCH_1, qty: 1, expectedVersion: 1 },
        IDEM_KEY,
        'corr-1',
        'shop_owner',
        SHOP_A,
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      controller.reserveStock(
        BATCH_1,
        { shopId: SHOP_B, qty: 2, version: 1 },
        IDEM_KEY,
        'corr-1',
        'shop_owner',
        SHOP_A,
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      controller.releaseStock(
        BATCH_1,
        { shopId: SHOP_B, qty: 2 },
        IDEM_KEY,
        'corr-1',
        'shop_owner',
        SHOP_A,
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      controller.bulkImport(
        {
          shopId: SHOP_B,
          rows: [
            { productId: PROD_1, batchCode: 'B1', qty: 5, costPrice: 10, expiryDate: '2026-12-31' },
          ],
        },
        'corr-1',
        'shop_owner',
        SHOP_A,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(service.listBatchesForShop).not.toHaveBeenCalled();
    expect(service.addStockBatch).not.toHaveBeenCalled();
    expect(service.recordSale).not.toHaveBeenCalled();
    expect(service.reserveStock).not.toHaveBeenCalled();
    expect(service.releaseStock).not.toHaveBeenCalled();
    expect(service.bulkImportBatches).not.toHaveBeenCalled();
  });

  it('denies unlinked users (missing shopId or role) by default, while allowing own shop and admin', async () => {
    const { controller, service } = makeController();

    await expect(controller.listBatches(SHOP_A, 'shop_owner', undefined)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(controller.listBatches(SHOP_A, undefined, SHOP_A)).rejects.toThrow(
      ForbiddenException,
    );

    await controller.listBatches(SHOP_A, 'shop_owner', SHOP_A);
    await controller.listBatches(SHOP_B, 'admin', undefined);
    expect(service.listBatchesForShop).toHaveBeenCalledTimes(2);
  });
});
