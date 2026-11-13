"""OpenTelemetry SDK lifecycle — the one place that builds providers and exporters.

The OTel *API* stays in `usecase`; the SDK, exporters and framework
instrumentation live here, in the composition root's layer. No tracer provider
is ever constructed: this service ships logs and metrics only.
"""

from __future__ import annotations

import importlib.metadata
import logging
import socket
import uuid
from collections.abc import Iterable, Sequence
from typing import Any

import anyio
from fastapi import FastAPI
from opentelemetry import _logs, metrics
from opentelemetry._logs import get_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.instrumentation.logging.handler import LoggingHandler as OtelLoggingHandler
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor
from opentelemetry.metrics import CallbackOptions, Meter, Observation
from opentelemetry.sdk._logs import LoggerProvider, LogRecordProcessor
from opentelemetry.sdk._logs.export import (
    BatchLogRecordProcessor,
    ConsoleLogRecordExporter,
    InMemoryLogRecordExporter,
    LogRecordExporter,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    ConsoleMetricExporter,
    InMemoryMetricReader,
    MetricExporter,
    MetricReader,
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.metrics.view import DropAggregation, ExplicitBucketHistogramAggregation, View
from opentelemetry.sdk.resources import Resource
from sqlalchemy.ext.asyncio import AsyncEngine

from template.application.settings import Settings
from template.httpapi.configuration.telemetry import instrument_app as instrument_fastapi_app
from template.usecase.commons.exceptions import DomainError
from template.usecase.commons.logging import SENSITIVE_DATA_FILTER

_log = logging.getLogger(__name__)

SERVICE_NAMESPACE = "luiznaac"
DEV_ENDPOINT = "http://localhost:4318"
SHUTDOWN_TIMEOUT_SECONDS = 10.0

HTTP_DURATION_BUCKETS: tuple[float, ...] = (
    0.005,
    0.01,
    0.025,
    0.05,
    0.075,
    0.1,
    0.25,
    0.5,
    0.75,
    1,
    2.5,
    5,
    7.5,
    10,
)
DB_OPERATION_BUCKETS: tuple[float, ...] = (0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10)

RUNTIME_METRICS: dict[str, list[str] | None] = {
    "process.cpu.time": ["user", "system"],
    "process.memory.usage": None,
    "process.open_file_descriptor.count": None,
    "process.thread.count": None,
    "cpython.gc.collections": None,
    "cpython.gc.collected_objects": None,
    "cpython.gc.uncollectable_objects": None,
}

_LEGACY_DB_CONNECTIONS_USAGE = "db.client.connections.usage"
_LEGACY_HTTP_METRICS = (
    "http.server.duration",
    "http.client.duration",
    "http.server.request.size",
    "http.server.response.size",
    "http.server.request.body.size",
    "http.server.response.body.size",
    "http.client.request.body.size",
    "http.client.response.body.size",
)


class TelemetryConfigError(DomainError):
    """A telemetry configuration that must fail at boot, loudly."""


def _installed_version() -> str:
    try:
        return importlib.metadata.version("template")
    except importlib.metadata.PackageNotFoundError:
        return "0.0.0"


def _build_resource(settings: Settings) -> Resource:
    config = settings.telemetry
    return Resource.create(
        {
            "service.name": config.service_name,
            "service.namespace": SERVICE_NAMESPACE,
            "service.version": config.service_version or _installed_version(),
            "deployment.environment.name": settings.app_env,
            "service.instance.id": str(uuid.uuid4()),
            "host.name": config.host_name or socket.gethostname(),
        }
    )


def _views() -> Sequence[View]:
    views: list[View] = [
        View(
            instrument_name="http.server.request.duration",
            attribute_keys={
                "http.request.method",
                "http.route",
                "http.response.status_code",
                "error.type",
                "url.scheme",
                "network.protocol.version",
            },
            aggregation=ExplicitBucketHistogramAggregation(boundaries=HTTP_DURATION_BUCKETS),
        ),
        View(
            instrument_name="http.client.request.duration",
            attribute_keys={
                "http.request.method",
                "server.address",
                "server.port",
                "http.response.status_code",
                "error.type",
            },
            aggregation=ExplicitBucketHistogramAggregation(boundaries=HTTP_DURATION_BUCKETS),
        ),
        View(
            instrument_name="db.client.operation.duration",
            aggregation=ExplicitBucketHistogramAggregation(boundaries=DB_OPERATION_BUCKETS),
        ),
        View(instrument_name=_LEGACY_DB_CONNECTIONS_USAGE, aggregation=DropAggregation()),
    ]
    views.extend(View(instrument_name=name, aggregation=DropAggregation()) for name in _LEGACY_HTTP_METRICS)
    return views


class Telemetry:
    """The built SDK plus the instrumentors the composition root applies."""

    def __init__(
        self,
        *,
        resource: Resource,
        meter_provider: MeterProvider,
        logger_provider: LoggerProvider,
        metric_reader: MetricReader,
        metric_exporter: MetricExporter | None,
        log_exporter: LogRecordExporter | None,
        service_name: str,
        service_version: str,
    ) -> None:
        self.resource = resource
        self.meter_provider = meter_provider
        self.logger_provider = logger_provider
        self.metric_reader = metric_reader
        self.metric_exporter = metric_exporter
        self.log_exporter = log_exporter
        self.meter: Meter = meter_provider.get_meter(service_name, service_version)
        self._shutdown = False

    def install_log_bridge(self) -> None:
        """Attach the OTel handler to the root logger; depends on stdlib logging."""
        instrumentor = LoggingInstrumentor()
        _uninstrument_if_active(instrumentor)
        if get_logger_provider() is self.logger_provider:
            instrumentor.instrument(set_logging_format=False, log_code_attributes=False)
        else:
            logging.getLogger().addHandler(
                OtelLoggingHandler(logger_provider=self.logger_provider, log_code_attributes=False)
            )
        for handler in logging.getLogger().handlers:
            if isinstance(handler, OtelLoggingHandler):
                handler.addFilter(SENSITIVE_DATA_FILTER)

    def instrument_runtime(self) -> None:
        instrumentor = SystemMetricsInstrumentor(config=RUNTIME_METRICS)
        _uninstrument_if_active(instrumentor)
        instrumentor.instrument(meter_provider=self.meter_provider)

    def instrument_engine(self, engine: AsyncEngine) -> None:
        instrumentor = SQLAlchemyInstrumentor()
        _uninstrument_if_active(instrumentor)
        instrumentor.instrument(engine=engine.sync_engine, meter_provider=self.meter_provider)
        self._install_pool_instruments(engine)

    def instrument_http_client(self) -> None:
        instrumentor = HTTPXClientInstrumentor()
        _uninstrument_if_active(instrumentor)
        instrumentor.instrument(meter_provider=self.meter_provider)

    def instrument_app(self, app: FastAPI) -> None:
        instrument_fastapi_app(app, meter_provider=self.meter_provider)

    def _install_pool_instruments(self, engine: AsyncEngine) -> None:
        pool: Any = engine.pool
        attributes = {
            "db.client.connection.pool.name": getattr(pool, "logging_name", None) or "default",
            "db.system.name": _db_system(engine.url.drivername),
            "db.namespace": engine.url.database or "",
        }

        def count(_: CallbackOptions) -> Iterable[Observation]:
            yield Observation(pool.checkedout(), {**attributes, "db.client.connection.state": "used"})
            yield Observation(pool.checkedin(), {**attributes, "db.client.connection.state": "idle"})

        def limit(_: CallbackOptions) -> Iterable[Observation]:
            yield Observation(pool.size() + getattr(pool, "_max_overflow", 0), attributes)

        def pending(_: CallbackOptions) -> Iterable[Observation]:
            # SQLAlchemy's pool does not expose waiter counts; the series is present at 0.
            yield Observation(0, attributes)

        self.meter.create_observable_up_down_counter(
            "db.client.connection.count",
            callbacks=[count],
            unit="{connection}",
            description="The number of connections in state idle or used.",
        )
        self.meter.create_observable_up_down_counter(
            "db.client.connection.limit",
            callbacks=[limit],
            unit="{connection}",
            description="The maximum number of connections the pool may open.",
        )
        self.meter.create_observable_up_down_counter(
            "db.client.connection.pending_requests",
            callbacks=[pending],
            unit="{request}",
            description="The number of requests waiting for a connection.",
        )

    def shutdown(self) -> None:
        if self._shutdown:
            return
        self._shutdown = True
        self.logger_provider.shutdown()
        self.meter_provider.shutdown()

    async def async_shutdown(self) -> None:
        try:
            with anyio.fail_after(SHUTDOWN_TIMEOUT_SECONDS):
                await anyio.to_thread.run_sync(self.shutdown)
        except TimeoutError:
            _log.warning("telemetry.shutdown.timeout")


def _uninstrument_if_active(instrumentor: Any) -> None:
    if getattr(instrumentor, "_is_instrumented_by_opentelemetry", False):
        instrumentor.uninstrument()


def _db_system(drivername: str) -> str:
    driver = drivername.split("+", 1)[0]
    return "mysql" if "mysql" in driver else driver


def build_telemetry(
    settings: Settings,
    *,
    metric_reader: MetricReader | None = None,
    log_exporter: LogRecordExporter | None = None,
    log_processor: LogRecordProcessor | None = None,
) -> Telemetry:
    """Build the providers once; fail at boot when prod has no endpoint."""
    config = settings.telemetry
    if settings.app_env == "prod" and not config.endpoint:
        raise TelemetryConfigError(
            "OTEL_EXPORTER_OTLP_ENDPOINT is required under APP_ENV=prod — refusing to start a silent service"
        )

    is_test = settings.app_env == "test"
    console = config.console and settings.app_env != "prod"
    endpoint = (config.endpoint or DEV_ENDPOINT).rstrip("/")
    resource = _build_resource(settings)
    service_version = str(resource.attributes.get("service.version") or "0.0.0")

    metric_exporter: MetricExporter | None = None
    if metric_reader is None:
        if is_test:
            metric_reader = InMemoryMetricReader()
        elif console:
            metric_exporter = ConsoleMetricExporter()
            metric_reader = PeriodicExportingMetricReader(
                metric_exporter,
                export_interval_millis=config.metric_export_interval_ms,
            )
        else:
            metric_exporter = OTLPMetricExporter(endpoint=f"{endpoint}/v1/metrics")
            metric_reader = PeriodicExportingMetricReader(
                metric_exporter,
                export_interval_millis=config.metric_export_interval_ms,
            )

    meter_provider = MeterProvider([metric_reader], resource=resource, views=_views())

    if log_exporter is None:
        if is_test:
            log_exporter = InMemoryLogRecordExporter()  # type: ignore[no-untyped-call]
        elif console:
            log_exporter = ConsoleLogRecordExporter()
        else:
            log_exporter = OTLPLogExporter(endpoint=f"{endpoint}/v1/logs")

    if log_processor is None:
        if is_test:
            log_processor = SimpleLogRecordProcessor(log_exporter)
        else:
            log_processor = BatchLogRecordProcessor(
                log_exporter,
                schedule_delay_millis=config.batch_schedule_delay_ms,
                max_queue_size=2048,
                export_timeout_millis=10000,
            )

    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(log_processor)

    if not isinstance(metrics.get_meter_provider(), MeterProvider):
        metrics.set_meter_provider(meter_provider)
    if not isinstance(get_logger_provider(), LoggerProvider):
        _logs.set_logger_provider(logger_provider)

    return Telemetry(
        resource=resource,
        meter_provider=meter_provider,
        logger_provider=logger_provider,
        metric_reader=metric_reader,
        metric_exporter=metric_exporter,
        log_exporter=log_exporter,
        service_name=config.service_name,
        service_version=service_version,
    )


__all__ = ["Telemetry", "TelemetryConfigError", "build_telemetry"]
