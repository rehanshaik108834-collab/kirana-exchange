import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import pino from 'pino';
import { DataSource } from 'typeorm';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { CreateDisputeDto, ResolveDisputeDto } from './dto/dispute.dto';
import { Dispute, type DisputeStatus } from './entities/dispute.entity';

export interface DisputeActor {
  userId: string;
  role: string;
  shopId?: string;
}

const DEFAULT_RESOLVED_PENALTY = 5;

@Injectable()
export class DisputeService {
  private readonly logger = pino({ name: 'shop-dispute-service' });

  constructor(private readonly dataSource: DataSource) {}

  private normalizeUuid(val?: string): string {
    return val && isUuid(val) ? val : uuidv4();
  }

  private async resolveReporterShopId(actor: DisputeActor): Promise<string> {
    if (actor.shopId && isUuid(actor.shopId)) {
      return actor.shopId;
    }
    const rows = (await this.dataSource.query(`SELECT id FROM shops WHERE owner_id = $1`, [
      actor.userId,
    ])) as Array<{ id: string }>;
    if (!rows[0]?.id) {
      throw new ForbiddenException('A linked shop profile is required to submit a swap dispute');
    }
    return rows[0].id;
  }

  async createDispute(dto: CreateDisputeDto, actor: DisputeActor): Promise<Dispute> {
    const reporterShopId = await this.resolveReporterShopId(actor);
    if (reporterShopId === dto.accusedShopId) {
      throw new BadRequestException('A shop cannot file a swap dispute against itself');
    }

    const repo = this.dataSource.getRepository(Dispute);
    const dispute = repo.create({
      transactionId: dto.transactionId,
      reporterShopId,
      accusedShopId: dto.accusedShopId,
      reason: dto.reason.trim(),
      status: 'OPEN',
      resolutionNotes: null,
      resolvedBy: null,
      resolvedAt: null,
    });

    return repo.save(dispute);
  }

  async listMyDisputes(actor: DisputeActor): Promise<Dispute[]> {
    const shopId = await this.resolveReporterShopId(actor);
    return this.dataSource.getRepository(Dispute).find({
      where: [{ reporterShopId: shopId }, { accusedShopId: shopId }],
      order: { createdAt: 'DESC' },
    });
  }

  async listAdminQueue(actor: DisputeActor, status?: DisputeStatus): Promise<Dispute[]> {
    if (actor.role !== 'admin') {
      throw new ForbiddenException('Admin role required to inspect the dispute resolution queue');
    }
    const where = status ? { status } : {};
    return this.dataSource.getRepository(Dispute).find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Admin resolves or dismisses an OPEN dispute atomically:
   * - Updates dispute status, resolution notes, resolved_by, resolved_at.
   * - If RESOLVED, deducts `penaltyPoints` (default 5) from accused shop's reputation clamped [0, 100].
   * - Writes an immutable `audit_logs` entry inside the same PostgreSQL transaction.
   */
  async resolveDispute(
    disputeId: string,
    dto: ResolveDisputeDto,
    actor: DisputeActor,
    correlationId?: string,
  ): Promise<Dispute> {
    if (actor.role !== 'admin') {
      throw new ForbiddenException('Admin role required to resolve swap disputes');
    }

    const validCorr = this.normalizeUuid(correlationId);
    const penalty = dto.status === 'RESOLVED' ? (dto.penaltyPoints ?? DEFAULT_RESOLVED_PENALTY) : 0;

    return this.dataSource.transaction(async (manager) => {
      const dispute = await manager.findOne(Dispute, {
        where: { id: disputeId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!dispute) {
        throw new NotFoundException(`Dispute ${disputeId} not found`);
      }
      if (dispute.status !== 'OPEN') {
        throw new ConflictException(`Dispute ${disputeId} is already ${dispute.status}`);
      }

      dispute.status = dto.status;
      dispute.resolutionNotes = dto.resolutionNotes.trim();
      dispute.resolvedBy = this.normalizeUuid(actor.userId);
      dispute.resolvedAt = new Date();

      const saved = await manager.save(Dispute, dispute);

      if (penalty > 0) {
        await manager.query(
          `
          UPDATE shops
          SET reputation_score = LEAST(100.00, GREATEST(0.00, reputation_score - $1::numeric)),
              updated_at = NOW()
          WHERE id = $2
          `,
          [penalty.toFixed(2), dispute.accusedShopId],
        );
      }

      await manager.query(
        `
        INSERT INTO audit_logs
          (actor_id, actor_role, action, entity_type, entity_id, correlation_id, metadata)
        VALUES ($1, $2, $3, 'dispute', $4, $5, $6::jsonb)
        `,
        [
          this.normalizeUuid(actor.userId),
          actor.role,
          `DISPUTE_${dto.status}`,
          saved.id,
          validCorr,
          JSON.stringify({
            transactionId: saved.transactionId,
            accusedShopId: saved.accusedShopId,
            penaltyPoints: penalty,
          }),
        ],
      );

      this.logger.info(
        { correlationId: validCorr, disputeId: saved.id, status: saved.status, penalty },
        'Admin resolved swap dispute',
      );
      return saved;
    });
  }
}
