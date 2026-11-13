"""Shared outbound HTTP client — the `KtorClientConfig` equivalent.

One `httpx.AsyncClient` is built by the composition root and injected into every
gateway, so connection pools are reused. It is closed on app shutdown. Every
outbound call carries the request id bound by the edge.
"""

from __future__ import annotations

import httpx

from template.usecase.commons.request_context import REQUEST_ID_HEADER, current_request_id

_DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


async def _propagate_request_id(request: httpx.Request) -> None:
    request_id = current_request_id()
    if request_id is not None and REQUEST_ID_HEADER not in request.headers:
        request.headers[REQUEST_ID_HEADER] = request_id


def build_http_client(*, timeout: httpx.Timeout = _DEFAULT_TIMEOUT) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=timeout,
        event_hooks={"request": [_propagate_request_id]},
    )
