"""Kirana Exchange Analytics Simulator package."""

from .calendar_signals import (
    CATEGORY_SEASONALITY_PHASE,
    INDIAN_FESTIVALS_2026,
    festival_multiplier,
    weather_multiplier,
)
from .config import (
    BehaviourParams,
    CityCenterConfig,
    DemandParams,
    SimulatorConfig,
    load_config,
)
from .generator import (
    SimulatedDataset,
    generate_daily_series,
    generate_shops,
    generate_synthetic_skus,
    run_simulation,
    stream_rng,
)

__all__ = [
    "CATEGORY_SEASONALITY_PHASE",
    "INDIAN_FESTIVALS_2026",
    "BehaviourParams",
    "CityCenterConfig",
    "DemandParams",
    "SimulatedDataset",
    "SimulatorConfig",
    "festival_multiplier",
    "generate_daily_series",
    "generate_shops",
    "generate_synthetic_skus",
    "load_config",
    "run_simulation",
    "stream_rng",
    "weather_multiplier",
]
