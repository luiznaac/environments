# template

A React single-page frontend for a project's browser UI, with a typed API client, TanStack Query and a Vite build.

The primary-screen screenshot for this page belongs under `docs/assets/` once the first user-facing slice is merged.

## Quickstart

Node 22 and npm.

```bash
npm ci
npm run dev
```

The dev server listens on `http://localhost:5273`; the API proxy targets `http://localhost:8080`.

<!-- TODO: replace the prerequisites with the product's own. -->

## Checks

```bash
npm run typecheck   # tsc -b --noEmit
npm run lint        # Biome
npm run test        # Vitest
npm run check       # the canonical all-checks command (includes the pre-commit test)
```

<!-- TODO: name any extra check the product adds. -->

## Docs

- [Code map](docs/code-map.md) — module, seam and entry-point navigation; open it when you need to find where a change lands.
- [Repository conventions](AGENTS.md) — layout, commands and the dev-proxy/base-path rules; open it before adding a page or an API call.
- [Domain glossary](CONTEXT.md) — the project's vocabulary; open it when a term is unclear.
- [Coding standards — React lane](CODING_STANDARDS.md) — the idiom rules the tooling does not enforce; open it before writing code.
- Added on use: `docs/adr/` with the first ADR, `docs/runbooks/` with the first operational story, and `docs/research/` and topical docs as they are written.

<!-- TODO: add the product's topical docs here as they are born. -->
