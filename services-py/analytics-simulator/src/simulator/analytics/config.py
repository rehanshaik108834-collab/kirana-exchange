"""Runtime settings for Kirana Analytics & Simulator HTTP/CQRS service."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AnalyticsSettings(BaseSettings):
    """Application settings loaded from environment or .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "kirana-analytics-simulator"
    app_port: int = 3011
    app_env: str = "development"
    log_level: str = "INFO"

    database_url: str = Field(
        default="postgresql+asyncpg://kirana_admin:secretpassword@127.0.0.1:5432/analytics_db",
        description="Async PostgreSQL connection string for analytics_db",
    )
    rabbitmq_url: str = Field(
        default="amqp://kirana_admin:secretpassword@127.0.0.1:5672/",
        description="RabbitMQ AMQP URL for CQRS projection consumer",
    )
    rabbit_consumer_enabled: bool = Field(
        default=False,
        description="Enable background RabbitMQ consumer during FastAPI lifespan",
    )


analytics_settings = AnalyticsSettings()
