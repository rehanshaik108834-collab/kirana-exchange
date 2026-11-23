"""Unit tests for production model persistence and graceful fallback."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from forecast.ml.artifact_store import (
    FALLBACK_MODEL_NAME,
    MODEL_FILENAME,
    load_production_forecaster,
    save_production_forecaster,
)
from forecast.ml.models.moving_average import MovingAverageForecaster


def test_missing_artifact_activates_fallback(tmp_path: Path):
    loaded = load_production_forecaster(tmp_path / "nonexistent")
    assert loaded.is_fallback is True
    assert loaded.model_name == FALLBACK_MODEL_NAME
    assert isinstance(loaded.model, MovingAverageForecaster)


def test_save_and_load_fresh_artifact(tmp_path: Path):
    now = datetime(2026, 4, 1, 12, 0, tzinfo=UTC)
    model = MovingAverageForecaster(window=7)
    save_production_forecaster(
        model,
        tmp_path,
        model_name="adaptive_ensemble",
        wape=0.2998,
        trained_at=now - timedelta(days=3),
        max_age_days=14,
    )

    loaded = load_production_forecaster(tmp_path, now=now)
    assert loaded.is_fallback is False
    assert loaded.model_name == "adaptive_ensemble"
    assert isinstance(loaded.model, MovingAverageForecaster)
    assert loaded.model.window == 7


def test_stale_artifact_activates_fallback(tmp_path: Path):
    now = datetime(2026, 4, 20, 12, 0, tzinfo=UTC)
    save_production_forecaster(
        MovingAverageForecaster(window=7),
        tmp_path,
        model_name="lightgbm_global",
        trained_at=now - timedelta(days=15),
        max_age_days=14,
    )

    loaded = load_production_forecaster(tmp_path, now=now)
    assert loaded.is_fallback is True
    assert loaded.model_name == FALLBACK_MODEL_NAME
    assert loaded.fallback_reason is not None and "stale" in loaded.fallback_reason


def test_corrupt_artifact_activates_fallback(tmp_path: Path):
    now = datetime(2026, 4, 1, 12, 0, tzinfo=UTC)
    save_production_forecaster(
        MovingAverageForecaster(window=7),
        tmp_path,
        model_name="lightgbm_global",
        trained_at=now,
    )
    (tmp_path / MODEL_FILENAME).write_bytes(b"corrupted-not-a-pickle")

    loaded = load_production_forecaster(tmp_path, now=now)
    assert loaded.is_fallback is True
    assert loaded.model_name == FALLBACK_MODEL_NAME
