"""Inventory risk engine: safety-stock reorders, days-of-cover, and action ladder."""

import math
from dataclasses import dataclass
from datetime import date
from typing import Literal

RiskType = Literal["DEAD_STOCK", "EXPIRY"]
RecommendedAction = Literal[
    "SWAP_TO_NEIGHBOUR",
    "BUNDLE_DISCOUNT",
    "RETURN_TO_DISTRIBUTOR",
]

DEAD_STOCK_DOC_THRESHOLD: float = 45.0
EXPIRY_LOOKAHEAD_DAYS: int = 60
SWAP_MIN_EXPIRY_DAYS: int = 7
DISTRIBUTOR_RETURN_DOC_THRESHOLD: float = 90.0
MAX_DAYS_OF_COVER: float = 999.99


@dataclass(frozen=True)
class BatchRiskResult:
    batch_id: str
    shop_id: str
    product_id: str
    risk_type: RiskType
    days_of_cover: float
    expected_unsold_qty: int
    recommended_action: RecommendedAction


def compute_reorder_qty(
    predicted_7d_qty: float,
    upper_bound_7d_qty: float,
    total_available_qty: int,
    lead_time_days: int = 2,
) -> int:
    """Compute safety-stock-buffered weekly reorder quantity for the Order-This list.

    Safety stock scales the upper prediction interval margin by sqrt(lead_time_days / 7).
    """
    pred = max(0.0, float(predicted_7d_qty))
    upper = max(pred, float(upper_bound_7d_qty))
    available = max(0, int(total_available_qty))
    lead_days = max(1, int(lead_time_days))

    safety_stock = (upper - pred) * math.sqrt(lead_days / 7.0)
    target_stock = pred + safety_stock
    shortfall = target_stock - available
    if shortfall <= 0.0:
        return 0
    return int(math.ceil(shortfall))


def select_action_ladder(
    risk_type: RiskType,
    days_to_expiry: int,
    days_of_cover: float,
    expected_unsold_qty: int,
) -> RecommendedAction:
    """Select the optimal 3-step kirana clearance action.

    1. RETURN_TO_DISTRIBUTOR: already expired (days_to_expiry <= 0) OR extreme stagnant
       dead stock (DEAD_STOCK with days_of_cover >= 90).
    2. BUNDLE_DISCOUNT: tight expiry window (< 7 days) where P2P swap handover is too slow,
       OR tiny surplus (< 2 units).
    3. SWAP_TO_NEIGHBOUR: default primary action when >= 7 days remain and >= 2 unsold units.
    """
    if days_to_expiry <= 0:
        return "RETURN_TO_DISTRIBUTOR"
    if risk_type == "DEAD_STOCK" and days_of_cover >= DISTRIBUTOR_RETURN_DOC_THRESHOLD:
        return "RETURN_TO_DISTRIBUTOR"
    if days_to_expiry < SWAP_MIN_EXPIRY_DAYS or expected_unsold_qty < 2:
        return "BUNDLE_DISCOUNT"
    return "SWAP_TO_NEIGHBOUR"


def evaluate_batch_risks(
    *,
    batch_id: str,
    shop_id: str,
    product_id: str,
    qty: int,
    reserved_qty: int,
    expiry_date: date,
    forecast_daily_demand: float,
    as_of_date: date,
) -> list[BatchRiskResult]:
    """Evaluate a single inventory batch for EXPIRY and DEAD_STOCK risks.

    Uses strictly unreserved stock: available_qty = max(0, qty - reserved_qty).
    Caps days_of_cover at 999.99 so PostgreSQL NUMERIC(8,2) never overflows.
    """
    available_qty = max(0, int(qty) - max(0, int(reserved_qty)))
    if available_qty == 0:
        return []

    daily_demand = max(0.0, float(forecast_daily_demand))
    if daily_demand <= 1e-6:
        days_of_cover = MAX_DAYS_OF_COVER
    else:
        days_of_cover = min(MAX_DAYS_OF_COVER, round(available_qty / daily_demand, 2))

    days_to_expiry = (expiry_date - as_of_date).days
    flags: list[BatchRiskResult] = []

    # 1. EXPIRY risk evaluation
    if days_to_expiry <= 0:
        unsold_at_expiry = available_qty
    else:
        projected_sell_through = daily_demand * days_to_expiry
        unsold_at_expiry = int(math.ceil(max(0.0, available_qty - projected_sell_through)))
        unsold_at_expiry = min(available_qty, unsold_at_expiry)

    if days_to_expiry <= 0 or (days_to_expiry <= EXPIRY_LOOKAHEAD_DAYS and unsold_at_expiry > 0):
        flags.append(
            BatchRiskResult(
                batch_id=batch_id,
                shop_id=shop_id,
                product_id=product_id,
                risk_type="EXPIRY",
                days_of_cover=days_of_cover,
                expected_unsold_qty=max(1, unsold_at_expiry),
                recommended_action=select_action_ladder(
                    risk_type="EXPIRY",
                    days_to_expiry=days_to_expiry,
                    days_of_cover=days_of_cover,
                    expected_unsold_qty=max(1, unsold_at_expiry),
                ),
            )
        )

    # 2. DEAD_STOCK risk evaluation
    if days_of_cover > DEAD_STOCK_DOC_THRESHOLD:
        projected_45d = daily_demand * DEAD_STOCK_DOC_THRESHOLD
        unsold_after_45d = int(math.ceil(max(0.0, available_qty - projected_45d)))
        unsold_after_45d = max(1, min(available_qty, unsold_after_45d))
        flags.append(
            BatchRiskResult(
                batch_id=batch_id,
                shop_id=shop_id,
                product_id=product_id,
                risk_type="DEAD_STOCK",
                days_of_cover=days_of_cover,
                expected_unsold_qty=unsold_after_45d,
                recommended_action=select_action_ladder(
                    risk_type="DEAD_STOCK",
                    days_to_expiry=days_to_expiry,
                    days_of_cover=days_of_cover,
                    expected_unsold_qty=unsold_after_45d,
                ),
            )
        )

    return flags
