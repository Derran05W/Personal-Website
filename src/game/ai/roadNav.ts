// Runtime road-navigation service (Phase 16 Task 5; Phase 30 D1 re-seat onto the NavProvider).
// The impure glue that turns a pursuit unit's "where am I / where's the player" into a road-follow
// STEERING HINT, without the unit owning a map reference or touching the R3F tree. It reads the
// active NavProvider (ai/navProvider.ts) — legacy tile world OR Toronto thermometer, the unit
// never knows which — set by the pursuit director mount (ai/SpawnDirectorMount.tsx) for the run's
// lifetime and cleared on teardown. Every query is a no-op returning null until a provider is
// published (same defensive discipline as unitsRef / squadCoordinator).
//
// CONSUMER CONTRACT (all pursue-capable units — police/armored/swat(unclaimed)/gunTruck(ram)/
// tank): in think(), call approachTargetFor(poseX, poseZ, playerX, playerZ, thisStuck) and pass
// the result as pursueSteer's `approachTarget`. A non-null point means "steer the road way, not
// straight at the player"; pursueSteer uses it ONLY in pursue mode, so passing it unconditionally
// is safe for flank/orbit units too. The gating below is deliberately conservative about the
// close range so the signed-off ram / press-in feel (the BUSTED-critical behaviors) never
// regresses.

import { AI_STEERING } from '../config';
import type { StuckState } from './aiSteering';
import { navProviderRef, sampleLineDrivableVia } from './navProvider';
import type { NavPoint } from './roadPath';

/**
 * The road-graph waypoint a pursue-mode unit should steer toward instead of beelining at the
 * player, or null to steer directly. Returns null (→ direct pursue/press/ram, unchanged) when:
 *   • no provider is live yet, or
 *   • the player is within pressDistM — CLOSE RANGE IS SACRED: ram + slow-target press-in stay
 *     exactly as signed off, so the organic BUSTED terminal behaviour is never overridden.
 * Otherwise returns the provider's next-hop waypoint (NavProvider.nextWaypoint) when the unit is
 *   • farther than roadApproachDistM (the distant-target wedge case — the dominant one), OR
 *   • currently in a post-unstick road-seek window (stuck.roadSeekRemainSec > 0), OR
 *   • its straight line to the player is blocked by buildings (cheap sampled LOS) — the mid-range
 *     "building between me and the player" wedge.
 * The LOS test is only reached in the pressDistM..roadApproachDistM band (far units road-follow
 * unconditionally; close units never do), so it costs a handful of drivable lookups at 10 Hz.
 * Pure given the published provider.
 */
export function approachTargetFor(
  fromX: number,
  fromZ: number,
  playerX: number,
  playerZ: number,
  stuck: StuckState,
): NavPoint | null {
  const nav = navProviderRef.current;
  if (nav === null) return null;

  const dist = Math.hypot(playerX - fromX, playerZ - fromZ);
  // Close range → let pursueSteer's direct pursue / ram / press-in run unchanged.
  if (dist <= AI_STEERING.pressDistM) return null;

  const roadSeeking = stuck.roadSeekRemainSec > 0;
  const losClear =
    sampleLineDrivableVia(
      (x, z) => nav.isDrivable(x, z),
      fromX,
      fromZ,
      playerX,
      playerZ,
      AI_STEERING.roadApproachLosSamples,
    ) >= AI_STEERING.roadApproachLosClearFrac;
  const wantApproach = dist > AI_STEERING.roadApproachDistM || roadSeeking || !losClear;
  if (!wantApproach) return null;

  return nav.nextWaypoint(fromX, fromZ, playerX, playerZ);
}
