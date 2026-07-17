// Pursuit spawn director (Phase 9, TDD §5.5/§5.6). Owns WHEN pursuit units exist: it holds
// a fixed pool, maintains `caps[tier]` pursuing units spawned on road tiles in the 60–90 m
// off-screen ring around the player, despawns anything past 140 m, round-robins each unit's
// 10 Hz decision tick so raycasts don't clump, and fills the new cap the instant the wanted
// tier climbs. It is the chassis every Part 4 escalation unit bolts onto: the director is
// unit-kind agnostic — it reads the per-tier composition table (config/SPAWN_COMPOSITION)
// and creates units through the module-scope FACTORY REGISTRY, so adding armored/SWAT/gun-
// truck/tank later is a config entry + a registerUnitFactory() call, never a director edit.
//
// It mirrors ai/traffic.ts's discipline: pure, framework-free helpers (unit-tested, no
// Rapier/three) up top; a controller class below. Critically the controller creates NO
// physics resources itself — the unit factory (ai/units/*, Task 2) owns the body/controller/
// mesh behind each UnitHandle — so the entire director is Rapier-free and fully testable in
// plain vitest by injecting a stub factory. The R3F mount (ai/SpawnDirectorMount.tsx) drives
// its two per-step passes from the Rapier step hooks and wires the tierChanged/runEnded
// events; the controller stays event- and framework-free.
//
// --- pool / slot model --------------------------------------------------------------------
// `slots` is a stable array of length maxCap (= caps[5] = 10); the index is the unit's pool
// id and its stagger phase. A free slot is the seam's `kind === null` sentinel (a persistent
// placeholder). On spawn the director drops the factory-created UnitHandle's own slot into
// that index; on despawn it restores a placeholder. Consumers (BUSTED proximity, the pursuit
// mesh, debug overlay) read `unitsRef.current.slots` exactly as they read traffic's.
//
// --- cap accounting ------------------------------------------------------------------------
// The cap counts PURSUING units only. A wrecked unit is debris held as a destruction trophy
// for SPAWN.wreckLingerSec, not a pursuer, so it doesn't hold the tier below its cap — the
// director spawns a replacement while the wreck lingers. The fixed pool (SlotBook) is what
// bounds total bodies, so a wreck can never let the pool overflow.

import {
  SPAWN,
  SPAWN_COMPOSITION,
  type CompositionEntry,
  type MaxOfKindEntry,
  type MinPreferredEntry,
} from '../config';
import { createRng, type Rng } from '../world/rng';
import { tileCenter, type Tile } from '../world/types';
import { playerVehicle } from '../vehicles/playerRef';
import { getGameState } from '../state/store';
// Reused verbatim from the Phase 7 civilian system (sanctioned by the task): the fixed-yaw
// camera "behind the frame" heuristic, the +Z-forward yaw helper, the pool slot allocator,
// and the Vec2 shape. Pursuit and civilian spawning share the exact same off-screen-ring
// discipline, so they share the exact same primitives rather than duplicating them.
import { SlotBook, cameraForwardXZ, yawTo, type Vec2 } from './traffic';
import type { UnitFactory, UnitHandle, UnitKind, UnitSlot, PursuitApi } from './pursuitTypes';

// Matches <Physics timeStep={1/60}> (game/index.tsx): a constant dt tracks sim time exactly
// and stops while paused (the mount's step hooks don't fire when Physics is paused).
const PHYSICS_HZ = 60;
const PHYSICS_STEP_SEC = 1 / PHYSICS_HZ;

// Physics steps between a unit's 10 Hz decisions (= 6 at 60 Hz / 10 Hz). Round-robining pool
// index i across these phases is the "no two of N units raycast the same step" guarantee.
export const STEPS_PER_THINK = Math.max(1, Math.round(PHYSICS_HZ / SPAWN.aiTickHz));
// Physics steps between pool-maintenance passes (= 30 at 60 Hz / 2 Hz).
const STEPS_PER_MAINTAIN = Math.max(1, Math.round(PHYSICS_HZ / SPAWN.maintainHz));
// Max concurrent pool size across all tiers.
const MAX_CAP = Math.max(...SPAWN.caps);

// ===========================================================================================
// Pure helpers (unit-tested; no Rapier/three/store side effects)
// ===========================================================================================

