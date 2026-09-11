# AGENTS.md — React scaffold

A starter skeleton for a project frontend, the same stack as chameidor/portfolio-2/label-follower/
shougong's `frontend/`: **React 19, Vite 6, TypeScript 5.7, Tailwind v4, `@tanstack/react-query` v5,
`react-router-dom` v7**. One vertical slice implemented end-to-end — a health-check dashboard,
calling `GET /health` through the typed client — same idea as the `kotlin`/`python` scaffolds'
worked example. Keep it intact; it's the reference for "how do I wire a new API call through every
layer" (client → query hook → page).

Unlike the four generated frontends today, this scaffold ships with **Biome (lint+format) and
Vitest wired up from the start** — see `template-sync` in salgadinhos for porting that back into
them.

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

`vite.config.ts`'s `base` defaults to `/template/` in a production build (override with
`VITE_BASE` — rename `template` when this scaffold is copied into a new project) and `/` in dev.
The dev server proxies `/api` to `VITE_API_TARGET` (default `http://localhost:8080`) to dodge
CORS — see `react-spa-screen` in salgadinhos for why this exists (the unified dashboard reverse
proxy).

## Testing scope

Only `src/lib/**` has tests (`vitest.config.ts` restricts `include` to it) — pure logic, no
rendering. No component/render tests yet; don't claim UI coverage beyond what this actually
checks.

## Renaming when starting a new project

`template` → `<project>` in: `package.json` (`name`), `index.html` (`<title>`), `vite.config.ts`
(the `/template/` production base path).

## Git workflow

**Do not commit directly to `master`.** Always create a feature branch and open a PR, even for a
small or "obviously safe" change. This applies to all contributors.
