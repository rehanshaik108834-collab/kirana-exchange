"""Global LightGBM demand forecaster with recursive roll-forward."""

from datetime import date, timedelta
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd

from ..features import FEATURE_COLUMNS, build_inference_features, build_training_features
from .base import BaseForecaster


class LightGBMForecaster(BaseForecaster):
    """Global gradient boosting forecaster trained across all catalog series.

    Leverages 24 known-in-advance calendar features, past demand lags,
    rolling statistics, and stockout signals. Uses autoregressive recursive
    roll-forward to generate multi-step forecasts with zero future leakage.
    """

    def __init__(
        self,
        n_estimators: int = 100,
        learning_rate: float = 0.05,
        num_leaves: int = 31,
        min_child_samples: int = 5,
        random_state: int = 42,
    ) -> None:
        self.n_estimators = n_estimators
        self.learning_rate = learning_rate
        self.num_leaves = num_leaves
        self.min_child_samples = min_child_samples
        self.random_state = random_state
        self.model: lgb.LGBMRegressor | None = None
        self._fitted = False

    def fit(self, history_df: pd.DataFrame) -> "LightGBMForecaster":
        if history_df.empty:
            return self

        train_feats = build_training_features(history_df)

        feature_cols = list(FEATURE_COLUMNS)
        X = train_feats[feature_cols]
        y = train_feats["qty_sold"].to_numpy(dtype=float)

        self.model = lgb.LGBMRegressor(
            objective="regression_l1",
            n_estimators=self.n_estimators,
            learning_rate=self.learning_rate,
            num_leaves=self.num_leaves,
            min_child_samples=self.min_child_samples,
            random_state=self.random_state,
            verbosity=-1,
            n_jobs=1,
        )
        self.model.fit(X, y)
        self._fitted = True
        return self

    def predict(
        self,
        history_df: pd.DataFrame,
        horizon: int = 7,
        start_date: date | pd.Timestamp | str | None = None,
    ) -> pd.DataFrame:
        if history_df.empty or not self._fitted or self.model is None:
            return pd.DataFrame(columns=["shop_id", "product_id", "forecast_date", "predicted_qty"])

        df = history_df.copy()
        df["_dt"] = pd.to_datetime(df["sale_date"])

        if start_date is not None:
            start_dt = pd.to_datetime(start_date)
        else:
            start_dt = df["_dt"].max() + timedelta(days=1)

        # Filter strictly past before start_dt to eliminate any accidental leakage
        current_history = df[df["_dt"] < start_dt].drop(columns=["_dt"], errors="ignore").copy()
        feature_cols = list(FEATURE_COLUMNS)

        all_predictions: list[dict[str, Any]] = []

        # Recursive autoregressive roll-forward for horizon steps
        for step in range(horizon):
            step_date = start_dt + timedelta(days=step)
            step_features = build_inference_features(current_history, forecast_date=step_date)

            if step_features.empty:
                continue

            X_step = step_features[feature_cols]
            y_pred = self.model.predict(X_step)
            y_pred = np.clip(y_pred, 0.0, None)

            # Record predictions and update current_history for next step lag computation
            step_updates: list[dict[str, Any]] = []
            for idx, (_, row) in enumerate(step_features.iterrows()):
                pred_val = round(float(y_pred[idx]), 2)
                s_id = row["shop_id"]
                p_id = row["product_id"]

                all_predictions.append(
                    {
                        "shop_id": s_id,
                        "product_id": p_id,
                        "forecast_date": step_date,
                        "predicted_qty": pred_val,
                    }
                )
                step_updates.append(
                    {
                        "shop_id": s_id,
                        "product_id": p_id,
                        "sale_date": step_date,
                        "qty_sold": pred_val,
                        "stockout_flag": False,
                    }
                )

            current_history = pd.concat(
                [current_history, pd.DataFrame(step_updates)], ignore_index=True
            )

        res = pd.DataFrame(all_predictions)
        if res.empty:
            return pd.DataFrame(columns=["shop_id", "product_id", "forecast_date", "predicted_qty"])

        return res.sort_values(["shop_id", "product_id", "forecast_date"]).reset_index(drop=True)
