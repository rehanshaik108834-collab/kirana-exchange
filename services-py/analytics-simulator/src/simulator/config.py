from datetime import date
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, PositiveFloat, PositiveInt


class CityCenterConfig(BaseModel):
    name: str = "Hyderabad"
    state: str = "Telangana"
    lat: float = Field(17.385044, ge=-90.0, le=90.0)
    lng: float = Field(78.486671, ge=-180.0, le=180.0)
    radius_km: PositiveFloat = 8.0
    cluster_count: PositiveInt = 5


class DemandParams(BaseModel):
    weekend_uplift: float = Field(1.25, ge=1.0, le=3.0)
    festival_uplift: float = Field(1.60, ge=1.0, le=5.0)
    weather_seasonality_strength: float = Field(0.20, ge=0.0, le=1.0)
    slow_mover_share: float = Field(0.35, ge=0.0, le=0.9)
    slow_mover_zero_prob: float = Field(0.75, ge=0.1, le=0.98)
    annual_trend_std: float = Field(0.10, ge=0.0, le=0.5)
    reorder_point_days: PositiveInt = 4
    reorder_lead_time_days: PositiveInt = 2


class BehaviourParams(BaseModel):
    swap_acceptance_prob: float = Field(0.45, ge=0.0, le=1.0)
    price_sensitivity: float = Field(0.30, ge=0.0, le=1.0)
    gst_scheme_weights: dict[Literal["REGULAR", "COMPOSITION", "UNREGISTERED"], float] = Field(
        default_factory=lambda: {"REGULAR": 0.35, "COMPOSITION": 0.45, "UNREGISTERED": 0.20}
    )


class SimulatorConfig(BaseModel):
    version: str = "1.0.0"
    seed: int = 42
    shop_count: PositiveInt = 10
    skus_per_shop: PositiveInt = 40
    days: PositiveInt = 180
    start_date: date = date(2026, 1, 1)
    city_center: CityCenterConfig = Field(default_factory=CityCenterConfig)
    demand: DemandParams = Field(default_factory=DemandParams)
    behaviour: BehaviourParams = Field(default_factory=BehaviourParams)


def load_config(path: str | Path) -> SimulatorConfig:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return SimulatorConfig.model_validate(raw)
