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

    # RabbitMQ Messaging
    rabbitmq_url: str = Field(
        default="amqp://kirana_admin:secretpassword@127.0.0.1:5672/",
        description="RabbitMQ connection URL",
    )


settings = Settings()
