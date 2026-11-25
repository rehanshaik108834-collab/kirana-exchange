import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  CloseWindowDto,
  CreateGroupBuyWindowDto,
  ListWindowsQueryDto,
  UpsertCommitmentDto,
} from './dto/groupbuy.dto';
import { type GroupBuyActor, GroupBuyService } from './groupbuy.service';

@Controller('v1/groupbuy')
export class GroupBuyController {
  constructor(private readonly groupBuyService: GroupBuyService) {}

  private extractActor(headers: Record<string, string | undefined>): GroupBuyActor {
    const userId = headers['x-user-id'];
    const role = headers['x-user-role'];
    const shopId = headers['x-shop-id'];

    if (!userId || !role) {
      throw new ForbiddenException('Missing verified gateway identity headers');
    }
    return { userId, role, shopId };
  }

  @Post('windows')
  createWindow(
    @Body() dto: CreateGroupBuyWindowDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.groupBuyService.createWindow(dto, this.extractActor(headers));
  }

  @Get('windows')
  listWindows(@Query() query: ListWindowsQueryDto) {
    return this.groupBuyService.listWindows(query);
  }

  @Get('windows/:id')
  getWindowDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.groupBuyService.getWindowDetail(id, this.extractActor(headers));
  }

  @Put('windows/:id/commitments')
  upsertCommitment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertCommitmentDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.groupBuyService.upsertCommitment(
      id,
      dto,
      this.extractActor(headers),
      headers['idempotency-key'],
    );
  }

  @Delete('windows/:id/commitments/:productId')
  removeCommitment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.groupBuyService.removeCommitment(id, productId, this.extractActor(headers));
  }

  @Post('windows/:id/close')
  closeWindow(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseWindowDto,
    @Query('force') forceRaw: string | undefined,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    const actor = this.extractActor(headers);
    if (actor.role !== 'admin') {
      throw new ForbiddenException('Admin role required to manually trigger window closure');
    }
    return this.groupBuyService.closeWindow(id, {
      force: forceRaw === 'true',
      extensionHours: dto?.extensionHours,
      correlationId: headers['x-correlation-id'],
    });
  }

  @Get('allocations/mine')
  getMyAllocations(@Headers() headers: Record<string, string | undefined>) {
    return this.groupBuyService.getMyAllocations(this.extractActor(headers));
  }
}
