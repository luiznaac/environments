# AGENTS.md — environments

Development guidelines for anyone (human, agent, or tool) working in this repository.

## What this repository is

**This is not an application.** It's a personal collection of minimal, working scaffolds — one
per tech stack — used as the starting point for new projects. Nothing here runs in production and
nothing depends on it at runtime. Changes here only matter for whatever project gets bootstrapped
from a given scaffold *next*; they never affect an already-generated project retroactively.

There are four independent scaffolds, `kotlin/`, `python/`, `php/`, and `react/`. They do not
share code or tooling with each other — treat them as separate repositories that happen to live in
the same place. `kotlin/` and `python/` deliberately share the *same architecture* (see below), so
a change to the shape of one should usually be mirrored in the other. `react/` is what every
project's `frontend/` was generated from — see [react/AGENTS.md](react/AGENTS.md).

## `kotlin/` — the Ktor + Spring + Exposed + Flyway template

This is the literal template that [chameidor](../chameidor/AGENTS.md) and
[portfolio-2](../portfolio-2/AGENTS.md) were both generated from (package root `dev.agner.template`,
renamed to `dev.agner.<project>` on each new project). It is a **complete, runnable vertical slice**
built around a single feature — a health check — implemented end-to-end through every layer, so a
new project has a working example to copy from rather than empty folders. Includes schema versioning
via Flyway migrations (see `kotlin/AGENTS.md`).

### Architecture (identical shape to chameidor/portfolio-2)

```
application  →  http-api  →  usecase  ←  persistence
                  gateway  →  usecase
```

- `usecase` — `HealthChecker`/`HealthGateway`/`HealthCheckResult` (the port + orchestration),
  `commons/` (shared extensions/definitions), `configuration/` (Jackson `JsonMapper`, kotlinx
  serializers, `TimeProviderConfig` for injecting a `Clock`). Has a `testFixtures` source set
  (`BasicHelpers.kt`) — start any new project's shared test builders here.
- `persistence` — `DatabaseConfig` (Exposed/MySQL wiring) and `MySqlConnectionHealthCheck`, an
  example implementation of a health-check port.
- `gateway` — `KtorClientConfig`, `AppHealthGateway`/`HttpClientHealthCheck`, an example outbound
  HTTP health check.
- `http-api` — `ControllerTemplate` (the routing interface every controller implements),
  `KtorConfig` (embedded Netty server wired via `Set<ControllerTemplate>`, see
  [chameidor/backend/AGENTS.md](../chameidor/backend/AGENTS.md) for the full explanation of this
  wiring — its "Runtime wiring model" section),
  and `HealthController` as the one working example endpoint.
- `application` — `Boot.kt` (Spring `@ComponentScan` + `runApplication`).
- `integrationTest` — a fully working integration-test harness: `DockerComposeExtension`,
  `IntegrationTest` base class, `KotestConfig`, `HttpMockService`/`HttpRequestService` (WireMock +
  request helpers), `ResetWiremock`/`StopKtorServer` (Kotest extensions), `ClockMock`. **Copy this
  whole module as-is into new projects** — it's infrastructure, not example code to be replaced.

### Rules for evolving this template

- **Keep it minimal.** Only add something here if it's genuinely something every new project in
  this family should start with (a working example of a pattern, a piece of test infrastructure).
  Don't add project-specific business logic.
- **Keep the health-check vertical slice intact and working.** It's the reference example for "how
  do I wire a new port/adapter through all four layers" — if you change the wiring pattern
  (`ControllerTemplate`, the Spring+Ktor DI bridge, the Exposed repository shape), update it here
  first and consistently through all four layers, since this is what gets copy-pasted forward.
  See [chameidor/backend/AGENTS.md](../chameidor/backend/AGENTS.md) for the canonical description
  of that wiring and the feature-implementation walkthrough — this template is the origin of that
  pattern, so the two documents should stay in sync.
