from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _quiet_logging() -> None:
    from template.usecase.commons.logging import configure_logging

    configure_logging("WARNING", json=False)
