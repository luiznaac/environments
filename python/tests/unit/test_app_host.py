"""The self-health base URL derives from the configured HTTP port unless a host is set."""

from __future__ import annotations

from template.application import container as container_module
from template.application import settings as settings_module


def test_settings_default_to_the_canonical_dev_ports(monkeypatch) -> None:
    monkeypatch.delenv("HTTP_PORT", raising=False)
    monkeypatch.delenv("MYSQL__PORT", raising=False)

    settings = settings_module.Settings(_env_file=None)

    assert settings.http_port == 8080
    assert settings.mysql.port == 3306


def test_app_host_derives_from_the_configured_http_port(monkeypatch) -> None:
    monkeypatch.delenv("GATEWAYS__APP__HOST", raising=False)

    settings = settings_module.Settings(_env_file=None, http_port=9101)

    assert settings.app_host == "http://localhost:9101"


def test_an_explicit_gateway_host_still_wins(monkeypatch) -> None:
    monkeypatch.setenv("GATEWAYS__APP__HOST", "http://api.internal:8080")

    settings = settings_module.Settings(_env_file=None, http_port=9101)

    assert settings.app_host == "http://api.internal:8080"


async def test_container_builds_the_self_health_gateway_from_the_derived_host(monkeypatch) -> None:
    captured: list[str] = []

    class _RecordingGateway:
        def __init__(self, _client: object, base_url: str) -> None:
            captured.append(base_url)

        async def is_healthy(self) -> bool:
            return True

    monkeypatch.delenv("GATEWAYS__APP__HOST", raising=False)
    monkeypatch.setattr(container_module, "AppHealthGateway", _RecordingGateway)
    settings = settings_module.Settings(_env_file=None, http_port=9102)

    instance = container_module.Container(settings)
    try:
        assert captured == ["http://localhost:9102"]
    finally:
        await instance.aclose()
