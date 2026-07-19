import { describe, expect, it, afterEach } from 'vitest';
import { SQUAD } from '../config';
import { generate } from '../world/generate';
import {
  createLegacyNavProvider,
  getNavProvider,
  navProviderRef,
  resetNavProvider,
  sampleLineDrivableVia,
  setNavProvider,
  type NavProvider,
} from './navProvider';
import { approachWaypoint, isDrivableAt, sampleLineDrivable } from './roadPath';
import { clampToDrivable } from './squad';
import { collectRoadPoints } from './spawnDirector';

// The legacy provider must reproduce the pre-Phase-30 tile-coupled behaviour EXACTLY: every method
// is proven identical to the underlying pure function the old code called. That equivalence is the
// parity proof — the existing pursuit unit tests (roadPath/squad/spawnDirector) already pin those
// pure functions, so a byte-identical delegate means the pursuit stack is unchanged on the legacy map.

const world = generate(416);

/** A spread of world-space sample points across the map (road, building, edge, off-map). */
function samplePoints(): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = [];
  const half = (64 * 10) / 2; // WORLD.tiles * WORLD.tileSize / 2 for seed 416
  for (let gx = -half; gx <= half; gx += 37) {
    for (let gz = -half; gz <= half; gz += 41) {
      pts.push({ x: gx, z: gz });
    }
  }
  // A couple of explicitly off-map points too.
  pts.push({ x: 9999, z: -9999 }, { x: -12345, z: 6789 });
  return pts;
}

describe('createLegacyNavProvider — byte-identical delegation to the tile helpers', () => {
  const provider = createLegacyNavProvider(world);

  it('isDrivable === roadPath.isDrivableAt(world.tiles) everywhere', () => {
    for (const p of samplePoints()) {
      expect(provider.isDrivable(p.x, p.z)).toBe(isDrivableAt(world.tiles, p.x, p.z));
    }
  });

  it('nearestRoadPoint === squad.clampToDrivable(p, world, SQUAD)', () => {
    for (const p of samplePoints()) {
      expect(provider.nearestRoadPoint(p.x, p.z)).toEqual(clampToDrivable({ x: p.x, z: p.z }, world, SQUAD));
    }
  });

  it('nextWaypoint === roadPath.approachWaypoint(world.graph)', () => {
    const pts = samplePoints();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i * 7 + 3) % pts.length];
      expect(provider.nextWaypoint(a.x, a.z, b.x, b.z)).toEqual(
        approachWaypoint(world.graph, a.x, a.z, b.x, b.z),
      );
    }
  });

  it('spawnCandidates === spawnDirector.collectRoadPoints(world.tiles) (and is memoised stable)', () => {
    const expected = collectRoadPoints(world.tiles);
    expect(provider.spawnCandidates()).toEqual(expected);
    // Memoised: same array identity across calls (the mount recomputes only per world).
    expect(provider.spawnCandidates()).toBe(provider.spawnCandidates());
  });

  it('spawnNav is the {nodes, tiles} bias context the old mount passed', () => {
    const nav = provider.spawnNav();
    expect(nav).toBeDefined();
    expect(nav!.nodes).toBe(world.graph.nodes);
    expect(nav!.tiles).toBe(world.tiles);
  });
});

describe('sampleLineDrivableVia — identical sampling to roadPath.sampleLineDrivable', () => {
  const provider = createLegacyNavProvider(world);
  const isDrivable = (x: number, z: number): boolean => provider.isDrivable(x, z);

  it('reproduces roadPath.sampleLineDrivable for many segments and sample counts', () => {
    const pts = samplePoints();
    for (const samples of [1, 4, 6, 8]) {
      for (let i = 0; i < pts.length; i += 5) {
        const a = pts[i];
        const b = pts[(i + 11) % pts.length];
        expect(sampleLineDrivableVia(isDrivable, a.x, a.z, b.x, b.z, samples)).toBe(
          sampleLineDrivable(a.x, a.z, b.x, b.z, world.tiles, samples),
        );
      }
    }
  });
});

describe('navProviderRef singleton', () => {
  afterEach(() => resetNavProvider());

  it('set/get/reset publish and clear the active provider', () => {
    expect(getNavProvider()).toBeNull();
    const provider: NavProvider = createLegacyNavProvider(world);
    setNavProvider(provider);
    expect(getNavProvider()).toBe(provider);
    expect(navProviderRef.current).toBe(provider);
    resetNavProvider();
    expect(getNavProvider()).toBeNull();
  });
});
