// Tank-shell explosion resolver (Phase 12 Task 1; TDD §5.6 "Tank shell & explosion physics").
// combat/projectiles.ts calls detonate() at a shell's impact point; this module turns that
// point into the physical spectacle: a radius-8 m Rapier sphere query gathers every collider
// in range, resolves each through world/registry.ts, and applies — to EVERYTHING, no faction
// filter (friendly fire is intentional, TDD §5.6) —
//   • FIXED static props (kind 'propStatic') → world/propDynamics.ts's swapFromExternalHit
//     (knocked loose into the dynamic pool, launched radially by the swap's own synthesized
//     impulse — its launch direction is normalize(propPos − blastPoint), i.e. straight out of
//     the blast — so we rely on that rather than reaching the freshly-pooled body). This is the
//     documented fallback in the part-file: the shared swap path caps launch impulse, so a HEAVY
//     static prop (parked car) tosses tumble-dominant; ALREADY-dynamic props get the full radial
//     impulse via the dynamic-body branch below.
//   • DYNAMIC bodies (player, pursuit units, converted/wrecked civilians, already-dynamic props)
//     → wake + a radial LINEAR impulse at the center of mass (clamped per-body so light bodies
//     don't rocket and the player launch stays recoverable) + linear-falloff damage. The player
//     gets ZERO angular impulse (never helicopters); non-player debris/units get a small capped
//     tumble torque for juice.
//   • hp-bearing FIXED entities (transformers) → linear-falloff damage only (no impulse).
// Every detonation pushes one ExplosionRecord (combat/explosionFeed.ts) so the FX layer (Task 3)
// always plays flash/smoke/scorch/shake regardless of what was in range.
//
// Pure math (falloff / damage curve / per-body impulse clamp / body-dedupe) is exported and
// unit-tested with no Rapier; detonate() is the one imperative shell (sphere query + impulses).

import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { CollisionGroup, TANK } from '../config';
import { getEntity, type EntityEntry } from '../world/registry';
import { swapFromExternalHit } from '../world/propDynamics';
import { applyEntityDamage, applyPlayerDamage } from './damage';
import { pushExplosion } from './explosionFeed';
import type { Vec3 } from './turret';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];
type RapierCollider = ReturnType<RapierWorld['getCollider']>;

/**
 * Explosion query interaction groups: membership PROJECTILE, filter = every body an explosion
 * can affect. UNLIKE combat/hitscan.ts's BULLET_RAY_GROUPS this INCLUDES PURSUIT — friendly
 * fire is the whole point at ★5 (a tank shell wrecking its own police cordon; TDD §5.6). It
 * EXCLUDES BUILDING/GROUND (indestructible fixed geometry — nothing to launch or damage),
 * WATER, and PROJECTILE. Rapier reports a collider iff (shape.mem & collider.filter) &&
 * (collider.mem & shape.filter): every listed target's COLLIDES_WITH includes PROJECTILE
 * (config/collision.ts), so all of them match.
 */
export const EXPLOSION_QUERY_GROUPS =
  (CollisionGroup.PROJECTILE << 16) |
  (CollisionGroup.PLAYER |
    CollisionGroup.PURSUIT |
    CollisionGroup.CIVILIAN |
    CollisionGroup.PROP_STATIC |
    CollisionGroup.PROP_DYNAMIC);

const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };

// ===========================================================================================
// Pure math (unit-tested; no Rapier/registry side effects)
// ===========================================================================================

/** Linear proximity falloff: 1 at the blast center, 0 at (and beyond) the radius. Clamped to
 * [0,1]. This is the shared 1 − dist/radius term both the impulse and (implicitly) the damage
 * curve are built on. */
export function blastFalloff(dist: number, radius: number): number {
  if (!(radius > 0)) return 0;
  const t = dist / radius;
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t;
}

/** Linear-falloff blast damage: dmgCenter at dist 0, dmgEdge at dist ≥ radius (TDD §5.6
 * "35 → 5 at edge"). Interpolated on dist/radius, clamped so it never drops below dmgEdge or
 * rises above dmgCenter. */
export function blastDamage(
  dist: number,
  radius: number,
  dmgCenter: number,
  dmgEdge: number,
): number {
  if (!(radius > 0)) return dmgCenter;
  const t = Math.min(1, Math.max(0, dist / radius));
  return dmgCenter + (dmgEdge - dmgCenter) * t;
}

