"""FastAPI/ASGI instrumentation — installed by the composition root, never in `usecase`."""

from __future__ import annotations

from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

__all__ = ["instrument_app"]


def instrument_app(app: FastAPI, *, meter_provider: object) -> None:
    """Attach the official ASGI middleware; spans are no-ops without a tracer provider."""
    FastAPIInstrumentor.instrument_app(app, meter_provider=meter_provider)  # type: ignore[arg-type]
