# environments

A personal collection of ready-to-copy **starter projects** ("scaffolds"), one per tech stack.
This isn't an app you run — it's a set of templates you copy from when starting something new, so
you don't have to set up build tooling, linting, Docker, and a basic project layout from scratch
every time.

There are three scaffolds here, and they're unrelated to each other:

## `kotlin/`

A working Kotlin backend service skeleton: HTTP server (Ktor), dependency injection (Spring),
database access (Exposed/MySQL), Docker setup, linting (Detekt), and a full integration-test
harness — all wired together and demonstrated end-to-end through one working example endpoint (a
health check). Two real projects were bootstrapped from this template:
[chameidor](../chameidor/README.md) and [portfolio-2](../portfolio-2/README.md).

To start a new project from it: copy the `kotlin/` folder, rename the Kotlin package throughout,
rename the project in `settings.gradle.kts`, and you have a running service with a working health
check endpoint, ready to build real features on top of.

## `python/`

The same layered hexagonal architecture as `kotlin/`, in current Python tooling: FastAPI, a
hand-written composition root (no DI framework), SQLAlchemy 2 async / MySQL, httpx, local-file
adapters, Ruff, mypy `--strict`, import-linter for the layer rules, and a Testcontainers
integration harness. Demonstrated end-to-end through a health-check endpoint plus a non-HTTP
feature (`items`, reading local JSON). Managed with `uv`.

```bash
uv sync && uv run poe check                     # install + run lint/types/contracts/tests
uv run poe run                                  # http://localhost:8080/health
```

## `php/`

A minimal PHP 8 project skeleton: Composer for dependencies/autoloading, PHPUnit for tests, and a
Docker Compose setup to run PHP + Apache without installing PHP on your machine. Smaller and
simpler than the Kotlin scaffold — just enough to start writing code.

```bash
docker-compose up                              # starts PHP + Apache on http://localhost:8080
docker-compose run composer install            # install dependencies
docker-compose run php vendor/bin/phpunit       # run tests
```

## Why keep this around

Bootstrapping a new personal project from a battle-tested skeleton is faster and more consistent
than starting from an empty folder each time — and any improvement made here (a better Docker
setup, a stricter lint rule, a nicer test harness) benefits every future project built from it.

See [CLAUDE.md](CLAUDE.md) for details on the internal structure of each scaffold if you're
modifying them.
