"""Unit tests for forecasting evaluation metrics."""

import numpy as np
from forecast.ml.metrics import (
    compute_bias,
    compute_mae,
    compute_rmse,
    compute_wape,
    evaluate_forecast,
)


def test_compute_wape_exact():
    # Actual: [10, 20, 30] (sum = 60)
    # Pred:   [12, 18, 33] (abs errors = [2, 2, 3], sum = 7)
    # WAPE = 7 / 60 ≈ 0.1166667
    actuals = np.array([10.0, 20.0, 30.0])
    preds = np.array([12.0, 18.0, 33.0])
    wape = compute_wape(actuals, preds)
    assert np.isclose(wape, 7.0 / 60.0)


def test_compute_wape_edge_cases():
    # Perfect forecast
    assert compute_wape([10, 20], [10, 20]) == 0.0

    # All-zero actuals and all-zero preds
    assert compute_wape([0, 0], [0, 0]) == 0.0

    # All-zero actuals with non-zero preds
    assert compute_wape([0, 0], [5, 5]) == 1.0


def test_compute_bias():
    actuals = np.array([10.0, 20.0])  # sum = 30

    # Over-forecasting (+5)
    over_pred = np.array([12.0, 23.0])  # sum = 35 -> (35 - 30)/30 = +0.1667
    assert np.isclose(compute_bias(actuals, over_pred), 5.0 / 30.0)

    # Under-forecasting (-6)
    under_pred = np.array([8.0, 16.0])  # sum = 24 -> (24 - 30)/30 = -0.20
    assert np.isclose(compute_bias(actuals, under_pred), -6.0 / 30.0)

    # All zeros
    assert compute_bias([0, 0], [0, 0]) == 0.0


def test_compute_mae_and_rmse():
    actuals = np.array([10.0, 20.0])
    preds = np.array([12.0, 24.0])  # errors = [2, 4]
    assert compute_mae(actuals, preds) == 3.0
    # RMSE = sqrt((4 + 16)/2) = sqrt(10) ≈ 3.162277
    assert np.isclose(compute_rmse(actuals, preds), np.sqrt(10.0))


def test_evaluate_forecast():
    actuals = [10, 20, 30]
    preds = [10, 20, 30]
    res = evaluate_forecast(actuals, preds)
    assert res["wape"] == 0.0
    assert res["bias"] == 0.0
    assert res["mae"] == 0.0
    assert res["rmse"] == 0.0
    assert res["n_samples"] == 3
