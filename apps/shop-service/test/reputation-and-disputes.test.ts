import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import { DisputeService } from '../src/dispute.service';
import { Dispute } from '../src/entities/dispute.entity';
import { ReputationEventConsumer } from '../src/reputation.consumer';

const SHOP_A = '11111111-1111-4111-8111-111111111111';
const SHOP_B = '22222222-2222-4222-8222-222222222222';
const TX_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';

describe('Shop Service — Reputation Consumer & Dispute Workflow', () => {
  it('awards +2.00 to both shops on saga.swap.completed.v1 and deducts -10.00 on BUYER_TIMEOUT', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const consumer = new ReputationEventConsumer();

    await consumer.handleEvent(
      {
        id: uuidv4(),
        type: 'saga.swap.completed.v1',
        version: 1,
        occurredAt: '2026-04-01T00:00:00Z',
        correlationId: uuidv4(),
        producer: 'saga-orchestrator',
        payload: { sellerShopId: SHOP_A, buyerShopId: SHOP_B },
      },
      { query } as any,
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('LEAST(100.00, GREATEST(0.00, reputation_score + $1::numeric))'),
      ['2.00', SHOP_A],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('LEAST(100.00, GREATEST(0.00, reputation_score + $1::numeric))'),
      ['2.00', SHOP_B],
    );

    query.mockClear();

    // BUYER_TIMEOUT deducts -10.00 from buyer
    await consumer.handleEvent(
      {
        id: uuidv4(),
        type: 'saga.swap.cancelled.v1',
        version: 1,
        occurredAt: '2026-04-01T00:00:00Z',
        correlationId: uuidv4(),
        producer: 'saga-orchestrator',
        payload: { sellerShopId: SHOP_A, buyerShopId: SHOP_B, reason: 'BUYER_TIMEOUT' },
      },
      { query } as any,
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.any(String), ['-10.00', SHOP_B]);

    query.mockClear();

    // Non-no-show cancellation (USER_CANCEL) applies 0 penalty
    await consumer.handleEvent(
      {
        id: uuidv4(),
        type: 'saga.swap.cancelled.v1',
        version: 1,
        occurredAt: '2026-04-01T00:00:00Z',
        correlationId: uuidv4(),
        producer: 'saga-orchestrator',
        payload: { sellerShopId: SHOP_A, buyerShopId: SHOP_B, reason: 'USER_CANCEL' },
      },
      { query } as any,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('prevents self-disputes, enforces admin-only resolution, deducts reputation, and writes audit_logs', async () => {
    const disputes = new Map<string, Dispute>();
    const queries: Array<{ sql: string; params: unknown[] }> = [];

    const makeManager = () => ({
      findOne: async (_cls: unknown, opts: any) => disputes.get(opts.where.id) ?? null,
      find: async () => [...disputes.values()],
      create: (_cls: unknown, data: any) => Object.assign(new Dispute(), { id: uuidv4(), ...data }),
      save: async (_cls: unknown, entity: Dispute) => {
        disputes.set(entity.id, entity);
        return entity;
      },
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return [];
      },
    });

    const dataSource: any = {
      getRepository: () => {
        const m = makeManager();
        return {
          create: (d: any) => m.create(Dispute, d),
          save: (e: Dispute) => m.save(Dispute, e),
          find: () => m.find(),
        };
      },
      transaction: async (cb: (m: any) => Promise<any>) => cb(makeManager()),
    };

    const service = new DisputeService(dataSource);

    // 1. Self-dispute rejected
    await expect(
      service.createDispute(
        { transactionId: TX_ID, accusedShopId: SHOP_A, reason: 'Damaged cartons' },
        { userId: uuidv4(), role: 'shop_owner', shopId: SHOP_A },
      ),
    ).rejects.toThrow(BadRequestException);

    // 2. Valid dispute filed by Shop A against Shop B
    const created = await service.createDispute(
      { transactionId: TX_ID, accusedShopId: SHOP_B, reason: 'Short quantity delivered at pickup' },
      { userId: uuidv4(), role: 'shop_owner', shopId: SHOP_A },
    );
    expect(created.status).toBe('OPEN');

    // 3. Non-admin cannot resolve
    await expect(
      service.resolveDispute(
        created.id,
        { status: 'RESOLVED', resolutionNotes: 'Verified' },
        { userId: uuidv4(), role: 'shop_owner', shopId: SHOP_A },
      ),
    ).rejects.toThrow(ForbiddenException);

    // 4. Admin resolves -> reputation penalty + audit_logs written
    const resolved = await service.resolveDispute(
      created.id,
      { status: 'RESOLVED', resolutionNotes: 'Confirmed short delivery', penaltyPoints: 7 },
      { userId: ADMIN_ID, role: 'admin' },
    );
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedAt).toBeTruthy();
    expect(queries.some((q) => q.sql.includes('UPDATE shops') && q.params[0] === '7.00')).toBe(
      true,
    );
    expect(queries.some((q) => q.sql.includes('INSERT INTO audit_logs'))).toBe(true);

    // 5. Re-resolving already closed dispute throws 409 ConflictException
    await expect(
      service.resolveDispute(
        created.id,
        { status: 'DISMISSED', resolutionNotes: 'Duplicate' },
        { userId: ADMIN_ID, role: 'admin' },
      ),
    ).rejects.toThrow(ConflictException);
  });
});
