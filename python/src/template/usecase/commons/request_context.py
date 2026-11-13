"""Request and job correlation carriers — language-native `ContextVar`s.

`X-Request-ID` is the only cross-service carrier. A request binds it at the
edge; background work binds a `job.id` at its task boundary. Structlog's
processor mirrors both into records, and the outbound client propagates the
request id.
"""

from __future__ import annotations

import contextvars
import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

REQUEST_ID_HEADER = "X-Request-ID"

_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{8,128}$")

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
_job_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("job_id", default=None)


def is_valid_request_id(value: str | None) -> bool:
    """An inbound id is kept only when it matches the benign charset and length."""
    if value is None:
        return False
    return _VALID_REQUEST_ID.fullmatch(value) is not None


def resolve_request_id(inbound: str | None) -> str:
    """Keep a valid inbound id; otherwise generate a lowercase canonical UUIDv4."""
    if inbound is not None and is_valid_request_id(inbound):
        return inbound
    return str(uuid.uuid4())


def current_request_id() -> str | None:
    return _request_id.get()


def current_job_id() -> str | None:
    return _job_id.get()


def bind_request_id(value: str) -> contextvars.Token[str | None]:
    return _request_id.set(value)


def reset_request_id(token: contextvars.Token[str | None]) -> None:
    _request_id.reset(token)


def new_job_id() -> str:
    return str(uuid.uuid4())


@contextmanager
def request_context(value: str) -> Iterator[str]:
    """Bind a request id for the duration of a block (tests and non-ASGI callers)."""
    token = bind_request_id(value)
    try:
        yield value
    finally:
        reset_request_id(token)


@contextmanager
def job_context(value: str | None = None) -> Iterator[str]:
    """Bind a job id for the duration of background work."""
    job_id = value or new_job_id()
    token = _job_id.set(job_id)
    try:
        yield job_id
    finally:
        _job_id.reset(token)
