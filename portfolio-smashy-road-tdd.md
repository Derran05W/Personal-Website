# Technical Design Document — Portfolio Site with 3D "Smashy Road" Game

**Working title:** *Smashy the 6ix*
**Version:** 0.1 (draft for review)
**Owner:** [Your Name]
**Status:** Open questions in §16 need decisions before M1.

---

## 1. Summary

A personal portfolio website whose homepage **is** a playable, low-poly 3D driving/destruction game inspired by *Smashy Road: Wanted*. The player free-drives a finite Toronto-flavored city, smashing civilian cars, light posts, and transformers. Destruction raises a **Heat** metric that drives a 5-tier **Wanted** escalation — from regular police sedans up to tanks that fire physics-driven explosive shells — with tier-matched ambient helicopters. Destroying a district's transformer blacks out that section of the city.

A persistent site header (name, Resume, Portfolio, LinkedIn, GitHub) renders instantly, stays interactive while the game loads and plays, and the game pauses on `Esc`/`P`. Players pick from a garage of cars with different stats before each run.

---

## 2. Goals and Non-Goals

### Goals
- A portfolio homepage recruiters actually remember. The game must be *fun within 5 seconds* of gaining control.
- 60 fps on a mid-range laptop; playable (30 fps) on recent phones via quality tiers.
- Header and portfolio content usable **before and independently of** the game (the game is progressive enhancement, not a gate).
- Escalation that reads clearly: each wanted tier looks and feels meaner than the last.
- The blackout system as a signature "wow" feature.

