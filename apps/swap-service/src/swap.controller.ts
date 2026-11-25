import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  CandidateSearchQueryDto,
  CounterOfferDto,
  CreateListingDto,
  CreateOfferDto,
  CreateShortageDto,
} from './dto/swap.dto';
import { computeSuggestedPrice } from './pricing';
import { SwapActor, SwapService } from './swap.service';

@Controller('v1/swaps')
export class SwapController {
  constructor(private readonly swapService: SwapService) {}

  private extractActor(headers: Record<string, string | undefined>): SwapActor {
    const userId = headers['x-user-id'];
    const role = headers['x-user-role'];
    const shopId = headers['x-shop-id'];

    if (!userId || !role) {
      throw new ForbiddenException('Missing verified gateway identity headers');
    }

    return { userId, role, shopId };
  }

  @Get('price-suggestion')
  getPriceSuggestion(
    @Query('costPrice') costPriceRaw: string,
    @Query('batchExpiryDate') batchExpiryDate: string,
    @Query('daysOfCover') daysOfCoverRaw?: string,
  ) {
    const costPrice = Number(costPriceRaw);
    if (!Number.isFinite(costPrice) || costPrice <= 0 || !batchExpiryDate) {
      throw new BadRequestException('Valid costPrice (> 0) and batchExpiryDate are required');
    }
    const daysOfCover =
      daysOfCoverRaw !== undefined && daysOfCoverRaw !== '' ? Number(daysOfCoverRaw) : undefined;
    return computeSuggestedPrice({ costPrice, batchExpiryDate, daysOfCover });
  }

  @Post('listings')
  createListing(
    @Body() dto: CreateListingDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.swapService.createListing(
      dto,
      this.extractActor(headers),
      headers['idempotency-key'],
      headers['x-correlation-id'],
    );
  }

  @Get('listings/mine')
  getMyListings(@Headers() headers: Record<string, string | undefined>) {
    return this.swapService.getMyListings(this.extractActor(headers));
  }

  @Get('listings/drafts')
  getRiskDrafts(@Headers() headers: Record<string, string | undefined>) {
    return this.swapService.getRiskListingDrafts(this.extractActor(headers));
  }

  @Post('listings/:id/cancel')
  cancelListing(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.swapService.cancelListing(id, this.extractActor(headers));
  }

  @Post('shortages')
  createShortage(
    @Body() dto: CreateShortageDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.swapService.createOrUpdateShortage(dto, this.extractActor(headers));
  }

  @Get('candidates')
  searchCandidates(
    @Query() query: CandidateSearchQueryDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.swapService.searchCandidates(query, this.extractActor(headers));
  }

  @Post('offers')
  createOffer(@Body() dto: CreateOfferDto, @Headers() headers: Record<string, string | undefined>) {
    return this.swapService.createOffer(
      dto,
      this.extractActor(headers),
      headers['idempotency-key'],
    );
  }

  @Get('offers')
  getMyOffers(@Headers() headers: Record<string, string | undefined>) {
    return this.swapService.getMyOffers(this.extractActor(headers));
  }

  @Post('offers/:id/counter')
  counterOffer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CounterOfferDto,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.swapService.counterOffer(id, dto, this.extractActor(headers));
  }

  @Post('offers/:id/accept')
  acceptOffer(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.swapService.acceptOffer(
      id,
      this.extractActor(headers),
      headers['x-correlation-id'],
    );
  }

  @Post('offers/:id/reject')
  rejectOffer(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return this.swapService.rejectOffer(id, this.extractActor(headers));
  }

  @Get('internal/matching-snapshot')
  getMatchingSnapshot(
    @Query('state') state: string,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    const role = (headers['x-user-role'] || '').toLowerCase();
    const internalCaller = headers['x-internal-service'];
    if (role !== 'admin' && internalCaller !== 'swap-matcher') {
      throw new ForbiddenException('Admin or swap-matcher identity required');
    }
    if (!state) {
      throw new BadRequestException('Query parameter state is required');
    }
    return this.swapService.getMatchingSnapshot(state);
  }
}
