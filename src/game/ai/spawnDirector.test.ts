import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SpawnDirectorController,
  STEPS_PER_THINK,
  capForTier,
  collectRoadPoints,
  countPursuingKind,
  filterRegisteredEntries,
  kindAtMax,
  lingerExpired,
  nearestPointIndex,
  pickCompositionKind,
  registerUnitFactory,
  roadProximityScore,
  scoreSpawnCandidate,
  selectBiasedSpawnPoint,
  selectSpawnPoint,
  shouldThink,
  thinkPhase,
  unregisterUnitFactory,
  type CandidateScoreWeights,
  type RoadPoint,
  type SpawnNavContext,
} from './spawnDirector';
import { cameraForwardXZ, quatFromYaw } from './traffic';
import { SPAWN, SPAWN_COMPOSITION, WORLD, type CompositionEntry } from '../config';
import { createRng } from '../world/rng';
import { gameEvents } from '../state/events';
import type { Tile } from '../world/types';
import type { UnitFactory, UnitHandle, UnitKind, UnitSlot } from './pursuitTypes';

// --- fixtures --------------------------------------------------------------------------------

function tile(col: number, row: number, type: Tile['type']): Tile {
  return { col, row, type, districtId: 0, blockId: type === 'road' ? -1 : 0 };
}

const firstOf = (ids: readonly number[]): number => ids[0];

// A stub unit: a slot-only fake, no physics body — exactly what the task's stub-verification
// path describes, here driving the controller in a plain vitest environment.
interface StubRec {
  readonly slot: UnitSlot;
  thinks: number;
  disposed: boolean;
}

