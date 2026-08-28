"""Demonstrates the WireMock-equivalent: a real local HTTP server (pytest-httpserver)."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
from pytest_httpserver import HTTPServer

from template.gateway.health.app_health_gateway import AppHealthGateway
from template.gateway.health.http_client_health_check import HttpClientHealthCheck
from template.usecase.commons.time import FixedClock


async def test_gateway_reports_healthy_when_remote_says_so(httpserver: HTTPServer) -> None:
    httpserver.expect_request("/health/internal").respond_with_json({"is_healthy": True})

    async with httpx.AsyncClient() as client:
        gateway = AppHealthGateway(client, httpserver.url_for("/"))
        assert await gateway.is_healthy() is True


async def test_health_check_swallows_transport_errors() -> None:
    class _Boom:
        async def is_healthy(self) -> bool:
            raise RuntimeError("connection refused")

    check = HttpClientHealthCheck(_Boom(), FixedClock(datetime(2026, 1, 1, tzinfo=UTC)))
    result = await check.get_health_status()

    assert result.service_name == "http-client"
    assert result.is_healthy is False
