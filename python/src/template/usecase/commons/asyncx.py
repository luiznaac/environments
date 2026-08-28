"""Async helpers — the `mapAsync` / `awaitAll` equivalents."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable


async def map_async[T, R](items: Iterable[T], fn: Callable[[T], Awaitable[R]]) -> list[R]:
    """Apply an async function to every item concurrently, preserving order."""
    results: list[R] = await asyncio.gather(*(fn(item) for item in items))
    return results
