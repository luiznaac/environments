"""DB-backed telemetry evidence: both health components and the SQLAlchemy pool series.

These assertions are extra evidence, not the PR gate — the fast gate is
`uv run poe check`, which runs the unit lane without Docker.
"""

from __future__ import annotations

import httpx
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from template.application.container import Container


def _metrics(container: Container) -> dict[str, object]:
    reader = container.telemetry.metric_reader
    assert isinstance(reader, InMemoryMetricReader)
    data = reader.get_metrics_data()
    return {
        metric.name: metric
        for resource_metric in data.resource_metrics
        for scope_metric in resource_metric.scope_metrics
        for metric in scope_metric.metrics
    }


async def test_health_reports_both_components_and_the_pool_series(
    client: httpx.AsyncClient, container: Container
) -> None:
    response = await client.get("/health")
    assert response.status_code == 200
    components = {row["service_name"] for row in response.json()}
    assert components == {"mysql-connection", "http-client"}

    metrics = _metrics(container)
    status = metrics["health.check.status"]
    points = {point.attributes["health.component"] for point in status.data.data_points}
    assert points == {"mysql-connection", "http-client"}

    count = metrics["db.client.connection.count"]
    attributes = {
        (
            point.attributes["db.client.connection.state"],
            point.attributes["db.system.name"],
            point.attributes["db.namespace"],
        )
        for point in count.data.data_points
    }
    assert ("idle", "mysql", container.settings.mysql.database) in attributes
    assert "db.client.connection.limit" in metrics
    assert "db.client.connection.pending_requests" in metrics
