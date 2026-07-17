import { describe, it, expect } from 'vitest';
import {
  computeFlankSlots,
  clampToDrivable,
  assignFlankSlots,
  releaseStuckClaims,
  reconcileTimers,
  slotClaimedBy,
  type ClaimMap,
  type FlankSlot,
  type SquadCandidate,
} from './squad';
import { SQUAD, WORLD } from '../config';
import { tileCenter, tileIndex, type Tile, type TileType, type WorldData } from '../world/types';

const DEG2RAD = Math.PI / 180;

// --- test-world builder (only tiles matter to clampToDrivable) --------------------------------

/** A WorldData whose tiles are all `road` except any overridden via `set`. Fully typed — the
 * non-tile fields are empty (clampToDrivable reads only `tiles`). */
function makeWorld(overrides: readonly { col: number; row: number; type: TileType }[] = []): WorldData {
  const tiles: Tile[] = [];
  for (let row = 0; row < WORLD.tiles; row++) {
    for (let col = 0; col < WORLD.tiles; col++) {
      tiles[tileIndex(col, row)] = { col, row, type: 'road', districtId: 0, blockId: -1 };
    }
  }
  for (const o of overrides) {
    const t = tiles[tileIndex(o.col, o.row)];
    tiles[tileIndex(o.col, o.row)] = { ...t, type: o.type };
  }
  return {
    seed: 1,
    tiles,
    blocks: [],
    buildings: [],
    transformers: [],
    districts: [],
    graph: { nodes: [], edges: [], outEdges: [] },
    landmarkSlots: [],
  };
}

// A center-ish tile to experiment on.
const MID = Math.floor(WORLD.tiles / 2);

// ===========================================================================================

describe('computeFlankSlots', () => {
  const origin = { x: 0, z: 0 };

  it('places two slots ±flankOffsetDeg off +Z at flankDistanceM when moving forward fast', () => {
    // Velocity along +Z at 10 m/s (≥ threshold) → base direction is +Z.
    const [left, right] = computeFlankSlots(origin, { x: 0, z: 10 }, 0, SQUAD);
    const off = SQUAD.flankOffsetDeg * DEG2RAD;
    const d = SQUAD.flankDistanceM;
    expect(left.id).toBe(0);
    expect(right.id).toBe(1);
    // Left slot (−offset): −X, ahead in +Z. Right slot (+offset): +X, ahead in +Z.
    expect(left.x).toBeCloseTo(Math.sin(-off) * d);
    expect(left.z).toBeCloseTo(Math.cos(-off) * d);
    expect(right.x).toBeCloseTo(Math.sin(off) * d);
    expect(right.z).toBeCloseTo(Math.cos(off) * d);
    expect(left.x).toBeLessThan(0);
    expect(right.x).toBeGreaterThan(0);
    // Both are the same distance ahead of the player.
    expect(Math.hypot(left.x, left.z)).toBeCloseTo(d);
    expect(Math.hypot(right.x, right.z)).toBeCloseTo(d);
  });

  it('falls back to FACING when the player is slower than flankSpeedThresholdMps', () => {
    // Facing +X (yaw = π/2), nearly stopped → base direction is the facing, not the (tiny) velocity.
    const yaw = Math.PI / 2;
    const [left, right] = computeFlankSlots(origin, { x: 0, z: 0.2 }, yaw, SQUAD);
    const off = SQUAD.flankOffsetDeg * DEG2RAD;
    const d = SQUAD.flankDistanceM;
    // Both slots sit ahead along +X (positive x), split ±30° about it.
    expect(left.x).toBeCloseTo(Math.sin(yaw - off) * d);
    expect(left.z).toBeCloseTo(Math.cos(yaw - off) * d);
    expect(right.x).toBeCloseTo(Math.sin(yaw + off) * d);
    expect(right.z).toBeCloseTo(Math.cos(yaw + off) * d);
    expect(left.x).toBeGreaterThan(0);
    expect(right.x).toBeGreaterThan(0);
  });

  it('uses VELOCITY (not facing) once above the threshold — the two disagree', () => {
    // Facing +Z (yaw 0) but sliding toward +X above threshold → base direction follows velocity.
    const fast = computeFlankSlots(origin, { x: 5, z: 0 }, 0, SQUAD); // speed 5 ≥ 3
    const slow = computeFlankSlots(origin, { x: 1, z: 0 }, 0, SQUAD); // speed 1 < 3 → facing +Z
    // Fast: base +X → both slots have positive x offset AND positive z on one side / negative other.
    // Its midpoint direction is +X, so the mean slot x is clearly positive.
    expect((fast[0].x + fast[1].x) / 2).toBeGreaterThan(5);
    // Slow: base +Z → mean slot z clearly positive, mean x ≈ 0.
    expect((slow[0].z + slow[1].z) / 2).toBeGreaterThan(5);
    expect((slow[0].x + slow[1].x) / 2).toBeCloseTo(0);
  });
});