/** Concurrent pursuit cap for a wanted tier, clamped to the caps table's bounds (defensive —
 * tier is always 0..5 in practice). */
export function capForTier(tier: number, caps: readonly number[]): number {
  if (caps.length === 0) return 0;
  const i = Math.max(0, Math.min(tier, caps.length - 1));
  return caps[i];
}

/** A candidate spawn location — the world-space center (pre-jitter) of one road tile. */
export interface RoadPoint {
  readonly x: number;
  readonly z: number;
  /** Flat-grid tile index (row * WORLD.tiles + col); kept for debug/traceability. */
  readonly tileIndex: number;
}

/** Every road tile's world-space center, in flat-grid order. The director's spawn candidate
 * set: pursuit units spawn ONLY on road tiles (TDD §5.6). Pure — `tiles` is any tile list. */
export function collectRoadPoints(tiles: readonly Tile[]): RoadPoint[] {
  const points: RoadPoint[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.type !== 'road') continue;
    const c = tileCenter(t.col, t.row);
    points.push({ x: c.x, z: c.z, tileIndex: i });
  }
  return points;
}

export interface RingConfig {
  readonly ringMin: number;
  readonly ringMax: number;
}

/**
 * Choose a spawn point in the [ringMin, ringMax] ring around the player, preferring points
 * BEHIND the fixed follow camera (out of frame, so units pop in unseen — TDD §5.6). Two
 * candidate pools are gathered in one pass — ring points that are also behind the camera, and
 * all ring points — and `pick` selects from the behind pool when non-empty, else any ring
 * point; −1 when the ring is empty. Returns an INDEX into `points`. Pure: `pick` is injected
 * (rng-backed live, deterministic in tests). Mirrors traffic.selectSpawnNode. */
export function selectSpawnPoint(
  points: readonly { readonly x: number; readonly z: number }[],
  px: number,
  pz: number,
  camFwdX: number,
  camFwdZ: number,
  cfg: RingConfig,
  pick: (indices: readonly number[]) => number,
): number {
  const minSq = cfg.ringMin * cfg.ringMin;
  const maxSq = cfg.ringMax * cfg.ringMax;
  const behind: number[] = [];
  const anyRing: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const dx = points[i].x - px;
    const dz = points[i].z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 < minSq || d2 > maxSq) continue;
    anyRing.push(i);
    if (dx * camFwdX + dz * camFwdZ < 0) behind.push(i);
  }
  const pool = behind.length > 0 ? behind : anyRing;
  return pool.length > 0 ? pick(pool) : -1;
}

/** Nearest point to (px,pz), or −1 if none. Debug forceSpawn fallback when the ring is empty
 * (e.g. player parked off any road) so a forced spawn still lands somewhere sensible. */
export function nearestPointIndex(
  points: readonly { readonly x: number; readonly z: number }[],
  px: number,
  pz: number,
): number {
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i].x - px;
    const dz = points[i].z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

/** Stable 10 Hz think phase (0..stepsPerThink-1) for a pool index. Distinct across the first
 * `stepsPerThink` indices, so with stepsPerThink ≥ N the first N units never share a phase. */
export function thinkPhase(unitId: number, stepsPerThink: number): number {
  const s = Math.max(1, stepsPerThink);
  return ((unitId % s) + s) % s;
}

/** Whether a pool index thinks on this physics step — its staggered 10 Hz slot. */
export function shouldThink(unitId: number, stepIndex: number, stepsPerThink: number): boolean {
  const s = Math.max(1, stepsPerThink);
  return ((stepIndex % s) + s) % s === thinkPhase(unitId, s);
}

/** Weighted pick of one unit kind from a tier's composition entries; null when the tier is
 * empty (★0) or all weights are non-positive. `roll` yields a float in [0,1) (rng-backed live,
 * deterministic in tests). */
export function pickCompositionKind(
  entries: readonly CompositionEntry[],
  roll: () => number,
): UnitKind | null {
  if (entries.length === 0) return null;
  let total = 0;
  for (const e of entries) total += Math.max(0, e.weight);
  if (total <= 0) return null;
  let r = roll() * total;
  for (const e of entries) {
    r -= Math.max(0, e.weight);
    if (r < 0) return e.kind;
  }
  return entries[entries.length - 1].kind; // fp guard: roll()≈1 lands here
}

