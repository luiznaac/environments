"""Contract tests for the SDK build: resource, config failure modes, runtime and pool."""

from __future__ import annotations

import logging
import uuid

import httpx
import pytest
from opentelemetry.sdk._logs.export import (
    ConsoleLogRecordExporter,
    InMemoryLogRecordExporter,
    LogRecordExporter,
)
from opentelemetry.sdk.metrics.export import (
    ConsoleMetricExporter,
    InMemoryMetricReader,
)
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import get_tracer_provider
from sqlalchemy.ext.asyncio import create_async_engine

from template.application.container import Container
from template.application.settings import Settings
from template.application.telemetry import TelemetryConfigError, build_telemetry
from tests.fixtures import StubHealthChecker, build_test_settings, metric, metric_names


def test_dev_defaults_the_endpoint_to_localhost(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    monkeypatch.delenv("TELEMETRY_CONSOLE", raising=False)

    settings = Settings(_env_file=None, app_env="dev")

    assert settings.telemetry.service_name == "template"
    assert settings.telemetry.endpoint == "http://localhost:4318"
    assert settings.telemetry.console is False


def test_the_standard_env_names_configure_the_group(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_SERVICE_NAME", "shougong")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318")
    monkeypatch.setenv("TELEMETRY_CONSOLE", "true")

    settings = Settings(_env_file=None, app_env="dev")

    assert settings.telemetry.service_name == "shougong"
    assert settings.telemetry.endpoint == "http://otel-collector:4318"
    assert settings.telemetry.console is True


def test_prod_without_an_endpoint_fails_at_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

    settings = Settings(_env_file=None, app_env="prod")

    with pytest.raises(TelemetryConfigError, match="OTEL_EXPORTER_OTLP_ENDPOINT"):
        build_telemetry(settings)


def test_dev_without_a_collector_still_builds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

    telemetry = build_telemetry(Settings(_env_file=None, app_env="dev"))
    try:
        assert telemetry.metric_reader is not None
    finally:
        telemetry.shutdown()


def test_console_swaps_both_exporters(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TELEMETRY_CONSOLE", "true")

    telemetry = build_telemetry(Settings(_env_file=None, app_env="dev"))
    try:
        assert isinstance(telemetry.metric_exporter, ConsoleMetricExporter)
        assert isinstance(telemetry.log_exporter, ConsoleLogRecordExporter)
    finally:
        telemetry.shutdown()


def test_console_is_never_a_prod_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    monkeypatch.setenv("TELEMETRY_CONSOLE", "true")

    telemetry = build_telemetry(Settings(_env_file=None, app_env="prod"))
    try:
        assert not isinstance(telemetry.metric_exporter, ConsoleMetricExporter)
        assert not isinstance(telemetry.log_exporter, ConsoleLogRecordExporter)
    finally:
        telemetry.shutdown()


def test_the_test_profile_exports_nothing() -> None:
    telemetry = build_telemetry(build_test_settings())
    try:
        assert isinstance(telemetry.metric_reader, InMemoryMetricReader)
        assert telemetry.metric_exporter is None
        assert isinstance(telemetry.log_exporter, InMemoryLogRecordExporter)
        assert isinstance(telemetry.log_exporter, LogRecordExporter)
    finally:
        telemetry.shutdown()


def test_no_tracer_provider_is_constructed() -> None:
    telemetry = build_telemetry(build_test_settings())
    try:
        assert not isinstance(get_tracer_provider(), TracerProvider)
    finally:
        telemetry.shutdown()


def test_the_six_resource_attributes_are_present(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SERVICE_VERSION", "2.3.4")
    monkeypatch.setenv("HOSTNAME", "host-from-env")

    telemetry = build_telemetry(build_test_settings())
    try:
        attributes = dict(telemetry.resource.attributes)
        assert attributes["service.name"] == "template"
        assert attributes["service.namespace"] == "luiznaac"
        assert attributes["service.version"] == "2.3.4"
        assert attributes["deployment.environment.name"] == "test"
        assert attributes["host.name"] == "host-from-env"
        assert uuid.UUID(attributes["service.instance.id"]).version == 4
    finally:
        telemetry.shutdown()


def test_the_runtime_subset_is_installed_and_system_metrics_are_excluded() -> None:
    telemetry = build_telemetry(build_test_settings())
    try:
        telemetry.instrument_runtime()
        names = metric_names(telemetry)
        for required in (
            "process.cpu.time",
            "process.memory.usage",
            "process.open_file_descriptor.count",
            "process.thread.count",
            "cpython.gc.collections",
            "cpython.gc.collected_objects",
            "cpython.gc.uncollectable_objects",
        ):
            assert required in names
        assert not any(name.startswith("system.") for name in names)
        assert not any(name.startswith("process.runtime.") for name in names)
    finally:
        telemetry.shutdown()


async def test_the_pool_series_are_emitted_under_the_catalog_names() -> None:
    telemetry = build_telemetry(build_test_settings())
    engine = create_async_engine("mysql+asyncmy://user:pass@localhost:3306/shop")
    try:
        telemetry.instrument_engine(engine)
        count = metric(telemetry, "db.client.connection.count")
        limit = metric(telemetry, "db.client.connection.limit")
        pending = metric(telemetry, "db.client.connection.pending_requests")

        assert count.unit == "{connection}"
        assert limit.unit == "{connection}"
        assert pending.unit == "{request}"

        points = count.data.data_points
        states = {point.attributes["db.client.connection.state"] for point in points}
        assert states == {"idle", "used"}
        for point in points:
            assert point.attributes["db.system.name"] == "mysql"
            assert point.attributes["db.namespace"] == "shop"
            assert point.attributes["db.client.connection.pool.name"]
    finally:
        await engine.dispose()
        telemetry.shutdown()


async def test_a_down_collector_boots_serves_and_logs_a_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TIMEOUT", "1")
    settings = Settings(_env_file=None, app_env="dev")
    telemetry = build_telemetry(settings)
    container = Container(settings, telemetry=telemetry, health_checkers=[StubHealthChecker()])
    try:
        transport = httpx.ASGITransport(app=container.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/health")
        assert response.status_code == 200

        telemetry.meter.create_counter("evidence.down").add(1)
        with caplog.at_level(logging.WARNING):
            telemetry.meter_provider.force_flush(timeout_millis=500)
        assert any("export" in record.getMessage().lower() for record in caplog.records)
    finally:
        telemetry.shutdown()
        await container.aclose()
