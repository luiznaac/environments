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

## Propagation: manifests, template-check and template-propagate

Each scaffold carries `.salgadinhos/manifest.yml` — the classification the propagation flow
reads. `entries` maps a path (relative to the scaffold root) to one of four classes:

| Class | Meaning | `template-check` (detector) | `template-propagate` (applier) |
|---|---|---|---|
| `owned` | The scaffold owns the file | whole-file compare (JSON structurally, text normalized) | overwrites it with the scaffold's content |
| `pinned` | Surgical edit — only the pinned bits move | JSON dependency watchlist (`pins`) or every `[versions]` alias of a TOML catalog | updates (or adds) exactly those pins |
| `merge` | The project edits it too; only the listed sections merge | named TOML sections compare | replaces only the listed sections |
| `judgment` | Not mechanical — the porting skill handles it | skipped | skipped, reported for the porting skill |

`instantiate.name` is the scaffold's own name token (`template`); creation tooling replaces it
word-boundedly with the project name, and both tools reuse it to normalize scaffold files
against a project. `check.command` (optional) is the lane's fast check and `check.timeout_seconds`
its optional budget (default 15 min, `--check-timeout` overrides); the applier runs it before
opening a PR. The watchlist is deliberately curated — add an entry only when the project family
really should converge on it.

