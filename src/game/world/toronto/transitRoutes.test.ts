// Phase 31 (Part-8 D1/D2, T1) — transitRoutes.ts resolver tests. Pure/deterministic; no seed
// dependency (route resolution never rolls randomness — only the roster ASSIGNMENT, tested
// separately in transitRoster.test.ts, needs seeds 416/9417).
//
// Phase 31 LANE-OFFSET FIX (Part-8, live-diagnosed wrong-way bug): a bus route now resolves to a
// CLOSED LOOP (direction-correct LANE_OFFSET_WU lane out, the opposite lane back — see
// transitRoutes.ts's header + resolveBusLoop). The tests below that used to assert a single fixed
// "kerb offset" for every bus map point (the OLD, buggy shape — both legs on the same lane) are
// rewritten for the loop shape; a new describe block directly regression-tests the fix (loop
// closure + opposite-lane legs). Streetcar resolution is UNCHANGED (still resolveRoute, a single
// open centreline polyline) — its own describe block and the golden hash below prove that.
import { describe, expect, it } from 'vitest';
import { CAR_REF } from '../../config/cityPackScale';
import { LANE_OFFSET_WU, ROAD_CLASSES } from '../../config/torontoMap';
import { streetcarTrackOffsetWu, TORONTO_TRANSIT_OFFSET } from '../../config/torontoTransit';
import { getCarDef } from '../../vehicles/definitions';
import { buildStreets, type Street } from './streets';
import type { MapPoint } from './projection';
import {
  buildTransitRoutes,
  busRouteStreetCoverage,
  isOnBusRoute,
  laneSignForSegment,
  routeWorldPoints,
  streetcarTrackPerpWu,
  type ResolvedTransitRoute,
} from './transitRoutes';

const routes = buildTransitRoutes();
const { streets } = buildStreets();
const streetById = new Map(streets.map((s) => [s.id, s]));

function routeById(id: string): ResolvedTransitRoute {
  const r = routes.find((x) => x.id === id);
  if (!r) throw new Error(`test fixture: route "${id}" not found`);
  return r;
}

/** FNV-1a 32-bit hash of a string → 8-char hex (same idiom as world/generate.test.ts's own
 * pinned golden hash). */
