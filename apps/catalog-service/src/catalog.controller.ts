import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CreateProductDto, MergeProductsDto, UpdateProductDto } from './dto/catalog.dto';

@Controller()
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  private assertAdmin(role?: string) {
    if (role !== 'admin') {
      throw new ForbiddenException('Admin role required for catalog mutations');
    }
  }

  @Get('health')
  health(@Headers('x-correlation-id') correlationId = 'unknown') {
    return { status: 'ok', service: 'catalog-service', correlationId };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    const stats = this.catalogService.getCacheStats();
    return [
      '# HELP catalog_cache_hits_total Total Redis cache hits in catalog-service',
      '# TYPE catalog_cache_hits_total counter',
      `catalog_cache_hits_total ${stats.hits}`,
      '# HELP catalog_cache_misses_total Total Redis cache misses in catalog-service',
      '# TYPE catalog_cache_misses_total counter',
      `catalog_cache_misses_total ${stats.misses}`,
      '# HELP catalog_cache_hit_rate Current Redis cache hit ratio in catalog-service',
      '# TYPE catalog_cache_hit_rate gauge',
      `catalog_cache_hit_rate ${stats.hitRate}`,
      '',
    ].join('\n');
  }

  @Get('v1/catalog/products/ean/:ean')
  async findByEan(@Param('ean') ean: string) {
    return this.catalogService.findByEan(ean);
  }

  /** Batch lookup for inventory screens: ?ids=uuid1,uuid2 (max 100). Includes inactive/merged rows. */
  @Get('v1/catalog/products/by-ids')
  async findByIds(@Query('ids') idsRaw = '') {
    return this.catalogService.findByIds(idsRaw);
  }

  @Get('v1/catalog/products/search')
  async search(@Query('q') query = '', @Query('limit') limitRaw?: string) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    return this.catalogService.searchProducts(query, Number.isNaN(limit) ? 20 : limit);
  }

  @Post('v1/catalog/products')
  async createProduct(
    @Body() dto: CreateProductDto,
    @Headers('x-user-role') userRole?: string,
    @Headers('x-user-id') userId = '',
    @Headers('x-correlation-id') correlationId = '',
  ) {
    this.assertAdmin(userRole);
    return this.catalogService.createProduct(dto, userId, correlationId);
  }

  @Patch('v1/catalog/products/:id')
  async updateProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @Headers('x-user-role') userRole?: string,
    @Headers('x-user-id') userId = '',
    @Headers('x-correlation-id') correlationId = '',
  ) {
    this.assertAdmin(userRole);
    return this.catalogService.updateProduct(id, dto, userId, correlationId);
  }

  @Post('v1/catalog/products/merge')
  @HttpCode(HttpStatus.OK)
  async mergeProducts(
    @Body() dto: MergeProductsDto,
    @Headers('x-user-role') userRole?: string,
    @Headers('x-user-id') userId = '',
    @Headers('x-correlation-id') correlationId = '',
  ) {
    this.assertAdmin(userRole);
    return this.catalogService.mergeDuplicateProducts(
      dto.sourceId,
      dto.targetId,
      userId,
      correlationId,
    );
  }
}
