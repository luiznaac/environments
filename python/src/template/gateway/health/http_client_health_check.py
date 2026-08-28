"""`HttpClientHealthCheck` — implements `IHealthChecker` on top of `IHealthGateway`."""

from __future__ import annotations

from template.usecase.commons.time import IClock
from template.usecase.health.checker import HealthCheckResult
from template.usecase.health.gateway import IHealthGateway


class HttpClientHealthCheck:
    def __init__(self, health_gateway: IHealthGateway, clock: IClock) -> None:
        self._health_gateway = health_gateway
        self._clock = clock

    async def get_health_status(self) -> HealthCheckResult:
        try:
            is_healthy = await self._health_gateway.is_healthy()
        except Exception:  # a health check must never raise
            is_healthy = False

        return HealthCheckResult(
            service_name="http-client",
            is_healthy=is_healthy,
            timestamp=self._clock.now(),
        )
