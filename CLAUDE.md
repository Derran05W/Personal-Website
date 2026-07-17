# Smashy the 6ix — Portfolio Site + 3D Driving Game

Personal portfolio site whose homepage **is** a playable low-poly 3D driving/destruction
game (Smashy Road-style, Toronto-flavored). React shell (header/portfolio/resume) paints
instantly; the game is a lazy-loaded chunk. Full spec: **`portfolio-smashy-road-tdd.md`**
(the TDD — authoritative for all design intent).

**Stack:** React 19 + TypeScript (strict) + Vite · three.js via @react-three/fiber + drei ·
Rapier physics via @react-three/rapier · zustand · howler.js · leva (dev) · pnpm · Vercel.

---

## How to work (session protocol)

You are a **Fable orchestrator session**. One phase per session — never start a second
phase, even if the first finishes early (spend surplus on verification and polish).

1. **Orient.** Read this file. Find the first unchecked phase in the checklist below.
   If the repo state contradicts the checklist, trust the repo + `git log` and fix the
   checklist before proceeding.
2. **Load context.** Read the phase's part file in `.planning/`, the TDD sections it
   lists, and the previous phase's handoff notes in `.planning/phases/`.
3. **Verify preconditions.** Previous phase's exit criteria hold: `pnpm typecheck && pnpm
   lint && pnpm test && pnpm build` pass, dev server runs, deployed preview is green.
   From Phase 3 on, launch the dev server and screenshot the game (Playwright) to confirm
   the baseline works before touching anything. If preconditions fail, fixing them IS the
   session's first task — log what you found in the handoff notes.
4. **Plan.** Write a detailed implementation plan to `.planning/phases/phase-NN-plan.md`
   (template: `.planning/templates/phase-plan.md`). The part file gives you scope,
   architecture guidance, and acceptance criteria; your plan adds file-level detail,
   subagent task breakdown, and sequencing. Resolve the part file's "decisions for this
   session" explicitly in the plan — you are the advisor; decide and record rationale.
5. **Implement via subagents.** You orchestrate and review; subagents write code.
   - **Opus subagents:** physics, vehicle feel, AI steering, shader/instancing work,
     perf-sensitive systems, gnarly debugging.
   - **Sonnet subagents:** UI/HUD, config modules, tests, asset scripts, docs, routine
     wiring.
   - Parallelize only independent workstreams. You do the integration and review every
     subagent's output against the plan before accepting it.
6. **Verify.** Run every acceptance check in the part file. Quality gates for every phase:
   typecheck, lint, unit tests, production build, Playwright smoke, manual dev-server
   check with screenshots, perf budgets via r3f-perf (once the game exists), no console
   errors.
7. **Exit protocol** (all steps mandatory):
   - [ ] All acceptance criteria met, or shortfalls explicitly documented as blockers.
   - [ ] Update the checklist below: mark the phase, add date + one-line result.
   - [ ] Write handoff notes to `.planning/phases/phase-NN-notes.md` (template in
         `.planning/templates/`): decisions made, deviations from plan, known issues,
         tuned values that changed from TDD defaults, what the next session must know.
   - [ ] Commit with a clean conventional message (no AI attribution of any kind).
         Push so Vercel deploys — every phase ends deployed.
   - [ ] If the phase has a **USER GATE**, mark status `[!]` (awaiting user), state
         clearly in your final message what the user must do, and stop.

**Blocked?** Don't improvise around a locked decision or a missing user input. Write the
blocker into the handoff notes, mark the phase `[!]`, tell the user, stop.

---

## Phase checklist

Status: `[ ]` todo · `[~]` in progress · `[!]` blocked / awaiting user · `[x]` done

### Part 1 — Foundation (`.planning/part-1-foundation.md`)
- [x] **Phase 1 — App shell & deploy pipeline** (M0) — 2026-07-15: shell/routes/CI/a11y shipped, Lighthouse 100×4 on all 3 routes; Vercel repo connection still needs the user's one manual dashboard step (see phase-01-notes.md).
- [x] **Phase 2 — Game bootstrap: canvas, state machine, config, input** — 2026-07-15: full runtime skeleton shipped (canvas/physics/store/machine/events/config/leva/input, 105 tests); smoke+deploy verification pending user push/Vercel; Phase 3 needs a container rebuild for browsers (see phase-02-notes.md).
- [x] **Phase 3 — Driving prototype & fun gate** (M1) — 2026-07-16: raycast vehicle + §5.3 camera + test scene shipped; found & fixed reversed steering (D steered left), sensitivity re-tune + reverse-steer invert + handbrake skid marks folded in, full battery green; USER GATE passed — user signed off on feel 2026-07-16 (see phase-03-notes.md). Push/Vercel connect still user-blocked.

### Part 2 — The City (`.planning/part-2-city.md`)
- [x] **Phase 4 — World generation: tiles, roads, districts, boundaries** (M2a) — 2026-07-16: seeded generator (1.24 ms, 88 new tests, golden-hash pinned), traffic graph (1,932 nodes seed 416), city scene + diegetic boundaries + water sensor + minimap/debug tooling shipped; all gates + live battery green; push still user-blocked (see phase-04-notes.md).
- [x] **Phase 5 — City rendering: instancing, palette, assets, blue hour** (M2b) — 2026-07-16: palette material + emissive plumbing, district-ranged instancing (blackout write path proven visibly), 15 building variants + 8 street props all-procedural (kenney.nl firewalled — fetch pipeline deferred), blue-hour rig w/ texel-quantized shadow follow, 3,754 registry-wired colliders, street-front zoning for the camera; 55 calls / 147.6k tris; 365 tests green; USER look check posted (non-blocking; see phase-05-notes.md).
- [x] **Phase 6 — Destruction physics: props go flying** (M2c) — 2026-07-16: contact spine (onImpact over typed records), fixed→dynamic swap + 60-slot pool (never-fail eviction, 20 s despawn), TDD damage resolver (transformer death + events + shake), 634 parked cars, fall-through root-caused (double-failure; defense-in-depth added, feel untouched); M2 battery: 17.8k impacts, flat heap, 0 errors; 424 tests (see phase-06-notes.md).

### Part 3 — Core Loop (`.planning/part-3-core-loop.md`)
- [x] **Phase 7 — Civilian traffic** (M3a) — 2026-07-16: 24-car kinematic graph-followers w/ block-ray hold + anti-deadlock creep, ram conversion (explicit velocity inheritance, civHit once), wreck detection (flip/hp → civWrecked once, linger, recycle); 5-min combined soak: pool pinned 24/24, 22.3k impacts, flat heap, 0 errors; 450 tests (see phase-07-notes.md).
- [x] **Phase 8 — Heat, score, HUD** (M3b) — 2026-07-16: monotonic heat w/ ordered tier crossings, score + risk bonus (fixed-step accrual), header-matched HUD (stars/score/HP/hints, 10 Hz throttle), versioned persistence; fixed ground-spike insta-death found by first HP render; live audit green, 503 tests; damage tuning flagged for P9 (see phase-08-notes.md).
- [x] **Phase 9 — Police ★1, WRECKED/BUSTED, full run loop** (M4) — 2026-07-16: spawn director (extensible composition, staggered 10 Hz), police reuse the signed-off vehicle controller (lead/ram/avoid/stuck-recover, strobing lightbar), WRECKED/water/BUSTED states, damage root-cause retune + vehicle-ram proxy, same-seed retry via runId remount, game-over screen + synthesized sirens; M4 battery: swarm→death→pristine retry ×10, 0 errors; organic-BUSTED reachability flagged for Part 4 tuning; 624 tests (see phase-09-notes.md).

### Part 4 — Escalation (`.planning/part-4-escalation.md`)
- [x] **Phase 10 — ★2 Armored + ★3 SWAT flanking** (M5a) — 2026-07-16: squad coordinator (flank slots, hysteresis, drivable clamp), armored (real 1920 kg + shove) + blacked-out SWAT (ram ×1.5) on the P9 chassis, ★2/★3 composition w/ minPreferred, press-in fix (cops crowd-and-hold); ★3 battery: both SWAT flanking live, 3-min chaos soak flat-heap 0-error; 688 tests; organic-BUSTED + unit-prop-launch debts → P11 (see phase-10-notes.md).
- [x] **Phase 11 — ★4 Gun trucks: standoff + turret fire** (M5b) — 2026-07-16: orbit/standoff steering w/ ram-switch, world-damped turret + LOS gate, sim-time hitscan bursts (measured 3×100 ms / 2.5 s cd, 3 dmg, shove-never-flips), bullets launch props via new swapFromExternalHit (P12 explosion entry), tracer FX + damage vignette, ★4 composition w/ maxOfKind ≤2; chaos soak flat-heap 0-error; 742 tests; no-navmesh navigation theme consolidated for P12/P16 (see phase-11-notes.md).
- [ ] **Phase 12 — ★5 Tanks, shells, explosions + chaos bench** (M5c)

### Part 5 — Signature & Juice (`.planning/part-5-signature-and-juice.md`)
- [ ] **Phase 13 — Power grid & district blackouts** (M6)
- [ ] **Phase 14 — Helicopters & searchlight** (M7a)
- [ ] **Phase 15 — Audio pass** (M7b)
- [ ] **Phase 16 — FX & juice pass** (M7c)

### Part 6 — Ship It (`.planning/part-6-ship.md`)
- [ ] **Phase 17 — Garage, six cars, unlocks, persistence** (M8a)
- [ ] **Phase 18 — Mobile controls & quality tiers** (M8b) — USER GATE: real-phone test
- [ ] **Phase 19 — Toronto landmark layer & lighting polish** (M9)
- [ ] **Phase 20 — Content, SEO, credits, launch** (M10) — USER GATE: real content + launch approval

---

## Locked decisions — do not relitigate

Adopted from TDD §16 recommendations plus TDD non-goals. Changing any of these requires
the user, not you.

| Decision | Value |
|---|---|
| Time of day | Permanent early-evening **blue hour** (blackouts must read) |
| Heat | **Monotonic, never decays**; wanted tier is a pure function of heat |
| BUSTED mechanic | **In** (speed < 1 m/s for 3 s with ≥ 3 pursuers within 8 m) |
| Unlocks | **Lifetime-score milestones**, generous thresholds, `localStorage` |
| Mobile v1 | **Playable-basic** (◀ ▶ + brake, auto-throttle, low tier) |
| Map | **Finite** 64×64 tiles (640 m²), seeded generation, lakefront south edge |
| Pedestrians | **None** (vehicles + props only) |
| Backend | **None** — static site, `localStorage` only |
| Buildings | Indestructible fixed colliders in v1 |
| Assets | CC0-first (Kenney/Quaternius/Poly Pizza) + procedural fallback; player cars & military tier procedural |
| Physics | Rapier raycast vehicle controller behind `IVehicleModel`; arcade-box fallback if fun gate fails |

**Open (user input needed):** header branding/name & game title wordmark (placeholder
"Derran" until told otherwise); resume PDF; portfolio project content; LinkedIn URL;
custom domain. GitHub is `Derran05W`. Needed at Phase 1 (placeholders OK) and for real
at Phase 20.

---

## Core facts every session needs

### Directory layout (TDD §6)
```
src/
  app/            # shell: header, routes, portfolio, resume — NEVER imports from game/
  game/
    index.tsx     # lazy entry, <Canvas>, providers
    state/        # zustand store: machine, heat, score, settings + typed event emitter
    config/       # ALL tunables (TDD Appendix A) — single source of truth, no magic numbers elsewhere
    world/        # seeded generator, districts, traffic graph, instancing, entity registry
    vehicles/     # IVehicleModel, player controller, car definitions
    ai/           # steering, spawn director, unit definitions
    combat/       # damage resolver, projectiles, explosions
    powergrid/    # districts, transformer logic, emitter registry, light pool
    fx/           # particles, decals, camera shake
    audio/        # howler manager, positional sirens
    hud/          # React HUD components reading the store
