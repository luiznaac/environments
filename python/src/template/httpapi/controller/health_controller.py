"""`HealthController` — the one worked example endpoint.

`GET /health`          aggregates every `IHealthChecker`.
`GET /health/internal` is the cheap liveness probe `AppHealthGateway` calls.
"""

from __future__ import annotations

from collections.abc import Sequence

from fastapi import APIRouter

from template.httpapi.schema import HealthCheckResponse
from template.usecase.commons.asyncx import map_async
from template.usecase.health.checker import IHealthChecker


class HealthController:
    def __init__(self, health_checkers: Sequence[IHealthChecker]) -> None:
        self._health_checkers = health_checkers

    def router(self) -> APIRouter:
        router = APIRouter(tags=["health"])

        @router.get("/health")
        async def health() -> list[HealthCheckResponse]:
            results = await map_async(
                self._health_checkers,
                lambda checker: checker.get_health_status(),
            )
            return [HealthCheckResponse.from_domain(result) for result in results]

        @router.get("/health/internal")
        async def health_internal() -> dict[str, bool]:
            return {"is_healthy": True}

        return router
