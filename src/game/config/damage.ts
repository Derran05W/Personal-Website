// Damage, busted, and game-over tunables. TDD §5.10.
import type { ArchetypeName } from '../world/archetypes';
import { VEHICLE_TUNING } from './vehicles';

// Per-archetype masses (kg) consumed ONLY by combat/damage.ts's massFactorOf() to derive
// the "other side's mass factor" in the TDD §5.10 formula below — a damage-model-local
// table, not a physics-simulation one. Values are phase-06-plan.md's Decisions-table
// proposal (mailbox 30 · bench 60 · hydrant 90 · streetlight 120 · trafficLight 150 ·
// tree 200 · fenceSegment 40 · transformerBox 400 · parkedCar 1200). world/propDynamics.ts
// (Phase 6 Task 2) defines its own physical masses for the dynamic-body pool; if the two
// ever diverge, reconciling them into one source of truth is a follow-up integration item
// (phase-06-notes.md). Archetypes absent here (buildings, anything unlisted) — and every
// non-prop entity (pursuit/civilian units, not modeled yet) — fall back to massFactor 1.
const ARCHETYPE_MASS_KG: Partial<Record<ArchetypeName, number>> = {
  mailbox: 30,
  bench: 60,
  hydrant: 90,
  streetlight: 120,
  trafficLight: 150,
  tree: 200,
  fenceSegment: 40,
  transformerBox: 400,
  parkedCar: 1200,
};