/** Wreck-linger elapsed test: true once a wreck first observed at `wreckedAt` has been debris
 * for `lingerSec` at the current `simTime`. `wreckedAt < 0` = not yet observed wrecked. */
export function lingerExpired(simTime: number, wreckedAt: number, lingerSec: number): boolean {
  return wreckedAt >= 0 && simTime - wreckedAt >= lingerSec;
}

/** Count of currently PURSUING (non-wrecked) units of `kind` among `slots` — a lingering
 * wreck of that kind doesn't count toward it, mirroring the controller's own
 * `pursuingCount()` discipline (a wreck is debris, not a pursuer). Pure; backs
 * `minPreferred` fill order below and is unit-tested directly against plain slot fixtures. */
export function countPursuingKind(slots: readonly UnitSlot[], kind: UnitKind): number {
  let n = 0;
  for (const s of slots) {
    if (s.kind === kind && s.state !== 'wrecked') n++;
  }
  return n;
}

/** True once `kind`'s live (pursuing, non-wrecked) count has reached its per-tier concurrency
 * cap in `maxOfKind` (SPAWN_COMPOSITION.maxOfKind[tier]) — the generic form of the ★5 maxTanks
 * rule. A kind with no entry in `maxOfKind` is never at max (uncapped). Pure; the director builds
 * a predicate over this and uses it to exclude the kind from both fill passes. */
export function kindAtMax(
  slots: readonly UnitSlot[],
  kind: UnitKind,
  maxOfKind: readonly MaxOfKindEntry[],
): boolean {
  const entry = maxOfKind.find((e) => e.kind === kind);
  return entry !== undefined && countPursuingKind(slots, kind) >= entry.max;
}

/** Filters a tier's weighted composition entries down to kinds with a REGISTERED factory,
 * preserving each surviving entry's weight untouched (so ratios among the remaining kinds
 * are exactly what the config table specifies — no renormalization needed since
 * `pickCompositionKind` already works off relative weights).
 *
 * This is the "fall back to a registered kind" half of the unknown-factory guard: Part 4
 * lands a unit's factory registration (ai/units/*'s mesh mount) on its own schedule, so a
 * composition row can legitimately reference a kind before its factory exists yet (or after
 * a hot-reload drops one — `unregisterUnitFactory`). Excluding it from the roll means the
 * OTHER registered kinds in the same tier still fill the cap at their relative weights,
 * instead of the whole tier stalling on the missing kind. If every entry is filtered out,
 * `pickCompositionKind` sees an empty list and returns null (handled by the caller — see
 * `trySpawn`'s "skip the spawn this round" fallback). Pure — `isRegistered` injected so this
 * is testable without the module-scope factory map. */
export function filterRegisteredEntries(
  entries: readonly CompositionEntry[],
  isRegistered: (kind: UnitKind) => boolean,
): CompositionEntry[] {
  return entries.filter((e) => isRegistered(e.kind));
}

// ===========================================================================================
// Factory registry (module scope — survives mounts/remounts)
// ===========================================================================================
// Task 2's police module (ai/units/policeSedan.ts) calls registerUnitFactory('police', …) at
// import time; Part 4's units register themselves the same way. The director never imports a
// concrete unit — it only ever looks a kind up here.

const factories = new Map<UnitKind, UnitFactory>();

/** Register the factory that creates one unit of `kind`. Called once per kind at unit-module
 * import (idempotent-ish: last registration wins, which also lets a test swap in a stub). */
export function registerUnitFactory(kind: UnitKind, factory: UnitFactory): void {
  factories.set(kind, factory);
}

/** Look up a kind's factory, or undefined if none is registered yet. */
export function getUnitFactory(kind: UnitKind): UnitFactory | undefined {
  return factories.get(kind);
}

/** Drop a kind's factory (test hygiene / hot-reload safety). */
export function unregisterUnitFactory(kind: UnitKind): void {
  factories.delete(kind);
}

// ===========================================================================================
// Controller (framework-free; owns the pool, spawn/despawn cadence, and think scheduling)
// ===========================================================================================

