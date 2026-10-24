# Code map

Module → key files → seam index, plus the app entry points; seeded from the scaffold — re-author it with the `code-map` skill as the project's modules grow.

## Modules

### `src/` — application code (`Src\`)
**Purpose**: every application class, autoloaded from the `Src\` namespace.
**Files**: `src/Base.php` (the placeholder example)
**Seam(s)**:
- **Autoload seam** — `composer.json` maps `Src\` → `src/` (PSR-4), so a class `Src\Foo\Bar` is the file `src/Foo/Bar.php`. There is no framework container or router: a new module is a new namespace directory under `src/`.
- Dependencies come from `composer.json`'s `require`; run Composer through the compose `composer` service, not a host install.

### `tests/` — the PHPUnit suite (`Tests\`)
**Purpose**: every test class, autoloaded from the `Tests\` namespace.
**Files**: `tests/BaseTest.php` (the placeholder example)
**Seam(s)**:
- **Test seam** — a test extends `PHPUnit\Framework\TestCase` and is named `*Test.php`; `vendor/bin/phpunit` discovers it. `composer.json` maps `Tests\` → `tests/` (PSR-4, `autoload-dev`).

### Repo root — toolchain and container
**Purpose**: the Composer manifest and the Docker Compose setup that runs PHP without a host install.
**Files**: `composer.json`, `composer.lock`; `docker-compose.yml`; `.pre-commit-config.yaml`; `.gitignore`
**Seam(s)**: `composer.json` is the dependency and autoload source of truth. `docker-compose.yml` defines the `php` service (`php:8-apache`, `8080 → 80`, the scaffold mounted at `/var/www/html`) and the `composer` helper service; there is no dedicated script, so commands go through those services.

## Entry points

- `docker-compose.yml` — starts the `php` service serving the scaffold under Apache at `http://localhost:8080`; there is no front controller or route table yet.
