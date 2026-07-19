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
import { Color, Matrix4, Vector3 } from 'three';
import { DAMAGE } from '../config/damage';
import { ENEMY_UNITS, PLAYER_CARS } from '../config/vehicles';
import { gameEvents } from '../state/events';
import { getGameState } from '../state/store';
import { getDevToggles } from '../core/devToggles';
import { addShake } from '../fx/cameraRig';
import { pushFxBurst } from '../fx/particleFeed';
import { playerVehicle } from '../vehicles/playerRef';
import { getArchetypeHandles } from '../world/instancing';
import type { EntityEntry } from '../world/registry';
import type { ImpactHandler, ImpactRecord } from './types';
import type { Vec3 } from './turret';
import { onImpact } from './contacts';

// Module-scope: one Color instance, reused for every transformer death (mirrors
// fx/SkidMarks.tsx's RUBBER/GROUND convention — never allocate a fresh Color per call).
const TRANSFORMER_DEAD_COLOR = new Color(DAMAGE.deadTransformerColor);
// Scratch for reading a dead transformer's world position off its InstancedMesh instance
// (Phase 16: fires transformerDestroyed's x/y/z for fx/eventFx.ts's spark burst). One
// Matrix4/Vector3 pair, reused every death — this path runs on impact events, not every
// frame, but the module-scope-scratch convention (this file's TRANSFORMER_DEAD_COLOR,
// fx/SkidMarks.tsx, combat/explosion.ts) is followed anyway for consistency.
const _transformerMatrix = new Matrix4();
const _transformerPos = new Vector3();

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
 * The selected player car's damage-model mass factor: PLAYER_CARS[selectedCarId].massFactor,
 * read LIVE from the store (state/store.ts). These authored values (sedan 1.0, racer 0.8,
 * pickup 1.4, bus 2.6, monster 2.2, Red Rocket 3.0) are already expressed as a factor relative
 * to the reference chassis (DAMAGE.referenceMassKg = the sedan's 1200 kg), so a bus rams 2.6×
 * as hard as the sedan and a street racer 0.8× — exactly the same "factor vs reference"
 * convention massFactorOf() applies to props and pursuit units, so they compose in one formula.
 *
 * Phase 17: the player is NO LONGER hard-coded to 1. The sedan still resolves to exactly 1
 * (it IS the reference), so the M1-signed-off feel and every pre-Phase-17 test are byte-
 * identical while rustySedan is selected; heavier/lighter cars scale the damage OTHERS take
 * from a player ram. Damage the player TAKES is unaffected — that is governed by the ATTACKER's
 * mass factor (massFactorOf(other) in applySideDamage), never the player's own — so a racer's
 * fragility stays its 60 hp, not a reduced-incoming discount. Read live (not cached at mount)
 * so it always reflects the current run's car regardless of any mount-timing coupling.
 */
export function playerMassFactor(): number {
  return PLAYER_CARS[getGameState().selectedCarId].massFactor;
}

/**
 * The "other side's mass factor" for the damage formula: entry's mass (DAMAGE.archetypeMassKg
 * for its archetype, the selected car's factor for the player — see playerMassFactor above)
 * divided by DAMAGE.referenceMassKg. Entities with no known mass (undefined entry, buildings,
 * unlisted archetypes, civilian units — not modeled yet) default to factor 1, per this phase's
 * documented scope.
 *
 * Phase 10 extension: `kind: 'pursuit'` entries carry their own `unitKind` (world/registry.ts
 * seam) set by the unit factories (ai/units/*) — ENEMY_UNITS[unitKind].massFactor IS ALREADY
 * a factor relative to the reference chassis mass (policeSedan.ts's header: "massFactor 1.0
 * resolves to 1200 kg against the 1200 kg reference chassis"), so it's used directly, not
 * divided by referenceMassKg again. A pursuit entry with no unitKind (shouldn't happen; every
 * current factory sets one) falls through to the generic archetype path below, which is a
 * no-op for pursuit entries (they carry no archetype) and lands on the factor-1 default.
 */
export function massFactorOf(entry: EntityEntry | undefined): number {
  if (!entry) return 1;
  if (entry.kind === 'player') return playerMassFactor();
  if (entry.kind === 'pursuit' && entry.unitKind) {
    return ENEMY_UNITS[entry.unitKind].massFactor;
  }
  if (entry.archetype) {
    const massKg = DAMAGE.archetypeMassKg[entry.archetype];
    if (massKg !== undefined) return massKg / DAMAGE.referenceMassKg;
  }
  return 1;
}

/**
 * Ram damage multiplier (Phase 10): ENEMY_UNITS[unitKind].ramDamageMultiplier when `attacker`
 * is a pursuit unit that carries one, else 1 (the neutral/no-op default — also what an absent
 * config field means, per EnemyUnitDef's doc comment). Kept separate from massFactorOf because
 * it is directional (see applySideDamage's call site: it scales damage dealt BY a unit's ram
 * TO the player, never the reverse), where massFactorOf is symmetric.
 */
export function ramDamageMultiplier(attacker: EntityEntry | undefined): number {
  if (attacker?.kind === 'pursuit' && attacker.unitKind) {
    return ENEMY_UNITS[attacker.unitKind].ramDamageMultiplier ?? 1;
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
  // World position for fx/eventFx.ts's transformerSparks burst — read straight off the live
  // instance matrix (transformers are always FIXED archetype instances, never swapped into
  // the dynamic pool, so this is always accurate when the mesh exists) rather than threading
  // a contact point through from the impact — that's derivable, but the mesh already IS the
  // ground truth for "where this transformer actually sits". undefined (event omits x/y/z —
  // see state/events.ts's doc comment) only when the archetype has no live InstancedMesh
  // this run (e.g. a bare unit test).
  let x: number | undefined;
  let y: number | undefined;
  let z: number | undefined;

  if (entry.archetype !== undefined && entry.instanceId !== undefined) {
    const primary = getArchetypeHandles(entry.archetype)[0];
    if (primary) {
      primary.mesh.setColorAt(entry.instanceId, TRANSFORMER_DEAD_COLOR);
      const { instanceColor } = primary.mesh;
      if (instanceColor) {
        instanceColor.addUpdateRange(entry.instanceId * 3, 3);
        instanceColor.needsUpdate = true;
      }
      primary.mesh.getMatrixAt(entry.instanceId, _transformerMatrix);
      _transformerPos.setFromMatrixPosition(_transformerMatrix);
      x = _transformerPos.x;
      y = _transformerPos.y;
      z = _transformerPos.z;
    }
  }

  gameEvents.emit('transformerDestroyed', { districtId: entry.districtId, x, y, z });

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
 *
 * Exported so combat/hitscan.ts (Phase 11 gun-truck bullets) can deal fixed per-round damage to
 * hp-bearing entities through THIS resolver rather than duplicating the hp-clamp + death-event
 * emission — keeping the propDestroyed/transformerDestroyed contract this file owns single-source.
 *
 * `point` (Phase 16): the killing blow's world-space contact point, when the caller has one —
 * combat/hitscan.ts's bullet hit point, combat/explosion.ts's blast-affected body center, or
 * (via applySideDamage below) an ImpactRecord's own optional `point`. Forwarded verbatim into
 * propDestroyed's x/y/z for fx/eventFx.ts's debrisChips burst; undefined is a legitimate value
 * (Rapier doesn't always report a contact point — see state/events.ts's doc comment), NOT
 * defaulted to a fake origin. Unused for a transformer death — handleTransformerDeath derives
 * its own, more accurate position straight off the instance mesh.
 */
export function applyEntityDamage(entry: EntityEntry, damage: number, point?: Vec3): void {
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
    gameEvents.emit('propDestroyed', { archetype: entry.archetype, x: point?.x, y: point?.y, z: point?.z });
  }
}

// --- resolver: player hp (lives in the store, not the registry) -------------------------------

/**
 * Applies `damage` to the player's store-held HP, clamped at 0, and emits playerDamaged. A
 * no-op once playerHp is already 0 (WRECKED transition + game-over flow is Phase 9 scope —
 * this resolver only ever drains HP down to, and holds it at, 0). Honors the DEV invincible
 * toggle.
 *
 * Exported so combat/hitscan.ts (Phase 11 gun-truck bullets) drains player HP through the SAME
 * guard (invincible + clamp + playerDamaged emission) that ram damage uses — one player-damage
 * path, so bullets and rams can never diverge on invincibility or the HUD damage event.
 */
export function applyPlayerDamage(damage: number): void {
  // Dev invincibility (leva Debug toggle; core/devToggles.ts) — Phase 9 debug tooling.
  if (import.meta.env.DEV && getDevToggles().invincible) return;
  const state = getGameState();
  if (state.playerHp <= 0) return;
  const newHp = Math.max(0, state.playerHp - damage);
  state.setPlayerHp(newHp);
  gameEvents.emit('playerDamaged', { hp: newHp, amount: damage });
}

// --- camera shake + impact sparks ------------------------------------------------------------

/** Adds impact trauma (fx/cameraRig.addShake) for impacts above DAMAGE.shakeForceThreshold,
 * scaled by DAMAGE.shakeForceScale (addShake already caps at CAMERA.shake.maxAmplitude), and
 * pushes a cosmetic 'impactSparks' burst (Phase 16 Task 3) at the same threshold — a hard
 * contact big enough to shake the camera is exactly the "worth a spark hit" bar, so this
 * shares the gate rather than adding a second tunable.
 *
 * The SPARK (not the shake) is additionally gated two ways, both learned live in the Phase
 * 16 FX battery, where the pool pinned at 500/500 during a plain slide and during combat:
 *   1. BOTH impact sides must be registered — the same rule applySideDamage uses. A bare
 *      ground scrape (hard lateral slide, suspension-settle spike) shakes at most a capped
 *      amount and deals no damage; it must not shower sparks either.
 *   2. A wall-clock throttle (DAMAGE.sparkMinIntervalMs): contact-force events re-fire every
 *      physics step while a pair stays wedged, and unlike shake (trauma-capped) a burst per
 *      step saturates the particle pool and starves every smoke/fire emitter.
 * The shake keeps its original, sign-off-era behavior — threshold only.
 *
 * Position: the contact's own `point` when Rapier reports one (in practice this is almost
 * always undefined today — combat/contacts.ts's dispatchContactForce doc comment: "Rapier's
 * ContactForceEvent exposes no contact point"), else the player chassis translation — every
 * impact this resolver ever sees has the player on one side or the other (applySideDamage's
 * header), so its position is always a reasonable stand-in for "roughly where this hit
 * happened" even without the exact contact point.
 */
let lastSparkAtMs = Number.NEGATIVE_INFINITY;

/** Test hygiene: forget the spark throttle's last-burst timestamp (damage.test.ts calls this
 * from beforeEach so earlier tests' impacts can't swallow a later test's expected burst). */
export function resetSparkThrottle(): void {
  lastSparkAtMs = Number.NEGATIVE_INFINITY;
}

function maybeShakeAndSpark(
  forceMag: number,
  point: Vec3 | undefined,
  a: EntityEntry | undefined,
  b: EntityEntry | undefined,
): void {
  if (forceMag < DAMAGE.shakeForceThreshold) return;
  addShake(forceMag * DAMAGE.shakeForceScale);

  if (!a || !b) return; // bare-ground scrape: capped shake, no spark shower (doc above)
  const nowMs = performance.now();
  if (nowMs - lastSparkAtMs < DAMAGE.sparkMinIntervalMs) return;
  lastSparkAtMs = nowMs;

  const pos = point ?? playerVehicle.current?.readState().pose.position;
  if (!pos) return;
  // Scale the burst a little with force so a glancing threshold-crosser reads smaller than a
  // full-on plow, clamped to a sane band — this is cosmetic proportionality, not a physical
  // quantity, so the exact curve doesn't need to be more than "bigger hits look bigger".
  const rawIntensity = forceMag / DAMAGE.shakeForceThreshold;
  const intensity = rawIntensity < 0.5 ? 0.5 : rawIntensity > 3 ? 3 : rawIntensity;
  pushFxBurst('impactSparks', pos.x, pos.y, pos.z, { intensity });
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
  point: Vec3 | undefined,
): void {
  if (!target || !other) return;
  // Dynamic-vs-dynamic pairs use the dedicated ram proxy (see config comment): two yielding
  // bodies produce far lower contact forces than hits against kinematic/fixed geometry, so
  // the global proxy would map real rams to zero. Originally pursuit-vehicle-only (Phase 9);
  // Phase 29 (Toronto parity) extends the SAME physical reasoning to `propDynamic` — a live
  // dynamic body is a live dynamic body regardless of whether it's a pursuit unit or a prop,
  // and Rapier's solver doesn't distinguish. This was FOUND LIVE during Phase 29 T1
  // verification: Toronto's already-dynamic parked cars/lane-closure cones (registered at
  // creation, never swapped from fixed — see world/toronto/torontoColliders.ts) measured
  // ~4,000-14,000 N on a genuine 6+ m/s ram — an order of magnitude below the global proxy's
  // threshold (minImpactSpeed=5 needs forceMag > 625,000), meaning they could NEVER score
  // under the un-widened formula, however hard rammed. Legacy props reach `propDynamic` only
  // AFTER the fixed->dynamic swap (world/propDynamics.ts), by which point they're typically
  // launched/tumbling and rarely struck a clean second time — this widening is a no-op for
  // that rare path in practice, not a retune of legacy's signed-off fixed-hit feel (which
  // stays on the default proxy: the swap-triggering hit itself is always against a
  // `propStatic` entry, never `propDynamic`).
  const isYieldingBodyPair =
    (target.kind === 'player' && (other.kind === 'pursuit' || other.kind === 'propDynamic')) ||
    ((target.kind === 'pursuit' || target.kind === 'propDynamic') && other.kind === 'player');
  const cfg: DamageConfig = isYieldingBodyPair
    ? { ...DAMAGE, forceToSpeedProxy: DAMAGE.vehicleRamForceProxy }
    : DAMAGE;
  let damage = computeDamage(forceMag, massFactorOf(other), cfg);
  // Ram damage multiplier (Phase 10): a pursuit unit's ram INTO the player hurts more per its
  // own kind (swat 1.5×, armored 1.15×) — directional, never applied when the player rams a
  // unit (target.kind === 'pursuit' side of isVehiclePair uses the plain, unmultiplied factor).
  if (target.kind === 'player' && other.kind === 'pursuit') {
    damage *= ramDamageMultiplier(other);
  }
  if (damage <= 0) return;
  // Single-hit cap (Phase 16 Task 3; config/damage.ts's DAMAGE.maxSingleHit doc comment): the
  // LAST thing before damage is actually applied, so it catches the fully-multiplied value
  // (ram multiplier included) regardless of which formula/proxy produced it — one contact
  // event can never drain more than this, however large forceMag reads.
  if (damage > DAMAGE.maxSingleHit) damage = DAMAGE.maxSingleHit;
  if (target.kind === 'player') {
    applyPlayerDamage(damage);
  } else {
    applyEntityDamage(target, damage, point);
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
  applySideDamage(impact.a, impact.b, impact.forceMag, impact.point);
  applySideDamage(impact.b, impact.a, impact.forceMag, impact.point);
  maybeShakeAndSpark(impact.forceMag, impact.point, impact.a, impact.b);
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
