import { describe, expect, it } from 'vitest';
import {
  advanceAvenueCursor,
  avenueCursorAtDistance,
  avenueCursorHeading,
  avenueCursorPoint,
  avenueOneWayLength,
  avenueRoundTripLength,
  avenueSegLength,
  getStreetcarAvenues,
  resolveStreetcarHold,
  type AvenueCursor,
  type AvenuePath,
} from './streetcarTraffic';
import { TRAFFIC_CIV, TRAFFIC_STREETCAR, trafficActiveTarget } from '../config';
import { PLAYER_CARS, VEHICLE_TUNING } from '../config/vehicles';
import { getCarDef } from '../vehicles/definitions';
import { convertibleHandle } from './traffic';
import type { EntityEntry } from '../world/registry';
import type { ImpactRecord } from '../combat/types';

// --- fixtures --------------------------------------------------------------------------------

/** An OPEN two-segment avenue, 30 m then 20 m (one-way 50 m, round trip 100 m) — a bend, not a
 * straight line, so heading changes are exercised too. Mirrors world/types.ts's LanePath.points
 * shape (a median centerline, one end of an arterial to the other — never closed). */
function bentAvenue(): AvenuePath {
  return [
    { x: 0, z: 0 },
    { x: 30, z: 0 },
    { x: 30, z: 20 },
  ];
}

/** A plain straight 40 m avenue (one segment) — the simplest there-and-back case. */
function straightAvenue(): AvenuePath {
  return [
    { x: 0, z: 0 },
    { x: 40, z: 0 },
  ];
}

function impact(a: EntityEntry | undefined, b: EntityEntry | undefined, forceMag: number): ImpactRecord {
  return { aHandle: 1, bHandle: 2, a, b, forceMag };
}

// --- avenue path math (pure) ------------------------------------------------------------------

describe('avenueSegLength / avenueOneWayLength / avenueRoundTripLength', () => {
  it('measures each segment (no wraparound/closing segment)', () => {
    const path = bentAvenue();
    expect(avenueSegLength(path, 0)).toBeCloseTo(30);
    expect(avenueSegLength(path, 1)).toBeCloseTo(20);
  });

  it('one-way length is the sum of segments; round trip is exactly double', () => {
    expect(avenueOneWayLength(bentAvenue())).toBeCloseTo(50);
    expect(avenueRoundTripLength(bentAvenue())).toBeCloseTo(100);
    expect(avenueOneWayLength(straightAvenue())).toBeCloseTo(40);
    expect(avenueRoundTripLength(straightAvenue())).toBeCloseTo(80);
  });

  it('degenerate paths (<2 points) have zero length', () => {
    expect(avenueOneWayLength([])).toBe(0);
    expect(avenueOneWayLength([{ x: 0, z: 0 }])).toBe(0);
    expect(avenueRoundTripLength([{ x: 0, z: 0 }])).toBe(0);
  });
});

describe('avenueCursorAtDistance (there-and-back fold)', () => {
  it('resolves a distance within the first segment, heading forward (dir 1)', () => {
    const c = avenueCursorAtDistance(bentAvenue(), 10);
    expect(c.segIndex).toBe(0);
    expect(c.progressM).toBeCloseTo(10);
    expect(c.dir).toBe(1);
  });

  it('resolves a distance into the second segment, still forward', () => {
    const c = avenueCursorAtDistance(bentAvenue(), 35); // 30 (seg0) + 5 into seg1
    expect(c.segIndex).toBe(1);
    expect(c.progressM).toBeCloseTo(5);
    expect(c.dir).toBe(1);
  });

  it('exactly at the far tip (one-way length) is still forward-facing', () => {
    const c = avenueCursorAtDistance(bentAvenue(), 50);
    expect(c.segIndex).toBe(1);
    expect(c.progressM).toBeCloseTo(20);
    expect(c.dir).toBe(1);
  });

  it('past the one-way length reflects onto the return leg (dir -1)', () => {
    const c = avenueCursorAtDistance(bentAvenue(), 60); // 10 m into the return leg
    expect(c.dir).toBe(-1);
    expect(c.segIndex).toBe(1); // still 10 m from the far tip -> still on segment 1 (20 m long)
    expect(c.progressM).toBeCloseTo(10);
  });

  it('a full round trip returns exactly to the start, forward-facing again', () => {
    const c = avenueCursorAtDistance(bentAvenue(), 100);
    expect(c.dir).toBe(1);
    expect(c.segIndex).toBe(0);
    expect(c.progressM).toBeCloseTo(0);
  });

  it('wraps distances beyond one round trip via modulo', () => {
    const c = avenueCursorAtDistance(bentAvenue(), 100 + 10); // one full there-and-back + 10 m
    expect(c.dir).toBe(1);
    expect(c.segIndex).toBe(0);
    expect(c.progressM).toBeCloseTo(10);
  });

  it('wraps negative distances into the tail of the round trip (the return leg)', () => {
    const c = avenueCursorAtDistance(bentAvenue(), -10); // 10 m "before" the start = 10 m of return leg left
    expect(c.dir).toBe(-1);
    expect(c.segIndex).toBe(0);
    expect(c.progressM).toBeCloseTo(10);
  });

  it('degenerate path returns a zero-length forward-facing cursor, never throws', () => {
    const c = avenueCursorAtDistance([{ x: 5, z: 5 }], 100);
    expect(c.segIndex).toBe(0);
    expect(c.progressM).toBe(0);
    expect(c.dir).toBe(1);
  });
});

