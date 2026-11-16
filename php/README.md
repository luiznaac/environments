# php

A minimal PHP 8 skeleton for a project's web app, with Composer, PHPUnit and a Docker Compose setup.

## Quickstart

Docker and Docker Compose.

```bash
docker-compose run composer install
docker-compose up
```

The app listens on `http://localhost:8080`.

<!-- TODO: replace the prerequisites with the product's own and paste the real output transcript here. -->

## Checks

```bash
docker-compose run php vendor/bin/phpunit   # the test suite
```

<!-- TODO: add the product's single all-checks script and name it here. -->

## Docs

- [Code map](docs/code-map.md) — module, seam and entry-point navigation; open it when you need to find where a change lands.
- [Repository conventions](AGENTS.md) — layout, commands and the placeholder rule; open it before adding application code.
- [Domain glossary](CONTEXT.md) — the project's vocabulary; open it when a term is unclear.
- Added on use: `docs/adr/` with the first ADR, `docs/runbooks/` with the first operational story, `CODING_STANDARDS.md` when the lane adopts one, and `docs/research/` and topical docs as they are written.

<!-- TODO: add the product's topical docs here as they are born. -->
