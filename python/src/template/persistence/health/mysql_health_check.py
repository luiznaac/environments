"""`MySqlConnectionHealthCheck` — implements `IHealthChecker` against MySQL."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from template.usecase.commons.time import IClock
from template.usecase.health.checker import HealthCheckResult


class MySqlConnectionHealthCheck:
    def __init__(self, engine: AsyncEngine, clock: IClock) -> None:
        self._engine = engine
        self._clock = clock

    async def get_health_status(self) -> HealthCheckResult:
        try:
            async with self._engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            is_healthy = True
        except Exception:  # a health check must never raise
            is_healthy = False

        return HealthCheckResult(
            service_name="mysql-connection",
            is_healthy=is_healthy,
            timestamp=self._clock.now(),
        )
