// Pure SWAT-squad flank coordinator (Phase 10 Task 1; TDD §5.6 SWAT row: "two units steer to
// ±30° offsets ahead of the player to box in; others ram"). This is the game's first COORDINATED
// AI: instead of every unit independently seeking the player, two flank SLOTS are computed ahead
// of the player and ASSIGNED to specific SWAT units, which then hold formation (aiSteering's
// 'flank' mode) while the rest ram.
//
// Like ai/aiSteering.ts and vehicles/steering.ts this module is PURE — numbers in, numbers out,
// NO three.js / Rapier imports — so the coordination logic (slot geometry, cost-based assignment
// with incumbency hysteresis, stuck-claim release) unit-tests without the wasm module. The
// impure glue (reading the live player pose + SWAT roster off the refs, driving this at 10 Hz,
// publishing the result) lives in ai/squadCoordinator.ts + ai/SquadMount.tsx.
//
// Angle convention (matches ai/aiSteering.ts + ai/traffic.ts): +Z is model-forward, a heading yaw
// θ points along the unit vector (sin θ, cos θ), and +yaw (toward +X) is "right".
//
// clampToDrivable is the one function that touches world data: it reads TILE TYPES (pure city
// data, deterministic per seed — world/types.ts, zero three/rapier) to snap a slot that landed
// inside a building/fenced tile out to the nearest drivable tile center, so a flanker is never
// ordered to drive into a wall. WORLD's tile dimensions come from config (the single source of
// truth), same as world/types.ts's own tileCenter helper uses.

import { WORLD } from '../config';
import { tileCenter, tileIndex, type TileType, type WorldData } from '../world/types';
import { wrapAngle, yawToward } from './aiSteering';

/** A planar point. */
export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

/** One computed flank slot: a world-space target the assigned SWAT unit steers to. `id` is 0 for
 * the left slot (−flankOffsetDeg off the base direction), 1 for the right (+flankOffsetDeg). */
export interface FlankSlot {
  readonly id: number;
  readonly x: number;
  readonly z: number;
}

/** A SWAT unit eligible to claim a flank slot. `unitId` is its stable pool-slot id (UnitSlot.id);
 * (x, z) is its world position, `yaw` its heading (for the heading-misalignment cost term). */
export interface SquadCandidate {
  readonly unitId: number;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

/** slotId → unitId. Which unit currently owns each flank slot (a unit owns at most one slot; a
 * slot is owned by at most one unit). */
export type ClaimMap = ReadonlyMap<number, number>;

/** slotId → seconds the current claimant has CONTINUOUSLY failed to reach its slot (releaseStuck
 * bookkeeping). Absent = 0. */
export type ClaimTimers = ReadonlyMap<number, number>;

/** The subset of SQUAD config computeFlankSlots reads. */
export interface FlankSlotConfig {
  readonly flankDistanceM: number;
  readonly flankOffsetDeg: number;
  readonly flankSpeedThresholdMps: number;
}

/** The subset of SQUAD config assignFlankSlots reads. */
export interface AssignConfig {
  readonly headingWeightM: number;
  readonly hysteresisPct: number;
}

/** The subset of SQUAD config releaseStuckClaims reads. */
export interface ReleaseConfig {
  readonly reachDistM: number;
  readonly unreachableSec: number;
}

/** The subset of SQUAD config clampToDrivable reads. */
export interface ClampConfig {
  readonly clampMaxRadiusTiles: number;
}

const DEG2RAD = Math.PI / 180;

/** Tile types a vehicle can drive on. Buildings are solid; transformer lots are fenced — a flank
 * slot on either is snapped out to the nearest of these by clampToDrivable. */
const DRIVABLE_TILE_TYPES: ReadonlySet<TileType> = new Set<TileType>(['road', 'park', 'parkingLot']);

// ===========================================================================================
// (1) Slot geometry
// ===========================================================================================

/**
 * The two flank slots ±flankOffsetDeg off the player's base direction, flankDistanceM ahead.
 * Base direction is the player's VELOCITY heading when they're moving at least
 * cfg.flankSpeedThresholdMps (box in where they're going), otherwise their FACING (`playerYaw`) —
 * a near-stationary player has no meaningful velocity heading. Pure.
 */
export function computeFlankSlots(
  playerPos: Vec2,
  playerVel: Vec2,
  playerYaw: number,
  cfg: FlankSlotConfig,
): [FlankSlot, FlankSlot] {
  const speed = Math.hypot(playerVel.x, playerVel.z);
  const baseYaw =
    speed >= cfg.flankSpeedThresholdMps ? yawToward(playerVel.x, playerVel.z) : playerYaw;
  const offset = cfg.flankOffsetDeg * DEG2RAD;
  return [
    slotAt(playerPos, baseYaw - offset, cfg.flankDistanceM, 0),
    slotAt(playerPos, baseYaw + offset, cfg.flankDistanceM, 1),
  ];
}

function slotAt(origin: Vec2, yaw: number, dist: number, id: number): FlankSlot {
  return { id, x: origin.x + Math.sin(yaw) * dist, z: origin.z + Math.cos(yaw) * dist };
}

// ===========================================================================================
// (2) Drivable clamp (reads pure city tile data)
// ===========================================================================================

/** Flat-grid (col, row) of a world-space point, clamped to the map bounds. */
function worldToColRow(x: number, z: number): { col: number; row: number } {
  const half = (WORLD.tiles * WORLD.tileSize) / 2;
  const col = Math.floor((x + half) / WORLD.tileSize);
  const row = Math.floor((z + half) / WORLD.tileSize);
  const max = WORLD.tiles - 1;
  return {
    col: col < 0 ? 0 : col > max ? max : col,
    row: row < 0 ? 0 : row > max ? max : row,
  };
}

function isDrivableTile(world: WorldData, col: number, row: number): boolean {
  const t = world.tiles[tileIndex(col, row)];
  return t !== undefined && DRIVABLE_TILE_TYPES.has(t.type);
}

/**
 * Snap a flank target off a building/fenced tile to the nearest drivable (road/park/parkingLot)
 * tile CENTER, via a small outward spiral. If the target already sits on a drivable tile it is
 * returned unchanged (the precise slot, not the tile center). If no drivable tile is found within
 * cfg.clampMaxRadiusTiles (shouldn't happen in a city with roads), the original target is returned.
 * Pure given the world's tile data.
 */
export function clampToDrivable(target: Vec2, world: WorldData, cfg: ClampConfig): Vec2 {
  const { col, row } = worldToColRow(target.x, target.z);
  if (isDrivableTile(world, col, row)) return { x: target.x, z: target.z };

  const max = WORLD.tiles - 1;
  let best: Vec2 | null = null;
  let bestD2 = Infinity;

  for (let r = 1; r <= cfg.clampMaxRadiusTiles; r++) {
    // Early out: the closest any tile in ring r could be is ≈(r−1) tiles away; once that already
    // exceeds our best hit no farther ring can beat it (rings only grow), so we're done.
    if (best !== null) {
      const minRingDist = (r - 1) * WORLD.tileSize;
      if (minRingDist * minRingDist >= bestD2) break;
    }
    for (const [c, rw] of ringTiles(col, row, r, max)) {
      if (!isDrivableTile(world, c, rw)) continue;
      const center = tileCenter(c, rw);
      const dx = center.x - target.x;
      const dz = center.z - target.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { x: center.x, z: center.z };
      }
    }
  }

