"""Configuration settings for Kirana Swap Matching Worker."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings loaded from environment or .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    service_name: str = "swap-matcher"
    log_level: str = "INFO"

    swap_service_url: str = Field(
        default="http://127.0.0.1:3007",
        description="Internal base URL for apps/swap-service",
    )
    rabbitmq_url: str = Field(
        default="amqp://kirana_admin:secretpassword@127.0.0.1:5672/",
        description="RabbitMQ AMQP connection URL",
    )
    max_radius_km: float = Field(
        default=10.0,
        ge=0.5,
        le=25.0,
        description="Global upper cap on peer swap matching radius (km)",
    )
    http_timeout_seconds: float = Field(
        default=10.0,
        ge=1.0,
        le=60.0,
    )


settings = Settings()
