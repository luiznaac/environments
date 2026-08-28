"""Transport DTOs. Pydantic lives here, at the edge — never in `usecase`."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from template.usecase.health.checker import HealthCheckResult


class HealthCheckResponse(BaseModel):
    service_name: str
    is_healthy: bool
    timestamp: datetime

    @classmethod
    def from_domain(cls, result: HealthCheckResult) -> HealthCheckResponse:
        return cls(
            service_name=result.service_name,
            is_healthy=result.is_healthy,
            timestamp=result.timestamp,
        )
