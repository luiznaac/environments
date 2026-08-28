"""`ITransactionTemplate` — "run this block inside one DB transaction".

Lets a use-case service compose several repository calls atomically without
importing SQLAlchemy. Implemented in `persistence`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol, TypeVar

_T = TypeVar("_T")


class ITransactionTemplate(Protocol):
    async def execute(self, block: Callable[[], Awaitable[_T]]) -> _T: ...
