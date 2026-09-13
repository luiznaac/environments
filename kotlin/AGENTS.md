# AGENTS.md — Kotlin template

Development guidelines for anyone (human, agent, or tool) working in this Gradle multi-module
template. This is a complete, runnable vertical slice built around a single feature — a health
check — implemented end-to-end through every layer. Keep it intact and working; it's the reference
example for "how do I wire a new port/adapter".

## Architecture

Layered hexagonal. **Dependencies only point inward.** Enforced by the Gradle module graph.

```
application  →  http-api  →  usecase  ←  persistence
                  gateway  →  usecase
```

- **`usecase`** — the core. Domain models, repository interfaces (`IHealthChecker`, `IHealthGateway`,
  `ITransactionTemplate`), and services. Depends on nothing infrastructural. `testFixtures` source
  set holds `BasicHelpers.kt` — start any new project's shared test builders here.
- **`persistence`** — Exposed-backed implementations of the `usecase` repository interfaces.
  `DatabaseConfig` wires MySQL; `MySqlConnectionHealthCheck` is an example implementation.
- **`gateway`** — outbound integrations. `KtorClientConfig`, `AppHealthGateway`/`HttpClientHealthCheck`
  are the worked example.
- **`http-api`** — Ktor routes as `@Component` classes implementing `ControllerTemplate`.
  `KtorConfig` starts the embedded Netty server and wires up all controllers. `HealthController`
  is the one working example endpoint.
- **`application`** — composition root. `Boot.kt` (Spring `@ComponentScan` + `runApplication`).
- **`integrationTest`** — full-stack tests via docker-compose. `DockerComposeExtension`,
  `IntegrationTest` base class, WireMock + Kotest helpers.

## Design principles

- **Interfaces live where they're consumed.** `IHealthChecker` lives in `usecase` because that's
  who needs it; `persistence` depends on `usecase` to implement it, not the other way around.
- **Domain models are immutable.** Use sealed classes for distinct shapes (don't use nullable
  fields or boolean flags).
- **Every repository method is transactional.** Use `transaction { }` to wrap mutations.
- **No framework leakage into `usecase`.** Don't import Ktor, Exposed, or Spring web types there.

## How to implement a new feature (walkthrough)

Example: adding a new HTTP endpoint backed by new persisted state.

1. **Model the domain** in `usecase/src/main/kotlin/dev/agner/template/usecase/<feature>/`.
2. **Define the port** — a repository interface (e.g., `I<Name>Repository`, `async` methods).
3. **Write the service** — constructor-injected, depends on the port.
4. **Implement persistence** in `persistence/` — Exposed `Table`, `Entity`, and `@Component`
   repository.
5. **Write the migration** — see "Database migrations" below — rather than editing `mysql/init.sql`.
6. **Expose it over HTTP** — `http-api/.../controller/` as a `@Component` class implementing
   `ControllerTemplate`. No manual registration needed.
7. **Wire it** in `application/Boot.kt`'s component scanning.
8. **Test** each layer — unit tests in each module's `src/test/kotlin`, integration tests in
   `integrationTest/`.

## Database migrations

The schema is versioned SQL under `persistence/src/main/resources/db/migration/V*.sql` — there is
no more `mysql/init.sql`. Two tools, each doing one half of the job:

- **Exposed's migration module** (`persistence/.../migration/MigrationScripts.kt`) *generates* the
  SQL by diffing `allTables` (every `Table` object, defined in the same file) against a live
  database. It never applies anything.
- **Flyway** (`persistence/.../migration/Migrator.kt`) *applies* those `V*.sql` files. It runs as
  a standalone `main()` — packaged as a second start script, `bin/migrate`, alongside
  `bin/application` (see `application/build.gradle.kts`) — invoked from `deploy/entrypoint.sh`
  before the app starts. Not from the Spring context: `KtorConfig` blocks the main thread for the
  process's entire lifetime (`ktor.wait: true`), so nothing hooked into Spring's lifecycle would
  run before the server starts accepting requests anyway. A failed migration aborts the container
  instead of serving traffic against a stale schema. `baselineOnMigrate` means a database that
  already has the tables gets stamped at V1 rather than having it re-applied.

Changing a table:

