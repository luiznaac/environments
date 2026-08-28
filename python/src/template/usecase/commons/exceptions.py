"""Domain exception hierarchy. Adapters map these to transport errors (HTTP, etc)."""

from __future__ import annotations


class DomainError(Exception):
    """Base class for every error the core raises deliberately."""


class ResourceNotFoundError(DomainError):
    def __init__(self, resource: str, identifier: str) -> None:
        super().__init__(f"{resource} not found: {identifier}")
        self.resource = resource
        self.identifier = identifier


class InvalidArgumentError(DomainError):
    pass
