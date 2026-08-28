"""Injectable clock — the equivalent of `TimeProviderConfig` in the Kotlin family.

Depend on `IClock` anywhere you need the current time so tests can freeze it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol, runtime_checkable


@runtime_checkable
class IClock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    """Production clock. Swap for a fixed clock in tests."""

    def now(self) -> datetime:
        return datetime.now(tz=UTC)


class FixedClock:
    """Test double: always returns the same instant."""

    def __init__(self, instant: datetime) -> None:
        self._instant = instant

    def now(self) -> datetime:
        return self._instant
