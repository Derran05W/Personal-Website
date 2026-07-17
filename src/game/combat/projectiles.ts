// Tank shells (Phase 12 Task 1; TDD §5.6 "Shell = fast kinematic projectile, 45 m/s, flat
// trajectory, detonates on any contact"). The projectile HALF of the tank's gun (combat/
// explosion.ts is what the detonation does).
//
// --- Shell design verdict: PURE-POINT, no Rapier body -------------------------------------
// A shell is a simulated POINT advanced by TANK.shellSpeed × dt each physics step, with a
// per-step SWEEP raycast from its previous position to its new one (segment length = speed ×
// dt ≈ 0.75 m/step at 45 m/s). It detonates at the FIRST hit along that segment — anything but
// the firer, including the ground and buildings. Because the sweep covers the ENTIRE span the
// point would traverse between frames, the shell CANNOT tunnel through a thin obstacle however
// fast it flies — no CCD, no kinematic body, no contact-event plumbing needed. (A kinematic
// body would be heavier and still risk tunneling at high speed / low framerate; the point +
// sweep is strictly simpler and provably tunnel-free — see projectiles.test.ts.)
//
// The pool owns ≤ TANK.shell.poolSize concurrent shells and exposes getShellPositions() for the
// FX layer (Task 3) to render the shell mesh + smoke trail — this module keeps zero three.js /
// render state (trail coordination is left to Task 3 via those positions, not pushed into
// combat/tracerFeed.ts, which is bullet-tracer-specific).
//
// The imperative Rapier bits (the world sweep raycast) are isolated behind an injected ShellSweep
// so ShellPool's stepping, lifetime, recycle, and no-tunnel behavior are all unit-tested with a
// synthetic sweep and no Rapier world.

import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { CollisionGroup, TANK } from '../config';
import type { Vec3 } from './turret';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

/**
 * Shell sweep interaction groups: membership PROJECTILE, filter = everything a shell can
 * detonate on. Same construction as combat/hitscan.ts's BULLET_RAY_GROUPS but WITH PURSUIT
 * added — a shell physically striking another vehicle (incl. a police car) detonates there,
 * and the blast then hits friend and foe alike (TDD §5.6 friendly fire). GROUND is included so
 * a flat shot that meets the road detonates; the FIRING tank is excluded per-cast (below).
 */
export const SHELL_SWEEP_GROUPS =
  (CollisionGroup.PROJECTILE << 16) |
  (CollisionGroup.PLAYER |
    CollisionGroup.PURSUIT |
    CollisionGroup.CIVILIAN |
    CollisionGroup.PROP_STATIC |
    CollisionGroup.PROP_DYNAMIC |
    CollisionGroup.BUILDING |
    CollisionGroup.GROUND);

// --- pure helpers ----------------------------------------------------------------------------

/** Unit direction from a raw vector; a zero vector yields +Z (a harmless default — a shell is
 * always spawned with a real aim). Pure/testable. */
export function normalizeDir(x: number, y: number, z: number): Vec3 {
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) return { x: 0, y: 0, z: 1 };
  return { x: x / len, y: y / len, z: z / len };
}

/** The sweep segment length for one physics step at `speed` (m/s) over `dt` (s) — how far the
 * point travels, and therefore the maxToi of that step's sweep ray. Pure/testable. */
export function sweepSegLength(speed: number, dt: number): number {
  return speed * dt;
}

// --- sweep seam --------------------------------------------------------------------------------

/** Result of a per-step sweep: the time-of-impact along the segment + the collider hit, or null
 * if the segment is clear. */
export interface SweepHit {
  readonly toi: number;
  readonly colliderHandle: number;
}

/**
 * A per-step sweep: cast from (ox,oy,oz) along (dx,dy,dz) for up to `maxToi`, excluding the firer
 * body (`firerBodyHandle`, or < 0 for "no firer"), returning the first hit or null. Injected so
 * the pool is testable without Rapier; makeWorldSweep is the live implementation.
 */
export type ShellSweep = (
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxToi: number,
  firerBodyHandle: number,
) => SweepHit | null;

/** Detonation callback (combat/explosion.ts's detonate, bound to a live world in the mount). */
export type ShellDetonate = (x: number, y: number, z: number) => void;

/** Build the live world sweep: a reused Ray + world.castRay masked to SHELL_SWEEP_GROUPS,
 * excluding the firing tank's body so a shell never detonates on its own barrel. Resolving the
 * firer handle each call tolerates the tank despawning mid-flight (getRigidBody → skip). */
export function makeWorldSweep(world: RapierWorld, rapier: RapierNamespace): ShellSweep {
  const ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  return (ox, oy, oz, dx, dy, dz, maxToi, firerBodyHandle) => {
    ray.origin.x = ox;
    ray.origin.y = oy;
    ray.origin.z = oz;
    ray.dir.x = dx;
    ray.dir.y = dy;
    ray.dir.z = dz;
    let excludeBody: RapierRigidBody | undefined;
    if (firerBodyHandle >= 0) {
      try {
        excludeBody = world.getRigidBody(firerBodyHandle) ?? undefined;
      } catch {
        excludeBody = undefined; // firer already gone
      }
    }
    const hit = world.castRay(ray, maxToi, true, undefined, SHELL_SWEEP_GROUPS, undefined, excludeBody);
    if (hit === null) return null;
    return { toi: hit.timeOfImpact, colliderHandle: hit.collider.handle };
  };
}

// --- shell pool --------------------------------------------------------------------------------

