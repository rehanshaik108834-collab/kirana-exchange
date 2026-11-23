"""Past-only feature engineering pipeline with mathematical zero-leakage guarantee.

Every lag, rolling window, stockout imputation, and recency signal at row `sale_date = t`
depends strictly on observations strictly prior to `t` for the same (shop_id, product_id).
"""

from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from .calendar_features import add_calendar_features

FEATURE_COLUMNS: tuple[str, ...] = (
    # Known-in-advance calendar & seasonality features
    "day_of_week",
    "is_weekend",
    "day_of_month",
    "month",
    "doy_sin",
    "doy_cos",
    "is_festival_day",
    "is_pre_festival_2d",
    "days_to_next_festival",
    # Strictly past-only demand lags (on stockout-adjusted demand)
    "lag_1",
    "lag_7",
    "lag_14",
    "lag_28",
    # Strictly past-only rolling statistics
    "roll_mean_7",
    "roll_std_7",
    "roll_mean_14",
    "roll_mean_28",
    "roll_std_28",
    "roll_max_28",
    "nonzero_rate_28",
    # Strictly past-only stockout & recency signals
    "stockout_flag_lag_1",
    "stockout_rate_7",
    "stockout_rate_28",
    "days_since_last_sale",
)


def complete_daily_grid(df: pd.DataFrame) -> pd.DataFrame:
    """For each (shop_id, product_id), reindex `sale_date` to a contiguous daily grid.

    Fills missing dates from min(sale_date) to max(sale_date) with qty_sold=0,
    stockout_flag=False. Always returns sorted by [shop_id, product_id, sale_date].
    """
    if df.empty:
        return df.copy()

    clean = df.copy()
    clean["_dt"] = pd.to_datetime(clean["sale_date"])

    grid_frames: list[pd.DataFrame] = []

    for (s_id, p_id), grp in clean.groupby(["shop_id", "product_id"], sort=True):
        grp_sorted = grp.sort_values("_dt").drop_duplicates(subset=["_dt"])
        min_dt = grp_sorted["_dt"].min()
        max_dt = grp_sorted["_dt"].max()

        full_range = pd.date_range(start=min_dt, end=max_dt, freq="D", name="_dt")
        reindexed = grp_sorted.set_index("_dt").reindex(full_range).reset_index()

        reindexed["shop_id"] = s_id
        reindexed["product_id"] = p_id
        reindexed["qty_sold"] = np.where(
            reindexed["qty_sold"].isna(), 0, reindexed["qty_sold"]
        ).astype(int)
        reindexed["stockout_flag"] = np.where(
            reindexed["stockout_flag"].isna(), False, reindexed["stockout_flag"]
        ).astype(bool)
        reindexed["sale_date"] = reindexed["_dt"]

        grid_frames.append(reindexed)

    result = pd.concat(grid_frames, ignore_index=True)
    result = result.drop(columns=["_dt"], errors="ignore")
    return result.sort_values(["shop_id", "product_id", "sale_date"]).reset_index(drop=True)


def _compute_series_past_features(group: pd.DataFrame) -> pd.DataFrame:
    """Compute past-only lags, rolling statistics, and stockout signals for a single series.

    Strict zero-leakage invariant: row at index `i` (date `t`) never observes any values
    at or after index `i`.
    """
    n = len(group)
    raw_qty = group["qty_sold"].astype(float).to_numpy()
    stockout = group["stockout_flag"].astype(bool).to_numpy()

    # 1. Past-only uncensored quantity imputation:
    # On censored days (stockout == True), compute rolling mean of non-stockout days
    # strictly BEFORE t and take max(raw_qty, prior_non_stockout_mean)
    non_stockout_arr = np.where(stockout, np.nan, raw_qty)
    prior_mean_series = (
        pd.Series(non_stockout_arr).shift(1).rolling(28, min_periods=1).mean().to_numpy()
    )

    uncensored = np.copy(raw_qty)
    for i in range(n):
        if stockout[i]:
            imputed = prior_mean_series[i]
            if not np.isnan(imputed):
                uncensored[i] = max(raw_qty[i], float(imputed))

    uncensored_series = pd.Series(uncensored)

    # 2. Demand lags (on stockout-adjusted demand)
    lag_1 = uncensored_series.shift(1).fillna(0.0).to_numpy()
    lag_7 = uncensored_series.shift(7).fillna(0.0).to_numpy()
    lag_14 = uncensored_series.shift(14).fillna(0.0).to_numpy()
    lag_28 = uncensored_series.shift(28).fillna(0.0).to_numpy()

    # 3. Rolling statistics on shifted uncensored series (strictly past-only)
    shifted = uncensored_series.shift(1)
    roll_mean_7 = shifted.rolling(7, min_periods=1).mean().fillna(0.0).to_numpy()
    roll_std_7 = shifted.rolling(7, min_periods=1).std(ddof=0).fillna(0.0).to_numpy()
    roll_mean_14 = shifted.rolling(14, min_periods=1).mean().fillna(0.0).to_numpy()
    roll_mean_28 = shifted.rolling(28, min_periods=1).mean().fillna(0.0).to_numpy()
    roll_std_28 = shifted.rolling(28, min_periods=1).std(ddof=0).fillna(0.0).to_numpy()
    roll_max_28 = shifted.rolling(28, min_periods=1).max().fillna(0.0).to_numpy()
    nonzero_rate_28 = (
        (shifted > 0.0).astype(float).rolling(28, min_periods=1).mean().fillna(0.0).to_numpy()
    )

    # 4. Stockout signals strictly on shifted stockout flag
    stk_shifted = pd.Series(stockout.astype(float)).shift(1)
    stockout_flag_lag_1 = stk_shifted.fillna(0.0).astype(int).to_numpy()
    stockout_rate_7 = stk_shifted.rolling(7, min_periods=1).mean().fillna(0.0).to_numpy()
    stockout_rate_28 = stk_shifted.rolling(28, min_periods=1).mean().fillna(0.0).to_numpy()

    # 5. Days since last positive sale (clipped at 90, 90 if no prior sale)
    days_since_last_sale = np.full(n, 90, dtype=int)
    last_sale_idx = -1
    for i in range(n):
        if last_sale_idx != -1:
            days_since_last_sale[i] = min(i - last_sale_idx, 90)
        if raw_qty[i] > 0.0:
            last_sale_idx = i

    out = group.copy()
    out["lag_1"] = np.round(lag_1, 4)
    out["lag_7"] = np.round(lag_7, 4)
    out["lag_14"] = np.round(lag_14, 4)
    out["lag_28"] = np.round(lag_28, 4)
    out["roll_mean_7"] = np.round(roll_mean_7, 4)
    out["roll_std_7"] = np.round(roll_std_7, 4)
    out["roll_mean_14"] = np.round(roll_mean_14, 4)
    out["roll_mean_28"] = np.round(roll_mean_28, 4)
    out["roll_std_28"] = np.round(roll_std_28, 4)
    out["roll_max_28"] = np.round(roll_max_28, 4)
    out["nonzero_rate_28"] = np.round(nonzero_rate_28, 4)
    out["stockout_flag_lag_1"] = stockout_flag_lag_1
    out["stockout_rate_7"] = np.round(stockout_rate_7, 4)
    out["stockout_rate_28"] = np.round(stockout_rate_28, 4)
    out["days_since_last_sale"] = days_since_last_sale

    return out


