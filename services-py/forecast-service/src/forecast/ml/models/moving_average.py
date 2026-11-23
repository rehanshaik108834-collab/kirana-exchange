"""Moving Average demand forecaster and production fallback."""

from datetime import date, timedelta
from typing import Any

import pandas as pd

from .base import BaseForecaster


class MovingAverageForecaster(BaseForecaster):
    """Moving Average demand forecaster.

    Calculates the past W-day rolling mean (default 14 days) per series.
    On stockout days, uses non-stockout observations to prevent under-forecasting.
    Also serves as the system's safe production fallback (`model_used = 'fallback'`).
    """

    def __init__(self, window: int = 14) -> None:
        self.window = window
        self._means: dict[tuple[str, str], float] = {}

    def fit(self, history_df: pd.DataFrame) -> "MovingAverageForecaster":
        if history_df.empty:
            return self

        df = history_df.copy()
        df["_dt"] = pd.to_datetime(df["sale_date"])
        df = df.sort_values(["shop_id", "product_id", "_dt"])

        self._means = {}
        for (s_id, p_id), grp in df.groupby(["shop_id", "product_id"], sort=True):
            # Take last `window` days of series
            tail_grp = grp.tail(self.window)
            if "stockout_flag" in tail_grp.columns:
                non_stk = tail_grp[~tail_grp["stockout_flag"].astype(bool)]
                if not non_stk.empty:
                    mean_val = float(non_stk["qty_sold"].mean())
                else:
                    mean_val = float(tail_grp["qty_sold"].mean())
            else:
                mean_val = float(tail_grp["qty_sold"].mean())

            self._means[(s_id, p_id)] = max(0.0, round(mean_val, 2))

        return self

    def predict(
        self,
        history_df: pd.DataFrame,
        horizon: int = 7,
        start_date: date | pd.Timestamp | str | None = None,
    ) -> pd.DataFrame:
        if history_df.empty:
            return pd.DataFrame(columns=["shop_id", "product_id", "forecast_date", "predicted_qty"])

        self.fit(history_df)

        df = history_df.copy()
        df["_dt"] = pd.to_datetime(df["sale_date"])

        if start_date is not None:
            start_dt = pd.to_datetime(start_date)
        else:
            start_dt = df["_dt"].max() + timedelta(days=1)

        forecast_dates = [start_dt + timedelta(days=i) for i in range(horizon)]

        unique_series = df[["shop_id", "product_id"]].drop_duplicates()
        records: list[dict[str, Any]] = []

        for _, row in unique_series.iterrows():
            s_id = row["shop_id"]
            p_id = row["product_id"]
            mean_val = self._means.get((s_id, p_id), 0.0)

            for f_dt in forecast_dates:
                records.append(
                    {
                        "shop_id": s_id,
                        "product_id": p_id,
                        "forecast_date": f_dt,
                        "predicted_qty": mean_val,
                    }
                )

        return pd.DataFrame(records)
