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
  // TDD §5.10 formula: damage = collisionK × impactSpeedProxy × otherMassFactor. STARTING
  // POINT (k=1) — retune live via the leva "DAMAGE" folder against real vehicle
  // masses/speeds once the contact spine (combat/contacts.ts) is feeding real numbers.
  collisionK: 1,
  // Below this impact-speed-proxy (m/s-equivalent — see forceToSpeedProxy below),
  // collisions deal zero damage ("love-taps are free", TDD §5.10). STARTING POINT.
  minImpactSpeed: 4,
  // combat/contacts.ts's ImpactRecord carries Rapier's summed contact-FORCE magnitude (N)
  // for the step, not a relative speed — there is no cheap way to recover true relative
  // speed from a solver-resolved force without per-body velocity history the spine doesn't
  // capture. Mapping used instead: impactSpeedProxy = forceMag / forceToSpeedProxy, fed
  // through the untouched k × speed × massFactor formula/threshold above (both written
  // against m/s). STARTING-POINT divisor (N per 1 m/s-equivalent unit) — retune live once
  // real contact-force numbers are observable in-game (leva "DAMAGE" folder); see
  // combat/damage.ts's computeDamage() doc comment for the consuming side of this mapping.
  forceToSpeedProxy: 250,
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
} as const;
