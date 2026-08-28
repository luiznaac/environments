"""`SqlAlchemyTransactionTemplate` — implements `ITransactionTemplate`.

Repositories call `current_session()` to get the session bound to the running
transaction. Nested `execute(...)` calls join the outer transaction instead of
opening a new one — the same semantics as Exposed's `transaction { }`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import TypeVar

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

_T = TypeVar("_T")

_current_session: ContextVar[AsyncSession | None] = ContextVar("_current_session", default=None)


class SqlAlchemyTransactionTemplate:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def execute(self, block: Callable[[], Awaitable[_T]]) -> _T:
        if _current_session.get() is not None:
            return await block()

        async with self._session_factory() as session:
            token = _current_session.set(session)
            try:
                result = await block()
                await session.commit()
                return result
            except Exception:
                await session.rollback()
                raise
            finally:
                _current_session.reset(token)


def current_session() -> AsyncSession:
    session = _current_session.get()
    if session is None:
        msg = "No active transaction — wrap the call in ITransactionTemplate.execute(...)"
        raise RuntimeError(msg)
    return session
