"""Known-in-advance calendar and Indian festival features for demand forecasting.

Strictly past-and-present deterministic signals that contain zero future weather
or future demand leakage.
"""

import math
from bisect import bisect_left
from datetime import date, timedelta

import numpy as np
import pandas as pd

# Authentic 2026 Indian retail-impact festival dates
INDIAN_FESTIVALS_2026: dict[date, str] = {
    date(2026, 1, 14): "Makar Sankranti / Pongal",
    date(2026, 1, 26): "Republic Day",
    date(2026, 2, 15): "Maha Shivaratri",
    date(2026, 3, 4): "Holi",
    date(2026, 3, 19): "Ugadi / Gudi Padwa",
    date(2026, 3, 21): "Eid-ul-Fitr",
    date(2026, 3, 27): "Ram Navami",
    date(2026, 5, 27): "Eid-ul-Adha",
    date(2026, 8, 15): "Independence Day",
    date(2026, 8, 28): "Raksha Bandhan",
    date(2026, 9, 14): "Ganesh Chaturthi",
    date(2026, 10, 20): "Dussehra",
    date(2026, 11, 8): "Diwali",
    date(2026, 12, 25): "Christmas",
}

# Add key late-2025 and early-2027 festivals for boundary smoothing
FESTIVAL_DATES: list[date] = sorted(
    [
        date(2025, 10, 20),
        date(2025, 12, 25),
        *INDIAN_FESTIVALS_2026.keys(),
        date(2027, 1, 14),
        date(2027, 1, 26),
    ]
)
FESTIVAL_SET: set[date] = set(FESTIVAL_DATES)

CALENDAR_COLUMNS: tuple[str, ...] = (
    "day_of_week",
    "is_weekend",
    "day_of_month",
    "month",
    "doy_sin",
    "doy_cos",
    "is_festival_day",
    "is_pre_festival_2d",
    "days_to_next_festival",
)


def _compute_festival_signals(dt_val: date) -> tuple[int, int, int]:
    """Compute (is_festival_day, is_pre_festival_2d, days_to_next_festival) for a date."""
    is_fest = 1 if dt_val in FESTIVAL_SET else 0
    is_pre = (
        1
        if (
            (dt_val + timedelta(days=1) in FESTIVAL_SET)
            or (dt_val + timedelta(days=2) in FESTIVAL_SET)
        )
        else 0
    )

    idx = bisect_left(FESTIVAL_DATES, dt_val)
    if idx < len(FESTIVAL_DATES):
        diff = (FESTIVAL_DATES[idx] - dt_val).days
        days_to_next = min(diff, 30)
    else:
        days_to_next = 30

    return is_fest, is_pre, days_to_next


def add_calendar_features(df: pd.DataFrame, date_col: str = "sale_date") -> pd.DataFrame:
    """Append known-in-advance calendar signals to DataFrame.

    Features generated:
    - day_of_week: 0 (Monday) .. 6 (Sunday)
    - is_weekend: 1 for Friday, Saturday, Sunday; 0 otherwise
    - day_of_month: 1 .. 31
    - month: 1 .. 12
    - doy_sin, doy_cos: cyclical day-of-year seasonality (period 365.25)
    - is_festival_day: 1 if date is an Indian festival
    - is_pre_festival_2d: 1 if date is 1 or 2 days before a festival
    - days_to_next_festival: integer days to next festival, capped at 30
    """
    out = df.copy()
    dates = pd.to_datetime(out[date_col])

    out["day_of_week"] = dates.dt.dayofweek.astype(int)
    # Fri (4), Sat (5), Sun (6) are peak kirana weekend shopping days
    out["is_weekend"] = dates.dt.dayofweek.isin([4, 5, 6]).astype(int)
    out["day_of_month"] = dates.dt.day.astype(int)
    out["month"] = dates.dt.month.astype(int)

    doy = dates.dt.dayofyear.astype(float)
    radians = 2.0 * math.pi * doy / 365.25
    out["doy_sin"] = np.round(np.sin(radians), 6)
    out["doy_cos"] = np.round(np.cos(radians), 6)

    # Festival features via unique date lookup for performance
    unique_dates = [d.date() for d in dates.unique()]
    fest_lookup = {d: _compute_festival_signals(d) for d in unique_dates}

    date_series = [d.date() for d in dates]
    out["is_festival_day"] = [fest_lookup[d][0] for d in date_series]
    out["is_pre_festival_2d"] = [fest_lookup[d][1] for d in date_series]
    out["days_to_next_festival"] = [fest_lookup[d][2] for d in date_series]

    return out
