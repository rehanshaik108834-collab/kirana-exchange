"""Configuration settings for Kirana Forecast Service."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application runtime settings loaded from environment or .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "kirana-forecast-service"
    app_port: int = 3006
    app_env: str = "development"
    log_level: str = "INFO"

    # Database
    database_url: str = Field(
        default="postgresql+asyncpg://kirana_admin:secretpassword@127.0.0.1:5432/forecast_db",
        description="Async PostgreSQL connection string",
    )
    database_url_sync: str = Field(
        default="postgresql://kirana_admin:secretpassword@127.0.0.1:5432/forecast_db",
        description="Sync PostgreSQL connection string for Alembic",
    )

    # Redis Cache
    redis_url: str = Field(
        default="redis://127.0.0.1:6379/0",
        description="Redis connection URL for forecast cache-aside",
    )
    forecast_cache_ttl_seconds: int = Field(
        default=21_600,
        description="TTL in seconds for Redis forecast:shop:{shopId} cache entries (6h)",
    )

    # RabbitMQ Messaging & Outbox
    rabbitmq_url: str = Field(
        default="amqp://kirana_admin:secretpassword@127.0.0.1:5672/",
        description="RabbitMQ connection URL",
    )
    outbox_batch_size: int = Field(
        default=50,
        description="Max outbox_events rows relayed per poll batch",
    )

    # ML Model Artifact Store
    model_artifact_dir: str = Field(
        default="artifacts/models",
        description="Directory containing serialized production forecasting model artifacts",
    )
    model_max_age_days: int = Field(
        default=14,
        description="Maximum artifact age in days before falling back to MovingAverage",
    )


settings = Settings()
