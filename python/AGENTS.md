# AGENTS.md — Python scaffold

Development guidelines for anyone (human, agent, or tool) working in this scaffold. Follow the
patterns below rather than inventing new ones — this is a template that gets copied forward, so
consistency matters more than local cleverness.

## What this is

Not an application. A **starter skeleton** for a Python backend service, deliberately the same
architecture as the sibling [`kotlin/`](../kotlin) scaffold (which itself is the template behind
[chameidor](../../chameidor/AGENTS.md) and [portfolio-2](../../portfolio-2/AGENTS.md)).
One vertical slice is implemented end-to-end — a **health check**. Keep it intact and working;
it's the reference example for "how do I wire a new port/adapter".

## Architecture

Layered hexagonal. **Dependencies only point inward.** Enforced by `import-linter`
(`uv run poe contracts`), which fails the build on violation — the equivalent of the Gradle
module graph in `kotlin/`.

```
application  ->  httpapi     ->  usecase  <-  persistence
                 gateway     ->  usecase
```

One installable package, `src/template/`, with one sub-package per layer:

- **`usecase/`** — the core. Domain models (frozen dataclasses, **no Pydantic**), ports as
  `typing.Protocol` with an `I` prefix (`IHealthChecker`, `IHealthGateway`, `ITransactionTemplate`),
  and services. Depends on **nothing** infrastructural — `import-linter` forbids importing
  `fastapi`, `sqlalchemy`, `httpx`, `pydantic`, `uvicorn` here. `commons/` holds genuinely
  cross-cutting helpers only (`time.IClock`, `logging.get_logger`, `asyncx.map_async`,
  `exceptions`).
- **`persistence/`** — SQLAlchemy 2 async implementations of `usecase` ports against MySQL.
  `configuration/transaction.py` implements `ITransactionTemplate`; repositories call
  `current_session()` to get the session bound to the running transaction. No tables yet —
  `configuration/base.py` has the `DeclarativeBase` to extend.
- **`gateway/`** — outbound HTTP (httpx). One shared `AsyncClient` from
  `configuration/http_client.py`, injected everywhere. `AppHealthGateway` + `HttpClientHealthCheck`
  are the worked example.
- **`httpapi/`** — FastAPI. Each controller is a class with a `router() -> APIRouter` method
  (`IController`, the `ControllerTemplate` analogue). `configuration/server.py` mounts every
  controller the composition root passes it and installs the domain-exception handlers.
  DTOs live in `schema.py` (Pydantic, edge only).
- **`application/`** — the composition root. `settings.py` (pydantic-settings, `APP_ENV` profile),
  `container.py`, `boot.py`.

### Wiring model (important — don't reinvent this)

There is **no DI framework**. `application/container.py` is the single place that knows every
concrete class. It builds the object graph once and exposes `health_checkers: list[IHealthChecker]`
and `controllers: list[IController]` — the hand-written equivalent of Spring collecting
`Set<HealthChecker>` / `Set<ControllerTemplate>`. `boot.py` builds the `Container`, stashes it on
`app.state`, and hands `app` to uvicorn. Tests construct their own `Container` with fakes / a
`FixedClock`.

**Adding a health check or an endpoint means: write the class, then add one line to `container.py`.**
Nothing is auto-discovered — that is the deliberate trade for an explicit, greppable graph.

## How to implement a new feature (walkthrough)

Example: a database-backed `widgets` catalog exposed over HTTP.

1. **Model the domain** in `usecase/widgets/model.py` (frozen dataclass; separate `WidgetCreation`
   from `Widget` if the shapes differ).
2. **Define the port** in `usecase/widgets/gateway.py` (`IWidgetRepository`, a `Protocol`, `async`
   methods).
3. **Write the service** in `usecase/widgets/service.py` — constructor-injected, depends on the
   port. Split a pure calculator from the orchestrator if there's real logic.
4. **Implement the port** in `persistence/widgets/` — a SQLAlchemy entity on `Base`, plus
   `class WidgetRepository:` whose methods run inside `transaction_template.execute(...)` and use
   `current_session()`.
5. **Write the migration** — see "Database migrations" below — rather than adding to
   `mysql/init.sql` (that file no longer exists).
6. **Expose it**: `httpapi/controller/widget_controller.py` with a `router()` method; DTOs in
   `schema.py`.
7. **Wire it** in `application/container.py`: build the repository, pass it to `WidgetService`,
   append the controller to `self.controllers`.
