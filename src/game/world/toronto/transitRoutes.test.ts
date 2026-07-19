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
import { LANE_OFFSET_WU, ROAD_CLASSES } from '../../config/torontoMap';
import { TORONTO_TRANSIT_OFFSET } from '../../config/torontoTransit';
import { buildStreets } from './streets';
import type { MapPoint } from './projection';
import {
  buildTransitRoutes,
  busRouteStreetCoverage,
  isOnBusRoute,
  laneSignForSegment,
  routeWorldPoints,
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

  it('a streetcar segment\'s (zero) offset is trivially within the street half-width', () => {
    for (const r of routes.filter((x) => x.mode === 'streetcar')) {
      for (const seg of r.segments) {
        const street = streetById.get(seg.streetId)!;
        expect(TORONTO_TRANSIT_OFFSET.streetcarOffsetWu, `${r.id} on ${seg.streetId}`).toBeLessThan(street.halfWidth);
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
          const maxOffset = r.mode === 'bus' ? LANE_OFFSET_WU[street.cls] : TORONTO_TRANSIT_OFFSET.streetcarOffsetWu;
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

describe('streetcar routes run the true centreline (no offset) — unchanged by the Phase 31 bus fix', () => {
  it('every streetcar mapPoint sits exactly on its street centerline', () => {
    for (const r of routes.filter((x) => x.mode === 'streetcar')) {
      for (const seg of r.segments) {
        const street = streetById.get(seg.streetId)!;
        const relevant = r.mapPoints.filter((p) => (street.axis === 'ns' ? p.y >= seg.lo - 1 && p.y <= seg.hi + 1 : p.x >= seg.lo - 1 && p.x <= seg.hi + 1));
        for (const p of relevant) {
          const across = street.axis === 'ns' ? p.x : p.y;
          expect(across).toBeCloseTo(street.centerline, 6);
        }
      }
    }
  });

  // Golden hash: pins the streetcar-only resolved output so ANY accidental perturbation from
  // the Phase 31 bus-loop work (which shares resolveSegment/emitSegmentPoints with resolveRoute)
  // fails loudly. Streetcar resolution's own code path (resolveRoute, TORONTO_TRANSIT_OFFSET.
  // streetcarOffsetWu, 'bounce' cursor mode) is untouched by this phase's fix.
  it('matches a pinned golden hash for the 7 streetcar routes', () => {
    const streetcarOnly = routes.filter((r) => r.mode === 'streetcar');
    expect(stableHash(JSON.stringify(streetcarOnly))).toBe('0795f0ce');
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
