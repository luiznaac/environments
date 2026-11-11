# AGENTS.md — Python scaffold

Development guidelines for anyone (human, agent, or tool) working in this scaffold. Follow the patterns below rather than inventing new ones — consistency matters more than local cleverness.

## What this is

Not an application. A **starter skeleton** for a Python backend service, deliberately the same architecture as the sibling [`kotlin/`](../kotlin) scaffold (which itself is the scaffold behind [chameidor](../../chameidor/AGENTS.md) and [portfolio-2](../../portfolio-2/AGENTS.md)). One vertical slice is implemented end-to-end — a **health check**. Keep it intact and working; it's the reference example for "how do I wire a new port/adapter".

## Code map

- [`docs/code-map.md`](docs/code-map.md)

## Architecture

Layered hexagonal. **Dependencies only point inward.** Enforced by `import-linter` (`uv run poe contracts`), which fails the build on violation — the equivalent of the Gradle module graph in `kotlin/`.

```
application  ->  httpapi     ->  usecase  <-  persistence
                 gateway     ->  usecase
```

One installable package, `src/template/`, with one sub-package per layer:

- **`usecase/`** — the core. Domain models, ports (`IHealthChecker`, `IHealthGateway`, `ITransactionTemplate`), and services — see [`CODING_STANDARDS.md`](CODING_STANDARDS.md) for their shape. Depends on **nothing** infrastructural — `import-linter` forbids importing `fastapi`, `sqlalchemy`, `httpx`, `pydantic`, `uvicorn` here. `commons/` holds genuinely cross-cutting helpers only (`time.IClock`, `logging.get_logger`, `asyncx.map_async`, `exceptions`).
- **`persistence/`** — SQLAlchemy 2 async implementations of `usecase` ports against MySQL. `configuration/transaction.py` implements `ITransactionTemplate`; repositories call `current_session()` to get the session bound to the running transaction. No tables yet — `configuration/base.py` has the `DeclarativeBase` to extend.
- **`gateway/`** — outbound HTTP (httpx). One shared `AsyncClient` from `configuration/http_client.py`, injected everywhere. `AppHealthGateway` + `HttpClientHealthCheck` are the worked example.
- **`httpapi/`** — FastAPI. Each controller is a class with a `router() -> APIRouter` method (`IController`, the `ControllerTemplate` analogue). `configuration/server.py` mounts every controller the composition root passes it and installs the domain-exception handlers. DTOs live in `schema.py`.
- **`application/`** — the composition root. `settings.py` (pydantic-settings, `APP_ENV` profile), `container.py`, `boot.py`.

### Wiring model (important — don't reinvent this)

There is **no DI framework**. `application/container.py` is the single place that knows every concrete class. It builds the object graph once and exposes `health_checkers: list[IHealthChecker]` and `controllers: list[IController]` — the hand-written equivalent of Spring collecting `Set<HealthChecker>` / `Set<ControllerTemplate>`. `boot.py` builds the `Container`, stashes it on `app.state`, and hands `app` to uvicorn. Tests construct their own `Container` with fakes / a `FixedClock`.

**Adding a health check or an endpoint means: write the class, then add one line to `container.py`.** Nothing is auto-discovered — that is the deliberate trade for an explicit, greppable graph.

## How to implement a new feature (walkthrough)

Example: a database-backed `widgets` catalog exposed over HTTP.