function stubFactory(recs: StubRec[], kind: UnitKind = 'police'): UnitFactory {
  // Faithfully records the pose the director hands it — including the yaw — exactly as a real
  // unit factory (Task 2) writes the spawn pose into its slot.
  return ({ x, z, yaw }) => {
    const q = quatFromYaw(yaw);
    const slot: UnitSlot = {
      id: recs.length,
      kind,
      state: 'pursuing',
      x,
      y: 0,
      z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      hp: 40,
      behaviorLabel: 'pursue',
    };
    const rec: StubRec = { slot, thinks: 0, disposed: false };
    const handle: UnitHandle = {
      slot,
      think() {
        rec.thinks++;
      },
      dispose() {
        rec.disposed = true;
      },
    };
    recs.push(rec);
    return handle;
  };
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// ============================================================================================
// Pure helpers
// ============================================================================================

describe('capForTier', () => {
  it('returns the per-tier concurrent cap from the caps table', () => {
    expect([0, 1, 2, 3, 4, 5].map((t) => capForTier(t, SPAWN.caps))).toEqual([0, 4, 6, 8, 9, 10]);
  });

  it('clamps out-of-range tiers to the table bounds', () => {
    expect(capForTier(-1, SPAWN.caps)).toBe(0);
    expect(capForTier(99, SPAWN.caps)).toBe(10);
    expect(capForTier(0, [])).toBe(0);
  });

  it('scales by the quality pursuit-cap modifier and rounds (Phase 18)', () => {
    // Default modifier = 1 → the raw table value, unchanged.
    expect(capForTier(5, SPAWN.caps, 1)).toBe(10);
    // low tier ×0.7: 10→7, 8→6 (5.6 rounds up), 4→3 (2.8 rounds up).
    expect(capForTier(5, SPAWN.caps, 0.7)).toBe(7);
    expect(capForTier(3, SPAWN.caps, 0.7)).toBe(6);
    expect(capForTier(1, SPAWN.caps, 0.7)).toBe(3);
    // A modifier ≤ 1 can only shrink the cap → never exceeds max(caps) (pool never overflows).
    for (const t of [0, 1, 2, 3, 4, 5]) {
      expect(capForTier(t, SPAWN.caps, 0.7)).toBeLessThanOrEqual(Math.max(...SPAWN.caps));
    }
  });
});

describe('collectRoadPoints', () => {
  it('keeps only road tiles and resolves each to its world-space center', () => {
    const tiles: Tile[] = [
      tile(30, 30, 'building'),
      tile(31, 30, 'road'),
      tile(32, 30, 'park'),
      tile(33, 30, 'road'),
      tile(34, 30, 'parkingLot'),
    ];
    const pts = collectRoadPoints(tiles);
    expect(pts).toHaveLength(2);
    // Centers must be finite, distinct, and carry the flat-grid index they came from.
    expect(pts[0].tileIndex).toBe(1);
    expect(pts[1].tileIndex).toBe(3);
    expect(Number.isFinite(pts[0].x) && Number.isFinite(pts[0].z)).toBe(true);
    expect(pts[0].x).not.toBe(pts[1].x); // col 31 vs 33 → different X
  });

  it('returns nothing when there are no road tiles', () => {
    expect(collectRoadPoints([tile(0, 0, 'building'), tile(1, 0, 'park')])).toEqual([]);
  });
});

describe('selectSpawnPoint', () => {
  const cfg = { ringMin: SPAWN.ringMin, ringMax: SPAWN.ringMax };
  // The fixed §5.3 rig looks NW (−X,−Z); "behind camera" is toward +X,+Z (SE).
  const cam = cameraForwardXZ(45);

  it('selects only in-ring points (excludes too-close and too-far)', () => {
    const points = [
      { x: 20, z: 0 }, // 20 m — inside ringMin, excluded
      { x: 75, z: 0 }, // 75 m — in ring
      { x: 200, z: 0 }, // 200 m — beyond ringMax, excluded
    ];
    // Force selection over the whole candidate pool: firstOf returns whatever the filter kept.
    expect(selectSpawnPoint(points, 0, 0, cam.x, cam.z, cfg, firstOf)).toBe(1);
  });

  it('prefers a behind-camera ring point over an in-front one', () => {
    const points = [
      { x: -75, z: 0 }, // in ring, IN FRONT of camera (NW)
      { x: 53, z: 53 }, // in ring (~75 m), BEHIND camera (SE)
    ];
    expect(selectSpawnPoint(points, 0, 0, cam.x, cam.z, cfg, firstOf)).toBe(1);
  });

  it('falls back to any ring point when none are behind the camera', () => {
    const points = [
      { x: -75, z: 0 }, // in ring, in front
      { x: -53, z: -53 }, // in ring, in front
    ];
    expect([0, 1]).toContain(selectSpawnPoint(points, 0, 0, cam.x, cam.z, cfg, firstOf));
  });

  it('returns −1 when the ring is empty', () => {
    const points = [
      { x: 0, z: 0 },
      { x: 500, z: 500 },
    ];
    expect(selectSpawnPoint(points, 0, 0, cam.x, cam.z, cfg, firstOf)).toBe(-1);
  });
});

describe('nearestPointIndex', () => {
  it('returns the index of the closest point, −1 when empty', () => {
    const points = [
      { x: 100, z: 0 },
      { x: 10, z: 0 },
      { x: 50, z: 0 },
    ];
    expect(nearestPointIndex(points, 0, 0)).toBe(1);
    expect(nearestPointIndex([], 0, 0)).toBe(-1);
  });
});

// ============================================================================================
// Phase 16 Task 5: approach-biased spawn-ring selection (candidate scoring + weighted pick)
// ============================================================================================

describe('roadProximityScore', () => {
  it('is 1 on a node, 0.5 at the reference distance, and decreases monotonically', () => {
    expect(roadProximityScore(0, 10)).toBeCloseTo(1);
    expect(roadProximityScore(10, 10)).toBeCloseTo(0.5);
    expect(roadProximityScore(100, 10)).toBeLessThan(roadProximityScore(30, 10));
    expect(roadProximityScore(1e6, 10)).toBeLessThan(0.001);
  });
});

describe('scoreSpawnCandidate', () => {
  const W: CandidateScoreWeights = {
    roadProximityWeight: 1,
    approachClearnessWeight: 2,
    biasWeightFloor: 0.05,
  };

  it('combines both factors above the floor (both 1 → floor + 1)', () => {
    expect(scoreSpawnCandidate(1, 1, W)).toBeCloseTo(1.05);
  });

  it('collapses to just the floor when approach clearness is 0', () => {
    expect(scoreSpawnCandidate(1, 0, W)).toBeCloseTo(0.05);
  });

  it('increases with approach clearness (a clearer drive scores higher)', () => {
    expect(scoreSpawnCandidate(0.5, 0.9, W)).toBeGreaterThan(scoreSpawnCandidate(0.5, 0.2, W));
  });

  it('a 0 weight ignores that factor (^0 = 1)', () => {
    const ignoreRoad: CandidateScoreWeights = { roadProximityWeight: 0, approachClearnessWeight: 1, biasWeightFloor: 0 };
    // Road proximity 0.1 is ignored → score is purely the clearness term.
    expect(scoreSpawnCandidate(0.1, 0.5, ignoreRoad)).toBeCloseTo(0.5);
  });
});

describe('selectBiasedSpawnPoint', () => {
  const cfg = { ringMin: SPAWN.ringMin, ringMax: SPAWN.ringMax };
  const cam = cameraForwardXZ(45); // "behind" is toward +X,+Z (SE)
  const allOnes = (): number => 1;

  it('excludes too-close / too-far points (same ring gate as selectSpawnPoint)', () => {
    const points = [
      { x: 20, z: 0 }, // too close
      { x: 53, z: 53 }, // in ring, behind
      { x: 300, z: 0 }, // too far
    ];
    expect(selectBiasedSpawnPoint(points, 0, 0, cam.x, cam.z, cfg, allOnes, () => 0)).toBe(1);
  });

  it('prefers a behind-camera candidate over an in-front one', () => {
    const points = [
      { x: -75, z: 0 }, // in ring, in front (NW)
      { x: 53, z: 53 }, // in ring, behind (SE)
    ];
    expect(selectBiasedSpawnPoint(points, 0, 0, cam.x, cam.z, cfg, allOnes, () => 0.5)).toBe(1);
  });

  it('weights the pick toward the higher-scored candidate, but keeps a random tiebreak', () => {
    const points = [
      { x: 53, z: 53 }, // behind, HIGH score
      { x: 50, z: 55 }, // behind, low score
    ];
    const score = (i: number): number => (i === 0 ? 10 : 0.05);
    // A low roll lands in the dominant candidate's mass → index 0.
    expect(selectBiasedSpawnPoint(points, 0, 0, cam.x, cam.z, cfg, score, () => 0)).toBe(0);
    // A high roll can still land on the low-scored candidate → variety preserved (not deterministic).
    expect(selectBiasedSpawnPoint(points, 0, 0, cam.x, cam.z, cfg, score, () => 0.999)).toBe(1);
  });

  it('returns −1 when the ring is empty', () => {
    const points = [
      { x: 0, z: 0 },
      { x: 500, z: 500 },
    ];
    expect(selectBiasedSpawnPoint(points, 0, 0, cam.x, cam.z, cfg, allOnes, () => 0.5)).toBe(-1);
  });
});

// The controller still fills the cap through the approach-biased path when nav context is
// supplied (proving the biased selection never spuriously starves the pool).
describe('SpawnDirectorController — approach-biased selection (nav context)', () => {
  const PLAYER = { x: 0, z: 0 };
  const RING_POINTS: RoadPoint[] = [
    { x: 53, z: 53, tileIndex: 0 },
    { x: 55, z: 50, tileIndex: 1 },
    { x: 50, z: 55, tileIndex: 2 },
    { x: 60, z: 45, tileIndex: 3 },
    { x: 45, z: 60, tileIndex: 4 },
    { x: 58, z: 48, tileIndex: 5 },
    { x: 40, z: 62, tileIndex: 6 },
    { x: 62, z: 40, tileIndex: 7 },
    { x: 38, z: 64, tileIndex: 8 },
    { x: 64, z: 38, tileIndex: 9 },
  ];

  // All-road tile grid + a graph node on each ring candidate → every candidate scores well, so
  // the weighted pick behaves like a healthy uniform-ish draw that always fills the cap.
  function allRoadTiles(): Tile[] {
    const N = WORLD.tiles;
    const tiles: Tile[] = [];
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        tiles.push({ col, row, type: 'road', districtId: 0, blockId: -1 });
      }
    }
    return tiles;
  }
  const nav: SpawnNavContext = {
    nodes: RING_POINTS.map((p) => ({ x: p.x, z: p.z })),
    tiles: allRoadTiles(),
  };

  let recs: StubRec[];
  let tier: number;
  let player: { x: number; z: number } | null;
  let controller: SpawnDirectorController;

  beforeEach(() => {
    recs = [];
    tier = 0;
    player = { ...PLAYER };
    registerUnitFactory('police', stubFactory(recs));
    controller = new SpawnDirectorController({
      roadPoints: RING_POINTS,
      rng: createRng(416).fork('bias-test'),
      getTier: () => tier,
      getPlayerPos: () => player,
      camForward: cameraForwardXZ(),
      nav,
    });
  });

  afterEach(() => {
    controller.dispose();
    unregisterUnitFactory('police');
  });

  it('fills caps[tier] via the biased path and keeps every spawn in the ring', () => {
    tier = 5;
    controller.requestFill();
    controller.stepAfter();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[5]);
    for (const rec of recs) {
      const d = Math.hypot(rec.slot.x - PLAYER.x, rec.slot.z - PLAYER.z);
      expect(d).toBeGreaterThan(SPAWN.ringMin - 5);
      expect(d).toBeLessThan(SPAWN.ringMax + 5);
    }
  });

  it('forceSpawn still succeeds through the biased path', () => {
    expect(controller.api.forceSpawn('police')).toBe(true);
    expect(controller.api.activeCount()).toBe(1);
  });
});

