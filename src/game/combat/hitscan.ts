// Hitscan bullets (Phase 11 Task 2; TDD §5.6 gun-truck row). The "what a fired round does" half
// of the ranged toolkit (combat/turret.ts is the aim half). A gun truck's turret fires a 3-round
// BURST — rounds spaced spacingSec apart, SIM-TIME scheduled inside the unit's per-step tick (NOT
// setTimeout: the clock is the physics clock, so bursts pause with the sim and stay deterministic)
// — then waits cooldownSec before the next burst. Each round is an instant raycast from the muzzle
// along the (damped) aim + a seeded cone spread, out to rangeM. The FIRST thing it hits is
// resolved through world/registry.ts and handled:
//   • player      → dmgPerHit via the store (combat/damage.ts's applyPlayerDamage, which already
//                   honors the DEV invincible toggle) + an impulsePerHit shove at the hit point.
//   • static prop → world/propDynamics.ts's swapFromExternalHit (a bullet knocks it loose & flies).
//   • other hp    → dmgPerHit via combat/damage.ts's applyEntityDamage (civilians, transformers…).
//   • building / ground / nothing → no gameplay effect (just a tracer).
// EVERY round pushes one TracerShot (combat/tracerFeed.ts) whether it hit or flew to max range —
// the FX layer (Task 3) renders those. Phase 12 tank shells reuse this file's burst scheduler +
// fireRound; the pure scheduler/spread/direction math is unit-tested with no Rapier.

import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { CollisionGroup } from '../config';
import type { Rng } from '../world/rng';
import { getEntity } from '../world/registry';
import { swapFromExternalHit } from '../world/propDynamics';
import { applyEntityDamage, applyPlayerDamage } from './damage';
import { pushFxBurst } from '../fx/particleFeed';
import { pushTracer } from './tracerFeed';
import type { Vec3 } from './turret';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];
type RapierRay = InstanceType<RapierNamespace['Ray']>;

/**
 * Bullet ray interaction groups: membership PROJECTILE; filter = everything a round can hit
 * EXCEPT other pursuit units (no friendly fire) and other projectiles/water. Rapier reports a
 * collider iff (ray.mem & collider.filter) && (collider.mem & ray.filter): every listed target's
 * COLLIDES_WITH includes PROJECTILE (config/collision.ts), so the first of these along the ray is
 * the hit. PURSUIT is deliberately omitted from the filter, so a gun truck's rounds pass THROUGH
 * itself and its squadmates (the firing body is also excluded per-cast for good measure).
 */
export const BULLET_RAY_GROUPS =
  (CollisionGroup.PROJECTILE << 16) |
  (CollisionGroup.PLAYER |
    CollisionGroup.CIVILIAN |
    CollisionGroup.PROP_STATIC |
    CollisionGroup.PROP_DYNAMIC |
    CollisionGroup.BUILDING |
    CollisionGroup.GROUND);

// --- pure spread + direction -----------------------------------------------------------------

/** One seeded spread offset in [−spreadRad, +spreadRad], advancing `rng`. The gun truck forks a
 * fresh rng per (unit, burst) and pulls two of these per round (yaw + pitch) — so the whole
 * burst's dispersion is deterministic and reproducible from the seed. */
export function spreadAngle(rng: Rng, spreadRad: number): number {
  return (rng.next() * 2 - 1) * spreadRad;
}

/**
 * Unit bullet direction from a base aim yaw + pitch, perturbed by cone offsets (dYaw, dPitch).
 * +Z-forward convention (dir = (sin yaw·cos pitch, sin pitch, cos yaw·cos pitch)); the result is
 * always a unit vector. Zero offsets return the pure aim direction. Pure/testable.
 */
export function bulletDirection(aimYaw: number, pitch: number, dYaw: number, dPitch: number): Vec3 {
  const yaw = aimYaw + dYaw;
  const p = pitch + dPitch;
  const cp = Math.cos(p);
  return { x: Math.sin(yaw) * cp, y: Math.sin(p), z: Math.cos(yaw) * cp };
}