export const DAMAGE = {
  // TDD §5.10 formula: damage = collisionK × impactSpeedProxy × otherMassFactor.
  // Phase 9 retune (combat/runLoop.ts's live driving battery — see phase-09-notes.md for
  // the measured before/after table): 1 was a leftover Phase-6 placeholder that, combined
  // with the equally-wrong forceToSpeedProxy below, made a single moderate-speed impact
  // (~5 m/s into a building) drain the FULL 100 hp bar in one physics step. 1.2 keeps the
  // formula's shape but lands a genuine full-speed (~25 m/s) square building hit in the
  // TDD-adjacent 25-35 hp band once forceToSpeedProxy is corrected (see below).
  collisionK: 1.2,
  // Below this impact-speed-proxy (m/s-equivalent — see forceToSpeedProxy below),
  // collisions deal zero damage ("love-taps are free", TDD §5.10). Phase 9 retune: raised
  // 4 -> 5 (small margin above the corrected proxy's now-realistic m/s scale) specifically
  // so a glancing/low-angle building scrape or a moderate-speed prop clip reads as free,
  // per phase-09-plan.md's Decision ("raise minImpactSpeed so building scrapes at low
  // angle are free") — see combat/damage.ts's computeDamage() for the strict "<" cutoff.
  minImpactSpeed: 5,
  // combat/contacts.ts's ImpactRecord carries Rapier's summed contact-FORCE magnitude (N)
  // for the step, not a relative speed — there is no cheap way to recover true relative
  // speed from a solver-resolved force without per-body velocity history the spine doesn't
  // capture. Mapping used instead: impactSpeedProxy = forceMag / forceToSpeedProxy, fed
  // through the untouched k × speed × massFactor formula/threshold above (both written
  // against m/s).
  //
  // Phase 9 retune: the Phase 6 placeholder (250) was ~500x too small. A rigid-body stop
  // against a `fixed` collider resolves in one physics step, so forceMag empirically tracks
  // ~playerMassKg × Δv × (1/timeStep) — i.e. proportional to the CAR's mass and the fixed
  // timestep, not a small constant. Live-measured on the real dev build (chromium,
  // debugBridge.recentImpacts + readState().speed at the moment of impact — see
  // phase-09-notes.md for the full before/after table): a clean single-step building hit
  // at 4.88 m/s read forceMag ≈ 622,337 N (≈127,500 N per m/s of closing speed). This
  // divisor is chosen so impactSpeedProxy lands close to that REAL closing speed in m/s
  // (622,337 / 125,000 ≈ 4.98, matching the measured 4.88 m/s) — i.e. the "proxy" is no
  // longer a fictional unit, it's approximately the actual relative speed, which is what
  // makes `minImpactSpeed` above and the collisionK retune both mean what their names say.
  // This single correction is also what fixes the Phase 8 "sustained wedge" failure mode
  // (a car pinned against an obstacle/prop/civilian reads LOW closing speed every
  // subsequent step once it stops actually gaining speed, which now correctly falls below
  // minImpactSpeed instead of re-dealing near-fatal damage every physics step forever).
  forceToSpeedProxy: 125_000,
  // Separate proxy for DYNAMIC-vs-DYNAMIC vehicle pairs (player <-> pursuit units).
  // Rapier's contact forces for two yielding dynamic bodies read ~10x lower than
  // against kinematic civilians or fixed buildings (the other body gives way), so the
  // global proxy above maps real unit rams (~30k-150k N measured, Phase 9 Task 2) to a
  // sub-threshold speed proxy and rams would deal 0. 12_000 puts a solid ram at ~
  // 12-15 hp (TDD "sedan ram" band 10-18) and leaves light nudges under the threshold.
  vehicleRamForceProxy: 12_000,
  // Reference mass (kg) massFactor is normalized against — mirrors the player chassis mass
  // (config/vehicles.ts VEHICLE_TUNING.chassis.massKg), imported rather than duplicated so
  // a chassis retune can't silently desync the damage model. The player's own massFactor is
  // therefore always exactly 1 (it IS the reference) — see combat/damage.ts massFactorOf().
  referenceMassKg: VEHICLE_TUNING.chassis.massKg,
  archetypeMassKg: ARCHETYPE_MASS_KG,
  // Impact force (N) above which the damage resolver adds camera shake trauma
  // (fx/cameraRig.addShake, which already caps at CAMERA.shake.maxAmplitude — no separate
  // cap needed here). STARTING POINT, live-tunable.
  shakeForceThreshold: 800,
  // Trauma (m of peak jitter) added per Newton above the threshold: addShake(forceMag ×
  // shakeForceScale). STARTING POINT, live-tunable.
  shakeForceScale: 0.0006,
  // Dark tint applied to a transformer's InstancedMesh instance on death
  // (world/instancing.ts setColorAt) — the "wrecked" visual signal ahead of the real Phase
  // 16 spark/scorch FX. Hex string (leva's auto-schema builder skips non-numeric leaves,
  // same convention as fx.ts SKID.colors — tune this one in code).
  deadTransformerColor: '#141414',
  // Hitscan bullet damage (gun truck bursts). TDD §5.10 / §5.6.
  bulletDamage: 3,
  // Visual HP thresholds: smoke below 50% HP, fire below 25% HP. TDD §5.10.
  smokeBelowHpFrac: 0.5,
  fireBelowHpFrac: 0.25,
  // Water = instant wreck (TDD §5.10) — no magnitude needed, handled as a special case
  // by the damage resolver, not a numeric tunable.
  //
  // Phase 9 (combat/runLoop.ts): seconds between a WRECKED trigger (playerHp<=0, or
  // enteredWater) and the actual PLAYING->GAMEOVER transition. TDD §5.10 calls for
  // "brief slow-mo + camera pull-back" on WRECKED; slow-mo is CUT for this phase
  // (phase-09-plan.md Decisions — timestep scaling vs. the raycast controller is exactly
  // the burst-fragility family Phase 6 closed), so this window is spent on control-lock +
  // camera pull-back only (fx/cameraRig.ts's setDeathPullback). STARTING POINT, tunable.
  wreckedLockSec: 1.2,
} as const;

export const BUSTED = {
  // Player speed must stay below this (m/s) ...
  maxSpeed: 1,
  // ...for this many seconds ...
  holdSec: 3,
  // ...while at least this many pursuit units ...
  minPursuers: 3,
  // ...are within this radius (m) of the player. TDD §5.10.
  pursuerRadius: 8,
  // Phase 9 (combat/runLoop.ts): seconds between a BUSTED trigger and the
  // PLAYING->GAMEOVER transition — same lock-then-transition pattern as
  // DAMAGE.wreckedLockSec (kept as its own field since the two are independently
  // tunable even though they share the same TDD-implied starting value). TDD §5.10's
  // "busted cinematic" (units converge, red/blue wash) plays during this window.
  lockSec: 1.2,
} as const;