describe('thinkPhase / shouldThink (10 Hz stagger)', () => {
  it('gives the first N pool ids distinct phases when stepsPerThink ≥ N', () => {
    for (const s of [4, 6, 10]) {
      const phases = [0, 1, 2, 3].map((id) => thinkPhase(id, s));
      expect(new Set(phases).size).toBe(4);
    }
  });

  it('each unit thinks exactly once per stepsPerThink cycle', () => {
    const s = STEPS_PER_THINK;
    for (let id = 0; id < s; id++) {
      let count = 0;
      for (let step = 1; step <= s; step++) if (shouldThink(id, step, s)) count++;
      expect(count).toBe(1);
    }
  });

  it('no two of 4 units think on the same step (stepsPerThink ≥ 4)', () => {
    const s = 6;
    for (let step = 0; step < s; step++) {
      const thinking = [0, 1, 2, 3].filter((id) => shouldThink(id, step, s));
      expect(thinking.length).toBeLessThanOrEqual(1);
    }
  });

  it('derives 6 steps per think from 60 Hz physics / 10 Hz decisions', () => {
    expect(STEPS_PER_THINK).toBe(6);
  });
});

describe('pickCompositionKind', () => {
  it('★0 spawns nothing; ★1 is the only single-kind (police) row', () => {
    expect(pickCompositionKind(SPAWN_COMPOSITION.tiers[0], () => 0.5)).toBeNull();
    // ★4 gained gun trucks (Phase 11) and ★5 gained tanks (Phase 12), so ★1 is the only
    // remaining single-kind police row.
    expect(pickCompositionKind(SPAWN_COMPOSITION.tiers[1], () => 0)).toBe('police');
    expect(pickCompositionKind(SPAWN_COMPOSITION.tiers[1], () => 0.999)).toBe('police');
  });

  it('★5 is the full roster + tanks (Phase 12): police at the low roll, tank at the high roll', () => {
    expect(pickCompositionKind(SPAWN_COMPOSITION.tiers[5], () => 0)).toBe('police');
    expect(pickCompositionKind(SPAWN_COMPOSITION.tiers[5], () => 0.999)).toBe('tank');
    // The mix carries every escalation kind so ★5 fields the whole force.
    const kinds = new Set(SPAWN_COMPOSITION.tiers[5].map((e) => e.kind));
    expect(kinds).toEqual(new Set(['police', 'armored', 'swat', 'gunTruck', 'tank']));
  });

  it('rolls proportional to weight across multiple kinds (Phase 10 shape)', () => {
    const entries: CompositionEntry[] = [
      { kind: 'police', weight: 1 },
      { kind: 'armored', weight: 3 },
    ];
    expect(pickCompositionKind(entries, () => 0.1)).toBe('police'); // r=0.4 → −0.6 <0
    expect(pickCompositionKind(entries, () => 0.9)).toBe('armored'); // r=3.6 → past police
  });

  it('returns null for an empty list or all-zero weights', () => {
    expect(pickCompositionKind([], () => 0.5)).toBeNull();
    const zeroed = [{ kind: 'police', weight: 0 }] as const;
    expect(pickCompositionKind(zeroed, () => 0.5)).toBeNull();
  });
});

