# AGENTS.md — environments

Development guidelines for anyone (human, agent, or tool) working in this repository.

## What this repository is

**This is not an application.** It's a personal collection of minimal, working scaffolds — one
per tech stack — used as the starting point for new projects. Nothing here runs in production and
nothing depends on it at runtime. Changes here only matter for whatever project gets bootstrapped
from a given scaffold *next*; they never affect an already-generated project retroactively.

There are four independent scaffolds, `kotlin/`, `python/`, `php/`, and `react/`. They do not
share code or tooling with each other — treat them as separate repositories that happen to live in
the same place. (The root-level `tools/` reads every scaffold's `.salgadinhos/manifest.yml`, but
that's the propagation machinery aimed at the scaffolds, not shared scaffold code.) `kotlin/` and
`python/` deliberately share the *same architecture* (see below), so
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
- **New projects come from `tools/new-project.mjs`, not from hand-copying.** It applies the
  package/Gradle/database renames declared in `.salgadinhos/manifest.yml` (`instantiate:`) — see
  "Creation" under Propagation.

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

## Propagation: manifests + template-check

Each scaffold carries `.salgadinhos/manifest.yml` — the classification the propagation flow
reads. `entries` maps a path (relative to the scaffold root) to one of four classes:

| Class | Meaning | `template-check` behavior |
|---|---|---|
| `owned` | The scaffold owns the file; propagation overwrites it | whole-file compare (JSON structurally, text normalized) |
| `pinned` | Surgical edit — only the pinned bits move | JSON dependency watchlist (`pins`) or every `[versions]` alias of a TOML catalog |
| `merge` | The project edits it too; only the listed sections merge | named TOML sections compare |
| `judgment` | Not mechanical — the porting skill handles it | skipped |

`instantiate.name` is the scaffold's own name token (`template`); creation tooling replaces it
word-boundedly with the project name, and `template-check` reuses it to normalize scaffold files
against a project. The watchlist is deliberately curated — add an entry only when the project
family really should converge on it.

Projects are discovered by globbing for `.salgadinhos/<lane>.yml` sentinels (one per lane:
`source`, `lane`, `applied`, `allow`) — stamped by the creation script / applier, never
hand-written. `allow: [{ entry, reason }]` is how a lane records an accepted divergence.

`tools/template-check.mjs` is the read-only detector: it compares every discovered lane against
its scaffold manifest and reports DRIFT (project behind — port the scaffold's improvement),
AHEAD (project ran ahead — port back or record an `allow`) and RESTATE (a global AGENTS.md rule
copied verbatim into a project doc). It never applies anything. `--project <name>` narrows the
run; `--code-root <dir>` points at another checkout of the project family (default: this repo's
parent); `--global-agents <file>` overrides the salgadinhos global. Exit codes: 0 clean,
1 blocking drift, 2 config error.

```bash
node tools/template-check.mjs     # whole family (needs the sibling repos checked out)
node --test "tools/*.test.mjs"    # the check's and the creation tooling's tests
```

### Creation

`tools/new-project.mjs` instantiates a scaffold into a new project lane:

```bash
node tools/new-project.mjs --stack kotlin --name <project> [--lane backend] [--to <dir>]
    [--db <name>] [--port <n>] [--image <repo/name>] [--base-path </p/>] [--code-root <dir>]
```

It copies the scaffold (manifest included), applies `instantiate:` — the token renamed
word-boundedly in paths and text and package-name-shapedly in JSON values, plus the value
overrides — rewrites the copied manifest to `entries` only, stamps the lane sentinel
(`applied: { revision: 1, scaffold_sha }`), runs the zero-leftover assertion and the scaffold's
`check`, then `git init`s, commits and installs the master guard
(`salgadinhos/adapters/install.mjs --install-repo`) — in that order, so the guard never blocks the
first commit. A red assertion or check aborts before the commit. `--skip-check`/`--skip-guard`
exist for tests; remote repo, CI, secrets, domain and first deploy are the creation skill's job
(`salgadinhos`).

`instantiate:` is the creation contract: `name` (token), `lane` (default lane dir), `check` (fast
check), `keep` (files where the token is not a placeholder) and `values` (conventions — `db`,
`port`, `image`, `basePath` — each declaring the per-file literals a CLI override swaps; a
literal's token becomes the override, or its `style: whole` makes the override the literal's full
replacement, as the image reference needs). `php` declares no `instantiate.name`, so creation
refuses it until a consumer exists.

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
