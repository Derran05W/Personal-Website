// Runtime road-navigation service (Phase 16 Task 5). The impure glue around the pure
// ai/roadPath.ts, mirroring ai/squadCoordinator.ts's "module singleton holds the live world
// data, units query it in think()" shape — so a pursuit unit gets a road-follow steering hint
// without owning a graph reference or touching the R3F tree.
//
// There is exactly one live run at a time (game/index.tsx mounts one world), so a plain module
// singleton is correct. ai/SpawnDirectorMount.tsx (which already receives the world and lives
// inside <Physics> keyed on the world seed) calls setRoadNav(world) on mount and resetRoadNav()
// on teardown — the pursuit-navigation data rides with the same mount that owns the pursuit
// pool, so no new mount is added to game/index.tsx. Every query is a no-op returning null until
// the world is set (same defensive discipline as unitsRef / squadCoordinator).
//
// CONSUMER CONTRACT (all pursue-capable units — police/armored/swat(unclaimed)/gunTruck(ram)/
// tank): in think(), call approachTargetFor(poseX, poseZ, playerX, playerZ, thisStuck) and pass
// the result as pursueSteer's `approachTarget`. A non-null point means "steer the road way, not
// straight at the player"; pursueSteer uses it ONLY in pursue mode, so passing it unconditionally
// is safe for flank/orbit units too. The gating below is deliberately conservative about the
// close range so the signed-off ram / press-in feel (the BUSTED-critical behaviors) never
// regresses.

import { AI_STEERING } from '../config';
import type { WorldData } from '../world/types';
import type { StuckState } from './aiSteering';
import { approachWaypoint, lineLosClear, type NavPoint } from './roadPath';

// --- module-scope live world (single live run) ----------------------------------------------
let world: WorldData | null = null;

/** Publish the live world so pursuit units can road-follow (SpawnDirectorMount mount effect). */
export function setRoadNav(w: WorldData): void {
  world = w;
}

/** Clear the live world (SpawnDirectorMount teardown / regenerate / retry). */
export function resetRoadNav(): void {
  world = null;
}

/** True once a world is published — lets a unit / test cheaply know the service is live. */
export function isRoadNavReady(): boolean {
  return world !== null;
}

/**
 * The road-graph waypoint a pursue-mode unit should steer toward instead of beelining at the
 * player, or null to steer directly. Returns null (→ direct pursue/press/ram, unchanged) when:
 *   • no world is live yet, or
 *   • the player is within pressDistM — CLOSE RANGE IS SACRED: ram + slow-target press-in stay
 *     exactly as signed off, so the organic BUSTED terminal behaviour is never overridden.
 * Otherwise returns a greedy next-node waypoint (ai/roadPath.approachWaypoint) when the unit is
 *   • farther than roadApproachDistM (the distant-target wedge case — the dominant one), OR
 *   • currently in a post-unstick road-seek window (stuck.roadSeekRemainSec > 0), OR
 *   • its straight line to the player is blocked by buildings (cheap tile LOS) — the mid-range
 *     "building between me and the player" wedge.
 * The LOS test is only reached in the pressDistM..roadApproachDistM band (far units road-follow
 * unconditionally; close units never do), so it costs a handful of tile lookups at 10 Hz. Pure
 * given the published world.
 */
export function approachTargetFor(
  fromX: number,
  fromZ: number,
  playerX: number,
  playerZ: number,
  stuck: StuckState,
): NavPoint | null {
  const w = world;
  if (w === null) return null;

  const dist = Math.hypot(playerX - fromX, playerZ - fromZ);
  // Close range → let pursueSteer's direct pursue / ram / press-in run unchanged.
  if (dist <= AI_STEERING.pressDistM) return null;

  const roadSeeking = stuck.roadSeekRemainSec > 0;
  const wantApproach =
    dist > AI_STEERING.roadApproachDistM ||
    roadSeeking ||
    !lineLosClear(
      fromX,
      fromZ,
      playerX,
      playerZ,
      w.tiles,
      AI_STEERING.roadApproachLosSamples,
      AI_STEERING.roadApproachLosClearFrac,
    );
  if (!wantApproach) return null;

  return approachWaypoint(w.graph, fromX, fromZ, playerX, playerZ);
}
