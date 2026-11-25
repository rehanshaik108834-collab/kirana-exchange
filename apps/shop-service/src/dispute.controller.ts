import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { type DisputeActor, DisputeService } from './dispute.service';
import { CreateDisputeDto, ResolveDisputeDto } from './dto/dispute.dto';
import type { DisputeStatus } from './entities/dispute.entity';

@Controller('v1/shops/disputes')
export class DisputeController {
  constructor(private readonly disputeService: DisputeService) {}

  private extractActor(headers: Record<string, string | undefined>): DisputeActor {
    const userId = headers['x-user-id'];
    const role = headers['x-user-role'];
    const shopId = headers['x-shop-id'];
    if (!userId || !role) {
      throw new UnauthorizedException('Missing authenticated identity');
    }
    return { userId, role, shopId };
  }

  @Post()
  createDispute(
    @Body() dto: CreateDisputeDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.disputeService.createDispute(dto, this.extractActor(headers));
  }

  @Get('mine')
  listMine(@Headers() headers: Record<string, string | undefined>) {
    return this.disputeService.listMyDisputes(this.extractActor(headers));
  }

  @Get()
  listAdminQueue(
    @Query('status') status: DisputeStatus | undefined,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.disputeService.listAdminQueue(this.extractActor(headers), status);
  }

  @Patch(':id/resolve')
  resolveDispute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.disputeService.resolveDispute(
      id,
      dto,
      this.extractActor(headers),
      headers['x-correlation-id'],
    );
  }
}
