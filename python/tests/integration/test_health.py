from __future__ import annotations

import httpx


async def test_health_endpoint_reports_mysql_connection_up(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    by_service = {row["service_name"]: row["is_healthy"] for row in response.json()}
    assert by_service["mysql-connection"] is True


async def test_internal_liveness_probe(client: httpx.AsyncClient) -> None:
    response = await client.get("/health/internal")

    assert response.status_code == 200
    assert response.json() == {"is_healthy": True}
