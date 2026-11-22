import math
from datetime import date, timedelta

# Key 2026 Indian retail-impact festivals (covers both H1 180-day runs and full-year runs)
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

# Category weather affinity: +1 peaks in summer (Apr-May), -1 peaks in monsoon/winter (Aug-Nov)
CATEGORY_SEASONALITY_PHASE: dict[str, float] = {
    "Beverages": 1.0,
    "Dairy": 0.6,
    "Staples": 0.1,
    "Snacks": -0.4,
    "Instant Food": -0.7,
    "Personal Care": 0.3,
    "Home Care": 0.0,
}


def festival_multiplier(day: date, peak_uplift: float) -> tuple[float, bool]:
    """Return (multiplier, is_festival_window) for a calendar date.

    Applies full `peak_uplift` on the festival date and a 50% pre-festival ramp
    on the 2 preceding days to model pre-festival kirana stocking.
    """
    if day in INDIAN_FESTIVALS_2026:
        return peak_uplift, True
    if (day + timedelta(days=1)) in INDIAN_FESTIVALS_2026 or (
        day + timedelta(days=2)
    ) in INDIAN_FESTIVALS_2026:
        ramp = 1.0 + 0.5 * (peak_uplift - 1.0)
        return ramp, True
    return 1.0, False


def weather_multiplier(day: date, category: str, strength: float) -> float:
    """Smooth annual Indian seasonal curve peaking around May 15 (day 135) for summer

    categories and peaking in monsoon/post-monsoon for comfort categories.
    """
    if strength == 0.0:
        return 1.0
    phase = CATEGORY_SEASONALITY_PHASE.get(category, 0.0)
    day_of_year = day.timetuple().tm_yday
    # Cosine peaks at day 135 (mid-May heatwave) and troughs at day 317 (mid-Nov)
    wave = math.cos(2.0 * math.pi * (day_of_year - 135) / 365.0)
    return max(0.5, 1.0 + strength * phase * wave)