- **Detekt config here is the baseline.** `config/detekt/{config,format.yml}` and
  `gradle/libs.versions.toml` define the versions/rules new projects inherit. If you bump a
  version or a lint rule here, consider (don't automatically do) also porting it to chameidor and
  portfolio-2 — they may have already diverged intentionally.
- When starting a new project from this template: copy the whole `kotlin/` tree, rename the
  package (`dev.agner.template` → `dev.agner.<project>`), rename the Gradle project in
  `settings.gradle.kts`, and update `docker-compose.yml`'s database name.

## `python/` — the FastAPI hexagonal template

The `kotlin/` architecture ported to modern Python tooling (package root `template`, renamed to
`<project>` on each new project). Same layered shape, same "dependencies point inward" rule,
enforced by `import-linter` instead of the Gradle module graph. One health-check vertical slice
end-to-end.

### Architecture

```
application  →  httpapi     →  usecase  ←  persistence
                gateway     →  usecase
```

One package `src/template/`, one sub-package per layer. Key differences from `kotlin/`:

- **No DI framework.** `application/container.py` is a hand-written composition root that builds
  the object graph once and exposes `health_checkers: list[IHealthChecker]` /
  `controllers: list[IController]` — the explicit equivalent of Spring collecting `Set<…>`. Adding
  a checker or endpoint = write the class + one line in `container.py`.
- Ports are `typing.Protocol` with an `I` prefix (`IHealthChecker`, `ITransactionTemplate`). Domain
  models are frozen dataclasses — **Pydantic only at the edges** (`httpapi/schema.py`,
  `application/settings.py`).
- FastAPI (not Ktor); SQLAlchemy 2 async + `asyncmy` (not Exposed); httpx (not Ktor client);
  `structlog` (not Logback); Ruff (not Detekt); mypy `--strict` (the `allWarningsAsErrors`
  analogue); `pydantic-settings` + `APP_ENV` (not `application.yaml` profiles); `uv` + `poe`
  (not Gradle); `pytest` + Testcontainers + `pytest-httpserver` (not Kotest + WireMock).
- `tests/` replaces the `integrationTest` module: `tests/unit/` (no Docker) and
  `tests/integration/` (spins MySQL, boots the app in-process over ASGI).

### Rules for evolving it

- Same "keep it minimal" rule as `kotlin/` — only patterns every new project should start with.
- Keep the health-check slice intact and working through every layer.
- `python/AGENTS.md` has the full architecture description and the feature walkthrough — keep
  it in sync with the code and, where the shape changes, with `kotlin/`.
- Full check bundle: `uv run poe check`.

## `php/` — the PHP + PHPUnit template

A minimal PHP 8 scaffold: Composer with PSR-4 autoloading (`Src\` → `src/`, `Tests\` → `tests/`),
PHPUnit 9.5 for testing, and a `docker-compose.yml` with a `php:8-apache` service (port
`8080→80`) plus a `composer` helper service for running Composer commands without installing PHP
locally.

- `src/Base.php` / `tests/BaseTest.php` are placeholder examples — replace them, don't extend
  them, when starting a real project.
- Run tests: `docker-compose run composer install` then
  `docker-compose run php vendor/bin/phpunit` (no dedicated script exists yet — if you add one to
  `composer.json`, document it here).
- Unlike the Kotlin template, this scaffold has no real feature example — it's a bare toolchain
  setup. Keep it that way unless you're deliberately adding a second reference example.

## `react/` — the React + Vite frontend template

The stack every project's `frontend/` (chameidor, portfolio-2, label-follower, shougong) was
generated from — React 19, Vite 6, TypeScript, Tailwind v4, TanStack Query, React Router. Full
detail in [react/AGENTS.md](react/AGENTS.md); unlike the other three scaffolds it ships with
Biome + Vitest wired up already — see `template-sync` in the `salgadinhos` repo for porting that
back into the four generated frontends, which don't have it yet.

## Pre-commit

`kotlin/`, `python/`, `react/` and `php/` each carry a `.pre-commit-config.yaml` at their root
with `no-commit-to-branch` (protects `master`). `python/` also wires its stack lint (ruff, mypy,
import-linter) into the same file; keep any new scaffold consistent — every scaffold gets the
branch guard, and whatever lint the stack has is wired into the same file. A new project generated
from a scaffold inherits this guard by copying the scaffold's `.pre-commit-config.yaml`.

## Git

Remote: `git@github.com:luiznaac/environments.git`, single branch `master`. History is small and
linear: initial commit → PHP scaffold → Kotlin scaffold → incremental refinements (JSON
serializers, configurability, health-check fixes) → Python scaffold → React scaffold. Keep commits
scoped to one scaffold at a time where possible, since they are otherwise unrelated.
