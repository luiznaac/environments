# Observability — logging & metrics

The normative behavior contract for logs and metrics in this scaffold and in every service generated from it (chameidor, portfolio-2, label-follower). `CODING_STANDARDS.md` carries the language-idiom half; the `code-review` Standards axis reads both, and a diff that emits or configures telemetry is reviewed against this file.

**Scope:** logs + metrics over OpenTelemetry, exported over OTLP. **No traces** — never a `TracerProvider`, span processor or trace exporter. **Non-goals:** alerting, dashboards, SLOs, sampling, retention, and provisioning the observability backend; those consume the pipeline contract fixed here.

Conformance baseline: OpenTelemetry semantic conventions **v1.45.0**. The metric names, units, types and buckets in §5 are that version's, verbatim, and are the contract: an SDK or instrumentation bump that renames a series or changes a unit is a breaking change.

## 1. Pipeline

### Transport

| Item | Contract |
|---|---|
| Wire protocol | OTLP/HTTP + protobuf on `:4318` — not gRPC (`:4317`) |
| Endpoint | `OTEL_EXPORTER_OTLP_ENDPOINT`; prod `http://otel-collector:4318` |
| Security | none on the internal Docker network (no TLS, no auth headers) — TLS + `OTEL_EXPORTER_OTLP_HEADERS` only if the Collector ever leaves the host |
| Collector | one shared, Docker-managed, infra-owned instance per host (`otel-collector:4318` on the shared `proxy` network); it is **not** shipped in this scaffold, this image, or the container's supervisord |
| Logs | dual-write: the same record goes to OTLP **and** to stdout (prod: single-line JSON; dev: human console) |
| Metrics | OTLP only — there is no stdout rendering and no `/metrics` endpoint |

### Resource attributes

Every service sets these six once, by SDK configuration — never per call site. Code defaults exist so a missing env var still yields a valid resource.

| Attribute | Source | Default |
|---|---|---|
| `service.name` | `OTEL_SERVICE_NAME` | the lane's name token (substituted with the project name at creation) |
| `service.namespace` | fixed `luiznaac` | — |
| `service.version` | `SERVICE_VERSION` | build version (`build-info.properties` from `project.version`) |
| `deployment.environment.name` | the active Spring profile, first value; `test` → `test` | `dev`; `production` maps to `prod` |
| `service.instance.id` | UUID generated per process boot | — |
| `host.name` | `HOSTNAME` | the OS hostname |

Current semconv naming: `deployment.environment.name`, not the legacy `deployment.environment`.

### Export behavior

| Knob | Value |
|---|---|
| Log processor | batch: `OTEL_BLRP_SCHEDULE_DELAY=5000`, queue 2048, export timeout 10 s |
| Metric reader | periodic, `OTEL_METRIC_EXPORT_INTERVAL=60000`, **cumulative** temporality |
| Retry | the OTLP exporter's built-in exponential backoff |
| Shutdown | SDK `shutdown()` with a 10 s deadline on SIGTERM (Spring context close → `@PreDestroy`); the deploy sets supervisord `stopwaitsecs=20` |

### Failure mode

- **Prod requires the endpoint.** A missing `OTEL_EXPORTER_OTLP_ENDPOINT` under the prod profile fails at boot — a deploy bug, caught loudly, never a silent no-telemetry service.
- **A configured-but-down Collector degrades.** One WARN, retry forever; it never fails a request or a boot. Metric loss during the outage is accepted.
- **Dev** defaults the endpoint to `http://localhost:4318`. `TELEMETRY_CONSOLE=true` swaps both exporters for console exporters — the fully offline path; it swaps, never adds.
- **The test profile exports nothing** (`OTEL_LOGS_EXPORTER=none`, `OTEL_METRICS_EXPORTER=none`); tests assert through in-memory readers.

### Collector contract

The pipeline the infra follow-on implements, on the `otel/opentelemetry-collector-contrib` distribution:

```
otlp receiver (:4318) → memory_limiter + batch → prometheusremotewrite  (metrics)
                                              → loki                    (logs)
```

- `resource_to_telemetry_conversion: {enabled: true}` — every series carries `service_name`, `service_version`, `deployment_environment_name`, and `target_info` exists.
- `send_native_histograms: false` — apps emit explicit-bucket histograms only.
- **No traces pipeline.** A stray trace export is refused, so an empty `ResourceSpans` transcript proves "no traces".
- The Collector image tag is pinned by the `iac` homelab stack; docs point at it and never say `latest`.

## 2. Log records

### Shape

One record, two renderings: the OTLP log record and the stdout line carry the same fields; only the renderer differs (dev console, prod single-line JSON, no ANSI).

