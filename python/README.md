# template

A Python backend service for a project's HTTP API, with MySQL persistence, built on FastAPI and SQLAlchemy with a hexagonal layout.

## Quickstart

Python 3.12 and Docker.

```bash
uv sync
docker compose up -d mysql
uv run poe run
```

The API listens on `http://localhost:8080`; MySQL publishes on `localhost:3306`.

<!-- TODO: replace the prerequisites with the product's own and paste the real /health output transcript here. -->

## Checks

```bash
uv run poe lint       # Ruff
uv run poe typecheck  # mypy --strict
uv run poe test       # pytest, integration suite included (needs Docker)
uv run poe check && uv run poe test-integration   # the canonical all-checks command
```

<!-- TODO: name any extra check the product adds. -->

## Docs

- [Code map](docs/code-map.md) — module, seam and entry-point navigation; open it when you need to find where a change lands.
- [Repository conventions](AGENTS.md) — architecture, wiring rules and the feature walkthrough; open it before adding a feature.
- [Domain glossary](CONTEXT.md) — the project's vocabulary; open it when a term is unclear.
- [Coding standards — Python lane](CODING_STANDARDS.md) — the idiom rules the tooling does not enforce; open it before writing code.
- Added on use: `docs/adr/` with the first ADR, `docs/runbooks/` with the first operational story, and `docs/research/` and topical docs as they are written.

<!-- TODO: add the product's topical docs here as they are born. -->
