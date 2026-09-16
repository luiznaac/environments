# AGENTS.md — React scaffold

A starter skeleton for a project frontend, the same stack as chameidor/portfolio-2/label-follower/
shougong's `frontend/`: **React 19, Vite 6, TypeScript 5.7, Tailwind v4, `@tanstack/react-query` v5,
`react-router-dom` v7**. One vertical slice implemented end-to-end — a health-check dashboard,
calling `GET /health` through the typed client — same idea as the `kotlin`/`python` scaffolds'
worked example. Keep it intact; it's the reference for "how do I wire a new API call through every
layer" (client → query hook → page).

Unlike the four generated frontends today, this scaffold ships with **Biome (lint+format) and
Vitest wired up from the start** — drift detection in `environments` reports when that has been
ported back into them.

## Layout

```
src/
  api/          client.ts (typed fetch wrapper), queries.ts (useQuery hooks), types.ts (DTO mirror)
  components/   Layout.tsx, Panel.tsx — shared chrome
  pages/        route-level components (Dashboard.tsx is the worked example)
  lib/          pure helpers, unit-tested in lib/**/*.test.ts — no React imports here
```

New API call: typed function in `api/client.ts` → hook in `api/queries.ts` → consumed from a
`pages/` component. Don't call `fetch` directly from a component.

## Commands

```bash
npm run dev         # vite dev server, port 5273
npm run typecheck    # tsc -b --noEmit
npm run lint         # biome check
npm run lint:fix     # biome check --write
npm run test          # vitest run (src/lib/** only)
npm run check         # typecheck + lint + test — run before considering a change done
npm run build         # tsc -b && vite build
```

## Tailwind v4 — config lives in CSS

`src/index.css` has `@import "tailwindcss";` and an `@theme` block — there is no
`tailwind.config.js`. `vite.config.ts` wires the `@tailwindcss/vite` plugin.

## Dev proxy / deployment base path

`vite.config.ts`'s `base` defaults to `/template/` in a production build and `/` in dev; the
creation tooling rewrites the production base path from the manifest's `instantiate:` section,
and `VITE_BASE` overrides it. The dev server proxies `/api` to `VITE_API_TARGET` (default
`http://localhost:8080`) to dodge CORS — a generated project is served under a sub-path behind
the unified dashboard reverse proxy.

## Testing scope

Only `src/lib/**` has tests (`vitest.config.ts` restricts `include` to it) — pure logic, no
rendering. No component/render tests yet; don't claim UI coverage beyond what this actually
checks.

## Instantiation

New projects are instantiated from this scaffold by the `new-project` script in `environments` —
it applies the `template` renames (package name, base path, title) from the manifest's
`instantiate:` section, stamps the lane sentinel and makes the first commit; the creation skill in
`salgadinhos` drives the parameters and the follow-up. Don't rename by hand.

Git/PR conventions: see `salgadinhos/global/AGENTS.md`.
