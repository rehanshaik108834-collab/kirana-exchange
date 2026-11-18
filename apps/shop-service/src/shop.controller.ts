import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CreateShopDto, UpdateShopLocationDto } from './dto/shop.dto';
import { ShopService } from './shop.service';

@Controller('v1/shops')
export class ShopController {
  constructor(private readonly shopService: ShopService) {}

  @Get('health')
  health(@Headers('x-correlation-id') correlationId = 'unknown') {
    return { status: 'ok', service: 'shop-service', correlationId };
  }

  @Post()
  async createShop(
    @Body() dto: CreateShopDto,
    @Headers('x-correlation-id') correlationId = 'unknown',
  ) {
    return this.shopService.createShop(dto, correlationId);
  }

  @Get(':shopId')
  async getShop(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.shopService.getShopById(shopId);
  }

  @Patch(':shopId/location')
  async updateLocation(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() dto: UpdateShopLocationDto,
    @Headers('x-correlation-id') correlationId = 'unknown',
  ) {
    return this.shopService.updateShopLocation(shopId, dto, correlationId);
  }
}
