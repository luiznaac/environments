# Code map

Module → key files → seam index, plus the app entry points; seeded from the scaffold — re-author it with the `code-map` skill as the project's modules grow.

The layers are one package, `src/template/`, with one sub-package each; `import-linter` enforces that dependencies point inward (`application → httpapi/persistence/gateway → usecase`).

## Modules

### `usecase/` — domain models, ports and services
**Purpose**: the pure core. Owns the health-check ports (`IHealthChecker`, `IHealthGateway`), the `HealthCheckResult` model, the transaction port and the cross-cutting helpers. Imports no framework — `import-linter` forbids `fastapi`, `sqlalchemy`, `httpx`, `uvicorn` and `pydantic` here.
**Files**: `src/template/usecase/health/{checker,gateway}.py`; `src/template/usecase/configuration/transaction.py`; `src/template/usecase/commons/{time,logging,asyncx,exceptions}.py`
**Seam(s)**:
- **`IHealthChecker`** (`health/checker.py`) — the inbound port (`async get_health_status() -> HealthCheckResult`); `HealthController` takes a `Sequence[IHealthChecker]` and every adapter satisfies it structurally.
- **`IHealthGateway`** (`health/gateway.py`) — the outbound port (`async is_healthy() -> bool`), implemented by `gateway`'s `AppHealthGateway` and consumed by `HttpClientHealthCheck`.
- **`ITransactionTemplate`** (`configuration/transaction.py`) — lets a service compose several repository writes atomically without importing SQLAlchemy; implemented in `persistence`.
- **`IClock`** (`commons/time.py`) — the time seam; logic reads time from the injected clock, never `datetime.now()`, so tests can fix it.
- Domain models are frozen, slotted dataclasses (see `CODING_STANDARDS.md`); Pydantic belongs only to `httpapi/schema.py` and `application/settings.py`.

### `persistence/` — SQLAlchemy 2 async adapters
**Purpose**: implements the `usecase` ports against MySQL and owns the transaction template and the declarative base.
**Files**: `src/template/persistence/configuration/{base,database,transaction}.py`; `src/template/persistence/health/mysql_health_check.py`
**Seam(s)**:
- **Adapter seam** — `MySqlConnectionHealthCheck` is the worked example of a class satisfying `IHealthChecker`; a repository implements its `usecase` port the same way.
- **Transaction seam** — `SqlAlchemyTransactionTemplate` implements `ITransactionTemplate`; repositories call `current_session()` to get the session bound to the running transaction, and nested `execute(...)` calls join it.
- **Entity seam** — `configuration/base.py`'s `Base` is the declarative base; the first table-backed feature adds an entity there and its `CREATE TABLE` to `mysql/init.sql`.

### `gateway/` — outbound HTTP
**Purpose**: adapters for external systems, over one shared `httpx.AsyncClient`.
**Files**: `src/template/gateway/configuration/http_client.py`; `src/template/gateway/health/{app_health_gateway,http_client_health_check}.py`
**Seam(s)**:
- **Client seam** — `configuration/http_client.py`'s `build_http_client()` produces the single `AsyncClient` the composition root injects everywhere and closes on shutdown.
- **Gateway seam** — `AppHealthGateway` implements `IHealthGateway` by calling the service's own `/health/internal`; `HttpClientHealthCheck` implements `IHealthChecker` on top of that port. A new integration adds the port in `usecase` and its adapter here.

### `httpapi/` — FastAPI edge
**Purpose**: the HTTP surface — controllers, the edge DTOs and the domain-exception handlers.
**Files**: `src/template/httpapi/configuration/server.py`; `src/template/httpapi/controller/{base,health_controller}.py`; `src/template/httpapi/schema.py`
**Seam(s)**:
- **Route seam** — `IController.router()` returns an `APIRouter`; `server.build_app` mounts every controller the composition root passes in, so adding an endpoint never edits the server wiring.
- **DTO seam** — Pydantic models in `schema.py` are the edge shape; a DTO change also updates `frontend/src/api/types.ts` in a combined repo, in the same commit.
- **Error seam** — `server._install_exception_handlers` maps domain exceptions to the `{"code","detail"}` body; a new domain exception is one handler branch there.

### `application/` — composition root
**Purpose**: the one place that knows every concrete class — builds the object graph, the FastAPI app and the settings.
**Files**: `src/template/application/{settings,container,boot}.py`
**Seam(s)**:
- **Composition seam** — `Container.__init__` builds the engine, HTTP client, checkers and controllers; adding a checker or endpoint is writing the class and adding one line there.
- **Config seam** — `Settings` (pydantic-settings) reads `APP_ENV`, `HTTP_PORT`, `MYSQL__*` and `GATEWAYS__APP__HOST`; nested env vars use `__` as the delimiter.
- **Entry seam** — `boot.py` exposes `app` (the uvicorn import target) and `main()`; tests build their own `Container` with fakes and a `FixedClock`.

### `tests/` — the two test lanes
**Purpose**: unit specs (no Docker) and integration specs that boot the real app against a real MySQL.
**Files**: `tests/conftest.py`; `tests/unit/test_app_health_gateway.py`; `tests/integration/conftest.py`; `tests/integration/test_health.py`
**Seam(s)**: `tests/integration/conftest.py` starts MySQL through Testcontainers and drives the real app in-process over ASGI; unit specs construct fakes directly. Add a shared builder to `tests/fixtures.py` (create it when the first one is needed) rather than copying fixtures per spec. `uv run poe check` is the Docker-free fast gate; the integration lane runs in CI.

### Repo root — packaging, deploy, CI
**Purpose**: the toolchain, configuration and container story around the package.
**Files**: `pyproject.toml`; `Dockerfile`, `docker-compose.yml`, `.env.example`; `mysql/init.sql`; `.pre-commit-config.yaml`; `.github/workflows/{ci,docker-publish}.yml`
**Seam(s)**: `pyproject.toml` carries every tool's config and the `poe` task graph — `poe check` (lint, format-check, typecheck, contracts, unit tests) is the verification ladder's fast rung, and its `import-linter` contracts are the layer gate. `docker-compose.yml` provides the MySQL dependency; `mysql/init.sql` is the schema bootstrap mounted by it. `.pre-commit-config.yaml` runs the branch guard plus the unit lane.

## Entry points

- `src/template/application/boot.py` — the process: `app` is what uvicorn imports, `main()` runs uvicorn on `HTTP_PORT`; both build the `Container`.
- `src/template/httpapi/configuration/server.py` — `build_app` mounts the controllers and installs the exception handlers.
- `tests/integration/conftest.py` — the integration lane's entry: Testcontainers MySQL plus the real app over ASGI.
- `Dockerfile` + `docker-compose.yml` — the container entry: uvicorn serves `template.application.boot:app`, with the MySQL sidecar.
