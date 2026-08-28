"""`IController` — the `ControllerTemplate` equivalent.

Every controller returns an `APIRouter`. The composition root collects them and
`server.build_app` mounts each one — so adding an endpoint never means touching
the server wiring, exactly like the Kotlin template.
"""

from __future__ import annotations

from typing import Protocol

from fastapi import APIRouter


class IController(Protocol):
    def router(self) -> APIRouter: ...
