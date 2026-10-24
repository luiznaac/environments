# Code map

Module → key files → seam index, plus the app entry points; seeded from the scaffold — re-author it with the `code-map` skill as the project's modules grow.

## Modules

### `src/api/` — the wire layer
**Purpose**: the typed client, the TanStack Query hooks and the hand-maintained DTO mirror. Every backend call crosses here; a component never calls `fetch`.
**Files**: `src/api/client.ts`; `src/api/queries.ts`; `src/api/types.ts`
**Seam(s)**:
- **Wire contract** — `src/api/types.ts` is the hand-maintained mirror of the backend edge DTOs; a backend DTO change updates it in the same commit. It is synced by hand, not generated, so a shape mismatch is a bug in the mirror.
- **Data seam** — `src/api/client.ts` holds the `request` wrapper, `ApiError` and the `api` object (`api.getHealth()`), with `BASE` from `VITE_API_BASE` (default `/api`); `src/api/queries.ts` holds the `useQuery` hooks (`useHealth`). A new call is a typed function in `client.ts`, a hook in `queries.ts`, then consumption from a page — in that order.

### `src/pages/` — route-level screens
**Purpose**: one component per route, composing the shared chrome and a query hook.
**Files**: `src/pages/Dashboard.tsx`
**Seam(s)**: `Dashboard.tsx` is the worked example of the whole slice (`useHealth` → loading/error/data states → `Panel`); a new screen is a page component added to the route table in `src/App.tsx`.

### `src/components/` — shared chrome
**Purpose**: presentational components that take props/children and fetch nothing.
**Files**: `src/components/Layout.tsx`; `src/components/Panel.tsx`
**Seam(s)**: `Layout` is the shell (`<header>` plus `<Outlet />`) every nested route renders inside; `Panel` is the reference titled container. Adding data fetching or state here is the wrong seam — it belongs in a page or a hook.

### `src/lib/` — pure helpers
**Purpose**: framework-free logic — formatting, dates, calculations — the only Vitest-covered surface.
**Files**: `src/lib/format.ts`; `src/lib/format.test.ts`
**Seam(s)**: no React imports; a helper is a plain exported function and its sibling `*.test.ts` pins it. `vitest.config.ts` restricts `include` to `src/lib/**/*.test.ts`, so a page or component needs the `include` glob (and a jsdom/render-test setup) widened before its test would run.

### Repo root — build, theme, proxy, CI
**Purpose**: the Vite/Biome/TypeScript toolchain, the theme tokens and the dev-server wiring.
**Files**: `vite.config.ts`, `vitest.config.ts`, `biome.json`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`; `src/index.css`; `index.html`; `package.json`; `.env.example`; `.github/workflows/ci.yml`
**Seam(s)**: `vite.config.ts` owns the production `base` path and the dev `/api` proxy (`VITE_API_TARGET`, default `http://localhost:8080`); `src/index.css`'s `@theme` block is the token source (no `tailwind.config.js`); `package.json`'s `check` script (typecheck + Biome + Vitest) is the fast gate, mirrored by CI.

## Entry points

- `index.html` — the Vite document; loads `src/main.tsx`.
- `src/main.tsx` — mounts React with the TanStack `QueryClient` and the browser router (`basename` from `BASE_URL`).
- `src/App.tsx` — the route table: `Layout` as the shell with `Dashboard` as the index route.
- `vite.config.ts` — the dev server (port `5273`) and the `/api` proxy; the production build's base path.
