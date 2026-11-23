"""Croston and TSB intermittent demand forecaster via statsforecast."""

from datetime import date, timedelta
from typing import Any, Literal

import pandas as pd
from statsforecast import StatsForecast
from statsforecast.models import TSB, CrostonOptimized, CrostonSBA

from .base import BaseForecaster


class CrostonForecaster(BaseForecaster):
    """Croston and TSB intermittent demand forecaster.

    Designed for INTERMITTENT and LUMPY demand series where sales occur
    infrequently. Uses Syntetos-Boylan Approximation (CrostonSBA) by default,
    or Teunter-Syntetos-Babai (TSB) / CrostonOptimized.
    """

    def __init__(
        self,
        method: Literal["CrostonSBA", "TSB", "CrostonOptimized"] = "CrostonSBA",
        alpha_d: float = 0.2,
        alpha_p: float = 0.2,
    ) -> None:
        self.method = method
        self.alpha_d = alpha_d
        self.alpha_p = alpha_p
        self._sf: StatsForecast | None = None
        self._all_series: list[tuple[str, str]] = []

    def fit(self, history_df: pd.DataFrame) -> "CrostonForecaster":
        if history_df.empty:
            return self

        df = history_df.copy()
        df["_dt"] = pd.to_datetime(df["sale_date"])
        df = df.sort_values(["shop_id", "product_id", "_dt"])

        # Create unique_id: f"{shop_id}__SEP__{product_id}"
        df["unique_id"] = df["shop_id"].astype(str) + "__SEP__" + df["product_id"].astype(str)
        df["ds"] = df["_dt"]
        df["y"] = df["qty_sold"].astype(float)

        self._all_series = list(
            df[["shop_id", "product_id"]].drop_duplicates().itertuples(index=False, name=None)
        )

        sf_df = df[["unique_id", "ds", "y"]].drop_duplicates(subset=["unique_id", "ds"])

        if self.method == "TSB":
            model = TSB(alpha_d=self.alpha_d, alpha_p=self.alpha_p)
        elif self.method == "CrostonOptimized":
            model = CrostonOptimized()
        else:
            model = CrostonSBA()

        self._sf = StatsForecast(models=[model], freq="D", n_jobs=1)
        self._sf.fit(sf_df)

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

        if self._sf is None:
            return pd.DataFrame(columns=["shop_id", "product_id", "forecast_date", "predicted_qty"])

        preds_df = self._sf.predict(h=horizon).reset_index()

        col_name = (
            self.method
            if self.method in preds_df.columns
            else [c for c in preds_df.columns if c not in ["unique_id", "ds"]][0]
        )

        records: list[dict[str, Any]] = []
        for _, row in preds_df.iterrows():
            parts = str(row["unique_id"]).split("__SEP__")
            s_id = parts[0]
            p_id = parts[1] if len(parts) > 1 else ""
            pred_val = max(0.0, float(row[col_name]))

            records.append(
                {
                    "shop_id": s_id,
                    "product_id": p_id,
                    "forecast_date": pd.to_datetime(row["ds"]),
                    "predicted_qty": round(pred_val, 2),
                }
            )

        res = pd.DataFrame(records)

        # If a start_date was explicitly requested that differs from default, align dates
        if start_date is not None and not res.empty:
            start_dt = pd.to_datetime(start_date)
            # Recompute forecast_date sequence per series
            date_map = {
                d: start_dt + timedelta(days=idx)
                for idx, d in enumerate(sorted(res["forecast_date"].unique()))
            }
            res["forecast_date"] = res["forecast_date"].map(date_map)

        return res.sort_values(["shop_id", "product_id", "forecast_date"]).reset_index(drop=True)