describe('clampToDrivable', () => {
  it('returns the target unchanged when it already sits on a drivable tile', () => {
    const world = makeWorld(); // all road
    const target = { x: 3.2, z: -7.1 };
    const out = clampToDrivable(target, world, SQUAD);
    expect(out.x).toBe(target.x);
    expect(out.z).toBe(target.z);
  });

  it('snaps a target on a building tile to the nearest drivable tile center', () => {
    const world = makeWorld([{ col: MID, row: MID, type: 'building' }]);
    const target = tileCenter(MID, MID); // dead center of the lone building
    const out = clampToDrivable(target, world, SQUAD);
    // Landed on one of the 4 edge-neighbour road centers, exactly one tile (tileSize) away.
    expect(Math.hypot(out.x - target.x, out.z - target.z)).toBeCloseTo(WORLD.tileSize);
    // And it is genuinely a drivable (road) tile center.
    const drivable =
      [
        tileCenter(MID - 1, MID),
        tileCenter(MID + 1, MID),
        tileCenter(MID, MID - 1),
        tileCenter(MID, MID + 1),
      ].some((c) => c.x === out.x && c.z === out.z);
    expect(drivable).toBe(true);
  });

  it('spirals outward through a building cluster to the nearest drivable center', () => {
    // 3×3 building block centered on MID → nearest road is two tiles from the center tile.
    const block: { col: number; row: number; type: TileType }[] = [];
    for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
      block.push({ col: MID + dc, row: MID + dr, type: 'building' });
    }
    const world = makeWorld(block);
    const target = tileCenter(MID, MID);
    const out = clampToDrivable(target, world, SQUAD);
    // Nearest drivable is an edge road tile two tiles out (2 × tileSize) on an axis.
    expect(Math.hypot(out.x - target.x, out.z - target.z)).toBeCloseTo(2 * WORLD.tileSize);
  });

  it('treats fenced transformer lots as non-drivable (snaps away)', () => {
    const world = makeWorld([{ col: MID, row: MID, type: 'transformerLot' }]);
    const out = clampToDrivable(tileCenter(MID, MID), world, SQUAD);
    expect(Math.hypot(out.x - tileCenter(MID, MID).x, out.z - tileCenter(MID, MID).z)).toBeCloseTo(
      WORLD.tileSize,
    );
  });
});

describe('assignFlankSlots', () => {
  const cfg = { headingWeightM: SQUAD.headingWeightM, hysteresisPct: SQUAD.hysteresisPct };
  // Two slots on the X axis; candidates positioned so the nearest-slot pairing is obvious.
  const slots: FlankSlot[] = [
    { id: 0, x: -10, z: 0 },
    { id: 1, x: 10, z: 0 },
  ];
  // A candidate whose heading already points at (tx,tz) → zero heading-misalignment cost.
  const cand = (unitId: number, x: number, z: number, tx: number, tz: number): SquadCandidate => ({
    unitId,
    x,
    z,
    yaw: Math.atan2(tx - x, tz - z),
  });

  it('assigns each slot to its nearest candidate (maximal, one-to-one)', () => {
    const candidates = [cand(1, -12, 0, -10, 0), cand(2, 12, 0, 10, 0)];
    const claims = assignFlankSlots(slots, candidates, new Map(), cfg);
    expect(claims.get(0)).toBe(1);
    expect(claims.get(1)).toBe(2);
    expect(claims.size).toBe(2);
  });

  it('fills every slot it can even when one candidate is closest to BOTH (no empty slot)', () => {
    // Both candidates sit near slot0; the assignment must still fill slot1 (maximal fill).
    const candidates = [cand(1, -10, 0, -10, 0), cand(2, -9, 1, -10, 0)];
    const claims = assignFlankSlots(slots, candidates, new Map(), cfg);
    expect(claims.size).toBe(2);
    expect(new Set(claims.values())).toEqual(new Set([1, 2]));
  });

  it('fills exactly one slot when there is only one candidate', () => {
    const claims = assignFlankSlots(slots, [cand(1, 9, 0, 10, 0)], new Map(), cfg);
    expect(claims.size).toBe(1);
    expect(claims.get(1)).toBe(1); // closest to slot1
  });

  it('returns no claims with no candidates', () => {
    expect(assignFlankSlots(slots, [], new Map(), cfg).size).toBe(0);
  });

  describe('incumbency hysteresis (one slot, two rivals)', () => {
    const oneSlot: FlankSlot[] = [{ id: 0, x: 0, z: 0 }];
    const incumbent = cand(1, 0, 10, 0, 0); // dist 10, aligned → raw cost 10
    const held: ClaimMap = new Map([[0, 1]]);

    it('KEEPS the incumbent against a challenger less than hysteresisPct cheaper', () => {
      const challenger = cand(2, 0, 9, 0, 0); // dist 9 → 10% cheaper, under the 20% bar
      const claims = assignFlankSlots(oneSlot, [incumbent, challenger], held, cfg);
      expect(claims.get(0)).toBe(1); // incumbent holds
    });

    it('YIELDS to a challenger that beats it by more than hysteresisPct', () => {
      const challenger = cand(2, 0, 7, 0, 0); // dist 7 → 30% cheaper, clears the 20% bar
      const claims = assignFlankSlots(oneSlot, [incumbent, challenger], held, cfg);
      expect(claims.get(0)).toBe(2); // challenger takes it
    });
  });

  it('is STABLE under position jitter (no thrash tick-to-tick)', () => {
    let prev: ClaimMap = new Map();
    const base = [cand(1, -12, 0, -10, 0), cand(2, 12, 0, 10, 0)];
    const first = assignFlankSlots(slots, base, prev, cfg);
    prev = first;
    // Re-assign many times with sub-metre jitter; the assignment must never flip.
    for (let i = 0; i < 20; i++) {
      const j = ((i % 5) - 2) * 0.1; // −0.2..+0.2 m
      const jittered = [cand(1, -12 + j, j, -10, 0), cand(2, 12 - j, -j, 10, 0)];
      const next = assignFlankSlots(slots, jittered, prev, cfg);
      expect(next.get(0)).toBe(first.get(0));
      expect(next.get(1)).toBe(first.get(1));
      prev = next;
    }
  });

  it('accounts for heading misalignment: a closer but wrong-facing unit loses to an aligned one', () => {
    const oneSlot: FlankSlot[] = [{ id: 0, x: 0, z: 0 }];
    // A: slightly closer (dist 8) but facing 180° away (misalign π → +6·π ≈ +18.8 m cost).
    const misfacing: SquadCandidate = { unitId: 1, x: 0, z: 8, yaw: 0 /* faces +Z, away from slot */ };
    // B: a bit farther (dist 10) but pointed straight at the slot (misalign 0).
    const aligned = cand(2, 0, 10, 0, 0);
    const claims = assignFlankSlots(oneSlot, [misfacing, aligned], new Map(), cfg);
    expect(claims.get(0)).toBe(2);
  });
});

