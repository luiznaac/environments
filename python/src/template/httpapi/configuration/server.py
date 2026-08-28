"""FastAPI app factory — the `KtorConfig` equivalent.

Takes the list of controllers assembled by the composition root and mounts
each one. Also installs the domain-exception handlers.
"""

from __future__ import annotations

from collections.abc import Sequence
from contextlib import AbstractAsyncContextManager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from template.httpapi.controller.base import IController
from template.usecase.commons.exceptions import (
    DomainError,
    InvalidArgumentError,
    ResourceNotFoundError,
)
from template.usecase.commons.logging import get_logger

_log = get_logger(__name__)

type Lifespan = AbstractAsyncContextManager[None]


def build_app(
    controllers: Sequence[IController],
    *,
    lifespan: object | None = None,
) -> FastAPI:
    app = FastAPI(title="template", lifespan=lifespan)  # type: ignore[arg-type]

    for controller in controllers:
        _log.info("route.init", controller=type(controller).__name__)
        app.include_router(controller.router())

    _install_exception_handlers(app)
    return app


def _install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ResourceNotFoundError)
    async def _not_found(_: Request, exc: ResourceNotFoundError) -> JSONResponse:
        return _problem(404, "resource_not_found", str(exc))

    @app.exception_handler(InvalidArgumentError)
    async def _invalid(_: Request, exc: InvalidArgumentError) -> JSONResponse:
        return _problem(400, "invalid_argument", str(exc))

    @app.exception_handler(DomainError)
    async def _domain(_: Request, exc: DomainError) -> JSONResponse:
        return _problem(422, "domain_error", str(exc))


def _problem(status: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"code": code, "detail": detail})
