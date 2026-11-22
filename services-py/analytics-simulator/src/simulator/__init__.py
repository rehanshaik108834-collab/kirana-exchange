"""Kirana Exchange Analytics Simulator package."""

from .benchmark_sampler import load_active_holiday_dates, sample_favorita_benchmark
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
from .exporter import (
    ExportFormat,
    ExportManifest,
    FileArtifact,
    compute_config_hash,
    export_dataset,
    sha256_file,
    verify_manifest,
)
from .generator import (
    SimulatedDataset,
    generate_daily_series,
    generate_shops,
    generate_synthetic_skus,
    run_simulation,
    stream_rng,
)
from .loader import (
    BulkHttpLoader,
    LoaderConfig,
    LoadingSummary,
)

__all__ = [
    "BulkHttpLoader",
    "CATEGORY_SEASONALITY_PHASE",
    "INDIAN_FESTIVALS_2026",
    "BehaviourParams",
    "CityCenterConfig",
    "DemandParams",
    "ExportFormat",
    "ExportManifest",
    "FileArtifact",
    "LoaderConfig",
    "LoadingSummary",
    "SimulatedDataset",
    "SimulatorConfig",
    "compute_config_hash",
    "export_dataset",
    "festival_multiplier",
    "generate_daily_series",
    "generate_shops",
    "generate_synthetic_skus",
    "load_active_holiday_dates",
    "load_config",
    "run_simulation",
    "sample_favorita_benchmark",
    "sha256_file",
    "stream_rng",
    "verify_manifest",
    "weather_multiplier",
]