/**
 * Per-body impulse magnitude for the radial launch: the base impulse × falloff, then clamped to
 * BOTH an absolute ceiling AND maxLaunchSpeedMps × mass (so a light body's resulting Δv can't
 * exceed maxLaunchSpeedMps, keeping a 30 kg prop from being flung to hundreds of m/s and keeping
 * the player launch recoverable). Never negative.
 */
export function clampImpulseMag(
  base: number,
  falloff: number,
  mass: number,
  maxImpulse: number,
  maxLaunchSpeedMps: number,
): number {
  const desired = base * Math.max(0, falloff);
  const massCap = maxLaunchSpeedMps * Math.max(0, mass);
  return Math.max(0, Math.min(desired, maxImpulse, massCap));
}

/** One collider gathered by the sphere query, tagged with its parent rigid-body handle (or
 * undefined for a collider with no body). */
export interface BlastHitRef {
  readonly colliderHandle: number;
  readonly bodyHandle: number | undefined;
}

/**
 * Dedupe gathered colliders down to ONE per rigid body (a body may own several colliders, and a
 * single blast must apply its impulse/damage to each body exactly once). Keeps the FIRST
 * collider seen per body; colliders with no body (bodyHandle undefined) are each kept as
 * distinct (they can't be batched). Order-preserving. Pure.
 */
export function dedupeByBody<T extends BlastHitRef>(hits: readonly T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const h of hits) {
    if (h.bodyHandle === undefined) {
      out.push(h);
      continue;
    }
    if (seen.has(h.bodyHandle)) continue;
    seen.add(h.bodyHandle);
    out.push(h);
  }
  return out;
}

/**
 * Normalized radial launch direction from the blast point to a body center, with an upward kick
 * folded in and re-normalized (so bodies POP + arc, not only skid). A body essentially AT the
 * blast point (degenerate radial) launches straight up.
 */
export function radialLaunchDir(point: Vec3, body: Vec3, upKick: number): Vec3 {
  let dx = body.x - point.x;
  let dy = body.y - point.y;
  let dz = body.z - point.z;
  const len = Math.hypot(dx, dy, dz);
  if (len > 1e-4) {
    dx /= len;
    dy /= len;
    dz /= len;
  } else {
    dx = 0;
    dy = 1;
    dz = 0;
  }
  dy += upKick;
  const l2 = Math.hypot(dx, dy, dz) || 1;
  return { x: dx / l2, y: dy / l2, z: dz / l2 };
}

// ===========================================================================================
// DEV finite-pose check (queued; drained by combat/ProjectilesMount next physics step)
// ===========================================================================================

const pendingFiniteChecks: RapierRigidBody[] = [];
const FINITE_CHECK_CAP = 256;

function queueFiniteCheck(body: RapierRigidBody): void {
  if (!import.meta.env.DEV) return;
  if (pendingFiniteChecks.length < FINITE_CHECK_CAP) pendingFiniteChecks.push(body);
}

/** DEV-only: assert every body an explosion touched has a finite pose AFTER the physics step
 * that integrated the impulse (a bad impulse would surface as NaN here, not silently). Called
 * by combat/ProjectilesMount's useAfterPhysicsStep. No-op in production. */
export function drainExplosionFiniteChecks(): void {
  if (!import.meta.env.DEV) return;
  for (const body of pendingFiniteChecks) {
    try {
      const t = body.translation();
      if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) {
        console.error('[explosion] non-finite body pose after blast:', t);
      }
    } catch {
      // Body was removed (despawned) between the blast and this drain — nothing to check.
    }
  }
  pendingFiniteChecks.length = 0;
}

/** Test-only: reset the DEV finite-check queue between cases. */
export function __resetExplosionForTest(): void {
  pendingFiniteChecks.length = 0;
}

// ===========================================================================================
// detonate — the one imperative entry point
// ===========================================================================================

export interface DetonateDeps {
  readonly world: RapierWorld;
  readonly rapier: RapierNamespace;
}

/**
 * Detonate at `point`: push the FX record, sphere-query the world (radius TANK.blast.radius),
 * dedupe to one collider per body, and apply the radial impulse + falloff damage described in
 * this file's header to each — player, props, civilians, AND pursuit units alike (no faction
 * filter). Safe to call any physics step; imperative (Rapier + registry + store + prop pool).
 */
