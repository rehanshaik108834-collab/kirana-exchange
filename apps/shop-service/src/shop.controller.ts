import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateShopDto, UpdateShopLocationDto } from './dto/shop.dto';
import { ShopActor, ShopService } from './shop.service';

/**
 * Identity comes only from api-gateway headers built from the verified JWT
 * (`x-user-id`, `x-user-role`); request bodies never carry ownership.
 */
@Controller('v1/shops')
export class ShopController {
  constructor(private readonly shopService: ShopService) {}

  private actor(userId?: string, role?: string): ShopActor {
    if (!userId || !role) {
      throw new UnauthorizedException('Missing authenticated identity');
    }
    return { userId, role };
  }

  @Get('health')
  health(@Headers('x-correlation-id') correlationId = 'unknown') {
    return { status: 'ok', service: 'shop-service', correlationId };
  }

  @Post()
  async createShop(
    @Body() dto: CreateShopDto,
    @Headers('x-user-id') userId?: string,
    @Headers('x-user-role') role?: string,
    @Headers('x-correlation-id') correlationId = 'unknown',
  ) {
    const actor = this.actor(userId, role);
    if (actor.role !== 'shop_owner') {
      throw new ForbiddenException('Only a shop_owner can create a shop profile');
    }
    return this.shopService.createShop(dto, actor.userId, correlationId);
  }

  /** The caller's own shop (used by the web app after login). Declared before `:shopId`. */
  @Get('me')
  async getMyShop(@Headers('x-user-id') userId?: string, @Headers('x-user-role') role?: string) {
    return this.shopService.getShopByOwner(this.actor(userId, role).userId);
  }

  @Get(':shopId')
  async getShop(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Headers('x-user-id') userId?: string,
    @Headers('x-user-role') role?: string,
  ) {
    return this.shopService.getShopById(shopId, this.actor(userId, role));
  }

  @Patch(':shopId/location')
  async updateLocation(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() dto: UpdateShopLocationDto,
    @Headers('x-user-id') userId?: string,
    @Headers('x-user-role') role?: string,
    @Headers('x-correlation-id') correlationId = 'unknown',
  ) {
    return this.shopService.updateShopLocation(
      shopId,
      dto,
      this.actor(userId, role),
      correlationId,
    );
  }
}