function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('buildTransitRoutes — shape', () => {
  it('resolves exactly the 15 routes from the data file, all with >= 2 map points', () => {
    expect(routes.length).toBe(15);
    for (const r of routes) {
      expect(r.mapPoints.length, r.id).toBeGreaterThanOrEqual(2);
      expect(r.segments.length, r.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('has exactly 8 bus routes and 7 streetcar routes', () => {
    expect(routes.filter((r) => r.mode === 'bus').length).toBe(8);
    expect(routes.filter((r) => r.mode === 'streetcar').length).toBe(7);
  });

  it('has unique route ids', () => {
    const ids = routes.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('every route stays within its street(s) ribbon', () => {
  it('a bus segment\'s LANE_OFFSET_WU lane offset is within the street half-width', () => {
    for (const r of routes.filter((x) => x.mode === 'bus')) {
      for (const seg of r.segments) {
        const street = streetById.get(seg.streetId)!;
        const offset = LANE_OFFSET_WU[street.cls];
        expect(offset, `${r.id} on ${seg.streetId}`).toBeLessThan(street.halfWidth);
        expect(offset, `${r.id} on ${seg.streetId}`).toBeLessThan(ROAD_CLASSES[street.cls] / 2);
      }
    }
  });

  it('a streetcar segment\'s derived track offset is inside the ribbon and inboard of the traffic lane', () => {
    // Phase 75: was "trivially within the half-width" when the offset was a literal 0. It is now
    // the derived inner-lane strip centre, so the bound has real content on both sides.
    for (const r of routes.filter((x) => x.mode === 'streetcar')) {
      for (const seg of r.segments) {
        const street = streetById.get(seg.streetId)!;
        const offset = Math.abs(streetcarTrackPerpWu(street));
        expect(offset, `${r.id} on ${seg.streetId}`).toBeLessThan(street.halfWidth);
        expect(offset, `${r.id} on ${seg.streetId} must sit INBOARD of the bus/civilian lane`).toBeLessThan(
          LANE_OFFSET_WU[street.cls],
        );
      }
    }
  });

  it('every resolved map point lies within its street span (+/- the mode\'s lane offset)', () => {
    for (const r of routes) {
      for (const p of r.mapPoints) {
        // every map point must land on SOME segment's street (within its span +/- a hair for the
        // perp offset carried on the perpendicular axis only, so the along-axis coordinate is exact).
        const onAnySegment = r.segments.some((seg) => {
          const street = streetById.get(seg.streetId)!;
          const along = street.axis === 'ns' ? p.y : p.x;
          const maxOffset = r.mode === 'bus' ? LANE_OFFSET_WU[street.cls] : Math.abs(streetcarTrackPerpWu(street));
          const acrossOk =
            street.axis === 'ns'
              ? Math.abs(p.x - street.centerline) <= maxOffset + 1e-6
              : Math.abs(p.y - street.centerline) <= maxOffset + 1e-6;
          return along >= seg.lo - 1e-6 && along <= seg.hi + 1e-6 && acrossOk;
        });
        expect(onAnySegment, `${r.id} point ${JSON.stringify(p)}`).toBe(true);
      }
    }
  });
});

describe('97 Yonge — the full-spine showpiece', () => {
  const r = routeById('97');

  it('every map point sits at x ~= 1500 (the Yonge spine, +/- the direction-correct lane offset)', () => {
    for (const p of r.mapPoints) {
      expect(Math.abs(p.x - 1500)).toBeLessThanOrEqual(LANE_OFFSET_WU.spine + 1e-6);
    }
  });

  it('spans nearly the whole map (Queens Quay to Finch), not just a clipped fragment', () => {
    const ys = r.mapPoints.map((p) => p.y);
    const span = Math.max(...ys) - Math.min(...ys);
    // Yonge's own resolved span is ~2458 wu (12 to 2470); the Finch<->Queens Quay clip should be
    // most of that.
    expect(span).toBeGreaterThan(2000);
  });

  it('world-space points also track x ~= the Yonge spine world-x', () => {
    const yonge = streetById.get('yonge')!;
    const world = routeWorldPoints(r);
    // mapToWorld's x <- map x identity (projection.ts convention) — the spine's world-x is its
    // own map centerline.
    for (const w of world) {
      expect(Math.abs(w.x - yonge.centerline)).toBeLessThanOrEqual(LANE_OFFSET_WU.spine + 1e-6);
    }
  });

  it('drives BOTH sides of the spine — outbound and return use opposite lanes (the wrong-way fix)', () => {
    const signs = new Set(r.mapPoints.map((p) => Math.sign(p.x - 1500)));
    expect(signs.has(1), 'expected a point east of the spine (one lane)').toBe(true);
    expect(signs.has(-1), 'expected a point west of the spine (the other lane)').toBe(true);
  });
});

describe('splits terminate at Yonge', () => {
  const yonge = streetById.get('yonge')!;

  it('Yonge really is the spine at x=1500 (sanity — every split test below relies on this)', () => {
    expect(yonge.centerline).toBe(1500);
  });

  for (const [id, streetId, half] of [
    ['36', 'finch', 'west'],
    ['39', 'finch', 'east'],
    ['84', 'sheppard', 'west'],
    ['185', 'sheppard', 'east'],
  ] as const) {
    it(`route ${id} is clipped to a half of ${streetId} (not the street's full span)`, () => {
      const r = routeById(id);
      const street = streetById.get(streetId)!;
      const seg = r.segments.find((s) => s.streetId === streetId)!;
      expect(seg).toBeDefined();
      // The split boundary is where the street crosses Yonge — i.e. the along-coordinate equal
      // to Yonge's own centerline (1500). A genuinely clipped half must have EXACTLY one of its
      // bounds at that crossing, and must NOT reproduce the street's own full [lo,hi] span.
      const atYonge = (v: number): boolean => Math.abs(v - 1500) < 1e-6;
      expect(atYonge(seg.lo) || atYonge(seg.hi), `${id} seg=${JSON.stringify(seg)}`).toBe(true);
      expect(seg.lo === street.span[0] && seg.hi === street.span[1], `${id} should be a HALF, not the full street`).toBe(false);
      if (half === 'west') expect(atYonge(seg.hi)).toBe(true);
      else expect(atYonge(seg.lo)).toBe(true);
    });
  }

  // finch/sheppard are 'ew' streets, so their along-coordinate IS x directly (the lane offset
  // only ever perturbs y on these routes) — the crossing itself is exactly x=1500, no slack
  // needed beyond floating-point epsilon.
  const nearYonge = (pts: readonly MapPoint[]): MapPoint[] => pts.filter((p) => Math.abs(p.x - 1500) < 1e-6);

  it('36 Finch West and 39 Finch East both cross x = 1500 — the shared Yonge split point', () => {
    const west = routeById('36');
    const east = routeById('39');
    // Each route's polyline is a closed loop (outbound + return), so it crosses the Yonge
    // junction TWICE (once per lane/direction) — at least 2 points on each side.
    expect(nearYonge(west.mapPoints).length).toBeGreaterThanOrEqual(2);
    expect(nearYonge(east.mapPoints).length).toBeGreaterThanOrEqual(2);
  });

  it('84 Sheppard West and 185 Sheppard Central both cross x = 1500 — the shared Yonge split point', () => {
    const west = routeById('84');
    const east = routeById('185');
    expect(nearYonge(west.mapPoints).length).toBeGreaterThanOrEqual(2);
    expect(nearYonge(east.mapPoints).length).toBeGreaterThanOrEqual(2);
  });

  it('Finch/Sheppard splits do not overlap: west route never crosses east of Yonge and vice versa', () => {
    for (const [westId, eastId] of [
      ['36', '39'],
      ['84', '185'],
    ] as const) {
      const west = routeById(westId);
      const east = routeById(eastId);
      // 'ew' streets: x IS the along-coordinate exactly (the lane offset only perturbs y), so
      // there is no offset-driven slack to allow for here — a tiny float epsilon is enough.
      for (const p of west.mapPoints) expect(p.x, westId).toBeLessThanOrEqual(1500 + 1e-6);
      for (const p of east.mapPoints) expect(p.x, eastId).toBeGreaterThanOrEqual(1500 - 1e-6);
    }
  });
});

describe('laneSignForSegment (Phase 31 lane-sign convention, matches roadGraph.ts exactly)', () => {
  it('ns axis: increasing along (southbound) -> -1 (west side, roadGraph.ts\'s forwardSign)', () => {
    expect(laneSignForSegment('ns', 100, 200)).toBe(-1);
  });

  it('ns axis: decreasing along (northbound) -> +1 (east side)', () => {
    expect(laneSignForSegment('ns', 200, 100)).toBe(1);
  });

  it('ew axis: increasing along (eastbound) -> +1 (south side, roadGraph.ts\'s forwardSign)', () => {
    expect(laneSignForSegment('ew', 100, 200)).toBe(1);
  });

  it('ew axis: decreasing along (westbound) -> -1 (north side)', () => {
    expect(laneSignForSegment('ew', 200, 100)).toBe(-1);
  });

  it('equal endpoints (degenerate) default to the forward sign, never throws/NaNs', () => {
    expect(laneSignForSegment('ns', 150, 150)).toBe(-1);
    expect(laneSignForSegment('ew', 150, 150)).toBe(1);
  });
});

describe('bus routes resolve to a closed loop with direction-correct lanes (Phase 31 wrong-way fix)', () => {
  const busRoutes = routes.filter((r) => r.mode === 'bus');

  it('every bus route\'s mapPoints closes back onto its own first point (a real loop)', () => {
    for (const r of busRoutes) {
      const first = r.mapPoints[0];
      const last = r.mapPoints[r.mapPoints.length - 1];
      expect(Math.hypot(last.x - first.x, last.y - first.y), r.id).toBeLessThan(1e-6);
    }
  });

  it('streetcar routes do NOT close (they stay a genuinely open there-and-back avenue)', () => {
    for (const r of routes.filter((x) => x.mode === 'streetcar')) {
      const first = r.mapPoints[0];
      const last = r.mapPoints[r.mapPoints.length - 1];
      expect(Math.hypot(last.x - first.x, last.y - first.y), r.id).toBeGreaterThan(1);
    }
  });

  it('every single-segment bus route resolves to exactly 5 points: outbound(2) + return(2) + closing(1)', () => {
    // All 8 bus routes in transit-routes.json are single-segment (see the data file) — this
    // pins the exact loop shape resolveBusLoop produces for that common case.
    for (const r of busRoutes) {
      expect(r.segments.length, r.id).toBe(1);
      expect(r.mapPoints.length, r.id).toBe(5);
    }
  });

  it('the outbound leg and the return leg ride OPPOSITE lanes — the wrong-way regression check', () => {
    for (const r of busRoutes) {
      const street = streetById.get(r.segments[0].streetId)!;
      const across = (p: MapPoint): number => (street.axis === 'ns' ? p.x - street.centerline : p.y - street.centerline);
      const outboundOffset = across(r.mapPoints[0]); // outbound leg's first point
      const returnOffset = across(r.mapPoints[2]); // return leg's first point
      expect(Math.abs(outboundOffset), r.id).toBeCloseTo(LANE_OFFSET_WU[street.cls], 6);
      expect(Math.abs(returnOffset), r.id).toBeCloseTo(LANE_OFFSET_WU[street.cls], 6);
      // Opposite signs: before the fix this was the SAME sign both legs — i.e. the return leg
      // drove the exact same physical lane the outbound leg used (the live-diagnosed bug).
      expect(Math.sign(outboundOffset), r.id).toBe(-Math.sign(returnOffset));
    }
  });

  it('the far-tip join sits at the same along-coordinate on both legs — only the lane flips', () => {
    for (const r of busRoutes) {
      const street = streetById.get(r.segments[0].streetId)!;
      const along = (p: MapPoint): number => (street.axis === 'ns' ? p.y : p.x);
      // mapPoints[1] = outbound leg's far end; mapPoints[2] = return leg's far-end start.
      expect(along(r.mapPoints[1]), r.id).toBeCloseTo(along(r.mapPoints[2]), 6);
    }
  });
});

describe('streetcar routes run the derived inner-lane track (Phase 75 — was the bare centreline)', () => {
  const streetcarRoutes = routes.filter((x) => x.mode === 'streetcar');
  /** The streetcar body's own half-width (wu). Toronto streetcars mount with no chassis override
   * (world/toronto/TorontoTransit.tsx), so ai/streetcarTraffic.ts falls back to the Red Rocket's
   * resolved chassis — read live here rather than re-typed, so a vehicle re-grade cannot silently
   * push the body onto the grass without this failing. */
  const STREETCAR_HALF_WIDTH_WU = getCarDef('redRocket').controller.chassis.halfWidth;

  it('every streetcar mapPoint sits exactly on its street\'s derived track offset', () => {
    for (const r of streetcarRoutes) {
      for (const seg of r.segments) {
        const street = streetById.get(seg.streetId)!;
        const relevant = r.mapPoints.filter((p) => (street.axis === 'ns' ? p.y >= seg.lo - 1 && p.y <= seg.hi + 1 : p.x >= seg.lo - 1 && p.x <= seg.hi + 1));
        for (const p of relevant) {
          const across = street.axis === 'ns' ? p.x : p.y;
          expect(across).toBeCloseTo(street.centerline + streetcarTrackPerpWu(street), 6);
        }
      }
    }
  });

  it('the track is the derived strip centre — equal clearance to the inner kerb and the traffic lane', () => {
    // The derivation, restated independently of streetcarTrackOffsetWu's own arithmetic: the track
    // must sit halfway between the median edge (or the centreline, on a class with none) and the
    // inner flank of a car centred on LANE_OFFSET_WU.
    for (const s of streets) {
      const offset = Math.abs(streetcarTrackPerpWu(s));
      const toKerb = offset - s.medianHalfWidth;
      const toTrafficLane = LANE_OFFSET_WU[s.cls] - CAR_REF.widthWu / 2 - offset;
      expect(toKerb, `${s.id}`).toBeCloseTo(toTrafficLane, 9);
      expect(toKerb, `${s.id} must have real clearance, not tangency`).toBeGreaterThan(0);
    }
  });

  it('one shared track on the conventional side (+1 = east on an ns street, south on an ew street)', () => {
    expect(TORONTO_TRANSIT_OFFSET.streetcarTrackSign).toBe(1);
    for (const r of streetcarRoutes) {
      const street = streetById.get(r.segments[0].streetId)!;
      // Every point of a single-street route sits on ONE side — a single track driven both ways,
      // not a two-lane loop (that is the bus's shape; see the loop block above).
      const sides = new Set(
        r.mapPoints.map((p) => Math.sign((street.axis === 'ns' ? p.x : p.y) - street.centerline)),
      );
      expect(sides, r.id).toEqual(new Set([TORONTO_TRANSIT_OFFSET.streetcarTrackSign]));
    }
  });

  it('matches the Phase 75 per-class values (spine 3.025 / artery 2.75 / major 1.65 / minor 1.1)', () => {
    expect(streetcarTrackOffsetWu('spine', CAR_REF.widthWu / 2)).toBeCloseTo(3.025, 9);
    expect(streetcarTrackOffsetWu('artery', CAR_REF.widthWu / 2)).toBeCloseTo(2.75, 9);
    expect(streetcarTrackOffsetWu('major', 0)).toBeCloseTo(1.65, 9);
    expect(streetcarTrackOffsetWu('minor', 0)).toBeCloseTo(1.1, 9);
  });

  it('THE MEDIAN LAW — no streetcar path point, and no streetcar BODY, sits on the planted strip', () => {
    // The bug this phase fixed: at offset 0 every point of 510 Spadina (an artery, median 2.2 wu)
    // sat dead-centre in the grass. Checked on the body envelope, not just the path point.
    for (const r of streetcarRoutes) {
      for (const seg of r.segments) {
        const street = streetById.get(seg.streetId)!;
        if (street.medianHalfWidth === 0) continue;
        const innerFlank = Math.abs(streetcarTrackPerpWu(street)) - STREETCAR_HALF_WIDTH_WU;
        expect(innerFlank, `${r.id} on ${street.id}: body inner flank vs median kerb`).toBeGreaterThan(
          street.medianHalfWidth,
        );
      }
    }
  });

  it('THE LAW HAS TEETH — the pre-Phase-75 zero offset puts every median-street route in the grass', () => {
    const onMedianStreet = streetcarRoutes.flatMap((r) =>
      r.segments.map((seg) => streetById.get(seg.streetId)!).filter((s) => s.medianHalfWidth > 0),
    );
    expect(onMedianStreet.map((s) => s.id)).toEqual(['spadina']); // 510 Spadina — the one that broke
    for (const s of onMedianStreet) expect(0 - STREETCAR_HALF_WIDTH_WU).toBeLessThan(s.medianHalfWidth);
  });

  it('the streetcar body stays clear of the civilian/bus lane it runs inboard of', () => {
    // The second half of the "inner lane" claim: a streetcar and a car abreast must not overlap.
    // (Before Phase 75 they DID — at offset 0 the 2.4 wu body straddled the centreline and clipped
    // both 2.2-capped lanes by 0.1 wu.)
    for (const r of streetcarRoutes) {
      for (const seg of r.segments) {
        const street = streetById.get(seg.streetId)!;
        const outerFlank = Math.abs(streetcarTrackPerpWu(street)) + STREETCAR_HALF_WIDTH_WU;
        expect(outerFlank, `${r.id} on ${street.id}`).toBeLessThan(LANE_OFFSET_WU[street.cls] - CAR_REF.widthWu / 2);
      }
    }
  });

  it('GUARDS THE MINOR CASE — no streetcar route rides a class whose track would cross the centreline', () => {
    // On a `minor` the derived offset is 1.1 wu, so the 1.2 wu body half-width would poke 0.1 wu
    // across the centreline into the oncoming side. No route does today (all 7 ride majors + one
    // artery); if one ever moves onto a minor, this fails and the derivation must be re-graded
    // rather than the route quietly shipping on the wrong side of the road.
    const crossesCentreline = (s: Street): boolean =>
      Math.abs(streetcarTrackPerpWu(s)) - STREETCAR_HALF_WIDTH_WU < 0;
    for (const r of streetcarRoutes) {
      for (const seg of r.segments) {
        expect(crossesCentreline(streetById.get(seg.streetId)!), `${r.id} on ${seg.streetId}`).toBe(false);
      }
    }
    // …and the guard is not vacuous: `minor` really is the class that would trip it.
    expect(streets.some((s) => s.cls === 'minor' && crossesCentreline(s))).toBe(true);
  });

  // Golden hash: pins the streetcar-only resolved output so ANY accidental perturbation from the
  // bus-loop work (which shares resolveSegment/emitSegmentPoints with resolveRoute) fails loudly.
  //
  // PHASE 75 RE-PIN (0795f0ce -> 8c00cae4), the ONE re-pin this phase's transit track takes, with
  // both contributing deltas attributed:
  //   1. THE TRACK MOVED (this task): every streetcar route steps off the centreline onto the
  //      derived inner-lane offset — 6 major routes by 1.65 wu, 510 Spadina by 2.75 wu.
  //   2. THE STREET MOVED (Phase 75 T0, before this task touched anything): streets.ts's
  //      boundary nudge is half-width-derived, so doubling the widths re-nudged Bloor's centreline
  //      1366.95 -> 1371.90, which is 511 Bathurst's northern span endpoint. Measured in isolation
  //      at T0's commit the hash was already 0689e8a0 — i.e. the route data moved before the track
  //      did, and neither delta is hiding inside the other.
  it('matches a pinned golden hash for the 7 streetcar routes', () => {
    const streetcarOnly = routes.filter((r) => r.mode === 'streetcar');
    expect(stableHash(JSON.stringify(streetcarOnly))).toBe('809c871c');
  });
});

// PHASE 75 (T2) — the median law for BOTH transit modes, stated on the resolved polylines rather
// than on either resolver's arithmetic. Medians are visual-only (config/torontoMap.ts's
// ROAD_MEDIAN.colliders = false), so a transit vehicle on the grass is a look defect, not a
// physics one — but it is exactly the look defect this task exists to remove, and the only thing
// that would have caught the 510-Spadina-through-the-grass regression is a test on the points.
describe('no transit path point lies inside a median footprint (Phase 75)', () => {
  const medianStreets = streets.filter((s) => s.medianWidth > 0);

  /** How far into `street`'s planted strip a map point sits (> 0 = on the grass); -Infinity when
   * the point is not alongside that street at all. */
  const medianIntrusionWu = (street: Street, p: MapPoint): number => {
    const along = street.axis === 'ns' ? p.y : p.x;
    if (along < street.span[0] - 1e-6 || along > street.span[1] + 1e-6) return Number.NEGATIVE_INFINITY;
    const across = street.axis === 'ns' ? p.x : p.y;
    return street.medianHalfWidth - Math.abs(across - street.centerline);
  };

  it('the map really does carry medians (otherwise the laws below are vacuous)', () => {
    expect(medianStreets.map((s) => s.id).sort()).toEqual(['bloor', 'spadina', 'university', 'yonge']);
  });

  it('all 15 routes are single-segment — the attribution the laws below rely on', () => {
    // Every route in data/toronto/transit-routes.json rides exactly one street, so `segments[0]`
    // identifies the street a given map point is TRAVELLING ON. If a multi-street route is ever
    // added, the two laws below need per-segment point attribution before they stay honest.
    for (const r of routes) expect(r.segments.length, r.id).toBe(1);
  });

  it('THE LAW — no route point rides inside the median of the street it is travelling on', () => {
    // This is the regression: at the old literal 0 offset, EVERY point of 510 Spadina sat dead
    // centre in Spadina's planted strip, and 97 Yonge's two lanes straddled Yonge's.
    for (const r of routes) {
      const ridden = streetById.get(r.segments[0].streetId)!;
      if (ridden.medianHalfWidth === 0) continue;
      for (const p of r.mapPoints) {
        expect(
          medianIntrusionWu(ridden, p),
          `${r.id} point (${p.x.toFixed(2)},${p.y.toFixed(2)}) rides ${ridden.id}'s median`,
        ).toBeLessThan(0);
      }
    }
  });

  it('points that DO sit in a median belong to a PERPENDICULAR street — a junction, where medians break', () => {
    // A route whose endpoint token is a cross street terminates on that street's CENTRELINE (e.g.
    // 19 Bay's northern tip at Bay x Bloor), which is inside the cross street's nominal median
    // rect. Legitimate, and the same verdict the traffic graph's own hubs carry
    // (roadGraph.test.ts): a real boulevard's planted strip stops short of a junction so cross and
    // left-turning traffic can pass — that break IS where these points sit. Pinned so the class
    // stays "termini at junctions" rather than silently growing a route that rides the grass.
    const inMedian: string[] = [];
    for (const r of routes) {
      const ridden = streetById.get(r.segments[0].streetId)!;
      for (const p of r.mapPoints) {
        for (const s of medianStreets) {
          if (s.id === ridden.id) continue;
          if (medianIntrusionWu(s, p) > 0) inMedian.push(`${r.id}@${s.id}`);
        }
      }
    }
    // Six bus termini + one streetcar terminus, every one of them a route endpoint TOKEN that
    // names the crossing street: the four Yonge splits (36/39 Finch, 84/185 Sheppard), 121 Front's
    // Yonge tip, 19 Bay's Bloor tip and 511 Bathurst's Bloor tip.
    expect([...new Set(inMedian)].sort()).toEqual([
      '121@yonge',
      '185@yonge',
      '19@bloor',
      '36@yonge',
      '39@yonge',
      '511@bloor',
      '84@yonge',
    ]);
    for (const entry of new Set(inMedian)) {
      const [routeId, streetId] = entry.split('@');
      const r = routes.find((x) => x.id === routeId)!;
      const ridden = streetById.get(r.segments[0].streetId)!;
      const cross = streetById.get(streetId)!;
      // …and it really is a junction of the two: the cross street's centreline is one of this
      // route's own along-street endpoints.
      const seg = r.segments[0];
      expect(
        Math.min(Math.abs(seg.lo - cross.centerline), Math.abs(seg.hi - cross.centerline)),
        `${entry} must be a terminus at the crossing`,
      ).toBeLessThan(1e-6);
      expect(ridden.axis, entry).not.toBe(cross.axis);
    }
  });

  it('the only segment that TRAVERSES its own street\'s median is 97 Yonge\'s two terminus U-turns', () => {
    // Honest scope: the laws above are about POINTS. A bus loop also has two perpendicular tip
    // segments (outbound lane -> return lane at each terminus) and on a median street that join
    // necessarily sweeps across the strip — the same terminus U-turn the traffic graph's own
    // median tips make. Medians carry no collider, so this is a look question, not a trap; pinned
    // so it stays two known segments on one known route.
    const selfCrossings: string[] = [];
    const perpendicularCrossings: string[] = [];
    for (const r of routes) {
      const ridden = streetById.get(r.segments[0].streetId)!;
      for (let i = 1; i < r.mapPoints.length; i++) {
        const a = r.mapPoints[i - 1];
        const b = r.mapPoints[i];
        for (const s of medianStreets) {
          const acrossA = s.axis === 'ns' ? a.x : a.y;
          const acrossB = s.axis === 'ns' ? b.x : b.y;
          const alongMid = s.axis === 'ns' ? (a.y + b.y) / 2 : (a.x + b.x) / 2;
          const spansStrip = (acrossA - s.centerline) * (acrossB - s.centerline) < 0;
          const alongside = alongMid >= s.span[0] - 1e-6 && alongMid <= s.span[1] + 1e-6;
          if (!spansStrip || !alongside) continue;
          (s.id === ridden.id ? selfCrossings : perpendicularCrossings).push(`${r.id}@${s.id}`);
        }
      }
    }
    expect(selfCrossings.sort()).toEqual(['97@yonge', '97@yonge']);
    // Everything else is a route driving THROUGH a junction on the perpendicular street — the
    // ordinary case, and precisely what a median break exists for.
    expect(perpendicularCrossings.length).toBe(17);
    expect([...new Set(perpendicularCrossings)].sort()).toEqual([
      '34@yonge',
      '501@spadina',
      '501@university',
      '501@yonge',
      '504@spadina',
      '504@university',
      '504@yonge',
      '505@spadina',
      '505@university',
      '505@yonge',
      '506@spadina',
      '506@university',
      '506@yonge',
      '509@yonge',
      '97@bloor',
    ]);
  });
});

describe('bus route coverage / isOnBusRoute (D5 seam)', () => {
  const coverage = busRouteStreetCoverage(routes);

  it('only covers streets bus routes actually ride (yonge/bay/front/finch/sheppard/eglinton)', () => {
    const covered = new Set(coverage.map((c) => c.streetId));
    expect(covered).toEqual(new Set(['yonge', 'bay', 'front', 'finch', 'sheppard', 'eglinton']));
  });

  it('never includes a streetcar-only street (queen/king/dundas/college/spadina/bathurst/queensquay is bus-free except queensquay isn\'t a bus street either)', () => {
    const covered = new Set(coverage.map((c) => c.streetId));
    for (const streetcarOnly of ['queen', 'king', 'dundas', 'college', 'spadina', 'bathurst', 'queensquay']) {
      expect(covered.has(streetcarOnly)).toBe(false);
    }
  });

  it('isOnBusRoute is true along the covered span and false outside it', () => {
    const yongeCov = coverage.filter((c) => c.streetId === 'yonge');
    expect(yongeCov.length).toBeGreaterThan(0);
    const mid = (yongeCov[0].lo + yongeCov[0].hi) / 2;
    expect(isOnBusRoute('yonge', mid, coverage)).toBe(true);
    expect(isOnBusRoute('yonge', yongeCov[0].lo - 1000, coverage)).toBe(false);
    expect(isOnBusRoute('spadina', mid, coverage)).toBe(false);
  });
});

describe('every resolved segment references a real street (data-file sanity)', () => {
  it('every segment.streetId is a real street.ts id', () => {
    for (const r of buildTransitRoutes()) {
      for (const seg of r.segments) {
        expect(streetById.has(seg.streetId), `${r.id} -> ${seg.streetId}`).toBe(true);
      }
    }
  });
});