export function detonate(deps: DetonateDeps, point: Vec3): void {
  const { world, rapier } = deps;
  const blast = TANK.blast;

  // FX always plays, whatever was (or wasn't) in range.
  pushExplosion({ x: point.x, y: point.y, z: point.z, radiusM: blast.radius, t: performance.now() });

  // Gather every collider whose group is compatible, tagged with its body handle for dedupe.
  const ball = new rapier.Ball(blast.radius);
  const gathered: (BlastHitRef & { collider: RapierCollider })[] = [];
  world.intersectionsWithShape(
    point,
    IDENTITY_ROT,
    ball,
    (collider) => {
      gathered.push({
        colliderHandle: collider.handle,
        bodyHandle: collider.parent()?.handle,
        collider,
      });
      return true; // keep enumerating
    },
    undefined,
    EXPLOSION_QUERY_GROUPS,
  );

  for (const item of dedupeByBody(gathered)) {
    affectOne(deps, item, item.collider, point, blast);
  }
}

/** Apply one blast's effect to a single collider's entity (already deduped to one per body). */
function affectOne(
  deps: DetonateDeps,
  ref: BlastHitRef,
  collider: RapierCollider,
  point: Vec3,
  blast: typeof TANK.blast,
): void {
  const entry = getEntity(ref.colliderHandle);
  if (entry === undefined) return; // unregistered geometry — ignore

  const body = collider.parent();
  const center = body ? body.translation() : collider.translation();
  const dist = Math.hypot(center.x - point.x, center.y - point.y, center.z - point.z);
  if (dist > blast.radius) return; // query is inclusive at the boundary; guard the epsilon
  const falloff = blastFalloff(dist, blast.radius);

  // FIXED static props swap into the dynamic pool FIRST (the swap's synthesized impulse is
  // already radial — see file header). Its force proxy scales with proximity so edge props
  // barely stir / stay put; the archetype threshold gate inside swapFromExternalHit makes a
  // sub-threshold hit a graceful no-op.
  if (entry.kind === 'propStatic') {
    swapFromExternalHit(ref.colliderHandle, point, blast.propForceProxyN * falloff);
    return;
  }

  // Damage — no faction filter (player, civilians, pursuit units, transformers all take it).
  const dmg = blastDamage(dist, blast.radius, blast.dmgCenter, blast.dmgEdge);
  if (entry.kind === 'player') {
    applyPlayerDamage(dmg);
  } else if (entry.hp !== undefined) {
    applyEntityDamage(entry, dmg);
  }

  // Radial impulse — only DYNAMIC bodies can be pushed (kinematic civilians / fixed transformers
  // are damage-only). Wake sleepers so a resting prop/unit actually receives the shove.
  if (body && body.isDynamic()) {
    applyBlastImpulse(deps, body, entry, center, point, falloff, blast);
    queueFiniteCheck(body);
  }
}

/** The dynamic-body launch: a clamped linear radial impulse at the center of mass (no torque —
 * so nothing helicopters from it), plus, for NON-player bodies, a small capped tumble torque. */
function applyBlastImpulse(
  _deps: DetonateDeps,
  body: RapierRigidBody,
  entry: EntityEntry,
  center: Vec3,
  point: Vec3,
  falloff: number,
  blast: typeof TANK.blast,
): void {
  body.wakeUp();

  const dir = radialLaunchDir(point, center, blast.upKick);
  const mag = clampImpulseMag(
    blast.impulse,
    falloff,
    body.mass(),
    blast.maxImpulse,
    blast.maxLaunchSpeedMps,
  );
  // At center of mass → pure linear, zero angular. The player therefore CANNOT be spun by the
  // blast, only launched (and it lands + recovers). Passing wakeUp=true is belt-and-suspenders.
  body.applyImpulse({ x: dir.x * mag, y: dir.y * mag, z: dir.z * mag }, true);

  // Tumble for everything BUT the player: a small torque about a horizontal axis perpendicular to
  // the launch, clamped hard so debris/units spin a little without going wild. The player is left
  // untouched (never helicopters).
  if (entry.kind !== 'player') {
    // axis = normalize(dir × worldUp) → a horizontal tangent; degenerate (dir≈up) → +X.
    let ax = dir.z; // (dir × (0,1,0)) = (dir.z, 0, -dir.x)
    let az = -dir.x;
    const al = Math.hypot(ax, az);
    if (al > 1e-3) {
      ax /= al;
      az /= al;
    } else {
      ax = 1;
      az = 0;
    }
    const torque = Math.min(blast.maxAngularImpulse, blast.maxAngularImpulse * falloff);
    body.applyTorqueImpulse({ x: ax * torque, y: 0, z: az * torque }, true);
  }
}
