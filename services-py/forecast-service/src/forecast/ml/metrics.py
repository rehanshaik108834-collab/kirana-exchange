"""Evaluation metrics for demand forecasting in Kirana Exchange.

Includes WAPE (Weighted Absolute Percentage Error), Bias, MAE, and RMSE.
"""

import numpy as np
import pandas as pd


def compute_wape(
    actuals: np.ndarray | pd.Series | list[float],
    predictions: np.ndarray | pd.Series | list[float],
) -> float:
    """Calculate Weighted Absolute Percentage Error (WAPE).

    Formula:
        WAPE = sum(|actual - predicted|) / sum(actual)

    If sum(actual) == 0:
        Returns 0.0 if sum(|actual - predicted|) == 0 else 1.0.
    """
    y_true = np.asarray(actuals, dtype=float)
    y_pred = np.asarray(predictions, dtype=float)

    total_actual = float(np.sum(y_true))
    total_abs_error = float(np.sum(np.abs(y_true - y_pred)))

    if total_actual == 0.0:
        return 0.0 if total_abs_error == 0.0 else 1.0

    return float(total_abs_error / total_actual)


def compute_bias(
    actuals: np.ndarray | pd.Series | list[float],
    predictions: np.ndarray | pd.Series | list[float],
) -> float:
    """Calculate Normalized Forecast Bias.

    Formula:
        Bias = sum(predicted - actual) / sum(actual)

    Positive bias indicates overall over-forecasting (holding excess stock risk).
    Negative bias indicates overall under-forecasting (stockout risk).
    """
    y_true = np.asarray(actuals, dtype=float)
    y_pred = np.asarray(predictions, dtype=float)

    total_actual = float(np.sum(y_true))
    total_error = float(np.sum(y_pred - y_true))

    if total_actual == 0.0:
        return 0.0

    return float(total_error / total_actual)


def compute_mae(
    actuals: np.ndarray | pd.Series | list[float],
    predictions: np.ndarray | pd.Series | list[float],
) -> float:
    """Mean Absolute Error (MAE)."""
    y_true = np.asarray(actuals, dtype=float)
    y_pred = np.asarray(predictions, dtype=float)
    if len(y_true) == 0:
        return 0.0
    return float(np.mean(np.abs(y_true - y_pred)))


def compute_rmse(
    actuals: np.ndarray | pd.Series | list[float],
    predictions: np.ndarray | pd.Series | list[float],
) -> float:
    """Root Mean Squared Error (RMSE)."""
    y_true = np.asarray(actuals, dtype=float)
    y_pred = np.asarray(predictions, dtype=float)
    if len(y_true) == 0:
        return 0.0
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def evaluate_forecast(
    actuals: np.ndarray | pd.Series | list[float],
    predictions: np.ndarray | pd.Series | list[float],
) -> dict[str, float]:
    """Compute complete metric scorecard for a set of predictions."""
    y_true = np.asarray(actuals, dtype=float)
    y_pred = np.asarray(predictions, dtype=float)

    return {
        "wape": round(compute_wape(y_true, y_pred), 4),
        "bias": round(compute_bias(y_true, y_pred), 4),
        "mae": round(compute_mae(y_true, y_pred), 4),
        "rmse": round(compute_rmse(y_true, y_pred), 4),
        "total_actual": round(float(np.sum(y_true)), 2),
        "total_pred": round(float(np.sum(y_pred)), 2),
        "n_samples": int(len(y_true)),
    }