  return best ?? { x: target.x, z: target.z };
}

/** (col,row) tiles at exactly Chebyshev distance `r` from (col0,row0), clamped in-bounds. */
function ringTiles(col0: number, row0: number, r: number, max: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dc = -r; dc <= r; dc++) {
    for (let dr = -r; dr <= r; dr++) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue; // ring shell only
      const c = col0 + dc;
      const rw = row0 + dr;
      if (c < 0 || c > max || rw < 0 || rw > max) continue;
      out.push([c, rw]);
    }
  }
  return out;
}

// ===========================================================================================
// (3) Claim assignment (cost + incumbency hysteresis)
// ===========================================================================================

/** Raw claim cost of a unit taking a slot: straight-line distance + heading misalignment (how far
 * the unit must turn to face the slot) weighted into metres. Lower is better. */
function claimCost(candidate: SquadCandidate, slot: FlankSlot, cfg: AssignConfig): number {
  const dx = slot.x - candidate.x;
  const dz = slot.z - candidate.z;
  const dist = Math.hypot(dx, dz);
  const misalign = Math.abs(wrapAngle(yawToward(dx, dz) - candidate.yaw)); // 0..π rad
  return dist + misalign * cfg.headingWeightM;
}

/**
 * Assign the flank slots to the candidate SWAT units, minimizing total cost with two guards:
 *   • MAXIMAL FILL — as many slots as there are units are always filled (a low raw cost never
 *     leaves a slot empty), so the flank always forms when SWAT are present.
 *   • INCUMBENCY HYSTERESIS — the unit that held a slot last tick (prevClaims) keeps it unless a
 *     challenger beats its cost by at least cfg.hysteresisPct, modelled as a matching discount on
 *     the incumbent's cost. This is what stops two near-tied units swapping the slot every tick.
 * One unit per slot, one slot per unit. Pure; deterministic (ties broken by candidate order).
 */
