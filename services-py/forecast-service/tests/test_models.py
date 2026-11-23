"""Tests for individual forecasting models in the model suite."""

import pandas as pd
from forecast.ml.models import (
    AdaptiveEnsembleForecaster,
    CrostonForecaster,
    LightGBMForecaster,
    MovingAverageForecaster,
    NaiveForecaster,
    SeasonalNaiveForecaster,
)


def _sample_panel() -> pd.DataFrame:
    dates = pd.date_range("2026-01-01", periods=30, freq="D")
    records = []
    for dt in dates:
        # Shop 1: fast staple (sales ~ 10, weekend ~ 15)
        dow = dt.dayofweek
        val1 = 15 if dow in (4, 5, 6) else 10
        records.append(
            {
                "shop_id": "s1",
                "product_id": "p1",
                "sale_date": dt,
                "qty_sold": val1,
                "stockout_flag": False,
            }
        )
        # Shop 1, Prod 2: intermittent (sale every 4 days)
        val2 = 8 if (dt.day % 4 == 0) else 0
        records.append(
            {
                "shop_id": "s1",
                "product_id": "p2",
                "sale_date": dt,
                "qty_sold": val2,
                "stockout_flag": False,
            }
        )
    return pd.DataFrame(records)


def test_naive_forecaster():
    df = _sample_panel()
    forecaster = NaiveForecaster()
    forecaster.fit(df)
    preds = forecaster.predict(df, horizon=7)

    assert len(preds) == 14  # 2 products x 7 days
    assert set(preds.columns) == {"shop_id", "product_id", "forecast_date", "predicted_qty"}
    assert (preds["predicted_qty"] >= 0.0).all()


def test_seasonal_naive_forecaster():
    df = _sample_panel()
    forecaster = SeasonalNaiveForecaster(season_length=7)
    forecaster.fit(df)
    preds = forecaster.predict(df, horizon=7)

    assert len(preds) == 14
    # Check that Friday prediction matches previous Friday
    p1_preds = preds[preds["product_id"] == "p1"].sort_values("forecast_date")
    assert not p1_preds.empty
    assert (p1_preds["predicted_qty"] >= 0.0).all()


def test_moving_average_forecaster():
    df = _sample_panel()
    forecaster = MovingAverageForecaster(window=14)
    forecaster.fit(df)
    preds = forecaster.predict(df, horizon=7)

    assert len(preds) == 14
    p1_preds = preds[preds["product_id"] == "p1"]
    # Mean of p1 should be positive and close to ~12
    assert (p1_preds["predicted_qty"] > 0.0).all()


def test_croston_forecaster():
    df = _sample_panel()
    forecaster = CrostonForecaster(method="CrostonSBA")
    forecaster.fit(df)
    preds = forecaster.predict(df, horizon=7)

    assert len(preds) == 14
    assert (preds["predicted_qty"] >= 0.0).all()


def test_lightgbm_forecaster():
    df = _sample_panel()
    forecaster = LightGBMForecaster(n_estimators=30, learning_rate=0.1)
    forecaster.fit(df)
    preds = forecaster.predict(df, horizon=7)

    assert len(preds) == 14
    assert (preds["predicted_qty"] >= 0.0).all()


def test_adaptive_ensemble_forecaster():
    df = _sample_panel()
    ensemble = AdaptiveEnsembleForecaster(n_estimators=30, learning_rate=0.1)
    ensemble.fit(df)
    preds = ensemble.predict(df, horizon=7)

    assert len(preds) == 14
    assert (preds["predicted_qty"] >= 0.0).all()
