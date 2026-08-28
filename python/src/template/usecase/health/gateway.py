"""Outbound port for a generic "is the remote healthy?" probe."""

from __future__ import annotations

from typing import Protocol


class IHealthGateway(Protocol):
    async def is_healthy(self) -> bool: ...
