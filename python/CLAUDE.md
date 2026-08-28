# CLAUDE.md — python scaffold

Implementation guidelines for AI agents working in this scaffold. Follow the patterns below
rather than inventing new ones — this is a template that gets copied forward, so consistency
matters more than local cleverness.

## 1. What this is

Not an application. A **starter skeleton** for a Python backend service, deliberately the same
architecture as the sibling [`kotlin/`](../kotlin) scaffold (which itself is the template behind
[chameidor](../../chameidor/CLAUDE.md) and [portfolio-2](../../portfolio-2/CLAUDE.md)). One
vertical slice is implemented end-to-end — a **health check**. Keep it intact and working; it's
the reference example for "how do I wire a new port/adapter".

## 2. Architecture

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

## 3. How to implement a new feature (walkthrough)

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
5. **Add the table** to `mysql/init.sql`.
6. **Expose it**: `httpapi/controller/widget_controller.py` with a `router()` method; DTOs in
   `schema.py`.
7. **Wire it** in `application/container.py`: build the repository, pass it to `WidgetService`,
   append the controller to `self.controllers`.
8. **Test** each layer: unit tests in `tests/unit/` (add shared builders to a `tests/fixtures.py`
   if more than one test needs them — don't hand-roll), integration test in `tests/integration/`
   if it crosses the DB/HTTP boundary.

## 4. Conventions

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

## 5. Code style / checks

`uv run poe check` must pass before a change is done. Ruff (lint + format, 120 cols), mypy
`--strict`, import-linter, pytest. CI (`.github/workflows/ci.yml`) runs the same. Unit tests must
not need Docker; integration tests spin up MySQL via Testcontainers and are marked `integration`.

## 6. Renaming when starting a new project

`template` -> `<project>` in: `src/template/` dir, `pyproject.toml` (`name`, hatch `packages`,
`[tool.importlinter]` `root_package` + `containers`, `[tool.mypy]` `packages`), `Dockerfile`,
`ci.yml`, `poe` tasks, and `MYSQL_DATABASE` in `docker-compose.yml` + `mysql/init.sql`.
