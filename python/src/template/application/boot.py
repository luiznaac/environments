"""Entrypoint — the `Boot.kt` equivalent.

`app` is what uvicorn imports (`template.application.boot:app`).
`main()` is the `python -m template.application.boot` / `poe run` entrypoint.
"""

from __future__ import annotations

from fastapi import FastAPI

from template.application.container import Container
from template.application.settings import Settings
from template.usecase.commons.logging import configure_logging


def build_app() -> FastAPI:
    settings = Settings()
    configure_logging(settings.log_level, json=settings.log_as_json)
    container = Container(settings)
    container.app.state.container = container
    return container.app


app = build_app()


def main() -> None:
    import uvicorn

    settings = Settings()
    uvicorn.run(
        "template.application.boot:app",
        host="0.0.0.0",  # containerised service
        port=settings.http_port,
    )


if __name__ == "__main__":
    main()