/** Pitch (rad, + = up) from a muzzle down/up to a target point: atan2(dy, horizontalDistance).
 * A player below the muzzle yields a negative pitch so rounds angle DOWN and actually reach the
 * chassis instead of sailing overhead. */
export function pitchToward(muzzle: Vec3, target: Vec3): number {
  const horiz = Math.hypot(target.x - muzzle.x, target.z - muzzle.z);
  return Math.atan2(target.y - muzzle.y, horiz);
}

// --- burst scheduler (pure; sim-time driven) -------------------------------------------------

export interface BurstCfg {
  readonly rounds: number;
  readonly spacingSec: number;
  readonly cooldownSec: number;
}

export type BurstPhase = 'idle' | 'firing';

export interface BurstState {
  readonly phase: BurstPhase;
  /** Sim time (s) the current burst started (round i fires at burstStartSec + i·spacingSec). */
  readonly burstStartSec: number;
  readonly roundsFired: number;
  /** No new burst may start before this sim time. */
  readonly cooldownUntilSec: number;
  /** Total bursts begun — the per-burst rng fork label + tracer/debug counter. */
  readonly burstIndex: number;
}

export const initialBurstState: BurstState = {
  phase: 'idle',
  burstStartSec: 0,
  roundsFired: 0,
  cooldownUntilSec: 0,
  burstIndex: 0,
};

/** A burst may start only while idle and past the cooldown window. */
export function canStartBurst(s: BurstState, simTimeSec: number): boolean {
  return s.phase === 'idle' && simTimeSec >= s.cooldownUntilSec;
}

/** Begin a burst at `simTimeSec` (bumps burstIndex → a fresh spread rng fork). */
export function beginBurst(s: BurstState, simTimeSec: number): BurstState {
  return {
    phase: 'firing',
    burstStartSec: simTimeSec,
    roundsFired: 0,
    cooldownUntilSec: s.cooldownUntilSec,
    burstIndex: s.burstIndex + 1,
  };
}

/**
 * Advance a firing burst to `simTimeSec`: return the 0-based indices of the rounds that come DUE
 * this step (usually one at 60 Hz vs a 100 ms spacing, but robust to a hitch that spans several)
 * and the next state. Round i is scheduled at burstStartSec + i·spacingSec. When the final round
 * fires the burst goes idle and cooldownUntilSec = that round's time + cooldownSec — a full
 * cooldownSec gap between the last shot of one burst and the first of the next. No-op when idle.
 */
export function pumpBurst(
  s: BurstState,
  simTimeSec: number,
  cfg: BurstCfg,
): { readonly fired: number[]; readonly state: BurstState } {
  if (s.phase !== 'firing') return { fired: [], state: s };
  const fired: number[] = [];
  let roundsFired = s.roundsFired;
  let phase: BurstPhase = 'firing';
  let cooldownUntil = s.cooldownUntilSec;
  while (roundsFired < cfg.rounds) {
    const t = s.burstStartSec + roundsFired * cfg.spacingSec;
    if (simTimeSec + 1e-9 < t) break;
    fired.push(roundsFired);
    roundsFired += 1;
    if (roundsFired >= cfg.rounds) {
      phase = 'idle';
      cooldownUntil = t + cfg.cooldownSec;
    }
  }
  return { fired, state: { ...s, phase, roundsFired, cooldownUntilSec: cooldownUntil } };
}

// --- imperative single-round fire ------------------------------------------------------------

export interface HitscanDeps {
  readonly world: RapierWorld;
  /** Caller-owned reused Ray (no per-round allocation). */
  readonly ray: RapierRay;
  /** The firing truck's own body — excluded so a round never self-hits. */
  readonly excludeBody?: RapierRigidBody;
}

export interface RoundParams {
  readonly muzzle: Vec3;
  /** Normalized bullet direction (aim + pitch + seeded spread already applied). */
  readonly dir: Vec3;
  readonly rangeM: number;
  readonly dmgPerHit: number;
  readonly impulsePerHit: number;
  readonly propForceProxyN: number;
  /** performance.now() at fire time — the tracer fades by age. */
  readonly nowMs: number;
}

