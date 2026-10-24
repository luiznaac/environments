# AGENTS.md — PHP scaffold

A minimal PHP 8 skeleton: Composer with PSR-4 autoloading (`Src\` → `src/`, `Tests\` → `tests/`), PHPUnit 9.5, and a `docker-compose.yml` with a `php:8-apache` service (port `8080→80`) plus a `composer` helper service for running Composer commands without installing PHP locally.

## Layout

```
src/      application code, autoloaded as the Src\ namespace
tests/    PHPUnit tests, autoloaded as the Tests\ namespace
```

`src/Base.php` / `tests/BaseTest.php` are placeholder examples — replace them, don't extend them, when starting a real project. Unlike the Kotlin scaffold, this one has no real feature example: it is a bare toolchain setup. Keep it that way unless you deliberately add a second reference example.

## Commands

```bash
docker-compose up                            # PHP + Apache on http://localhost:8080
docker-compose run composer install          # install dependencies
docker-compose run php vendor/bin/phpunit    # run tests
```

No dedicated test script exists yet — if you add one to `composer.json`, document it here.

Git/PR conventions: see `salgadinhos/global/AGENTS.md`.

## Code map

- [`docs/code-map.md`](docs/code-map.md)
