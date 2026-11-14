"""FastAPI app factory — the `KtorConfig` equivalent.

Takes the list of controllers assembled by the composition root and mounts
each one. Also installs the domain-exception handlers and the outermost
request-id middleware that owns the boundary records.
"""

from __future__ import annotations

from collections.abc import Sequence
from contextlib import AbstractAsyncContextManager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from template.httpapi.controller.base import IController
from template.usecase.commons.exceptions import (
    DomainError,
    InvalidArgumentError,
    ResourceNotFoundError,
)
from template.usecase.commons.logging import get_logger
from template.usecase.commons.request_context import (
    REQUEST_ID_HEADER,
    bind_request_id,
    current_request_id,
    reset_request_id,
    resolve_request_id,
)

_log = get_logger(__name__)

type Lifespan = AbstractAsyncContextManager[None]

_STATUS_ERROR_TYPES: dict[int, str] = {
    400: "invalid_argument",
    401: "unauthorized",
    403: "forbidden",
    404: "resource_not_found",
    409: "conflict",
    422: "domain_error",
}


class RequestContextMiddleware:
    """Bind the request id before routing and own the 4xx WARN / 5xx ERROR records."""

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        request_id = resolve_request_id(Headers(scope=scope).get(REQUEST_ID_HEADER))
        token = bind_request_id(request_id)
        scope.setdefault("state", {})["request_id"] = request_id
        status_code: int | None = None
        response_started = False

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code, response_started
            if message["type"] == "http.response.start":
                response_started = True
                status_code = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self._app(scope, receive, send_with_request_id)
        except Exception as error:
            _log_5xx(scope, error)
            if response_started:
                raise
            response = JSONResponse(
                status_code=500,
                content={"code": "internal_error", "detail": "Internal Server Error"},
            )
            await response(scope, receive, send_with_request_id)
        else:
            if status_code is not None and 400 <= status_code < 500:
                _log_4xx(scope, status_code)
            elif status_code is not None and 500 <= status_code < 600:
                _log_5xx_response(scope, status_code)
        finally:
            reset_request_id(token)


def _request_attributes(scope: Scope, status_code: int) -> dict[str, object]:
    attributes: dict[str, object] = {
        "http.request.method": scope.get("method", ""),
        "http.response.status_code": status_code,
        "request.id": current_request_id(),
    }
    route = scope.get("route")
    route_path = getattr(route, "path_format", None) or getattr(route, "path", None)
    if route_path:
        attributes["http.route"] = route_path
    else:
        attributes["url.path"] = scope.get("path", "")
    return {key: value for key, value in attributes.items() if value is not None}


def _log_4xx(scope: Scope, status_code: int) -> None:
    state = scope.get("state") or {}
    error_type = state.get("error_type") or _STATUS_ERROR_TYPES.get(status_code, f"http_{status_code}")
    _log.warning(
        "http.request.failed",
        **{**_request_attributes(scope, status_code), "error.type": error_type},
    )


def _log_5xx(scope: Scope, error: Exception) -> None:
    _log.error(
        "http.request.failed",
        exc_info=error,
        **{**_request_attributes(scope, 500), "error.type": type(error).__name__},
    )


def _log_5xx_response(scope: Scope, status_code: int) -> None:
    state = scope.get("state") or {}
    error_type = state.get("error_type") or f"http_{status_code}"
    _log.error(
        "http.request.failed",
        **{**_request_attributes(scope, status_code), "error.type": error_type},
    )


def install_request_context_middleware(app: FastAPI) -> None:
    """Add the outermost middleware after instrumentation; last added wins."""
    app.add_middleware(RequestContextMiddleware)


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
    async def _not_found(request: Request, exc: ResourceNotFoundError) -> JSONResponse:
        return _problem(request, 404, "resource_not_found", str(exc))

    @app.exception_handler(InvalidArgumentError)
    async def _invalid(request: Request, exc: InvalidArgumentError) -> JSONResponse:
        return _problem(request, 400, "invalid_argument", str(exc))

    @app.exception_handler(DomainError)
    async def _domain(request: Request, exc: DomainError) -> JSONResponse:
        return _problem(request, 422, "domain_error", str(exc))


def _problem(request: Request, status: int, code: str, detail: str) -> JSONResponse:
    request.state.error_type = code
    return JSONResponse(status_code=status, content={"code": code, "detail": detail})
