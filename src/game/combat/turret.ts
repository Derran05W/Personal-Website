// Turret aim + fire-gate (Phase 11 Task 2; TDD §5.6 gun-truck row). The ranged-combat half of
// a gun truck: a world-space aim that DAMPS toward the player (rate-limited slew), a
// line-of-sight test that only BUILDINGS block, and the range/slip gates that decide whether a
// burst may start. combat/hitscan.ts is the other half (what a fired round does). Phase 12
// tanks reuse both verbatim — this file is deliberately unit-agnostic (no gun-truck imports).
//
// --- the moving-chassis gotcha (why the aim is WORLD-space) --------------------------------
// The turret's persistent state is its WORLD aim yaw, and track() damps that world yaw toward
// the world direction to the player. It is NOT a local angle relative to the (constantly
// rotating, drifting, orbiting) chassis: if we damped a chassis-relative angle, every degree
// the chassis yawed would instantly drag the "current" world aim with it, so a truck spinning
// through its orbit would whip the barrel around and spray wildly. Storing world aim means the
// barrel holds its heading in the world while the chassis moves under it, and only the damped
// slew toward the player changes it — exactly the lazy, laggable tracking the counterplay wants
// (a player crossing faster than yawRateDegPerSec out-runs the aim; TDD's "dodging is the
// counter"). The muzzle POSITION rides the chassis (turretMuzzle below); only the aim is world.
//
// Pure math (dampAngle / lateralSpeed / canFire / turretMuzzle / the LOS ray mask constant) is
// unit-tested with no Rapier; castBuildingClear is the one imperative helper (a single raycast).

import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { CollisionGroup } from '../config';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];
type RapierRay = InstanceType<RapierNamespace['Ray']>;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const DEG2RAD = Math.PI / 180;

/**
 * LOS ray interaction groups: membership PROJECTILE, filter BUILDING ONLY. Rapier's u32 is
 * (membership << 16) | filter, and a ray reports a collider hit iff (ray.mem & collider.filter)
 * && (collider.mem & ray.filter). Buildings' COLLIDES_WITH includes PROJECTILE, so a building
 * matches (blocks LOS); PROP_STATIC/PROP_DYNAMIC/GROUND/vehicles are all excluded from the ray's
 * FILTER, so props and the ground never block a shot — "chaotic-good": only a real wall shields
 * the player. Same construction as ai/pursuitVehicle.ts's AVOID_RAY_GROUPS (a hand-built mask,
 * not interactionGroups(), because we need a bespoke membership/filter pair).
 */
export const LOS_RAY_GROUPS = (CollisionGroup.PROJECTILE << 16) | CollisionGroup.BUILDING;

// --- pure aim math ---------------------------------------------------------------------------

/** Yaw (rad) for a +Z-forward model facing down (dx,dz); 0 for a zero delta. Matches the
 * ai/traffic.ts + aiSteering.ts convention (yaw = atan2(dx, dz), +yaw = toward +X = right). A
 * local copy rather than an import from aiSteering.ts, which Task 1 owns/edits in parallel —
 * keeps this module compilable and testable independent of that file's churn. */
export function yawToward(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return 0;
  return Math.atan2(dx, dz);
}

/** Shortest signed angle equivalent to `a`, wrapped to (−π, π]. Local copy — see yawToward. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}

/**
 * Rate-limited slew of `current` (rad) toward `target` (rad) by at most `maxStep` (rad) along
 * the SHORTEST arc. Pure — `maxStep` is the caller's yawRate × dt. maxStep ≥ π snaps straight to
 * the target (no rate limit). Both inputs may be any angle; the result is wrapped to (−π, π].
 */
export function dampAngle(current: number, target: number, maxStep: number): number {
  const delta = wrapAngle(target - current);
  const step = delta > maxStep ? maxStep : delta < -maxStep ? -maxStep : delta;
  return wrapAngle(current + step);
}

/**
 * Signed lateral (sideways) speed of a chassis, m/s: the component of planar velocity along the
 * chassis' RIGHT axis. With +Z-forward and yaw = atan2(fx,fz), forward = (sin yaw, cos yaw) and
 * right = (cos yaw, −sin yaw), so lateral = v · right = vx·cos(yaw) − vz·sin(yaw). The fire gate
 * uses |lateral| (a truck sliding sideways can't hold a bead).
 */
export function lateralSpeed(vx: number, vz: number, yaw: number): number {
  return vx * Math.cos(yaw) - vz * Math.sin(yaw);
}

