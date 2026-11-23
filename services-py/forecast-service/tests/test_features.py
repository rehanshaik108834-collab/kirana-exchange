"""Tests for past-only feature pipeline and zero-leakage verification."""

from datetime import date

import numpy as np
import pandas as pd
from forecast.ml.calendar_features import add_calendar_features
from forecast.ml.features import (
    FEATURE_COLUMNS,
    build_inference_features,
    build_training_features,
    complete_daily_grid,
)


def _generate_synthetic_panel(
    num_shops: int = 2,
    num_products: int = 2,
    num_days: int = 90,
    start_date: str = "2026-01-01",
    seed: int = 42,
) -> pd.DataFrame:
    """Generate a clean synthetic daily panel for testing."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range(start_date, periods=num_days, freq="D")
    records = []

    for s_idx in range(num_shops):
        s_id = f"shop-{s_idx:02d}"
        for p_idx in range(num_products):
            p_id = f"prod-{p_idx:02d}"
            # Baseline daily demand ~ Poisson(8)
            sales = rng.poisson(lam=8.0, size=num_days)
            # Occasional stockout (5% probability)
            stockouts = rng.random(size=num_days) < 0.05
            sales = np.where(stockouts, 0, sales)

            for d_idx, dt in enumerate(dates):
                records.append(
                    {
                        "shop_id": s_id,
                        "product_id": p_id,
                        "sale_date": dt,
                        "qty_sold": int(sales[d_idx]),
                        "stockout_flag": bool(stockouts[d_idx]),
                    }
                )

    return pd.DataFrame(records)


def test_calendar_features():
    df = pd.DataFrame(
        {
            "sale_date": [
                date(2026, 11, 6),  # 2 days before Diwali (pre-festival)
                date(2026, 11, 7),  # 1 day before Diwali (pre-festival)
                date(2026, 11, 8),  # Diwali (festival day)
                date(2026, 11, 9),  # Monday after Diwali
            ]
        }
    )
    res = add_calendar_features(df, date_col="sale_date")

    # Nov 6, 2026 is Friday (dow=4, is_weekend=1)
    assert res.iloc[0]["day_of_week"] == 4
    assert res.iloc[0]["is_weekend"] == 1
    assert res.iloc[0]["is_festival_day"] == 0
    assert res.iloc[0]["is_pre_festival_2d"] == 1
    assert res.iloc[0]["days_to_next_festival"] == 2

    # Nov 7, 2026 is Saturday (dow=5, is_weekend=1)
    assert res.iloc[1]["is_pre_festival_2d"] == 1
    assert res.iloc[1]["days_to_next_festival"] == 1

    # Nov 8, 2026 is Sunday (Diwali)
    assert res.iloc[2]["is_festival_day"] == 1
    assert res.iloc[2]["days_to_next_festival"] == 0

    # Sin/Cos doy within [-1, 1]
    assert (-1.0 <= res["doy_sin"]).all() and (res["doy_sin"] <= 1.0).all()
    assert (-1.0 <= res["doy_cos"]).all() and (res["doy_cos"] <= 1.0).all()


def test_complete_daily_grid():
    # Provide sparse panel with date gap
    df = pd.DataFrame(
        {
            "shop_id": ["shop-1", "shop-1"],
            "product_id": ["prod-1", "prod-1"],
            "sale_date": ["2026-01-01", "2026-01-04"],
            "qty_sold": [10, 20],
            "stockout_flag": [False, False],
        }
    )
    gridded = complete_daily_grid(df)
    assert len(gridded) == 4
    # Gaps filled with 0 sales and False stockout
    assert list(gridded["qty_sold"]) == [10, 0, 0, 20]
    assert list(gridded["stockout_flag"]) == [False, False, False, False]


def test_days_since_last_sale():
    df = pd.DataFrame(
        {
            "shop_id": ["s1"] * 5,
            "product_id": ["p1"] * 5,
            "sale_date": pd.date_range("2026-01-01", periods=5, freq="D"),
            "qty_sold": [5, 0, 0, 10, 0],
            "stockout_flag": [False] * 5,
        }
    )
    feats = build_training_features(df)
    # Day 0: no prior sale -> 90
    # Day 1: 1 day since sale on Day 0
    # Day 2: 2 days since sale on Day 0
    # Day 3: 3 days since sale on Day 0 (sale happens today, but features depend on PAST)
    # Day 4: 1 day since sale on Day 3
    assert list(feats["days_since_last_sale"]) == [90, 1, 2, 3, 1]


def test_feature_columns_complete_and_finite():
    panel = _generate_synthetic_panel(num_shops=1, num_products=1, num_days=30)
    feats = build_training_features(panel)

    for col in FEATURE_COLUMNS:
        assert col in feats.columns
        assert not feats[col].isna().any(), f"Column {col} has NaN"
        assert np.isfinite(feats[col]).all(), f"Column {col} has infinite values"


def test_adversarial_future_mutation_zero_leakage():
    """MATHEMATICAL ZERO-LEAKAGE VERIFICATION GATE:

    Features at row sale_date = t must be bit-identical whether future rows
    (sale_date >= t) are untouched or radically mutated.
    """
    panel = _generate_synthetic_panel(num_shops=2, num_products=2, num_days=90, seed=123)

    cutoff_date = pd.Timestamp("2026-03-01")  # Day 60

    # 1. Compute features on original unmutated panel
    feats_original = build_training_features(panel)

    # 2. Mutate future rows violently (all dates >= cutoff_date)
    mutated_panel = panel.copy()
    future_mask = pd.to_datetime(mutated_panel["sale_date"]) >= cutoff_date

    mutated_panel.loc[future_mask, "qty_sold"] = 999_999
    mutated_panel.loc[future_mask, "stockout_flag"] = True

    # Compute features on violently mutated panel
    feats_mutated = build_training_features(mutated_panel)

    # 3. Assert rows at cutoff_date and prior (sale_date <= cutoff_date) are BIT-IDENTICAL
    past_mask = pd.to_datetime(feats_original["sale_date"]) <= cutoff_date

    orig_sub = feats_original[past_mask].reset_index(drop=True)
    mut_sub = feats_mutated[past_mask].reset_index(drop=True)

    for col in FEATURE_COLUMNS:
        orig_vals = orig_sub[col].to_numpy()
        mut_vals = mut_sub[col].to_numpy()
        np.testing.assert_array_equal(
            orig_vals,
            mut_vals,
            err_msg=f"Zero-leakage violated in feature '{col}' at or before cutoff!",
        )


def test_inference_features_hard_cutoff_guard():
    """Inference features at forecast_date must be identical whether future rows

    were passed in or not.
    """
    panel = _generate_synthetic_panel(num_shops=2, num_products=2, num_days=90, seed=456)
    forecast_date = "2026-03-01"  # Day 60
    target_dt = pd.Timestamp(forecast_date)

    # Panel truncated to strictly past (< forecast_date)
    truncated_panel = panel[pd.to_datetime(panel["sale_date"]) < target_dt].copy()

    inf_from_full = build_inference_features(panel, forecast_date=forecast_date)
    inf_from_truncated = build_inference_features(truncated_panel, forecast_date=forecast_date)

    assert len(inf_from_full) == 4  # 2 shops x 2 products
    assert len(inf_from_truncated) == 4

    for col in FEATURE_COLUMNS:
        np.testing.assert_array_equal(
            inf_from_full[col].to_numpy(),
            inf_from_truncated[col].to_numpy(),
            err_msg=f"Inference feature '{col}' differs between full and truncated history!",
        )


def test_cross_series_isolation():
    """Mutating Shop B must have zero impact on Shop A's features."""
    panel = _generate_synthetic_panel(num_shops=2, num_products=2, num_days=60, seed=789)

    orig_feats = build_training_features(panel)

    # Mutate Shop 1 entirely
    mutated_panel = panel.copy()
    s1_mask = mutated_panel["shop_id"] == "shop-01"
    mutated_panel.loc[s1_mask, "qty_sold"] = 888

    mut_feats = build_training_features(mutated_panel)

    # Shop 0 features must be bit-identical
    s0_orig = orig_feats[orig_feats["shop_id"] == "shop-00"].reset_index(drop=True)
    s0_mut = mut_feats[mut_feats["shop_id"] == "shop-00"].reset_index(drop=True)

    for col in FEATURE_COLUMNS:
        np.testing.assert_array_equal(
            s0_orig[col].to_numpy(),
            s0_mut[col].to_numpy(),
            err_msg=f"Cross-series leak in feature '{col}'!",
        )
