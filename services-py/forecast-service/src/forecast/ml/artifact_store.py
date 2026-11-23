"""Model artifact persistence and graceful MovingAverage fallback loader."""

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import joblib
import structlog

from .models.base import BaseForecaster
from .models.moving_average import MovingAverageForecaster

logger = structlog.get_logger("forecast.ml.artifact_store")

MODEL_FILENAME = "production_model.joblib"
METADATA_FILENAME = "metadata.json"
FALLBACK_MODEL_NAME = "fallback"


@dataclass(frozen=True)
class LoadedForecaster:
    model: BaseForecaster
    model_name: str
    is_fallback: bool
    fallback_reason: str | None = None


def save_production_forecaster(
    model: BaseForecaster,
    artifact_dir: str | Path,
    *,
    model_name: str,
    wape: float | None = None,
    trained_at: datetime | None = None,
    max_age_days: int = 14,
) -> Path:
    """Persist a fitted BaseForecaster and JSON metadata atomically."""
    target_dir = Path(artifact_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    timestamp = trained_at or datetime.now(UTC)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)

    model_path = target_dir / MODEL_FILENAME
    meta_path = target_dir / METADATA_FILENAME

    joblib.dump(model, model_path)

    metadata: dict[str, Any] = {
        "model_name": model_name,
        "trained_at": timestamp.isoformat(),
        "wape": wape,
        "max_age_days": max_age_days,
    }
    meta_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    logger.info(
        "Saved production forecast model artifact",
        model_name=model_name,
        artifact_dir=str(target_dir),
        wape=wape,
    )
    return model_path


def _fallback(reason: str) -> LoadedForecaster:
    logger.warning("Activating forecast fallback model", reason=reason)
    return LoadedForecaster(
        model=MovingAverageForecaster(window=14),
        model_name=FALLBACK_MODEL_NAME,
        is_fallback=True,
        fallback_reason=reason,
    )


def load_production_forecaster(
    artifact_dir: str | Path,
    *,
    max_age_days: int | None = None,
    now: datetime | None = None,
) -> LoadedForecaster:
    """Load the production model artifact or gracefully fall back to MovingAverage.

    Returns `model_name='fallback'` and `is_fallback=True` whenever the artifact
    is missing, corrupted, invalid, or older than `max_age_days`.
    """
    target_dir = Path(artifact_dir)
    model_path = target_dir / MODEL_FILENAME
    meta_path = target_dir / METADATA_FILENAME

    if not model_path.exists() or not meta_path.exists():
        return _fallback("artifact_missing")

    try:
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        model_name = str(metadata["model_name"]).strip()
        raw_trained_at = str(metadata["trained_at"])
        trained_at = datetime.fromisoformat(raw_trained_at.replace("Z", "+00:00"))
        if trained_at.tzinfo is None:
            trained_at = trained_at.replace(tzinfo=UTC)
    except Exception as exc:
        return _fallback(f"metadata_corrupt: {exc}")

    if not model_name:
        return _fallback("metadata_missing_model_name")

    effective_max_age = (
        max_age_days if max_age_days is not None else int(metadata.get("max_age_days", 14))
    )
    current_time = now or datetime.now(UTC)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=UTC)

    if current_time - trained_at > timedelta(days=effective_max_age):
        return _fallback(f"artifact_stale (older than {effective_max_age} days)")

    try:
        loaded = joblib.load(model_path)
    except Exception as exc:
        return _fallback(f"artifact_load_error: {exc}")

    if not isinstance(loaded, BaseForecaster):
        return _fallback("artifact_invalid_type")

    logger.info("Loaded production forecast model artifact", model_name=model_name)
    return LoadedForecaster(
        model=loaded,
        model_name=model_name,
        is_fallback=False,
        fallback_reason=None,
    )
