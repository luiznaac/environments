# DEVELOPMENT.md — Kotlin template

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
5. **Write the migration** — see §4 — rather than editing `mysql/init.sql`.
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

## Code style

Detekt enforces: `config/detekt/{config,format.yml}`, `maxIssues: 0`, `autoCorrect: true`,
`MaximumLineLength: 120`, trailing commas mandatory, no wildcard imports, `allWarningsAsErrors = true`.
Run `./gradlew detekt` before finishing a change.

## Testing

Kotest `StringSpec`, MockK. Unit tests live in each module's `src/test/kotlin`, mirroring the main
package layout. Integration tests in `integrationTest/` boot the full stack via docker-compose.

```bash
./gradlew test                 # unit tests
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
./gradlew test           # unit tests only
./gradlew detekt         # lint (auto-fixes what it can)
```

Local dev: `docker compose up -d mysql` (or root-level `npm run db`) starts MySQL only, then
run via IntelliJ config in `.run/` with `MYSQL_HOST=localhost`, `MYSQL_USER=root`,
`MYSQL_PASSWORD=` (dev defaults in `application.yaml`).

Docker: repo-root `Dockerfile` is a multi-stage build (Gradle → `openjdk:21-slim` runtime)
that ships backend only (no frontend in this template). `docker-compose.yml` at the root adds
MySQL for full-stack runs.

## Git workflow

**Do not commit directly to `master`.** Always create a feature branch and open a PR,
even for a small or "obviously safe" change. This applies to all contributors.

Renaming when starting a new project:

`dev.agner.template` → `dev.agner.<project>` in:
- `build.gradle.kts` (rootProject.name, package declarations)
- `settings.gradle.kts`
- `docker-compose.yml` (database name)
- `application/src/main/resources/application.yaml` (logging package names)
- `.run/` configs
