# Code map

Module → key files → seam index, plus the app entry points; seeded from the scaffold — re-author it with the `code-map` skill as the project's modules grow.

## Modules

### `usecase` — domain models, ports and services
**Purpose**: the core the other layers implement against; owns the health-check feature (the `HealthChecker` port, the `HealthGateway` outbound port, the `HealthCheckResult` model) plus the shared `commons/` helpers and the `configuration/` beans. Depends on nothing infrastructural — no Ktor, Exposed or Spring web types.
**Files**: `usecase/src/main/kotlin/dev/agner/template/usecase/health/{HealthChecker,HealthGateway,HealthCheckResult}.kt`; `usecase/src/main/kotlin/dev/agner/template/usecase/commons/{DomainException,CommonDefinitions,CommonExtensions}.kt`; `usecase/src/main/kotlin/dev/agner/template/usecase/configuration/{JsonMapper,TimeProviderConfig}.kt` and `configuration/serializers/*`; `usecase/src/testFixtures/kotlin/dev/agner/template/usecase/BasicHelpers.kt`
**Seam(s)**:
- **`HealthChecker`** (`health/HealthChecker.kt`) — the inbound port every checker implements (`suspend getHealthStatus(): HealthCheckResult`); `http-api`'s `HealthHandler` collects the whole `Set<HealthChecker>` Spring builds.
- **`HealthGateway`** (`health/HealthGateway.kt`) — the outbound port (`suspend isHealthy(): Boolean`), implemented by `gateway`'s `AppHealthGateway` and consumed by `HttpClientHealthCheck`.
- **`DomainException`** (`commons/DomainException.kt`) — the error shape crossing to `http-api` (`error` / `userMessage` / `detail`, no HTTP knowledge); subclasses are mapped to statuses at the edge.
- **`configuration/JsonMapper.kt`** — the single Jackson `ObjectMapper` (kotlinx date/period serializers, `SNAKE_CASE`) shared by the HTTP server and the outbound client; in a generated project that also ships a frontend, a DTO change updates its `frontend/src/api/types.ts` in the same commit.
- **`configuration/TimeProviderConfig.kt`** — the `Clock` bean; logic reads time through the `commons` `now(clock)` extensions, never `Clock.system*` directly, so tests can fix time.

