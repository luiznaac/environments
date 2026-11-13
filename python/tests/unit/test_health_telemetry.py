"""Contract tests for the health instruments and their transition logs."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from template.application.telemetry import Telemetry, build_telemetry
from template.usecase.commons.logging import configure_logging
from template.usecase.health.checker import HealthCheckResult
from template.usecase.health.telemetry import HealthTelemetry
from tests.fixtures import build_test_settings, log_records, metrics_by_name


@pytest.fixture
def telemetry() -> Iterator[Telemetry]:
    instance = build_telemetry(build_test_settings())
    configure_logging("INFO", json=True)
    instance.install_log_bridge()
    try:
        yield instance
    finally:
        instance.shutdown()


def _result(component: str, healthy: bool) -> HealthCheckResult:
    return HealthCheckResult(
        service_name=component,
        is_healthy=healthy,
        timestamp=datetime(2026, 1, 1, tzinfo=UTC),
    )


def _metric(telemetry: Telemetry, name: str) -> Any:
    return metrics_by_name(telemetry)[name]


def test_the_status_gauge_reports_the_last_result_per_component(telemetry: Telemetry) -> None:
    health = HealthTelemetry(telemetry.meter)

    health.record(_result("mysql-connection", True))
    health.record(_result("app-health", False))

    metric = _metric(telemetry, "health.check.status")
    assert metric.unit == "1"
    points = {point.attributes["health.component"]: point.value for point in metric.data.data_points}
    assert points == {"mysql-connection": 1, "app-health": 0}


def test_a_failed_check_increments_the_counter_once(telemetry: Telemetry) -> None:
    health = HealthTelemetry(telemetry.meter)

    health.record(_result("mysql-connection", False))
    health.record(_result("mysql-connection", False))

    metric = _metric(telemetry, "health.check.failures")
    assert metric.unit == "{check}"
    point = metric.data.data_points[0]
    assert point.value == 2
    assert point.attributes["health.component"] == "mysql-connection"
    assert point.attributes["error.type"] == "health_check_failed"


def test_failures_and_recoveries_log_only_on_transition(telemetry: Telemetry) -> None:
    health = HealthTelemetry(telemetry.meter)

    health.record(_result("mysql-connection", True))
    assert log_records(telemetry) == []

    health.record(_result("mysql-connection", False))
    health.record(_result("mysql-connection", False))
    warnings = [item.log_record for item in log_records(telemetry) if item.log_record.severity_text == "WARN"]
    assert len(warnings) == 1
    assert warnings[0].body == "health.check.failed"
    assert warnings[0].attributes["health.component"] == "mysql-connection"
    assert warnings[0].attributes["error.type"] == "health_check_failed"

    health.record(_result("mysql-connection", True))
    infos = [item.log_record for item in log_records(telemetry) if item.log_record.severity_text == "INFO"]
    assert [record.body for record in infos] == ["health.check.recovered"]


def test_the_health_meter_scope_is_the_service_name(telemetry: Telemetry) -> None:
    HealthTelemetry(telemetry.meter).record(_result("app-health", True))

    reader = telemetry.metric_reader
    assert isinstance(reader, InMemoryMetricReader)
    data = reader.get_metrics_data()
    scopes = [
        scope_metric.scope
        for resource_metric in data.resource_metrics
        for scope_metric in resource_metric.scope_metrics
        if any(item.name == "health.check.status" for item in scope_metric.metrics)
    ]
    assert len(scopes) == 1
    assert scopes[0].name == "template"
    assert scopes[0].version