describe('countPursuingKind', () => {
  function slot(kind: UnitKind | null, state: 'pursuing' | 'wrecked'): UnitSlot {
    return { id: 0, kind, state, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, hp: 1, behaviorLabel: '' };
  }

  it('counts only non-wrecked units of the given kind', () => {
    const slots = [
      slot('swat', 'pursuing'),
      slot('swat', 'pursuing'),
      slot('swat', 'wrecked'), // lingering wreck — must not count
      slot('police', 'pursuing'),
      slot(null, 'pursuing'), // free pool slot — kind is null, must not count
    ];
    expect(countPursuingKind(slots, 'swat')).toBe(2);
    expect(countPursuingKind(slots, 'police')).toBe(1);
    expect(countPursuingKind(slots, 'armored')).toBe(0);
  });

  it('is 0 for an empty slot list', () => {
    expect(countPursuingKind([], 'police')).toBe(0);
  });
});

describe('filterRegisteredEntries', () => {
  const entries: CompositionEntry[] = [
    { kind: 'police', weight: 3 },
    { kind: 'armored', weight: 2 },
    { kind: 'swat', weight: 3 },
  ];

  it('keeps only entries whose kind passes isRegistered, weights untouched', () => {
    const registeredOnlyPoliceAndSwat = (k: string) => k === 'police' || k === 'swat';
    expect(filterRegisteredEntries(entries, registeredOnlyPoliceAndSwat)).toEqual([
      { kind: 'police', weight: 3 },
      { kind: 'swat', weight: 3 },
    ]);
  });

  it('returns everything when all kinds are registered', () => {
    expect(filterRegisteredEntries(entries, () => true)).toEqual(entries);
  });

  it('returns [] when nothing is registered', () => {
    expect(filterRegisteredEntries(entries, () => false)).toEqual([]);
  });
});

describe('★2/★3 composition weights (chi-squared-loose bounds)', () => {
  // Not a strict chi-squared test — a generous tolerance band around the expected proportion
  // across many seeded draws, enough to catch a badly wrong weight (e.g. a swapped ratio)
  // without being flaky over reasonable RNG variance.
  const N = 4000;

  function draw(entries: readonly CompositionEntry[], seedLabel: string): Record<string, number> {
    const rng = createRng(1).fork(seedLabel);
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const kind = pickCompositionKind(entries, rng.next);
      if (kind !== null) counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return counts;
  }

  it('★2 draws police:armored close to the configured 3:2 weight ratio', () => {
    const counts = draw(SPAWN_COMPOSITION.tiers[2], 'tier2-weights');
    const total = (counts.police ?? 0) + (counts.armored ?? 0);
    expect(total).toBe(N);
    const policeFrac = (counts.police ?? 0) / N;
    const armoredFrac = (counts.armored ?? 0) / N;
    // Expected: police 0.6, armored 0.4 — loose ±0.08 band.
    expect(policeFrac).toBeGreaterThan(0.52);
    expect(policeFrac).toBeLessThan(0.68);
    expect(armoredFrac).toBeGreaterThan(0.32);
    expect(armoredFrac).toBeLessThan(0.48);
  });

  it('★3 draws police:armored:swat close to the configured 3:2:3 weight ratio', () => {
    const counts = draw(SPAWN_COMPOSITION.tiers[3], 'tier3-weights');
    const total = (counts.police ?? 0) + (counts.armored ?? 0) + (counts.swat ?? 0);
    expect(total).toBe(N);
    // Expected: police 0.375, armored 0.25, swat 0.375 — loose ±0.08 band each.
    expect((counts.police ?? 0) / N).toBeGreaterThan(0.29);
    expect((counts.police ?? 0) / N).toBeLessThan(0.46);
    expect((counts.armored ?? 0) / N).toBeGreaterThan(0.17);
    expect((counts.armored ?? 0) / N).toBeLessThan(0.33);
    expect((counts.swat ?? 0) / N).toBeGreaterThan(0.29);
    expect((counts.swat ?? 0) / N).toBeLessThan(0.46);
  });
});