export function assignFlankSlots(
  slots: readonly FlankSlot[],
  candidates: readonly SquadCandidate[],
  prevClaims: ClaimMap,
  cfg: AssignConfig,
): ClaimMap {
  const s = slots.length;
  const n = candidates.length;
  if (s === 0 || n === 0) return new Map();

  // eff[si][ci] = effective (post-hysteresis) cost of putting candidate ci on slot si.
  const eff: number[][] = slots.map((slot) =>
    candidates.map((cand) => {
      const raw = claimCost(cand, slot, cfg);
      const incumbent = prevClaims.get(slot.id) === cand.unitId;
      // Incumbent discount: challenger wins only if rawChallenger < rawIncumbent·(1−pct).
      return incumbent ? raw * (1 - cfg.hysteresisPct) : raw;
    }),
  );

  const targetFill = Math.min(s, n);
  const used = new Array<boolean>(n).fill(false);
  const cur = new Array<number>(s).fill(-1); // per-slot candidate index, −1 = unassigned
  let bestFilled = -1;
  let bestCost = Infinity;
  let bestAssign: number[] | null = null;

  const consider = (filled: number, cost: number): void => {
    // Prefer more slots filled; among equal fill, lower total cost. (targetFill guarantees the
    // best branch fills maximally, so a cheap-but-underfilled branch can never win.)
    if (filled > bestFilled || (filled === bestFilled && cost < bestCost)) {
      bestFilled = filled;
      bestCost = cost;
      bestAssign = cur.slice();
    }
  };

  const rec = (si: number, filled: number, cost: number): void => {
    // Prune: even filling every remaining slot can't reach targetFill → abandon.
    if (filled + (s - si) < targetFill) return;
    if (si === s) {
      consider(filled, cost);
      return;
    }
    for (let ci = 0; ci < n; ci++) {
      if (used[ci]) continue;
      used[ci] = true;
      cur[si] = ci;
      rec(si + 1, filled + 1, cost + eff[si][ci]);
      used[ci] = false;
      cur[si] = -1;
    }
    // Leave slot si unassigned (only reachable when candidates < slots, given the prune above).
    cur[si] = -1;
    rec(si + 1, filled, cost);
  };

  rec(0, 0, 0);

  const claims = new Map<number, number>();
  if (bestAssign !== null) {
    for (let si = 0; si < s; si++) {
      const ci = bestAssign[si];
      if (ci >= 0) claims.set(slots[si].id, candidates[ci].unitId);
    }
  }
  return claims;
}

// ===========================================================================================
// (4) Stuck-claim release
// ===========================================================================================

export interface ReleaseResult {
  /** Surviving claims (stuck / orphaned claims removed). */
  readonly claims: ClaimMap;
  /** Updated per-slot unreached timers (reset to 0 on reach, dropped on release). */
  readonly timers: ClaimTimers;
}

/**
 * Advance each claim's "time spent NOT within reachDistM of its slot" by `dt`, and RELEASE any
 * claim whose claimant has stayed out of reach for cfg.unreachableSec continuously (wedged behind
 * a building, or otherwise unable to make the slot) — freeing that slot for assignFlankSlots to
 * hand to a better-placed unit. A claim whose claimant has vanished from `candidates` (despawned /
 * wrecked / no longer SWAT) or whose slot no longer exists is dropped immediately. Reaching the
 * slot resets the timer. Pure.
 */
export function releaseStuckClaims(
  prevClaims: ClaimMap,
  slots: readonly FlankSlot[],
  candidates: readonly SquadCandidate[],
  prevTimers: ClaimTimers,
  dt: number,
  cfg: ReleaseConfig,
): ReleaseResult {
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  const candById = new Map(candidates.map((c) => [c.unitId, c]));
  const reach2 = cfg.reachDistM * cfg.reachDistM;

  const claims = new Map<number, number>();
  const timers = new Map<number, number>();

  for (const [slotId, unitId] of prevClaims) {
    const slot = slotById.get(slotId);
    const cand = candById.get(unitId);
    if (slot === undefined || cand === undefined) continue; // orphaned → drop (timer forgotten)

    const dx = slot.x - cand.x;
    const dz = slot.z - cand.z;
    if (dx * dx + dz * dz <= reach2) {
      // Reached (or holding) the slot → keep the claim, reset the unreached timer.
      claims.set(slotId, unitId);
      timers.set(slotId, 0);
      continue;
    }
    const next = (prevTimers.get(slotId) ?? 0) + dt;
    if (next >= cfg.unreachableSec) continue; // stuck too long → release (drop claim + timer)
    claims.set(slotId, unitId);
    timers.set(slotId, next);
  }

  return { claims, timers };
}

/** Rebuild the unreached timers after (re)assignment: an unchanged claim keeps its timer, a slot
 * that changed hands (or is newly filled) starts fresh at 0. Keeps release bookkeeping honest when
 * assignFlankSlots hands a slot to a different unit than releaseStuckClaims left on it. Pure. */
export function reconcileTimers(
  finalClaims: ClaimMap,
  priorClaims: ClaimMap,
  priorTimers: ClaimTimers,
): ClaimTimers {
  const timers = new Map<number, number>();
  for (const [slotId, unitId] of finalClaims) {
    timers.set(slotId, priorClaims.get(slotId) === unitId ? (priorTimers.get(slotId) ?? 0) : 0);
  }
  return timers;
}

/** Reverse lookup: the slot a given unit currently claims, or null. Backs
 * squadCoordinator.getSquadTargetForUnit. Pure. */
export function slotClaimedBy(claims: ClaimMap, unitId: number): number | null {
  for (const [slotId, owner] of claims) {
    if (owner === unitId) return slotId;
  }
  return null;
}