/** A persistent free-slot placeholder (the seam's `kind === null` sentinel). Replaced by a
 * factory-created slot on spawn, restored on despawn. */
function freeSlot(id: number): UnitSlot {
  return {
    id,
    kind: null,
    state: 'pursuing',
    x: 0,
    y: 0,
    z: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    hp: 0,
    behaviorLabel: 'free',
  };
}

export interface SpawnDirectorOptions {
  /** Road-tile spawn candidates (mount passes collectRoadPoints(world.tiles)). */
  readonly roadPoints: readonly RoadPoint[];
  /** Deterministic stream for kind rolls + spawn-point selection/jitter. */
  readonly rng: Rng;
  /** Current wanted tier. Defaults to the live store; injectable for tests. */
  readonly getTier?: () => number;
  /** Current player XZ, or null when no run is live. Defaults to the player ref; injectable. */
  readonly getPlayerPos?: () => Vec2 | null;
  /** Fixed-camera forward (behind-frame heuristic). Defaults to the §5.3 rig yaw. */
  readonly camForward?: Vec2;
}

export class SpawnDirectorController {
  private readonly roadPoints: readonly RoadPoint[];
  private readonly rng: Rng;
  private readonly getTier: () => number;
  private readonly getPlayerPos: () => Vec2 | null;
  private readonly camFwd: Vec2;

  // Fixed pool. `slots[i]` is a live unit's own slot or a free placeholder; `handles[i]` the
  // live UnitHandle or null; both indexed by pool id (= stagger phase). `wreckObservedAt[i]`
  // is the sim time the director first saw slot i wrecked (−1 = not observed / not wrecked).
  private readonly slots: UnitSlot[];
  private readonly handles: (UnitHandle | null)[];
  private readonly wreckObservedAt: number[];
  private readonly book = new SlotBook(MAX_CAP);

  private stepIndex = 0;
  private simTime = 0;
  private pendingFill = false;

  readonly api: PursuitApi;

  constructor(opts: SpawnDirectorOptions) {
    this.roadPoints = opts.roadPoints;
    this.rng = opts.rng;
    this.getTier = opts.getTier ?? (() => getGameState().tier);
    this.getPlayerPos =
      opts.getPlayerPos ??
      (() => {
        const p = playerVehicle.current?.readState().pose.position;
        return p ? { x: p.x, z: p.z } : null;
      });
    this.camFwd = opts.camForward ?? cameraForwardXZ();

    this.slots = Array.from({ length: MAX_CAP }, (_, i) => freeSlot(i));
    this.handles = Array.from({ length: MAX_CAP }, () => null);
    this.wreckObservedAt = Array.from({ length: MAX_CAP }, () => -1);

    this.api = {
      slots: this.slots,
      activeCount: () => this.book.activeCount,
      forceSpawn: (kind) => this.forceSpawn(kind),
      despawnAll: () => this.despawnAll(),
    };
  }

  // --- per-step passes (driven by the mount's Rapier step hooks) ----------------------------

  /** useBeforePhysicsStep: advance the step clock and run each due unit's staggered 10 Hz
   * think(). Decisions cache inside the unit; the unit applies its cached forces in its own
   * before-step hook (seam contract) — the director only schedules WHO thinks WHEN. */
  stepBefore(): void {
    this.stepIndex++;
    for (let i = 0; i < MAX_CAP; i++) {
      const h = this.handles[i];
      if (h === null) continue;
      if (shouldThink(i, this.stepIndex, STEPS_PER_THINK)) h.think();
    }
  }

  /** useAfterPhysicsStep: advance sim time, then run pool maintenance on its ~2 Hz cadence
   * (or immediately after a tierChanged requestFill). */
  stepAfter(): void {
    this.simTime += PHYSICS_STEP_SEC;
    const due = this.pendingFill || this.stepIndex % STEPS_PER_MAINTAIN === 0;
    this.pendingFill = false;
    if (due) this.maintain();
  }

  /** tierChanged hook (wired by the mount): fill the new cap on the very next after-step,
   * not on the next 2 Hz cadence tick (TDD §5.5 "immediately fills the new cap"). */
  requestFill(): void {
    this.pendingFill = true;
  }

  // --- maintenance --------------------------------------------------------------------------

