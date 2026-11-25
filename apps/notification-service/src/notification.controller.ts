import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  type MessageEvent,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Sse,
} from '@nestjs/common';
import { REDIS_CLIENT } from '@kirana/common';
import type Redis from 'ioredis';
import { Observable } from 'rxjs';
import { UpdateNotificationPreferencesDto } from './dto/notification.dto';
import {
  type NotificationActor,
  NotificationService,
  SSE_NOTIFY_PREFIX,
} from './notification.service';

@Controller('v1/notifications')
export class NotificationController {
  constructor(
    private readonly notificationService: NotificationService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  private extractActor(headers: Record<string, string | undefined>): NotificationActor {
    const userId = headers['x-user-id'];
    const role = headers['x-user-role'];
    const shopId = headers['x-shop-id'];

    if (!userId || !role) {
      throw new ForbiddenException('Missing verified gateway identity headers');
    }
    return { userId, role, shopId };
  }

  @Get()
  list(
    @Query('limit') limitRaw: string | undefined,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 50;
    return this.notificationService.listForShop(
      this.extractActor(headers),
      Number.isFinite(limit) ? limit : 50,
    );
  }

  @Post(':id/read')
  markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.notificationService.markRead(id, this.extractActor(headers));
  }

  @Post('read-all')
  markAllRead(@Headers() headers: Record<string, string | undefined>) {
    return this.notificationService.markAllRead(this.extractActor(headers));
  }

  @Put('preferences')
  updatePreferences(
    @Body() dto: UpdateNotificationPreferencesDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.notificationService.updatePreferences(dto, this.extractActor(headers));
  }

  @Post('flush-batches')
  flushBatches(@Headers() headers: Record<string, string | undefined>) {
    const actor = this.extractActor(headers);
    if (actor.role !== 'admin') {
      throw new ForbiddenException('Admin role required to flush batched notification digests');
    }
    return this.notificationService.flushAllBatchedShops();
  }

  @Sse('stream')
  async streamNotifications(
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<Observable<MessageEvent>> {
    const actor = this.extractActor(headers);
    if (!actor.shopId) {
      throw new ForbiddenException('Linked shop required to subscribe to notification stream');
    }

    const initial = await this.notificationService.listForShop(actor, 10);
    const channelName = `${SSE_NOTIFY_PREFIX}${actor.shopId}`;

    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({
        type: 'notification.snapshot',
        data: { unreadCount: initial.unreadCount },
      });

      if (!this.redis) return;

      const sub = this.redis.duplicate();
      const onMessage = (_channel: string, raw: string) => {
        try {
          subscriber.next({ type: 'notification.new', data: JSON.parse(raw) });
        } catch {
          subscriber.next({ type: 'notification.new', data: raw });
        }
      };

      sub.on('message', onMessage);
      void sub.subscribe(channelName).catch(() => undefined);

      return () => {
        sub.off('message', onMessage);
        void sub.unsubscribe(channelName).catch(() => undefined);
        void sub.quit().catch(() => undefined);
      };
    });
  }
}
