from __future__ import annotations

import os

import pytest

# The test profile never exports: set it before any test module imports the app.
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("OTEL_SEMCONV_STABILITY_OPT_IN", "http,database")


@pytest.fixture(autouse=True)
def _quiet_logging() -> None:
    from template.usecase.commons.logging import configure_logging

    configure_logging("WARNING", json=False)
