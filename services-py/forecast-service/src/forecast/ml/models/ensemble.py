"""Adaptive ensemble demand forecaster routing via Syntetos-Boylan classification."""

from datetime import date
from typing import Any

import pandas as pd

from ..classifier import classify_panel
from .base import BaseForecaster
from .croston import CrostonForecaster
from .lightgbm import LightGBMForecaster
from .moving_average import MovingAverageForecaster


class AdaptiveEnsembleForecaster(BaseForecaster):
    """Adaptive demand forecaster combining LightGBM and Croston/TSB.

    Routing Strategy:
    - SMOOTH / ERRATIC series: routed to Global LightGBM (captures rich calendar
      uplifts, seasonality, and rolling velocity).
    - INTERMITTENT / LUMPY series: routed to Croston SBA (handles sparse zeros and
      sporadic inter-arrival distributions).
    - Fallback: Moving Average for short/sparse edge cases.
    """

    def __init__(
        self,
        n_estimators: int = 100,
        learning_rate: float = 0.05,
    ) -> None:
        self.lgb_model = LightGBMForecaster(
            n_estimators=n_estimators,
            learning_rate=learning_rate,
        )
        self.croston_model = CrostonForecaster(method="CrostonSBA")
        self.fallback_model = MovingAverageForecaster(window=14)
        self._classifications: dict[tuple[str, str], str] = {}

    def fit(self, history_df: pd.DataFrame) -> "AdaptiveEnsembleForecaster":
        if history_df.empty:
            return self

        # 1. Classify demand series using Syntetos-Boylan
        classified = classify_panel(history_df)
        self._classifications = {
            (row["shop_id"], row["product_id"]): row["demand_class"]
            for _, row in classified.iterrows()
        }

        # 2. Fit sub-models
        self.lgb_model.fit(history_df)
        self.croston_model.fit(history_df)
        self.fallback_model.fit(history_df)

        return self

    def predict(
        self,
        history_df: pd.DataFrame,
        horizon: int = 7,
        start_date: date | pd.Timestamp | str | None = None,
    ) -> pd.DataFrame:
        if history_df.empty:
            return pd.DataFrame(columns=["shop_id", "product_id", "forecast_date", "predicted_qty"])

        # Ensure fitted
        if not self._classifications:
            self.fit(history_df)

        lgb_preds = self.lgb_model.predict(history_df, horizon=horizon, start_date=start_date)
        croston_preds = self.croston_model.predict(
            history_df, horizon=horizon, start_date=start_date
        )
        fallback_preds = self.fallback_model.predict(
            history_df, horizon=horizon, start_date=start_date
        )

        # Index predictions for fast lookup: (shop_id, product_id, forecast_date) -> predicted_qty
        lgb_map = {
            (r["shop_id"], r["product_id"], r["forecast_date"]): r["predicted_qty"]
            for _, r in lgb_preds.iterrows()
        }
        croston_map = {
            (r["shop_id"], r["product_id"], r["forecast_date"]): r["predicted_qty"]
            for _, r in croston_preds.iterrows()
        }
        fallback_map = {
            (r["shop_id"], r["product_id"], r["forecast_date"]): r["predicted_qty"]
            for _, r in fallback_preds.iterrows()
        }

        records: list[dict[str, Any]] = []

        # Iterate over all series and forecast dates
        for _, row in fallback_preds.iterrows():
            s_id = row["shop_id"]
            p_id = row["product_id"]
            f_dt = row["forecast_date"]

            d_class = self._classifications.get((s_id, p_id), "SMOOTH")

            if d_class in ("SMOOTH", "ERRATIC"):
                pred_val = lgb_map.get(
                    (s_id, p_id, f_dt), fallback_map.get((s_id, p_id, f_dt), 0.0)
                )
            else:
                pred_val = croston_map.get(
                    (s_id, p_id, f_dt), fallback_map.get((s_id, p_id, f_dt), 0.0)
                )

            records.append(
                {
                    "shop_id": s_id,
                    "product_id": p_id,
                    "forecast_date": f_dt,
                    "predicted_qty": max(0.0, round(float(pred_val), 2)),
                }
            )

        res = pd.DataFrame(records)
        return res.sort_values(["shop_id", "product_id", "forecast_date"]).reset_index(drop=True)
