"""CQRS admin projections, experiment runner, and FastAPI service for analytics_db."""

from .api import app, create_app
from .consumer import AnalyticsProjectionConsumer, apply_analytics_event_atomic
from .experiment import (
    ExperimentMetrics,
    PairedExperimentRequest,
    PairedExperimentResult,
    run_paired_experiment,
)
from .models import (
    AnalyticsBase,
    NetworkMetricsProjection,
    ProcessedMessage,
    ShopMapProjection,
    SimulationRun,
)

__all__ = [
    "AnalyticsBase",
    "AnalyticsProjectionConsumer",
    "ExperimentMetrics",
    "NetworkMetricsProjection",
    "PairedExperimentRequest",
    "PairedExperimentResult",
    "ProcessedMessage",
    "ShopMapProjection",
    "SimulationRun",
    "app",
    "apply_analytics_event_atomic",
    "create_app",
    "run_paired_experiment",
]
