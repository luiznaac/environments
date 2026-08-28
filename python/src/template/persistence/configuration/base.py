"""Declarative base for ORM entities.

No tables yet. Add an entity here and a matching `CREATE TABLE` in
`mysql/init.sql` when the first table-backed feature lands.
"""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
