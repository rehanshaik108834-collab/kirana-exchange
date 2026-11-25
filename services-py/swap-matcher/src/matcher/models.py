"""Pydantic contracts for swap-service snapshots and swap.match.found.v1 events."""

import uuid
from datetime import UTC, date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ListingItem(BaseModel):
    """Open surplus listing from swap-service's internal matching snapshot."""

    model_config = ConfigDict(populate_by_name=True)

    listing_id: str = Field(alias="listingId")
    seller_shop_id: str = Field(alias="sellerShopId")
    batch_id: str = Field(alias="batchId")
    product_id: str = Field(alias="productId")
    state: str = ""
    qty: int = Field(gt=0)
    price: float = Field(gt=0.0)
    cost_price: float = Field(alias="costPrice", ge=0.0)
    batch_expiry_date: date = Field(alias="batchExpiryDate")
    lat: float
    lng: float
    reputation_score: float = Field(alias="reputationScore", default=100.0, ge=0.0, le=100.0)


class ShortageItem(BaseModel):
    """Open shortage request from swap-service's internal matching snapshot."""

    model_config = ConfigDict(populate_by_name=True)

    shortage_id: str = Field(alias="shortageId")
    buyer_shop_id: str = Field(alias="buyerShopId")
    product_id: str = Field(alias="productId")
    state: str = ""
    reorder_qty: int = Field(alias="reorderQty", gt=0)
    max_unit_price: float | None = Field(alias="maxUnitPrice", default=None)
    lat: float
    lng: float
    swap_radius_km: float = Field(alias="swapRadiusKm", default=2.0, gt=0.0)
    reputation_score: float = Field(alias="reputationScore", default=100.0, ge=0.0, le=100.0)


class StateMatchingSnapshot(BaseModel):
    """Canonical response returned by GET /v1/swaps/internal/matching-snapshot?state=..."""

    model_config = ConfigDict(populate_by_name=True)

    state: str
    generated_at: str = Field(alias="generatedAt")
    listings: list[ListingItem] = Field(default_factory=list)
    shortages: list[ShortageItem] = Field(default_factory=list)

    def hydrated_items(self) -> tuple[list[ListingItem], list[ShortageItem]]:
        """Stamp snapshot-level state onto items that omit an explicit per-item state."""
        listings = [
            item if item.state else item.model_copy(update={"state": self.state})
            for item in self.listings
        ]
        shortages = [
            item if item.state else item.model_copy(update={"state": self.state})
            for item in self.shortages
        ]
        return listings, shortages


class MatchAssignment(BaseModel):
    """Optimal matched (surplus listing -> shortage buyer) assignment."""

    listing_id: str
    seller_shop_id: str
    buyer_shop_id: str
    shortage_id: str
    product_id: str
    state: str
    matched_qty: int
    offered_price: float
    distance_km: float
    cost: float
    rank_score: float


def build_match_found_envelope(
    match: MatchAssignment,
    *,
    correlation_id: str | None = None,
    producer: str = "swap-matcher",
    occurred_at: datetime | None = None,
) -> dict[str, Any]:
    """Build a canonical KiranaEventEnvelope conforming to swap.match.found.v1.json."""
    ts = occurred_at or datetime.now(UTC)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)

    corr = correlation_id or str(uuid.uuid4())
    try:
        uuid.UUID(corr)
    except ValueError:
        corr = str(uuid.uuid4())

    return {
        "id": str(uuid.uuid4()),
        "type": "swap.match.found.v1",
        "version": 1,
        "occurredAt": ts.isoformat().replace("+00:00", "Z"),
        "correlationId": corr,
        "producer": producer,
        "payload": {
            "listingId": match.listing_id,
            "candidateShopId": match.buyer_shop_id,
            "productId": match.product_id,
            "distanceKm": match.distance_km,
            "rankScore": match.rank_score,
            "offeredPrice": match.offered_price,
        },
    }
