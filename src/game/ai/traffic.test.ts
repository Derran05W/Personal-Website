import { describe, expect, it } from 'vitest';
import {
  SlotBook,
  advanceCursor,
  cameraForwardXZ,
  convertibleHandle,
  cursorPoint,
  quatFromYaw,
  resolveHold,
  selectSpawnNode,
  stepYaw,
  tickWreck,
  upDotFromQuat,
  wrapAngle,
  yawTo,
  type PathCursor,
  type Vec2,
} from './traffic';
import type { TrafficGraph, TrafficNode } from '../world/types';
import type { EntityEntry } from '../world/registry';
import type { ImpactRecord } from '../combat/types';

// --- fixtures --------------------------------------------------------------------------------

function node(id: number, x: number, z: number): TrafficNode {
  return { id, x, z, kind: 'waypoint', tileIndex: 0 };
}

/** A unit square loop: node 0..3 clockwise, each node has exactly one out-edge to the next,
 * so the path is deterministic (0→1→2→3→0…) and every segment is 10 m long. */
function squareLoop(): TrafficGraph {
  const nodes = [node(0, 0, 0), node(1, 10, 0), node(2, 10, 10), node(3, 0, 10)];
  const edges = [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 0 },
  ];
  const outEdges = [[0], [1], [2], [3]];
  return { nodes, edges, outEdges };
}

function cursorOnEdge0(): PathCursor {
  return { fromX: 0, fromZ: 0, toX: 10, toZ: 0, toNodeId: 1, segLenM: 10, progressM: 0 };
}

const firstEdge = (ids: readonly number[]): number => ids[0];

// --- yaw / quaternion helpers ----------------------------------------------------------------

