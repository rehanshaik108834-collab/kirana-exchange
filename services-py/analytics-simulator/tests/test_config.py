from datetime import date
from pathlib import Path

import pytest
from pydantic import ValidationError
from simulator.config import (
    BehaviourParams,
    CityCenterConfig,
    DemandParams,
    SimulatorConfig,
    load_config,
)

CONFIGS_DIR = Path(__file__).resolve().parent.parent / "configs"


def test_load_preset_10():
    cfg = load_config(CONFIGS_DIR / "preset_10.yaml")
    assert cfg.shop_count == 10
    assert cfg.city_center.cluster_count == 2
    assert cfg.seed == 42
    assert cfg.skus_per_shop == 40
    assert cfg.days == 180
    assert cfg.city_center.name == "Hyderabad"
    assert cfg.city_center.state == "Telangana"
    assert cfg.city_center.lat == pytest.approx(17.385044)
    assert cfg.city_center.lng == pytest.approx(78.486671)
    assert cfg.city_center.radius_km == 8.0
    assert cfg.demand.weekend_uplift == 1.25
    assert cfg.demand.reorder_point_days == 4
    assert cfg.behaviour.swap_acceptance_prob == 0.45


def test_load_preset_100():
    cfg = load_config(CONFIGS_DIR / "preset_100.yaml")
    assert cfg.shop_count == 100
    assert cfg.city_center.cluster_count == 6
    assert cfg.seed == 42
    assert cfg.skus_per_shop == 40
    assert cfg.days == 180
    assert cfg.city_center.radius_km == 12.0


def test_load_preset_500():
    cfg = load_config(CONFIGS_DIR / "preset_500.yaml")
    assert cfg.shop_count == 500
    assert cfg.city_center.cluster_count == 15
    assert cfg.seed == 42
    assert cfg.skus_per_shop == 50
    assert cfg.days == 180
    assert cfg.city_center.radius_km == 18.0


def test_default_config_instantiation():
    cfg = SimulatorConfig()
    assert cfg.version == "1.0.0"
    assert cfg.seed == 42
    assert cfg.shop_count == 10
    assert cfg.start_date == date(2026, 1, 1)
    assert isinstance(cfg.city_center, CityCenterConfig)
    assert isinstance(cfg.demand, DemandParams)
    assert isinstance(cfg.behaviour, BehaviourParams)


def test_validation_bounds_enforced():
    with pytest.raises(ValidationError):
        # Lat out of range
        CityCenterConfig(lat=95.0, lng=78.0)

    with pytest.raises(ValidationError):
        # Negative radius
        CityCenterConfig(lat=17.0, lng=78.0, radius_km=-1.0)

    with pytest.raises(ValidationError):
        # Weekend uplift < 1.0
        DemandParams(weekend_uplift=0.5)

    with pytest.raises(ValidationError):
        # Shop count <= 0
        SimulatorConfig(shop_count=0)
