# environments

A personal collection of ready-to-copy **starter projects** ("scaffolds"), one per tech stack.
This isn't an app you run — it's a set of templates you copy from when starting something new, so
you don't have to set up build tooling, linting, Docker, and a basic project layout from scratch
every time.

There are four scaffolds here, and they're unrelated to each other:

## Starting a new project

Scaffolds are instantiated by the `new-project` script, never hand-copied:

```bash
node tools/new-project.mjs --stack kotlin --name <project> [--lane backend] [--port <n>]
```

It copies the scaffold (propagation manifest included), applies the renames declared in the
manifest's `instantiate:` section, stamps the lane sentinel, runs the scaffold's fast check and
makes the first commit, then installs the master guard. The creation skill in the `salgadinhos`
repo drives the parameters and the follow-up — remote repo, CI, secrets, domain, first deploy.
See [AGENTS.md](AGENTS.md) → "Creation".

## `kotlin/`

A working Kotlin backend service skeleton: HTTP server (Ktor), dependency injection (Spring),
database access (Exposed/MySQL), Docker setup, linting (Detekt), and a full integration-test
harness — all wired together and demonstrated end-to-end through one working example endpoint (a
health check). Two real projects were bootstrapped from this template:
[chameidor](../chameidor/README.md) and [portfolio-2](../portfolio-2/README.md).

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

## `react/`

The frontend skeleton every project's `frontend/` was generated from: React 19, Vite 6,
TypeScript, Tailwind v4, TanStack Query, React Router, with Biome and Vitest wired in from the
start. One vertical slice — a health-check dashboard calling the API — through the typed client.
Full detail in [react/AGENTS.md](react/AGENTS.md).

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

See [AGENTS.md](AGENTS.md) for details on the internal structure of each scaffold if you're
modifying them.
