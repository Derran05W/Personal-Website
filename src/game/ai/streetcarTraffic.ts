// Streetcar traffic system (Phase 19 Task 3; TDD §13 "Streetcars as heavy civilian traffic on
// two avenues"). A tiny, tier-scaled, FIXED-size roster of long, slow, implacable kinematic
// followers that drive world.landmarks.streetcarAvenues (Phase 19 Task 1's concurrent seam)
// there-and-back, converting to a dynamic wreck on a hard enough player ram — the same lifecycle
// shape as ai/traffic.ts's civilian cars, deliberately EXTENDED rather than forked:
//   - reuses traffic.ts's pure yaw/quat/wreck helpers (yawTo, quatFromYaw, upDotFromQuat,
//     stepYaw, tickWreck, convertibleHandle) so a streetcar turns, flips, and wrecks with
//     exactly the same feel math as a regular car;
//   - reuses traffic.ts's exported collision-group/ray constants (PHYSICS_STEP_SEC,
//     RAY_HEIGHT_M, CIVILIAN_GROUPS, BLOCK_RAY_GROUPS) so streetcars collide/ray-cast against
//     the identical CIVILIAN group a regular car does — a car's own block-ray sees a stopped
//     streetcar "for free", no changes needed on that side (see traffic.ts's Phase 19 header
//     note and this task's report for why: a Rapier ray hits any collider surface it crosses,
//     regardless of that collider's length);
//   - registers kind: 'civilian' in world/registry.ts, same as a regular car, so combat/
//     damage.ts's generic hp-draining path (applyEntityDamage) "just works" unchanged — a
//     streetcar's hp drains using the PLAYER's mass factor exactly like a regular civ's does
//     (massFactorOf(other=player)); the registry gets one new optional marker field
//     (EntityEntry.isStreetcar) so consumers can tell a streetcar's entry apart from a
//     regular car's, deliberately NOT wired into massFactorOf — see registry.ts's doc comment
//     and this task's report for the full "verified, not extended" writeup on the damage path.
//
// What's genuinely NEW (not reused) is the path-following data model: a streetcar does not
// walk ai/traffic.ts's branching TrafficGraph at all — it drives a fixed OPEN polyline (an
// "avenue", world/types.ts's LanePath — a median centerline from one end of an arterial to the
// other) THERE AND BACK, reversing at each tip (world/landmarks.ts's buildStreetcarAvenues doc
// comment: "Task 3 turns it into a there-and-back loop"), so the cursor/advance/point math below
// is its own small family, shaped like traffic.ts's PathCursor/advanceCursor/cursorPoint but
// without any turn-choice branching (there is exactly one "next" segment either way — forward
// toward the far tip, or backward toward the near one).
//
// --- landmark seam (Task 1, concurrent) ------------------------------------------------------
// Phase 19 Task 1 (world generation) is landing `world.landmarks.streetcarAvenues: LanePath[]`
// on WorldData CONCURRENTLY with this task (see CLAUDE.md's phase-19 task table) — by design,
// this module never imports a `landmarks`-typed symbol from world/generate.ts or world/types.ts
// (both are Task 1's own files, off limits here), so it compiles and runs correctly whether
// Task 1 has landed yet or not: getStreetcarAvenues() below reads `world` through a LOCAL
// structural type (duck-typed on x/z points) and validates every path at runtime. Absent,
// empty, or malformed data on `world` simply yields an empty avenue list, and every consumer
// downstream (the controller's constructor, ai/StreetcarMount.tsx) treats an empty list as "no
// streetcars, everything else unchanged" — this task's explicit defensive-coding requirement.
//
// --- lifecycle (per StreetcarSlot) -----------------------------------------------------------
//   null → 'driving'    initial spawn (constructor) or recycle: kinematic body placed on its
//                        assigned avenue loop.
//   'driving' → 'converted'  a player ram ≥ TRAFFIC_STREETCAR.convertForceThreshold swaps it to
//                        a dynamic body, inheriting loop-direction velocity + a kick; civHit
//                        fires once. UNLIKE ai/traffic.ts's civilian conversion, this does NOT
//                        yield to the monster-truck crush path (combat/playerSpecials.ts) —
//                        that seam only ever calls trafficRef (regular civs); a monster-truck
//                        hit on a streetcar safely falls through to this normal force-threshold
//                        path instead (verified, see this task's report — no code change needed
//                        there, trafficRef.crush() no-ops on a handle it doesn't own).
//   'converted' → 'wrecked'  sustained flip (up-dot < wreckUpDot) OR hp ≤ 0; civWrecked once.
//   any → recycled       TRAFFIC_STREETCAR.wreckLingerSec after conversion/wreck: the dynamic
//                        body + registry entry are torn down and the SAME slot id respawns onto
//                        its assigned avenue at a fresh random point — UNLIKE ai/traffic.ts's
//                        pool, there is no despawn-by-player-distance and no free/pooled state:
//                        the roster is small and fixed, and streetcars circulate regardless of
//                        where the player is (an "implacable... transit route", not a
//                        proximity-spawned crowd).