| Field | Value |
|---|---|
| `timestamp` | event time |
| `observed_timestamp` | SDK capture time |
| `severity_number` / `severity_text` | TRACE=1, DEBUG=5, INFO=9, WARN=13, ERROR=17, FATAL=21 |
| `body` | the **event name** (see *Event names* below) — never prose |
| `event.name` | attribute, identical to the body, so events are queryable and routable by name while the body stays legible |
| `attributes` | flat string/number/bool map: OTel semconv keys where one exists (`http.request.method`, `http.route`, `url.path`, `http.response.status_code`, `error.type`, `db.system.name`, …), otherwise `<domain>.<field>` in snake_case |
| `resource` | the six attributes from §1 — set once, never repeated per call site |
| `exception.type` / `.message` / `.stacktrace` | OTel exception semconv; there is no separate `stack` field |
| `trace_id` / `span_id` | always empty — no tracing |

### Event names

`<domain>.<action>` — lowercase, dot-separated, stable, bounded cardinality. The domain is the bounded context or module (`http`, `db`, `health`, `config`, plus app domains); the action is one snake-ish word.

```
route.init   health.checked   http.request.failed   db.migration.applied   config.loaded
```

**Never interpolate into a name.** Identifiers and values are attributes: `order.failed` + `order.id`, never `order.42.failed`. The body answers *what happened* (a constant); attributes answer *which / how much / with what*. A log that needs a sentence is documentation, not a log line.

### Levels

| Level | Meaning |
|---|---|
| ERROR | the operation failed and a human may need to act; an invariant broke; an unhandled exception reached the boundary. One ERROR per failure, at the boundary that handles it — no log-and-rethrow per layer |
| WARN | degraded but handled: retry succeeded, fallback used, Collector unreachable, deprecated path taken. **4xx is WARN at most, never ERROR** |
| INFO | lifecycle and significant business events worth keeping in prod: boot/shutdown, config loaded, route table initialized, migration applied, a state transition someone would ask about during an incident |
| DEBUG | dev-only diagnostics; never enabled in prod (prod root level is INFO; a DEBUG override needs an explicit env change and a restart) |
| FATAL | ERROR plus process exit |

### Required attributes

- Every record: the resource set + `event.name` (stamped from the body when a plain framework log carries none).
- HTTP failure records: `http.request.method`, `http.route` (preferred) or `url.path`, `http.response.status_code`, `error.type`, `request.id` (§3). **No duration on logs** — `http.server.request.duration` is the metric; logs answer *why*, metrics answer *how much / how often*.
- Domain attributes needed to debug the event. Never a secret, token, password, `Authorization`/`Cookie` header, request/response body, SQL with values, or (redaction, §4) an unvetted free-text message.

### What a log is not

- **Not an access log.** Metrics own per-request volume, latency and status. This is the volume decision: logs carry failed/degraded requests and lifecycle/business events only.
- **Not control flow.** No function entry/exit, loop iterations, or "starting X"/"finished X" pairs.
- **Not a debug dump.** No request/response bodies, full SQL, config dumps or secrets.
- **Not duplicated.** Logged once, where the event is handled, not at every layer it crosses.
- **Not the only signal.** If you want to count it, chart it or alert on it, it is a metric (§5).

### Bridge, not replace

- **API:** SLF4J/Logback stays the developer API. Call sites produce attributes, not interpolated strings: `logger().event("orders.failed", "order.id" to id, throwable = e)`. A plain `log.info("…")` keeps working as a body-only, non-event diagnostic.
- **Carrier:** MDC is the single carrier — `event()` scopes `event.name` plus one key per attribute, logs the event name as the message, and clears it synchronously, so a coroutine suspension cannot leak it.
- **Export:** an `OpenTelemetryAppender` on the root logger captures MDC → attributes and the message → body. Framework logs (Ktor, Netty, Spring, Hikari, Exposed) arrive through the same appender for free.
- **Not used:** the OTel Java agent (a tracing path), and any SDK autoconfigure.

### Configuration

Three app-owned keys; everything else is the standard env contract.

| Key | `application.yaml` | Default |
|---|---|---|
| service name | `telemetry.service-name` ← `OTEL_SERVICE_NAME` | the lane's name token |
| endpoint | `telemetry.endpoint` ← `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` (dev); **required in prod** → boot failure |
| console exporters | `telemetry.console` ← `TELEMETRY_CONSOLE` | `false` |

Read from the environment, untouched: `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_TRACES_EXPORTER=none`, `OTEL_BLRP_SCHEDULE_DELAY=5000`, `OTEL_METRIC_EXPORT_INTERVAL=60000`, `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative`, `OTEL_SEMCONV_STABILITY_OPT_IN=http,database`, `OTEL_RESOURCE_ATTRIBUTES` (resource remainder), `SERVICE_VERSION`, `LOG_LEVEL` (default `INFO`; `LOGBACK_LOG_LEVEL` stays a deprecated alias via `${LOG_LEVEL:-${LOGBACK_LOG_LEVEL:-INFO}}`). `.env.example` carries dev fixtures only, never a real value.

## 3. Request correlation

