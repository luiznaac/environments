# template

A Kotlin backend service for a project's HTTP API, with MySQL persistence, Docker packaging and an integration-test harness.

## Quickstart

JDK 21 on `PATH`, Docker, and `MYSQL_HOST`, `MYSQL_USER` and `MYSQL_PASSWORD` exported (fixtures in `.env.example`).

```bash
./gradlew compileKotlin compileTestKotlin
docker compose up -d mysql
./gradlew :application:run
```

The API listens on `http://localhost:8080`; MySQL publishes on `localhost:3306`.

<!-- TODO: replace the prerequisites with the product's own and paste the real /health output transcript here. -->

## Checks

```bash
./gradlew compileKotlin compileTestKotlin   # compile (warnings are errors)
./gradlew detekt                            # lint (rewrites formatting in place)
./gradlew unitTest --no-daemon              # the canonical all-checks command (the pre-commit hook)
./gradlew clean build                       # everything, integration suite included (needs Docker)
```

<!-- TODO: name any extra check the product adds. -->

## Docs

- [Code map](docs/code-map.md) — module, seam and entry-point navigation; open it when you need to find where a change lands.
- [Repository conventions](AGENTS.md) — architecture, wiring rules and the feature walkthrough; open it before adding a feature.
- [Domain glossary](CONTEXT.md) — the project's vocabulary; open it when a term is unclear.
- [Coding standards — Kotlin lane](CODING_STANDARDS.md) — the idiom rules the tooling does not enforce; open it before writing code.
- Added on use: `docs/adr/` with the first ADR, `docs/runbooks/` with the first operational story, and `docs/research/` and topical docs as they are written.

<!-- TODO: add the product's topical docs here as they are born. -->