```

### State machine
`BOOT → LOADING → GARAGE → PLAYING ⇄ PAUSED → GAMEOVER → (GARAGE | PLAYING)`
Transitions validated; keyboard input attaches only in `PLAYING`; pause on Esc/P,
tab-hidden, window blur, route change away from Home.

### Frame order (TDD §6)
input → AI tick (10 Hz, cached) → fixed-step physics (60 Hz, interpolated render) →
drain contact events → damage/heat resolvers → FX/audio → render.
In practice: AI forces in `useBeforePhysicsStep`, event drain + resolvers in
`useAfterPhysicsStep`, camera/FX in late `useFrame`.

### Collision groups (`game/config/collision.ts`)
`PLAYER, PURSUIT, CIVILIAN, PROP_STATIC, PROP_DYNAMIC, BUILDING, PROJECTILE, GROUND,
WATER(sensor)`. Projectiles ignore projectiles; water senses only vehicles. Convex
primitive colliders ONLY (cuboids/capsules/balls) — no trimeshes at runtime.

### Entity registry pattern
Every collider handle maps to `{ kind, archetype, instanceId, hp, districtId, … }` in one
registry (`world/registry.ts`). ALL contact resolution goes through it. Not a full ECS —
R3F archetype components + plain system modules.

### Events (typed emitter)
`heatChanged, tierChanged, transformerDestroyed, unitWrecked, civHit, civWrecked,
propDestroyed, playerDamaged, playerWrecked, busted, runStarted, runEnded, darkCity`.
HUD/audio/FX subscribe; systems stay decoupled. Extend the catalog, don't bypass it.

### Perf budgets (TDD §10) — checked at every phase exit
| | Desktop high | Laptop med | Mobile low |
|---|---|---|---|
| FPS | 60 | 60 | 30 |
| Draw calls | < 150 | < 120 | < 90 |
| Triangles | < 300k | < 200k | < 120k |
| Active dynamic bodies | 120 | 90 | 60 |
| Shadows | 2048 | 1024 | off |
| DPR cap | 2.0 | 1.5 | 1.5 |

Shell bundle < 150 KB gz, paints before game chunk (≈2–3 MB) loads. Game deps must never
leak into the shell chunk — check `pnpm build` output per phase.

### Heat / tier quick reference (full tables: TDD §5.5–5.6, values in `game/config/`)
Tier thresholds `[0, 15, 75, 180, 350, 600]`; concurrent pursuit caps `[0, 4, 6, 8, 9,
10]`, max 2 tanks; spawn ring 60–90 m, despawn > 140 m; passive +1 heat/s while ≥ ★1.
Score = Σ heat events + 5 × tier per second while ≥ ★1.

### Conventions
- **pnpm**, Node 22 LTS, TS strict, no `any` (lint-enforced). Vitest for pure logic;
  Playwright for smoke + screenshots.
- 1 unit = 1 m, Y-up, glTF (Draco via `gltf-transform`), typed asset manifest.
- Single palette-texture material shared by everything; per-instance color + `emissiveOn`
  attributes on all InstancedMeshes.
- **Instance buffers are ordered/grouped by district** with recorded `[start, count]`
  ranges per archetype — blackouts write one buffer range. Sacred; set up in Phase 5.
- Every gameplay phase extends the dev **debug panel** (leva): force tier, grant heat,
  spawn unit X, blackout district, teleport, invincible, chaos bench. Agents verify
  through debug switches + screenshots, not gameplay skill.
- All numbers live in `game/config/` typed `as const`, live-tunable via leva in dev.
  If you tune a value away from the TDD default, record it in handoff notes.
- No real-world logos/wordmarks (generic "POLICE", plain red/white streetcar). Stylized
  landmark shapes fine. Every non-CC0 asset gets an entry in `assets/credits.json`.
- Commits: short conventional messages (`feat:`, `fix:`, `chore:`). **Never** add
  Claude/AI co-author trailers or attribution.

### Commands (after Phase 1 exists)
`pnpm dev` · `pnpm build` · `pnpm preview` · `pnpm typecheck` · `pnpm lint` ·
`pnpm test` · `pnpm smoke` (Playwright) · `pnpm assets:fetch` (Phase 5+)

---

## File map

| What | Where |
|---|---|
| TDD (authoritative spec) | `portfolio-smashy-road-tdd.md` |
| Part files (phase scopes, this roadmap's detail) | `.planning/part-*.md` |
| Session-authored phase plans | `.planning/phases/phase-NN-plan.md` |
| Session handoff notes | `.planning/phases/phase-NN-notes.md` |
| Templates | `.planning/templates/` |
| Autonomous multi-phase runner (for the sandbox devcontainer) | `.devcontainer/run-all-phases.sh` |

`.planning/` is gitignored (local workflow docs); `CLAUDE.md` and the TDD are committed.
