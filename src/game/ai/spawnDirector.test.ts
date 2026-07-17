import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SpawnDirectorController,
  STEPS_PER_THINK,
  capForTier,
  collectRoadPoints,
  lingerExpired,
  nearestPointIndex,
  pickCompositionKind,
  registerUnitFactory,
  selectSpawnPoint,
  shouldThink,
  thinkPhase,
  unregisterUnitFactory,
  type RoadPoint,
} from './spawnDirector';
import { cameraForwardXZ, quatFromYaw } from './traffic';
import { SPAWN, SPAWN_COMPOSITION, type CompositionEntry } from '../config';
import { createRng } from '../world/rng';
import { gameEvents } from '../state/events';
import type { Tile } from '../world/types';
import type { UnitFactory, UnitHandle, UnitSlot } from './pursuitTypes';

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

function stubFactory(recs: StubRec[]): UnitFactory {
  // Faithfully records the pose the director hands it — including the yaw — exactly as a real
  // unit factory (Task 2) writes the spawn pose into its slot.
  return ({ x, z, yaw }) => {
    const q = quatFromYaw(yaw);
    const slot: UnitSlot = {
      id: recs.length,
      kind: 'police',
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
  it('v1 table: ★0 spawns nothing; every tier ≥ ★1 picks police', () => {
    expect(pickCompositionKind(SPAWN_COMPOSITION.tiers[0], () => 0.5)).toBeNull();
    for (let t = 1; t <= 5; t++) {
      expect(pickCompositionKind(SPAWN_COMPOSITION.tiers[t], () => 0)).toBe('police');
      expect(pickCompositionKind(SPAWN_COMPOSITION.tiers[t], () => 0.999)).toBe('police');
    }
  });

  it('rolls proportional to weight across multiple kinds (Part 4 shape)', () => {
    // UnitKind is only 'police' in v1; cast a two-kind table to prove the picker is generic
    // over the composition shape Part 4 will use (police + a heavier unit at higher tiers).
    const entries = [
      { kind: 'police', weight: 1 },
      { kind: 'armored', weight: 3 },
    ] as unknown as readonly CompositionEntry[];
    expect(pickCompositionKind(entries, () => 0.1) as string).toBe('police'); // r=0.4 → −0.6 <0
    expect(pickCompositionKind(entries, () => 0.9) as string).toBe('armored'); // r=3.6 → past police
  });

  it('returns null for an empty list or all-zero weights', () => {
    expect(pickCompositionKind([], () => 0.5)).toBeNull();
    const zeroed = [{ kind: 'police', weight: 0 }] as const;
    expect(pickCompositionKind(zeroed, () => 0.5)).toBeNull();
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
