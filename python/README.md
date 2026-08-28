# python

A working Python backend service skeleton — the same layered hexagonal architecture as the
`kotlin/` scaffold, using today's Python tooling: HTTP server (FastAPI), a hand-written
composition root instead of a DI framework, async database access (SQLAlchemy 2 / MySQL),
outbound HTTP (httpx), Docker, linting/formatting (Ruff), types (mypy `--strict`),
architecture enforcement (import-linter), and an integration-test harness (Testcontainers) — all
wired together and demonstrated end-to-end through one working example endpoint (a health check).

## Quick start

```bash
uv sync                       # create .venv + install everything
uv run poe run                # start the service on http://localhost:8080 (needs MySQL — see below)
docker-compose up -d mysql    # local MySQL on :3306
curl localhost:8080/health
```

## Tasks (`uv run poe <task>`)

| task               | what it does                                            |
|--------------------|--------------------------------------------------------|
| `run`              | uvicorn with reload                                     |
| `lint` / `format`  | Ruff                                                    |
| `typecheck`        | mypy `--strict`                                         |
| `contracts`        | import-linter (layer rules)                             |
| `test`             | all tests                                               |
| `test-unit`        | unit tests only (no Docker)                             |
| `test-integration` | integration tests (needs a Docker daemon)              |
| `check`            | everything CI runs                                      |

## Starting a new project from it

Copy the `python/` folder, then rename the `template` package: the directory
`src/template/`, `packages = ["src/template"]` and `name` in `pyproject.toml`, the
`root_package` / container names in `[tool.importlinter]`, the module paths in
`Dockerfile` / `ci.yml` / `poe` tasks, and the `MYSQL_DATABASE` in `docker-compose.yml`.

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules for evolving it.