def build_training_features(df: pd.DataFrame) -> pd.DataFrame:
    """Build strictly past-only features for every historical row in `df`.

    INVARIANT (ZERO LEAKAGE):
    - Every lagged, rolling, stockout-imputation, and recency feature at row `sale_date = t`
      MUST depend ONLY on rows for the same (shop_id, product_id) with `sale_date < t`.
    - Compute `uncensored_qty` using only non-stockout observations strictly before `t`.
    - Compute `days_since_last_sale` as days elapsed since most recent `sale_date < t` with qty > 0.
    - Preserves shop_id, product_id, sale_date, qty_sold, stockout_flag plus all FEATURE_COLUMNS.
    """
    if df.empty:
        return df.copy()

    # 1. Ensure daily contiguous grid per (shop_id, product_id)
    gridded = complete_daily_grid(df)

    # 2. Add calendar & festival signals (known in advance)
    with_calendar = add_calendar_features(gridded, date_col="sale_date")

    # 3. Compute past-only dynamic features per series group
    processed_groups: list[pd.DataFrame] = []
    for _, grp in with_calendar.groupby(["shop_id", "product_id"], sort=True):
        processed_groups.append(_compute_series_past_features(grp))

    result = pd.concat(processed_groups, ignore_index=True)

    # Ensure all FEATURE_COLUMNS are present and finite
    for col in FEATURE_COLUMNS:
        if col not in result.columns:
            result[col] = 0.0

    return result.sort_values(["shop_id", "product_id", "sale_date"]).reset_index(drop=True)


def build_inference_features(
    history_df: pd.DataFrame,
    forecast_date: date | pd.Timestamp | str,
) -> pd.DataFrame:
    """Build a 1-row feature vector per (shop_id, product_id) for predicting `forecast_date`.

    INVARIANT:
    - Hard-filters `history_df` to `sale_date < pd.Timestamp(forecast_date)` FIRST so
      accidentally passing future rows into inference can never leak.
    - Appends one placeholder row at `forecast_date` per series and reuses
      `build_training_features(...)`, returning only the rows at `sale_date == forecast_date`.
    """
    if history_df.empty:
        return pd.DataFrame()

    target_dt = pd.to_datetime(forecast_date)

    hist = history_df.copy()
    hist["_dt"] = pd.to_datetime(hist["sale_date"])
    # 1. Hard cutoff guard: discard any row at or beyond forecast_date
    hist = hist[hist["_dt"] < target_dt].drop(columns=["_dt"], errors="ignore")

    if hist.empty:
        return pd.DataFrame()

    # 2. Extract all unique series
    unique_series = hist[["shop_id", "product_id"]].drop_duplicates()

    # 3. Append placeholder row at target_dt for each series
    placeholders: list[dict[str, Any]] = []
    for _, row in unique_series.iterrows():
        placeholders.append(
            {
                "shop_id": row["shop_id"],
                "product_id": row["product_id"],
                "sale_date": target_dt,
                "qty_sold": 0,
                "stockout_flag": False,
            }
        )
    placeholder_df = pd.DataFrame(placeholders)

    combined = pd.concat([hist, placeholder_df], ignore_index=True)

    # 4. Build features on combined dataset
    features = build_training_features(combined)

    # 5. Extract strictly the target forecast_date row per series
    features["_dt"] = pd.to_datetime(features["sale_date"])
    inference_rows = (
        features[features["_dt"] == target_dt]
        .drop(columns=["_dt"], errors="ignore")
        .sort_values(["shop_id", "product_id"])
        .reset_index(drop=True)
    )

    return inference_rows
