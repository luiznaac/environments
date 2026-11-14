"""Structured logging — structlog stays the API, stdlib logging is the chokepoint.

The stdlib factory lets framework logs (uvicorn, FastAPI, httpx) flow through
the same record shape. A terminal processor splits the event name from its
attributes; the OTel logging instrumentation and a console handler render the
same stdlib record in the two contract renderings.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import traceback
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Final

import structlog
from structlog.stdlib import BoundLogger
from structlog.typing import EventDict, WrappedLogger

from template.usecase.commons.request_context import current_job_id, current_request_id

__all__ = [
    "SENSITIVE_DATA_FILTER",
    "SensitiveDataFilter",
    "configure_logging",
    "get_logger",
]

_LEVELS: Final[dict[str, str]] = {
    "DEBUG": "DEBUG",
    "INFO": "INFO",
    "WARNING": "WARN",
    "WARN": "WARN",
    "ERROR": "ERROR",
    "CRITICAL": "FATAL",
}

_RESERVED_ATTRS: Final[frozenset[str]] = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "message",
        "module",
        "msecs",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)

_SECRET_KEY = re.compile(
    r"(password|passphrase|token|secret|api[-_]?key|private[-_]?key|session[-_]?id"
    r"|authorization|cookie|set[-_]?cookie|credential|connection[-_]?string)",
    re.IGNORECASE,
)
_BODY_KEY = re.compile(r"(^|[._])(body|payload)$", re.IGNORECASE)

_REDACTED = "[REDACTED]"


class _Drop:
    pass


_DROP = _Drop()


def _redact(key: str, value: Any) -> Any:
    if _BODY_KEY.search(key):
        return _DROP
    if _SECRET_KEY.search(key):
        if isinstance(value, dict | list | tuple):
            return _DROP
        return _REDACTED
    if isinstance(value, dict):
        redacted = {child_key: _redact(child_key, child_value) for child_key, child_value in value.items()}
        return {child_key: child_value for child_key, child_value in redacted.items() if child_value is not _DROP}
    if isinstance(value, list | tuple):
        return [_redact(key, item) for item in value]
    return value


def _redact_event_dict(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    event_name = str(event_dict.get("event", ""))
    event_dict["event.name"] = event_name
    for key in list(event_dict):
        if key in ("event", "event.name"):
            continue
        value = _redact(key, event_dict[key])
        if value is _DROP:
            del event_dict[key]
        else:
            event_dict[key] = value
    return event_dict


class SensitiveDataFilter(logging.Filter):
    """Defense-in-depth on every handler: stamp `event.name`, redact secrets."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not getattr(record, "event.name", None):
            record.__dict__["event.name"] = record.getMessage()
        request_id = current_request_id()
        if request_id is not None and "request.id" not in record.__dict__:
            record.__dict__["request.id"] = request_id
        job_id = current_job_id()
        if job_id is not None and "job.id" not in record.__dict__:
            record.__dict__["job.id"] = job_id
        for key in list(record.__dict__):
            if key in _RESERVED_ATTRS or key in ("event.name", "event"):
                continue
            value = _redact(key, record.__dict__[key])
            if value is _DROP:
                del record.__dict__[key]
            else:
                record.__dict__[key] = value
        return True


SENSITIVE_DATA_FILTER = SensitiveDataFilter()


def _correlation_processor(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    request_id = current_request_id()
    if request_id is not None:
        event_dict.setdefault("request.id", request_id)
    job_id = current_job_id()
    if job_id is not None:
        event_dict.setdefault("job.id", job_id)
    return event_dict


def _split_event(_: WrappedLogger, __: str, event_dict: EventDict) -> tuple[tuple[str], dict[str, Any]]:
    """Return the stdlib call: the event name is the body, the rest are attributes."""
    event = str(event_dict.pop("event", ""))
    event_dict.pop("level", None)
    event_dict.pop("timestamp", None)
    exc_info = event_dict.pop("exc_info", None)
    kwargs: dict[str, Any] = {"extra": event_dict}
    if exc_info is not None:
        kwargs["exc_info"] = exc_info
    return (event,), kwargs


class _StdoutHandler(logging.StreamHandler[Any]):
    """Resolve `sys.stdout` at emit time so capture tools (and reloads) see the record."""

    def emit(self, record: logging.LogRecord) -> None:
        self.stream = sys.stdout
        super().emit(record)


class _ConsoleFormatter(logging.Formatter):
    def __init__(self, *, json_output: bool, resource: Mapping[str, Any] | None = None) -> None:
        super().__init__()
        self._json = json_output
        self._resource = dict(resource or {})

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "severity_text": _LEVELS.get(record.levelname, record.levelname),
            "body": record.getMessage(),
            "event.name": getattr(record, "event.name", record.getMessage()),
        }
        if self._resource:
            payload["resource"] = self._resource
        for key, value in vars(record).items():
            if key in _RESERVED_ATTRS or key in ("event.name", "event"):
                continue
            payload[key] = value
        if record.exc_info:
            exc_type, exc, tb = record.exc_info
            payload["exception.type"] = exc_type.__name__ if exc_type else None
            payload["exception.message"] = str(exc) if exc else None
            payload["exception.stacktrace"] = "".join(traceback.format_exception(exc_type, exc, tb))
        if self._json:
            return json.dumps(payload, default=str, ensure_ascii=False)
        attributes = " ".join(
            f"{key}={value!r}"
            for key, value in payload.items()
            if key not in ("timestamp", "severity_text", "body", "event.name")
        )
        return f"{payload['timestamp']} {payload['severity_text']:<5} {payload['body']} {attributes}".rstrip()


def configure_logging(
    level: str = "INFO",
    *,
    json: bool = True,
    resource: Mapping[str, Any] | None = None,
) -> None:
    level_number = logging.getLevelNamesMapping()[level.upper()]
    root = logging.getLogger()
    root.setLevel(level_number)
    root.handlers.clear()

    console = _StdoutHandler(sys.stdout)
    console.setFormatter(_ConsoleFormatter(json_output=json, resource=resource))
    console.addFilter(SENSITIVE_DATA_FILTER)
    root.addHandler(console)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True
    logging.getLogger("uvicorn.access").disabled = True
    for name in ("httpx", "httpcore"):
        # The client library's per-request INFO line is an access log; metrics own volume.
        logging.getLogger(name).setLevel(logging.WARNING)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            _correlation_processor,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _redact_event_dict,
            _split_event,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=False,
    )


def get_logger(name: str | None = None) -> BoundLogger:
    logger: BoundLogger = structlog.get_logger(name)
    return logger