  private maintain(): void {
    const player = this.getPlayerPos();
    if (player === null) return; // no run live → nothing to maintain
    const despawnSq = SPAWN.despawnAt * SPAWN.despawnAt;

    // Retire far units, and wrecks past their linger window.
    for (let i = 0; i < MAX_CAP; i++) {
      const h = this.handles[i];
      if (h === null) continue;
      const slot = h.slot;
      if (slot.state === 'wrecked') {
        if (this.wreckObservedAt[i] < 0) this.wreckObservedAt[i] = this.simTime;
        if (lingerExpired(this.simTime, this.wreckObservedAt[i], SPAWN.wreckLingerSec)) {
          this.despawn(i);
          continue;
        }
      }
      const dx = slot.x - player.x;
      const dz = slot.z - player.z;
      if (dx * dx + dz * dz > despawnSq) this.despawn(i);
    }

    // Top pursuing units up to the current cap.
    const tier = this.getTier();
    const cap = capForTier(tier, SPAWN.caps);
    const entries = SPAWN_COMPOSITION.tiers[tier] ?? [];
    const minPreferred: readonly MinPreferredEntry[] = SPAWN_COMPOSITION.minPreferred?.[tier] ?? [];
    const maxOfKind: readonly MaxOfKindEntry[] = SPAWN_COMPOSITION.maxOfKind?.[tier] ?? [];
    // Per-kind concurrency cap predicate (Phase 11): a kind at its maxOfKind limit is excluded
    // from BOTH fill passes below, so e.g. ≤ 2 gun trucks holds however the weighted rolls fall.
    const atMax = (kind: UnitKind): boolean => kindAtMax(this.slots, kind, maxOfKind);
    // Shared across BOTH passes below: a single hard bound so a run of unlucky rolls (an
    // unregistered kind, an exhausted ring) can never spin forever regardless of which pass
    // is consuming it — see trySpawn/trySpawnKind's "return false, never throw" contract.
    let guard = MAX_CAP + 1;

    // Pass 1 — minPreferred: guarantee each preferred kind's floor BEFORE the weighted roll
    // gets a turn (TDD/Phase 10 rationale: squad.ts's flank slots need bodies to claim them,
    // so ★3 wants >=2 SWAT on the ground before spending the rest of the cap on the mix). A
    // preferred kind that is also maxOfKind-capped stops at whichever bound is hit first.
    for (const pref of minPreferred) {
      while (
        this.pursuingCount() < cap &&
        countPursuingKind(this.slots, pref.kind) < pref.count &&
        !atMax(pref.kind) &&
        guard-- > 0
      ) {
        if (!this.trySpawnKind(player, pref.kind)) break; // no ring point / no factory — next pref
      }
    }

    // Pass 2 — weighted fill for whatever's left of the cap (capped kinds excluded from the roll).
    while (this.pursuingCount() < cap && guard-- > 0) {
      if (!this.trySpawn(player, entries, atMax)) break; // no ring point / no eligible kind this pass
    }
  }

  private pursuingCount(): number {
    let n = 0;
    for (let i = 0; i < MAX_CAP; i++) {
      const h = this.handles[i];
      if (h !== null && h.slot.state !== 'wrecked') n++;
    }
    return n;
  }

  // --- spawn / despawn ----------------------------------------------------------------------

  /** Spawn one unit for the current tier's `entries` at a ring road tile. Rolls only among
   * kinds with a REGISTERED factory (filterRegisteredEntries) — a composition entry whose
   * unit module hasn't registered yet is transparently excluded from the roll rather than
   * ever reaching spawnAt's factory-undefined branch, so the other kinds in the mix keep
   * filling the cap at their relative weights. Returns false (no side effect) if the ring is
   * empty, no entry has a registered factory, or the pool is full. */
  private trySpawn(
    player: Vec2,
    entries: readonly CompositionEntry[],
    atMax: (kind: UnitKind) => boolean,
  ): boolean {
    const idx = selectSpawnPoint(
      this.roadPoints,
      player.x,
      player.z,
      this.camFwd.x,
      this.camFwd.z,
      SPAWN,
      this.pickIndex,
    );
    if (idx < 0) return false;
    // Eligible = has a registered factory AND is under its per-kind concurrency cap.
    const eligible = filterRegisteredEntries(entries, (k) => factories.has(k) && !atMax(k));
    const kind = pickCompositionKind(eligible, this.rng.next);
    if (kind === null) return false; // nothing in this tier's mix is eligible this round
    return this.spawnAt(idx, kind);
  }

