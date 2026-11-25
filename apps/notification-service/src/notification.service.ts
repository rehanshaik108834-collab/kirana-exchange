import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { REDIS_CLIENT } from '@kirana/common';
import type Redis from 'ioredis';
import pino from 'pino';
import { DataSource, type EntityManager, IsNull } from 'typeorm';
import { UpdateNotificationPreferencesDto } from './dto/notification.dto';
import { type NotificationChannel, NotificationRecord } from './entities/notification.entity';
import { ShopContact } from './entities/shop-contact.entity';
import { MailerService } from './mailer.service';

export const NOTIFY_CAP_PREFIX = 'notify:cap:';
export const NOTIFY_BATCH_PREFIX = 'notify:batch:';
export const NOTIFY_BATCH_SHOPS_SET = 'notify:batch:shops';
export const SSE_NOTIFY_PREFIX = 'sse:notify:';

const CAP_TTL_SECONDS = 90_000;
const BATCH_TTL_SECONDS = 86_400;

export interface NotificationActor {
  userId: string;
  role: string;
  shopId?: string;
}

export interface DispatchAlertInput {
  shopId: string;
  type: string;
  title: string;
  body: string;
  priority: 'URGENT' | 'BATCHABLE';
  data: Record<string, unknown>;
  correlationId?: string;
  now?: Date;
}

export interface DispatchAlertResult {
  notification: NotificationRecord;
  channel: NotificationChannel;
  emailed: boolean;
  capped: boolean;
  batched: boolean;
}

export function dailyCapKey(shopId: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `${NOTIFY_CAP_PREFIX}${shopId}:${day}`;
}

export function batchQueueKey(shopId: string): string {
  return `${NOTIFY_BATCH_PREFIX}${shopId}`;
}

export function defaultShopEmail(shopId: string): string {
  return `shop-${shopId.slice(0, 8)}@kirana.local`;
}

@Injectable()
export class NotificationService {
  private readonly logger = pino({ name: 'notification-service' });
  private readonly dailyEmailCap = Number(process.env.NOTIFY_DAILY_CAP || 20);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailer: MailerService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  private assertShopId(actor: NotificationActor): string {
    if (!actor.shopId) {
      throw new ForbiddenException('A linked shop profile is required to view notifications');
    }
    return actor.shopId;
  }

  private async resolveShopContact(
    shopId: string,
    manager?: EntityManager,
  ): Promise<{ email: string; emailEnabled: boolean }> {
    const repo = manager
      ? manager.getRepository(ShopContact)
      : this.dataSource.getRepository(ShopContact);
    const contact = await repo.findOne({ where: { shopId } });
    if (contact) {
      return { email: contact.email, emailEnabled: contact.emailEnabled };
    }
    return { email: defaultShopEmail(shopId), emailEnabled: true };
  }

