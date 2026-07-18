# Smashy the 6ix — Portfolio Site + 3D Driving Game

Personal portfolio site whose homepage **is** a playable low-poly 3D driving/destruction
game (Smashy Road-style, Toronto-flavored). React shell (header/portfolio/resume) paints
instantly; the game is a lazy-loaded chunk. Full spec: **`portfolio-smashy-road-tdd.md`**
(the TDD — authoritative for all design intent). The Part 7 map overhaul is governed by
its own spec: **`docs/map/TORONTO-MAP-SPEC-v2.md`** (see MAP PROJECT section below).

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
- [x] **Phase 12 — ★5 Tanks, shells, explosions + chaos bench** (M5c) — 2026-07-16: pure-point no-tunnel shells, faction-free 8 m blasts (friendly fire proven live, player can't helicopter), 6×-mass tank w/ 0.8 s telegraph + dodgeable-by-construction shells, ★5 composition (2 tanks max), chaos bench standing harness (3× runs: 71/150 calls, 211k/300k tris, heapΔ 0.0 MB, exit 0); 799 tests; M5/Part 4 COMPLETE (see phase-12-notes.md).

### Part 5 — Signature & Juice (`.planning/part-5-signature-and-juice.md`)
- [x] **Phase 13 — Power grid & district blackouts** (M6) — 2026-07-16/17: seeded flicker → permanent district blackouts (write 0.05 ms vs 1 ms budget), 6-light pool w/ hysteresis + dark-exclusion-even-mid-fade, DARK CITY banner + persisted badge, minimap overlay + debug suite; real event chain proven live, 876 tests (see phase-13-notes.md).
- [x] **Phase 14 — Helicopters & searchlight** (M7a) — 2026-07-17: orbit/bank flight model w/ presence fly-in/out + ★5 dual at π offset, 96-tri 3-livery heli, ONE SpotLight + fake volumetric cone + ground pool (money shots over dark districts/DARK CITY), zero physics cost (Δ0 A/B), bench 73/150 calls; 916 tests (see phase-14-notes.md).
- [x] **Phase 15 — Audio pass** (M7b) — 2026-07-17: fully-synthesized WebAudio soundscape (documented deviation — no files obtainable): bus/pool manager w/ priority eviction, 19 sounds (engine/impacts/guns/explosions/transformer/ambience/stingers), per-kind sirens + culled hums + rotors w/ camera-frame panning, full catalog event map w/ compile guard + ducking; 10-retry orphan soak PASS; 1,061 tests; AUDIBLE QUALITY = user's ears (see phase-15-notes.md).
- [x] **Phase 16 — FX & juice pass** (M7c) — 2026-07-17: 500-slot/2-draw-call particle system + 8 presets, slip-triggered skids + tire smoke, damage tint/smoke/fire states, per-source shake + FOV kick + reducedShake, BUSTED wash/WRECKED beat/DARK CITY treatment, road-follow pursuit slice; found & fixed TWO buried regressions (TankMesh/Explosions/TankTelegraph never mounted since P12 — tanks couldn't spawn, blasts had no visuals; spark-spam pool saturation); bench 92-95/150 calls heapΔ0, 5-min soak flat, 1,196 tests (see phase-16-notes.md). M7/Part 5 COMPLETE.

### Part 6 — Ship It (`.planning/part-6-ship.md`)
- [x] **Phase 17 — Garage, six cars, unlocks, persistence** (M8a) — 2026-07-17: grade→param mapping w/ test-locked sedan invariance, six distinct procedural cars + real garage (cards/bars/locks/keyboard), monster crush + heavy plow + boat-turn specials, lifetime-score unlocks + toast + v1-additive persistence (lastSeed/unlockedCarIds); found & fixed THREE live bugs (garage re-entry never ended the run; pre-existing run-start Suspense race — runStarted lost to a fast click, engine audio/lastSeed dead; HP bar % math wrong for non-100-hp cars); ★5 regression heaviest+lightest clean, bench 92/150 heapΔ0, 1,320 tests (see phase-17-notes.md).
- [!] **Phase 18 — Mobile controls & quality tiers** (M8b) — 2026-07-17: touch controls (auto-throttle proven hands-free), quality manager finalized (probe + full §10 budget wiring, user-choice-wins), all-tier benches green (med debt closed; low 119.7k/120k), WebGL2 gate + Play card + context-loss recovery, mobile e2e; found & fixed leva boot-provenance bug + root-caused the seed-416 fallen-pole spawn hazard; 1,440 tests (see phase-18-notes.md). AWAITING USER: real-phone test (checklist in notes). Phase 19 MAY proceed in parallel per part file.
- [x] **Phase 19 — Toronto landmark layer & lighting polish** (M9) — 2026-07-17: landmark seam (deterministic, hash re-pinned f573aa88) + CN Tower/stadium/flatiron models, Kensington market district (blackout money-clip PROVEN live) + midtown, 4 streetcars looping avenues (verified 6 m/s live, wreckable 3,600 kg payday), raccoons/tipped cans, sky lake-glow + water shimmer + exposure 1.35; found & fixed a Rapier boot panic (StrictMode body churn pre-step); benches green all tiers WITH the layer (low 119.8k/120k); 1,552 tests. HONEST RE-SCOPE: tower-at-distance wayfinding is geometrically impossible under the locked §5.3 camera — documented for the user (see phase-19-notes.md).
- [!] **Phase 20 — Content, SEO, credits, launch** (M10) — 2026-07-17: ALL non-content work shipped — prerendered SEO routes (game-free, proven), typed meta/OG/sitemap, guarded Vercel Analytics + game events, verified-license credits page, error boundary (site never white-pages, e2e-proven), on-brand 404, vercel.json, typed placeholder content layer (draft-badged, zero-refactor drop-in), full a11y/QA audit w/ all 4 filed issues fixed (skip-link restored, game UI exposed to AT); 1,635 tests, smoke 30/31, shell 94.4 KB gz (see phase-20-notes.md). AWAITING USER: Vercel connect, real content, phone test (P18), wayfinding call (P19), launch approval. Lighthouse numeric x4 owed from a real machine.

### Part 7 — Toronto Map Overhaul (`.planning/part-7-toronto-map.md` · spec `docs/map/TORONTO-MAP-SPEC-v2.md`)
User re-scope 2026-07-17: rebuild the map as a *recognizable* Toronto — thermometer
polygon (downtown block + Yonge stem + North York capsule), real street grid, named
buildings with materials + brand decals, CN Tower/Rogers heroes, places/nostalgia layer.
Phase numbering continues the master list; each maps to a spec §10 phase. The legacy
64×64 world stays the playable game until the new map reaches drivable parity (see MAP
PROJECT workflow rule 4).
- [x] **Phase 21 — Map v2 ph.0: piecewise projection + polygon world** (spec §1–§3, §10.0) — 2026-07-17: CLAUDE.md merge + file canonicalization; 18/20 anchors researcher-verified (round-1 latitude.to coords failed the monotonic-lon sanity gate — up to 700 m off, re-verified vs Wikidata); projection (Yonge straight at x=1500 by construction, exact inverse), §1 polygon + idempotent 80 wu camera clamp, §3c height curve, 4 data files + schema gate; derived truth snapshot-pinned (downtown N-S 1.81 m/wu, not the table's 1.55 — real Bloor→shore is 3.39 km; Steeles + Casa Loma off-map); fixed 3 fresh-container preconditions + a real error-path e2e race (terminal strict-mode violation vs 2 fallback-state h1s); 1,696 tests, smoke 30+1 skip, zero runtime wiring — game untouched (see phase-21-notes.md).
- [x] **Phase 22 — Map v2 ph.1: road graph on the thermometer + Line 1 tunnel transition** (§10.1) — 2026-07-17: 24 §3a streets from 10 new researcher-verified street_ref anchors (3 more rounds; "proxies must sit near Yonge" lesson), TrafficGraph-shaped road graph (863 nodes/1,824 edges, BFS-connected through the spine, tileIndex:-1 debt), boundary-nudge rule, pure fold-crossing tunnel (closed-band, re-arm, single-fire on jumps) + Line 1 overlay via new tunnelTransit event (silent audio entry), TorontoScene behind `torontoMap` dev toggle (ground/water-sensor/ribbons+curbs+dashes/signposts/fell-out net/camera clamp w/ corrective render), legacy OFF-branch byte-identical; LIVE-PROVEN: Finch→Union drive tracks x=1500 whole way, overlay both directions, water→WRECKED→R-retry, 30 calls/6.7k tris, 0 errors; FLAGGED DEBT → P23 first task: dev-slice standard-material output crushes to black (unlit-literal materials shipped as mitigation; verify on real GPU); 1,766 tests (see phase-22-notes.md).
- [x] **Phase 23 — Map v2 ph.2: filler massing + district stock** (§6–§7, §10.2) — 2026-07-17: 15-district layer (declarative street/zone-referenced bounds, zero literals, 100% coverage, +111 tests), deterministic seeded massing (567 frontage-biased boxes, §3c-curved heights, Yonge storefront strips, contiguous district [start,count] ranges, 567 BUILDING colliders), district ground tints; data source = part-file-authorized procedural fallback (OSM/Cadmapper = optional user upgrade); MATERIAL VERDICT: lit Lambert ALSO crushes on the bare slice — legacy reads via emissive windows, so unlit-literal ships and Phase 24's palette+emissive is THE look fix (real-GPU check still user-owed); §10.2's literal skyline gate impossible under the locked §5.3 camera (same truth as P19's wayfinding) — street-level frontage read achieved + FLAGGED FOR USER; slice 33 calls/20.4k tris, legacy byte-identical 93/187k, 1,890 tests (see phase-23-notes.md).
- [x] **Phase 24 — Map v2 ph.3: named buildings, materials, CROWN decals** (§3c–§4, §10.3) — 2026-07-17: specs round-6 (3 confirms incl. Union's 229 m = 74 wu EXACT; Hullmark 167.94, Emerald twin 41+32, Eaton 129 wu by rule), 14 street-referenced placements (twins, Well podium, Casa Loma DROPPED — off-polygon), §4 material→look map + per-facade window CanvasTextures w/ seeded warm lit windows (THE P23 look fix proven live: Scotia red granite + Aura blue glass glow at dusk), 5-brand 32×32 pixel homage atlas + S/E CROWN decals on the six banks (visible faces PINNED: south+east) + trademark-disclaimed credits section, massing exclusions + hero lots reserved; CAMERA-VANTAGE WALL confirmed 3rd time — crowns (36–49 wu) sit above the locked camera's ~15 wu visible ceiling, same user decision as P19 wayfinding/P23 skyline; flush-frontage pass = P25 entry task; 67 calls/20.5k tris, 1,930 tests (see phase-24-notes.md).
- [x] **Phase 25 — Map v2 ph.4: heroes — CN Tower + Rogers Centre, occlusion fade, night pod ring** (§5, A.3, §10.4) — 2026-07-17: CN 266 tris (hex taper, pod 0.62h w/ emissive LED ring, SkyPod 0.81h, needle, legs; h=90.68 single-source) + Rogers 240 tris (ring base, seamed 4-band dome, sliding panel) on the reserved rail-lands lots w/ base-cylinder colliders; A.5 occlusion fade proven via new occlusionMinOpacity probe (0.35 behind TD; visible see-through shot geometrically precluded — camera sits inside occluders, 4th camera-wall confirmation); flush-frontage pass 13/14 (RBC/CIBC on York — Bay/York artifact; Well podium exception); 71 calls/21.5k tris, 1,957 tests (see phase-25-notes.md).
- [x] **Phase 26 — Map v2 ph.5: places layer, vibe props, Sam's discs, queues (nostalgia pass)** (§6, §8, §10.5) — 2026-07-17/18: round-7 research (20/20 places verified), 21-cell retail atlas + 20 disclaimered brand credits, placesLayer (street-referenced address table incl. NY street-number interpolation, FASCIA bands, cosmetic queues, spinning Sam's discs, Chinatown gate/crosswalk/umbrellas/patio lights/Sankofa screens/graffiti), CROWN UV V-remap regression fixed; agent lost to a network outage post-verification — orchestrator re-verified (1,979 tests, 78-79 calls, 0 errors); ORIGINAL SPEC §10 COMPLETE — parity flip deferred until after the city-pack re-dress (see phase-26-notes.md).

**CITY-PACK REAPPROACH (user directive 2026-07-17, supersedes the earlier detail-pass
plan and the "all-procedural assets" reality of Phases 21–26):** the user supplied a
57-model GLB city pack (13 MB, at repo root pending ingestion — buildings incl. two BLANK
facade variants, Traffic Light, Power Box, full street furniture, vehicles, animated
characters). New rules: (1) world models REFERENCE the pack instead of in-house
procedural — EXCEPTIONS: playable cars stay in-house (user-stated), wanted-level pursuit
units stay in-house (user-stated), and towers/heroes (CN, Rogers, bank towers, twins)
stay in-house because the pack has no tower-class models (orchestrator exception, flagged
to user); (2) every referenced business building gets a PERSONALIZATION layer (blank
pack facades + the 21-cell logo atlas FASCIA/CROWN decals + awnings/posters/props) so
the business reads; (3) pack characters are EXCLUDED from gameplay (locked "Pedestrians:
none") — static prop use only if ever; (4) roads re-scaled car-derived (mains ≈ 7
player-car widths, supersedes §3a; buildings ≈ 3 car lengths, landmarks exempt); (5)
licence/source of the pack: ASK USER — credits entry required before launch. Process:
each sub-phase planned by a Fable-5 planner agent, built by Opus/Sonnet subagents.
- [x] **Phase 25.5 — asset pipeline & pack ingestion** — 2026-07-18: pipeline (dedup→palette→join→quantize→meshopt→webp; 52 GLBs 6.01→0.90 MB, all buildings 1-prim/1-material, sha-idempotent + drift-guard), typed manifest + car-derived scale config (building ×5.59 → 13.5 wu), meshopt-only loader streamed from public/ (game chunk +22 KB gz decoder code only), CityPackInstances (instanceColor tints proven) + preview cluster behind toggles, collision proven; A/B VERDICT: UNLIT wins for textured pack assets too (lit crushes under ACES at blue hour — SwiftShader-provisional); pending-licence credits badge (City Pack = scrubbed multi-author poly.pizza — user sources needed; MegaKit is CC0 w/ licence file → user call on wider use); 2,022 tests (see phase-25.5-notes.md).
- [x] **Phase 25.6 — world re-dress** — 2026-07-18: car-derived roads (spine 15.4 = 7 cars, §3a superseded w/ spec addendum), 0.4 wu dashes, 4 wu sidewalk band, crosswalks + dash-skip; simplify() pipeline (flat-normal root-cause fix; pack 381 KB, all caps hit); frontage.ts street-walk placer (stable slot ids = 25.7 seam) replaced massing.ts; furniture (244 traffic lights w/ NS/EW lamp cycling proven, 700 trees, 80 power boxes, hydrants/benches/trash/bus stops/manholes) + 200 parked cars as sleeping dynamics (shove-proven); worst-vantage 47 calls/19.3k tris — gate beaten 10×; builder killed by machine sleep post-verification, orchestrator re-verified (2,161 tests, 14-shot evidence set) (see phase-25.6-notes.md).
- [ ] **Phase 25.7 — business personalization**: every places.json venue on a blank-facade pack model + FASCIA/CROWN decals + awnings/billboard/poster dressing (Pizza Corner for pizza etc.); P26's queue/disc/vibe systems re-skinned onto pack models; named towers keep their P24 window-texture boxes (pack-exception)
- [ ] **Phase 25.8 — cohesion & perf**: lighting/tone unification over pack materials, ground detail (sidewalk curb depth, noise textures, park patches), perf re-verification vs budgets (13 MB pack → Draco/lazy-load strategy so the shell stays < 150 KB and game boot stays sane), screenshot reel

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
| Map | **Toronto thermometer polygon** (2400×4100 wu, `docs/map/TORONTO-MAP-SPEC-v2.md` §1) — user re-scope 2026-07-17. Legacy 64×64 tile map ships until the new map reaches drivable parity (MAP PROJECT rule 4) |
| Brand logos (map layer) | **In** — user override 2026-07-17: real Toronto brands as 32×32 pixel-art homage decals (nearest-neighbour, mipmaps off, no photo logos); police/military stay generic; every brand gets an `assets/credits.json` entry with a trademark note |
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

## MAP PROJECT — Toronto playable map (Part 7)

Governed by **`docs/map/TORONTO-MAP-SPEC-v2.md`**. Read the relevant spec section before
touching map code. Do not improvise geometry, scale, or placement decisions the spec
already makes.

### Source of truth (data > code)
- `data/toronto/anchors.json` — researcher-verified WGS84 coordinates calibrating the
  projection. Derived world coords are *regenerated* from these — never hand-tune twice.
- `data/toronto/building-specs.json` — heights, footprints, materials, computed game
  dims. **Never hardcode a height, footprint, colour, or address in code.** Code reads
  the JSON; if a value is wrong, fix the JSON.
- `data/toronto/places.json` — consumer spots; each entry carries
  `status: verified | knowledge | needs_agent`. `needs_agent` entries are filled ONLY by
  the map-researcher subagent or `tools/research/run_researchers.py` — never by
  guessing, never from the main thread's memory.
- `data/toronto/model-sources.json` — free geometry sources + licence notes. Any shipped
  CC-BY asset gets a credits entry.
- All four files are schema-checked by a vitest suite under `src/game/world/toronto/`
  (runs in `pnpm test`, hence CI).

### Workflow contract (map phases)
1. Phase order = spec §10 = checklist Part 7. One spec phase per session; the session
   protocol above applies unchanged (plan → subagents → verify → handoff → commit+push).
2. Each spec section lists its tests. **Write those tests first**, watch them fail,
   implement to green. The tests are the exit condition — if they pass, stop; don't
   gold-plate.
3. Scale/width/height values come only from the spec §3 tables via `data/toronto/` +
   `game/config/`. Grep for magic numbers before committing.
4. The legacy 64×64 world remains the deployed game until the Toronto map reaches
   drivable parity (target: end of Phase 23), then a config switch flips and the legacy
   generator is retired in a cleanup pass. Never leave main with a broken game.

### Cost discipline (research)
- Real-world lookups (an address, a height, a licence, "is this place still open") go to
  the **map-researcher** subagent (Haiku, contract in `.claude/agents/map-researcher.md`),
  not the main thread.
- Whole-dataset refreshes: `ANTHROPIC_API_KEY=... python3 tools/research/run_researchers.py
  [places|specs|models]`, then merge `tools/research/out/*.json` into `data/toronto/`
  (review the diff). The devcontainer has no API key — use the subagent path there.

### Renderer decisions — RESOLVED (spec Addendum A)
- True 3D, low-poly flat-shaded, Smashy Road-style. Buildings are extruded boxes with
  flat/vertex colours — no photo textures anywhere. Tri budgets: CN Tower ≤ 600,
  Rogers ≤ 500, filler box ≤ 12.
- **Camera bearing: FIXED** — answered 2026-07-17 from `game/config/camera.ts`
  (yaw 45°, pitch 50°, no player rotation control; sole exception is the death-beat's
  8° yaw drift). Addendum A.2's fixed-bearing branch applies: exactly two faces of every
  box are ever visible; author CROWN/FASCIA decals on those two faces only; the decal
  test is "decal face lies in the camera-visible half-space". Pin the exact face pair
  when Phase 21's map→world axis mapping lands.
- Logo decals: quads from the 32×32 pixel atlas, nearest-neighbour, mipmaps OFF.
- Occlusion: any mesh intersecting the camera→car ray fades to alpha ≤ 0.4 within
  150 ms (Phase 25 test; mandatory for the financial district and CN Tower).

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
- Real-world brand logos are **in for the map layer only** (user decision 2026-07-17,
  supersedes the earlier no-logos rule): 32×32 pixel-art homage versions, never photo
  assets. Police/military liveries stay generic ("POLICE"). Stylized landmark shapes
  fine. Every non-CC0 asset AND every referenced brand gets an entry in
  `assets/credits.json`.
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
| Toronto map spec (authoritative for Part 7) | `docs/map/TORONTO-MAP-SPEC-v2.md` |
| Toronto map data (single source of truth) | `data/toronto/*.json` |
| Map research runner (needs `ANTHROPIC_API_KEY`) | `tools/research/run_researchers.py` (out: `tools/research/out/`) |
| map-researcher subagent contract | `.claude/agents/map-researcher.md` |
| Part files (phase scopes, this roadmap's detail) | `.planning/part-*.md` |
| Session-authored phase plans | `.planning/phases/phase-NN-plan.md` |
| Session handoff notes | `.planning/phases/phase-NN-notes.md` |
| Templates | `.planning/templates/` |
| Autonomous multi-phase runner (for the sandbox devcontainer) | `.devcontainer/run-all-phases.sh` |

`.planning/` is gitignored (local workflow docs); `CLAUDE.md` and the TDD are committed.
