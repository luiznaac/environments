"""Structured logging — the `logger()` extension + `logback.xml` equivalent.

`configure_logging` is called once from the composition root; everything else
just calls `get_logger(__name__)`.
"""

from __future__ import annotations

import logging

import structlog
from structlog.typing import FilteringBoundLogger

__all__ = ["configure_logging", "get_logger"]


def configure_logging(level: str = "INFO", *, json: bool = True) -> None:
    renderer: structlog.types.Processor = (
        structlog.processors.JSONRenderer() if json else structlog.dev.ConsoleRenderer()
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping()[level.upper()],
        ),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> FilteringBoundLogger:
    logger: FilteringBoundLogger = structlog.get_logger(name)
    return logger