describe('lingerExpired', () => {
  it('is false until lingerSec has elapsed since the wreck was observed', () => {
    expect(lingerExpired(0, -1, 10)).toBe(false); // never observed wrecked
    expect(lingerExpired(5, 0, 10)).toBe(false); // 5 s < 10 s
    expect(lingerExpired(9.99, 0, 10)).toBe(false);
    expect(lingerExpired(10, 0, 10)).toBe(true); // exactly at the window
    expect(lingerExpired(30, 22, 10)).toBe(false); // 8 s in
    expect(lingerExpired(33, 22, 10)).toBe(true); // 11 s in
  });
});

// ============================================================================================
// Controller (stub-factory driven — no physics body, mirrors the task's stub-verification path)
// ============================================================================================

describe('SpawnDirectorController', () => {
  const PLAYER = { x: 0, z: 0 };
  // Six in-ring, behind-camera (SE) road points at ~75 m + two decoys the director must ignore.
  const RING_POINTS: RoadPoint[] = [
    { x: 53, z: 53, tileIndex: 0 },
    { x: 55, z: 50, tileIndex: 1 },
    { x: 50, z: 55, tileIndex: 2 },
    { x: 60, z: 45, tileIndex: 3 },
    { x: 45, z: 60, tileIndex: 4 },
    { x: 58, z: 48, tileIndex: 5 },
    { x: 20, z: 0, tileIndex: 6 }, // decoy: inside ringMin
    { x: 300, z: 0, tileIndex: 7 }, // decoy: beyond ringMax
  ];

  let recs: StubRec[];
  let tier: number;
  let player: { x: number; z: number } | null;
  let controller: SpawnDirectorController;

  function makeController(): SpawnDirectorController {
    return new SpawnDirectorController({
      roadPoints: RING_POINTS,
      rng: createRng(416).fork('test'),
      getTier: () => tier,
      getPlayerPos: () => player,
      camForward: cameraForwardXZ(),
    });
  }

  /** One maintenance pass right now (mirrors the tierChanged → requestFill → after-step path). */
  function fillNow() {
    controller.requestFill();
    controller.stepAfter();
  }

  beforeEach(() => {
    recs = [];
    tier = 0;
    player = { ...PLAYER };
    registerUnitFactory('police', stubFactory(recs));
    controller = makeController();
  });

  afterEach(() => {
    controller.dispose();
    unregisterUnitFactory('police');
  });

  it('spawns nothing at ★0', () => {
    fillNow();
    expect(controller.api.activeCount()).toBe(0);
  });

  it('maintains exactly caps[tier] pursuing units as the tier climbs', () => {
    for (const t of [1, 2, 3, 4, 5]) {
      tier = t;
      fillNow();
      expect(controller.api.activeCount()).toBe(SPAWN.caps[t]);
    }
  });

  it('fills the NEW cap immediately on a tier change (requestFill), not on the slow cadence', () => {
    tier = 1;
    // A plain step that is NOT a maintenance-cadence step must not fill on its own...
    controller.stepBefore(); // stepIndex → 1 (not a multiple of the maintain cadence)
    controller.stepAfter();
    expect(controller.api.activeCount()).toBe(0);
    // ...but the tierChanged path (requestFill) fills the new cap on the very next after-step.
    fillNow();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[1]);
  });

  it('spawns only on in-ring road points (60–90 m), never the too-close/too-far decoys', () => {
    tier = 5;
    fillNow();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[5]);
    for (const rec of recs) {
      const d = dist(rec.slot, PLAYER);
      // Central ~75 m points ± spawn jitter — comfortably inside the ring, and provably not
      // one of the 20 m / 300 m decoys.
      expect(d).toBeGreaterThan(SPAWN.ringMin - 5);
      expect(d).toBeLessThan(SPAWN.ringMax + 5);
    }
  });

  it('spawns with an initial yaw facing the player', () => {
    tier = 1;
    fillNow();
    // yawTo(dx,dz) aims a +Z-forward model down (dx,dz); facing the player means the model's
    // forward (sin yaw, cos yaw) points from the unit toward the player.
    for (const rec of recs) {
      const yaw = 2 * Math.atan2(rec.slot.qy, rec.slot.qw); // slot carries the spawn quaternion
      const fwd = { x: Math.sin(yaw), z: Math.cos(yaw) };
      const toPlayer = { x: PLAYER.x - rec.slot.x, z: PLAYER.z - rec.slot.z };
      const len = Math.hypot(toPlayer.x, toPlayer.z);
      const dot = (fwd.x * toPlayer.x + fwd.z * toPlayer.z) / len;
      expect(dot).toBeGreaterThan(0.99); // forward aligns with the direction to the player
    }
  });

  it('despawns units that drift beyond despawnAt (140 m) and disposes them', () => {
    tier = 1;
    fillNow();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[1]);
    const spawned = recs.length;

    // Teleport the player far away: every unit is now > 140 m off, and no road point is in the
    // ring around the new position, so nothing respawns.
    player = { x: 400, z: 0 };
    controller.requestFill();
    controller.stepAfter();

    expect(controller.api.activeCount()).toBe(0);
    expect(recs.slice(0, spawned).every((r) => r.disposed)).toBe(true);
  });

  it('round-robins think() so each of 4 units thinks once per 10 Hz cycle', () => {
    tier = 1;
    fillNow(); // 4 units at pool ids 0..3, stepIndex still 0
    for (let s = 0; s < STEPS_PER_THINK; s++) controller.stepBefore();
    // Over one full cycle each of the 4 distinct-phase units thinks exactly once.
    for (let i = 0; i < 4; i++) expect(recs[i].thinks).toBe(1);
  });

  // These two exercise the EXACT gameEvents wiring SpawnDirectorMount.tsx sets up, so the
  // mount's event→controller plumbing is proven without a browser.
  it('tierChanged event → requestFill fills the new cap on the next after-step', () => {
    const off = gameEvents.on('tierChanged', () => controller.requestFill());
    tier = 1;
    gameEvents.emit('tierChanged', { tier: 1, prevTier: 0 });
    controller.stepAfter();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[1]);
    off();
  });

  it('runEnded event → despawnAll drains the pool', () => {
    const off = gameEvents.on('runEnded', () => controller.despawnAll());
    tier = 1;
    fillNow();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[1]);
    gameEvents.emit('runEnded', { score: 0, reason: 'wrecked' });
    expect(controller.api.activeCount()).toBe(0);
    expect(recs.every((r) => r.disposed)).toBe(true);
    off();
  });

  it('forceSpawn ignores the cap and despawnAll drains the pool + disposes', () => {
    // ★0: automatic fill spawns nothing, but forceSpawn still creates a unit.
    expect(controller.api.forceSpawn('police')).toBe(true);
    expect(controller.api.forceSpawn('police')).toBe(true);
    expect(controller.api.activeCount()).toBe(2);

    controller.api.despawnAll();
    expect(controller.api.activeCount()).toBe(0);
    expect(recs.every((r) => r.disposed)).toBe(true);
  });

  it('replaces a wrecked unit while it lingers, then reclaims the wreck after wreckLingerSec', () => {
    tier = 1;
    fillNow();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[1]); // 4 pursuing

    // Wreck one unit: it stops counting toward the cap, so the director spawns a replacement
    // (the wreck lingers as a 5th live body).
    recs[0].slot.state = 'wrecked';
    fillNow();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[1] + 1); // 4 pursuing + 1 lingering wreck
    expect(recs[0].disposed).toBe(false);

    // Advance sim time past the linger window (maintenance runs on its cadence).
    const steps = Math.ceil((SPAWN.wreckLingerSec + 1) * 60);
    for (let s = 0; s < steps; s++) {
      controller.stepBefore();
      controller.stepAfter();
    }
    expect(recs[0].disposed).toBe(true);
    expect(controller.api.activeCount()).toBe(SPAWN.caps[1]); // back to steady state
  });
});

