# Smashy the 6ix

Portfolio site whose homepage is a playable, low-poly 3D driving/destruction game
(Smashy Road-style, Toronto-flavored). The React shell (header, portfolio, resume)
paints instantly; the game is a lazy-loaded chunk.

Authoritative docs: **`CLAUDE.md`** (project conventions, phase checklist, session
protocol) and **`portfolio-smashy-road-tdd.md`** (full technical design doc). Read
those before making changes — this README is just a quick-start stub.

## Requirements

- Node 22 (see `.nvmrc`)
- pnpm 10 (`packageManager` field enables Corepack)

## Commands

```bash
pnpm install       # install dependencies
pnpm dev           # start the Vite dev server
pnpm build         # type-check + production build (dist/)
pnpm preview       # serve the production build locally
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm format        # prettier --write
pnpm test          # vitest run (unit tests)
pnpm smoke         # playwright test (e2e smoke tests)
```

## Status

Currently in **Phase 1 — App shell & deploy pipeline** (scaffold + tooling). See
`CLAUDE.md` for the full phase checklist and `.planning/` for in-progress planning docs.