### Non-Goals (v1)
- **Infinite world.** The map is finite by design (§5.4).
- **Pedestrians.** Vehicles and props only — keeps the tone cartoonish/recruiter-safe and saves an entire AI + animation system. (Matches the source game's vibe.)
- Multiplayer, accounts, backend leaderboards, monetization.
- Faithful Toronto reproduction. Landmarks are a stylized stretch layer (§13); v1 ships on generated city blocks.
- Destructible buildings (buildings are immovable bumpers in v1).

---

## 3. Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | **React + TypeScript + Vite** | Header/routes/menus are ordinary React; game canvas is a lazy-loaded route element. |
| 3D | **three.js** via **@react-three/fiber** + **drei** | Declarative scene graph, easy HUD/menu ↔ game state wiring. |
| Physics | **Rapier** via **@react-three/rapier** | WASM, fast, deterministic-ish, has a built-in **raycast vehicle controller** and collision event queue. |
| Game state | **zustand** | One store for game state machine + HUD-visible values; plain module state for hot per-frame data. |
| Audio | **howler.js** (+ three PositionalAudio for sirens) | Simple pooling, mobile unlock handling. |
| Assets | glTF (Draco-compressed via `gltf-transform`) | Single palette-texture workflow (§8). |
| Dev tuning | **leva** panel (dev builds only) | Live-tune every constant in §Appendix A. |
| Hosting | Vercel / Netlify / GitHub Pages | Static site; no server. |

**Alternatives considered:** vanilla three.js (smaller bundle, but hand-rolling UI↔game glue costs more than R3F adds); Babylon.js (heavier, no benefit here); cannon-es (simpler than Rapier but weaker performance and no vehicle controller). Rapier's vehicle controller is the main physics bet — fallback plan in §7 if it fights us.

---

## 4. Site Architecture

### 4.1 Routes and shell

```
/            → Home: game canvas fullscreen under header
/portfolio   → project grid (static content)
/resume      → embedded PDF + download button
LinkedIn / GitHub → external links in header
```

- The **app shell** (header + routes) is its own small bundle (< 150 KB gz) and paints immediately.
- The **game chunk** (three, rapier WASM, models, audio ≈ 2–3 MB) is `React.lazy` code-split and starts fetching on Home mount. The header is fully interactive during load — this is the mechanism that satisfies the "header usable while game loads" requirement, not a workaround.

### 4.2 Layering and input routing

- Canvas: `position: fixed; inset: 0; z-index: 0`. Header: `z-index: 50; pointer-events: auto`.
- Keyboard listeners attach only while game state is `PLAYING`; `Esc` and `P` toggle pause; header stays tabbable at all times.
- Auto-pause on: `visibilitychange` (tab hidden), window blur, and route change away from Home (game unmount persists run? No — run ends; simpler, and runs are short).

### 4.3 Load sequence

1. Shell paints (header + skyline placeholder / gradient).
2. Game chunk + WASM fetch with progress bar (drei `useProgress`).
3. Assets stream via a manifest loader; garage opens when critical assets are ready.
4. First user input starts audio context (browser autoplay rules).

---

## 5. Game Design

### 5.1 Core loop

Drive → smash stuff → Heat rises → wanted tier escalates → survive escalating pursuit → get **WRECKED** or **BUSTED** → score screen → retry / change car. Target run length: 1–4 minutes.

### 5.2 Controls

| Action | Desktop | Mobile |
|---|---|---|
| Steer / throttle | `WASD` / arrows | On-screen ◀ ▶ buttons, auto-throttle (Smashy-style) |
| Handbrake | `Space` | Brake button |
| Pause | `Esc` or `P` | ⏸ button |
| Restart (game over) | `R` | Tap button |
| Mute | `M` | Settings |

### 5.3 Camera

Fixed-yaw follow camera (no player rotation control — key to the Smashy look and to readability):
- Yaw locked at 45°, pitch ≈ 50°, base distance 18 m.
- Distance eases out +0–10 m with speed and +1.5 m per wanted tier (see more chaos as chaos grows).
- Position damped-lerp (t ≈ 0.08/frame @60), look-target leads 4 m along velocity.
- Camera shake impulse on big impacts and explosions (decaying noise, capped).

### 5.4 World

- **Size:** 64 × 64 tiles, 10 m per tile → **640 m × 640 m** playable. Big enough for multi-minute runs, small enough to fully instance and keep in memory.
- **Generation:** seeded RNG (seed shown on the score screen — makes runs shareable/reproducible). Arterial roads every 4–6 tiles in both axes; blocks filled from a weighted set: small buildings (1×1–2×2 tiles), mid towers (2×2, midtown-ish), parking lots (spawn parked-car props), parks (trees, benches), and **transformer lots** (§5.8).
- **Boundaries:** south edge is **lakefront** (water = instant WRECKED on entry — very Toronto); other three edges are highway barriers + fencing. No invisible walls; the edge is diegetic.
- **Traffic network:** roads form a node/edge graph; civilian cars follow it as kinematic bodies. Pursuit AI does **not** path on the graph — police steer physically and cut across lots/parks, which produces the authentic chaotic swarming.

### 5.5 Heat and Wanted levels

Heat is **monotonic** — it never decays (matches Smashy Road's one-way pressure; also means a visitor who just cruises politely is never hassled). Wanted level is a pure function of Heat.

**Heat events (initial values, all tunable):**

| Event | Heat |
|---|---|
| Light post / hydrant / mailbox / bench destroyed | +1 |
| Traffic light destroyed | +2 |
| Civilian car smashed (first big impact) | +5 |
| Civilian car wrecked (flipped/burning) | +8 |
| **Transformer destroyed (blackout)** | +12 |
| Police sedan wrecked | +25 |
| Armored unit wrecked | +40 |
| SWAT unit wrecked | +50 |
| Military gun truck wrecked | +60 |
| Tank wrecked | +100 |
| Passive, while wanted ≥ ★1 | +1 / sec |

**Wanted tiers:**

| Tier | Heat ≥ | New pursuers | Max concurrent (total) | Helicopter | Vibe |
|---|---|---|---|---|---|
| ★0 | 0 | — | 0 | — | Peaceful city |
| ★1 | 15 | Police sedans | 4 | — | Sirens in the distance |
| ★2 | 75 | + Armored police | 6 | **Police heli** | It's getting serious |
| ★3 | 180 | + SWAT SUVs | 8 | SWAT heli | Blacked-out convoys |
| ★4 | 350 | + Military gun trucks | 9 | Military heli | Live fire |
| ★5 | 600 | + Tanks | 10 (max 2 tanks) | Military heli ×2 | Shells and craters |

On tier-up: stinger audio, HUD stars flare, spawn director immediately fills the new cap from off-screen.

### 5.6 Enemy roster

Speeds are relative to the starter car's top speed (=100%). HP in abstract hit points; player collisions deal momentum-scaled damage (§5.10).

| Unit | HP | Mass | Top speed | Behavior | Special |
|---|---|---|---|---|---|
| **Police sedan** (4-door) | 40 | 1.0× | 105% | Pure pursuit + ram | Cheap, numerous, bouncy |
| **Armored police** | 90 | 1.6× | 90% | Pursuit + heavy ram | Visibly plated/geared; shrugs off light props; can shove the player |
| **SWAT SUV/truck** | 120 | 1.8× | 100% | **Flanking**: two units steer to ±30° offsets ahead of the player to box in; others ram | Blacked-out, aggressive; ram deals bonus damage |
| **Military gun truck** | 100 | 1.5× | 95% | **Standoff**: orbits at ~20 m; closes to ram only if player is slow/cornered | Turret gunner fires 3-round bursts: hitscan tracers, 3 dmg + 600 N impulse per hit, 2.5 s cooldown |
| **Tank** | 400 | 6.0× | 55% | Slow chase; turret tracks player (max 60°/s yaw) | Fires a shell every 5 s with a 0.8 s telegraph (barrel glow + laser dot). See below. |

**Tank shell & explosion physics** (the fun part):
- Shell = fast kinematic projectile (45 m/s, flat trajectory), detonates on any contact.
- Explosion: radius 8 m sphere query → apply radial impulse (20 kN at center, linear falloff) + damage (35 → 5 at edge) to **everything**: player, props, civilians, *and other pursuit units*. Friendly fire is intentional — tanks wrecking their own police cordon is emergent comedy and a pressure-release valve at ★5.
- FX: flash, smoke puff, scorch decal, camera shake, prop shrapnel (already-dynamic props get launched for free).

**AI implementation:** steering behaviors (seek/pursue, offset-seek for flankers, orbit for standoff) + 3 short forward raycasts for obstacle avoidance. Decisions tick at 10 Hz and are cached between ticks; forces apply every physics step. No navmesh in v1.

**Spawn director:** maintains per-tier caps; spawns on road tiles in a 60–90 m ring around the player (off-screen), despawns anything > 140 m away, recycles bodies via pooling.

### 5.7 Helicopters (ambient)

Pure atmosphere per requirements — no gameplay effect in v1.
- One heli per tier ≥ ★2 (police → SWAT → military livery; ★5 adds a second military heli).
- Behavior: orbit the player at 40 m radius, 35 m altitude, banked lean, looping rotor audio (distance-attenuated).
- **Searchlight:** a single real `SpotLight` from the heli tracking the player. Because the scene is evening-lit (§8), one spotlight buys enormous drama for one light's cost.
- Stretch: heli spotlights sweep and occasionally lose/reacquire you.

### 5.8 Power grid and blackouts (signature feature)

- The map is divided into a **4 × 4 district grid** (each district 16×16 tiles).
- Each district contains **one transformer prop** (30 HP, fenced corner lot, hum SFX, warning signage) plus a registry of its **emitters**: every streetlight, traffic light, and building-window emissive group inside the district.
- **On transformer destruction:** 0.6 s flicker across the district → all registered emitters switch off; spark particle burst + electrical zap SFX; +12 Heat. Blackout is **permanent for the run** (v1; timed repair crews are a stretch flourish).
- **Implementation:** streetlights/buildings are `InstancedMesh` archetypes with a per-instance `emissiveOn` attribute; a blackout writes one buffer range per archetype — effectively free. Real dynamic lights are a small pool (4–6 `PointLight`s) assigned to the nearest *lit* emitters around the player; blacked-out districts simply never receive pool lights.
- **Easter egg:** all 16 districts dark → "**DARK CITY**" banner, ambience swaps to crickets + distant sirens.

> **Design dependency:** blackouts only *read* if the baseline scene is dark enough to notice lights. This forces the time-of-day decision in §8 — recommended: permanent early-evening "blue hour."

### 5.9 Player vehicles and garage

Garage screen before the first run and reachable from pause/game-over. Stats shown as bars. Unlocks via lifetime score milestones persisted in `localStorage` (generous thresholds — respect visitors' time; a recruiter should see 2–3 unlocks in one sitting).

| Car | Speed | Accel | Handling | HP | Mass | Character |
|---|---|---|---|---|---|---|
| **Rusty Sedan** (starter) | C | C | B | 100 | 1.0× | Honest, balanced |
| **Street Racer** | A | A | A | 60 | 0.8× | Glass cannon — outrun everything, die to one tank shell |
| **Pickup** | B | C | C | 130 | 1.4× | Good pusher, stable |
| **School Bus** | D | D | D | 220 | 2.6× | Wrecking ball; smashes props without slowing |
| **Monster Truck** | C | B | C | 180 | 2.2× | Rides over civilian cars (crush = auto-wreck them) |
| **Red Rocket** (streetcar, free-driving) | C | D | D | 260 | 3.0× | Absurd Toronto joke unlock; huge, nearly unstoppable, turns like a boat |

All six are simple enough to build procedurally from boxes if external assets disappoint (§8.3).

### 5.10 Damage, game over, scoring

- **Damage model:** collision damage = `k × relative_speed × other_mass_factor`, thresholded so love-taps are free. Bullets 3, shells 35→5. Water = instant wreck. No regen.
- **Visual state:** smoke at < 50% HP, fire at < 25%, panels darken (material tint).
- **WRECKED:** HP → 0. Brief slow-mo + camera pull-back.
- **BUSTED:** speed < 1 m/s for 3 s while ≥ 3 pursuit units are within 8 m → busted cinematic (units converge, red/blue wash). Cheap to build, hugely characterful.
- **Score:** `Σ heat events` + risk bonus of `5 × current_tier` per second while ≥ ★1. Score screen shows score, best, tier reached, unlock progress, map seed, `R` retry / `G` garage.

---

## 6. Systems Architecture

```
src/
  app/            # shell: header, routes, portfolio, resume
  game/
    index.tsx     # lazy entry, <Canvas>, providers
    state/        # zustand store: machine, heat, score, settings
    config/       # ALL tunables from this doc live here (single source of truth)
    world/        # seeded generator, districts, traffic graph, instancing
    vehicles/     # player controller, car definitions
    ai/           # steering, spawn director, unit definitions
    combat/       # damage resolver, projectiles, explosions
    powergrid/    # districts, transformer logic, emitter registry, light pool
    fx/           # particles, decals, camera shake
    audio/        # howler manager, positional sirens
    hud/          # React HUD components reading the store
```

- **State machine:** `BOOT → LOADING → GARAGE → PLAYING ⇄ PAUSED → GAMEOVER → (GARAGE | PLAYING)`.
- **Frame order:** input → AI tick (10 Hz, cached) → fixed-step physics (60 Hz, interpolated render) → drain Rapier contact-event queue → damage/heat resolvers → FX/audio → render.
- **Not a full ECS.** Entity archetypes as R3F components + plain systems; a lightweight registry maps rigid-body handles → entity metadata for contact resolution. Rationale: team of one, debuggability beats purity.
- **Events:** tiny emitter for `heatChanged`, `tierChanged`, `transformerDestroyed`, `unitWrecked`, `playerWrecked`, `busted` — HUD, audio, and FX subscribe; systems stay decoupled.

---

## 7. Physics Design (Rapier)

- Fixed timestep 1/60 s, render interpolation on.
- **Player + pursuit vehicles:** Rapier's `DynamicRayCastVehicleController` (4-wheel raycast suspension) tuned arcade — stiff suspension, generous friction slip, high angular damping, mild downforce. **Decision gate at M1:** if the controller can't be made to feel "toy-car bouncy," fall back to the *arcade box* model (rigid body + direct force/torque steering + fake wheel visuals). Both are behind one `IVehicleModel` interface so the swap is contained.
- **Collision groups:** `PLAYER, PURSUIT, CIVILIAN, PROP_STATIC, PROP_DYNAMIC, BUILDING, PROJECTILE, GROUND, WATER(sensor)` — bitmask table lives in `config/collision.ts`. (E.g., projectiles ignore other projectiles; water only senses vehicles.)
- **Props (posts, hydrants, transformers, benches, parked cars):** spawned as `fixed` colliders (zero sim cost). On an impact impulse above threshold → swapped to dynamic with the impact impulse inherited (the classic "everything is nailed down until you hit it" trick). Dynamic props auto-sleep, despawn after 20 s, and live in a pool capped at ~60.
- **Civilian cars:** kinematic followers on the traffic graph until hit → converted to dynamic, tagged wrecked when flipped or HP-zeroed.
- **Buildings:** fixed cuboid colliders, indestructible.
- Perf: rely on body sleeping, cap active dynamic bodies (§10), keep colliders convex primitives only (cuboids/capsules — no trimeshes at runtime).

---

## 8. Rendering, Art Direction, and Assets

### 8.1 Direction
Low-poly, flat-shaded, chunky proportions, saturated palette — the Crossy/Smashy family look. It's cheap to render, cheap to author, and hides the fact that a solo dev made the art.

**Time of day: permanent early-evening "blue hour."** This is a design decision, not a style whim — streetlights and lit windows must be visible for the blackout feature to land, and headlights/sirens/heli searchlight all get free drama. (Full day-night cycle = stretch.)

### 8.2 Lighting & rendering plan
- One directional "dusk" light with a tight 60 m shadow frustum following the player; hemisphere ambient; pooled point lights (§5.8); one heli spotlight.
- **Instancing everywhere:** buildings, streetlights, trees, parked cars, props per-archetype `InstancedMesh` with per-instance color + emissive attributes. Target < 150 draw calls total.
- Materials: `MeshLambert/Standard` with a single **palette texture** (tiny gradient atlas; every mesh UV-mapped to palette cells) → one shared material, instancing-friendly, zero texture memory pressure.
- Post-processing: none in v1 (CSS vignette if desired). Selective bloom on emissives = desktop-only stretch.

### 8.3 Where the models come from (answering the open question directly)

| Source | License | Use for |
|---|---|---|
| **Kenney.nl** — *Car Kit*, *City Kit* (roads/commercial/suburban) | CC0 | Civilian cars, roads, buildings, props. Closest ready-made match to the Smashy aesthetic. Also has CC0 audio + UI packs. |
| **Quaternius** packs | CC0 | Additional low-poly vehicles incl. military-flavored ones, building variety. |
| **Poly Pizza** (search aggregator) | CC0 / CC-BY (filter!) | Gap-filling: tank, helicopter, transformer. Credit CC-BY items on an `/credits` page. |
| **Sketchfab** (license-filtered) | CC0 / CC-BY | Last resort for specific gaps; verify license per item. |
| **Procedural (Claude-generated code)** | ours | Fallback + customs: every vehicle in §5.9 can be composed from boxes/cylinders in code, and **CN Tower is genuinely easiest to build procedurally** (cylinder stack + pod + antenna). Claude can also supply Blender-Python scripts for anything bespoke. |

**Decision at M2:** external kits vs. all-procedural for v1 vehicles. Recommendation: Kenney kit for civilians/city, procedural for the six player cars and the military tier (guarantees a consistent silhouette language and zero licensing anxiety).

**Pipeline:** source → Blender (1 unit = 1 m, Y-up export) → glTF → `gltf-transform optimize` (weld, prune, Draco) → typed manifest loader. No real-world logos or wordmarks anywhere (plain red/white streetcar, generic "POLICE") — stylized landmark *shapes* are fine, trademarks are not.

---

## 9. UI / UX

- **Header:** fixed 64 px bar; name left; right side: Resume, Portfolio, LinkedIn, GitHub (icon links). Subtle backdrop blur so it sits legibly over the game. Interactive from first paint (§4).
- **HUD:** wanted stars top-right (flare on tier-up), score top-center, HP as a car-silhouette fill bottom-left, control hints fade after 8 s of play.
- **Menus:** Garage (car cards + stat bars + lock states), Pause (Resume / Restart / Garage / Mute / Quality), Game Over (§5.10).
- **Pause triggers:** `Esc`, `P`, pause button, tab hidden, window blur, route change.
- **Mobile v1:** playable-basic — left/right + brake buttons, auto-throttle, low quality tier, DPR capped at 1.5. If WebGL2 is unavailable: static skyline hero + header links (graceful degrade).
- **Accessibility:** `prefers-reduced-motion` → don't auto-start; show a "Play" card and a static hero instead. All portfolio content reachable without playing. Header fully keyboard-navigable; canvas gets an `aria-label`; skip-to-content link.
- **SEO:** portfolio/resume routes prerendered with meta/OG tags; the game is enhancement, never the only path to content.

---

## 10. Performance Budgets and Quality Tiers

| Budget | Desktop (high) | Laptop (med) | Mobile (low) |
|---|---|---|---|
| Target FPS | 60 | 60 | 30 |
| Draw calls | < 150 | < 120 | < 90 |
| Triangles on screen | < 300 k | < 200 k | < 120 k |
| Active dynamic bodies | 120 | 90 | 60 |
| Pursuit cap modifier | 100% | 100% | 70% |
| Shadows | on (2048) | on (1024) | off |
| DPR cap | 2.0 | 1.5 | 1.5 |

Tier chosen by a 2-second FPS probe on first load + `hardwareConcurrency` hint; user-overridable in Pause → Quality. Bundle: shell < 150 KB gz; lazy game chunk ≈ 2–3 MB (Rapier WASM + Draco'd models + core audio).

---

## 11. Audio

- **Sources:** Kenney audio packs (CC0), freesound.org (filter CC0).
- **Channels:** engine loop (pitch ∝ speed), pooled impact hits (velocity-scaled, max 6 concurrent), positional sirens (cap 3 audible, nearest pursuers), heli rotor, gunfire, shell + explosion, transformer hum → zap → district power-down *whoomp*, evening ambience (→ crickets on Dark City).
- Music: intensity layers per wanted tier — stretch.
- Autoplay policy: audio context unlocks on first input; global mute (`M`) persisted.

---

## 12. Persistence

`localStorage` only, no backend:

| Key | Value |
|---|---|
| `bestScore` | number |
| `lifetimeScore` | number (drives unlocks) |
| `unlockedCarIds` | string[] |
| `settings` | { quality, muted } |
| `lastSeed` | number |

Optional later: tiny Supabase leaderboard — explicitly out of scope for v1.

---

## 13. Toronto Landmark Layer (Stretch — after M8)

Reserved slots in the generator, all stylized low-poly, no trademarks:

- **CN Tower + stadium** at the lakefront, south-center. The tower doubles as a **wayfinding landmark** visible from everywhere — it earns its polygons.
- **Kensington block:** one district of narrow, mismatched, colorful low buildings + market props.
- **Midtown cluster:** a district of taller instanced towers (density change reads as "midtown" for free).
- **Flatiron wedge** building at one angled intersection.
- **Streetcars** as heavy civilian traffic on two avenues (and the *Red Rocket* garage unlock, §5.9).
- **Raccoon + tipped garbage can** prop set. Non-negotiable.

---

## 14. Milestones

Each milestone ends deployed and playable. M1 is the **fun gate** — do not proceed past it until driving on an empty plane already feels good.

| M | Deliverable | Acceptance |
|---|---|---|
| **M0** | Shell: header, routes, resume/portfolio stubs, deploy pipeline | Instant paint, links work, Lighthouse ≥ 95 |
| **M1** | Driving prototype: player car, camera, physics on gray plane | *"I drove around for 2 minutes for no reason"* |
| **M2** | City gen: roads, instanced buildings, props, boundaries, lakefront | 60 fps with full map; props go flying |
| **M3** | Civilian traffic + heat/score + HUD | Smashing feels rewarding; heat numbers tune-able live |
| **M4** | ★1 police + WRECKED/BUSTED + game over loop | A full run start→death→retry works |
| **M5** | Tiers ★2–★5: armored, SWAT flanking, gun trucks, tanks + shells/explosions | Escalation readable; tank friendly-fire chaos works |
| **M6** | Power grid: transformers, district blackouts, light pool, Dark City | Blackout visibly darkens a district at range |
| **M7** | Helicopters, audio pass, particles/decals, camera shake | "Juice" pass complete |
| **M8** | Garage, unlocks, persistence, mobile controls, quality tiers | Playable on a phone; unlocks persist |
| **M9** | Toronto landmarks + evening lighting polish | CN Tower visible map-wide |
| **M10** | Portfolio/resume real content, SEO, analytics, credits page, launch | Ship it |

Rough sizing: each M ≈ 1–2 focused weekends; M5 is the largest.

---

## 15. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Vehicle feel never gets fun | M1 fun-gate; leva live-tuning; prepared fallback from Rapier vehicle controller to arcade-box model (§7) |
| Mobile performance | Quality tiers, instancing, hard entity caps, DPR cap, shadow off |
| Rapier vehicle controller quirks | `IVehicleModel` interface isolates the swap |
| Asset licensing surprises | CC0-first policy; `/credits` page; procedural fallback for every vehicle |
| Landmark scope creep | Landmarks strictly gated behind M8 |
| Blackouts invisible in daylight | Locked evening lighting decision (§8.1) |
| WebGL context loss / no WebGL2 | Context-restore handler; static hero fallback |
| Browser audio autoplay | Unlock on first input; game is silent-safe |

---

## 16. Open Questions (need your call before/at the flagged milestone)

1. **Time of day** — permanent blue-hour evening (recommended) vs. day-night cycle? *(blocks M2 art)*
2. **Heat decay** — never (recommended, Smashy-authentic) vs. slow decay while unseen? *(M3)*
3. **BUSTED mechanic** — in (recommended) or wrecked-only? *(M4)*
4. **Unlock model** — score milestones (recommended) vs. everything unlocked? *(M8)*
5. **Mobile** — playable-basic in v1 (recommended) vs. static fallback first, controls later? *(M8)*
6. **Branding** — your name/wordmark for the header; keep *Smashy the 6ix* as the game's title? *(M0)*

---

## Appendix A — Tunables sketch (`game/config/`)

Everything numeric in this document lives in typed config, editable at runtime via leva in dev builds:

```ts
export const HEAT = {
  events: { lightPost: 1, trafficLight: 2, civHit: 5, civWreck: 8,
            transformer: 12, policeWreck: 25, armoredWreck: 40,
            swatWreck: 50, gunTruckWreck: 60, tankWreck: 100 },
  passivePerSec: 1, // only while tier >= 1
  tierThresholds: [0, 15, 75, 180, 350, 600],
} as const;

export const SPAWN = {
  caps: [0, 4, 6, 8, 9, 10], maxTanks: 2,
  ringMin: 60, ringMax: 90, despawnAt: 140, aiTickHz: 10,
} as const;

export const TANK = {
  shellSpeed: 45, fireCooldown: 5, telegraphSec: 0.8,
  blast: { radius: 8, impulse: 20_000, dmgCenter: 35, dmgEdge: 5 },
} as const;

export const CAMERA = { yawDeg: 45, pitchDeg: 50, baseDist: 18,
  speedZoom: 10, tierZoom: 1.5, lerp: 0.08, lookAhead: 4 } as const;

export const WORLD = { tiles: 64, tileSize: 10, districts: 4,
  arterialEvery: [4, 6] } as const;
```

---

*End of document. Next artifact after sign-off: M0–M1 repo scaffold.*