describe('advanceAvenueCursor / avenueCursorPoint / avenueCursorHeading', () => {
  it('accumulates distance within a segment', () => {
    const c: AvenueCursor = { segIndex: 0, segLenM: 30, progressM: 0, dir: 1 };
    advanceAvenueCursor(bentAvenue(), c, 15);
    expect(c.segIndex).toBe(0);
    expect(c.progressM).toBeCloseTo(15);
    expect(c.dir).toBe(1);
  });

  it('rolls onto the next segment, carrying overflow', () => {
    const c: AvenueCursor = { segIndex: 0, segLenM: 30, progressM: 25, dir: 1 };
    advanceAvenueCursor(bentAvenue(), c, 10); // 25 + 10 = 35 > 30 -> rolls, 5 m overflow
    expect(c.segIndex).toBe(1);
    expect(c.progressM).toBeCloseTo(5);
    expect(c.dir).toBe(1);
  });

  it('reflects at the far tip instead of wrapping — direction flips, position holds', () => {
    const c: AvenueCursor = { segIndex: 1, segLenM: 20, progressM: 15, dir: 1 };
    advanceAvenueCursor(bentAvenue(), c, 10); // 15 + 10 = 25 > 20 (5 m past the far tip) -> reflect
    expect(c.dir).toBe(-1);
    expect(c.segIndex).toBe(1); // still on the last segment, now counting down
    expect(c.progressM).toBeCloseTo(15); // 20 - 5 m overshoot
  });

  it('reflects at the near tip (the path start) back onto the forward leg', () => {
    const c: AvenueCursor = { segIndex: 0, segLenM: 30, progressM: 5, dir: -1 };
    advanceAvenueCursor(bentAvenue(), c, 10); // 5 m of room, then 5 m past the start -> reflect
    expect(c.dir).toBe(1);
    expect(c.segIndex).toBe(0);
    expect(c.progressM).toBeCloseTo(5);
  });

  it('a there-and-back round trip driven step-by-step returns exactly to the start', () => {
    const path = bentAvenue();
    const c: AvenueCursor = { segIndex: 0, segLenM: avenueSegLength(path, 0), progressM: 0, dir: 1 };
    const total = avenueRoundTripLength(path);
    const stepM = 2;
    let travelled = 0;
    while (travelled < total) {
      advanceAvenueCursor(path, c, stepM);
      travelled += stepM;
    }
    expect(c.dir).toBe(1);
    const p = avenueCursorPoint(path, c, { x: 0, z: 0 });
    // 100 m / 2 m per step = exactly 50 steps -> lands exactly back at (0,0).
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.z).toBeCloseTo(0, 5);
  });

  it('degenerate path (<2 points) is a no-op, never throws', () => {
    const c: AvenueCursor = { segIndex: 0, segLenM: 1e-4, progressM: 0, dir: 1 };
    expect(() => advanceAvenueCursor([{ x: 0, z: 0 }], c, 100)).not.toThrow();
    expect(c.progressM).toBe(0);
  });

  it('point interpolates along the segment regardless of direction; heading is negated on the return leg', () => {
    const path = bentAvenue();
    const forward: AvenueCursor = { segIndex: 0, segLenM: 30, progressM: 10, dir: 1 };
    const p = avenueCursorPoint(path, forward, { x: 0, z: 0 });
    expect(p.x).toBeCloseTo(10);
    expect(p.z).toBeCloseTo(0);
    const hFwd = avenueCursorHeading(path, forward);
    expect(hFwd.dx).toBeCloseTo(30);
    expect(hFwd.dz).toBeCloseTo(0);

    const backward: AvenueCursor = { segIndex: 0, segLenM: 30, progressM: 10, dir: -1 };
    const pBack = avenueCursorPoint(path, backward, { x: 0, z: 0 });
    // Position is direction-independent — same point as the forward cursor above.
    expect(pBack.x).toBeCloseTo(10);
    expect(pBack.z).toBeCloseTo(0);
    const hBack = avenueCursorHeading(path, backward);
    expect(hBack.dx).toBeCloseTo(-30);
    expect(hBack.dz).toBeCloseTo(0);
  });
});

