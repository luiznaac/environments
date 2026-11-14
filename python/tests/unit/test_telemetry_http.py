"""ASGI-surface telemetry: request id, boundary records, catalog names and buckets.

Runs the real app over `httpx.ASGITransport` with a stub health checker and no
MySQL; DB-backed assertions live in the integration suite.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from fastapi.responses import JSONResponse
from opentelemetry.sdk._logs import ReadableLogRecord
from pytest_httpserver import HTTPServer

from template.application.container import Container
from template.application.telemetry import HTTP_DURATION_BUCKETS, Telemetry, build_telemetry
from template.usecase.commons.logging import configure_logging
from tests.fixtures import (
    StubHealthChecker,
    build_test_settings,
    log_records,
    metrics_by_name,
    new_log_records,
)


@pytest.fixture
def telemetry() -> Iterator[Telemetry]:
    instance = build_telemetry(build_test_settings())
    configure_logging("INFO", json=True)
    instance.install_log_bridge()
    try:
        yield instance
    finally:
        instance.shutdown()


@pytest.fixture
async def container(telemetry: Telemetry) -> AsyncIterator[Container]:
    instance = Container(
        build_test_settings(),
        telemetry=telemetry,
        health_checkers=[StubHealthChecker()],
    )

    @instance.app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("boom")

    @instance.app.get("/unavailable")
    async def unavailable() -> JSONResponse:
        return JSONResponse(status_code=503, content={"code": "unavailable"})

    @instance.app.get("/framework")
    async def framework() -> dict[str, bool]:
        logging.getLogger("some.framework").warning("plain framework message")
        return {"ok": True}

    @instance.app.get("/outbound")
    async def outbound(url: str) -> dict[str, int]:
        response = await instance.http_client.get(url)
        return {"status": response.status_code}

    try:
        yield instance
    finally:
        await instance.aclose()


@pytest.fixture
async def client(container: Container) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=container.app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http_client:
        yield http_client


def _failure_records(records: list[ReadableLogRecord]) -> list[ReadableLogRecord]:
    return [record for record in records if record.log_record.event_name == "http.request.failed"]


async def test_a_404_produces_one_warn_with_request_context(client: httpx.AsyncClient, telemetry: Telemetry) -> None:
    start = len(log_records(telemetry))

    response = await client.get("/nope", headers={"X-Request-ID": "abcdefgh"})

    assert response.status_code == 404
    assert response.headers["X-Request-ID"] == "abcdefgh"
    failures = _failure_records(new_log_records(telemetry, start))
    assert len(failures) == 1
    record = failures[0].log_record
    assert record.severity_text == "WARN"
    assert record.body == "http.request.failed"
    assert record.attributes["http.request.method"] == "GET"
    assert record.attributes["url.path"] == "/nope"
    assert record.attributes["http.response.status_code"] == 404
    assert record.attributes["error.type"] == "resource_not_found"
    assert record.attributes["request.id"] == "abcdefgh"
    assert "http.route" not in record.attributes
    assert "exception.type" not in record.attributes


async def test_an_invalid_inbound_request_id_is_replaced(client: httpx.AsyncClient) -> None:
    response = await client.get("/nope", headers={"X-Request-ID": "short"})

    generated = response.headers["X-Request-ID"]
    assert uuid.UUID(generated).version == 4


async def test_a_5xx_exception_produces_one_error_with_exception_semconv(
    client: httpx.AsyncClient, telemetry: Telemetry
) -> None:
    start = len(log_records(telemetry))

    response = await client.get("/boom", headers={"X-Request-ID": "abcdefgh"})

    assert response.status_code == 500
    assert response.headers["X-Request-ID"] == "abcdefgh"
    failures = _failure_records(new_log_records(telemetry, start))
    assert len(failures) == 1
    record = failures[0].log_record
    assert record.severity_text == "ERROR"
    assert record.attributes["http.response.status_code"] == 500
    assert record.attributes["error.type"] == "RuntimeError"
    assert record.attributes["exception.type"] == "RuntimeError"
    assert record.attributes["exception.message"] == "boom"
    assert record.attributes["request.id"] == "abcdefgh"


async def test_a_handled_5xx_response_still_produces_one_error(client: httpx.AsyncClient, telemetry: Telemetry) -> None:
    start = len(log_records(telemetry))

    response = await client.get("/unavailable", headers={"X-Request-ID": "abcdefgh"})

    assert response.status_code == 503
    failures = _failure_records(new_log_records(telemetry, start))
    assert len(failures) == 1
    record = failures[0].log_record
    assert record.severity_text == "ERROR"
    assert record.attributes["http.response.status_code"] == 503
    assert record.attributes["error.type"] == "http_503"
    assert "exception.type" not in record.attributes


async def test_a_success_echoes_the_request_id_and_emits_no_boundary_record(
    client: httpx.AsyncClient, telemetry: Telemetry
) -> None:
    start = len(log_records(telemetry))

    response = await client.get("/health", headers={"X-Request-ID": "abcdefgh"})

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "abcdefgh"
    assert _failure_records(new_log_records(telemetry, start)) == []


async def test_a_plain_framework_log_inside_a_request_carries_the_request_id(
    client: httpx.AsyncClient, telemetry: Telemetry
) -> None:
    start = len(log_records(telemetry))

    response = await client.get("/framework", headers={"X-Request-ID": "abcdefgh"})

    assert response.status_code == 200
    plain = [
        record.log_record
        for record in new_log_records(telemetry, start)
        if record.log_record.body == "plain framework message"
    ]
    assert len(plain) == 1
    assert plain[0].attributes["request.id"] == "abcdefgh"


async def test_the_shared_client_propagates_the_request_id(client: httpx.AsyncClient, httpserver: HTTPServer) -> None:
    httpserver.expect_request("/probe").respond_with_json({"ok": True})

    response = await client.get(
        "/outbound",
        params={"url": httpserver.url_for("/probe")},
        headers={"X-Request-ID": "abcdefgh"},
    )

    assert response.status_code == 200
    forwarded = httpserver.log[-1][0]
    assert forwarded.headers["X-Request-ID"] == "abcdefgh"


async def test_the_catalog_names_units_and_buckets_are_exact(
    client: httpx.AsyncClient, telemetry: Telemetry, httpserver: HTTPServer
) -> None:
    httpserver.expect_request("/probe").respond_with_json({"ok": True})
    await client.get("/health")
    await client.get("/outbound", params={"url": httpserver.url_for("/probe")})

    metrics = metrics_by_name(telemetry)

    server = metrics["http.server.request.duration"]
    assert server.unit == "s"
    health_point = next(point for point in server.data.data_points if point.attributes.get("http.route") == "/health")
    assert tuple(health_point.explicit_bounds) == HTTP_DURATION_BUCKETS
    assert len(health_point.bucket_counts) == len(HTTP_DURATION_BUCKETS) + 1

    active = metrics["http.server.active_requests"]
    assert active.unit == "{request}"
    assert all(point.value == 0 for point in active.data.data_points)

    client_duration = metrics["http.client.request.duration"]
    assert client_duration.unit == "s"
    assert all(tuple(point.explicit_bounds) == HTTP_DURATION_BUCKETS for point in client_duration.data.data_points)

    assert "http.server.request.count" not in metrics
    assert "http.server.request.body.size" not in metrics
    assert "http.server.response.body.size" not in metrics
    assert "http.client.duration" not in metrics
    assert "http.server.duration" not in metrics

    for item in metrics.values():
        for point in item.data.data_points:
            assert "request.id" not in point.attributes


async def test_an_unmatched_404_creates_no_new_series(client: httpx.AsyncClient, telemetry: Telemetry) -> None:
    await client.get("/nope-one")
    await client.get("/nope-two")

    server = metrics_by_name(telemetry)["http.server.request.duration"]
    unmatched = [point for point in server.data.data_points if "http.route" not in point.attributes]
    assert len(unmatched) == 1
    assert all(point.attributes.get("http.route") != "/nope-one" for point in server.data.data_points)


async def test_health_records_the_gauge_without_a_per_check_info_log(
    client: httpx.AsyncClient, telemetry: Telemetry
) -> None:
    start = len(log_records(telemetry))

    await client.get("/health")

    metrics = metrics_by_name(telemetry)
    status = metrics["health.check.status"]
    assert status.unit == "1"
    points = status.data.data_points
    assert len(points) == 1
    assert points[0].attributes["health.component"] == "app-health"
    assert points[0].value == 1
    assert "health.check.failures" not in metrics
    assert new_log_records(telemetry, start) == []


async def test_there_is_no_metrics_endpoint(client: httpx.AsyncClient) -> None:
    response = await client.get("/metrics")

    assert response.status_code == 404
