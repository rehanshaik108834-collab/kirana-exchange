import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  AddStockBatchDto,
  BulkImportBatchesDto,
  RecordSaleDto,
  ReleaseStockDto,
  ReserveStockDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  private assertShopOwnership(targetShopId: string, userRole?: string, userShopId?: string): void {
    if (userRole && userRole !== 'admin' && userShopId && userShopId !== targetShopId) {
      throw new ForbiddenException('Cannot access or mutate inventory of another shop');
    }
  }

  @Get('health')
  health(@Headers('x-correlation-id') correlationId = 'unknown') {
    return { status: 'ok', service: 'inventory-service', correlationId };
  }

  @Get('v1/inventory/batches')
  async listBatches(
    @Query('shopId', ParseUUIDPipe) shopId: string,
    @Headers('x-user-role') userRole?: string,
    @Headers('x-shop-id') userShopId?: string,
  ) {
    this.assertShopOwnership(shopId, userRole, userShopId);
    return this.inventoryService.listBatchesForShop(shopId);
  }

  @Post('v1/inventory/batches')
  async addBatch(
    @Body() dto: AddStockBatchDto,
    @Headers('idempotency-key') idempotencyKey = '',
    @Headers('x-correlation-id') correlationId = '',
    @Headers('x-user-role') userRole?: string,
    @Headers('x-shop-id') userShopId?: string,
  ) {
    this.assertShopOwnership(dto.shopId, userRole, userShopId);
    return this.inventoryService.addStockBatch(dto, idempotencyKey, correlationId);
  }

  @Post('v1/inventory/sales')
  async recordSale(
    @Body() dto: RecordSaleDto,
    @Headers('idempotency-key') idempotencyKey = '',
    @Headers('x-correlation-id') correlationId = '',
    @Headers('x-user-role') userRole?: string,
    @Headers('x-shop-id') userShopId?: string,
  ) {
    this.assertShopOwnership(dto.shopId, userRole, userShopId);
    return this.inventoryService.recordSale(dto, idempotencyKey, correlationId);
  }

  @Post('v1/inventory/batches/:batchId/reserve')
  @HttpCode(HttpStatus.OK)
  async reserveStock(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() dto: ReserveStockDto,
    @Headers('idempotency-key') idempotencyKey = '',
    @Headers('x-correlation-id') correlationId = '',
    @Headers('x-user-role') userRole?: string,
    @Headers('x-shop-id') userShopId?: string,
  ) {
    this.assertShopOwnership(dto.shopId, userRole, userShopId);
    return this.inventoryService.reserveStock(batchId, dto, idempotencyKey, correlationId);
  }

  @Post('v1/inventory/batches/:batchId/release')
  @HttpCode(HttpStatus.OK)
  async releaseStock(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() dto: ReleaseStockDto,
    @Headers('idempotency-key') idempotencyKey = '',
    @Headers('x-correlation-id') correlationId = '',
    @Headers('x-user-role') userRole?: string,
    @Headers('x-shop-id') userShopId?: string,
  ) {
    this.assertShopOwnership(dto.shopId, userRole, userShopId);
    return this.inventoryService.releaseStock(batchId, dto, idempotencyKey, correlationId);
  }

  @Post('v1/inventory/batches/bulk-import')
  @HttpCode(HttpStatus.OK)
  async bulkImport(
    @Body() dto: BulkImportBatchesDto,
    @Headers('x-correlation-id') correlationId = '',
    @Headers('x-user-role') userRole?: string,
    @Headers('x-shop-id') userShopId?: string,
  ) {
    this.assertShopOwnership(dto.shopId, userRole, userShopId);
    return this.inventoryService.bulkImportBatches(dto.shopId, dto.rows, correlationId);
  }
}
