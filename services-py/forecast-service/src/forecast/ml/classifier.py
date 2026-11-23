"""Syntetos-Boylan demand classification engine.

Classifies (shop_id, product_id) historical demand series into:
- SMOOTH (ADI < 1.32, CV^2 < 0.49)
- ERRATIC (ADI < 1.32, CV^2 >= 0.49)
- INTERMITTENT (ADI >= 1.32, CV^2 < 0.49)
- LUMPY (ADI >= 1.32, CV^2 >= 0.49)

Strictly ignores censored zero-sale stockout days to avoid misclassifying fast staples.
"""

from dataclasses import dataclass
from datetime import date
from typing import Literal

import numpy as np
import pandas as pd

DemandClass = Literal["SMOOTH", "ERRATIC", "INTERMITTENT", "LUMPY"]

ADI_THRESHOLD: float = 1.32
CV2_THRESHOLD: float = 0.49


@dataclass(frozen=True)
class DemandClassification:
    demand_class: DemandClass
    adi: float
    cv2: float
    nonzero_days: int
    valid_days: int


def classify_series(
    qty_sold: pd.Series | np.ndarray,
    stockout_flag: pd.Series | np.ndarray | None = None,
) -> DemandClassification:
    """Classify a historical daily demand series into Syntetos-Boylan quadrants.

    Formula:
        ADI = N_valid / k
        CV^2 = (sigma_nz / mu_nz) ^ 2

    where:
    - k = nonzero days (qty > 0)
    - N_valid = valid days excluding censored stockout zeros (qty == 0 AND stockout == True)
    - mu_nz, sigma_nz = mean and population standard deviation (ddof=0) of nonzero demand.
    """
    qty = np.asarray(qty_sold, dtype=float)

    if stockout_flag is not None:
        stockout = np.asarray(stockout_flag, dtype=bool)
        # Exclude days where sales were 0 specifically because stock was unavailable
        censored_zero = (qty == 0.0) & stockout
        valid_qty = qty[~censored_zero]
    else:
        valid_qty = qty

    valid_days = int(len(valid_qty))
    pos_values = valid_qty[valid_qty > 0.0]
    nonzero_days = int(len(pos_values))

    # Edge cases
    if nonzero_days == 0 or valid_days == 0:
        return DemandClassification(
            demand_class="INTERMITTENT",
            adi=float("inf"),
            cv2=0.0,
            nonzero_days=0,
            valid_days=valid_days,
        )

    if nonzero_days == 1:
        cv2 = 0.0
        adi = float(valid_days) / 1.0
    else:
        mu_nz = float(np.mean(pos_values))
        sigma_nz = float(np.std(pos_values, ddof=0))
        cv2 = float((sigma_nz / mu_nz) ** 2) if mu_nz > 0.0 else 0.0
        adi = float(valid_days) / float(nonzero_days)

    # Assign quadrant
    is_regular_interval = adi < ADI_THRESHOLD
    is_low_variance = cv2 < CV2_THRESHOLD

    if is_regular_interval and is_low_variance:
        demand_class: DemandClass = "SMOOTH"
    elif is_regular_interval and not is_low_variance:
        demand_class = "ERRATIC"
    elif not is_regular_interval and is_low_variance:
        demand_class = "INTERMITTENT"
    else:
        demand_class = "LUMPY"

    return DemandClassification(
        demand_class=demand_class,
        adi=round(adi, 4),
        cv2=round(cv2, 4),
        nonzero_days=nonzero_days,
        valid_days=valid_days,
    )


def classify_panel(
    df: pd.DataFrame,
    cutoff_date: pd.Timestamp | date | str | None = None,
) -> pd.DataFrame:
    """Classify every (shop_id, product_id) pair using strictly historical data.

    If `cutoff_date` is provided, filters strictly `sale_date < cutoff_date` first.
    Returns DataFrame with columns:
      [shop_id, product_id, demand_class, adi, cv2, nonzero_days, valid_days]
    """
    if df.empty:
        return pd.DataFrame(
            columns=[
                "shop_id",
                "product_id",
                "demand_class",
                "adi",
                "cv2",
                "nonzero_days",
                "valid_days",
            ]
        )

    sub_df = df.copy()
    if cutoff_date is not None:
        sub_df["_dt"] = pd.to_datetime(sub_df["sale_date"])
        cutoff_dt = pd.to_datetime(cutoff_date)
        sub_df = sub_df[sub_df["_dt"] < cutoff_dt]

    if sub_df.empty:
        return pd.DataFrame(
            columns=[
                "shop_id",
                "product_id",
                "demand_class",
                "adi",
                "cv2",
                "nonzero_days",
                "valid_days",
            ]
        )

    records: list[dict] = []
    has_stockout = "stockout_flag" in sub_df.columns

    for (s_id, p_id), grp in sub_df.groupby(["shop_id", "product_id"], sort=True):
        stockout = grp["stockout_flag"] if has_stockout else None
        res = classify_series(grp["qty_sold"], stockout)
        records.append(
            {
                "shop_id": s_id,
                "product_id": p_id,
                "demand_class": res.demand_class,
                "adi": res.adi,
                "cv2": res.cv2,
                "nonzero_days": res.nonzero_days,
                "valid_days": res.valid_days,
            }
        )

    return pd.DataFrame(records)
