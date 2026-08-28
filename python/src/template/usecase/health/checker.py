"""Health-check port + domain model.

Every adapter that can report on a dependency (MySQL, an HTTP client, a job)
implements `IHealthChecker`. The composition root collects them all into a list,
exactly like Spring collecting `Set<HealthChecker>`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class HealthCheckResult:
    service_name: str
    is_healthy: bool
    timestamp: datetime


@runtime_checkable
class IHealthChecker(Protocol):
    async def get_health_status(self) -> HealthCheckResult: ...
