"""`AppHealthGateway` — implements `IHealthGateway`.

Calls the service's own `/health/internal` over HTTP, exactly like the Kotlin
template's `AppHealthGateway`. It exists to demonstrate an outbound HTTP call
and give the HTTP client health check something real to probe.
"""

from __future__ import annotations

import httpx


class AppHealthGateway:
    def __init__(self, client: httpx.AsyncClient, base_url: str) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")

    async def is_healthy(self) -> bool:
        response = await self._client.get(f"{self._base_url}/health/internal")
        response.raise_for_status()
        payload = response.json()
        return bool(payload["is_healthy"])
