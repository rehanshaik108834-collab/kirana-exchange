"""Tests for Rolling-Origin Backtester and Go/No-Go Gate #3 verification."""

import pandas as pd
from forecast.ml.backtest import RollingOriginBacktester
from forecast.ml.benchmark_runner import generate_benchmark_panel
from forecast.ml.models import (
    AdaptiveEnsembleForecaster,
    LightGBMForecaster,
    MovingAverageForecaster,
    NaiveForecaster,
    SeasonalNaiveForecaster,
)


def test_generate_origins():
    dates = pd.date_range("2026-01-01", periods=60, freq="D")
    df = pd.DataFrame(
        {
            "shop_id": ["s1"] * 60,
            "product_id": ["p1"] * 60,
            "sale_date": dates,
            "qty_sold": [10] * 60,
            "stockout_flag": [False] * 60,
        }
    )
    backtester = RollingOriginBacktester(horizon=7, min_train_days=28, step_days=7)
    origins = backtester.generate_origins(df, num_origins=3)

    assert len(origins) == 3
    # Check that origins are ordered chronologically
    assert origins[0] < origins[1] < origins[2]
    # Check that earliest origin allows min_train_days
    assert (origins[0] - dates[0]).days >= 28
    # Check that latest origin allows horizon days before end
    assert (dates[-1] - origins[-1]).days >= 6


def test_gate_3_ml_beats_naive_baseline():
    """GO/NO-GO GATE #3 FORMAL VERIFICATION:

    The trained ML forecasting model (LightGBM / Adaptive Ensemble)
    must strictly beat the Naive baseline on WAPE over rolling-origin backtests.
    """
    # Generate 60-day realistic kirana panel (2 shops, 3 products)
    panel = generate_benchmark_panel(
        num_shops=2,
        num_products=3,
        num_days=60,
        start_date="2026-01-01",
        seed=101,
    )

    backtester = RollingOriginBacktester(
        horizon=7,
        min_train_days=35,
        step_days=7,
    )

    models = {
        "Naive": NaiveForecaster(),
        "SeasonalNaive": SeasonalNaiveForecaster(season_length=7),
        "MovingAverage": MovingAverageForecaster(window=14),
        "LightGBM": LightGBMForecaster(n_estimators=50, learning_rate=0.08),
        "AdaptiveEnsemble": AdaptiveEnsembleForecaster(n_estimators=50, learning_rate=0.08),
    }

    summary = backtester.run_backtest(panel, models=models, num_origins=2)

    # 1. Assert Gate #3 passes
    assert summary.passed_gate_3 is True, f"Gate #3 failed: {summary.gate_3_report}"
    assert summary.gate_3_margin > 0.0

    # 2. Assert LightGBM or AdaptiveEnsemble WAPE is lower than Naive
    tbl = summary.results_table.set_index("model")
    naive_wape = tbl.loc["Naive", "wape"]
    best_ml_wape = min(tbl.loc["LightGBM", "wape"], tbl.loc["AdaptiveEnsemble", "wape"])

    assert best_ml_wape < naive_wape, f"ML WAPE ({best_ml_wape}) >= Naive ({naive_wape})"
    assert len(summary.gate_3_report) > 0
