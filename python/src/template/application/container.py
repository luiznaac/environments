"""Composition root — the hand-written replacement for Spring's component scan.

This is the ONE place that knows every concrete class. It builds the object
graph once at startup, builds telemetry first, injects the meter and applies
the instrumentation, and exposes:

* `health_checkers` — every `IHealthChecker` implementation (like `Set<HealthChecker>`)
* `controllers`     — every `IController` implementation (like `Set<ControllerTemplate>`)
* `app`             — the wired FastAPI application

Tests build their own `Container` with fakes / a `FixedClock` and never touch
global state.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from template.application.settings import Settings
from template.application.telemetry import Telemetry, build_telemetry
from template.gateway.configuration.http_client import build_http_client
from template.gateway.health.app_health_gateway import AppHealthGateway
from template.gateway.health.http_client_health_check import HttpClientHealthCheck
from template.httpapi.configuration.server import build_app, install_request_context_middleware
from template.httpapi.controller.base import IController
from template.httpapi.controller.health_controller import HealthController
from template.persistence.configuration.database import build_engine, build_session_factory
from template.persistence.configuration.transaction import SqlAlchemyTransactionTemplate
from template.persistence.health.mysql_health_check import MySqlConnectionHealthCheck
from template.usecase.commons.time import IClock, SystemClock
from template.usecase.health.checker import IHealthChecker
from template.usecase.health.telemetry import HealthTelemetry


class Container:
    def __init__(
        self,
        settings: Settings,
        *,
        clock: IClock | None = None,
        telemetry: Telemetry | None = None,
        health_checkers: Sequence[IHealthChecker] | None = None,
    ) -> None:
        self.settings = settings
        self.clock: IClock = clock or SystemClock()
        self.telemetry: Telemetry = telemetry or build_telemetry(settings)

        # --- infrastructure singletons -------------------------------------
        self.engine: AsyncEngine = build_engine(settings.mysql.url)
        self.telemetry.instrument_engine(self.engine)
        self._session_factory = build_session_factory(self.engine)
        self.transaction_template = SqlAlchemyTransactionTemplate(self._session_factory)
        self.http_client: httpx.AsyncClient = build_http_client()
        self.telemetry.instrument_http_client()

        # --- health slice ------------------------------------------------
        self.health_telemetry = HealthTelemetry(self.telemetry.meter)
        if health_checkers is None:
            self._app_health_gateway = AppHealthGateway(self.http_client, settings.app_host)
            self.health_checkers: list[IHealthChecker] = [
                MySqlConnectionHealthCheck(self.engine, self.clock),
                HttpClientHealthCheck(self._app_health_gateway, self.clock),
            ]
        else:
            self.health_checkers = list(health_checkers)

        # --- http layer ------------------------------------------------
        self.controllers: list[IController] = [
            HealthController(self.health_checkers, self.health_telemetry),
        ]

        @asynccontextmanager
        async def lifespan(_: FastAPI) -> AsyncIterator[None]:
            yield
            await self.aclose()

        self.app = build_app(self.controllers, lifespan=lifespan)
        self.telemetry.instrument_app(self.app)
        install_request_context_middleware(self.app)
        self.telemetry.instrument_runtime()

    async def aclose(self) -> None:
        await self.http_client.aclose()
        await self.engine.dispose()
        await self.telemetry.async_shutdown()