**`X-Request-ID`, UUIDv4.** The edge keeps an inbound value only when it matches `^[A-Za-z0-9._-]{8,128}$`; otherwise it discards it and generates a lowercase canonical UUIDv4. The resolved id is:

- recorded as the attribute **`request.id`** on every log record emitted while that request is handled — and on no metric, ever;
- echoed on **every** response (success and error);
- propagated on **every** outbound HTTP call from the shared gateway client. A callee treats it as a valid inbound id, so a chain shares one id with no per-hop regeneration.

Do **not** parse `traceparent` yet; `X-Request-ID` stays compatible with future tracing (the id becomes a root-span attribute, `traceparent` propagates separately — no contract change when traces arrive).

**Carrier and placement.** A language-native context element (Kotlin `CoroutineContext.Element`, inherited by structured-concurrency children) mirrored into `MDCContext` so MDC survives suspension. **No OTel Baggage** — with no tracing there is no consumer, and its cross-service header is a needless leak/size surface; the explicit header is the only cross-service carrier. A Ktor plugin installed in `KtorConfig` **before routing** binds it, so framework, usecase, gateway and exception-handler logs all see the id.

**Work outside a request.** A scheduled or background task generates its own id at the task boundary and records it as **`job.id`**; a task spawned from a request keeps `request.id` and may add `job.id`.

**Error telemetry — one record per failure, at the boundary that owns the response.** Usecases and gateways never log-and-throw; they throw (or enrich the exception) and the boundary logs once.

- **Every 4xx → one WARN** `http.request.failed`, `error.type` = the stable domain code the transport already exposes (`resource_not_found`, `invalid_argument`, `domain_error`), plus `http.request.method`, `http.route` (preferred) or `url.path`, `http.response.status_code`, `request.id`. **No `exception.*`, no stacktrace** for expected domain errors.
- **Every 5xx → one ERROR**, `error.type` = the exception class name (not the message), plus `exception.type` / `.message` / `.stacktrace` and the request attributes. A 5xx produced by an expected domain error stays stacktrace-free but is still ERROR.
- **Background-task failure → one ERROR** at the task boundary with `job.id` (plus an inherited `request.id`).
- **Success (2xx/3xx) produces no per-request record.**

## 4. Redaction

Enforced at **one pipeline chokepoint**, before export and before the stdout renderer, so the two renderings cannot diverge: a Logback `TurboFilter` here.

- **Never emitted, in either signal:** passwords/passphrases, bearer/refresh/access tokens, API keys, private keys, session ids, `Authorization` / `Cookie` / `Set-Cookie`, credential-bearing connection strings. Key-based, case-insensitive deny-list: the scalar value becomes `[REDACTED]` (the key stays, so presence is visible); a secret-bearing container is dropped.
- **Bodies never emitted:** request/response bodies are excluded by default in both signals; no full SQL with values (parameterized SQL plus statement name only).
- **PII is allowed** — no PII deny-list; direct identifiers may appear when operationally useful. This is a deliberate, accepted risk for these personal projects. Secrets and bodies remain excluded.
- **Defense in depth, in this order:** the call-site rule (never pass a secret into a logging call) is primary; pipeline redaction catches accidents. Redaction is best-effort on attribute values, not free-text — an exception message must not embed a secret. Full URLs are not logged by default (`url.path` only); a query string only when known non-secret.

## 5. Metric catalog

### Naming and translation

Apps emit **dotted OTel names only** — no namespace prefix, no unit suffix, no `_total`, no hand-written underscores in custom names. The Collector's `prometheusremotewrite` exporter owns translation (dots → underscores, UCUM unit → `_seconds`/`_bytes`, `_total` on monotonic counters, `{...}` annotation units → no suffix).

| OTel name | Prometheus series |
|---|---|
| `http.server.request.duration` | `http_server_request_duration_seconds_bucket` |
| `jvm.memory.used` | `jvm_memory_used_bytes` |
| `db.client.connection.count{state="used"}` | `db_client_connection_count{db_client_connection_state="used"}` |
| `orders.created` | `orders_created_total` |
| `health.check.failures` | `health_check_failures_total` |

Deliberate deviation from `<namespace>_<subsystem>_<name>_<unit>`: service identity is a resource attribute, not a name prefix, so a query can aggregate across services; the Collector's `resource_to_telemetry_conversion` turns it into labels. If a dashboard ever needs a prefix it is added once in the Collector (`metricstransform`), never in app code. Custom names use dots as the **only** separator, so the dot→underscore mapping cannot collide with a hand-written name; semconv names are used verbatim, underscores and all.

### HTTP server — RED from semconv instruments, no custom counter

- `http.server.request.duration` — Histogram, unit `s`, explicit buckets `[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]`.
- `http.server.active_requests` — UpDownCounter, `{request}` (in-flight), emitted explicitly in the request plugin.
- **No `http.server.request.count`.** Rate and error rate derive from the histogram's `_count`; a second counter is a duplicate signal.