Projects are discovered by globbing for `.salgadinhos/<lane>.yml` sentinels (one per lane:
`source`, `lane`, `applied`, `allow`) — stamped by the creation script / applier, never
hand-written (for a project that predates the tooling, the applier's `--bootstrap` stamps it).
`applied.scaffold_sha` is the immutable pin (which scaffold commit the lane last absorbed);
`applied.revision` is a per-lane counter, for audit — not the from→to unit.
`allow: [{ entry, reason, seen_in? }]` is how a lane records an accepted divergence.

`tools/template-check.mjs` is the read-only detector: every discovered lane is compared against
its scaffold manifest in **two views**, both anchored at the pin (`applied.scaffold_sha`):

- **queue** (the scaffold at the pin vs the scaffold at `HEAD`): what the applier would bring to
  the lane. Reads commits, not the working tree — commit a scaffold change to queue it. Reported
  as DRIFT — blocking unless the entry is `allow`ed.
- **lane** (the lane vs the scaffold at the pin): the edits the lane made on its own since it
  applied the pin. Reported as AHEAD, report-only: port back, or declare the divergence in
  `allow`.

RESTATE flags a global AGENTS.md rule copied verbatim into a project doc. It never applies
anything. `--project <name>` narrows the run; `--code-root <dir>` points at another checkout of
the project family (default: this repo's parent); `--global-agents <file>` overrides the
salgadinhos global. Exit codes: 0 clean, 1 blocking queue drift, 2 config error.

### The applier

`tools/template-propagate.mjs` applies the mechanical classes for every lane whose pin is behind
the target commit — **one PR per repo via `gh`; it never pushes to a default branch directly**:

```bash
node tools/template-propagate.mjs            # dry run: apply + fast check in a scratch clone
node tools/template-propagate.mjs --open-pr  # push the branch and open/update one PR per repo
```

Per repo it clones the origin into a scratch dir (the sibling checkouts are never written to),
branches `salgadinhos/propagate-<target>`, applies every manifest entry that changed between pin
and target, bumps each lane sentinel's `applied` to the target, and runs each lane's
`check.command` (proportional: only lanes that actually applied something). Only a green fast
check reaches `git push` + `gh pr create`; re-running is idempotent — the branch the previous run
pushed is checked out again and the open PR is reported instead of duplicated. Scaffold changes
with no manifest entry are reported but not propagated (they are outside the watchlist by
design); if one is later classified, `template-check` reports it as DRIFT, since its detection
is content-based, not range-based. `--to <sha>` propagates up to a specific scaffold commit,
`--project <name>` narrows the run, and `--skip-check` / `--keep-scratch` / `--check-timeout`
exist for debugging. Exit codes: 0 clean, 1 a repo failed (fast check, push, PR), 2 global
config error.

**Verification, rollback and waiver.** The local fast check is the first filter; the destination
repo's CI on the PR is the real gate, and acceptance is a green check there (the merge itself is
the human gate). **Rollback = close the PR**: the applier never touches the default branch, so
closing discards the whole propagation; if it already merged, revert the commit. A divergence
the family is not actually converging on must not be silently skipped: the lane declares it in
the sentinel as `allow: [{ entry, reason }]` — renúncia, advance without applying. The applier
skips the entry, still advances the pin (so the waiver is durable), and stamps `seen_in` with
the target commit the first time it observes the waiver.

```bash
node tools/template-check.mjs       # whole family (needs the sibling repos checked out)
node tools/template-propagate.mjs   # dry-run every lane behind HEAD
node --test "tools/*.test.mjs"      # the check's, the creation tooling's and the applier's tests
```

### Bootstrapping an existing project

A project that predates the tooling has no sentinel, so discovery cannot see it. `--bootstrap`
stamps the lane lineage through the applier — one PR per repo, only `.salgadinhos/` files
touched, each lane pinned at the target commit (`--to`, default HEAD): nothing queues until the
scaffold moves past the pin.

```bash
node tools/template-propagate.mjs --bootstrap --project <name> \
    --lane <dir>=<source> [--lane <dir>=<source> ...] [--to <sha>] [--open-pr]
```

The stamped sentinel is `revision: 1` with `allow: []`; divergences a lane already carries are
declared later, as detection reports them per lane. Re-runs are idempotent (an already-stamped
lane reports the open PR instead of a duplicate) and bootstrapping never applies scaffold
changes — it only pins the baseline.

### Sweeps

Two sweeps keep the propagation queue visible and drained (`.github/workflows/template-sweep.yml`):

- **Mechanical** — weekly (Mondays 12:17 UTC ≈ 09:00 BRT, after Dependabot's run) plus on every
  push touching a scaffold, tool or this workflow. It checks out the family, runs the detector
  (`template-check`, read-only), collects the advisory (pin-vs-target queue per lane, classified
  by manifest class), and — only when armed — opens the propagation PRs
  (`template-propagate --open-pr`) and posts the advisory.
- **Judgment** — the same run renders the weekly judgment queue (judgment-class entries +
  unclassified changes) and, when armed, opens at most one open `Judgment sweep <week>` issue
  (label `template-sync`) per week. That issue is the work order for the scheduled porting
  session (the `template-sync` skill in `salgadinhos`), which closes it once every item has
  landed as a PR or a declared waiver. The session's schedule lives outside this repo — any
  scheduler (OpenChamber, a cron on the machine holding the family checkout) that can run
  `opencode run` with the `template-sync` prompt will do; the issue is the durable queue.

**Arming.** The cross-repo steps (propagation PRs, advisory comments, the weekly issue) need a
fine-grained PAT in the `TEMPLATE_SWEEP_TOKEN` secret: Contents read/write + Pull requests
read/write on `chameidor`, `portfolio-2`, `label-follower`, `shougong`, plus Issues read/write on
`environments` (the weekly issue) and Contents read on `salgadinhos` (the restatement baseline).
Without the secret the sweep still runs the detector and the collect step, and warns that it is
not armed — it never fails a push on its own findings.

**Advisory.** `tools/sweep-advisory.mjs` renders a sticky, non-blocking comment on every open PR
of a family repo whose lane has a queue (created once, patched in place, matched by the
`<!-- template-sweep advisory -->` marker; never posted when a lane is at its pin, and patched
to a "current" body when a queue drains). The comment lists the mechanical queue with the exact
applier command, flags judgment entries for the porting skill, shows waivers (renúncia) and
unclassified changes, and states that it never gates a merge. The sweep's own propagation PRs
(`salgadinhos/propagate-*`) are skipped — their body already is the queue.

```bash
node tools/sweep-advisory.mjs --collect --code-root .. --output sweep-collect.json
node tools/sweep-advisory.mjs --apply [--issue] --input sweep-collect.json
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
