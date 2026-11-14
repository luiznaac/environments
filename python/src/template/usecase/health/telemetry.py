"""Health instruments and transition logs — the OTel API half of the health slice.

The gauge reports the last observed result and never performs I/O; the counter
captures failures between exports. A WARN/INFO pair marks only state changes.
"""

from __future__ import annotations

from opentelemetry.metrics import CallbackOptions, Meter, Observation

from template.usecase.commons.logging import get_logger
from template.usecase.health.checker import HealthCheckResult

_ERROR_TYPE = "health_check_failed"


class HealthTelemetry:
    def __init__(self, meter: Meter) -> None:
        self._last: dict[str, bool] = {}
        self._log = get_logger(__name__)
        self._status = meter.create_observable_gauge(
            "health.check.status",
            callbacks=[self._observe],
            unit="1",
            description="The last observed health result per component.",
        )
        self._failures = meter.create_counter(
            "health.check.failures",
            unit="{check}",
            description="The number of failed health checks.",
        )

    def _observe(self, _: CallbackOptions) -> list[Observation]:
        return [
            Observation(1 if healthy else 0, {"health.component": component})
            for component, healthy in self._last.items()
        ]

    def record(self, result: HealthCheckResult) -> None:
        component = result.service_name
        previously_healthy = self._last.get(component)
        self._last[component] = result.is_healthy

        if not result.is_healthy:
            self._failures.add(
                1,
                {"health.component": component, "error.type": _ERROR_TYPE},
            )

        if previously_healthy is None:
            if not result.is_healthy:
                self._log.warning(
                    "health.check.failed",
                    **{"health.component": component, "error.type": _ERROR_TYPE},
                )
            return
        if previously_healthy and not result.is_healthy:
            self._log.warning(
                "health.check.failed",
                **{"health.component": component, "error.type": _ERROR_TYPE},
            )
        elif not previously_healthy and result.is_healthy:
            self._log.info("health.check.recovered", **{"health.component": component})