// ============================================================================================
// minPreferred fill order (Phase 10 Task 3) — three stub factories (police/armored/swat), all
// registered, driving the real ★2/★3 SPAWN_COMPOSITION rows.
// ============================================================================================

describe('SpawnDirectorController — minPreferred fill order', () => {
  const PLAYER = { x: 0, z: 0 };
  const RING_POINTS: RoadPoint[] = [
    { x: 53, z: 53, tileIndex: 0 },
    { x: 55, z: 50, tileIndex: 1 },
    { x: 50, z: 55, tileIndex: 2 },
    { x: 60, z: 45, tileIndex: 3 },
    { x: 45, z: 60, tileIndex: 4 },
    { x: 58, z: 48, tileIndex: 5 },
    { x: 40, z: 62, tileIndex: 6 },
    { x: 62, z: 40, tileIndex: 7 },
  ];

  let recs: StubRec[];
  let tier: number;
  let player: { x: number; z: number } | null;
  let controller: SpawnDirectorController;

  beforeEach(() => {
    recs = [];
    tier = 0;
    player = { ...PLAYER };
    registerUnitFactory('police', stubFactory(recs, 'police'));
    registerUnitFactory('armored', stubFactory(recs, 'armored'));
    registerUnitFactory('swat', stubFactory(recs, 'swat'));
    controller = new SpawnDirectorController({
      roadPoints: RING_POINTS,
      rng: createRng(77).fork('minpreferred-test'),
      getTier: () => tier,
      getPlayerPos: () => player,
      camForward: cameraForwardXZ(),
    });
  });

  afterEach(() => {
    controller.dispose();
    unregisterUnitFactory('police');
    unregisterUnitFactory('armored');
    unregisterUnitFactory('swat');
  });

  it("★3 fills its minPreferred SWAT quota before spending the rest of the cap on the weighted roll", () => {
    tier = 3;
    controller.requestFill();
    controller.stepAfter();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[3]);

    const minSwat = SPAWN_COMPOSITION.minPreferred?.[3]?.find((p) => p.kind === 'swat')?.count ?? 0;
    expect(minSwat).toBeGreaterThan(0); // sanity: the config row this test exercises is non-trivial
    // Pass 1 (minPreferred) always completes before pass 2 (weighted) within one maintain()
    // call, so the FIRST `minSwat` units ever spawned this run must be the guaranteed kind.
    expect(recs.slice(0, minSwat).every((r) => r.slot.kind === 'swat')).toBe(true);
    // And the quota is actually met live, not just attempted first.
    expect(recs.filter((r) => r.slot.kind === 'swat').length).toBeGreaterThanOrEqual(minSwat);
  });

  it('a wrecked (lingering) SWAT unit stops counting toward the quota, so a replacement spawns', () => {
    tier = 3;
    controller.requestFill();
    controller.stepAfter();
    const swatBefore = recs.filter((r) => r.slot.kind === 'swat' && r.slot.state !== 'wrecked').length;
    expect(swatBefore).toBeGreaterThanOrEqual(2);

    const swatRec = recs.find((r) => r.slot.kind === 'swat');
    expect(swatRec).toBeDefined();
    swatRec!.slot.state = 'wrecked'; // lingers as debris — must not count toward the >=2 floor

    controller.requestFill();
    controller.stepAfter();

    const pursuingSwat = recs.filter((r) => r.slot.kind === 'swat' && r.slot.state !== 'wrecked').length;
    expect(pursuingSwat).toBeGreaterThanOrEqual(2);
  });

  it('★2 has no minPreferred entry — fills purely from its two-kind weighted roll', () => {
    tier = 2;
    controller.requestFill();
    controller.stepAfter();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[2]);
    expect(SPAWN_COMPOSITION.minPreferred?.[2] ?? []).toEqual([]);
    // Only ★2's two configured kinds ever appear (no leakage from swat, which has no floor
    // and a zero weight in this tier's row).
    expect(recs.every((r) => r.slot.kind === 'police' || r.slot.kind === 'armored')).toBe(true);
    expect(recs).toHaveLength(SPAWN.caps[2]);
  });
});