  /** Spawn one unit of a SPECIFIC `kind` (minPreferred fill) at a ring road tile — same
   * ring-point selection as trySpawn, but no weighted roll. Falls through to spawnAt's own
   * factory-undefined guard (returns false, never throws) when `kind`'s unit module hasn't
   * registered a factory yet, so an unmet minimum for a not-yet-built kind just quietly
   * carries over to the next maintenance pass instead of blocking anything. */
  private trySpawnKind(player: Vec2, kind: UnitKind): boolean {
    const idx = selectSpawnPoint(
      this.roadPoints,
      player.x,
      player.z,
      this.camFwd.x,
      this.camFwd.z,
      SPAWN,
      this.pickIndex,
    );
    if (idx < 0) return false;
    return this.spawnAt(idx, kind);
  }

  /** Debug/seam forceSpawn: place one unit of `kind` near the player IGNORING the cap. Prefers
   * a ring point, falls back to the nearest road tile so it (near-)always succeeds. Still
   * bounded by the pool + a registered factory. */
  private forceSpawn(kind: UnitKind): boolean {
    const player = this.getPlayerPos();
    if (player === null) return false;
    let idx = selectSpawnPoint(
      this.roadPoints,
      player.x,
      player.z,
      this.camFwd.x,
      this.camFwd.z,
      SPAWN,
      this.pickIndex,
    );
    if (idx < 0) idx = nearestPointIndex(this.roadPoints, player.x, player.z);
    if (idx < 0) return false;
    return this.spawnAt(idx, kind);
  }

  /** Create + slot a unit of `kind` at road point `idx` (jittered), initial yaw facing the
   * player. Shared by trySpawn (cap fill) and forceSpawn. */
  private spawnAt(idx: number, kind: UnitKind): boolean {
    const factory = factories.get(kind);
    if (factory === undefined) {
      if (import.meta.env.DEV) {
        console.warn(`[spawnDirector] no factory registered for unit kind '${kind}'`);
      }
      return false;
    }
    const player = this.getPlayerPos();
    if (player === null) return false;

    const pt = this.roadPoints[idx];
    const j = SPAWN.spawnJitterM;
    const x = pt.x + (this.rng.next() * 2 - 1) * j;
    const z = pt.z + (this.rng.next() * 2 - 1) * j;
    // Face the player: yawTo(dx,dz) aims a +Z-forward model down (dx,dz).
    const yaw = yawTo(player.x - x, player.z - z);

    const poolId = this.book.acquire();
    if (poolId === undefined) return false; // pool full

    const handle = factory({ x, z, yaw });
    if (handle === null) {
      this.book.release(poolId);
      return false;
    }
    this.handles[poolId] = handle;
    this.slots[poolId] = handle.slot;
    this.wreckObservedAt[poolId] = -1;
    return true;
  }

  private despawn(id: number): void {
    const h = this.handles[id];
    if (h === null) return;
    h.dispose();
    this.handles[id] = null;
    this.slots[id] = freeSlot(id);
    this.wreckObservedAt[id] = -1;
    this.book.release(id);
  }

  /** Despawn everything and drain the pool (run end / retry / unmount). Idempotent. */
  despawnAll(): void {
    for (let i = 0; i < MAX_CAP; i++) {
      if (this.handles[i] !== null) this.despawn(i);
    }
  }

  /** Full teardown (mount unmount). Same as despawnAll — the controller holds no other
   * resources (the factory owns the bodies). */
  dispose(): void {
    this.despawnAll();
  }

  // rng-backed selection injected into the pure pickers (bound once, allocation-free).
  private readonly pickIndex = (indices: readonly number[]): number => this.rng.pick(indices);
}

/** Convenience for the mount: build a controller from a world + seed with live defaults. */
export function createSpawnDirector(
  roadPoints: readonly RoadPoint[],
  seed: number,
): SpawnDirectorController {
  return new SpawnDirectorController({
    roadPoints,
    rng: createRng(seed).fork('spawnDirector'),
  });
}