describe('releaseStuckClaims', () => {
  const cfg = { reachDistM: SQUAD.reachDistM, unreachableSec: SQUAD.unreachableSec };
  const slots: FlankSlot[] = [{ id: 0, x: 0, z: 0 }];
  const at = (unitId: number, x: number, z: number): SquadCandidate => ({ unitId, x, z, yaw: 0 });

  it('resets the timer and keeps the claim while the claimant is within reachDistM', () => {
    const res = releaseStuckClaims(
      new Map([[0, 1]]),
      slots,
      [at(1, 2, 0)], // dist 2 ≤ reachDistM
      new Map([[0, 1.5]]),
      0.1,
      cfg,
    );
    expect(res.claims.get(0)).toBe(1);
    expect(res.timers.get(0)).toBe(0);
  });

  it('accumulates unreached time while out of range but under the limit', () => {
    const res = releaseStuckClaims(
      new Map([[0, 1]]),
      slots,
      [at(1, 100, 0)], // way out of reach
      new Map([[0, 1.8]]),
      0.1,
      cfg,
    );
    expect(res.claims.get(0)).toBe(1); // still held
    expect(res.timers.get(0)).toBeCloseTo(1.9);
  });

  it('RELEASES the claim once unreached time reaches unreachableSec', () => {
    const res = releaseStuckClaims(
      new Map([[0, 1]]),
      slots,
      [at(1, 100, 0)],
      new Map([[0, 1.95]]),
      0.1,
      cfg,
    );
    expect(res.claims.has(0)).toBe(false); // released
    expect(res.timers.has(0)).toBe(false);
  });

  it('drops an orphaned claim whose claimant is no longer a candidate', () => {
    const res = releaseStuckClaims(new Map([[0, 99]]), slots, [at(1, 0, 0)], new Map(), 0.1, cfg);
    expect(res.claims.size).toBe(0);
  });

  it('drops a claim whose slot no longer exists', () => {
    const res = releaseStuckClaims(new Map([[5, 1]]), slots, [at(1, 0, 0)], new Map(), 0.1, cfg);
    expect(res.claims.size).toBe(0);
  });
});

describe('reconcileTimers', () => {
  it('keeps the timer for an unchanged claim, resets it when the slot changed hands', () => {
    const prior: ClaimMap = new Map([
      [0, 1],
      [1, 2],
    ]);
    const priorTimers = new Map([
      [0, 1.2],
      [1, 0.4],
    ]);
    const final: ClaimMap = new Map([
      [0, 1], // unchanged → keep 1.2
      [1, 3], // changed 2→3 → reset 0
    ]);
    const out = reconcileTimers(final, prior, priorTimers);
    expect(out.get(0)).toBe(1.2);
    expect(out.get(1)).toBe(0);
  });
});

describe('slotClaimedBy', () => {
  it('finds the slot a unit owns, or null', () => {
    const claims: ClaimMap = new Map([
      [0, 7],
      [1, 9],
    ]);
    expect(slotClaimedBy(claims, 9)).toBe(1);
    expect(slotClaimedBy(claims, 7)).toBe(0);
    expect(slotClaimedBy(claims, 5)).toBeNull();
  });
});