describe('yawTo / quatFromYaw / upDotFromQuat', () => {
  it('faces +Z at yaw 0 and +X at yaw +90°', () => {
    expect(yawTo(0, 1)).toBeCloseTo(0);
    expect(yawTo(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(yawTo(0, -1)).toBeCloseTo(Math.PI);
  });

  it('zero delta yields 0 (keep heading)', () => {
    expect(yawTo(0, 0)).toBe(0);
  });

  it('quatFromYaw is a unit rotation about +Y', () => {
    const q = quatFromYaw(Math.PI / 2);
    expect(q.x).toBe(0);
    expect(q.z).toBe(0);
    expect(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w).toBeCloseTo(1);
  });

  it('upDot is 1 upright, −1 fully inverted, 0 on its side', () => {
    expect(upDotFromQuat(0, 0)).toBeCloseTo(1); // identity (qx=qz=0)
    expect(upDotFromQuat(1, 0)).toBeCloseTo(-1); // 180° about X (qx=1) → inverted
    expect(upDotFromQuat(Math.sin(Math.PI / 4), 0)).toBeCloseTo(0); // 90° about X → on its side
  });
});

describe('wrapAngle / stepYaw', () => {
  it('wraps into (−π, π]', () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(Math.PI);
  });

  it('slews toward target, clamped by maxDelta, shortest way round', () => {
    expect(stepYaw(0, Math.PI / 2, 0.1)).toBeCloseTo(0.1);
    expect(stepYaw(0, -Math.PI / 2, 0.1)).toBeCloseTo(-0.1);
    // within reach → snaps to target
    expect(stepYaw(0, 0.05, 0.1)).toBeCloseTo(0.05);
    // shortest path across the ±π seam (target just past −π from a near-+π heading)
    const near = stepYaw(3.1, -3.1, 0.5);
    expect(Math.abs(wrapAngle(near - -3.1))).toBeLessThan(1e-6);
  });
});

// --- block-ray hold --------------------------------------------------------------------------

describe('resolveHold', () => {
  const cfg = { holdCapSec: 4, creepSpeedMps: 1.5 };

  it('clear road → full cruise, timer reset', () => {
    const r = resolveHold(3.9, false, 1 / 60, 8, cfg);
    expect(r.speed).toBe(8);
    expect(r.blockedSec).toBe(0);
  });

  it('blocked → holds at 0 until the cap, then creeps', () => {
    const dt = 1 / 60;
    let blockedSec = 0;
    let speed = 0;
    // accumulate blocked time up to just under the cap
    for (let t = 0; t < cfg.holdCapSec - dt; t += dt) {
      const r = resolveHold(blockedSec, true, dt, 8, cfg);
      blockedSec = r.blockedSec;
      speed = r.speed;
    }
    expect(speed).toBe(0);
    // one or two more steps crosses the cap → creep
    let steps = 0;
    while (speed === 0 && steps < 5) {
      const r = resolveHold(blockedSec, true, dt, 8, cfg);
      blockedSec = r.blockedSec;
      speed = r.speed;
      steps++;
    }
    expect(speed).toBe(cfg.creepSpeedMps);
    expect(blockedSec).toBeGreaterThanOrEqual(cfg.holdCapSec);
  });
});

// --- edge advance / turns --------------------------------------------------------------------

describe('advanceCursor', () => {
  const graph = squareLoop();

  it('accumulates distance within a segment', () => {
    const c = cursorOnEdge0();
    advanceCursor(c, 5, graph, firstEdge);
    expect(c.progressM).toBeCloseTo(5);
    expect(c.toNodeId).toBe(1);
    const p: Vec2 = { x: 0, z: 0 };
    cursorPoint(c, p);
    expect(p).toMatchObject({ x: expect.closeTo(5), z: expect.closeTo(0) });
  });

  it('rolls onto the next edge carrying the overflow', () => {
    const c = cursorOnEdge0();
    advanceCursor(c, 12, graph, firstEdge); // 10 to node1, 2 into edge 1→2
    expect(c.toNodeId).toBe(2);
    expect(c.progressM).toBeCloseTo(2);
    expect(c.fromX).toBeCloseTo(10);
    expect(c.fromZ).toBeCloseTo(0);
    expect(c.toX).toBeCloseTo(10);
    expect(c.toZ).toBeCloseTo(10);
  });

  it('crosses several nodes in one big step (overflow chains)', () => {
    const c = cursorOnEdge0();
    advanceCursor(c, 27, graph, firstEdge); // node0→node1(10)→node2(20)→7 m onto edge 2→3
    expect(c.toNodeId).toBe(3); // heading down edge 2→3
    expect(c.progressM).toBeCloseTo(7);
    const p: Vec2 = { x: 0, z: 0 };
    cursorPoint(c, p);
    expect(p.x).toBeCloseTo(3); // from (10,10) toward (0,10), 70% along
    expect(p.z).toBeCloseTo(10);
  });

  it('parks at a dead-end node (empty outEdges) instead of looping forever', () => {
    const deadEnd: TrafficGraph = {
      nodes: [node(0, 0, 0), node(1, 10, 0)],
      edges: [{ from: 0, to: 1 }],
      outEdges: [[0], []], // node 1 is a sink
    };
    const c = cursorOnEdge0();
    advanceCursor(c, 999, deadEnd, firstEdge);
    expect(c.toNodeId).toBe(1);
    expect(c.progressM).toBeCloseTo(c.segLenM); // clamped at the node, no hang
  });
});

describe('seeded turn choice validity', () => {
  it('advanceCursor always picks a valid out-edge; toNodeId matches the chosen edge', () => {
    // A hub node 0 with three out-edges to 1/2/3; each of those loops back to 0.
    const nodes = [node(0, 0, 0), node(1, 5, 0), node(2, 0, 5), node(3, -5, 0)];
    const edges = [
      { from: 0, to: 1 },
      { from: 0, to: 2 },
      { from: 0, to: 3 },
      { from: 1, to: 0 },
      { from: 2, to: 0 },
      { from: 3, to: 0 },
    ];
    const outEdges = [
      [0, 1, 2],
      [3],
      [4],
      [5],
    ];
    const graph: TrafficGraph = { nodes, edges, outEdges };
    const validTargets = new Set([1, 2, 3]);
    for (let pickIdx = 0; pickIdx < 3; pickIdx++) {
      // start one metre short of node 0 on edge 3→0, then step across it
      const c: PathCursor = { fromX: 5, fromZ: 0, toX: 0, toZ: 0, toNodeId: 0, segLenM: 5, progressM: 4 };
      advanceCursor(c, 2, graph, (ids) => ids[pickIdx]);
      expect(validTargets.has(c.toNodeId)).toBe(true);
    }
  });
});

// --- wreck state machine ---------------------------------------------------------------------

describe('tickWreck', () => {
  const cfg = { wreckUpDot: 0.3, wreckFlipSustainSec: 1.5 };
  const dt = 1 / 60;

  it('upright never wrecks', () => {
    let s = { flipSec: 0, wrecked: false };
    for (let i = 0; i < 600; i++) {
      const r = tickWreck(s, 1, 30, dt, cfg);
      expect(r.emit).toBe(false);
      s = r.next;
    }
    expect(s.wrecked).toBe(false);
    expect(s.flipSec).toBe(0);
  });

  it('sustained flip emits exactly once, then never again', () => {
    let s = { flipSec: 0, wrecked: false };
    let emits = 0;
    // 120 steps = 2 s of sustained flip, past the 1.5 s threshold
    for (let i = 0; i < 120; i++) {
      const r = tickWreck(s, -1, 30, dt, cfg);
      if (r.emit) emits++;
      s = r.next;
    }
    expect(emits).toBe(1);
    expect(s.wrecked).toBe(true);
  });

  it('a brief flip that recovers does not wreck (timer resets)', () => {
    let s = { flipSec: 0, wrecked: false };
    for (let i = 0; i < 60; i++) s = tickWreck(s, -1, 30, dt, cfg).next; // 1 s flipped (< 1.5)
    expect(s.wrecked).toBe(false);
    const recover = tickWreck(s, 1, 30, dt, cfg); // back upright
    expect(recover.next.flipSec).toBe(0);
    expect(recover.emit).toBe(false);
  });

  it('hp ≤ 0 wrecks immediately regardless of orientation, once', () => {
    const first = tickWreck({ flipSec: 0, wrecked: false }, 1, 0, dt, cfg);
    expect(first.emit).toBe(true);
    expect(first.next.wrecked).toBe(true);
    const again = tickWreck(first.next, 1, 0, dt, cfg);
    expect(again.emit).toBe(false);
  });
});

// --- pool accounting -------------------------------------------------------------------------

describe('SlotBook', () => {
  it('hands out distinct ids up to size, then nothing', () => {
    const book = new SlotBook(3);
    expect(book.activeCount).toBe(0);
    const a = book.acquire();
    const b = book.acquire();
    const c = book.acquire();
    expect(new Set([a, b, c]).size).toBe(3);
    expect([a, b, c].every((id) => id! >= 0 && id! < 3)).toBe(true);
    expect(book.acquire()).toBeUndefined(); // never exceeds the pool
    expect(book.activeCount).toBe(3);
  });

  it('reuses a released slot', () => {
    const book = new SlotBook(2);
    book.acquire();
    const b = book.acquire();
    expect(book.acquire()).toBeUndefined();
    book.release(b!);
    expect(book.activeCount).toBe(1);
    const reused = book.acquire();
    expect(reused).toBe(b);
    expect(book.freeCount).toBe(0);
  });
});

// --- ring node selection ---------------------------------------------------------------------

describe('selectSpawnNode', () => {
  const cfg = { spawnRingMinM: 60, spawnRingMaxM: 90 };
  // Camera looks NW (−X,−Z) from the fixed rig; "behind camera" is toward +X,+Z (SE).
  const cam = cameraForwardXZ(45);

  it('prefers a behind-camera ring node when one exists', () => {
    const nodes = [
      node(0, 0, 0), // player position — too close
      node(1, -75, 0), // in ring, IN FRONT of camera (NW)
      node(2, 53, 53), // in ring (~75 m), BEHIND camera (SE)
      node(3, 200, 0), // outside ring
    ];
    const chosen = selectSpawnNode(nodes, 0, 0, cam.x, cam.z, cfg, firstEdge);
    expect(chosen).toBe(2);
  });

  it('falls back to any ring node when none are behind', () => {
    const nodes = [
      node(0, -75, 0), // in ring, in front (NW)
      node(1, -53, -53), // in ring, in front (NW)
    ];
    const chosen = selectSpawnNode(nodes, 0, 0, cam.x, cam.z, cfg, firstEdge);
    expect([0, 1]).toContain(chosen);
  });

  it('returns −1 when the ring is empty', () => {
    const nodes = [node(0, 0, 0), node(1, 5, 5), node(2, 500, 500)];
    expect(selectSpawnNode(nodes, 0, 0, cam.x, cam.z, cfg, firstEdge)).toBe(-1);
  });
});

describe('cameraForwardXZ', () => {
  it('points NW (−X,−Z) for the default 45° rig and is unit length', () => {
    const f = cameraForwardXZ(45);
    expect(f.x).toBeLessThan(0);
    expect(f.z).toBeLessThan(0);
    expect(Math.hypot(f.x, f.z)).toBeCloseTo(1);
  });
});

// --- conversion gate -------------------------------------------------------------------------

describe('convertibleHandle', () => {
  const civ: EntityEntry = { kind: 'civilian', districtId: -1, hp: 30 };
  const player: EntityEntry = { kind: 'player', districtId: -1 };

  function record(a: EntityEntry | undefined, b: EntityEntry | undefined, forceMag: number): ImpactRecord {
    return { aHandle: 11, bHandle: 22, a, b, forceMag };
  }

  it('returns the civilian handle for a hard enough hit on either side', () => {
    expect(convertibleHandle(record(player, civ, 1000), 900)).toBe(22);
    expect(convertibleHandle(record(civ, player, 1000), 900)).toBe(11);
  });

  it('ignores sub-threshold hits (love-taps free)', () => {
    expect(convertibleHandle(record(player, civ, 500), 900)).toBe(-1);
  });

  it('ignores impacts with no civilian side', () => {
    expect(convertibleHandle(record(player, undefined, 5000), 900)).toBe(-1);
  });
});