8. **Test** each layer: unit tests in `tests/unit/` (add shared builders to a `tests/fixtures.py`
   if more than one test needs them — don't hand-roll), integration test in `tests/integration/`
   if it crosses the DB/HTTP boundary.

## Database migrations

The schema is versioned SQL under `alembic/versions/` — there is no more `mysql/init.sql`. Two
tools, each doing one half of the job:

- **Alembic's autogenerate** (`uv run poe migrate:generate`, i.e. `alembic revision
  --autogenerate`) *generates* a migration by diffing `Base.metadata` (populated by importing
  every entity module — see `alembic/env.py`) against a live database. Always review the
  generated file: the diff is mechanical and won't know a rename is a rename rather than a
  drop-and-add, and its `Union`/`Optional` style needs no fixing since `alembic/script.py.mako`
  already emits `from __future__ import annotations` and `X | None`.
- **`scripts/migrate.py`** (`uv run poe migrate`) *applies* pending migrations. It runs as a
  plain script — invoked from `deploy/entrypoint.sh` before the app starts, never from the app's
  own startup — and baselines a database that already has tables but no `alembic_version` table
  at `0001_baseline` instead of re-running it, then applies everything since. A failed migration
  aborts the container instead of serving traffic against a stale schema.

`tests/integration/test_migrations.py` is the guard: it migrates a throwaway Testcontainers MySQL
to head and asserts Alembic's own `compare_metadata` against `Base.metadata` is empty. If an
entity changes without a matching migration (or vice versa), this test fails.

Alembic's own files (`alembic.ini`, `alembic/env.py`, `alembic/script.py.mako`,
`alembic/versions/*.py`) live outside `src/template/`, so neither the import-linter contract
nor mypy cover them — Ruff still does (`ruff check .` lints everything).

## Conventions

- **`from __future__ import annotations`** at the top of every module.
- Ports are `Protocol` with an `I` prefix; adapters need not inherit them (structural typing), but
  may for clarity.
- Domain models: `@dataclass(frozen=True, slots=True)`. Pydantic only in `httpapi/schema.py` and
  `application/settings.py`.
- `async` all the way down; blocking IO via `anyio.to_thread`.
- A health check never raises — catch `Exception` and return `is_healthy=False`.
- Time comes from `IClock`, never `datetime.now()` directly in logic.
- Logs via `get_logger(__name__)`; event-style keys (`_log.info("widgets.listed", count=n)`).
- Config via `Settings`; nested env vars use `__` (`MYSQL__HOST`).

## Testing

Kotest (`pytest`), fixtures in `tests/fixtures.py`. Tests live in `tests/unit/` (no Docker) and
`tests/integration/` (spins MySQL via Testcontainers).

```bash
uv run poe test              # unit tests only
uv run poe test:integration  # integration tests
```

## Code style / checks

`uv run poe check` must pass before a change is done. Ruff (lint + format, 120 cols), mypy
`--strict`, import-linter, pytest. CI (`.github/workflows/ci.yml`) runs the same. Unit tests must
not need Docker; integration tests spin up MySQL via Testcontainers and are marked `integration`.

## Configuration

`src/template/application/settings.py` (pydantic-settings, `APP_ENV` profile):

| Key | Source | Notes |
|---|---|---|
| `mysql.host` / `mysql.user` / `mysql.password` | `MYSQL_HOST` / `MYSQL_USER` / `MYSQL_PASSWORD` | required, no defaults |
| `app_env` | `APP_ENV` | defaults to `development` |

Use `${VAR}` (required) or `${VAR:default}` (optional) for env var substitution.

## Build, run, deploy

```bash
uv run poe check      # lint, type check, test
uv run poe test       # unit tests
```

Local dev: `docker compose up -d mysql` (or `uv run poe db`) starts MySQL, then
`uv run poe serve` starts the dev server. Point `MYSQL_HOST=localhost`, `MYSQL_USER=root`,
`MYSQL_PASSWORD=` (dev defaults in `settings.py`).

Git/PR conventions: see `salgadinhos/global/AGENTS.md`.

## Renaming when starting a new project

`template` -> `<project>` in: `src/template/` dir, `pyproject.toml` (`name`, hatch `packages`,
`[tool.importlinter]` `root_package` + `containers`, `[tool.mypy]` `packages`), `Dockerfile`,
`deploy/entrypoint.sh`, `ci.yml`, `poe` tasks, and `MYSQL_DATABASE` in `docker-compose.yml`.
