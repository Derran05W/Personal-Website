// The pursuit NAV PROVIDER seam (Phase 30 D1). The legacy 64×64 tile world and the Toronto
// thermometer map answer the SAME four questions the pursuit stack asks of the world:
//   • is world point (x,z) drivable road?            (roadNav LOS + approach-clearness)
//   • what is the nearest drivable point to (x,z)?   (squad flank-slot clamp)
//   • what road-graph waypoint leads from a to b?    (roadNav road-follow steering hint)
//   • where may a pursuit unit spawn?                (spawn director candidate set + bias)
//
// Before Phase 30 those reads were hard-wired to `WorldData.tiles` / `WorldData.graph` in four
// modules (ai/roadPath, ai/roadNav, ai/spawnDirector, ai/squad). The interface below is derived
// verbatim from those call sites — no invented surface. The LEGACY implementation delegates to
// the exact same pure functions those modules already used, so its behaviour is byte-identical
// (the existing pursuit unit tests pin it). The TORONTO implementation (ai/torontoNavProvider.ts)
// answers the same questions off world/toronto's road graph + street ribbons.
//
// There is exactly one live run at a time (game/index.tsx mounts one world), so a plain module
// singleton holds the active provider. The pursuit director mount (ai/SpawnDirectorMount.tsx)
// sets it on mount and clears it on teardown; roadNav + squadCoordinator read it. Every query is
// a no-op returning null/false until a provider is published (same defensive discipline as
// unitsRef / squadCoordinator's roster reads).

import { SQUAD } from '../config';
import type { WorldData } from '../world/types';
import { approachWaypoint, isDrivableAt, type NavPoint } from './roadPath';
import { clampToDrivable } from './squad';
import { collectRoadPoints, type RoadPoint, type SpawnNavContext } from './spawnDirector';

export type { NavPoint };

/**
 * The world-geometry questions the pursuit stack asks. Both maps implement it; consumers never
 * know which map is live. Kept minimal — every method backs a real call site (see file header).
 */
export interface NavProvider {
  /** Is world point (x,z) on drivable road? Backs roadNav's cheap line-of-sight sampling and
   *  the flank-slot drivable clamp. */
  isDrivable(x: number, z: number): boolean;
  /** The nearest drivable point to (x,z); returns (x,z) unchanged when it is already drivable.
   *  Snaps a SWAT flank slot that landed inside a building/void out onto a road. */
  nearestRoadPoint(x: number, z: number): NavPoint;
  /** The road-graph waypoint a unit at (fromX,fromZ) should steer toward when approaching
   *  (targetX,targetZ) — a single next-hop node position, or null when unavailable (empty graph
   *  / degenerate). The physical chase + 3-ray avoidance layer on top (aiSteering). */
  nextWaypoint(fromX: number, fromZ: number, targetX: number, targetZ: number): NavPoint | null;
  /** The spawn director's candidate set: every point a pursuit unit MAY spawn on (road-tile
   *  centres on the legacy map, lane-graph nodes on Toronto). The director's ring + behind-camera
   *  + approach-bias selection runs over these unchanged. Stable per world (memoize internally). */
  spawnCandidates(): readonly RoadPoint[];
  /** Approach-bias context for the director's WEIGHTED spawn pick, or undefined to use the
   *  uniform behind-camera pick. Legacy supplies {nodes, tiles} (bias toward a clear drive across
   *  the building maze); Toronto returns undefined — its candidates ARE lane nodes (all on-road,
   *  no maze), so the uniform pick already converges. */
  spawnNav(): SpawnNavContext | undefined;
}

// --- active-provider singleton (single live run) --------------------------------------------
export const navProviderRef: { current: NavProvider | null } = { current: null };

/** Publish the live nav provider (pursuit director mount effect). */
export function setNavProvider(provider: NavProvider): void {
  navProviderRef.current = provider;
}

/** Clear the live provider (mount teardown / regenerate / retry). */
export function resetNavProvider(): void {
  navProviderRef.current = null;
}

/** The live provider, or null before one is published. */
export function getNavProvider(): NavProvider | null {
  return navProviderRef.current;
}

/**
 * Fraction (0..1) of `samples` INTERIOR points along (x0,z0)→(x1,z1) that are drivable per
 * `isDrivable`. The provider-based analogue of ai/roadPath.sampleLineDrivable — IDENTICAL
 * sampling (endpoints excluded, t = i/(samples+1) for i=1..samples), so a legacy provider whose
 * isDrivable === isDrivableAt reproduces roadPath.sampleLineDrivable exactly (parity). Pure.
 */
export function sampleLineDrivableVia(
  isDrivable: (x: number, z: number) => boolean,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  samples: number,
): number {
  const n = Math.max(1, Math.floor(samples));
  let drivable = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    if (isDrivable(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) drivable++;
  }
  return drivable / n;
}

/**
 * The LEGACY 64×64-tile nav provider — every method delegates to the SAME pure function the
 * pre-Phase-30 tile-coupled code called, so the pursuit stack behaves byte-identically on the
 * legacy world (proven by ai/navProvider.test.ts against the tile helpers directly):
 *   • isDrivable      → roadPath.isDrivableAt(world.tiles, …)
 *   • nearestRoadPoint→ squad.clampToDrivable(p, world, SQUAD)   (the old squadCoordinator clamp)
 *   • nextWaypoint    → roadPath.approachWaypoint(world.graph, …) (the old roadNav waypoint)
 *   • spawnCandidates → spawnDirector.collectRoadPoints(world.tiles) (the old mount roadPoints)
 *   • spawnNav        → { nodes: world.graph.nodes, tiles: world.tiles } (the old bias context)
 * `spawnCandidates` is memoised (candidates are a pure function of the world).
 */
export function createLegacyNavProvider(world: WorldData): NavProvider {
  let candidates: readonly RoadPoint[] | null = null;
  return {
    isDrivable: (x, z) => isDrivableAt(world.tiles, x, z),
    nearestRoadPoint: (x, z) => clampToDrivable({ x, z }, world, SQUAD),
    nextWaypoint: (fromX, fromZ, targetX, targetZ) =>
      approachWaypoint(world.graph, fromX, fromZ, targetX, targetZ),
    spawnCandidates: () => (candidates ??= collectRoadPoints(world.tiles)),
    spawnNav: () => ({ nodes: world.graph.nodes, tiles: world.tiles }),
  };
}