import { getCarDef } from '../vehicles/definitions';
import { playerVehicle } from '../vehicles/playerRef';
import { TRAFFIC_STREETCAR, trafficActiveTarget, type QualityTier, type StreetcarTuning } from '../config';
import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { gameEvents } from '../state/events';
import { getGameState } from '../state/store';
import { getEntity, registerEntity, unregisterEntity } from '../world/registry';
import { createRng, type Rng } from '../world/rng';
import type { ImpactRecord } from '../combat/types';
import type { StreetcarApi, StreetcarSlot } from './streetcarTypes';
import {
  BLOCK_RAY_GROUPS,
  CIVILIAN_GROUPS,
  PHYSICS_STEP_SEC,
  RAY_HEIGHT_M,
  convertibleHandle,
  quatFromYaw,
  stepYaw,
  tickWreck,
  upDotFromQuat,
  yawTo,
} from './traffic';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

const EPS = 1e-4;
// Safety cap on segment transitions consumed in one advanceAvenueCursor call. Per-frame travel
// is speed*dt (<= 6 * 1/60 = 0.1 m at TRAFFIC_STREETCAR.speedMps), and avenue segments are
// typically many metres long, so one transition per step is the norm — this only guards a
// pathological huge dt or a degenerate near-zero-length segment (mirrors ai/traffic.ts's
// MAX_ADVANCE_ITERS).
const MAX_AVENUE_ADVANCE_ITERS = 8;

// ===========================================================================================
// Avenue path math (pure; unit-tested; no Rapier/three)
// ===========================================================================================

export interface AvenuePoint {
  readonly x: number;
  readonly z: number;
}

/** An avenue's route — an ordered list of world-space points (world/types.ts's LanePath.points:
 * Task 1's median centerline of one full arterial, one end of the map to the other). Walked as
 * a THERE-AND-BACK bounce, never a closed loop: world/landmarks.ts's buildStreetcarAvenues doc
 * comment is explicit — "Task 3 turns it into a there-and-back loop" — because an avenue is an
 * OPEN line (it doesn't return to its start via any real street), so the only realistic way to
 * "loop" it is to drive to one end and reverse, exactly like a real streetcar route's two-way
 * single track. See AvenueCursor's `dir` field. */
export type AvenuePath = readonly AvenuePoint[];

/** Length (m) of the segment from point `i` to point `i+1`. No wraparound — `i` must be in
 * [0, path.length - 2]. */
