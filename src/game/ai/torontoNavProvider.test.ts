import { describe, expect, it } from 'vitest';
import { SPAWN } from '../config';
import { createRng } from '../world/rng';
import { buildStreets } from '../world/toronto/streets';
import { buildTorontoRoadGraph, buildRibbons } from '../world/toronto/roadGraph';
import { TORONTO_SPAWN_POSE } from '../world/toronto/torontoSceneHelpers';
import { createTorontoNavProvider } from './torontoNavProvider';
import { selectSpawnPoint } from './spawnDirector';
import { cameraForwardXZ } from './traffic';

const streets = buildStreets().streets;
const graph = buildTorontoRoadGraph(streets);
const ribbons = buildRibbons(streets);
const provider = createTorontoNavProvider();

/** Brute-force nearest graph node to (x,z), for validating the spatial hash. */
function bruteNearest(x: number, z: number): { x: number; z: number } {
  let best = graph.nodes[0];
  let bestD2 = Infinity;
  for (const n of graph.nodes) {
    const d2 = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = n;
    }
  }
  return { x: best.x, z: best.z };
}

describe('Toronto NavProvider — spawn candidates', () => {
  it('exposes every lane-graph node as a finite RoadPoint', () => {
    const cands = provider.spawnCandidates();
    expect(cands.length).toBe(graph.nodes.length);
    expect(cands.length).toBeGreaterThan(100); // the thermometer has hundreds of nodes
    for (const c of cands) {
      expect(Number.isFinite(c.x) && Number.isFinite(c.z)).toBe(true);
    }
  });
});

describe('Toronto NavProvider — isDrivable (point-in-ribbon)', () => {
  it('a ribbon centre is drivable', () => {
    for (const rib of ribbons) {
      const cx = (rib.minX + rib.maxX) / 2;
      const cz = (rib.minZ + rib.maxZ) / 2;
      expect(provider.isDrivable(cx, cz)).toBe(true);
    }
  });

  it('a point far off every street is not drivable', () => {
    expect(provider.isDrivable(-5000, -5000)).toBe(false);
    expect(provider.isDrivable(50000, 50000)).toBe(false);
  });

  it('the spawn pose (Yonge just south of Finch) is on a drivable street', () => {
    const p = TORONTO_SPAWN_POSE.position;
    expect(provider.isDrivable(p.x, p.z)).toBe(true);
  });
});

describe('Toronto NavProvider — nearestRoadPoint', () => {
  it('returns an on-road point unchanged', () => {
    const rib = ribbons[0];
    const cx = (rib.minX + rib.maxX) / 2;
    const cz = (rib.minZ + rib.maxZ) / 2;
    expect(provider.nearestRoadPoint(cx, cz)).toEqual({ x: cx, z: cz });
  });

  it('snaps an off-road point onto a drivable road (boundary-inclusive)', () => {
    const off = provider.nearestRoadPoint(-5000, -5000);
    expect(off).not.toEqual({ x: -5000, z: -5000 });
    expect(provider.isDrivable(off.x, off.z)).toBe(true);
  });
});

describe('Toronto NavProvider — nextWaypoint (spatial hash + BFS)', () => {
  // nextWaypoint(p, p) resolves from-node === target-node === nearest(p), and BFS(N,N) returns N,
  // so the returned position is exactly the nearest node's — a direct spatial-hash-vs-brute check.
  it('nearest-node lookup matches a brute-force scan for many world points', () => {
    const cands = provider.spawnCandidates();
    const rng = createRng(2024).fork('nav-nearest');
    for (let i = 0; i < 200; i++) {
      // Random points across the candidate cloud's bounding region + some jitter into the void.
      const a = cands[Math.floor(rng.next() * cands.length)];
      const x = a.x + (rng.next() * 2 - 1) * 300;
      const z = a.z + (rng.next() * 2 - 1) * 300;
      const wp = provider.nextWaypoint(x, z, x, z);
      expect(wp).toEqual(bruteNearest(x, z));
    }
  });

  it('returns null only for an empty graph (never for a live map)', () => {
    const p = TORONTO_SPAWN_POSE.position;
    expect(provider.nextWaypoint(p.x, p.z, p.x + 200, p.z + 200)).not.toBeNull();
  });

  it('BFS beads a full route: iterating nextWaypoint from the spawn reaches a far downtown node', () => {
    const spawn = TORONTO_SPAWN_POSE.position;
    // Target = the node with the largest world z (deep downtown / lakefront — furthest south).
    const target = graph.nodes.reduce((a, b) => (b.z > a.z ? b : a));
    let cur = bruteNearest(spawn.x, spawn.z);
    let reached = false;
    for (let step = 0; step < graph.nodes.length + 5; step++) {
      const wp = provider.nextWaypoint(cur.x, cur.z, target.x, target.z);
      expect(wp).not.toBeNull();
      if (Math.hypot(wp!.x - target.x, wp!.z - target.z) < 1e-6) {
        reached = true;
        break;
      }
      // Guard against a stall (BFS must always advance toward a reachable target).
      expect(wp).not.toEqual(cur);
      cur = { x: wp!.x, z: wp!.z };
    }
    expect(reached).toBe(true);
  });
});

describe('Toronto NavProvider — spawn ring on the compact map (seeds 416, 9417)', () => {
  const cands = provider.spawnCandidates();
  const spawn = TORONTO_SPAWN_POSE.position;
  const cam = cameraForwardXZ();
  const cfg = { ringMin: SPAWN.ringMin, ringMax: SPAWN.ringMax };

  it('has lane nodes in the 60–90 m ring around the spawn pose', () => {
    const inRing = cands.filter((c) => {
      const d = Math.hypot(c.x - spawn.x, c.z - spawn.z);
      return d >= SPAWN.ringMin && d <= SPAWN.ringMax;
    });
    expect(inRing.length).toBeGreaterThan(0);
  });

  it('selectSpawnPoint returns a valid in-ring candidate for both seeds', () => {
    for (const seed of [416, 9417]) {
      const rng = createRng(seed).fork('spawnDirector');
      const idx = selectSpawnPoint(cands, spawn.x, spawn.z, cam.x, cam.z, cfg, rng.pick);
      expect(idx).toBeGreaterThanOrEqual(0);
      const d = Math.hypot(cands[idx].x - spawn.x, cands[idx].z - spawn.z);
      expect(d).toBeGreaterThanOrEqual(SPAWN.ringMin - 1e-6);
      expect(d).toBeLessThanOrEqual(SPAWN.ringMax + 1e-6);
    }
  });
});
