"""Tests for Syntetos-Boylan demand classification engine."""

import numpy as np
import pandas as pd
from forecast.ml.classifier import (
    ADI_THRESHOLD,
    CV2_THRESHOLD,
    classify_panel,
    classify_series,
)


def test_classifier_thresholds():
    assert ADI_THRESHOLD == 1.32
    assert CV2_THRESHOLD == 0.49


def test_smooth_quadrant():
    # Regular daily demand with low variance
    # Daily sales of 10 for 30 days: ADI = 30/30 = 1.0 (< 1.32), CV^2 = 0.0 (< 0.49)
    qty = np.full(30, 10.0)
    result = classify_series(qty)
    assert result.demand_class == "SMOOTH"
    assert result.adi == 1.0
    assert result.cv2 == 0.0
    assert result.nonzero_days == 30
    assert result.valid_days == 30


def test_erratic_quadrant():
    # Regular daily demand with high variance
    # Alternating sales of 1 and 20 for 30 days:
    # ADI = 1.0 (< 1.32)
    # Mean = 10.5, Std = 9.5 -> CV^2 = (9.5 / 10.5)^2 ≈ 0.8186 (>= 0.49)
    qty = np.array([1.0, 20.0] * 15)
    result = classify_series(qty)
    assert result.demand_class == "ERRATIC"
    assert result.adi == 1.0
    assert result.cv2 >= CV2_THRESHOLD
    assert result.nonzero_days == 30


def test_intermittent_quadrant():
    # Intermittent demand: low frequency, low variance
    # Sale of 5 every 3 days for 30 days:
    # Nonzero days = 10, Valid days = 30 -> ADI = 3.0 (>= 1.32)
    # Nonzero quantities are all 5 -> CV^2 = 0.0 (< 0.49)
    qty = np.zeros(30)
    qty[::3] = 5.0
    result = classify_series(qty)
    assert result.demand_class == "INTERMITTENT"
    assert result.adi == 3.0
    assert result.cv2 == 0.0
    assert result.nonzero_days == 10
    assert result.valid_days == 30


def test_lumpy_quadrant():
    # Lumpy demand: low frequency, high variance
    # Sale every 3 days, alternating between 2 and 30
    qty = np.zeros(30)
    qty[0::6] = 2.0
    qty[3::6] = 30.0
    result = classify_series(qty)
    assert result.demand_class == "LUMPY"
    assert result.adi >= ADI_THRESHOLD
    assert result.cv2 >= CV2_THRESHOLD


def test_stockout_uncensoring_prevents_false_intermittent():
    # Fast-moving staple: 20 days of continuous sales of 10
    # Followed by 10 days of supplier stockout (qty_sold = 0, stockout_flag = True)
    qty = np.array([10.0] * 20 + [0.0] * 10)
    stockout = np.array([False] * 20 + [True] * 10)

    # With stockout uncensoring: censored 10 zero days are excluded from valid_days
    # valid_days = 20, nonzero_days = 20 -> ADI = 1.0 -> SMOOTH
    result_uncensored = classify_series(qty, stockout)
    assert result_uncensored.demand_class == "SMOOTH"
    assert result_uncensored.valid_days == 20
    assert result_uncensored.nonzero_days == 20
    assert result_uncensored.adi == 1.0

    # Without stockout uncensoring: valid_days = 30, nonzero_days = 20 -> ADI = 1.5 -> INTERMITTENT
    result_censored = classify_series(qty)
    assert result_censored.demand_class == "INTERMITTENT"
    assert result_censored.valid_days == 30
    assert result_censored.adi == 1.5


def test_edge_cases():
    # Empty series
    empty = classify_series(np.array([]))
    assert empty.demand_class == "INTERMITTENT"
    assert empty.adi == float("inf")
    assert empty.cv2 == 0.0
    assert empty.nonzero_days == 0
    assert empty.valid_days == 0

    # All-zero series
    all_zero = classify_series(np.zeros(15))
    assert all_zero.demand_class == "INTERMITTENT"
    assert all_zero.adi == float("inf")
    assert all_zero.nonzero_days == 0
    assert all_zero.valid_days == 15

    # Single non-zero observation
    one_sale = classify_series(np.array([0.0, 5.0, 0.0, 0.0]))
    assert one_sale.nonzero_days == 1
    assert one_sale.valid_days == 4
    assert one_sale.adi == 4.0
    assert one_sale.cv2 == 0.0
    assert one_sale.demand_class == "INTERMITTENT"


def test_classify_panel_with_and_without_cutoff():
    dates = pd.date_range("2026-01-01", periods=20, freq="D")
    df = pd.DataFrame(
        {
            "shop_id": ["shop-1"] * 20 + ["shop-2"] * 20,
            "product_id": ["prod-1"] * 20 + ["prod-1"] * 20,
            "sale_date": list(dates) + list(dates),
            "qty_sold": [5] * 20 + [0, 10] * 10,
            "stockout_flag": [False] * 40,
        }
    )

    # 1. Full panel classification
    panel = classify_panel(df)
    assert len(panel) == 2
    shop1 = panel[panel["shop_id"] == "shop-1"].iloc[0]
    shop2 = panel[panel["shop_id"] == "shop-2"].iloc[0]
    assert shop1["demand_class"] == "SMOOTH"
    assert shop2["demand_class"] == "INTERMITTENT"

    # 2. Panel with cutoff_date at day 10
    cutoff = pd.Timestamp("2026-01-11")
    panel_cutoff = classify_panel(df, cutoff_date=cutoff)
    assert len(panel_cutoff) == 2
    s1_cut = panel_cutoff[panel_cutoff["shop_id"] == "shop-1"].iloc[0]
    assert s1_cut["valid_days"] == 10
    assert s1_cut["nonzero_days"] == 10

    # 3. Empty panel
    empty_panel = classify_panel(pd.DataFrame())
    assert empty_panel.empty
    assert "demand_class" in empty_panel.columns