// --- hold resolution (no creep — the "implacable" requirement) --------------------------------

describe('resolveStreetcarHold', () => {
  it('clear road -> full cruise speed', () => {
    expect(resolveStreetcarHold(false, TRAFFIC_STREETCAR.speedMps)).toBe(TRAFFIC_STREETCAR.speedMps);
  });

  it('blocked -> stops dead, with no time-based creep escape (unlike ai/traffic.ts resolveHold)', () => {
    // No matter how "long" the caller has been blocked (this function is stateless — the whole
    // point is it never reads or accumulates a blocked-duration timer the way resolveHold's
    // holdCapSec does), the result is always 0.
    expect(resolveStreetcarHold(true, TRAFFIC_STREETCAR.speedMps)).toBe(0);
    expect(resolveStreetcarHold(true, TRAFFIC_STREETCAR.speedMps)).toBe(0);
    expect(resolveStreetcarHold(true, TRAFFIC_STREETCAR.speedMps)).toBe(0);
  });
});

// --- landmark seam: defensive read of world.landmarks.streetcarAvenues ------------------------

describe('getStreetcarAvenues (Task 1 seam, read defensively)', () => {
  it('no avenues data -> no streetcars (undefined world)', () => {
    expect(getStreetcarAvenues(undefined)).toEqual([]);
  });

  it('no avenues data -> no streetcars (world with no landmarks field at all)', () => {
    expect(getStreetcarAvenues({ seed: 1, tiles: [] })).toEqual([]);
  });

  it('no avenues data -> no streetcars (landmarks present, streetcarAvenues absent)', () => {
    expect(getStreetcarAvenues({ landmarks: {} })).toEqual([]);
  });

  it('no avenues data -> no streetcars (empty array)', () => {
    expect(getStreetcarAvenues({ landmarks: { streetcarAvenues: [] } })).toEqual([]);
  });

  it('rejects a malformed avenue (too short, non-numeric points, wrong shape) without throwing', () => {
    const world = {
      landmarks: {
        streetcarAvenues: [
          { axis: 'ns', roadIndex: 0, roadId: 0, points: [{ x: 0, z: 0 }] }, // too short (1 point)
          { axis: 'ns', roadIndex: 1, roadId: 1, points: [{ x: 0, z: 0 }, { x: 'nope', z: 0 }] }, // non-numeric
          { axis: 'ns', roadIndex: 2, roadId: 2 }, // missing points entirely
          null, // not even an object
        ],
      },
    };
    expect(getStreetcarAvenues(world)).toEqual([]);
  });

  it('accepts the real LanePath wire shape ({axis, roadIndex, roadId, points}) and pulls out `points`', () => {
    // world/types.ts's actual LanePath shape (world/landmarks.ts's buildStreetcarAvenues) — each
    // avenue is an OBJECT wrapping its point list, not a bare array.
    const pointsA = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
    ];
    const pointsB = [
      { x: 0, z: 200 },
      { x: 100, z: 200 },
      { x: 100, z: 260 },
    ];
    const world = {
      landmarks: {
        streetcarAvenues: [
          { axis: 'ns', roadIndex: 3, roadId: 0, points: pointsA },
          { axis: 'ew', roadIndex: 7, roadId: 1, points: pointsB },
        ],
      },
    };
    expect(getStreetcarAvenues(world)).toEqual([pointsA, pointsB]);
  });

  it('also accepts a bare point array per entry (defensive fallback, not just the wrapped shape)', () => {
    const bare = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
    ];
    const world = { landmarks: { streetcarAvenues: [bare] } };
    expect(getStreetcarAvenues(world)).toEqual([bare]);
  });

  it('keeps the valid avenues and drops only the malformed ones from a mixed list', () => {
    const good = { axis: 'ns' as const, roadIndex: 0, roadId: 0, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] };
    const bad = { axis: 'ns' as const, roadIndex: 1, roadId: 1, points: [{ x: 0, z: 0 }] };
    const world = { landmarks: { streetcarAvenues: [good, bad] } };
    expect(getStreetcarAvenues(world)).toEqual([good.points]);
  });
});

