"""Zero-dependency Prometheus metrics registry for Kirana Forecast Service."""

from threading import Lock


class ForecastMetrics:
    """Thread-safe Prometheus text-format metrics collector."""

    def __init__(self) -> None:
        self._lock = Lock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self.cache_hits_total: int = 0
            self.cache_misses_total: int = 0
            self.fallback_active: int = 0
            self.batch_runs_total: int = 0
            self.batch_duration_seconds: float = 0.0
            self.risk_flags_generated_total: int = 0
            self.outbox_published_total: int = 0

    def inc_cache_hit(self) -> None:
        with self._lock:
            self.cache_hits_total += 1

    def inc_cache_miss(self) -> None:
        with self._lock:
            self.cache_misses_total += 1

    def set_fallback_active(self, active: bool) -> None:
        with self._lock:
            self.fallback_active = 1 if active else 0

    def record_batch_run(self, duration_seconds: float, risk_flags: int) -> None:
        with self._lock:
            self.batch_runs_total += 1
            self.batch_duration_seconds = round(float(duration_seconds), 4)
            self.risk_flags_generated_total += int(risk_flags)

    def inc_outbox_published(self, count: int = 1) -> None:
        with self._lock:
            self.outbox_published_total += int(count)

    def render_prometheus(self) -> str:
        with self._lock:
            lines = [
                "# HELP forecast_cache_hits_total Total Redis cache hits on shop forecast reads.",
                "# TYPE forecast_cache_hits_total counter",
                f"forecast_cache_hits_total {self.cache_hits_total}",
                "# HELP forecast_cache_misses_total Redis cache misses on shop forecast reads.",
                "# TYPE forecast_cache_misses_total counter",
                f"forecast_cache_misses_total {self.cache_misses_total}",
                "# HELP forecast_fallback_active MovingAverage fallback mode active (1=yes, 0=no).",
                "# TYPE forecast_fallback_active gauge",
                f"forecast_fallback_active {self.fallback_active}",
                "# HELP forecast_batch_runs_total Total completed nightly forecast batch runs.",
                "# TYPE forecast_batch_runs_total counter",
                f"forecast_batch_runs_total {self.batch_runs_total}",
                "# HELP forecast_batch_duration_seconds Duration of most recent batch run.",
                "# TYPE forecast_batch_duration_seconds gauge",
                f"forecast_batch_duration_seconds {self.batch_duration_seconds}",
                "# HELP forecast_risk_flags_generated_total Total batch risk flags generated.",
                "# TYPE forecast_risk_flags_generated_total counter",
                f"forecast_risk_flags_generated_total {self.risk_flags_generated_total}",
                "# HELP forecast_outbox_published_total Total outbox events published to RabbitMQ.",
                "# TYPE forecast_outbox_published_total counter",
                f"forecast_outbox_published_total {self.outbox_published_total}",
                "",
            ]
        return "\n".join(lines)


metrics = ForecastMetrics()
