// Damage resolver (Phase 6 Task 3; TDD §5.10). Subscribes to combat/contacts.ts's onImpact
// feed and turns resolved ImpactRecords into HP loss, death events, a wrecked-transformer
// visual, and camera shake. Pure math lives in computeDamage() (fully unit-testable, no
// imports); everything else is a thin, also-directly-testable resolver over the entity
// registry (world/registry.ts — EntityEntry.hp is mutated in place, the documented pattern)
// and the zustand store (player HP, which has no registry entry of its own).
//
// --- force → damage mapping (see config/damage.ts for the tunables) -----------------------
// ImpactRecord.forceMag is Rapier's contact-force magnitude (N), not a relative speed, so
// computeDamage() first divides it by DAMAGE.forceToSpeedProxy to get an "impact speed
// proxy" (m/s-equivalent), then runs the TDD §5.10 formula (damage = k × speed ×
// otherMassFactor) unchanged against that proxy, thresholded by DAMAGE.minImpactSpeed so
// love-taps are free. Both constants are STARTING POINTS, live-tunable via leva.
//
// --- propDestroyed emission contract (do NOT double-emit) ----------------------------------
// This resolver emits `propDestroyed` ONLY when an hp-BEARING entity (parkedCar today;
// anything future with hp that isn't a transformer) reaches hp<=0 from accumulated damage.
// world/propDynamics.ts's fixed→dynamic swap emits `propDestroyed` separately for hp-LESS
// props (mailbox, bench, hydrant, streetlight, trafficLight, tree, fenceSegment) on launch —
// those never carry hp, so applyEntityDamage() below is a no-op for them and the two emitters
// never overlap. Transformers get their own dedicated `transformerDestroyed` event instead of
// `propDestroyed`, per TDD §5.8.
//
// --- deliberate scope cut: placeholder spark ------------------------------------------------
// The phase plan allowed "a cheap burst" of spark FX on transformer death; this resolver emits
// the event + a DEV console.info only. A real particle burst is Phase 16 (FX & juice pass)
// scope and the blackout consumer (emitters going dark) is Phase 13 (power grid) scope —
// faking either here would be scope creep dressed as progress, so the honest Phase 6 surface
// is: HP drains, the transformer dies, the event fires, the instance visibly darkens.

import { useEffect } from 'react';
import { Color } from 'three';
import { DAMAGE } from '../config/damage';
import { gameEvents } from '../state/events';
import { getGameState } from '../state/store';
import { getDevToggles } from '../core/devToggles';
import { addShake } from '../fx/cameraRig';
import { getArchetypeHandles } from '../world/instancing';
import type { EntityEntry } from '../world/registry';
import type { ImpactHandler, ImpactRecord } from './types';
import { onImpact } from './contacts';

// Module-scope: one Color instance, reused for every transformer death (mirrors
// fx/SkidMarks.tsx's RUBBER/GROUND convention — never allocate a fresh Color per call).
const TRANSFORMER_DEAD_COLOR = new Color(DAMAGE.deadTransformerColor);

// --- pure core -------------------------------------------------------------------------------

/** The subset of DAMAGE that computeDamage() needs — lets tests pass a fake config without
 * depending on the live (leva-mutable) module-scope block. */
export interface DamageConfig {
  readonly collisionK: number;
  readonly minImpactSpeed: number;
  readonly forceToSpeedProxy: number;
}

/**
 * Pure TDD §5.10 damage core: damage = collisionK × impactSpeedProxy × otherMassFactor,
 * thresholded (impactSpeedProxy below minImpactSpeed → 0, "love-taps are free"). `forceMag`
 * is Rapier's contact-force magnitude (N) from an ImpactRecord — see this file's header for
 * the N → m/s-equivalent mapping applied before the formula runs. `otherMassFactor` is the
 * OTHER side's mass relative to DAMAGE.referenceMassKg (see massFactorOf below); pass 1 for
 * an unknown/absent mass. Defaults `cfg` to the live DAMAGE config (leva-tunable) but takes
 * an explicit param so this stays a pure, independently unit-testable function.
 */
