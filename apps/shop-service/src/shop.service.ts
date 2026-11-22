import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import pino from 'pino';
import { DataSource } from 'typeorm';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { CreateShopDto, UpdateShopLocationDto } from './dto/shop.dto';
import { OutboxEvent } from './entities/outbox-event.entity';
import { Shop } from './entities/shop.entity';

export interface ShopActor {
  userId: string;
  role: string;
}

@Injectable()
export class ShopService {
  private readonly logger = pino({ name: 'shop-service' });

  constructor(private readonly dataSource: DataSource) {}

  private normalizeCorrelationId(correlationId: string): string {
    return isUuid(correlationId) ? correlationId : uuidv4();
  }

  /**
   * Creates a new shop profile and emits a ShopCreated event atomically.
   * INVARIANT: Executed inside a PostgreSQL transaction.
   * 1. Create and save the Shop entity. (Catch unique constraint 23505 on ownerId).
   * 2. Create and save an OutboxEvent entity (eventType: 'shop.created.v1').
   *    Payload must contain: shopId, lat, lng, state, gstScheme.
   * 3. Commit transaction.
   * Note: The background relay will poll this outbox event later to update Redis GEOADD.
   */
  private assertCanAccess(shop: Shop, actor: ShopActor): void {
    if (actor.role === 'admin') return;
    if (actor.role !== 'shop_owner' || shop.ownerId !== actor.userId) {
      throw new ForbiddenException('Only the shop owner or an admin can access this shop');
    }
  }

  async createShop(dto: CreateShopDto, ownerId: string, correlationId = 'unknown'): Promise<Shop> {
    const validCorrelationId = this.normalizeCorrelationId(correlationId);

    try {
      const savedShop = await this.dataSource.transaction(async (manager) => {
        const shop = manager.create(Shop, {
          ownerId,
          name: dto.name,
          address: dto.address,
          lat: dto.lat.toFixed(6),
          lng: dto.lng.toFixed(6),
          state: dto.state,
          gstScheme: dto.gstScheme,
          operatingHours: dto.operatingHours ?? {},
          swapRadiusKm: (dto.swapRadiusKm ?? 2.0).toFixed(2),
          reputationScore: '100.00',
        });

        const persistedShop = await manager.save(Shop, shop);

        const outboxEvent = manager.create(OutboxEvent, {
          aggregateType: 'shop',
          aggregateId: persistedShop.id,
          eventType: 'shop.created.v1',
          version: 1,
          correlationId: validCorrelationId,
          producer: 'shop-service',
          payload: {
            shopId: persistedShop.id,
            ownerId: persistedShop.ownerId,
            lat: Number(persistedShop.lat),
            lng: Number(persistedShop.lng),
            state: persistedShop.state,
            gstScheme: persistedShop.gstScheme,
          },
          publishedAt: null,
        });

        await manager.save(OutboxEvent, outboxEvent);

        return persistedShop;
      });

      this.logger.info(
        { correlationId: validCorrelationId, shopId: savedShop.id, state: savedShop.state },
        'Shop created and ShopCreated outbox event persisted',
      );

      return savedShop;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        throw new ConflictException('A shop profile already exists for this owner');
      }
      throw err;
    }
  }

  /**
   * Updates a shop's coordinates/state and writes a ShopMoved outbox event atomically.
   */
  async updateShopLocation(
    shopId: string,
    dto: UpdateShopLocationDto,
    actor: ShopActor,
    correlationId = 'unknown',
  ): Promise<Shop> {
    const validCorrelationId = this.normalizeCorrelationId(correlationId);

    const updatedShop = await this.dataSource.transaction(async (manager) => {
      const shop = await manager.findOne(Shop, {
        where: { id: shopId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!shop) {
        throw new NotFoundException(`Shop ${shopId} not found`);
      }
      this.assertCanAccess(shop, actor);

      shop.lat = dto.lat.toFixed(6);
      shop.lng = dto.lng.toFixed(6);
      shop.state = dto.state;
      if (dto.address !== undefined) {
        shop.address = dto.address;
      }
      if (dto.swapRadiusKm !== undefined) {
        shop.swapRadiusKm = dto.swapRadiusKm.toFixed(2);
      }

      const persistedShop = await manager.save(Shop, shop);

      const outboxEvent = manager.create(OutboxEvent, {
        aggregateType: 'shop',
        aggregateId: persistedShop.id,
        eventType: 'shop.moved.v1',
        version: 1,
        correlationId: validCorrelationId,
        producer: 'shop-service',
        payload: {
          shopId: persistedShop.id,
          lat: Number(persistedShop.lat),
          lng: Number(persistedShop.lng),
          state: persistedShop.state,
        },
        publishedAt: null,
      });

      await manager.save(OutboxEvent, outboxEvent);

      return persistedShop;
    });

    this.logger.info(
      { correlationId: validCorrelationId, shopId: updatedShop.id, state: updatedShop.state },
      'Shop location updated and ShopMoved outbox event persisted',
    );

    return updatedShop;
  }

  async getShopById(shopId: string, actor: ShopActor): Promise<Shop> {
    const shop = await this.dataSource.getRepository(Shop).findOne({ where: { id: shopId } });
    if (!shop) {
      throw new NotFoundException(`Shop ${shopId} not found`);
    }
    this.assertCanAccess(shop, actor);
    return shop;
  }

  async getShopByOwner(ownerId: string): Promise<Shop> {
    const shop = await this.dataSource.getRepository(Shop).findOne({ where: { ownerId } });
    if (!shop) {
      throw new NotFoundException('No shop profile exists for this user yet');
    }
    return shop;
  }
}