1. **Model the domain** in `usecase/widgets/model.py` (separate `WidgetCreation` from `Widget` if the shapes differ).
2. **Define the port** in `usecase/widgets/gateway.py` (`IWidgetRepository`, `async` methods).
3. **Write the service** in `usecase/widgets/service.py` — constructor-injected, depends on the port. Split a pure calculator from the orchestrator if there's real logic.
4. **Implement the port** in `persistence/widgets/` — a SQLAlchemy entity on `Base`, plus `class WidgetRepository:` whose methods run inside `transaction_template.execute(...)` and use `current_session()`.
5. **Write the migration** — see "Database migrations" below — rather than adding to `mysql/init.sql` (that file no longer exists).
6. **Expose it**: `httpapi/controller/widget_controller.py` with a `router()` method; DTOs in `schema.py`.
7. **Wire it** in `application/container.py`: build the repository, pass it to `WidgetService`, append the controller to `self.controllers`.
8. **Test** each layer: unit tests in `tests/unit/` (add shared builders to a `tests/fixtures.py` if more than one test needs them — don't hand-roll), integration test in `tests/integration/` if it crosses the DB/HTTP boundary.

## Database migrations

The schema is versioned SQL under `alembic/versions/` — there is no more `mysql/init.sql`. Two tools, each doing one half of the job:

- **Alembic's autogenerate** (`uv run poe migrate:generate`, i.e. `alembic revision --autogenerate`) *generates* a migration by diffing `Base.metadata` (populated by importing every entity module — see `alembic/env.py`) against a live database. Always review the generated file: the diff is mechanical and won't know a rename is a rename rather than a drop-and-add, and its `Union`/`Optional` style needs no fixing since `alembic/script.py.mako` already emits `from __future__ import annotations` and `X | None`.
- **`scripts/migrate.py`** (`uv run poe migrate`) *applies* pending migrations. It runs as a plain script — invoked from `deploy/entrypoint.sh` before the app starts, never from the app's own startup — and baselines a database that already has tables but no `alembic_version` table at `0001_baseline` instead of re-running it, then applies everything since. A failed migration aborts the container instead of serving traffic against a stale schema.

`tests/integration/test_migrations.py` is the guard: it migrates a throwaway Testcontainers MySQL to head and asserts Alembic's own `compare_metadata` against `Base.metadata` is empty. If an entity changes without a matching migration (or vice versa), this test fails.

Alembic's own files (`alembic.ini`, `alembic/env.py`, `alembic/script.py.mako`, `alembic/versions/*.py`) live outside `src/template/`, so neither the import-linter contract nor mypy cover them — Ruff still does (`ruff check .` lints everything).

## Conventions

- A health check never raises — catch `Exception` and return `is_healthy=False`.
- Config via `Settings`; nested env vars use `__` (`MYSQL__HOST`).

## Testing

Kotest (`pytest`), fixtures in `tests/fixtures.py`. Tests live in `tests/unit/` (no Docker) and `tests/integration/` (spins MySQL via Testcontainers).

```bash
uv run poe test-unit        # unit tests only (no Docker)
uv run poe test-integration # integration tests (needs a Docker daemon)
uv run poe test             # everything
```

## Code style / checks

`uv run poe check` must pass before a change is done. Ruff (lint + format, 120 cols), mypy `--strict`, import-linter, pytest. CI (`.github/workflows/ci.yml`) runs the same. Unit tests must not need Docker; integration tests spin up MySQL via Testcontainers and are marked `integration`.

## Coding standards

- [`CODING_STANDARDS.md`](CODING_STANDARDS.md) — "the language-idiom rules the tooling does not enforce"

## Configuration

`src/template/application/settings.py` (pydantic-settings, `APP_ENV` profile). Every value has a default; a gitignored `.env` may override locally (see `.env.example`). Nested env vars use `__`:

| Key | Env var | Default |
|---|---|---|
| `app_env` | `APP_ENV` | `dev` |
| `http_port` | `HTTP_PORT` | `8080` |
| `log_level` | `LOG_LEVEL` | `INFO` |
| `mysql.host` | `MYSQL__HOST` | `localhost` |
| `mysql.port` | `MYSQL__PORT` | `3306` |
| `mysql.user` | `MYSQL__USER` | `root` |
| `mysql.password` | `MYSQL__PASSWORD` | empty |
| `mysql.database` | `MYSQL__DATABASE` | `template` |
| `gateways.app.host` | `GATEWAYS__APP__HOST` | unset — derived from `HTTP_PORT` |

`Settings.app_host` is what the composition root hands `AppHealthGateway`: an explicit `GATEWAYS__APP__HOST` wins (container/deploy), otherwise the self-health URL follows `HTTP_PORT`.

### Ports (canonical family table)

Only `api` and `mysql` apply to this scaffold; `web` and `frontend-dev` belong to a generated project's root compose and `frontend/`.

| Role | Host env key | Scaffold default | Container-internal |
|---|---|---|---|
| `api` | `HTTP_PORT` | `8080` | `8080` (uvicorn, `Dockerfile` `EXPOSE`) |
| `web` | `WEB_HOST_PORT` (generated root compose only) | `8081` | `8081` |
| `mysql` | `MYSQL__PORT` | `3306` | `3306` |
| `frontend-dev` | `FRONTEND_DEV_PORT` (react / generated `frontend/`) | `5273` | — |

Only the published side of a compose mapping reads `.env`; container-internal ports stay fixed. A generated project replaces these defaults with its assigned block. The DB port recipe is `docker compose port mysql 3306`.

## Build, run, deploy

```bash
uv run poe check      # lint, format, typecheck, contracts, unit tests
uv run poe test       # all tests (integration needs Docker)
```

Local dev: `docker compose up -d mysql` starts MySQL on host `3306` (or `$MYSQL__PORT`), then `uv run poe run` serves the API on `$HTTP_PORT` (default `8080`, reload in `dev`). `MYSQL__HOST`/`MYSQL__USER`/`MYSQL__PASSWORD`/`MYSQL__DATABASE` default in `settings.py`; a gitignored `.env` overrides them.

Git/PR conventions: see `salgadinhos/global/AGENTS.md`.

## Instantiation

New projects are instantiated from this scaffold by the `new-project` script in `environments` — it applies the `template` renames (package dir, pyproject, import-linter, Dockerfile, CI, DB name) from the manifest's `instantiate:` section, stamps the lane sentinel and makes the first commit; the creation skill in `salgadinhos` drives the parameters and the follow-up. Don't rename by hand.
