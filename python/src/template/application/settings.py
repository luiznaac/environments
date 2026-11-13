"""Typed configuration — `application.yaml` + `@Value` + profiles, all in one place.

Values come from environment variables (and an optional `.env`). Nested groups
use `__` as the delimiter, e.g. `MYSQL__HOST`, `GATEWAYS__APP__HOST`.
Pick the profile with `APP_ENV=dev|prod|test`.
"""

from __future__ import annotations

import socket

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class MySqlConfig(BaseModel):
    host: str = "localhost"
    port: int = 3306
    user: str = "root"
    password: str = ""
    database: str = "template"

    @property
    def url(self) -> str:
        return f"mysql+asyncmy://{self.user}:{self.password}@{self.host}:{self.port}/{self.database}"


class AppGatewayConfig(BaseModel):
    # Base URL the service uses to call its own /health/internal (see AppHealthGateway).
    # Unset derives from `HTTP_PORT`; an explicit host wins for container/deploy.
    host: str | None = None


class GatewaysConfig(BaseModel):
    app: AppGatewayConfig = Field(default_factory=AppGatewayConfig)


class TelemetryConfig(BaseModel):
    """The telemetry keys, typed once from the standard env names."""

    service_name: str
    service_version: str | None
    host_name: str
    endpoint: str | None
    console: bool
    batch_schedule_delay_ms: int
    metric_export_interval_ms: int


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_nested_delimiter="__",
        extra="ignore",
    )

    app_env: str = "dev"
    http_port: int = 8080
    log_level: str = "INFO"
    otel_service_name: str = Field(default="template", validation_alias="OTEL_SERVICE_NAME")
    otlp_endpoint: str | None = Field(default=None, validation_alias="OTEL_EXPORTER_OTLP_ENDPOINT")
    telemetry_console: bool = Field(default=False, validation_alias="TELEMETRY_CONSOLE")
    service_version: str | None = Field(default=None, validation_alias="SERVICE_VERSION")
    host_name: str = Field(default_factory=socket.gethostname, validation_alias="HOSTNAME")
    otel_batch_schedule_delay: int = Field(default=5000, validation_alias="OTEL_BLRP_SCHEDULE_DELAY")
    otel_metric_export_interval: int = Field(default=60000, validation_alias="OTEL_METRIC_EXPORT_INTERVAL")

    mysql: MySqlConfig = Field(default_factory=MySqlConfig)
    gateways: GatewaysConfig = Field(default_factory=GatewaysConfig)

    @property
    def is_dev(self) -> bool:
        return self.app_env == "dev"

    @property
    def log_as_json(self) -> bool:
        return not self.is_dev

    @property
    def app_host(self) -> str:
        return self.gateways.app.host or f"http://localhost:{self.http_port}"

    @property
    def telemetry(self) -> TelemetryConfig:
        endpoint = self.otlp_endpoint
        if endpoint is None and self.app_env != "prod":
            endpoint = "http://localhost:4318"
        return TelemetryConfig(
            service_name=self.otel_service_name,
            service_version=self.service_version,
            host_name=self.host_name,
            endpoint=endpoint,
            console=self.telemetry_console,
            batch_schedule_delay_ms=self.otel_batch_schedule_delay,
            metric_export_interval_ms=self.otel_metric_export_interval,
        )