1. Edit the `Table` object in `persistence/.../<feature>/` (or add it to `allTables` if it's new).
2. Point `MYSQL_HOST`/`MYSQL_USER`/`MYSQL_PASSWORD` at a database already migrated to head, then
   `./gradlew :persistence:generateMigrationScript -Pname=V2__add_something` — diffs the Exposed
   `Table` objects against it and writes the SQL. Review the output before committing — the diff
   is mechanical and won't know a rename is a rename rather than a drop-and-add.
3. `./gradlew :persistence:migrate` to apply it locally.

`integrationTest/.../tests/MigrationSchemaTest.kt` is the guard: `DockerComposeExtension`
migrates the compose-provided MySQL to head before any spec runs, and this test asserts
`MigrationUtils.statementsRequiredForDatabaseMigration(*allTables)` is empty. If a `Table`
changes without a matching migration (or vice versa), this test fails.

## Domain errors

A domain exception carries a stable `error` code, a user-facing `message` and a developer
`detail`, and knows nothing about HTTP:

```kotlin
abstract class DomainException(
    val error: String,
    val userMessage: String,
    val detail: String,
) : RuntimeException(detail)
```

`http-api` turns it into a response in three pieces:

- **`DomainExceptionStatusMapper`** maps a concrete exception to an `HttpStatusCode`, defaulting
  to `400`. Add a branch per exception that needs another status
  (`is NotFoundException -> HttpStatusCode.NotFound`).
- **`installDomainExceptionHandler`** is the one `StatusPages` handler; it is the only place the
  `{"error", "message", "detail"}` body is built.
- **`KtorConfig`** only calls `installDomainExceptionHandler(mapper)`. Register the generic
  handler once, let the mapper choose the status, and never add a per-exception handler there.

## Code style

Detekt enforces: `config/detekt/{config,format.yml}`, `maxIssues: 0`, `autoCorrect: true`,
`MaximumLineLength: 120`, trailing commas mandatory, no wildcard imports, `allWarningsAsErrors = true`.

### The verification ladder

Before finishing a change, run these in order — cheapest and most local first, so a failure
surfaces where it's cheapest to read:

```bash
./gradlew compileKotlin compileTestKotlin   # 1. compile
./gradlew detekt                            # 2. lint
./gradlew test                              # 3. all tests, unit + integration
./gradlew clean build                       # 4. everything CI runs
```

**The order is load-bearing, not a preference.** `allWarningsAsErrors = true` means an unused
import or a deprecated call fails the *compiler*, not detekt. Run detekt first and it reports
problems the compiler was going to reject anyway — then you fix the same lines twice. Compile
first, and the lint pass only ever shows you genuinely stylistic findings.

`autoCorrect = true` means detekt **rewrites** import order and formatting in place as it runs.
Treat it as a formatter that also reports: after it finishes, re-read the diff before committing,
because a clean "0 issues" exit can still mean your file on disk is not the file you wrote.

Step 3 is not "unit tests" — the root project has no task filter, so `./gradlew test` fans out to
every module's `test`, **including `:integrationTest:test`**, which boots MySQL via
`DockerComposeExtension` and needs Docker up. To run only the fast in-process tests, exclude it:

```bash
./gradlew test -x :integrationTest:test   # unit tests only, no Docker
```

Step 4 (`build`) includes steps 1–3 plus detekt and packaging, so a green `build` implies all of
them. Running 1–3 first is about *time to feedback*, not about coverage.

### Import order

`config/detekt/format.yml` sets `ImportOrdering.layout: '*,java.**,javax.**,kotlin.**,^'`.
Read it as three things, not as "java last, everything else first":

- **`*`** — one alphabetical group holding everything not matched by a later slot. That is where
  the bulk of imports land: `dev.*`, `io.*`, `kotlinx.*`, `org.*` all sort **together**, one block,
  no blank lines between them.
- **`java.**`, **`javax.**`, **`kotlin.**`** — pushed after that group, in that order.
- **`^`** — the **alias-import** marker. It matches `import X as Y`. It is not a catch-all.

So the shape is: alphabetical block of app + third-party imports, then `java.*`, `javax.*`,
`kotlin.*`. Adding `import java.math.BigDecimal` to a file that already has `dev.agner...` and
`org.springframework...` sends it to the bottom:

```kotlin
import dev.agner.portfolio.usecase.allocation.model.AssetClass
import kotlinx.datetime.LocalDate
import org.springframework.stereotype.Service
import java.math.BigDecimal
import java.time.Clock
```

Note `kotlinx.datetime` sitting in the first block, beside `dev` and `org` — not down with
`java`. It is not matched by `kotlin.**` (that slot is the `kotlin.*` stdlib), and this is the
one people reorder wrong by hand most often. Don't hand-fix import order at all: `autoCorrect`
already does it, and it's faster than you are.

## Testing

Kotest `StringSpec` for unit specs and `DescribeSpec` for HTTP/`testApplication` specs, MockK.
Unit tests live in each module's `src/test/kotlin`, mirroring the main package layout.
Integration tests in `integrationTest/` boot the full stack via docker-compose.

```bash
./gradlew test                 # unit + integration tests (integrationTest needs Docker)
./gradlew testCoverageReport   # aggregated JaCoCo report
```

## Configuration

`application/src/main/resources/application.yaml`:

| Key | Source | Notes |
|---|---|---|
| `ktor.port` | `KTOR_PORT` | defaults to `8080` |
| `ktor.wait` | fixed `true` | blocks main thread on the embedded server |
| `mysql.host` / `mysql.user` / `mysql.password` | `MYSQL_HOST` / `MYSQL_USER` / `MYSQL_PASSWORD` | required, no defaults |

Use `${VAR}` (required) or `${VAR:default}` (optional) for env var substitution.

## Build, run, deploy

```bash
./gradlew clean build    # full build, same as CI
./gradlew test           # unit + integration tests
./gradlew detekt         # lint (auto-fixes what it can)
```

### When Gradle can't find a JDK

`allWarningsAsErrors = true` and the Java toolchain pinned to 21 mean a surprising number of
"Cannot compile" errors are really "no JDK". Work down this ladder before touching any code:

**Nível 1 — a JDK 21 is on `PATH`.** Nothing to do; `./gradlew` works.

**Nível 2 — JDK installed but not exported.** This is the common case on Windows, where IntelliJ
downloads a JDK under `~/.jdks` and never puts it on `PATH`. Symptom is exactly:

```
ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
```

Find the one on disk and export it for the shell you're in:

```bash
ls ~/.jdks                                  # e.g. ms-21.0.8
export JAVA_HOME="$HOME/.jdks/ms-21.0.8"
export PATH="$JAVA_HOME/bin:$PATH"
java -version                               # confirm: openjdk version "21.x"
```

**Nível 3 — no JDK 21 anywhere.** Use the toolchain image instead of installing one. The image
ships the Gradle distribution, so call `gradle` directly — the wrapper would download its own
distribution and can time out inside the container:

```bash
docker run --rm -v "$PWD":/w -w /w -v /var/run/docker.sock:/var/run/docker.sock \
    gradle:8-jdk21 gradle --no-daemon clean build
```

On Windows the socket mount is `//var/run/docker.sock:/var/run/docker.sock` (or
`\\.\pipe\docker_engine:\\.\pipe\docker_engine`, depending on the Docker Desktop backend). The
socket is what lets `integrationTest` reach the host daemon via Testcontainers — without it the
suite fails even though Docker is up, so mount it whenever the run will execute tests.

`--no-daemon` matters here: a daemon inside a throwaway container is pure overhead, and it can
outlive the build and hold a lock on the Gradle cache volume.

**Never report a Gradle task as passing when it was skipped for a missing JDK.** A build that
never compiled is not a green build — say which rung of the ladder you got stuck on.

### What `build` actually runs

`./gradlew clean build` is the CI command, and it is the only thing that exercises everything:
compile → detekt → unit tests → the `integrationTest` module → packaging. Two consequences worth
knowing before you trust a local run:

- **`integrationTest` is local-only and never "passes" when it didn't run.** It depends on
  Testcontainers reaching the host daemon (`DockerComposeExtension` boots MySQL), so a suite that
  was skipped or failed for the environment is reported as **"não executado"**, never as green.
  With Docker down, `build` fails in the `integrationTest` module — that is a *local environment*
  failure, not a code failure. Don't chase it in the diff; start Docker.
- **A green `test` is not a green `build`.** `./gradlew test` runs the `integrationTest` module too,
  but it still skips detekt and packaging. It's the right stage to run repeatedly while working,
  and the wrong one to quote as "it passes".

Local dev: `docker compose up -d mysql` (or root-level `npm run db`) starts MySQL only, then
run via IntelliJ config in `.run/` with `MYSQL_HOST=localhost`, `MYSQL_USER=root`,
`MYSQL_PASSWORD=` (dev defaults in `application.yaml`).

Docker: repo-root `Dockerfile` is a multi-stage build (Gradle → `openjdk:21-slim` runtime)
that ships backend only (no frontend in this template). `docker-compose.yml` at the root adds
MySQL for full-stack runs.

Git/PR conventions: see `salgadinhos/global/AGENTS.md`.

Renaming when starting a new project:

`dev.agner.template` → `dev.agner.<project>` in:
- `build.gradle.kts` (rootProject.name, package declarations)
- `settings.gradle.kts`
- `docker-compose.yml` (database name)
- `application/src/main/resources/application.yaml` (logging package names)
- `.run/` configs