// --- tier scaling (reuses config/quality.ts's trafficActiveTarget, TRAFFIC_CIV's own helper) --

describe('TRAFFIC_STREETCAR tier scaling', () => {
  it('resolves a small roster at every tier, scaling down (never up) from the high-tier base', () => {
    const high = trafficActiveTarget(TRAFFIC_STREETCAR.activeTarget, 'high');
    const med = trafficActiveTarget(TRAFFIC_STREETCAR.activeTarget, 'med');
    const low = trafficActiveTarget(TRAFFIC_STREETCAR.activeTarget, 'low');
    expect(high).toBe(TRAFFIC_STREETCAR.activeTarget);
    expect(med).toBeLessThanOrEqual(high);
    expect(low).toBeLessThanOrEqual(med);
    expect(low).toBeGreaterThan(0); // still a few streetcars even at the lowest tier
  });
});

// --- long-body block-ray: reach scales with the body, not just a copy of TRAFFIC_CIV's ---------

describe('streetcar block-ray reach vs. a regular civilian car', () => {
  it('front-bumper probe distance is the streetcar half-length (much longer than a car\'s)', () => {
    const streetcarHalfLength = getCarDef('redRocket').controller.chassis.halfLength;
    // ai/traffic.ts's civilian frontProbeM is a parked-car half-length — well under half the
    // streetcar's, confirming the "long-body" ray needs its own longer reach (this task's
    // brief), not a reused ai/traffic.ts constant.
    expect(streetcarHalfLength).toBeGreaterThan(4);
  });

  it('total forward look-ahead (bumper offset + block ray) exceeds TRAFFIC_CIV\'s', () => {
    const streetcarHalfLength = getCarDef('redRocket').controller.chassis.halfLength;
    const streetcarReach = streetcarHalfLength + TRAFFIC_STREETCAR.blockRayLengthM;
    // TRAFFIC_CIV's own frontProbeM comes from propColliderBox('parkedCar'), which this test
    // deliberately does not import (out of this task's owned files) — a conservative stand-in
    // upper bound (2.5 m half-length) is used instead; the real parked-car half-length is
    // smaller still, so this assertion is not weakened by the stand-in.
    const carReachUpperBound = 2.5 + TRAFFIC_CIV.blockRayLengthM;
    expect(streetcarReach).toBeGreaterThan(carReachUpperBound);
  });
});

// --- conversion mass/hp wiring: the "big prop payday" ------------------------------------------

describe('TRAFFIC_STREETCAR conversion mass/hp wiring', () => {
  it('massKg matches PLAYER_CARS.redRocket\'s massFactor over the reference chassis mass', () => {
    expect(TRAFFIC_STREETCAR.massKg).toBe(PLAYER_CARS.redRocket.massFactor * VEHICLE_TUNING.chassis.massKg);
  });

  it('hp keeps the same hp-per-kg ratio as a regular civilian car (scaled up, not arbitrary)', () => {
    const carRatio = TRAFFIC_CIV.hp / TRAFFIC_CIV.massKg;
    const streetcarRatio = TRAFFIC_STREETCAR.hp / TRAFFIC_STREETCAR.massKg;
    expect(streetcarRatio).toBeCloseTo(carRatio, 5);
  });

  it('convertForceThreshold is meaningfully higher than a regular civilian\'s (implacable, not trivial)', () => {
    expect(TRAFFIC_STREETCAR.convertForceThreshold).toBeGreaterThan(TRAFFIC_CIV.convertForceThreshold);
  });

  it('convertibleHandle (reused from ai/traffic.ts) applies the streetcar\'s own, higher threshold', () => {
    const civ: EntityEntry = { kind: 'civilian', districtId: -1, hp: TRAFFIC_STREETCAR.hp, isStreetcar: true };
    // A hit hard enough to convert a regular car is NOT automatically hard enough to convert a
    // streetcar — below its own threshold, still rejected.
    const belowStreetcarThreshold = impact(civ, undefined, TRAFFIC_STREETCAR.convertForceThreshold - 1);
    expect(convertibleHandle(belowStreetcarThreshold, TRAFFIC_STREETCAR.convertForceThreshold)).toBe(-1);

    const atStreetcarThreshold = impact(civ, undefined, TRAFFIC_STREETCAR.convertForceThreshold);
    expect(convertibleHandle(atStreetcarThreshold, TRAFFIC_STREETCAR.convertForceThreshold)).toBe(1); // aHandle
  });
});
