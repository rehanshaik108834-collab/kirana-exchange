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
  Res,
  Sse,
} from '@nestjs/common';
import { REDIS_CLIENT } from '@kirana/common';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { Observable } from 'rxjs';
import { CancelSagaDto, ConfirmHandoverDto } from './dto/saga.dto';
import { SSE_SWAP_CHANNEL_PREFIX } from './saga.constants';
import { type SagaActor, SagaService } from './saga.service';

@Controller('v1/sagas')
export class SagaController {
  constructor(
    private readonly sagaService: SagaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  private extractActor(headers: Record<string, string | undefined>): SagaActor {
    const userId = headers['x-user-id'];
    const role = headers['x-user-role'];
    const shopId = headers['x-shop-id'];

    if (!userId || !role) {
      throw new ForbiddenException('Missing verified gateway identity headers');
    }
    return { userId, role, shopId };
  }

  @Get('mine')
  listMine(@Headers() headers: Record<string, string | undefined>) {
    return this.sagaService.listMyTransactions(this.extractActor(headers));
  }

  @Get(':id')
  getDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.sagaService.getTransactionDetail(id, this.extractActor(headers));
  }

  @Post(':id/confirm-handover')
  confirmHandover(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmHandoverDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.sagaService.confirmHandover(
      id,
      dto.handoverCode,
      this.extractActor(headers),
      headers['x-correlation-id'],
    );
  }

  @Post(':id/cancel')
  cancelSwap(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelSagaDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.sagaService.cancelSwap(
      id,
      this.extractActor(headers),
      dto.reason ?? 'USER_CANCEL',
      headers['x-correlation-id'],
    );
  }

  @Get(':id/invoice.pdf')
  async downloadInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const invoice = await this.sagaService.getInvoicePdf(id, this.extractActor(headers));
    res.setHeader('Content-Type', invoice.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.filename}"`);
    res.setHeader('X-Invoice-Number', invoice.invoiceNo);
    res.send(invoice.buffer);
  }

  @Sse(':id/stream')
  async streamUpdates(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<Observable<MessageEvent>> {
    const detail = await this.sagaService.getTransactionDetail(id, this.extractActor(headers));
    const channelName = `${SSE_SWAP_CHANNEL_PREFIX}${id}`;

    return new Observable<MessageEvent>((subscriber) => {
      // Emit initial snapshot immediately upon subscription
      subscriber.next({
        type: 'saga.status',
        data: {
          transactionId: detail.transaction.id,
          state: detail.transaction.state,
          version: detail.transaction.version,
          billRecordId: detail.transaction.billRecordId,
          cancelReason: detail.transaction.cancelReason,
        },
      });

      if (!this.redis) {
        return;
      }

      const sub = this.redis.duplicate();
      const onMessage = (_channel: string, raw: string) => {
        try {
          subscriber.next({ type: 'saga.status', data: JSON.parse(raw) });
        } catch {
          subscriber.next({ type: 'saga.status', data: raw });
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