export function avenueSegLength(path: AvenuePath, i: number): number {
  const a = path[i];
  const b = path[i + 1];
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** One-way length of `path` (start to end, no return leg). Degenerate (<2 points) → 0. */
export function avenueOneWayLength(path: AvenuePath): number {
  if (path.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += avenueSegLength(path, i);
  return total;
}

/** Full there-and-back cycle length: twice the one-way length (drive to the far end, then all
 * the way back). Degenerate (<2 points) → 0. */
export function avenueRoundTripLength(path: AvenuePath): number {
  return avenueOneWayLength(path) * 2;
}

/**
 * Phase 31 (Part-8, wrong-way lane fix) — cursor traversal mode: 'bounce' is the P19 default
 * (an OPEN avenue, driven there-and-back, reflecting at each tip — see AvenuePath's own doc
 * comment for why); 'loop' is a CLOSED path (world/toronto/transitRoutes.ts builds a bus route
 * this way: outbound leg on the direction-correct lane, return leg on the OPPOSITE lane, joined
 * at both tips so the path's own last point coincides with its first) walked forward forever,
 * wrapping straight back to index 0 instead of ever reflecting. Every function below defaults to
 * 'bounce' so every pre-Phase-31 call site (every existing test, ai/StreetcarMount.tsx's legacy
 * streetcars, this file's own Toronto streetcar mount) is unaffected — only the Toronto BUS
 * mount opts into 'loop' (ai/streetcarTraffic.ts's StreetcarControllerOptions.pathMode).
 */
export type AvenueCursorMode = 'bounce' | 'loop';

/** Full cycle length under a cursor mode: the there-and-back round trip (2x one-way) for
 * 'bounce', or the path's own one-way length for 'loop' (a loop path is already closed back to
 * its own start — see AvenueCursorMode's doc comment — so walking it once already completes the
 * cycle; doubling it would drive the loop twice per "round trip"). Used wherever a caller needs
 * "how far can a streetcar/bus travel before it's back where it started" (roster seeding,
 * recycle placement). */
export function avenueCycleLength(path: AvenuePath, mode: AvenueCursorMode = 'bounce'): number {
  return mode === 'loop' ? avenueOneWayLength(path) : avenueRoundTripLength(path);
}

/** A streetcar's position along its avenue: which segment it's on, that segment's length, how
 * far along it (ALWAYS measured as distance from `path[segIndex]`, regardless of `dir` — see
 * avenueCursorPoint), and which way it's currently travelling. `dir: 1` means advancing toward
 * higher segment indices (toward the far end of the path); `dir: -1` means returning toward
 * index 0. Mutated in place by advanceAvenueCursor. */
export interface AvenueCursor {
  segIndex: number;
  segLenM: number;
  progressM: number;
  dir: 1 | -1;
}

/**
 * Cursor at exactly `distanceM` along the there-and-back cycle (see avenueRoundTripLength),
 * wrapped via modulo (negative or huge distances both resolve correctly) and reflected at
 * whichever end the folded distance lands past the one-way length — computed directly from
 * cumulative segment lengths rather than stepping, so it has no iteration cap and is safe to
 * call with an arbitrary distance. Used once per spawn/recycle to place a streetcar at a
 * starting point (and direction); advanceAvenueCursor below is the bounded PER-FRAME stepper.
 * Degenerate paths (<2 points, or a ~zero-length line) return a zero-length cursor.
 */
/** Walk `path` forward `posFromStart` metres from index 0 (no reflection/wraparound — the
 * caller has already folded `posFromStart` into whatever range is valid for its mode), landing
 * on the segment/progress that distance reaches, facing `dir`. Shared tail of both
 * avenueCursorAtDistance branches below (bounce's forward/return legs and loop's single forward
 * walk are all "some distance from index 0, facing some direction" once folded). */
function cursorAtPosFromStart(path: AvenuePath, posFromStart: number, dir: 1 | -1): AvenueCursor {
  const n = path.length;
  let remaining = posFromStart;
  for (let i = 0; i < n - 1; i++) {
    const segLen = Math.max(EPS, avenueSegLength(path, i));
    if (remaining < segLen || i === n - 2) {
      return { segIndex: i, segLenM: segLen, progressM: Math.min(remaining, segLen), dir };
    }
    remaining -= segLen;
  }
  // Unreachable in practice (the loop above always returns once i === n-2) — kept as a typed,
  // safe fallback rather than a non-null assertion.
  return { segIndex: 0, segLenM: Math.max(EPS, avenueSegLength(path, 0)), progressM: 0, dir };
}

export function avenueCursorAtDistance(path: AvenuePath, distanceM: number, mode: AvenueCursorMode = 'bounce'): AvenueCursor {
  const n = path.length;
  if (n < 2) return { segIndex: 0, segLenM: EPS, progressM: 0, dir: 1 };
  const oneWay = avenueOneWayLength(path);
  if (oneWay <= EPS) return { segIndex: 0, segLenM: EPS, progressM: 0, dir: 1 };

  if (mode === 'loop') {
    // Closed path (see AvenueCursorMode's doc comment: the path's own last point already
    // coincides with its first), walked forward forever — fold into [0, oneWay) and always face
    // forward; there is no "return leg" to reflect onto.
    const wrapped = ((distanceM % oneWay) + oneWay) % oneWay;
    return cursorAtPosFromStart(path, wrapped, 1);
  }

  const roundTrip = oneWay * 2;
  const wrapped = ((distanceM % roundTrip) + roundTrip) % roundTrip; // fold into [0, roundTrip)
  const dir: 1 | -1 = wrapped <= oneWay ? 1 : -1;
  // Distance from the START of the path (index 0), regardless of dir: the forward leg reads
  // straight off `wrapped`; the return leg mirrors it back down from oneWay.
  const posFromStart = dir === 1 ? wrapped : roundTrip - wrapped;
  return cursorAtPosFromStart(path, posFromStart, dir);
}

/**
 * Advance a cursor `distance` metres (always >= 0 — callers pass speed*dt) in its CURRENT
 * direction, reflecting (flipping `dir` and continuing into the same segment from the other
 * end) on reaching either tip of the open path instead of wrapping — see AvenuePath's doc
 * comment for why a there-and-back bounce, not a closed loop, is the correct shape here.
 * No-ops on a degenerate path (<2 points).
 */
export function advanceAvenueCursor(
  path: AvenuePath,
  c: AvenueCursor,
  distance: number,
  mode: AvenueCursorMode = 'bounce',
): void {
  if (path.length < 2) return;
  let remaining = distance;
  let iters = 0;
  while (remaining > 0 && iters < MAX_AVENUE_ADVANCE_ITERS) {
    iters++;
    if (c.dir === 1) {
      const roomLeft = c.segLenM - c.progressM;
      if (remaining < roomLeft) {
        c.progressM += remaining;
        remaining = 0;
      } else {
        remaining -= roomLeft;
        if (c.segIndex >= path.length - 2) {
          if (mode === 'loop') {
            // Closed path — the far tip of this (last) segment already coincides with path[0]
            // (see AvenueCursorMode's doc comment / world/toronto/transitRoutes.ts's bus loop
            // construction), so continue straight into the first segment instead of reflecting.
            c.segIndex = 0;
            c.segLenM = Math.max(EPS, avenueSegLength(path, 0));
            c.progressM = 0;
            // dir stays 1 — a loop never reverses.
          } else {
            // Reached the far tip of the path — reflect. Stay on this (last) segment, now
            // counting DOWN from its far end.
            c.dir = -1;
            c.progressM = c.segLenM;
          }
        } else {
          c.segIndex += 1;
          c.segLenM = Math.max(EPS, avenueSegLength(path, c.segIndex));
          c.progressM = 0;
        }
      }
    } else {
      const roomLeft = c.progressM;
      if (remaining < roomLeft) {
        c.progressM -= remaining;
        remaining = 0;
      } else {
        remaining -= roomLeft;
        if (c.segIndex <= 0) {
          // Reached the near tip (the path's own start) — reflect, now counting UP again.
          c.dir = 1;
          c.progressM = 0;
        } else {
          c.segIndex -= 1;
          c.segLenM = Math.max(EPS, avenueSegLength(path, c.segIndex));
          c.progressM = c.segLenM;
        }
      }
    }
  }
}

/** Interpolated point (fraction of the way along the cursor's current segment, from
 * `path[segIndex]` toward `path[segIndex + 1]` — this is direction-independent, see
 * AvenueCursor's doc comment), written into `out`. */
export function avenueCursorPoint(
  path: AvenuePath,
  c: AvenueCursor,
  out: { x: number; z: number },
): { x: number; z: number } {
  const a = path[c.segIndex];
  const b = path[c.segIndex + 1];
  const t = c.segLenM > EPS ? c.progressM / c.segLenM : 0;
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/** Raw (non-normalized) direction of TRAVEL at the cursor's current position — the segment's
 * own direction (path[segIndex] -> path[segIndex+1]) on the forward leg, NEGATED on the return
 * leg (dir === -1) so a reflected streetcar visibly turns around instead of driving backward.
 * Feed straight into ai/traffic.ts's yawTo (atan2-based, scale-invariant, so no normalize
 * needed here). */
export function avenueCursorHeading(path: AvenuePath, c: AvenueCursor): { dx: number; dz: number } {
  const a = path[c.segIndex];
  const b = path[c.segIndex + 1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return c.dir === 1 ? { dx, dz } : { dx: -dx, dz: -dz };
}

// ===========================================================================================
// Hold resolution (pure; no creep — see TRAFFIC_STREETCAR's doc comment)
// ===========================================================================================

/**
 * Streetcar hold resolution: UNLIKE ai/traffic.ts's resolveHold, there is no anti-deadlock
 * creep escape. A blocked streetcar stops dead and stays there — full stop, however long it
 * takes (the phase brief: streetcars are "implacable ... never deadlock-creep [through a
 * blocker]"). The anti-deadlock escape valve remains exclusively a CAR behaviour
 * (TRAFFIC_CIV.holdCapSec / creepSpeedMps via resolveHold, entirely unchanged by this file) —
 * documented as safe here because a streetcar itself never permanently gridlocks the road:
 * everything it can be blocked BY eventually clears on its own (a wrecked civilian despawns
 * after TRAFFIC_CIV.wreckLingerSec, a wrecked streetcar recycles after
 * TRAFFIC_STREETCAR.wreckLingerSec, the player moves on) — and a STOPPED streetcar is itself
 * just another stationary obstacle, exactly like a parked car or a building, that a queued
 * CAR's own creep already knows how to route through once its OWN hold cap trips. No new
 * gridlock shape is introduced; see this task's report for the full queueing writeup.
 */
export function resolveStreetcarHold(isBlocked: boolean, cruiseSpeed: number): number {
  return isBlocked ? 0 : cruiseSpeed;
}

// ===========================================================================================
// Landmark seam — defensive read of world.landmarks.streetcarAvenues (see file header)
// ===========================================================================================

// world/types.ts's real shape (confirmed against world/landmarks.ts's buildStreetcarAvenues):
// `world.landmarks?.streetcarAvenues: readonly LanePath[]` where `LanePath = { axis, roadIndex,
// roadId, points: readonly {x,z}[] }` — each avenue is an OBJECT wrapping its point list, not a
// bare point array. This local structural type mirrors only the shape actually read (`.points`)
// so this module still compiles and behaves correctly independent of world/types.ts's exact
// LanePath fields (never imports it — see this file's header).
interface WorldWithLandmarks {
  readonly landmarks?: {
    readonly streetcarAvenues?: readonly unknown[];
  };
}

function isPointArray(points: unknown): points is AvenuePath {
  if (!Array.isArray(points) || points.length < 2) return false;
  for (const p of points) {
    if (typeof p !== 'object' || p === null) return false;
    const rec = p as Record<string, unknown>;
    if (typeof rec.x !== 'number' || typeof rec.z !== 'number') return false;
    if (!Number.isFinite(rec.x) || !Number.isFinite(rec.z)) return false;
  }
  return true;
}

/** Pulls a usable AvenuePath out of one `streetcarAvenues` entry: the real LanePath shape
 * (`{ points: [...] }`) primarily, with a bare point-array also accepted (defensive fallback —
 * costs nothing, and protects against a future/alternate shape that skips the wrapper).
 * Undefined when neither shape matches or the points are too few/malformed. */
function extractAvenuePath(entry: unknown): AvenuePath | undefined {
  if (isPointArray(entry)) return entry;
  if (typeof entry === 'object' && entry !== null) {
    const points = (entry as { points?: unknown }).points;
    if (isPointArray(points)) return points;
  }
  return undefined;
}

/**
 * Every valid avenue path on `world.landmarks.streetcarAvenues` (Task 1's seam), or an empty
 * array when the field is absent, empty, or malformed — see this file's header. `world` is
 * typed `unknown` on purpose: this function must compile and behave correctly whether or not
 * WorldData has landed a `landmarks` field yet (a caller with a real WorldData value simply
 * widens it to `unknown` at the call site, which TypeScript always permits).
 */
export function getStreetcarAvenues(world: unknown): readonly AvenuePath[] {
  const landmarks = (world as WorldWithLandmarks | null | undefined)?.landmarks;
  const avenues = landmarks?.streetcarAvenues;
  if (!Array.isArray(avenues)) return [];
  const result: AvenuePath[] = [];
  for (const entry of avenues) {
    const path = extractAvenuePath(entry);
    if (path !== undefined) result.push(path);
  }
  return result;
}

// ===========================================================================================
// Controller (Rapier + registry; owns the fixed roster's bodies behind the pose slots)
// ===========================================================================================

interface InternalStreetcar {
  body: RapierRigidBody | null;
  colliderHandle: number; // registry key; −1 when torn down (between recycle() and its respawn)
  avenueIdx: number;
  cursor: AvenueCursor;
  lastMoveSpeed: number; // effective speed last kinematic step (conversion inherits it)
  civHitEmitted: boolean;
  flipSec: number;
  wrecked: boolean;
  convertedAt: number;
  wreckedAt: number;
}

function freshCursor(): AvenueCursor {
  return { segIndex: 0, segLenM: EPS, progressM: 0, dir: 1 };
}

function freshInternal(): InternalStreetcar {
  return {
    body: null,
    colliderHandle: -1,
    avenueIdx: 0,
    cursor: freshCursor(),
    lastMoveSpeed: 0,
    civHitEmitted: false,
    flipSec: 0,
    wrecked: false,
    convertedAt: 0,
    wreckedAt: 0,
  };
}

function freshSlot(id: number, hp: number): StreetcarSlot {
  return {
    id,
    state: null,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    dynamic: false,
    hp,
  };
}

/** Phase 31 (Part-8 D2) — optional per-call overrides. Additive only: every field is optional
 * and every legacy call site (ai/StreetcarMount.tsx, this file's own tests) that omits `options`
 * entirely gets EXACTLY the pre-Phase-31 behaviour (TRAFFIC_STREETCAR tuning, redRocket chassis,
 * tier-scaled roster via trafficActiveTarget) — see the constructor's own doc comment. This is
 * the "extend config/params, don't fork the controller" seam the phase brief calls for: Toronto
 * buses and Toronto streetcars are both driven by THIS SAME class, differing only in the values
 * passed here (config/torontoTransit.ts's TTC_BUS_TUNING/TTC_STREETCAR_TUNING + a bus chassis
 * override), never a duplicated copy of this file. */
export interface StreetcarControllerOptions {
  /** Tuning values in place of TRAFFIC_STREETCAR (same shape — config/streetcar.ts's
   * StreetcarTuning type). */
  readonly config?: StreetcarTuning;
  /** Collider/body half-extents in place of PLAYER_CARS.redRocket's chassis (e.g. a bus's own
   * resolved dims — config/torontoTransit.ts's busChassisHalfExtents()). */
  readonly chassis?: { readonly halfWidth: number; readonly halfHeight: number; readonly halfLength: number };
  /** When true, the roster size is `avenues.length` EXACTLY (no trafficActiveTarget tier
   * re-scaling) — the caller has already built `avenues` as a seeded, weighted, pre-assigned
   * per-slot polyline list (world/toronto/transitRoster.ts), so `id % avenues.length` degenerates
   * to `id` and every slot gets precisely the route it was assigned, not a round-robin cycle.
   * Default false preserves the legacy (P19) tier-scaled-independent-of-avenues-count sizing. */
  readonly exactRosterSize?: boolean;
  /** Registry `EntityEntry.isStreetcar` marker value (world/registry.ts — informational only,
   * not wired into damage math). Defaults true (every pre-Phase-31 caller of this class IS a
   * streetcar); Toronto's bus mount passes `false` so a bus registers honestly. */
  readonly isStreetcarEntry?: boolean;
  /** Cursor traversal mode (AvenueCursorMode) applied uniformly to every avenue this controller
   * owns. Defaults 'bounce' — the P19 there-and-back reflection every legacy caller (including
   * Toronto's OWN streetcar mount, deliberately unchanged) already gets. Toronto's bus mount
   * passes 'loop': world/toronto/transitRoutes.ts resolves each bus route as an explicit closed
   * loop (outbound lane one way, return lane the other, joined at the tips), so a bus should
   * wrap forward through it forever rather than ever reflecting into the oncoming lane (the
   * live-diagnosed Phase 31 wrong-way bug this option fixes). */
  readonly pathMode?: AvenueCursorMode;
  /** Per-avenue starting phase as a fraction of the avenue's cycle length, parallel to
   * `avenues`. Under `exactRosterSize`, `id % avenues.length` degenerates to `id`, so
   * seedRoster's own per-avenue rank/count spread always resolves to rank 0 of count 1 —
   * every slot starts at distance 0, and slots ASSIGNED THE SAME ROUTE (duplicate polylines,
   * invisible to this controller) spawn co-located and drive in lockstep (live-found Phase 31:
   * the three route-97 buses superimposed). The assigner (world/toronto/transitRoster.ts)
   * knows which slots share a route and passes their spread here. Omitted → the legacy
   * rank/count formula, byte-identical for every pre-Phase-31 caller. */
  readonly startFracs?: readonly number[];
}

export class StreetcarController {
  private readonly world: RapierWorld;
  private readonly rapier: RapierNamespace;
  private readonly avenues: readonly AvenuePath[];
  private readonly cfg: StreetcarTuning;
  private readonly isStreetcarEntry: boolean;
  private readonly pathMode: AvenueCursorMode;
  private readonly startFracs: readonly number[] | undefined;

  private readonly slots: StreetcarSlot[];
  private readonly internal: InternalStreetcar[];
  private readonly handleToSlot = new Map<number, number>();
  private readonly rng: Rng;

  // Body dims read LIVE off PLAYER_CARS.redRocket's own resolved chassis by default (same source
  // vehicles/meshes/RedRocketMesh.tsx paints over) — one source of truth for "reuses
  // RedRocketMesh's proportions" (this task's brief) — or `options.chassis` when provided.
  private readonly halfExtents: readonly [number, number, number];
  private readonly colliderCenterY: number;
  private readonly frontProbeM: number;

  private simTime = 0;

  // Hot-path scratch — a single reused Ray + its origin/dir vectors, and a point buffer, so
  // movement/ray casts never allocate (mirrors ai/traffic.ts's TrafficController).
  private readonly rayOrigin = { x: 0, y: RAY_HEIGHT_M, z: 0 };
  private readonly rayDir = { x: 0, y: 0, z: 0 };
  private readonly ray: InstanceType<RapierNamespace['Ray']>;
  private readonly scratchPoint = { x: 0, z: 0 };

  readonly api: StreetcarApi;

  constructor(
    world: RapierWorld,
    rapier: RapierNamespace,
    avenues: readonly AvenuePath[],
    seed: number,
    options?: StreetcarControllerOptions,
  ) {
    this.world = world;
    this.rapier = rapier;
    this.avenues = avenues;
    this.cfg = options?.config ?? TRAFFIC_STREETCAR;
    this.isStreetcarEntry = options?.isStreetcarEntry ?? true;
    this.pathMode = options?.pathMode ?? 'bounce';
    this.startFracs = options?.startFracs;
    this.rng = createRng(seed).fork('streetcar');

    const quality: QualityTier = getGameState().settings.quality;
    // Defensive-coding requirement (this task's brief): no valid avenues → a zero-size roster,
    // permanently. Every loop below (stepBefore/stepAfter) is then naturally a no-op over an
    // empty `slots` array — no extra guards needed anywhere else in this class.
    const size =
      avenues.length === 0 ? 0 : options?.exactRosterSize ? avenues.length : trafficActiveTarget(this.cfg.activeTarget, quality);
    this.slots = Array.from({ length: size }, (_, i) => freshSlot(i, this.cfg.hp));
    this.internal = Array.from({ length: size }, () => freshInternal());

    const chassis = options?.chassis ?? getCarDef('redRocket').controller.chassis;
    this.halfExtents = [chassis.halfWidth, chassis.halfHeight, chassis.halfLength];
    this.colliderCenterY = chassis.halfHeight;
    this.frontProbeM = chassis.halfLength; // ray starts at the front bumper, same convention as traffic.ts

    this.ray = new rapier.Ray(this.rayOrigin, this.rayDir);

    this.api = {
      slots: this.slots,
      activeCount: () => this.slots.reduce((n, s) => n + (s.state !== null ? 1 : 0), 0),
    };

    // Roster seeding is DEFERRED to the first stepBefore() (see seedRoster below), NOT done
    // here. Root-caused live at Phase 19 integration: creating raw Rapier bodies inside the
    // mount effect and then removing them in React StrictMode's immediate dev cleanup — all
    // BEFORE the world has ever stepped — panics Rapier's wasm ("unreachable" in
    // rbNumColliders, then the world is poisoned with "recursive use of an object" on every
    // later create). Every other body-creating system in this codebase (traffic pool fill,
    // prop swaps, unit factories) only ever creates bodies DURING live physics stepping, which
    // is why none of them ever hit this. Deferring to the first step reproduces exactly that
    // proven lifecycle — and as a bonus, no streetcar bodies exist at all until the first run
    // actually starts stepping (Physics is paused outside PLAYING).
  }

  /** One-shot roster placement, evenly spread across each avenue's ROUND-TRIP cycle (some
   * streetcars start on the return leg — a mid-cycle spread reads as live two-way service
   * from the first frame). UNLIKE ai/traffic.ts's ring-based per-step fill there is no spawn
   * budget: the roster is fully seeded in one call (>=1 valid avenue) or permanently empty
   * (size 0, the "no avenues data" path in the constructor). Called from stepBefore(). */
  private seeded = false;

  private seedRoster(): void {
    this.seeded = true;
    const avenues = this.avenues;
    const size = this.slots.length;
    if (avenues.length === 0 || size === 0) return;
    const perAvenueCount = new Array(avenues.length).fill(0) as number[];
    for (let id = 0; id < size; id++) perAvenueCount[id % avenues.length]++;
    const rankSoFar = new Array(avenues.length).fill(0) as number[];
    for (let id = 0; id < size; id++) {
      const avenueIdx = id % avenues.length;
      const rank = rankSoFar[avenueIdx]++;
      const count = perAvenueCount[avenueIdx];
      const cycleLen = avenueCycleLength(avenues[avenueIdx], this.pathMode);
      // startFracs (options) wins when provided — the caller's per-slot phase for duplicate
      // routes the per-avenue rank/count spread can't see (see StreetcarControllerOptions).
      // The fallback IS the legacy formula ((cycleLen / count) * rank), expressed as a fraction.
      const frac = this.startFracs?.[avenueIdx] ?? (count > 0 ? rank / count : 0);
      this.spawn(id, avenueIdx, cycleLen * frac);
    }
  }

  // --- kinematic movement (useBeforePhysicsStep) -------------------------------------------

  /** Advance every driving streetcar one kinematic step: block-ray hold (no creep — see
   * resolveStreetcarHold), avenue-loop advance, smooth yaw, and push the result onto the body
   * via setNextKinematic* so Rapier generates contacts (never useFrame for kinematic motion). */
  stepBefore(): void {
    if (!this.seeded) this.seedRoster(); // deferred body creation — see the constructor note
    const dt = PHYSICS_STEP_SEC;
    const maxYawDelta = this.cfg.turnRateRadPerSec * dt;
    for (let id = 0; id < this.slots.length; id++) {
      const slot = this.slots[id];
      if (slot.state !== 'driving') continue;
      const iv = this.internal[id];
      const body = iv.body;
      if (body === null) continue;
      const path = this.avenues[iv.avenueIdx];

      const dirX = Math.sin(slot.yaw);
      const dirZ = Math.cos(slot.yaw);
      const blocked = this.castBlock(iv, slot.x, slot.z, dirX, dirZ);
      const speed = resolveStreetcarHold(blocked, this.cfg.speedMps);
      iv.lastMoveSpeed = speed;

      advanceAvenueCursor(path, iv.cursor, speed * dt, this.pathMode);
      avenueCursorPoint(path, iv.cursor, this.scratchPoint);
      const heading = avenueCursorHeading(path, iv.cursor);
      const targetYaw = yawTo(heading.dx, heading.dz);
      const yaw = stepYaw(slot.yaw, targetYaw, maxYawDelta);

      slot.x = this.scratchPoint.x;
      slot.y = 0;
      slot.z = this.scratchPoint.z;
      slot.yaw = yaw;
      const q = quatFromYaw(yaw);
      slot.qx = q.x;
      slot.qy = q.y;
      slot.qz = q.z;
      slot.qw = q.w;

      body.setNextKinematicTranslation({ x: slot.x, y: 0, z: slot.z });
      body.setNextKinematicRotation(q);
    }
  }

  // --- resolvers + maintenance (useAfterPhysicsStep) ---------------------------------------

  /** Post-step pass: copy dynamic-body poses into slots, run wreck detection, and recycle a
   * lingered streetcar straight back onto its avenue loop. */
  stepAfter(): void {
    this.simTime += PHYSICS_STEP_SEC;
    for (let id = 0; id < this.slots.length; id++) {
      const slot = this.slots[id];
      if (slot.state === null || slot.state === 'driving') continue; // driving needs no post-step work
      const iv = this.internal[id];
      const body = iv.body;
      if (body === null) continue;

      const rot = body.rotation();
      if (!body.isSleeping()) {
        const tr = body.translation();
        slot.x = tr.x;
        slot.y = tr.y;
        slot.z = tr.z;
        slot.qx = rot.x;
        slot.qy = rot.y;
        slot.qz = rot.z;
        slot.qw = rot.w;
      }

      if (slot.state === 'converted') {
        const hp = getEntity(iv.colliderHandle)?.hp ?? slot.hp;
        slot.hp = hp;
        const upDot = upDotFromQuat(rot.x, rot.z);
        const step = tickWreck(
          { flipSec: iv.flipSec, wrecked: iv.wrecked },
          upDot,
          hp,
          PHYSICS_STEP_SEC,
          this.cfg,
        );
        iv.flipSec = step.next.flipSec;
        if (step.emit) {
          iv.wrecked = true;
          iv.wreckedAt = this.simTime;
          slot.state = 'wrecked';
          gameEvents.emit('civWrecked', {});
        }
      }

      const lingerFrom = slot.state === 'wrecked' ? iv.wreckedAt : iv.convertedAt;
      if (this.simTime - lingerFrom >= this.cfg.wreckLingerSec) {
        this.recycle(id);
      }
    }
  }

  // --- conversion (onImpact) ---------------------------------------------------------------

  /** Contact-spine subscriber: convert the driving streetcar a qualifying player ram refers to.
   * Deliberately does NOT check the monster-truck crush predicate ai/traffic.ts's civilian
   * conversion yields to — see this file's header lifecycle note: that seam only ever targets
   * trafficRef (regular civs), so a monster-truck hit here always falls through to this normal
   * force-threshold path, harmlessly (verified — see this task's report). */
  handleImpact(record: ImpactRecord): void {
    const handle = convertibleHandle(record, this.cfg.convertForceThreshold);
    if (handle < 0) return;
    const slotId = this.handleToSlot.get(handle);
    if (slotId === undefined) return; // not one of ours (or already converted)
    if (this.slots[slotId].state !== 'driving') return;
    this.convert(slotId);
  }

  private convert(slotId: number): void {
    const iv = this.internal[slotId];
    const slot = this.slots[slotId];
    const oldBody = iv.body;
    if (oldBody === null) return;

    const tr = oldBody.translation();
    const rot = oldBody.rotation();
    const hp = getEntity(iv.colliderHandle)?.hp ?? this.cfg.hp;

    // Retire the kinematic body (its collider goes with it) + registry identity.
    this.handleToSlot.delete(iv.colliderHandle);
    unregisterEntity(iv.colliderHandle);
    this.world.removeRigidBody(oldBody);

    // Dynamic body at the same pose, mass = TRAFFIC_STREETCAR.massKg (the "big prop payday").
    const bodyDesc = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(tr.x, tr.y, tr.z)
      .setRotation(rot)
      .setLinearDamping(this.cfg.dynamicLinDamping)
      .setAngularDamping(this.cfg.dynamicAngDamping)
      .setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = this.rapier.ColliderDesc.cuboid(
      this.halfExtents[0],
      this.halfExtents[1],
      this.halfExtents[2],
    )
      .setTranslation(0, this.colliderCenterY, 0)
      .setMass(this.cfg.massKg)
      .setCollisionGroups(CIVILIAN_GROUPS);
    const collider = this.world.createCollider(colDesc, body);

    // Inherit loop-direction velocity + a kick from the player's motion (else the hit feels
    // bolted down — same rationale as ai/traffic.ts's convert()).
    const path = this.avenues[iv.avenueIdx];
    const heading = avenueCursorHeading(path, iv.cursor);
    const len = Math.hypot(heading.dx, heading.dz);
    let vx = 0;
    let vz = 0;
    if (len > EPS) {
      vx = (heading.dx / len) * iv.lastMoveSpeed;
      vz = (heading.dz / len) * iv.lastMoveSpeed;
    }
    let vy = 0;
    const pv = playerVehicle.current?.readState().velocity;
    if (pv) {
      const k = this.cfg.convertKickScale;
      vx += pv.x * k;
      vy += pv.y * k;
      vz += pv.z * k;
    }
    body.setLinvel({ x: vx, y: vy, z: vz }, true);

    registerEntity(collider.handle, { kind: 'civilian', districtId: -1, hp, isStreetcar: this.isStreetcarEntry });
    this.handleToSlot.set(collider.handle, slotId);

    iv.body = body;
    iv.colliderHandle = collider.handle;
    iv.flipSec = 0;
    iv.wrecked = false;
    iv.convertedAt = this.simTime;
    slot.state = 'converted';
    slot.dynamic = true;
    slot.hp = hp;

    if (!iv.civHitEmitted) {
      iv.civHitEmitted = true;
      gameEvents.emit('civHit', {});
    }
  }

  // --- spawn / recycle ----------------------------------------------------------------------

  /** Place streetcar `id` on `avenueIdx`'s loop at `startDistanceM`, heading along the loop's
   * direction of travel there. Used both for the initial roster (constructor) and recycling
   * (below). */
  private spawn(id: number, avenueIdx: number, startDistanceM: number): void {
    const path = this.avenues[avenueIdx];
    const iv = this.internal[id];
    const slot = this.slots[id];

    iv.avenueIdx = avenueIdx;
    iv.cursor = avenueCursorAtDistance(path, startDistanceM, this.pathMode);
    iv.lastMoveSpeed = this.cfg.speedMps;
    iv.civHitEmitted = false;
    iv.flipSec = 0;
    iv.wrecked = false;
    iv.convertedAt = 0;
    iv.wreckedAt = 0;

    const point = avenueCursorPoint(path, iv.cursor, this.scratchPoint);
    const heading = avenueCursorHeading(path, iv.cursor);
    const yaw = yawTo(heading.dx, heading.dz);
    const q = quatFromYaw(yaw);

    // Kinematic body sits base-on-ground (y=0), collider lifted to its centre.
    const bodyDesc = this.rapier.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(point.x, 0, point.z)
      .setRotation(q);
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = this.rapier.ColliderDesc.cuboid(
      this.halfExtents[0],
      this.halfExtents[1],
      this.halfExtents[2],
    )
      .setTranslation(0, this.colliderCenterY, 0)
      .setCollisionGroups(CIVILIAN_GROUPS);
    const collider = this.world.createCollider(colDesc, body);

    registerEntity(collider.handle, {
      kind: 'civilian',
      districtId: -1,
      hp: this.cfg.hp,
      isStreetcar: this.isStreetcarEntry,
    });
    this.handleToSlot.set(collider.handle, id);

    iv.body = body;
    iv.colliderHandle = collider.handle;
    slot.state = 'driving';
    slot.dynamic = false;
    slot.hp = this.cfg.hp;
    slot.x = point.x;
    slot.y = 0;
    slot.z = point.z;
    slot.yaw = yaw;
    slot.qx = q.x;
    slot.qy = q.y;
    slot.qz = q.z;
    slot.qw = q.w;
  }

  /** Tear down a lingered converted/wrecked streetcar's dynamic body + registry entry and
   * respawn the SAME slot id back onto its assigned avenue at a fresh random point — the fixed
   * roster never shrinks (see this file's header: no despawn-by-distance, no pool). */
  private recycle(id: number): void {
    const iv = this.internal[id];
    const slot = this.slots[id];
    if (iv.body !== null) {
      if (iv.colliderHandle >= 0) {
        this.handleToSlot.delete(iv.colliderHandle);
        unregisterEntity(iv.colliderHandle);
      }
      this.world.removeRigidBody(iv.body);
      iv.body = null;
      iv.colliderHandle = -1;
    }
    slot.state = null; // transient — spawn() below sets it back to 'driving' before this returns
    const path = this.avenues[iv.avenueIdx];
    const cycleLen = avenueCycleLength(path, this.pathMode);
    const freshDistanceM = cycleLen > EPS ? this.rng.next() * cycleLen : 0;
    this.spawn(id, iv.avenueIdx, freshDistanceM);
  }

  /** Remove every body + registry entry (mount unmount / city teardown). */
  dispose(): void {
    for (let id = 0; id < this.slots.length; id++) {
      const slot = this.slots[id];
      if (slot.state === null) continue;
      const iv = this.internal[id];
      if (iv.body !== null) {
        if (iv.colliderHandle >= 0) unregisterEntity(iv.colliderHandle);
        this.world.removeRigidBody(iv.body);
        iv.body = null;
        iv.colliderHandle = -1;
      }
      slot.state = null;
      slot.dynamic = false;
    }
    this.handleToSlot.clear();
  }

  // --- small bound helper ---------------------------------------------------------------------

  private castBlock(iv: InternalStreetcar, x: number, z: number, dirX: number, dirZ: number): boolean {
    this.rayOrigin.x = x + dirX * this.frontProbeM;
    this.rayOrigin.y = RAY_HEIGHT_M;
    this.rayOrigin.z = z + dirZ * this.frontProbeM;
    this.rayDir.x = dirX;
    this.rayDir.y = 0;
    this.rayDir.z = dirZ;
    const hit = this.world.castRay(
      this.ray,
      this.cfg.blockRayLengthM,
      true,
      undefined,
      BLOCK_RAY_GROUPS,
      undefined,
      iv.body ?? undefined,
    );
    return hit !== null;
  }
}
