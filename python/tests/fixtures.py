"""Shared test builders — one stub checker and one metric/log reader per shape."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from template.application.settings import Settings
from template.application.telemetry import Telemetry
from template.usecase.health.checker import HealthCheckResult


class StubHealthChecker:
    def __init__(self, service_name: str = "app-health", *, is_healthy: bool = True) -> None:
        self._service_name = service_name
        self._is_healthy = is_healthy

    async def get_health_status(self) -> HealthCheckResult:
        return HealthCheckResult(
            service_name=self._service_name,
            is_healthy=self._is_healthy,
            timestamp=datetime(2026, 1, 1, tzinfo=UTC),
        )


def build_test_settings(**overrides: object) -> Settings:
    return Settings(_env_file=None, app_env="test", **overrides)  # type: ignore[arg-type]


def log_records(telemetry: Telemetry) -> list[ReadableLogRecord]:
    exporter = telemetry.log_exporter
    assert isinstance(exporter, InMemoryLogRecordExporter)
    return list(exporter.get_finished_logs())


def new_log_records(telemetry: Telemetry, start: int) -> list[ReadableLogRecord]:
    return log_records(telemetry)[start:]


def metrics_by_name(telemetry: Telemetry) -> dict[str, Any]:
    reader = telemetry.metric_reader
    assert isinstance(reader, InMemoryMetricReader)
    data = reader.get_metrics_data()
    return {
        metric.name: metric
        for resource_metric in data.resource_metrics
        for scope_metric in resource_metric.scope_metrics
        for metric in scope_metric.metrics
    }


def metric_names(telemetry: Telemetry) -> set[str]:
    return set(metrics_by_name(telemetry))


def metric(telemetry: Telemetry, name: str) -> Any:
    metrics = metrics_by_name(telemetry)
    assert name in metrics, f"metric {name} not exported"
    return metrics[name]