/** World-space muzzle position: the turret pivot rides `heightM` above the chassis center, and
 * the barrel tip sits `muzzleForwardM` ahead of the pivot along the (world) aim yaw. Both the
 * LOS ray and every fired round originate here. */
export function turretMuzzle(
  chassis: Vec3,
  aimYaw: number,
  cfg: { readonly heightM: number; readonly muzzleForwardM: number },
): Vec3 {
  return {
    x: chassis.x + Math.sin(aimYaw) * cfg.muzzleForwardM,
    y: chassis.y + cfg.heightM,
    z: chassis.z + Math.cos(aimYaw) * cfg.muzzleForwardM,
  };
}

// --- fire gate -------------------------------------------------------------------------------

export interface FireGateParams {
  /** Fire only when the player is within this range (m). */
  readonly engagementRangeM: number;
  /** No firing while |lateral chassis speed| exceeds this (m/s). */
  readonly slipGateMps: number;
}

export function inEngagementRange(distM: number, cfg: FireGateParams): boolean {
  return distM <= cfg.engagementRangeM;
}

export function slipOk(lateralSpeedMps: number, cfg: FireGateParams): boolean {
  return Math.abs(lateralSpeedMps) <= cfg.slipGateMps;
}

/**
 * The full fire gate (pure/composable): a burst may START only when the player is in range, the
 * chassis isn't slipping sideways too hard, AND line of sight is clear. `losClear` is computed
 * by castBuildingClear (imperative — one raycast) and injected so this predicate stays pure and
 * directly testable without a Rapier world.
 */
export function canFire(p: {
  readonly distM: number;
  readonly lateralSpeedMps: number;
  readonly losClear: boolean;
  readonly cfg: FireGateParams;
}): boolean {
  return inEngagementRange(p.distM, p.cfg) && slipOk(p.lateralSpeedMps, p.cfg) && p.losClear;
}

// --- imperative LOS raycast ------------------------------------------------------------------

/**
 * Single raycast muzzle→target masked to BUILDING membership only (LOS_RAY_GROUPS): returns true
 * when NO building lies between the two points (line of sight clear), false when one blocks it.
 * `ray` is a caller-owned, reused Ray (no per-call allocation on the hot path); `excludeBody`
 * (the firing truck's own body) is skipped so the muzzle never self-blocks. A degenerate
 * near-zero span reads as clear. Props/ground/vehicles never block — see LOS_RAY_GROUPS.
 */
export function castBuildingClear(
  world: RapierWorld,
  ray: RapierRay,
  from: Vec3,
  to: Vec3,
  excludeBody?: RapierRigidBody,
): boolean {
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  let dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;
  dx /= dist;
  dy /= dist;
  dz /= dist;
  ray.origin.x = from.x;
  ray.origin.y = from.y;
  ray.origin.z = from.z;
  ray.dir.x = dx;
  ray.dir.y = dy;
  ray.dir.z = dz;
  const hit = world.castRay(ray, dist, true, undefined, LOS_RAY_GROUPS, undefined, excludeBody);
  return hit === null;
}

// --- turret state ----------------------------------------------------------------------------

/** A gun truck's turret: owns the world-space aim yaw and slews it toward the player. */
export class Turret {
  private aimYaw: number;

  constructor(initialYaw = 0) {
    this.aimYaw = wrapAngle(initialYaw);
  }

  /** Current world-space aim yaw (rad). The mesh reads this to orient the turret InstancedMesh. */
  get yaw(): number {
    return this.aimYaw;
  }

  /**
   * Damp the WORLD aim toward the player over one step. `chassis`/`target` are XZ positions; the
   * desired heading is chassis→target (the pivot rides the chassis), and the aim slews toward it
   * by at most `maxStepRad` (= yawRateDegPerSec × DEG2RAD × dt). Returns the new aim yaw.
   */
  track(
    chassis: { readonly x: number; readonly z: number },
    target: { readonly x: number; readonly z: number },
    maxStepRad: number,
  ): number {
    const desired = yawToward(target.x - chassis.x, target.z - chassis.z);
    this.aimYaw = dampAngle(this.aimYaw, desired, maxStepRad);
    return this.aimYaw;
  }
}

/** Convenience: max slew (rad) for one step at `dtSec` given a deg/s rate — the value track()'s
 * `maxStepRad` wants. */
export function maxYawStep(yawRateDegPerSec: number, dtSec: number): number {
  return yawRateDegPerSec * DEG2RAD * dtSec;
}