export interface RoundResult {
  readonly hit: boolean;
  /** Registry kind of what was struck (undefined = flew to max range or hit unregistered geo). */
  readonly targetKind?: string;
}

/**
 * Fire ONE hitscan round: raycast muzzle→dir out to rangeM, resolve the first hit through the
 * registry, apply its effect, and ALWAYS push a tracer. Imperative (Rapier + registry + store +
 * prop pool) — the aim/spread/scheduling that decide the args are the tested pure parts.
 */
export function fireRound(deps: HitscanDeps, p: RoundParams): RoundResult {
  const ray = setRay(deps.ray, p.muzzle, p.dir);
  const hit = deps.world.castRay(
    ray,
    p.rangeM,
    true,
    undefined,
    BULLET_RAY_GROUPS,
    undefined,
    deps.excludeBody,
  );

  if (hit === null) {
    // Max-range miss — tracer flies the full length.
    const end = {
      x: p.muzzle.x + p.dir.x * p.rangeM,
      y: p.muzzle.y + p.dir.y * p.rangeM,
      z: p.muzzle.z + p.dir.z * p.rangeM,
    };
    pushTracer({
      x0: p.muzzle.x,
      y0: p.muzzle.y,
      z0: p.muzzle.z,
      x1: end.x,
      y1: end.y,
      z1: end.z,
      hit: false,
      t: p.nowMs,
    });
    return { hit: false };
  }

  const toi = hit.timeOfImpact;
  const point: Vec3 = {
    x: p.muzzle.x + p.dir.x * toi,
    y: p.muzzle.y + p.dir.y * toi,
    z: p.muzzle.z + p.dir.z * toi,
  };
  const handle = hit.collider.handle;
  const entry = getEntity(handle);
  const targetKind: string | undefined = entry?.kind;

  if (entry !== undefined) {
    if (entry.kind === 'player') {
      // Store-held HP (honors DEV invincible via applyPlayerDamage) + a shove at the hit point.
      applyPlayerDamage(p.dmgPerHit);
      const body = deps.world.getCollider(handle)?.parent();
      if (body) {
        body.applyImpulseAtPoint(
          { x: p.dir.x * p.impulsePerHit, y: p.dir.y * p.impulsePerHit, z: p.dir.z * p.impulsePerHit },
          point,
          true,
        );
      }
    } else if (entry.kind === 'propStatic') {
      // A round knocks a street prop loose into the dynamic pool (reuses the exact contact-swap
      // path). Below its archetype's threshold (tree/parked car) this is a graceful no-op.
      swapFromExternalHit(handle, point, p.propForceProxyN);
    } else if (entry.hp !== undefined) {
      // Civilians / transformers / airborne hp-bearing props — same resolver as ram damage,
      // so death events stay consistent (combat/damage.ts owns the emission contract).
      applyEntityDamage(entry, p.dmgPerHit, point);
    }
    // else: building / ground / hp-less dynamic prop → tracer only.
  }

  // Physical spark burst at the hit point (Phase 16). Tracers.tsx's hit-spark quad (a
  // camera-facing billboard drawn from the tracer feed) stays — this ADDS a real particle
  // burst from fx/particles.ts's pool, same "two independent FX layers" split
  // combat/explosion.ts uses for its flash + this task's ember burst.
  pushFxBurst('impactSparks', point.x, point.y, point.z);

  pushTracer({
    x0: p.muzzle.x,
    y0: p.muzzle.y,
    z0: p.muzzle.z,
    x1: point.x,
    y1: point.y,
    z1: point.z,
    hit: true,
    t: p.nowMs,
  });
  return { hit: true, targetKind };
}

/** Point a reused Ray from `origin` along the (already-normalized) `dir`, returning it. */
function setRay(ray: RapierRay, origin: Vec3, dir: Vec3): RapierRay {
  ray.origin.x = origin.x;
  ray.origin.y = origin.y;
  ray.origin.z = origin.z;
  ray.dir.x = dir.x;
  ray.dir.y = dir.y;
  ray.dir.z = dir.z;
  return ray;
}