```promql
# rate
sum by (http_route, http_request_method) (rate(http_server_request_duration_seconds_count[5m]))
# errors
sum by (http_route) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))
# p95
histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[5m])))
```

Attributes kept: `http.request.method`, `http.route`, `http.response.status_code`, `error.type`, `url.scheme`, `network.protocol.version`. Dropped: `user_agent.*` (unbounded), `server.address`/`server.port` (constant per service), `http.request.method_original`, body-size histograms. `http.route` is the framework's route pattern; an unmatched route (404 on an unknown path) leaves it **absent** — never substitute `url.path`, that is the cardinality bomb.

### HTTP client — the dependency-latency signal

`http.client.request.duration` — Histogram, `s`, same buckets, from the shared outbound client. Attributes: `http.request.method`, `server.address`, `server.port`, `http.response.status_code`, `error.type`. No custom outbound counter.

### Instrumentation source

Official library instrumentation — **no agent, no Micrometer OTLP registry, no Prometheus registry, no `/metrics`**.

- Server/client: `io.opentelemetry.instrumentation:opentelemetry-ktor-3.0` (`KtorServerTelemetry`, `KtorClientTelemetry`); `opentelemetry-hikaricp-3.0` only where a Hikari pool exists (never in this lane — Exposed's url connect is pool-less).
- Runtime: `io.opentelemetry.instrumentation:opentelemetry-runtime-telemetry` (the JDK 8/17/21 artifact; `opentelemetry-runtime-telemetry-java21` was never published), experimental metrics off (`emit-experimental-metrics=false`, empty JFR selection). Required subset: `jvm.memory.used`, `jvm.memory.limit`, `jvm.gc.duration`, `jvm.thread.count`, `jvm.cpu.recent_utilization`, `jvm.class.count`; the artifact's other stable `jvm.*` instruments may stay. No hand-written runtime instruments.
- Spans these instrumentations create internally are no-ops without a `TracerProvider`; the metrics are recorded regardless.

### Database

Pool series exist only where a pool exists. This lane has none, so no `db.client.connection.*` and no `db.client.operation.duration` (Exposed has no instrumentation and nothing is hand-rolled). Where a pool exists (Python, HikariCP), the catalog is `db.client.connection.count` (`{connection}`, `db.client.connection.state=idle|used`), `db.client.connection.limit`, `db.client.connection.pending_requests` (`{request}`), with `db.client.connection.pool.name`, `db.system.name`, `db.namespace`; `db.client.operation.duration` is optional (Histogram `s`, buckets `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]`).

### Health

- `health.check.status` — ObservableGauge, unit `1`, attribute `health.component` (`HealthCheckResult.serviceName`: `mysql-connection`, `app-health`), value `1` healthy / `0` unhealthy. It reports the **last observed** result, updated when the health endpoint runs, and never performs I/O itself — a gauge callback must not query the DB every 60 s.
- `health.check.failures` — Counter, `{check}`, attributes `health.component`, `error.type`; one increment per failed check. This captures flaps between exports that a sampled gauge cannot.
- Failures also surface as one WARN `health.check.failed` (`error.type`) and one INFO `health.check.recovered` on state transition only. **No per-check INFO.**

### Business metrics

Name `<domain>.<event>` — lowercase, dot-separated, past tense (`orders.created`, `contracts.synced`); dimensions are attributes, never name interpolation. Counter, unit `{event}` → Prometheus `<domain>_<event>_total`. Counters first; a histogram needs an explicit unit, explicit buckets and a documented rationale. Attributes: bounded dimensions only, ≤ 5 per metric, listed in this file's catalog table when added. One metric per business event — never per function call, never derived from logs. Declared through the OTel `Meter` API at the usecase layer (mirroring SLF4J) with a single custom meter scope: scope name = `service.name`, scope version = app version. The composition root injects the meter, so tests get the API's no-op meter.

### Cardinality rules (hard)

- Never a metric attribute: `request.id`, `job.id`, user/session/order ids, raw URL paths, query strings, full URLs, user-agent strings, client IPs, emails, free-text error messages, timestamps. `request.id` is a **log** attribute only.
- `error.type` on a metric = the HTTP status code string or a bounded domain code (`resource_not_found`, `invalid_argument`, `domain_error`) — never an exception message or an unbounded class set.
- Per-metric attribute count ≤ 5; each attribute's value set bounded and documented.
- Series budget: **≤ 1,000 active series per service** at baseline (HTTP ≈ routes × methods × status codes, runtime ≈ 30, pool ≈ 6, health ≈ 4). A new metric or attribute adding > 100 series needs an explicit note; exceeding the budget is fixed by dropping attributes, never by renaming the metric.
- Enforce the attribute allowlist with SDK metric views (`attribute_keys` in Java views) where the SDK supports it, and document any delta it cannot enforce.

### Export

OTLP/HTTP, **cumulative** temporality, 60 s periodic reader, explicit-bucket histograms only (no exponential histograms, no delta temporality). `TELEMETRY_CONSOLE=true` (dev only) swaps in the console metric exporter. There is no `/metrics` endpoint and no scrape. The test profile sets both exporters to `none`; acceptance tests assert through an in-memory reader.

## 6. Where the code lives

**Purity rule.** The OTel **API** (`opentelemetry-api`, `Meter`) is allowed in `usecase`, mirroring SLF4J. The **SDK, exporters, appenders and framework instrumentation** are forbidden there — the Gradle module graph (`usecase` declares only `opentelemetry-api`) is the enforcement.

| Piece | Module | File |
|---|---|---|
| Metric names/units/buckets and semconv attribute keys, shared by wiring and tests | `usecase` | `commons/MetricCatalog.kt`, `commons/TelemetryAttributes.kt` (new) |
| Request-id carrier (`AbstractCoroutineContextElement` + key) | `usecase` | `commons/RequestContext.kt` (new) |
| Structured log call (`event(name, vararg attrs, throwable?)`, MDC-scoped) | `usecase` | `commons/TelemetryLogging.kt` (new) |
| Health instruments + transition logs | `usecase` | `health/HealthTelemetry.kt` (new) |
| SDK build/shutdown, resource, exporters, views, appender install, JSON providers, redaction filter | `application` | `application/telemetry/{Telemetry,TelemetryConfig,TelemetryResource,TelemetryViews,RedactingMdcFilter,TelemetryJsonProviders}.kt` (new) |
| Logback config (OTel appender + prod JSON / dev console) | `application` resources | `logback-spring.xml` (new; replaces `logback.xml`) |
| Build version resource | `application` build | `build.gradle.kts` `WriteProperties` → `build-info.properties` |
| Request-id plugin, `KtorServerTelemetry`, explicit `http.server.active_requests`, boundary 4xx/5xx records | `http-api` | `configuration/RequestTelemetry.kt` (new); `configuration/DomainExceptionHandling.kt` (edit) |
| `KtorClientTelemetry` + outbound `X-Request-ID` | `gateway` | `configuration/KtorClientConfig.kt` (edit) |
| Health recording call site | `http-api` | `controller/HealthController.kt` (the handler takes `HealthTelemetry` and records each result) |
| — | `persistence` | unchanged: no pool in Exposed; the health adapter only returns `HealthCheckResult` |

A lane with a different module layout (label-follower) keeps this file's contract sections normative and follows its row in §8.

### SDK lifecycle

`TelemetryConfig` (an `@Configuration` in `application`) builds the `OpenTelemetrySdk` from the Spring `Environment`, installs `OpenTelemetryAppender.install(sdk)` in its constructor, exposes `OpenTelemetry`, `Meter` (scope name = `service.name`, scope version = app version) and `Telemetry` beans, and flushes in `@PreDestroy` with `sdk.shutdown().join(10s)`. Spring Boot's shutdown hook closes the context on SIGTERM — that is the flush path; no `main()` change. Log lines Spring emits before the context refresh reach the console appender only (accepted). No `TracerProvider`, no Java agent.

### Log bridge

`logback-spring.xml`: an `OpenTelemetryAppender` on the root logger, a `LoggingEventCompositeJsonEncoder` (logstash-logback-encoder) in the `prod` profile — MDC at root, pinned field names for `timestamp`/`severity_text`/`body`/`exception.*` — and the existing human pattern elsewhere. A `RedactingMdcFilter` (Logback `TurboFilter`) is the single redaction chokepoint, ahead of both appenders. The normalize step stamps `event.name = body` when absent, so plain framework logs still carry the attribute.

### Config keys

See §2 "Configuration" — three app-owned keys (`telemetry.service-name`, `telemetry.endpoint`, `telemetry.console`) plus the standard env contract.

## 7. Verification

Four rungs, proportional. **A green rung is not acceptance on its own.**

| Rung | What | When |
|---|---|---|
| 0 — static | Gradle module graph keeps SDK/exporters/instrumentation out of `usecase`; detekt runs as today | every PR |
| 1 — contract tests | this lane's own suite pins the contract with in-memory readers/exporters (never the Spring singleton) | every PR, in the existing fast gate |
| 2 — pipeline proof | a debug Collector receives both signals; the transcript lands under `## Telemetry evidence` | once per scaffold change and once per ported repo, manual |
| 3 — production acceptance | the same assertions against the host's real Collector | once per service after its first deploy with the new image |

Rung 1 without Rung 2 proves the record is built, not exported. Rung 2 without Rung 1 proves one run, not the contract.

**Gates:** `./gradlew unitTest --no-daemon` (fast, Docker-free, also the pre-commit lane) and `./gradlew clean build` (CI). No new CI job and no service container. The production dependencies are `opentelemetry-api` (the only OTel artifact in `usecase`), `opentelemetry-sdk`, `opentelemetry-exporter-otlp`, `opentelemetry-exporter-logging`, `opentelemetry-logback-appender-1.0`, `opentelemetry-runtime-telemetry`, `opentelemetry-ktor-3.0` (the edge modules) and `logstash-logback-encoder`; each module that asserts adds `testImplementation("io.opentelemetry:opentelemetry-sdk-testing")` (`InMemoryMetricReader`, `InMemoryLogRecordExporter`).

### Clause → test matrix (normative)

One row per contract clause. A clause without a row, or a row whose test is missing, is a Standards-axis finding.

| Clause | Kotlin test | Python test | Gate |
|---|---|---|---|
| six resource attributes present and correct | `TelemetryConfigTest` | `test_telemetry.py` | fast |
| prod without endpoint fails at boot; dev defaults to `localhost:4318`; `TELEMETRY_CONSOLE` swaps exporters | `TelemetryConfigTest` | `test_telemetry.py` | fast |
| test profile exports nothing; a down endpoint boots, serves, logs one WARN | `TelemetryConfigTest` | `test_telemetry.py` | fast |
| no `TracerProvider` / trace exporter is constructed | `TelemetryConfigTest` | `test_telemetry.py` | fast |
| body = `event.name`; `event.name` always present (stamped for plain logs) | `TelemetryLoggingTest` | `test_logging_bridge.py` | fast |
| `event()` sets and clears MDC across a coroutine dispatch | `TelemetryLoggingTest` | — (contextvar variant in `test_logging_bridge.py`) | fast |
| bridge drops `level`/`timestamp` from attributes; uvicorn loggers re-parented | — | `test_logging_bridge.py` | fast |
| severity maps ERROR/WARN/INFO/DEBUG; no `trace_id`/`span_id` | `TelemetryLoggingTest` | `test_logging_bridge.py` | fast |
| secret keys → `[REDACTED]` with the key kept, in **both** renderings; no body attribute; non-secret PII passes | `RedactingMdcFilterTest` | `test_logging_bridge.py` | fast |
| one 4xx → one WARN `http.request.failed`, no `exception.*`, full request attributes | `RequestTelemetryTest` | `test_telemetry_http.py` | fast |
| one 5xx → one ERROR with exception semconv; a success emits no per-request record; no access log | `RequestTelemetryTest` | `test_telemetry_http.py` | fast |
| `request.id` on every request record; valid inbound kept, invalid replaced; echoed on success and error | `RequestTelemetryTest` | `test_telemetry_http.py` | fast |
| outbound `X-Request-ID` propagation | `ClientTelemetryTest` | `test_telemetry_http.py` | fast |
| background work carries `job.id` | port-level (chameidor `TaskService`/`TaskExecutor`; shougong task boundary) | same | Rung 2/3 evidence |
| exact catalog names/units/types; semconv 14 / 10 bucket boundaries; scope name = `service.name` | `RequestTelemetryTest`, `ClientTelemetryTest`, `HealthTelemetryTest` | `test_telemetry_http.py`, `test_health_telemetry.py` | fast |
| no `http.server.request.count`; no `/metrics` endpoint; `request.id` never on a metric | `RequestTelemetryTest` | `test_telemetry_http.py` | fast |
| `http.server.active_requests` returns to 0; unmatched 404 has no `http.route` and creates no new series | `RequestTelemetryTest` | `test_telemetry_http.py` | fast |
| runtime subset present; `system.*` excluded; pool series only where a pool exists | `TelemetryConfigTest` | `test_telemetry.py` | fast |
| `health.check.status` per component + one failure increment; transition logs only | `HealthTelemetryTest` | `test_health_telemetry.py` | fast |
| DB-backed evidence (both health components, `db.client.connection.*`) | — | `tests/integration/test_telemetry_db.py` | `poe test` (Docker; evidence, not the gate) |

### Runbook — `## Verifying telemetry locally`

**Offline (no Collector).** Run with `TELEMETRY_CONSOLE=true` and no endpoint override.

```bash
curl -s localhost:8080/health      # 200; console shows the health gauge and the HTTP duration metric
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/nope   # 404; one WARN http.request.failed
```

Check: six resource attributes on every record; `http.server.request.duration` with `http.route=/health`; `http.server.active_requests` back to 0; **no** per-check INFO log (the gauge moves, the failure transition logs); the 404 record carries `request.id` and no `http.route`; the response echoes the same `X-Request-ID`. This proves the record, not the pipeline.

**With a Collector (pipeline proof).** One `docker run` of the `otel/opentelemetry-collector-contrib` image at the tag the `iac` homelab stack pins — never `latest` — with this config and **only logs + metrics pipelines** (a stray trace export is refused, so the transcript itself proves "no traces"):

```yaml
receivers:
  otlp:
    protocols: {http: {endpoint: 0.0.0.0:4318}}
processors:
  batch: {}
exporters:
  debug: {verbosity: detailed}
service:
  pipelines:
    logs: {receivers: [otlp], processors: [batch], exporters: [debug]}
    metrics: {receivers: [otlp], processors: [batch], exporters: [debug]}
```

```bash
docker run --rm -p 4318:4318 -v "$PWD/otel-debug.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector-contrib:<tag>
```

Then assert, one line of evidence each, in the PR's `## Telemetry evidence`:

1. `GET /health` → `ResourceMetrics` with `http.server.request.duration`, `http.route=/health`, the six resource attributes; `ResourceLogs` from the app.
2. `GET /nope` → one WARN record with `request.id`, no `http.route`, no `exception.*`; the response carries the same `X-Request-ID`.
3. **No `ResourceSpans` anywhere.**
4. No record contains a secret value or a request/response body.

The transcript is a filtered excerpt, not the full dump.

## 8. Converging a backend

### Sequencing

| Step | Work | Why here |
|---|---|---|
| 0 | `environments`: substitute `instantiate.name` in the **lane-side** manifest path (a prerequisite for `owned` paths under `dev/agner/<project>/`) | the `owned` telemetry entries cannot propagate until it lands |
| 1 | scaffold telemetry PR — the reference implementation the ports copy | — |
| 2 | **chameidor** (pilot) | smallest Ktor surface |
| 3 | **portfolio-2** | after chameidor proves the Ktor delta; largest route surface |
| 4 | **label-follower** | Spring MVC outlier; not a pilot |

### chameidor (Ktor + Spring DI, Java 21)

Adopt every scaffold piece — the `usecase` files, `application/telemetry/*`, `logback-spring.xml` (delete the old `logback.xml`), `http-api/.../RequestTelemetry.kt`, gateway telemetry + outbound header, health recording, `WriteProperties` build-info — plus:

- **No StatusPages and no `DomainException` today.** Add a `StatusPages` handler for unexpected exceptions (one ERROR, exception semconv, unchanged error bodies) and drive the 4xx WARN from the **response status** in the request plugin, covering the controllers' direct `respond(401/403/404)` calls without adding a domain-error type.
- Add `ktor-server-test-host` (`testImplementation`) for `RequestTelemetryTest`.
- **Background loop** (`TaskService` polling on `GlobalScope`, `TaskExecutor` swallowing failures into `TaskExecutionResult.Failure`): generate a **`job.id`** per execution at the enqueue `launch`, carry it into `TaskExecutor`, log one structured ERROR there (`tasks.execution.failed`, `job.id`, `task.id`, `error.type`); the enqueue-loop failure becomes a structured WARN/ERROR with a scheduler `job.id`. No request context flows into this work.
- Health components: `mysql-connection`, `app-health`, `task-job`. No pool series. No new business counters in the port.

### portfolio-2 (Ktor + Spring DI, Java 21)

Same scaffold adoption. It already has `StatusPages` + `DomainException`: log the boundary record there (`error.type` from `DomainException.error`) and keep the status-driven path for direct 4xx responses. Large route surface: `http.route` must be the framework's route pattern only, unmatched 404 leaves it absent (verify with `ControllerTestSupport`). `pendingTransfers` 409 stays a stacktrace-free WARN; bodies unchanged. No background jobs, no pool.

### label-follower (Spring MVC, single module, Java 17, Boot 3.5.7)

Same contract, different wiring. Put `config/telemetry/` files (`Telemetry`, `TelemetryConfig` with `@PreDestroy` flush, `TelemetryResource`, `TelemetryViews`, `RedactingMdcFilter`, `TelemetryJsonProviders`, `TelemetryLogging`, `RequestTelemetryFilter`, `BoundaryTelemetry`, `ServletTelemetryConfig`), `logback-spring.xml` keyed on the existing **`production`** profile (not `prod`), and `opentelemetry-spring-webmvc-6.0` + `opentelemetry-okhttp-3.0` + `opentelemetry-runtime-telemetry-java17`.

- **It has no health endpoint and no Actuator.** Add a minimal `GET /health` (component list, MySQL check) and `GET /health/internal` (`{is_healthy:true}`) mirroring the scaffold, with a `HealthChecker` port in `usecases/` and the MySQL adapter in `integrations/database/`, plus the `health.check.*` instruments. Dockerfile gains an API health probe alongside the nginx one. Do not add Actuator.
- **No DB pool** (Exposed url connect; no `DataSource`/Hikari): omit `db.client.connection.*` entirely.
- **OkHttp is the outbound seam**: replace the per-call `OkHttpClient` in `RafaHttp` with one shared `@Bean`, wrap it with the OkHttp telemetry, add an interceptor setting `X-Request-ID` from the request context, and replace `println` with a structured DEBUG log.
- Correlation: one `OncePerRequestFilter` at `HIGHEST_PRECEDENCE` writes MDC `request.id` and echoes the header; a highest-precedence `HandlerExceptionResolver` stores the exception for the filter, which emits the single boundary record after the chain (WARN 4xx, ERROR 5xx with exception semconv). 401/403/404/400/409/422 map to stable `error.type` codes.

### What propagates mechanically, what is judgment

| Artifact | Class |
|---|---|
| `docs/observability.md`, `CODING_STANDARDS.md` additions | **owned** (token-free paths) |
| `usecase` telemetry primitives (`commons/{MetricCatalog,TelemetryAttributes,RequestContext,TelemetryLogging}.kt`, `health/HealthTelemetry.kt`) | **owned** |
| The Kotlin contract suite (`TelemetryConfigTest`, `RedactingMdcFilterTest`, `TelemetryLoggingTest`, `RequestContextTest`, `HealthTelemetryTest`, `RequestTelemetryTest`, `ClientTelemetryTest`) | **owned** — the clause matrix travels with the primitives |
| `docs/observability-waivers.md` (created when a lane needs one) | judgment — lane-owned; a scaffold pass must never overwrite it |
| telemetry source modules, `logback-spring.xml`, `application/telemetry/*` | **owned** for chameidor/portfolio-2; **label-follower declares an `allow`** per entry (no `application`/`usecase`/`http-api` modules, `com.rafaelfo` package) and ports them by judgment |
| existing integration points (`KtorConfig`, `KtorClientConfig`, `DomainExceptionHandling`, `HealthController`) | judgment |
| root/module `build.gradle.kts`, new `[libraries]` aliases in `libs.versions.toml`, `docker-compose.yml`, `deploy/supervisord.conf`, `.env.example`, `AGENTS.md`, `docs/code-map.md` | judgment — the catalog's `pinned` class moves only `[versions]`; module build files are unclassified |

### Deploy and compatibility

- No new process. Each repo sets supervisord `stopwaitsecs=20` on `[program:api]` (today's default 10 is shorter than the 10 s flush). Migrations and nginx unchanged.
- Log consumers today: container stdout via supervisord, no parser. Dev keeps the human console; prod becomes single-line JSON — an accepted break-glass change.
- Volume: no per-request access log anywhere; the 4xx WARN addition is the only increase.
- **Release gate:** prod requires the endpoint (boot fails without it). The `iac` Collector stack and per-service env (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `SERVICE_VERSION`, `SPRING_PROFILES_ACTIVE=prod`; `production` for label-follower) must exist **before** the first ported image deploys. The app PR may merge (CI never runs the prod profile); the deploy that follows is blocked on that env.
- **Rollback:** revert the PR or pin the previous image tag — emission is additive and an absent Collector never fails a request. Emergency export stop with no code change: set `OTEL_LOGS_EXPORTER=none` and `OTEL_METRICS_EXPORTER=none` (keep the endpoint so the prod boot check still passes) and restart. `TELEMETRY_CONSOLE` is dev-only and never a prod switch.

## 9. Waivers

A **contract waiver** is a row in that lane's `docs/observability-waivers.md` — a lane-owned file (judgment-class, never overwritten by propagation), created from the table below when the lane needs its first waiver. It lives beside this file, not inside it, because this file is scaffold-owned and a propagation pass would erase the rows.

| Clause | Why | Compensating control | Tracking | Revisit |
|---|---|---|---|---|
| `<metric / field / wiring item>` | the genuine constraint | what still serves incident debugging | `#<issue>` | an event, not a date |

- It names a **specific** clause (a metric name, a log field, a wiring item), never "telemetry"; it states a compensating control; it links a tracking issue; its revisit trigger is an event ("when a pool is adopted"), not a date.
- **Non-waivable:** secret/body redaction, the resource attribute set, no `TracerProvider`/trace export, no `/metrics` scrape endpoint, one record per failure at the boundary, and the level semantics (4xx never ERROR). Failing one is failing the standard.
- **A conditional catalog clause is not a waiver.** "Pool series only where a pool exists" makes this lane conformant with no pool series; nothing is waived. Same for the optional DB operation histogram.
- **A missing prod Collector is not a waiver — it is "not converged".** The release gate keeps the previous image; the gap is a blocked item with an issue.
- **Two separate records.** The manifest `allow: [{ entry, reason }]` is the *propagation* waiver; a contract waiver is the *behavior* record above. Neither substitutes for the other.

## Acceptance

A scaffold telemetry PR is done when: the contract suite is green under the existing fast gate; `TELEMETRY_CONSOLE=true` shows one log + one metric offline; the `## Telemetry evidence` transcript proves Rung 2 (both signals, six resource attributes, no `ResourceSpans`, redaction); this file, the `CODING_STANDARDS.md` section, the `AGENTS.md` index and the code-map seam exist with the manifest entries classified; no Collector and no new process ship.

A port PR adds the repo's row in §8, its own contract tests green, a Rung-2 transcript from that repo, `stopwaitsecs=20`, access logs off, and a waiver row for anything it genuinely cannot meet.

The standard itself is done when this spec is published and the scaffold passes the above; each backend converges or carries a waiver, tracked per repo.