// ============================================================================================
// Unknown-factory fallback (Phase 10 Task 3) — a composition pick whose kind has no registered
// factory (Task 2's armored/swat units land on their own schedule) must skip cleanly: fall
// back to a registered kind within the same tier, or spawn nothing this round — never throw.
// ============================================================================================

describe('SpawnDirectorController — unknown-factory fallback', () => {
  const PLAYER = { x: 0, z: 0 };
  const RING_POINTS: RoadPoint[] = [
    { x: 53, z: 53, tileIndex: 0 },
    { x: 55, z: 50, tileIndex: 1 },
    { x: 50, z: 55, tileIndex: 2 },
    { x: 60, z: 45, tileIndex: 3 },
    { x: 45, z: 60, tileIndex: 4 },
    { x: 58, z: 48, tileIndex: 5 },
  ];

  let recs: StubRec[];
  let tier: number;
  let player: { x: number; z: number } | null;
  let controller: SpawnDirectorController;

  beforeEach(() => {
    recs = [];
    tier = 0;
    player = { ...PLAYER };
    controller = new SpawnDirectorController({
      roadPoints: RING_POINTS,
      rng: createRng(99).fork('unknown-factory-test'),
      getTier: () => tier,
      getPlayerPos: () => player,
      camForward: cameraForwardXZ(),
    });
  });

  afterEach(() => {
    controller.dispose();
    unregisterUnitFactory('police');
    unregisterUnitFactory('armored');
    unregisterUnitFactory('swat');
  });

  it('★2 fills entirely with police when armored has no registered factory yet (never throws)', () => {
    registerUnitFactory('police', stubFactory(recs, 'police'));
    // Deliberately NOT registering 'armored' — simulates Task 2 (armored/swat units) still
    // being mid-flight while this composition/director work lands.
    tier = 2;
    expect(() => {
      controller.requestFill();
      controller.stepAfter();
    }).not.toThrow();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[2]);
    expect(recs.every((r) => r.slot.kind === 'police')).toBe(true);
  });

  it('a tier whose entire mix has no registered factory spawns nothing, never throws, never hangs', () => {
    // No factories registered at all — worst case for the fallback guard.
    tier = 1; // ★1's composition is police-only
    expect(() => {
      controller.requestFill();
      controller.stepAfter();
    }).not.toThrow();
    expect(controller.api.activeCount()).toBe(0);
    expect(recs).toHaveLength(0);
  });

  it('forceSpawn of an unregistered kind returns false cleanly instead of throwing', () => {
    expect(() => controller.api.forceSpawn('swat')).not.toThrow();
    expect(controller.api.forceSpawn('swat')).toBe(false);
    expect(controller.api.activeCount()).toBe(0);
  });

  it('★3 minPreferred SWAT quota is skipped (not spun on) when swat has no registered factory', () => {
    registerUnitFactory('police', stubFactory(recs, 'police'));
    registerUnitFactory('armored', stubFactory(recs, 'armored'));
    // swat deliberately unregistered — the minPreferred pass must give up on it cleanly and
    // let the weighted pass fill the rest of the cap with the registered kinds.
    tier = 3;
    expect(() => {
      controller.requestFill();
      controller.stepAfter();
    }).not.toThrow();
    expect(controller.api.activeCount()).toBe(SPAWN.caps[3]);
    expect(recs.every((r) => r.slot.kind === 'police' || r.slot.kind === 'armored')).toBe(true);
  });
});

// ============================================================================================
// maxOfKind concurrency cap (Phase 11) — the generic ≤N-of-a-kind rule (SPAWN_COMPOSITION.
// maxOfKind), used at ★4 to hold gun trucks at ≤ 2 however the weighted rolls fall.
// ============================================================================================

