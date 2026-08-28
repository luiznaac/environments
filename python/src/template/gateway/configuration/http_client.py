"""Shared outbound HTTP client — the `KtorClientConfig` equivalent.

One `httpx.AsyncClient` is built by the composition root and injected into every
gateway, so connection pools are reused. It is closed on app shutdown.
"""

from __future__ import annotations

import httpx

_DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def build_http_client(*, timeout: httpx.Timeout = _DEFAULT_TIMEOUT) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout)