export function computeDamage(
  forceMag: number,
  otherMassFactor: number,
  cfg: DamageConfig = DAMAGE,
): number {
  if (!(forceMag > 0) || !(otherMassFactor > 0)) return 0;
  const impactSpeedProxy = forceMag / cfg.forceToSpeedProxy;
  if (impactSpeedProxy < cfg.minImpactSpeed) return 0;
  return cfg.collisionK * impactSpeedProxy * otherMassFactor;
}

/**
 * The "other side's mass factor" for the damage formula: entry's mass (DAMAGE.archetypeMassKg
 * for its archetype, or the reference mass for the player — it IS the reference, so its own
 * factor is always exactly 1) divided by DAMAGE.referenceMassKg. Entities with no known mass
 * (undefined entry, buildings, unlisted archetypes, pursuit/civilian units — not modeled yet)
 * default to factor 1, per this phase's documented scope.
 */
export function massFactorOf(entry: EntityEntry | undefined): number {
  if (!entry) return 1;
  if (entry.kind === 'player') return 1;
  if (entry.archetype) {
    const massKg = DAMAGE.archetypeMassKg[entry.archetype];
    if (massKg !== undefined) return massKg / DAMAGE.referenceMassKg;
  }
  return 1;
}

// --- resolver: hp-bearing registry entries ----------------------------------------------------

/**
 * Wrecked-visual + event side effects for a transformer reaching hp<=0. Darkens its single
 * InstancedMesh instance (world/instancing.ts's setColorAt/addUpdateRange pattern — mirrors
 * setDistrictColor but for one instance instead of a district range; setColorAt lazily
 * allocates instanceColor if this is the first tint any transformer instance has ever
 * received, per three.js's InstancedMesh source), then emits transformerDestroyed. No-ops the
 * visual half gracefully if the archetype isn't built this run (e.g. a unit test with no live
 * instancing registry) — the event still fires either way.
 */
function handleTransformerDeath(entry: EntityEntry): void {
  if (entry.archetype !== undefined && entry.instanceId !== undefined) {
    const primary = getArchetypeHandles(entry.archetype)[0];
    if (primary) {
      primary.mesh.setColorAt(entry.instanceId, TRANSFORMER_DEAD_COLOR);
      const { instanceColor } = primary.mesh;
      if (instanceColor) {
        instanceColor.addUpdateRange(entry.instanceId * 3, 3);
        instanceColor.needsUpdate = true;
      }
    }
  }

  gameEvents.emit('transformerDestroyed', { districtId: entry.districtId });

  if (import.meta.env.DEV) {
    // Placeholder spark (see file header): real FX is Phase 16, blackout consumption is
    // Phase 13 — this phase's honest scope ends at the event + a dev-visible log line.
    console.info(`[damage] transformer destroyed — district ${entry.districtId}`);
  }
}

/**
 * Applies `damage` to a registry entry's mutable hp (world/registry.ts contract), clamped at
 * 0, and fires the death side effect exactly once when it crosses from alive to dead. No-op
 * for entries without hp (indestructible props/buildings) or already-dead entries.
 */
function applyEntityDamage(entry: EntityEntry, damage: number): void {
  const hp = entry.hp;
  if (hp === undefined || hp <= 0) return;
  const newHp = Math.max(0, hp - damage);
  entry.hp = newHp;
  if (newHp > 0) return;

  if (entry.kind === 'transformer') {
    handleTransformerDeath(entry);
  } else if (entry.archetype) {
    // hp-bearing non-transformer death (parkedCar today) — see file header for the
    // propDestroyed emission split with world/propDynamics.ts. Wrecked-visual/pool handling
    // for the dead instance is propDynamics.ts's ownership, not this resolver's.
    gameEvents.emit('propDestroyed', { archetype: entry.archetype });
  }
}

// --- resolver: player hp (lives in the store, not the registry) -------------------------------

/**
 * Applies `damage` to the player's store-held HP, clamped at 0, and emits playerDamaged. A
 * no-op once playerHp is already 0 (WRECKED transition + game-over flow is Phase 9 scope —
 * this resolver only ever drains HP down to, and holds it at, 0).
 */