  private async checkAndIncrementDailyCap(shopId: string, now: Date): Promise<boolean> {
    if (!this.redis) return true;
    const key = dailyCapKey(shopId, now);
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, CAP_TTL_SECONDS);
      }
      return count <= this.dailyEmailCap;
    } catch (err) {
      this.logger.warn(
        { shopId, err: (err as Error).message },
        'Redis daily cap check failed; degrading gracefully',
      );
      return true;
    }
  }

  private async enqueueBatchItem(shopId: string, item: Record<string, unknown>): Promise<void> {
    if (!this.redis) return;
    const key = batchQueueKey(shopId);
    try {
      await this.redis.rpush(key, JSON.stringify(item));
      await this.redis.expire(key, BATCH_TTL_SECONDS);
      await this.redis.sadd(NOTIFY_BATCH_SHOPS_SET, shopId);
    } catch (err) {
      this.logger.warn(
        { shopId, err: (err as Error).message },
        'Redis alert batch enqueue failed; persisting notification record only',
      );
    }
  }

  private async publishSse(shopId: string, notification: NotificationRecord): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.publish(
        `${SSE_NOTIFY_PREFIX}${shopId}`,
        JSON.stringify({
          id: notification.id,
          shopId: notification.shopId,
          type: notification.type,
          channel: notification.channel,
          payload: notification.payload,
          readAt: notification.readAt,
          sentAt: notification.sentAt,
        }),
      );
    } catch (err) {
      this.logger.warn(
        { shopId, err: (err as Error).message },
        'Redis SSE notification publish failed',
      );
    }
  }

  /**
   * Routes a domain alert through daily cap (`notify:cap:*`), alert batching (`notify:batch:*`),
   * in-app SSE (`sse:notify:*`), and MailHog SMTP email delivery.
   */
  async dispatchAlert(
    input: DispatchAlertInput,
    existingManager?: EntityManager,
  ): Promise<DispatchAlertResult> {
    const now = input.now ?? new Date();
    const payload = {
      title: input.title,
      body: input.body,
      priority: input.priority,
      correlationId: input.correlationId ?? null,
      data: input.data,
    };

    const contact = await this.resolveShopContact(input.shopId, existingManager);

    let channel: NotificationChannel = 'SSE';
    let emailed = false;
    let capped = false;
    let batched = false;

    if (input.priority === 'BATCHABLE') {
      channel = 'BATCHED';
      batched = true;
      await this.enqueueBatchItem(input.shopId, {
        type: input.type,
        title: input.title,
        body: input.body,
        at: now.toISOString(),
      });
    } else {
      const underCap = await this.checkAndIncrementDailyCap(input.shopId, now);
      if (!underCap) {
        capped = true;
        batched = true;
        channel = 'BATCHED';
        await this.enqueueBatchItem(input.shopId, {
          type: input.type,
          title: input.title,
          body: input.body,
          capped: true,
          at: now.toISOString(),
        });
      } else if (contact.emailEnabled) {
        const sendRes = await this.mailer.sendEmail({
          to: contact.email,
          subject: `[Kirana Exchange] ${input.title}`,
          text: `${input.body}\n\nEvent: ${input.type}`,
        });
        emailed = sendRes.sent;
        channel = emailed ? 'EMAIL' : 'SSE';
      } else {
        channel = 'SSE';
      }
    }

    const repo = existingManager
      ? existingManager.getRepository(NotificationRecord)
      : this.dataSource.getRepository(NotificationRecord);

    const saved = await repo.save(
      repo.create({
        shopId: input.shopId,
        type: input.type,
        channel,
        payload,
        readAt: null,
      }),
    );

    // Always push live in-app SSE so the shopkeeper's bell badge stays fresh
    await this.publishSse(input.shopId, saved);

    return { notification: saved, channel, emailed, capped, batched };
  }

  /**
   * Flushes queued low-priority alerts from `notify:batch:{shopId}` into a single digest email
   * (respecting daily caps) and persists a digest NotificationRecord.
   */
  async flushBatchedAlerts(
    shopId: string,
    now = new Date(),
  ): Promise<{ flushedCount: number; emailed: boolean }> {
    if (!this.redis) return { flushedCount: 0, emailed: false };

    const key = batchQueueKey(shopId);
    const rawItems = await this.redis.lrange(key, 0, -1);
    if (rawItems.length === 0) {
      return { flushedCount: 0, emailed: false };
    }

    await this.redis.del(key);
    await this.redis.srem(NOTIFY_BATCH_SHOPS_SET, shopId);

    const parsed = rawItems.map((raw) => {
      try {
        return JSON.parse(raw) as { title?: string; body?: string; type?: string };
      } catch {
        return { title: 'Alert', body: raw, type: 'digest' };
      }
    });

    const summaryLines = parsed.map((item, idx) => `${idx + 1}. ${item.title}: ${item.body}`);
    const title = `Kirana Exchange Digest (${parsed.length} alerts)`;
    const body = summaryLines.join('\n');

    const contact = await this.resolveShopContact(shopId);
    let emailed = false;

    if (contact.emailEnabled) {
      const underCap = await this.checkAndIncrementDailyCap(shopId, now);
      if (underCap) {
        const res = await this.mailer.sendEmail({
          to: contact.email,
          subject: `[Kirana Exchange] ${title}`,
          text: body,
        });
        emailed = res.sent;
      }
    }

    const repo = this.dataSource.getRepository(NotificationRecord);
    const saved = await repo.save(
      repo.create({
        shopId,
        type: 'notification.digest.v1',
        channel: emailed ? 'EMAIL' : 'BATCHED',
        payload: {
          title,
          body,
          count: parsed.length,
          items: parsed,
        },
        readAt: null,
      }),
    );

    await this.publishSse(shopId, saved);
    return { flushedCount: parsed.length, emailed };
  }

  async flushAllBatchedShops(
    now = new Date(),
  ): Promise<{ shopsFlushed: number; alertsFlushed: number }> {
    if (!this.redis) return { shopsFlushed: 0, alertsFlushed: 0 };
    const shopIds = await this.redis.smembers(NOTIFY_BATCH_SHOPS_SET);
    let shopsFlushed = 0;
    let alertsFlushed = 0;

    for (const shopId of shopIds) {
      const res = await this.flushBatchedAlerts(shopId, now);
      if (res.flushedCount > 0) {
        shopsFlushed += 1;
        alertsFlushed += res.flushedCount;
      }
    }
    return { shopsFlushed, alertsFlushed };
  }

  async listForShop(
    actor: NotificationActor,
    limit = 50,
  ): Promise<{ notifications: NotificationRecord[]; unreadCount: number }> {
    const shopId = this.assertShopId(actor);
    const repo = this.dataSource.getRepository(NotificationRecord);

    const [notifications, unreadCount] = await Promise.all([
      repo.find({
        where: { shopId },
        order: { sentAt: 'DESC' },
        take: Math.min(100, Math.max(1, limit)),
      }),
      repo.count({ where: { shopId, readAt: IsNull() } }),
    ]);

    return { notifications, unreadCount };
  }

  async markRead(notificationId: string, actor: NotificationActor): Promise<NotificationRecord> {
    const shopId = this.assertShopId(actor);
    const repo = this.dataSource.getRepository(NotificationRecord);
    const record = await repo.findOne({ where: { id: notificationId } });

    if (!record) {
      throw new NotFoundException(`Notification ${notificationId} not found`);
    }
    if (record.shopId !== shopId && actor.role !== 'admin') {
      throw new ForbiddenException('Cannot mark another shop notification as read');
    }

    if (!record.readAt) {
      record.readAt = new Date();
      return repo.save(record);
    }
    return record;
  }

  async markAllRead(actor: NotificationActor): Promise<{ updated: number }> {
    const shopId = this.assertShopId(actor);
    const res = await this.dataSource
      .getRepository(NotificationRecord)
      .update({ shopId, readAt: IsNull() }, { readAt: new Date() });
    return { updated: res.affected ?? 0 };
  }

  async updatePreferences(
    dto: UpdateNotificationPreferencesDto,
    actor: NotificationActor,
  ): Promise<ShopContact> {
    const shopId = this.assertShopId(actor);
    const repo = this.dataSource.getRepository(ShopContact);
    const existing = await repo.findOne({ where: { shopId } });

    if (existing) {
      existing.email = dto.email;
      if (dto.emailEnabled !== undefined) {
        existing.emailEnabled = dto.emailEnabled;
      }
      return repo.save(existing);
    }

    return repo.save(
      repo.create({
        shopId,
        email: dto.email,
        emailEnabled: dto.emailEnabled ?? true,
      }),
    );
  }
}