describe('kindAtMax (pure per-kind concurrency predicate)', () => {
  const slotOf = (kind: UnitKind, state: UnitSlot['state'] = 'pursuing'): UnitSlot => ({
    id: 0,
    kind,
    state,
    x: 0,
    y: 0,
    z: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    hp: 100,
    behaviorLabel: '',
  });

  it('is false for a kind with no cap entry (uncapped)', () => {
    expect(kindAtMax([slotOf('gunTruck'), slotOf('gunTruck')], 'gunTruck', [])).toBe(false);
  });

  it('is true once the live (pursuing) count reaches the cap', () => {
    const cap = [{ kind: 'gunTruck' as const, max: 2 }];
    expect(kindAtMax([slotOf('gunTruck')], 'gunTruck', cap)).toBe(false);
    expect(kindAtMax([slotOf('gunTruck'), slotOf('gunTruck')], 'gunTruck', cap)).toBe(true);
  });

  it('ignores wrecked (lingering) units — only pursuers count toward the cap', () => {
    const cap = [{ kind: 'gunTruck' as const, max: 2 }];
    const slots = [slotOf('gunTruck'), slotOf('gunTruck', 'wrecked')];
    expect(kindAtMax(slots, 'gunTruck', cap)).toBe(false); // one wreck → only 1 pursuer
  });
});

describe('SpawnDirectorController — ★4 gun-truck maxOfKind cap', () => {
  const PLAYER = { x: 0, z: 0 };
  const RING_POINTS: RoadPoint[] = [
    { x: 53, z: 53, tileIndex: 0 },
    { x: 55, z: 50, tileIndex: 1 },
    { x: 50, z: 55, tileIndex: 2 },
    { x: 60, z: 45, tileIndex: 3 },
    { x: 45, z: 60, tileIndex: 4 },
    { x: 58, z: 48, tileIndex: 5 },
    { x: 40, z: 62, tileIndex: 6 },
    { x: 62, z: 40, tileIndex: 7 },
    { x: 38, z: 64, tileIndex: 8 },
    { x: 64, z: 38, tileIndex: 9 },
  ];

  let recs: StubRec[];
  let tier: number;
  let player: { x: number; z: number } | null;
  let controller: SpawnDirectorController;

  beforeEach(() => {
    recs = [];
    tier = 0;
    player = { ...PLAYER };
    registerUnitFactory('police', stubFactory(recs, 'police'));
    registerUnitFactory('armored', stubFactory(recs, 'armored'));
    registerUnitFactory('swat', stubFactory(recs, 'swat'));
    registerUnitFactory('gunTruck', stubFactory(recs, 'gunTruck'));
    controller = new SpawnDirectorController({
      roadPoints: RING_POINTS,
      rng: createRng(2024).fork('maxofkind-test'),
      getTier: () => tier,
      getPlayerPos: () => player,
      camForward: cameraForwardXZ(),
    });
  });

  afterEach(() => {
    controller.dispose();
    unregisterUnitFactory('police');
    unregisterUnitFactory('armored');
    unregisterUnitFactory('swat');
    unregisterUnitFactory('gunTruck');
  });

  it('fills caps[4] but never exceeds 2 gun trucks, across many maintain passes', () => {
    tier = 4;
    const maxGun = SPAWN_COMPOSITION.maxOfKind?.[4]?.find((m) => m.kind === 'gunTruck')?.max ?? 0;
    expect(maxGun).toBe(2); // sanity: the config row this test exercises
    for (let pass = 0; pass < 40; pass++) {
      controller.requestFill();
      controller.stepAfter();
      const liveGun = controller.api.slots.filter(
        (s) => s.kind === 'gunTruck' && s.state !== 'wrecked',
      ).length;
      expect(liveGun).toBeLessThanOrEqual(maxGun);
    }
    expect(controller.api.activeCount()).toBe(SPAWN.caps[4]);
  });

  it('guarantees the minPreferred gun truck AND respects the cap simultaneously', () => {
    tier = 4;
    controller.requestFill();
    controller.stepAfter();
    const liveGun = controller.api.slots.filter(
      (s) => s.kind === 'gunTruck' && s.state !== 'wrecked',
    ).length;
    expect(liveGun).toBeGreaterThanOrEqual(1); // minPreferred floor
    expect(liveGun).toBeLessThanOrEqual(2); // maxOfKind cap
  });

  it('a wrecked gun truck frees a cap slot so a replacement can spawn', () => {
    tier = 4;
    controller.requestFill();
    controller.stepAfter();
    // Wreck every live gun truck; the cap counts pursuers only, so replacements are allowed.
    let wreckedAny = false;
    for (const s of controller.api.slots) {
      if (s.kind === 'gunTruck' && s.state !== 'wrecked') {
        s.state = 'wrecked';
        wreckedAny = true;
      }
    }
    expect(wreckedAny).toBe(true);
    controller.requestFill();
    controller.stepAfter();
    const pursuingGun = controller.api.slots.filter(
      (s) => s.kind === 'gunTruck' && s.state !== 'wrecked',
    ).length;
    expect(pursuingGun).toBeGreaterThanOrEqual(1);
    expect(pursuingGun).toBeLessThanOrEqual(2);
  });
});