### `persistence` — Exposed/MySQL adapters and migrations
**Purpose**: implements the `usecase` ports against MySQL via Exposed, and owns the Flyway migration tooling.
**Files**: `persistence/src/main/kotlin/dev/agner/template/persistence/configuration/DatabaseConfig.kt`; `persistence/src/main/kotlin/dev/agner/template/persistence/health/MySqlConnectionHealthCheck.kt`; `persistence/src/main/kotlin/dev/agner/template/persistence/migration/{MigrationScripts,Migrator}.kt`; `persistence/src/main/resources/db/migration/V1__init.sql`
**Seam(s)**:
- **Adapter seam** — `MySqlConnectionHealthCheck` is the worked example of a `@Component … : HealthChecker`; a repository implements its `usecase` interface the same way.
- **Migration seam** — a new `Table` object must be added to `allTables` in `migration/MigrationScripts.kt`; the `:persistence:generateMigrationScript` task is a placeholder that prints guidance (wire it to Exposed's generator as chameidor and portfolio-2 do), and `Migrator.migrate(...)` applies the SQL under `persistence/src/main/resources/db/migration/`. The integration harness migrates the compose database to head through the same function; `MigrationSchemaTest` diffs `allTables` against a migrated database and fails on drift.
- **Connection seam** — `DatabaseConfig.databaseConnection` is the single Exposed `Database` bean; `Migrator.MysqlEnv` reads the same `MYSQL_*` environment variables for Flyway.

### `gateway` — outbound integrations
**Purpose**: adapters for the external systems the domain calls. The scaffold ships one worked HTTP example.
**Files**: `gateway/src/main/kotlin/dev/agner/template/gateway/configuration/KtorClientConfig.kt`; `gateway/src/main/kotlin/dev/agner/template/gateway/health/{AppHealthGateway,HttpClientHealthCheck}.kt`
**Seam(s)**:
- **Gateway seam** — `AppHealthGateway` implements `usecase`'s `HealthGateway` over the shared Ktor `HttpClient` produced by `KtorClientConfig` (Jackson content negotiation); `HttpClientHealthCheck` implements `HealthChecker` on top of that port.
- A new integration adds the port in `usecase` and its `@Component` adapter here — nothing in `http-api` changes.

### `http-api` — Ktor routes and edge adapters
**Purpose**: the HTTP surface — controllers, content negotiation, CORS and the domain-exception mapping.
**Files**: `http-api/src/main/kotlin/dev/agner/template/httpapi/controller/{ControllerTemplate,HealthController}.kt`; `http-api/src/main/kotlin/dev/agner/template/httpapi/configuration/{KtorConfig,DomainExceptionHandling,DomainExceptionStatusMapper}.kt`; `http-api/src/test/kotlin/dev/agner/template/httpapi/configuration/DomainExceptionHandlingTest.kt`
**Seam(s)**:
- **Route seam** — `ControllerTemplate.routes()` (`typealias RouteDefinition = Routing.() -> Unit`); `KtorConfig` injects `Set<ControllerTemplate>` and mounts each, so adding an endpoint is adding a controller and no manual registration.
- **Error-body seam** — `installDomainExceptionHandler` is the one `StatusPages` handler building the `{"error","message","detail"}` body; `DomainExceptionStatusMapper` chooses the status (defaults to `400`).

### `application` — composition root
**Purpose**: the Spring Boot entry and the runtime configuration that wires the modules together.
**Files**: `application/src/main/kotlin/dev/agner/template/application/Boot.kt`; `application/src/main/resources/application.yaml`, `application-prod.yaml`, `logback.xml`; `application/build.gradle.kts`
**Seam(s)**: `Boot.kt`'s `@ComponentScan("dev.agner.template")` is the wiring seam — every `@Component`/`@Service`/`@Configuration` is picked up, so a new class needs no registration. `application.yaml` is the config seam (`ktor.port` from `KTOR_PORT`, fixed `ktor.wait: true`, `mysql.*` from `MYSQL_*`).

### `integrationTest` — full-stack test harness
**Purpose**: end-to-end specs that boot the real app against a real MySQL and stubbed external gateways.
**Files**: `integrationTest/src/test/kotlin/dev/agner/template/integrationTest/config/{DockerComposeExtension,IntegrationTest,HttpMockService,HttpRequestService,ClockMock,KotestConfig,ResetWiremock,StopKtorServer}.kt`; `integrationTest/src/test/kotlin/dev/agner/template/integrationTest/helpers/IntegrationsHelper.kt`; `integrationTest/src/test/kotlin/dev/agner/template/integrationTest/tests/MigrationSchemaTest.kt`
**Seam(s)**: `DockerComposeExtension` starts the compose MySQL and migrates it to head before any spec; `IntegrationTest` is the annotation that boots the Spring context and stops Ktor afterwards; `HttpMockService` (WireMock) stubs outbound gateways. Copy this module as-is into a new project — it is infrastructure, not example code.

### Repo root — build, config, deploy, CI
**Purpose**: the cross-cutting build configuration, container story and the lanes' entry points.
**Files**: `settings.gradle.kts`, `build.gradle.kts`, `gradle/libs.versions.toml`; `config/detekt/{config,format}.yml`; `docker-compose.yml`, `.env.example`; `.pre-commit-config.yaml`; `.github/workflows/{ci,docker-publish}.yml`; `.run/BootKt.run.xml`
**Seam(s)**: `settings.gradle.kts` is the module graph (`include`), `gradle/libs.versions.toml` the pinned version catalog, the detekt configs the lint baseline (`maxIssues: 0`, `allWarningsAsErrors`). `.pre-commit-config.yaml` runs the branch guard and the Docker-free `unitTest` lane; `docker-compose.yml` is the MySQL dependency for local and integration runs.

## Entry points

- `application/src/main/kotlin/dev/agner/template/application/Boot.kt` — `main()`; Spring Boot component-scans `dev.agner.template` and starts the process.
- `http-api/src/main/kotlin/dev/agner/template/httpapi/configuration/KtorConfig.kt` — the HTTP route table: mounts every `ControllerTemplate`, installs content negotiation, CORS and the domain-exception handler, and blocks the main thread (`ktor.wait: true`).
- `persistence/src/main/kotlin/dev/agner/template/persistence/migration/Migrator.kt` — `main()` (and `migrate(...)`); the Flyway migrator the integration harness calls and the manual/local entry for applying `db/migration/V*.sql`.
- `integrationTest/src/test/kotlin/dev/agner/template/integrationTest/config/DockerComposeExtension.kt` — the integration suite's entry: compose MySQL plus a migrate to head; `IntegrationTest` then boots the app in-process.