function applyPlayerDamage(damage: number): void {
  // Dev invincibility (leva Debug toggle; core/devToggles.ts) — Phase 9 debug tooling.
  if (import.meta.env.DEV && getDevToggles().invincible) return;
  const state = getGameState();
  if (state.playerHp <= 0) return;
  const newHp = Math.max(0, state.playerHp - damage);
  state.setPlayerHp(newHp);
  gameEvents.emit('playerDamaged', { hp: newHp, amount: damage });
}

// --- camera shake --------------------------------------------------------------------------

/** Adds impact trauma (fx/cameraRig.addShake) for impacts above DAMAGE.shakeForceThreshold,
 * scaled by DAMAGE.shakeForceScale. addShake already caps at CAMERA.shake.maxAmplitude. */
function maybeShake(forceMag: number): void {
  if (forceMag < DAMAGE.shakeForceThreshold) return;
  addShake(forceMag * DAMAGE.shakeForceScale);
}

// --- top-level impact handler --------------------------------------------------------------

/** One side of an impact: damages `target` (if it's the player, or has registry hp) using the
 * OTHER side's (`other`'s) mass factor. A no-op if EITHER side is undefined: an undefined
 * target has nothing to damage, and an undefined OTHER is unregistered world furniture —
 * in practice the GROUND slab, whose suspension-settle contact spikes (measured ~380 kN on
 * the first frames after spawn) would otherwise read as a fatal crash and drain the player
 * to 0 hp on arrival (found by the Phase 8 HUD task, the first thing to ever render hp).
 * Every entity that SHOULD deal damage — buildings, props, civilians, later pursuit units
 * and projectiles — is registry-registered, so requiring `other` costs nothing real. */
function applySideDamage(
  target: EntityEntry | undefined,
  other: EntityEntry | undefined,
  forceMag: number,
): void {
  if (!target || !other) return;
  // Dynamic-vs-dynamic vehicle pairs use the dedicated ram proxy (see config comment):
  // two yielding bodies produce far lower contact forces than hits against kinematic /
  // fixed geometry, so the global proxy would map real rams to zero.
  const isVehiclePair =
    (target.kind === 'player' && other.kind === 'pursuit') ||
    (target.kind === 'pursuit' && other.kind === 'player');
  const cfg: DamageConfig = isVehiclePair
    ? { ...DAMAGE, forceToSpeedProxy: DAMAGE.vehicleRamForceProxy }
    : DAMAGE;
  const damage = computeDamage(forceMag, massFactorOf(other), cfg);
  if (damage <= 0) return;
  if (target.kind === 'player') {
    applyPlayerDamage(damage);
  } else {
    applyEntityDamage(target, damage);
  }
}

/**
 * The impact handler proper — every ImpactRecord effect this file owns. Exported directly
 * (not only reachable via initDamageSystem) so tests can dispatch synthetic ImpactRecords
 * without a live onImpact subscription. Resolves BOTH sides (a damaged using b's mass factor,
 * b damaged using a's), then applies shake once for the pair (not per side — a single impact
 * is a single shake event).
 */
export const applyImpact: ImpactHandler = (impact: ImpactRecord): void => {
  applySideDamage(impact.a, impact.b, impact.forceMag);
  applySideDamage(impact.b, impact.a, impact.forceMag);
  maybeShake(impact.forceMag);
};

// --- mount / integration ---------------------------------------------------------------------

/** Subscribes applyImpact to the live contact spine (combat/contacts.ts) and returns the
 * unsubscribe. Call once at mount (e.g. inside a useEffect or the DamageSystem component
 * below) and call the returned function on teardown. */
export function initDamageSystem(): () => void {
  return onImpact(applyImpact);
}

/** Null-rendering system component (matches core/frameOrder.tsx's AiSystem/EventDrainSystem/
 * CameraFxSystem style) that mounts/unmounts the damage resolver's subscription for its
 * lifetime. The phase orchestrator mounts this once, inside <Physics>, alongside the other
 * frame-order systems — it needs no props and owns no per-frame work (event-driven only). */
export function DamageSystem(): null {
  useEffect(() => initDamageSystem(), []);
  return null;
}
