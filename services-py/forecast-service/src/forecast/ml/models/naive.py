"""Naive and Seasonal Naive demand forecasters."""

from datetime import date, timedelta
from typing import Any

import pandas as pd

from .base import BaseForecaster


class NaiveForecaster(BaseForecaster):
    """Last-value naive forecaster.

    Repeats the most recently observed non-stockout demand (or last qty_sold)
    for each series across the entire forecast horizon.
    """

    def __init__(self) -> None:
        self._last_values: dict[tuple[str, str], float] = {}

    def fit(self, history_df: pd.DataFrame) -> "NaiveForecaster":
        if history_df.empty:
            return self

        df = history_df.copy()
        df["_dt"] = pd.to_datetime(df["sale_date"])
        df = df.sort_values(["shop_id", "product_id", "_dt"])

        self._last_values = {}
        for (s_id, p_id), grp in df.groupby(["shop_id", "product_id"], sort=True):
            # Prioritize non-stockout days if available
            non_stk = grp[~grp["stockout_flag"]] if "stockout_flag" in grp.columns else grp
            if not non_stk.empty:
                last_val = float(non_stk.iloc[-1]["qty_sold"])
            else:
                last_val = float(grp.iloc[-1]["qty_sold"])
            self._last_values[(s_id, p_id)] = max(0.0, last_val)

        return self

    def predict(
        self,
        history_df: pd.DataFrame,
        horizon: int = 7,
        start_date: date | pd.Timestamp | str | None = None,
    ) -> pd.DataFrame:
        if history_df.empty:
            return pd.DataFrame(columns=["shop_id", "product_id", "forecast_date", "predicted_qty"])

        if not self._last_values:
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
            val = self._last_values.get((s_id, p_id), 0.0)

            for f_dt in forecast_dates:
                records.append(
                    {
                        "shop_id": s_id,
                        "product_id": p_id,
                        "forecast_date": f_dt,
                        "predicted_qty": val,
                    }
                )

        return pd.DataFrame(records)


class SeasonalNaiveForecaster(BaseForecaster):
    """Seasonal 7-day lag naive forecaster.

    For retail kirana stores, Saturday predicts Saturday, Sunday predicts Sunday.
    For each target day (start_date + h), predicts the observed demand from
    exactly 7 days prior (start_date + h - 7 days). Falls back to last value
    if the 7-day prior date is missing.
    """

    def __init__(self, season_length: int = 7) -> None:
        self.season_length = season_length
        self._history_map: dict[tuple[str, str, pd.Timestamp], float] = {}
        self._fallback_values: dict[tuple[str, str], float] = {}

    def fit(self, history_df: pd.DataFrame) -> "SeasonalNaiveForecaster":
        if history_df.empty:
            return self

        df = history_df.copy()
        df["_dt"] = pd.to_datetime(df["sale_date"])

        self._history_map = {}
        self._fallback_values = {}

        for (s_id, p_id), grp in df.groupby(["shop_id", "product_id"], sort=True):
            for _, row in grp.iterrows():
                self._history_map[(s_id, p_id, row["_dt"])] = max(0.0, float(row["qty_sold"]))
            last_val = float(grp.iloc[-1]["qty_sold"])
            self._fallback_values[(s_id, p_id)] = max(0.0, last_val)

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

        unique_series = df[["shop_id", "product_id"]].drop_duplicates()
        records: list[dict[str, Any]] = []

        for _, row in unique_series.iterrows():
            s_id = row["shop_id"]
            p_id = row["product_id"]
            fallback = self._fallback_values.get((s_id, p_id), 0.0)

            for step in range(horizon):
                target_dt = start_dt + timedelta(days=step)
                lookback_dt = target_dt - timedelta(days=self.season_length)

                val = self._history_map.get((s_id, p_id, lookback_dt), fallback)
                records.append(
                    {
                        "shop_id": s_id,
                        "product_id": p_id,
                        "forecast_date": target_dt,
                        "predicted_qty": round(val, 2),
                    }
                )

        return pd.DataFrame(records)
