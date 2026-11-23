"""Unit tests for the inventory risk engine and safety-stock reorder math."""

import math
from datetime import date

from forecast.ml.risk import (
    MAX_DAYS_OF_COVER,
    compute_reorder_qty,
    evaluate_batch_risks,
    select_action_ladder,
)


def test_reorder_qty_includes_safety_stock_buffer():
    # predicted=20, upper=27, lead_time=2 -> safety = 7 * sqrt(2/7) ~= 3.74 -> target=23.74
    # available=10 -> ceil(13.74) = 14
    expected_safety = 7.0 * math.sqrt(2.0 / 7.0)
    expected = math.ceil(20.0 + expected_safety - 10)
    assert compute_reorder_qty(20.0, 27.0, 10, lead_time_days=2) == expected
    assert compute_reorder_qty(20.0, 27.0, 30, lead_time_days=2) == 0


def test_available_qty_excludes_reserved_stock():
    flags = evaluate_batch_risks(
        batch_id="b1",
        shop_id="s1",
        product_id="p1",
        qty=15,
        reserved_qty=15,
        expiry_date=date(2026, 4, 5),
        forecast_daily_demand=0.0,
        as_of_date=date(2026, 4, 1),
    )
    assert flags == []


def test_zero_demand_caps_days_of_cover_at_999_99():
    flags = evaluate_batch_risks(
        batch_id="b2",
        shop_id="s1",
        product_id="p1",
        qty=10,
        reserved_qty=2,
        expiry_date=date(2026, 12, 31),
        forecast_daily_demand=0.0,
        as_of_date=date(2026, 4, 1),
    )
    assert len(flags) == 1
    assert flags[0].risk_type == "DEAD_STOCK"
    assert flags[0].days_of_cover == MAX_DAYS_OF_COVER
    assert flags[0].expected_unsold_qty == 8
    assert flags[0].recommended_action == "RETURN_TO_DISTRIBUTOR"


def test_expiry_and_dead_stock_dual_flags_and_action_ladder():
    # 100 units, daily demand 1.5 -> days_of_cover = 66.67 (> 45 DEAD_STOCK)
    # expiry in 20 days -> sell-through 30 -> 70 unsold (EXPIRY)
    flags = evaluate_batch_risks(
        batch_id="b3",
        shop_id="s1",
        product_id="p1",
        qty=100,
        reserved_qty=0,
        expiry_date=date(2026, 4, 21),
        forecast_daily_demand=1.5,
        as_of_date=date(2026, 4, 1),
    )
    by_type = {f.risk_type: f for f in flags}
    assert set(by_type.keys()) == {"EXPIRY", "DEAD_STOCK"}
    assert by_type["EXPIRY"].expected_unsold_qty == 70
    assert by_type["EXPIRY"].recommended_action == "SWAP_TO_NEIGHBOUR"
    assert by_type["DEAD_STOCK"].recommended_action == "SWAP_TO_NEIGHBOUR"


def test_action_ladder_all_three_tiers():
    assert select_action_ladder("EXPIRY", 0, 10.0, 5) == "RETURN_TO_DISTRIBUTOR"
    assert select_action_ladder("DEAD_STOCK", 120, 95.0, 20) == "RETURN_TO_DISTRIBUTOR"
    assert select_action_ladder("EXPIRY", 4, 10.0, 5) == "BUNDLE_DISCOUNT"
    assert select_action_ladder("EXPIRY", 20, 30.0, 1) == "BUNDLE_DISCOUNT"
    assert select_action_ladder("EXPIRY", 20, 30.0, 8) == "SWAP_TO_NEIGHBOUR"