interface ShellSlot {
  active: boolean;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  ageSec: number;
  firer: number;
  seq: number; // acquisition order (oldest = smallest) for full-pool eviction
}

export interface ShellPoolDeps {
  readonly sweep: ShellSweep;
  readonly detonate: ShellDetonate;
  /** Defaults to TANK.shellSpeed / TANK.shell.* — overridable for tests. */
  readonly speed?: number;
  readonly lifetimeSec?: number;
  readonly poolSize?: number;
}

/**
 * Fixed pool of pure-point shells. spawn() acquires a slot (recycling the oldest live shell if
 * full so a fire never fails); step() advances every live shell one physics step, sweeping for a
 * hit and detonating at the first contact, and recycles shells that detonate or outlive their cap.
 */
export class ShellPool {
  private readonly sweep: ShellSweep;
  private readonly detonate: ShellDetonate;
  private readonly speed: number;
  private readonly lifetimeSec: number;
  private readonly slots: ShellSlot[] = [];
  private readonly free: number[] = [];
  private seq = 0;

  constructor(deps: ShellPoolDeps) {
    this.sweep = deps.sweep;
    this.detonate = deps.detonate;
    this.speed = deps.speed ?? TANK.shellSpeed;
    this.lifetimeSec = deps.lifetimeSec ?? TANK.shell.lifetimeSec;
    const size = deps.poolSize ?? TANK.shell.poolSize;
    for (let i = 0; i < size; i++) {
      this.slots.push({ active: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, ageSec: 0, firer: -1, seq: 0 });
      this.free.push(size - 1 - i); // pop() hands out 0,1,2,… first
    }
  }

  /** Number of shells currently in flight. */
  activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.active) n++;
    return n;
  }

  /**
   * Fire a shell from `origin` along `dir` (normalized here), excluding `firerBodyHandle` from
   * its sweeps (pass < 0 for no firer). Recycles the oldest live shell if the pool is full so a
   * fire is never dropped — only reachable if > poolSize shells are somehow concurrently live,
   * which the ★5 cadence never produces.
   */
  spawn(firerBodyHandle: number, origin: Vec3, dir: Vec3): void {
    const idx = this.free.pop() ?? this.evictOldest();
    const d = normalizeDir(dir.x, dir.y, dir.z);
    const s = this.slots[idx];
    s.active = true;
    s.x = origin.x;
    s.y = origin.y;
    s.z = origin.z;
    s.dx = d.x;
    s.dy = d.y;
    s.dz = d.z;
    s.ageSec = 0;
    s.firer = firerBodyHandle;
    s.seq = this.seq++;
  }

  /** Advance every live shell one physics step: sweep [pos → pos + dir·segLen]; detonate at the
   * first hit (incl. ground) and recycle; else advance and recycle once past the lifetime cap. */
  step(dt: number): void {
    const segLen = sweepSegLength(this.speed, dt);
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      const hit = this.sweep(s.x, s.y, s.z, s.dx, s.dy, s.dz, segLen, s.firer);
      if (hit !== null) {
        const px = s.x + s.dx * hit.toi;
        const py = s.y + s.dy * hit.toi;
        const pz = s.z + s.dz * hit.toi;
        this.recycle(i);
        this.detonate(px, py, pz);
        continue;
      }
      s.x += s.dx * segLen;
      s.y += s.dy * segLen;
      s.z += s.dz * segLen;
      s.ageSec += dt;
      if (s.ageSec >= this.lifetimeSec) this.recycle(i);
    }
  }

  /** Snapshot of live shell positions for the FX layer (Task 3) to render mesh + trail. Freshly
   * allocated (≤ poolSize entries — cheap); called at most once per render frame. */
  getShellPositions(): Vec3[] {
    const out: Vec3[] = [];
    for (const s of this.slots) if (s.active) out.push({ x: s.x, y: s.y, z: s.z });
    return out;
  }

  /** Drop every live shell (world teardown / remount). */
  clear(): void {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].active) this.recycle(i);
    }
  }

  private recycle(index: number): void {
    const s = this.slots[index];
    if (!s.active) return;
    s.active = false;
    this.free.push(index);
  }

  /** Full-pool fallback: recycle (silently drop) the oldest live shell and return its slot so a
   * spawn always succeeds. Unreachable under real ★5 fire cadence — documented in spawn(). */
  private evictOldest(): number {
    let oldest = 0;
    let oldestSeq = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].active && this.slots[i].seq < oldestSeq) {
        oldestSeq = this.slots[i].seq;
        oldest = i;
      }
    }
    this.slots[oldest].active = false;
    return oldest;
  }
}

// --- live-instance ref (Phase 12: tank unit fires through this; debug bridge drives it) --------

/** What ai/units/tank.ts (Task 2) fires through, the FX layer (Task 3) reads positions from, and
 * the debug bridge drives. Published by combat/ProjectilesMount while a run is live. */
export interface ProjectilesApi {
  /** Fire a shell (see ShellPool.spawn). */
  spawn(firerBodyHandle: number, origin: Vec3, dir: Vec3): void;
  /** Shells currently in flight. */
  activeCount(): number;
  /** Live shell positions for FX rendering. */
  getShellPositions(): Vec3[];
  /** Detonate an explosion directly at a point (no shell) — debug ("blast here"). */
  blastAt(x: number, y: number, z: number): void;
}

/** Module-scope live handle (mirrors ai/pursuitTypes.ts's unitsRef / world/propDynamics.ts's
 * activeController). null when no run is mounted. */
export const projectilesRef: { current: ProjectilesApi | null } = { current: null };
