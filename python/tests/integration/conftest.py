"""Integration harness — the `integrationTest` module equivalent.

Spins up a real MySQL via Testcontainers (needs a Docker daemon) and boots the
actual FastAPI app in-process, driven over ASGI by httpx. External HTTP is
faked per-test with `pytest-httpserver`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from testcontainers.mysql import MySqlContainer

from template.application.container import Container
from template.application.settings import MySqlConfig, Settings


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        item.add_marker("integration")


@pytest.fixture(scope="session")
def mysql() -> Iterator[MySqlContainer]:
    with MySqlContainer("mysql:8.4") as container:
        yield container


@pytest.fixture
def settings(mysql: MySqlContainer) -> Settings:
    return Settings(
        app_env="test",
        mysql=MySqlConfig(
            host=mysql.get_container_host_ip(),
            port=int(mysql.get_exposed_port(3306)),
            user=mysql.username,
            password=mysql.password,
            database=mysql.dbname,
        ),
    )


@pytest.fixture
async def container(settings: Settings) -> AsyncIterator[Container]:
    instance = Container(settings)
    try:
        yield instance
    finally:
        await instance.aclose()


@pytest.fixture
async def client(container: Container) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=container.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http_client:
        yield http_client
