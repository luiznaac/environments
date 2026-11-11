"""The module entrypoint serves on the configured HTTP port."""

from __future__ import annotations

from template.application import boot


def _record_uvicorn_run(monkeypatch) -> dict[str, object]:
    recorded: dict[str, object] = {}

    def fake_run(target: str, **kwargs: object) -> None:
        recorded["target"] = target
        recorded.update(kwargs)

    monkeypatch.setattr("uvicorn.run", fake_run)
    return recorded


def test_main_serves_on_the_configured_http_port(monkeypatch) -> None:
    recorded = _record_uvicorn_run(monkeypatch)
    monkeypatch.setenv("HTTP_PORT", "9123")
    monkeypatch.setenv("APP_ENV", "dev")

    boot.main()

    assert recorded["target"] == "template.application.boot:app"
    assert recorded["host"] == "0.0.0.0"
    assert recorded["port"] == 9123
    assert recorded["reload"] is True


def test_main_disables_reload_outside_dev(monkeypatch) -> None:
    recorded = _record_uvicorn_run(monkeypatch)
    monkeypatch.setenv("HTTP_PORT", "9123")
    monkeypatch.setenv("APP_ENV", "prod")

    boot.main()

    assert recorded["reload"] is False
