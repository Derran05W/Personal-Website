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
- [x] **Phase 24 — Map v2 ph.3: named buildings, materials, CROWN decals** (§3c–§4, §10.3) — 2026-07-17: specs round-6 (3 confirms incl. Union's 229 m = 74 wu EXACT; Hullmark 167.94, Emerald twin 41+32, Eaton 129 wu by rule), 14 street-referenced placements (twins, Well podium, Casa Loma DROPPED — off-polygon), §4 material→look map + per-facade window CanvasTextures w/ seeded warm lit windows (THE P23 look fix proven live: Scotia red granite + Aura blue glass glow at dusk), 5-brand 32×32 pixel homage atlas + S/E CROWN decals on the six banks (visible faces PINNED: south+east) + trademark-disclaimed credits section, massing exclusions + hero lots reserved; CAMERA-VANTAGE WALL confirmed 3rd time — crowns (36–49 wu) sit above the locked camera's ~15 wu visible ceiling, same user decision as P19 wayfinding/P23 skyline; flush-frontage pass = P25 entry task; 67 calls/20.5k tris, 1,930 tests (see phase-24-notes.md). *[P38 annotation: the "~15 wu visible ceiling" cited here is the dead baseDist-18 doctrine (see the MAP PROJECT camera block); the crown-invisibility verdict itself was re-measured and CONFIRMED under rig E at Phase 38.]*
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
- [x] **Phase 25.7 — business personalization** — 2026-07-18: claim engine (pre-occupancy lattice; 18 venues claimed INTO the streetwall, seed-independent, thin-exempt, McDonald's→pizza-corner corner hit landed), venueDress (27 fascia bands w/ camera-visible side-band rule, 14 procedural awnings, 96 kit props, queues migrated, Alo plaque), placesLayer shrunk to P26 exceptions; rendered via existing batched paths (+4 calls/+1.25k tris worst — budget beaten 3×), venueDress toggle + per-venue teleports; 17 screenshots (McDonald's corner + H Mart = money frames); W/N-facing venues read via side bands only (camera-wall constraint); 2,236 tests (see phase-25.7-notes.md).
- [x] **Phase 25.8 — cohesion & perf** — 2026-07-18: relight composite shipped (diagnosis: palette band + fog-as-contrast-compressor; fog pushed out, ladder brightened test-locked, subtle facade gradient bake — all leva-live, real-GPU call = user), curb-height sidewalks VISUAL-only (colliders rejected on the mandatory drive-feel gate — car launched), seeded ground noise (+0 calls) + 5 named parks + patches (seed-independent, venue-safe), no-furniture-on-ribbon invariant (Bloor masts fixed), queue visibility polish; tier wiring w/ HIGH-TIER BYTE-IDENTITY golden test (low: 50 calls/21.9k tris/50 bodies — under mobile budget; legacy low-tier bench flake proven pre-existing via clean worktree); asset-delivery line superseded-in-fact by 25.5 meshopt (381 KB); 17-shot before/after reel + contact sheet; 2,289 tests, smoke 31/31 (soft-skip now passes); CITY-PACK REAPPROACH COMPLETE — Part-8 (parity flip) proposal in notes, awaiting user (see phase-25.8-notes.md).

### Part 8 — Density, Life & the Flip (`.planning/part-8-density-life-flip.md`)
**User directive 2026-07-18** (converts the 25.8 Part-8 proposal into mandated work and
re-scopes it): the map must become a *denser, smaller* Toronto (≈0.6 linear compaction,
narrower roads, near-solid streetwall, building heights cut so the camera stops phasing
in), the Toronto map becomes the **DEFAULT** shipped world at parity flip, and the city
pack carries far more of the world: more building variants, a seeded basic-car
algorithm (weighted model pick × colour-varied body tints) for traffic/parked, 10–14
TTC transit vehicles on **researched real routes** (route table Haiku-verified
2026-07-18, embedded in the part file), construction sites from pack props, and —
USER OVERRIDE of the "playable cars stay in-house" lock — the default rusty car (and
garage cars where a pack fit exists) swap to pack models; monster truck + pursuit units
+ heroes/towers + streetcars stay in-house. City-pack licence gate CLEARED 2026-07-18
(user: open-source, permission confirmed); still wanted non-blocking: pack link/licence
name/author for a proper `assets/credits.json` entry (dated used-with-permission
fallback otherwise). **Model economy (user 2026-07-18):** user near usage limits —
Fable orchestrates but token-efficiently; prefer Sonnet subagents, Opus only for the
hard cores (see "Model economy" in the part file).
- [x] **Phase 27 — Compact re-projection, road diet, height cut** — 2026-07-19: DENSITY.scale 0.6 (fold exempt, YONGE_X invariant preserved) → 1440×2724 wu map, roads 5/4.5/4/3 cars, sidewalk 3, heights compressed (districts ×~0.55 cap 110 m + NAMED_HEIGHT_SCALE 0.6, heroes exempt), frontage pitch 14/occupancy ↑/cap 1400 SATURATED (≥4× per-area density); builder fixed 3 real latent literal bugs; live gate found+fixed backdrop-box fusion walls (reject-not-relocate + self-overlap), mast arm spanning dieted roads (scale 1.0), crosswalk 2.2; drive gate PASSED (spine x=1500.0 whole way, slalom hpΔ0, water WRECKED, retry, tunnel overlay); 2,318 tests, 0 console errors; landmarks() bridge = legacy-only gotcha (see phase-27-notes.md)
- [x] **Phase 28 — Infill: solid streetwall, back lots, parking lots, construction sites** — 2026-07-19: new infill.ts (reject-never-relocate family, ordered passes): 49 corner fills, 500+325 back-lot buildings/boxes, 350 laneway clutter, 16 parking lots w/ 115 static cars, 14 construction sites, 5 lane closures w/ 31 knockable cones (live gate: 59 impacts, hpΔ0, drives through), D11 deep-interior scatter (450-cap trees/greenhouses/piles; NY capsule honestly sparse — dials documented) + all-9-model packStock + blank-facade tints; whole layer +1 draw call/+4.6k tris, worst settled vantage 56 calls/27k; ~1,114 new colliders AWAITING P29 registry; 2,380 tests, 0 errors (see phase-28-notes.md)
- [x] **Phase 29 — Gameplay parity core: registry, destruction, civilian traffic + car-variety algorithm, heat/score, powergrid on Toronto** — 2026-07-19: Toronto branch mounts the gameplay spine (Damage/PropDynamics/HeatScore/DamageStates/Particles/Skids/PowerGrid); ~3,900 registry entries incl. 74 power boxes as transformers (newly collidered) + 200 scoring parked cars; found+fixed born-dynamic force under-report (propDynamic joins the ram proxy — parked rams score); 15-district blackout chain proven live (ground-tint darkening; debugBridge 16-count observability bug fixed +7 tests); traffic on the Toronto graph (existing controller, thin adapter, roster 16/24/32) w/ carVariety (7 models × 12 colours, anti-repeat) + pipeline neutral-body recolour ALL-preferred-path (manifest 52→59) — true body colours w/ dark glass; Toronto minimap live; 5-min soak flat heap 0 errors; 2,492 tests; debts: furniture-launch pool, LightPool adapter, 2-hit transformer tune → P30 (see phase-29-notes.md)
- [x] **Phase 30 — Pursuit parity: graph-native police nav (de-tiling), ★1–★5, helicopters** — 2026-07-19: NavProvider seam extracted from the 4 tile-read call sites (legacy impl verbatim + parity-pinned, ALL existing pursuit tests unchanged; Toronto impl: ribbon drivability, spatial-hash nearest, BFS waypoints, graph-node spawn ring — 60-90 m verified on the compact map); full ★1→★5 live on Toronto (chase/flank@10m/orbit-standoff/tank+telegraph+shell+explosion, dual heli, WRECKED organic, BUSTED via sanctioned trigger); P29 debts closed (BatchedMesh setVisibleAt launch pool reusing propDynamics pure fns byte-identical — furniture flies, StrictMode registration bug found+fixed; LightPool on mast emitters w/ dark exclusion; Toronto-own transformer hp 15); integrated gate: ★3 soak flat heap, 21 behavior labels, blackout+searchlight frame, 0 errors; 2,525 tests; FLAG: organic BUSTED still geometry-unreachable (locked 8 m radius — USER CALL, see notes) (see phase-30-notes.md)
- [x] **Phase 31 — Transit on real TTC routes (buses + streetcars) + player pack cars** — 2026-07-19: 15 verified TTC routes data-driven (schema-gated, endpoint tokens, zero literals) on the UNFORKED P19 streetcar controller (8 bus incl. 97 full-spine + 7 streetcar; rooftop route boards after a camera-law catch; TTC credits w/ disclaimer; route-derived bus stops); player cars: pipeline `-player` GLB variants w/ REAL wheel nodes (mirrored-name + baked-transform pitfalls solved by geometry; bus→hubcap fallback), rustySedan→rusty car-a DEFAULT + 4 more swaps, monster in-house, garage auto-flows, wheel-spin+damage-tint proven, bundle-leak caught (shell −3.4 KB); THE GATE CHAIN — 3 real defects found live & fixed: civilian head-on deadlock latent since P29 (direction-offset lane chains, 505→976 nodes, jam test ×2 90-97% movement), bus wrong-way return legs (closed-loop routes + pathMode:'loop', 106/106 direction checks), transit lockstep co-location (startFracs spread); P27 empty-map spine-cruise invariant RETIRED (live city: heat→swarm boxing is the game) → replacement invariants proven; 2,623 tests (see phase-31-notes.md)
- [!] **Phase 32 — The flip: WORLD_SOURCE=toronto default, legacy retirement, launch gates re-run** — 2026-07-19: **TORONTO IS THE SHIPPED GAME.** WORLD_SOURCE='toronto' (toggle/bridge/devPanel plumbing removed), legacy de-imported w/ marker-diff bundle proof (game chunk −44 KB, heap baseline 215→169 MB; source+tests stay pending user-approved excision), downtown Yonge spawn (drift-guarded, exclusion-checked), chaos bench FIXED (was silently broken on Toronto) + GREEN ×3 tiers (77-85 calls, all budgets beaten), credits finalized (pending badge gone, dated permission entry + attribution placeholder), graphViz wrong-graph fix; flip-QA on true default boot: full ★-ladder, 5-min soak flat heap, 0 errors; 2,624 tests, smoke 31/31 ×2; **PART 8 COMPLETE** (see phase-32-notes.md). AWAITING USER: Lighthouse ×4, phone test, content/Vercel/launch approval, real-GPU look, pack attribution details, BUSTED-radius call, legacy-excision approval

**IMMERSION OVERHAUL (user directive 2026-07-26, governs Parts 9–16):** two headline
problems: (1) the camera phases through buildings / weird perspectives — fix via camera
angle and/or building size; the "Camera bearing: FIXED" lock is **UNLOCKED for user
re-decision** at the Phase 33 USER GATE. (2) Far more Toronto detail & life (everything
except pedestrians), object-overlap "flashing" (z-fighting) eliminated, and the map
edge becomes a barrier or auto-kill. Master plan + arc rationale:
`.planning/immersion-overhaul-overview.md`; freely-licensed pack survey (all-CC0
top-8 incl. the Quaternius Downtown City MegaKit already at repo root):
`.planning/asset-pack-research.md`. Process: Fable 5 orchestrates at max effort;
implementation subagents default to **Opus 5** (user 2026-07-26 — supersedes the
Part-8 "prefer Sonnet" model economy); one phase per session, protocol unchanged.
Cross-cutting laws (overview §rules): camera decision cascades (no camera-dependent
pins until Phase 34 lands); ground-stack layering ladder is law after Phase 39; the
global placement arbiter is law after Phase 40; tri-budget raises are deliberate and
re-pinned, never silent.

### Part 9 — Camera, Scale & World Edge (`.planning/part-9-camera-world-edge.md`)
- [x] **Phase 33 — Camera lab: candidate rigs, clip instrumentation, USER GATE decision** — 2026-07-26: lab shipped ALL dev-gated (5 live-swap presets w/ FOV-into-config, prod bit-for-bit unchanged — chunk-grep-proven), clip instrumentation (2,383-AABB index + 9 counters incl. mid-session boresight metric), deterministic 12-leg scripted drive (waypoint-boxed after time-boxing proved non-comparable) + 35-still/10-drive battery + contact sheet; measured: A rests INSIDE a wall 100% at fold-corridor + 2.7% eye-inside driving, C buries the car behind rooftops, D's spring arm self-defeats (pull-in lowers the eye — probe-the-base-rig fix + insight for P36), E zero eye-inside across every run, B clean except one 7.4% wedge draw (its corridor margin is ~0 wu vs E's ~1); corridor-airspace law discovered (eye must stay inside the street's airspace: hr ≤ ~14.8 wu); 2,753 tests, 0 errors. USER GATE RESOLVED 2026-07-26: **rig E picked (yaw 45 / pitch 58 / dist 26 / FOV 38)** — Phase 34 adopts it as law (see phase-33-notes.md)
- [x] **Phase 34 — Camera adoption: new §5.3 law, clamp rework, visible-face re-derivation** — 2026-07-26: rig E SHIPPED (45/58/26/FOV 38) w/ the ramp SPLIT (speedZoom 4 + new speedPitchDeg 5 / tierPitchDeg 1.3 — corridor law hr ≤ 14.8 holds across the whole envelope, worst pitch 69.5°; law test pins literals + the invariant durably), death beat retuned (−22° restores the 36° arrest; BUSTED ★2+ excursion documented → P36), clamp moved IN-RIG via new prod-active pos-constraint seam (second gl.render DELETED, grep-proven; padding 80→30 MEASURED — clamp-can't-fix-void discovery, corridor free travel +50%, residual edge ring → P37), face pin south+east CONFIRMED standing (yaw-pure, all 6 sites), forceDeathBeat dev tool, boot pose derived; battery: E **0% eyeInside on every still+drive** (A's fold-corridor 100/100 = the before), perf Δ0 calls; 2,779 tests, smoke 31/31, 0 errors (see phase-34-notes.md)
- [x] **Phase 35 — Height re-grade under the new camera + the one true eye-line constant** — 2026-07-26: `CAMERA_EYE_MIN/MAX_WU` (22.05/35.13, computed from CAMERA leaves, law-tested THROUGH the rig's own fns) replace the dead "~13.8/15 wu wall" doctrine; audit found ONE real violation — brown-building at 24.19 wu as ordinary streetwall in 12/15 districts (frontage WIDTH rule setting height via aspect ratio) — fixed structurally via `STREETWALL_MAX_HEIGHT_WU` cap in resolveCityPackScale (binds on it alone → 21.05); eye-line law pinned in heightLaw.test.ts incl. THE CROSSER LIST = P36's occlusion work order (35 backdrop boxes + 9 tower-district back-lot boxes batched/unfaded, 12 named boxes + 2 heroes already faded); live battery: 2 drives eyeInside 0/0, census 56 crossers matches pin, 22-shot after-vantage set (interior-e before/after = the money pair), 0 errors; no goldens moved; 2,808 tests, smoke 31/31 (see phase-35-notes.md)
- [x] **Phase 36 — Occlusion v2: dithered fade for batched/instanced geometry + camera anti-clip** — 2026-07-26 (2 sessions: built, user-stopped mid-verification, resumed to green): A.5 now covers the WHOLE city — per-instance 4×4 Bayer screen-door fade (BatchedMesh colors-texture ALPHA texel / InstancedMesh `occFade` attr; zero new buffers/draw calls, alpha-restore vs USE_COLOR_ALPHA contamination) targeted by the DEV→prod-promoted clip index via 5 corner-aware boresight segments + 150 ms hysteresis + item-derived stable fade keys (never array positions); named/hero keep the material path w/ base-opacity-capture debt paid; anti-clip guard = second prod rig seam AFTER the polygon clamp (projection-not-delta, idempotent, growth-only slew, release = the rig's own lerp); resume session found+fixed TWO real see-through holes the first battery photographed — CN taper shaft absent from the index (eye rested INSIDE back-face-culled concrete → 3 tight taper-band AABBs via new heroes meta) and maxPullM 14 under-serving fat street-facing towers (44 eye-inside-Aura frames w/ near-plane slicing on a census drive → 25); census ×2 eyeInside 0/1072+0/725, battery 9/9 verdicts (strobe 1–3 transitions, pass cost ≈0.03–0.07 ms vs 0.2 budget, calls ≤80, BOTH fade channels proven), CN money shot = first photographed hero see-through; camera-wall precision gained: fat footprints (> 13.78 wu standoff) can't parked-occlude by geometry — banks fade only in drive-by transients; Rogers-dome + deeper-than-25 m residuals → P38; 2,909 tests, smoke 31/31, bench 82/150 (see phase-36-notes.md)
- [x] **Phase 37 — World edge: diegetic barriers + universal out-of-bounds auto-WRECKED** — 2026-07-26 (2 sessions: built + process died mid-battery unverdicted, resumed to green): barrier ring on all 11 land edges (worldEdge.ts pure walk: mitred inset segments at 6 wu — 0.5 on flush-ribbon edges, ONE fixed cuboid each + corner seals, kind 'barrier'; themes hoarding N / fence flanks / rail fold / notch cones via pack fence+cone batched + a 1-call merged procedural mesh; 19 dead-end "road closed" jersey rows w/ own colliders; south water edge OPEN by law, ring = a U w/ sealed corners); OOB backstop (outOfBounds.ts 10 Hz / 0.5 s sustain / once-per-mount → new leftWorld event → the enteredWater WRECKED path; silent fell-out teleport DELETED, water sensor 6→30 m ballistic envelope w/ new PLAYER-only filter killing a latent any-vehicle-drowns-the-player bug, resetCameraRig() into beginRun — every respawn path resets the rig); minimap ring restyle (hazard-orange U + blue water edge); resume session root-caused session 1's killer (battery clicked the TOUCH-ONLY gameover-retry-btn — desktop retry is the R key; 30 s locator timeouts read as a dead hang) and the battery's ONE real catch: 0.9-tall row colliders were CURB-HOPPED by the raycast vehicle (suspension rays ramp the chassis over — proven by creep/ram/drop probes) → row colliders now ring-height (3) under 0.9 visuals; battery 14/14 PASS 0 errors (rams bounce w/ zero out-frames & no falls, rowed streets stop AT the row face ~15-17 wu, forced OOB → GAMEOVER maxJump 0, retry camera-snap 13.7 wu, shore-drive survives the raised sensor, pursuit 40/40 inside); bench high 78/150 calls · 146.8k/300k tris · heapΔ0; smoke-with-live-dev-server false-failure mode documented; 2,970 tests, smoke 31/31 (see phase-37-notes.md)
- [x] **Phase 38 — Camera-debt sweep: re-evaluate crowns/skyline/wayfinding/see-through, evidence reel** — 2026-07-26 (2 sessions: battery ran + process died pre-notes, resumed): measured NDC verdicts via live-camera projection: P19 wayfinding + P23 skyline + P24 crowns all STILL IMPOSSIBLE under rig E (CN pod NDC-Y 5–13 at every distance 40–300 wu; zero rooflines from harbourfront/rail-lands/death-beat; all six bank crowns out of frame at every legal vantage) — P25 see-through FLIPPED + photographed (car through TD's dither at 0.35 opacity, the original "geometrically precluded" framing = the money frame); visible-band law derived (ground ≤ ~27–29 wu in play / ~59 death beat, NO sky/horizon EVER in frame) → verdict blocks filed into Ph 43/44/45/48/49/59/40 incl. the P59 re-scope discovery (a distant skyline ring would be invisible in every play frame — void fill must sit within ~25 wu of each edge); P36 residuals closed (cap-decline unreachable in play — Fairmont widest-diagonal probe pull 0; Rogers dome no-defect → P45 index filing; Aura inside-fade judged acceptable, not filed); P37 hoarding call: body #22322f→#446158 (2× luminance — stripe-only read fixed, after-shots at the exact battery vantages); doc sweep grep clean (P24 entry + generate.ts annotated, history preserved); venueDress audit confirmed; 2,970 tests, smoke 31/31, 0 errors; camera-debt ledger CLOSED (see phase-38-notes.md)

### Part 10 — Placement Integrity & Anti-Flicker (`.planning/part-10-placement-integrity.md`)
- [x] **Phase 39 — Z-fight audit + the ground-stack ladder (one ordered layering spec, migrated)** — 2026-07-26/27: `config/layering.ts` is LAW (GROUND_STACK 12 rungs ≥0.004 apart / WALL_STACK 4 ≥0.01 / placement-side SURFACE_ANCHOR; law test pins values + invariants, source-scan guard polices 8 producer files — extend its list for new producers); all 10 producers migrated, ZERO existing tests had pinned the old epsilons (why they drifted); all four audited collisions fixed + photographed before/after at identical vantages (torn-skid-on-rainbow money pair; searchlight pool was CLIPPED at the waterline, now washes onto the lake; manhole proud; construction decor anchored — floor-hole DROPPED, sunk-flush prototype proved an apertureless "hole" reads as nothing); polygonOffset A/B measured indistinguishable from the ladder at DPR 1 far range → NOT adopted, ladder primary, zero-prod-byte dev instrument kept for P42; draw-call Δ0, no goldens/colliders/XZ churned; 2,978 tests, smoke 31/31 (see phase-39-notes.md)
- [x] **Phase 40 — Global placement arbiter: one claim index for ALL placers + overlap invariant tests** — 2026-07-27 (2 sessions: build session killed by an API stall w/ T1 uncommitted; resume verified tree + finished): claimIndex.ts IS the arbiter (spatial-hash store, blocking/zone taxonomy, sanction rules = the ONE policy home) + worldContext/composeWorld composition root (TorontoScene's 7 placement memos → one call; camera clip volumes now PROJECT off the claims — ClipIndexSources deleted); all 7 audit gaps closed + regression-tested; sweep LIVE ×3 seeds — its first run found ~230-330 unsanctioned pairs/seed beyond the named gaps, every category traced & resolved (backdrop-behind-streetwall + corner mast/power-box SANCTIONED w/ recorded rationale; decor stand-in gates, fence-straddle gate lists, row-footprint-vs-cross-ribbon FIXED; 8 authored ribbon touches pinned exactly); arbiter also exposed 30/50 bus shelters embedded in the streetwall (flush-to-facade retune, photographed) + 10 backlot×tower interpenetrations (ablation-proven); goldens churned once w/ every delta attributed (claims 8,053 pinned); build ~99-120 ms vs 160 budget; bench 81/150 ×3 tiers, drive gate clean, 0 errors; 3,045 tests, smoke 31/31 (see phase-40-notes.md)
- [x] **Phase 41 — Surface & shimmer pass: seams, mipmap/aniso policy, thin-geometry distance behavior** — 2026-07-27 (3 sessions: build + first resume both stall-killed pre-commit; final session completed the battery): `config/surfaces.ts` = the SURFACE POLICY leaf (companion to layering.ts; measured frame 720p/DPR 1/**MSAA 4 on all three tiers**, pxPerWu ≈ 1046/d, THIN_GEOMETRY.minStripeWidthWu 0.3 law — dash/zebra/curb all PASS, P60 overhead wires 0.05–0.1 wu FAIL by construction → must ship as screen-width-clamped ribbons, law-tested; ATLAS_POLICY minification verdicts as code); route-board mip fix = the ONE real offender (~5× minified moving pixel-text strobed → generateMipmaps + NearestMipmapLinear, mag stays Nearest so the near homage look is untouched — stable "97 YONGE" vs scrambled before-blob); per-tier anisotropy 8/8/4 capability-capped via resolveAnisotropy (ground noise + mipped pack maps only; real-GPU-provisional); anchor derivations kill the P27 drift class (LAMP_OVERLAY.headAnchor = frac × manifest × scale, ROUTE_BOARD.busHeightWu = roofline + clearance; 7 pin tests, scratch-mutation proof 4/7 loud fails); curb seams audit-gated NO-CHANGE at re-pinned vantages (originals were fold-contaminated AND framed the closed side — geometry reasoning recorded); jitter matrix: stripes don't sparkle (≤0.117 % edge-only px, 0 % grazing, ×3 tiers); zero draw-call delta EXACT (spawn 72 calls/106,740 tris = P40 baseline; dash-far 72/107,794 before=after); bench ×3 green (82/150 · 82/120 · 79/90), drive gate 161.3 wu xDrift 0 hpΔ 0, 3,066 tests, smoke 31/31, 0 errors (see phase-41-notes.md)
- [x] **Phase 42 — Flicker hunt: auto-vantage sweep harness + two-frame flicker detector, fix stragglers** — 2026-07-27 (3 sessions; first two stall-killed): full 183-vantage sweep ×3 via new `--slice=i/8` chunking (the process rule that killed the priors); sweep A's triage found THE phase's one real z-fight — Chinatown gate post caps exactly coplanar with the lintel top (postTopY === lintel.y1, winner-swap at 9/9 toggles) — fixed in data + law-tested; 8 unmeasurable poses root-caused (street-END-node snaps onto the water-sensor seam / fold void corners) → 6 wu ground-safety clamp in the lattice (nudge-not-drop, all 183 ids kept, probe-derived: shore creep-roll kills at 2 wu, survives at 6); detector hardened on measured evidence: stage 4a edge-crawl gate (19× separation, positive control survives), stage 4b near-field stimulus parallax (bottom-edge + ≥40%-registered; kensington-class mid-frame defects protected by construction), hand-triage TRIAGED_BENIGN ledger (1 entry, region+radius-bounded — the class provably overlaps real z-fights at 37-50% residual, no threshold separates them), `--dumpFrames`; sweeps B+C both CLEAN 183/183 0 skips 0 hotspots (×2 = verdict-identical; raw counters vary sub-1% from wall-clock settle sensitivity — honest re-scope in notes, second-reset debt sketched); Part-10 closeout reel (8 montages + contact sheet, 2 evidence gaps documented not fabricated); gates: 3,130 tests, smoke 31/31, bench ×3 green, spawn identity 72/106,740 EXACT (see phase-42-notes.md). **PART 10 COMPLETE**

### Part 11 — Civic-Heart Landmarks (`.planning/part-11-civic-heart-landmarks.md`)
- [x] **Phase 43 — CN Tower v2: geometry (arched base, fluted shaft, real pod massing)** — 2026-07-27 (4 sessions; build+verify stall-killed pre-commit, closeout session finished the last gate): CN v2 shipped in place of the 266-tri v1 — 3 swept leg+rib fins w/ parabolic arch voids + modelled soffit (apex 0.14·h; legs merge 0.22·h researcher re-pin, §5 "bottom 8%" superseded w/ spec addendum), hex core 5-band taper w/ 15° roll (anti-coplanar at source), pod w/ mushroom flare / white radome / dark-glass + glass-floor strip / RECESSED red-white LED channel, re-proportioned SkyPod, 4-step needle + beacon stub; arch void faces the SE boresight by construction; 1,618 tris = deliberate re-pin 600→2,500, spawn identity 72 calls EXACT + 1,352-tri delta fully attributed; P44 hooks in meta (ringChannel/beaconTipY/ribAzimuths/archApexY) + vertex-probe test pattern; new `setDevCamPose` off-rig evidence instrument (DEV-gated read — P38's visible-band law makes on-rig silhouettes impossible); gates: 3,138 tests, build+smoke 31/31, bench ×3 OK (high 79/150 · 125.8k), flicker 183/183 ×8 slices 0 hotspots — closeout session found the prior session's "ALL GATES GREEN" premature (p43-1 aborted 14/22, slices 2–8 never ran) and completed the sweep to CLEAN before committing; pre-existing parked-dead-behind interior read filed → P44 w/ arch-void-escape candidate (see phase-43-notes.md)
- [x] **Phase 44 — CN Tower v2: lighting & night program (LED ring show, beacon) + wayfinding role** — 2026-07-27 (2 sessions: build died at the known turn-end trap mid-bench w/ implementation complete; resume re-ran all gates foreground): night program at **+0 draw calls** — single merged hero mesh, `onBeforeCompile` patch (spatial GLSL only) + `cnNightProgram.ts` pure CPU timing off `simNowMs()` (freeze-aware by construction), `aProgram`/`aProgramT` vertex attributes tagging RING/CREST/FLOOD/BEACON; seeded per-run mode (solid/pulse/chase) + 8-palette set (canon red/white weighted ~⅓, occasion palettes warm-adapted for blue hour) in `config/cnTower.ts`; beacon = needle stub + 4 pod-corner fixtures (+48 tris = the whole geometry delta) at 37.5 fpm double-flash inside the CAR 621 envelope (CN's own cadence unverifiable — stated not invented); blackout law STRUCTURAL (source-scan test w/ positive control: program files can never import powergrid — DARK CITY money pair photographed, dark skyline + lit tower); P43 parked-dead-behind debt CLOSED via `cnClipVolumes.ts` meta-derived tight cover (SE arch void stays OPEN; 12,992-pose 0.5 wu grid measured, 14 NW-patch residuals accepted under the P38 class); wayfinding = dev-minimap CN icon (corridor shots re-prove P38: tower never in frame on-rig); `cnProgram`/`setCnProgram` bridge + leva folder; gates: 3,223 tests (+85), spawn identity 72 calls EXACT / 108,140 tris (+48 attributed), bench ×3 green (high 83/150 · 141.8k), CN-adjacent flicker slice 7/7 CLEAN w/ program live, smoke 31/31, 0 errors (see phase-44-notes.md)
- [x] **Phase 45 — Rogers Centre v2 + rail-lands block: dome detail, jumbotron glow, Ripley's, Roundhouse** — 2026-07-27 (2 sessions: build session stall-killed AFTER the full battery ran — evidence was on disk; resume verified it + ran all gates): Rogers v2 240→1,342 tris (≤1,500 re-pin + >900 floor, spec §5 addendum): 6-band dome w/ proud seam lips, tinted+lifted retractable sector w/ leading-edge ribs + E/W track rails, 10-pier ring base w/ 5 program-lit gate bays, N-face Marriott window strip, S-face LED jumbotron (verified south = camera-visible), 2 helix ramps (homage, corners unverifiable); Rogers night program = the P44 CN architecture w/ own cache key at +0 draw calls, seeded colour-blocks, and a DELIBERATE policy fork test-locked both ways: Rogers DIMS with harbourfront (uDark lerp) while CN stays THE lit constant; P36/P38 dome-clip debt CLOSED via domeBands-inscribed covers — graze measured approach maxPull 0 / 0 Rogers-attributed eye-inside (the old TODO's feared false-positive dead); rail-lands block on the claimed strip (3 zone + 8 building + 5 prop claims, ClaimSource 'railLands'): faceted aquarium + fin sign, reduced-arc Roundhouse (4 deep overlapping chord colliders — drive-feel rule) w/ ⌀37 turntable, CN 6213-class locomotive, Steam Whistle bldg (atlas 7×3→8×3 append-only, credits 21→23) + string-light patio, ballast/tie dressing on TWO new GROUND_STACK rungs (coplanar-pair avoidance) w/ ladder re-pinned; spawn identity 76 calls / 110,752 tris EXACT attribution (+4 calls = the 4 rail-lands merged meshes; +2,612 tris = Rogers +1,102 + rail-lands +1,486 + 2 strip-displaced backlot boxes +24; goldens re-pinned once, −16 corridor scrub trees); 3,325 tests (+102), bench ×3 green (high 88/150 · 125.3k), Rogers-slice flicker 13/13 CLEAN w/ jumbotron live, jumbo freeze frames byte-identical, smoke 31/31, 0 errors (see phase-45-notes.md)
- [x] **Phase 46 — Union Station v2 + Front Street: colonnade, clock, GO shed + Royal York chateau roof** — 2026-07-27 (2 sessions: build stall-killed mid-T2 w/ T1 complete+tested on disk; resume verified tree, built T2, ran all gates): `namedGeometryBuilders` SEAM shipped (namedGeometry.ts render-plan contract: renderBoxes/lazy buildGeometry/signQuads/extraClaims/extraColliders; fallback STRUCTURAL — unregistered ids take the P24 path byte-identically, pinned) + shared bespoke-signage atlas (namedSignage.ts A–Z pixel font, P41 mipped-text law, ONE merged wordmark mesh = +1 call for every future landmark) + bespokeMesh.ts accum toolkit; **Union v2** (782 tris ≤900 w/ >500 floor): researched 22-column N colonnade + 4-column E wrap + 14-bay S pilaster rhythm, carved UNION STATION frieze, Great Hall attic to the EXACT data height over 0.8-height wing render boxes, full-length moat (paint on new GROUND_STACK.unionMoat 0.128 — FIRST rung ABOVE the raised sidewalk band, law re-pinned append-only) + visual-only balustrade (P37 curb-hop law), facade clock OMITTED (researcher: unverifiable — stated not invented); **GO shed** (180 tris ≤300) on the P45-reserved strip: cambered glass vault + angled pillars, own BUILDING collider (ram probe: creep stops AT the face, 12 s ram maxY 1.56 no launch/climb) + namedBuilding claim, rail-lands census exempts it BY ID; **Royal York v2** (158 tris ≤600 w/ >90 floor): mansard apron w/ EAVE-hugging dormer band (6 S + 4 E, backs rendered — open-shell see-through class caught in orchestrator review), sign drum w/ red neon ROYAL YORK (S+E), compact hip pavilion on a deck ring (measured twice on evidence: full-footprint summits at 6–19° shade as flat plates — pavilion-in-plan + slope/cap two-tone is what reads; steep-chateau-impossible truth recorded in-file, P19/P23-class); claims 8056→8058 (+moat/shed only, zero displacement — both land on already-vacated ground), clipVolumes +1; spawn identity **79 calls / 111,702 tris** EXACT (+3 calls = Union+RY bespoke meshes + THE sign mesh; +950 tris = 782+6+158+4); credits 23→25 (Fairmont Royal York, Union Station); gates: 3,398 tests (+73), bench ×3 (84/150·129.5k, 82/120·97.1k, 84/90·118.3k), Union/RY flicker slice CLEAN 7/7 ×2 (slice-A's single fire = the documented 16.28 px stage-3 settle-parallax class at a zero-P46-geometry vantage, triaged w/ frame dumps 91.4% explained), smoke 31/31, 0 console errors (see phase-46-notes.md)
- [x] **Phase 47 — City Hall twins + Nathan Phillips Square + Old City Hall + Osgoode Hall** — 2026-07-27/29 (2 sessions: build ran T0–T3 + the whole evidence battery then died mid-integration with 3 tests red; completion session diagnosed, finished the seam work, re-measured): the civic postcard shipped — **New City Hall** 1,516 tris (two segmented-arc crescents w/ concave lit-window bands + ribbed convex backs, saucer on its stem, podium; NPS = plaza + pale emissive rink + 3 Freedom Arches on the OCH axis + **3D block-letter TORONTO sign** w/ its own ring-height collider + flagpoles; square furniture-free BY CLAIM), **Old City Hall** 356 tris (RY pattern: body render box + copper-patina hips, off-centre clock tower to EXACT data height, 4 dials on all four faces w/ hands one rung proud, triple-arch porch), **Osgoode Hall** 294 tris (set-back pile + lawn + visual-only 1867 fence per P37) — every model inside cap AND above floor; `bespokeMesh` grew ARC primitives (first curved-PLAN landmark, kept out of private arithmetic); credits 25→28; ground ladder SPLICED not appended (civicPlaza 0.024/civicRink 0.028 below skid — appending atop would have buried skids + the searchlight pool, P39's own defect class), lawn reuses parkGround; **seam contract grew twice**: `renderBoxes` may be a footprint-matched SUBSEQUENCE (City Hall's 2 tower boxes DROPPED — a buried stub pad still costs a draw call) w/ explicit `renderBoxDataIndices` because array-position keys silently renamed the podium `#2`→`#0` and those keys are the facade seeds AND the P36 item-derived fade keys (+ mis-indexed CROWN decals), and `renderGroup` pools same-block landmarks into ONE mesh (law-tested ≤200 wu span — the fade-together trade is block-local); **THE PERF FINDING**: a 6-run clean-worktree ablation proved the low tier was ALREADY at 99.52% of its tri budget on untouched P46 (119,428/120,000) and that one bench run is not a pass/fail signal (same build measured 102,480 and 120,019 — fixed 60 s circuit, 500 ms sampling, SwiftShader), pre-culling P47 breached BOTH low gates (calls 92/90 in 2 of 4 runs, tris 121,862) → fixed by frustum-culling the named + bespoke landmark meshes (semantically invisible: conservative bounding-sphere reject, shadows cull against the light, raycast occlusion untouched; verified identical framing at the 2 widest poses) → **low 67–70/90 calls · 104.0–118.0k/120k tris over 4 runs, better than the P46 baseline on both**, high 95→72 calls, med 96→73; spawn identity 83→62 calls (pin re-based: now view-dependent) w/ the pre-culling +4 calls/+3,666 tris fully attributed; claims 8058→8081 (+23 attributed); 3,486 tests, smoke 31/31, civic flicker slice CLEAN 9/9 0 hotspots, drive-feel probes all PASS w/ square hpΔ0 proven traffic-off, 0 console errors; low-tier tri ceiling still tight at 98.3% → flagged to P72 (see phase-47-notes.md)
- [x] **Phase 48 — Financial-district crown pass: six bank silhouettes/materials + Hockey Hall of Fame** — 2026-08-02: six Bay Street banks retrofitted through the P46 seam via new `financialTowers.ts` (the seam's first MULTI-BUILDING module — one shared street-level vocabulary, six builders composing it) — 1,502 tris total for FCP/Scotia/TD/Commerce/RBC/CIBC, each ≤ its cap with a floor AND a pinned suite total; identity earned BELOW the eye line per P38 (podia, colonnades, entrances, pier/mullion rhythms, RBC's serration, CIBC's spandrel banding + park deck) with cheap crowns; TD SPLIT CALL = no second tower, the Mies 1-storey **banking pavilion** instead (the part of the complex the street meets), plus **Commerce Court North** (new `commerce-court-north` spec row + new `NAMED_SECONDARY_MASS_IDS` skip class — a secondary mass is data, not a code literal), both with extraClaim+extraCollider; new §4 material `steel_stainless` pays the debt commerce-court-west's own note recorded (two of six towers shared one fill); **Hockey Hall of Fame** 354 tris at the NW corner of Yonge×Front (arcaded 1885 banking hall + canted corner entrance + copper dome on a drum, NO league/team marks, credits 28→29); CROWN re-tune = NO-CHANGE with the reason recorded (P39 already consolidated `offsetWu`; P38 measured the band invisible) + a new keep-out law; **THE EVIDENCE CAUGHT WHAT THE TESTS COULDN'T** — dense articulation buried the §4 lit windows (blank white FCP, skinned Scotia/RBC sawtooth), fixed structurally by deriving facade rhythm from `WINDOW_PATTERN.columnPitchWu` (tris 2,058→1,502, −27%) under a new measured open-face law (≥0.5, computed from emitted triangles, reads 0.16/0.10 on the defect); P38 crown + skyline verdicts RE-MEASURED and unchanged (0/6 crowns, 0 rooflines); claims 8,081→8,076 fully attributed, spawn 62→63 calls/113,965 tris; 3,627 tests, bench ×3 ×3 tiers all green (low 66-67/90 · 88.8-112.9k/120k, better than the same-session pre-phase 117.3k worst), flicker slice CLEAN 6/6, drive-feel 4/4, smoke 31/31, 0 errors (see phase-48-notes.md)

**FEEL OVERHAUL (user directive 2026-08-04, governs Parts 17–20 — Phases 74–94):** the
map reads as Toronto but the game does not yet *play* like Smashy Road. Sixteen reported
items (traffic stacking + too dense to navigate, no mini-explosion damage pops, no
health-staged cube-smoke ladder, monster-truck handling, lifeless cars, poor pursuit
tracking, no reachable arrest, roads too narrow, no visible helicopter, getting stuck on
top of cars, plus new coin + health-pack pickups) and the headline ask: **"Smashy Road
still feels significantly better — figure out why. Dedicate 10 phases to this."** Master
plan + evidence-grounded diagnosis (D1–D8, each cited to file:line):
`.planning/feel-overhaul-overview.md`. Ten phases are tagged **⚑ SR-PARITY**
(74, 76, 77, 78, 81, 90, 91, 92, 93, 94) as the explicit answer. **"Double the roads"
means widen the EXISTING ribbons in place** (user clarification 2026-08-04) — no new
streets, no split carriageways, centrelines untouched.

**EXECUTION ORDER: Parts 17–20 (Phases 74–93) run NEXT — before Parts 12–16.** Content
detail on a game that does not feel good is unrecoverable spend, and P75's road widening +
P76's camera + P77's physics change the ground Parts 12–16 build on. Parts 12–16 keep their
existing numbers (Phases 49–73) — historic notes cite them by number (phase-38-notes.md
files verdicts into Ph 49 and Ph 59), so renumbering would corrupt the record — and resume
at Phase 49 after Phase 94. Overlap notes for their resumption are in the overview.

### Part 17 — Feel Parity Foundations (`.planning/part-17-feel-drive-model.md`)
- [!] **Phase 74 ⚑ — Feel lab: telemetry harness, Smashy Road reference analysis, the Feel Spec** — **USER GATE** — 2026-08-04: instrument shipped **with ZERO prod-file edits** (sha256 on all 3 `dist/assets/*.js` chunks IDENTICAL before/after — strictly stronger than P33's "chunk-grep-proven", which the survey found was never a committed gate): `dev/feelTelemetry.ts` (rAF sampler off `onImpact`'s prod-neutral seam + `playerRef`/`getDrivingInput`, every metric a time integral or physical quantity — never a frame count — stalled frames DISCARDED not clamped w/ self-reported `notes`), `dev/feelProbes.ts` (5 controlled manoeuvres, isolation echoed per result), `dev/feelDrives.ts` (4 district-derived routes), `dev/feelSpec.ts` (22-row oracle, 7 GATE, `evaluateFeelMetric` returns `insufficient-runs` below `minRunsForVerdict`), `scripts/feel-lab.mjs` (+`pnpm feel:lab`, `--slice=i/n`, per-slice results.json, contact sheets); reference research sourced+tagged (**14 unverifiable questions, almost no numbers** → every spec row carries `reference-verified`/`measured-baseline`/`design-target`) + 17-row gap table, each gap phase-owned; **THE INSTRUMENT DEFECT**: first battery read 26/27 stuck events "unrecoverable" 100% `building` — artefact, because the synthetic driver's unwedge (3.0 s) sat BEYOND the detector's verdict budget (1.5+1.0), so every wedge was unrecoverable *by construction*; control sweep 5/9/15 m/s → 5/5/6 events (flat in speed) isolated it; fixed → **26→4 (−85%) on identical routes+seed w/ zero game changes**, inequality now test-pinned; **TWO ERRORS IN MY OWN PLAN caught by implementers** (`durationSec` gate could never fail; `brakeDistM` ≥95% entry could never pass — governor×damping plateaus at 94%); baseline: `downtownDense` **92 m in 60 s at commanded 15 m/s**, `minorWeave` **30.7% airtime / 1.57 rad roll / 3 flips**, `chase3` **1.4 m/s mean w/ 7 pursuers + 12 unrecoverable stucks and no arrest ever fires** (D3 quantified), `spineCruise` clean control (454–581 m, 0 unrec); **turn radius NOT MEASURABLE** — @20 refused pre-flight (needs 8.6 m lateral > 8.5 m clear on the map's WIDEST ribbon; r=v/ω → 8.78 m @15, 11.71 m @20) ⇒ "turn radius becomes measurable" IS a P75 acceptance test; 3,970 tests (+343), bundle byte-identical, smoke 31/31 (1 flake, re-run clean), bench ×3 green (67/150·151.0k, 71/120·148.6k, 68/90·110.9k), 143 shots / 5 evidence trees, 0 errors (see phase-74-notes.md). **AWAITING USER:** sign off the Feel Spec (gate/watch split; the 3 response GATE targets deliberately left to P78); + 3 reference-vs-build calls (tank cap 3 vs our 2, tanker civilians, armed army heli)
- [x] **Phase 75 — Road expansion v2: double-width mains + grass medians + junction rebuild** — 2026-08-07: widths doubled all four classes (spine 22.0 / artery 19.8 / major 17.6 / minor 13.2, still `CAR_REF`-derived, zero literals) + 2.2 wu **visual-only** raised grass median on spine+arteries (per-street `optIn` wired for `major`, unused) + 136 sparse median trees (pitch DERIVED from the camera's visible ground band, so ≤1 tree in frame by construction); **THE CITY BECAME NAVIGABLE** — vs P74's own high-tier baseline, same routes/seed: `downtownDense` mean 1.6→**3.9 m/s** (path 92→200 m), `spineCruise` 8.2→**13.4** (489→791 m), `minorWeave` 3.4→**6.9** (195→397 m), **unrecoverable stucks 2+2→0 everywhere**, and minorWeave's **30.7 % airtime / 3 flips / 1.57 rad roll → 0/0/0.04** (contacts/min rose 14→27 but contacts *per metre* FELL 0.153→0.135 — more driving, not more crashing); `LANE_OFFSET_WU` re-derived to the carriageway centre w/ the 2.2 cap DELETED (it would have bound on every class, straddling the median while 8+ wu of new asphalt sat unused) + a lane-inside-ribbon/outside-median law; asphalt now emits as a class-ordered **UNION** (Bay/York overlap 7.88 wu — Bay's half-width alone exceeds the 7.52 wu gap so no override can separate them; already tangent −0.18 pre-phase = a 0.6-compaction artifact merely exposed) which also killed the pre-existing coplanar pair at all 73 intersections; **D11 new law: no two lane chains within one car width** (Bay/York put opposing chains 0.184 wu apart = P31's head-on deadlock reborn, fixed via `swallowedSpans`; worst cross-street now 25.5 wu = 11.6× the floor); junction rebuild (CROSSWALK.bandWu 2.2→**3.0**, P27's cut rationale inverted; traffic-light scale 1.0→**1.74** w/ the mast law made TWO-SIDED — it bounded reach only from above and passed trivially at 2× width — lamp anchor + post claim re-derived; `CityDress` mast collider off the full bbox → post half-width, killing ~3.6 wu of invisible diagonal wall at every signalized corner); 4 landmark `throw` guards fired for real — Osgoode root-fixed via a generalized **corner-pair `Frontage`** (+ 3 named buildings migrated: HHOF 3.50 / RY 2.73 / OCH 2.30 wu into ribbons, all the same "gap chosen off a ribbon edge but written as a centreline offset" bug); **FLICKER: 1 hotspot found, proven NEW vs a pre-phase worktree, root-caused to a curb strip losing its depth test to its own asphalt (0.006 wu decal = ~4-8 depth LSBs) — a LATENT PRE-PHASE defect (7 % spread before, 40.5 % after) that widening pushed past threshold; fixed by folding curb strips into the ribbon union at `ROAD_Y` (no epsilon touched) → 1.2 % spread, hot tiles 18(pre-phase)/258(broken)→**11**, better than baseline**; harness debts closed (flicker `EXPECTED_VANTAGE_COUNT` stale at 183 made *every* run exit 1 even at 0 hotspots; `money-dash-far` had LOST ITS SUBJECT — a curated dash-study anchor on the now-median spine, re-targeted onto Eglinton); land trade measured honestly — road area +93.6 %, buildable −**7.70 %** (my plan said −2.75 % from `polygon.ts`'s **stale pre-compaction area comment**, wrong by 2.7× since Part-8 — corrected in-file), frontage length −0.13 %, shipped streetwall FLAT at the cap but **raw supply −10.8 %**, re-pinned as a *measurement* + tripwire; goldens re-pinned ONCE, claims 8076→8182 fully attributed, arbiter sweep green ×3 seeds w/ **zero tolerances widened and zero new ribbon exceptions**; gates: 4,131 tests (+161), bench ×3 (high 73/150·152.2k, med 72/120·109.2k, **low 66/90·97,968/120k — materially better than P74's 110.9k**), flicker 4 slices/94 vantages CLEAN, smoke 31/31, eyeInside **0.0 %** at all 7 vantages before AND after, draw calls went DOWN (63→57, 63→58, 60→58), 0 console errors. **⚠ THE ONE ACCEPTANCE TEST THAT DID NOT PASS: turn radius is STILL not measurable** — the corridor DID open (±8.5→**±14.0 m** clear) and @20 progressed from *refusing before the car moved* to actually driving, but a steady full-lock circle at 20 m/s is grip-limited to ~40 m radius and needs ~80 m of corridor: **no street of any width can hold it**, and @5/@10 fail on settling/heuristics unrelated to geometry. The probe's DESIGN, not the map, is the binding constraint — and the quantity is already available from `stepSteer` (R = v/ω = **8.56 m at 15.5 m/s**). P78 should re-express the metric off `stepSteer` and re-pin the (already "provisional") Feel Spec rows (see phase-75-notes.md)
- [ ] **Phase 76 ⚑ — Camera v3: readability in the widened corridors** — **USER GATE**
- [ ] **Phase 77 ⚑ — Collision response v2: the player is never trapped by another vehicle**
- [ ] **Phase 78 ⚑ — Drive model v2: arcade response, grip, turn-in, brake, speed envelope**

### Part 18 — The Living, Navigable Street (`.planning/part-18-traffic-roads-street-life.md`)
- [ ] **Phase 79 — Traffic v3 bodies + density: fewer cars, dynamic-by-default, always shovable**
- [ ] **Phase 80 — Traffic v3 behaviour: brake, swerve, yield, honk, panic scatter**
- [ ] **Phase 81 ⚑ — Per-car feel re-grade + monster-truck rebuild**
- [ ] **Phase 82 — Intersections & curb life: signals that matter, turning traffic, ambient motion**
- [ ] **Phase 83 — Pickups: coins (score, no heat) + health packs (+10% of car max HP, rare)**
- [ ] **Phase 84 — Street gate: navigability battery + perf recert on the widened map**

### Part 19 — The Chase (`.planning/part-19-pursuit-arrest-chase.md`)
- [ ] **Phase 85 — Pursuit nav v3: committed tracking, interception, ram lines**
- [ ] **Phase 86 — Arrest v2: pin detection + a BUSTED that actually fires + arrest beat**
- [ ] **Phase 87 — Helicopter you can actually see: into the visible band, chase presence**
- [ ] **Phase 88 — Escalation & spawn geography: cops from ahead, roadblocks, pacing curve**
- [ ] **Phase 89 — Chase gate: full ★-ladder feel battery**

### Part 20 — Damage Language & Juice (`.planning/part-20-damage-language-juice.md`)
- [ ] **Phase 90 ⚑ — Cube-debris VFX core: the voxel-pop primitive on the existing pool**
- [ ] **Phase 91 ⚑ — Mini-explosion damage pops (visual-only) on every meaningful hit**
- [ ] **Phase 92 ⚑ — Smoke escalation ladder: black → red/black → yellow/orange/red/black (reversible)**
- [ ] **Phase 93 ⚑ — Impact juice: hit-stop, squash, shake, camera kick, audio layer**
- [ ] **Phase 94 ⚑ — Feel recertification + final gate** — **USER GATE**

---

**DEFERRED until after Phase 94** (see EXECUTION ORDER above) — Parts 12–16 below.

### Part 12 — Yonge Street & Culture Landmarks (`.planning/part-12-yonge-culture-landmarks.md`)
- [ ] **Phase 49 — Eaton Centre v2 glass galleria + Dundas (Sankofa) Square screen canyon v2**
- [ ] **Phase 50 — Yonge neon canyon: Massey Hall, Elgin/Winter Garden, marquees, blade signs, Sam's v2**
- [ ] **Phase 51 — East downtown: Gooderham Flatiron port, St Lawrence Market, Berczy fountain**
- [ ] **Phase 52 — U of T & Discovery District: Convocation Hall, University College, Robarts, legislature**
- [ ] **Phase 53 — Bloor edge: ROM crystal, Yorkville dressing, Honest Ed's nostalgia corner**
- [ ] **Phase 54 — North York centre: Mel Lastman Square v2, arts centre, Empress Walk, twins detail**

### Part 13 — Waterfront & Infrastructure (`.planning/part-13-waterfront-infrastructure.md`)
- [ ] **Phase 55 — Gardiner Expressway: elevated deck structure (columns + colliders, bents, rails)**
- [ ] **Phase 56 — Gardiner integration: underpass dressing/lighting, ramp stubs, audio zone**
- [ ] **Phase 57 — Rail corridor: berm/viaduct, street bridges, GO trains, signals, graffiti underpasses**
- [ ] **Phase 58 — Harbourfront: ferry terminal, animated ferries/boats, Redpath ship, Sugar Beach/HTO v2**
- [ ] **Phase 59 — Horizon fix: Toronto Islands + airport beacon + off-map skyline silhouette ring**

### Part 14 — Streets That Read Toronto (`.planning/part-14-toronto-streets.md`)
- [ ] **Phase 60 — Streetcar overhead wires + poles + track inlays on all 7 streetcar routes**
- [ ] **Phase 61 — TTC station entrances + signage on Line 1 + subway grates + Line 5 at Eglinton**
- [ ] **Phase 62 — Street furniture v2: TO bins, bike share, newspaper boxes, patios, rooftop dressing**
- [ ] **Phase 63 — Venue expansion east+west: ~20 new researched places, claim-engine dressed**
- [ ] **Phase 64 — Kensington & Chinatown deep pass: stalls, hanging signs, murals, garden car**
- [ ] **Phase 65 — District identity pass: per-district palette/signage/prop mixes**

### Part 15 — Motion & Ambient Life (`.planning/part-15-motion-ambient-life.md`)
- [ ] **Phase 66 — Traffic v2: taxi/delivery/food-truck variety, intersection behavior polish**
- [ ] **Phase 67 — Ambient motion: flags, steam vents, cranes, window-light schedules, planes**
- [ ] **Phase 68 — Wildlife: raccoon port + trash mini-events, gulls, squirrels (non-human only)**
- [ ] **Phase 69 — Sound of the city: district ambience beds, streetcar bell, TTC chime homage**

### Part 16 — Pack Expansion & Final Polish (`.planning/part-16-pack-polish-qa.md`)
- [ ] **Phase 70 — New asset pack ingestion (MegaKit + Kenney kits per research doc) + credits**
- [ ] **Phase 71 — Material/texture v2: facade variety, weathering, per-district palettes**
- [ ] **Phase 72 — Perf recertification: LOD/culling as needed, all-tier benches, mobile re-run**
- [ ] **Phase 73 — Final QA: full-map drive harness, flicker re-run, all launch gates, docs/handoff**

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
| Map | **Toronto thermometer polygon IS the shipped world** (since the Phase 32 flip, 2026-07-19; `config/worldSource.ts` WORLD_SOURCE='toronto'; compacted 1440×2724 wu per the 2026-07-18 density re-scope — numbers in `.planning/part-8-density-life-flip.md`). Legacy 64×64 is DE-IMPORTED from the game chunk (bundle-verified); its source/tests remain pending a user-approved `chore: legacy excision` |
| Brand logos (map layer) | **In** — user override 2026-07-17: real Toronto brands as 32×32 pixel-art homage decals (nearest-neighbour, mipmaps off, no photo logos); police/military stay generic; every brand gets an `assets/credits.json` entry with a trademark note |
| Pedestrians | **None** (vehicles + props only) |
| Backend | **None** — static site, `localStorage` only |
| Buildings | Indestructible fixed colliders in v1 |
| Assets | CC0-first (Kenney/Quaternius/Poly Pizza) + procedural fallback. **User override 2026-07-18:** player cars swap to city-pack models where a fit exists (default rusty car = pack `car-a`; monster truck, pursuit/military units, heroes/towers, streetcars stay in-house) — supersedes "playable cars stay in-house" in the CITY-PACK REAPPROACH block |
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
4. FULFILLED at Phase 32 (2026-07-19): `config/worldSource.ts` WORLD_SOURCE='toronto'
   ships the Toronto map; legacy world code is de-imported from the game chunk
   (bundle-verified). Legacy source + its tests remain in-repo until a user-approved
   `chore: legacy excision` pass. Never leave main with a broken game.

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
  Rogers ≤ 500, filler box ≤ 12 — **budgets rise deliberately in Parts 11–12** (e.g.
  CN v2 ≤ 2,500) per the overview's tri-budget addendum; re-pin, never silently.
- **Camera bearing: RE-LOCKED 2026-07-26**, with a SCHEDULED re-open at the **Phase 76
  USER GATE** (feel overhaul): Phase 75 doubles the road widths, which raises the
  corridor-airspace ceiling that *set* rig E — so the input to the P33/P34 decision
  changes and the user gets to pick again. Until that gate, rig E is law; no session may
  change the bearing without it. (Was briefly UNLOCKED 2026-07-26 for the
  Phase 33 USER GATE; Phase 34 adopted the pick as law): **yaw 45° / pitch 58° /
  baseDist 26 / FOV 38 — rig E**, `config/camera.ts`'s `CAMERA` block, superseding the
  pre-P34 45/50/24/45 rig (kept in `CAMERA_PRESETS` as historical preset 'A' for
  future re-comparisons, not as a fallback). Picked at the Phase 33 lab's USER GATE
  over four other candidates on the corridor-airspace measurement (the eye's
  horizontal radius must stay inside the dieted spine's street airspace, ≤ ~14.8 wu;
  E holds 13.78 at rest). The fixed-bearing MODEL itself was never in question and is
  unchanged (no player rotation control; the death-beat's yaw drift stays the sole
  exception): exactly two faces of every box are ever visible; CROWN/FASCIA decals go
  on those two faces only. Face pair **RE-DERIVED (not re-picked) at Phase 34**: yaw is
  unchanged from the old rig and the face set is a pure function of yaw alone (pitch
  only changes obliqueness) — **SOUTH + EAST CONFIRMED STANDING**, verified against
  every pinned site (namedBuildings.ts, venueDress.ts, frontage.ts, infill.ts,
  TorontoScene.tsx's SignBoard, routeBoardAtlas.ts). Height questions resolve at
  Phase 35's config-derived constants in `config/camera.ts`: **CAMERA_EYE_MIN_WU
  22.05 / CAMERA_EYE_MAX_WU 35.13** (eye-line law + the pinned crosser list =
  `world/toronto/heightLaw.test.ts`; ordinary streetwall stays under EYE_MIN via
  cityPackScale's STREETWALL_MAX_HEIGHT_WU cap). The "~13.8/15 wu visible ceiling"
  cited across P19–P25.7 notes is DEAD (a baseDist-18 relic) — never cite it, and do
  NOT confuse it with rig E's 13.78 wu **horizontal radius** (a different quantity,
  same coincidental digits).
- Logo decals: quads from the 32×32 pixel atlas, nearest-neighbour, mipmaps OFF.
- Occlusion — **v2 since Phase 36, city-wide**: batched/instanced geometry (pack
  streetwall, back lots, backdrop towers) fades per instance via a Bayer screen-door
  dither (opaque pass, zero extra draw calls), targeted by the now-production AABB clip
  index through 5 boresight segments + a 150 ms hysteresis hold; the ~18 named/hero
  meshes keep the material-opacity raycast path (A.5's ≤ 0.4-alpha/150 ms law holds on
  both, re-expressed as ≥ 0.35-coverage for the dither). A second prod-active rig seam
  (anti-clip, applied AFTER the polygon clamp) guarantees the eye never RESTS inside
  indexed volume (`CAMERA.antiClip`, maxPullM 25). Parked fades are geometrically
  possible only for solids THINNER than the eye's 13.78 wu standoff (CN's shaft, wall
  corners); fatter towers (all banks, Aura) occlude only transiently during drive-bys —
  that's guard territory, not fade territory. Residuals + evidence: phase-36-notes.md.

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
| Immersion overhaul master plan (Parts 9–16 arc + cross-cutting rules) | `.planning/immersion-overhaul-overview.md` |
| Feel overhaul master plan (Parts 17–20 arc + diagnosis D1–D8) | `.planning/feel-overhaul-overview.md` |
| Asset-pack licence survey (feeds Phase 70) | `.planning/asset-pack-research.md` |
| Session-authored phase plans | `.planning/phases/phase-NN-plan.md` |
| Session handoff notes | `.planning/phases/phase-NN-notes.md` |
| Templates | `.planning/templates/` |
| Autonomous multi-phase runner (for the sandbox devcontainer) | `.devcontainer/run-all-phases.sh` |

`.planning/` is gitignored (local workflow docs); `CLAUDE.md` and the TDD are committed.
