// Phase 74 feel lab — unit tests for the ROUTE DRIVES' pure half.
//
// Everything here runs headless: no browser, no Rapier, no r3f. What is tested is exactly what
// makes a route drive REPRODUCIBLE and HONEST — the registry's integrity (a renamed district must
// fail loudly, not silently shrink a rect), rect derivation from district ids, the seeded route
// plan's determinism, the speed-governor/look-ahead maths, and the console formatter. The drive
// LOOP itself is not unit-testable without a live world; it is verified by the battery.
//
// Style/precedent: ai/cameraLabDrive.test.ts, whose synthetic-graph fixture is reused in shape
// (nodes carry id/x/z/kind/tileIndex; outEdges[nodeId] holds edge INDICES into `edges`) alongside
// the LIVE Toronto graph for the assertions that only mean something against real data.

import { describe, it, expect } from 'vitest';
import {
  FEEL_ROUTES,
  FEEL_ROUTE_IDS,
  FEEL_STEERING,
  arriveDistFor,
  districtUnionRect,
  feelRouteAnchor,
  feelRouteRect,
  feelRouteSteps,
  formatFeelDriveReport,
  governedThrottle,
  lookaheadFor,
  nearestNodeIdInRect,
  planFeelRoute,
  resolveFeelRoute,
  speedStats,
  telemetryDigestLines,
  type FeelDriveReport,
  type FeelRouteId,
} from './feelDrives';
import { FEEL_TELEMETRY_DEFAULTS } from './feelTelemetry';
import { AI_STEERING } from '../config';
import { downtownDriveRect, nodeInRect, type DriveRect } from '../ai/cameraLabDrive';
import { buildDistricts } from '../world/toronto/districts';
import { mapToWorld, YONGE_X, ZONE_BOUNDARIES } from '../world/toronto/projection';
import { buildTorontoRoadGraph } from '../world/toronto/roadGraph';
import { buildStreets } from '../world/toronto/streets';
import { TORONTO_SPAWN_POSE } from '../world/toronto/torontoSceneHelpers';
import { HEAT } from '../config';
import type { DistrictId } from '../config/torontoDistricts';
import type { TrafficGraph, TrafficNode } from '../world/types';
import {
  createFeelAccumulator,
  resolveFeelCarParams,
  summarizeFeel,
  type FeelTelemetrySnapshot,
} from './feelTelemetry';

// The real graph, built once (a pure function of the street table — no seed, no mount).
const GRAPH: TrafficGraph = buildTorontoRoadGraph(buildStreets().streets);
const DISTRICT_IDS = new Set(buildDistricts().map((rd) => rd.def.id));

function node(id: number, x: number, z: number): TrafficNode {
  return { id, x, z, kind: 'waypoint', tileIndex: -1 };
}

// ============================================================================================
// Route registry integrity
// ============================================================================================

describe('FEEL_ROUTES registry', () => {
  it('exposes exactly the four planned routes, keyed by their own id', () => {
    expect([...FEEL_ROUTE_IDS].sort()).toEqual([
      'chase3',
      'downtownDense',
      'minorWeave',
      'spineCruise',
    ]);
    for (const id of FEEL_ROUTE_IDS) expect(FEEL_ROUTES[id].id).toBe(id);
  });

  it('every route names only districts that exist in the live district tiling', () => {
    for (const id of FEEL_ROUTE_IDS) {
      const route = FEEL_ROUTES[id];
      expect(route.districtIds.length, `${id} must name at least one district`).toBeGreaterThan(0);
      for (const districtId of route.districtIds) {
        expect(DISTRICT_IDS.has(districtId), `${id} references district '${districtId}'`).toBe(
          true,
        );
      }
    }
  });

  it('carries a label, a rationale and a plausible pace for every route', () => {
    for (const id of FEEL_ROUTE_IDS) {
      const route = FEEL_ROUTES[id];
      expect(route.label.length).toBeGreaterThan(0);
      expect(route.answers.length).toBeGreaterThan(0);
      // A feel drive governed near the camera lab's 5 m/s crawl would measure nothing about feel
      // (see the module header): every route must ask for a real fraction of the car's envelope.
      expect(route.cruiseFracOfTopSpeed).toBeGreaterThanOrEqual(0.4);
      expect(route.cruiseFracOfTopSpeed).toBeLessThanOrEqual(1);
    }
  });

  it('requires a wanted tier on chase3 alone, and only a tier the heat table defines', () => {
    for (const id of FEEL_ROUTE_IDS) {
      const tier = FEEL_ROUTES[id].requireTier;
      expect(Number.isInteger(tier)).toBe(true);
      expect(tier).toBeGreaterThanOrEqual(0);
      expect(typeof HEAT.tierThresholds[tier]).toBe('number');
      expect(tier > 0).toBe(id === 'chase3');
    }
    expect(FEEL_ROUTES.chase3.requireTier).toBe(3);
  });

  it('resolveFeelRoute fails loudly on an unknown id instead of defaulting', () => {
    expect(resolveFeelRoute('minorWeave').id).toBe('minorWeave');
    expect(() => resolveFeelRoute('downtown')).toThrow(/unknown route 'downtown'/);
    // The message must list what IS known — a battery typo should be self-diagnosing.
    expect(() => resolveFeelRoute('nope')).toThrow(/downtownDense/);
  });
});

// ============================================================================================
// Rect derivation (from district ids — never coordinate literals)
// ============================================================================================

describe('districtUnionRect', () => {
  it("reproduces the Phase 33 camera-lab downtown rect EXACTLY on downtown's own ids", () => {
    // The generalization is a copy of downtownDriveRect's body. This is the pin that stops the
    // copy drifting from the original — if it ever fails, the two labs stopped measuring the same
    // downtown and one of them is lying.
    expect(districtUnionRect(FEEL_ROUTES.downtownDense.districtIds)).toEqual(downtownDriveRect());
  });

  it('throws on a district the config does not define (a rename must never shrink a rect)', () => {
    expect(() => districtUnionRect(['financial', 'northYorke' as DistrictId])).toThrow(
      /district 'northYorke' is not in TORONTO_DISTRICTS/,
    );
  });

  it('rejects an empty district list rather than returning an infinite rect', () => {
    expect(() => districtUnionRect([])).toThrow(RangeError);
  });

  it('is deterministic (a pure function of the street table — no seed, no drift)', () => {
    expect(districtUnionRect(['queenWest'])).toEqual(districtUnionRect(['queenWest']));
  });

  it('grows monotonically as districts are added', () => {
    const one = districtUnionRect(['financial']);
    const two = districtUnionRect(['financial', 'harbourfront']);
    expect(two.minX).toBeLessThanOrEqual(one.minX);
    expect(two.maxX).toBeGreaterThanOrEqual(one.maxX);
    expect(two.minZ).toBeLessThanOrEqual(one.minZ);
    expect(two.maxZ).toBeGreaterThanOrEqual(one.maxZ);
  });
});

describe('feelRouteRect', () => {
  it("matches each route's own declared district ids (thunk and ids can never disagree)", () => {
    for (const id of FEEL_ROUTE_IDS) {
      expect(feelRouteRect(id), id).toEqual(districtUnionRect(FEEL_ROUTES[id].districtIds));
    }
  });

  it("hands the downtown routes the camera lab's export itself", () => {
    expect(feelRouteRect('downtownDense')).toEqual(downtownDriveRect());
    expect(feelRouteRect('chase3')).toEqual(downtownDriveRect());
  });

  it('yields a real, non-degenerate rect for every route', () => {
    for (const id of FEEL_ROUTE_IDS) {
      const rect = feelRouteRect(id);
      for (const v of [rect.minX, rect.maxX, rect.minZ, rect.maxZ]) {
        expect(Number.isFinite(v), id).toBe(true);
      }
      expect(rect.maxX, id).toBeGreaterThan(rect.minX);
      expect(rect.maxZ, id).toBeGreaterThan(rect.minZ);
    }
  });

  it('puts the three cases on genuinely different ground', () => {
    const downtown = feelRouteRect('downtownDense');
    const spine = feelRouteRect('spineCruise');
    const weave = feelRouteRect('minorWeave');
    // world z === map y (mapToWorld is the identity swap). ZONE_BOUNDARIES[2] is Bloor, the
    // fold/downtown seam: the spine route lives entirely NORTH of it, the two downtown routes
    // entirely SOUTH — so a spine measurement can never be contaminated by tower-canyon streets.
    expect(spine.maxZ).toBeLessThanOrEqual(ZONE_BOUNDARIES[2]);
    expect(downtown.minZ).toBeGreaterThanOrEqual(ZONE_BOUNDARIES[2]);
    expect(weave.minZ).toBeGreaterThanOrEqual(ZONE_BOUNDARIES[2]);
    // Kensington/Queen West sit WEST of the bank canyon — the narrow-street case is not just the
    // downtown case under another name.
    expect(weave.minX).toBeLessThan(downtown.minX);
  });

  it('gives every route a workable stretch of the real road graph', () => {
    for (const id of FEEL_ROUTE_IDS) {
      const rect = feelRouteRect(id);
      const inside = GRAPH.nodes.filter((n) => nodeInRect(rect, n));
      expect(inside.length, `${id} node count`).toBeGreaterThan(40);
    }
  });
});

// ============================================================================================
// Start anchors + start-node snapping
// ============================================================================================

describe('feelRouteAnchor', () => {
  it('starts the downtown routes at the SHIPPED player spawn (same t=0 as the camera lab)', () => {
    for (const id of ['downtownDense', 'chase3'] as const) {
      expect(feelRouteAnchor(id)).toEqual({
        x: TORONTO_SPAWN_POSE.position.x,
        z: TORONTO_SPAWN_POSE.position.z,
      });
    }
  });

  it("puts the spine anchor on the projection's own Yonge line, mid-rect", () => {
    const rect = feelRouteRect('spineCruise');
    const anchor = feelRouteAnchor('spineCruise');
    expect(anchor.x).toBeCloseTo(mapToWorld({ x: YONGE_X, y: 0 })[0], 10);
    expect(anchor.z).toBeCloseTo((rect.minZ + rect.maxZ) / 2, 10);
  });

  it('puts the weave anchor at its rect centre', () => {
    const rect = feelRouteRect('minorWeave');
    expect(feelRouteAnchor('minorWeave')).toEqual({
      x: (rect.minX + rect.maxX) / 2,
      z: (rect.minZ + rect.maxZ) / 2,
    });
  });

  it('lands every anchor inside its own route rect', () => {
    for (const id of FEEL_ROUTE_IDS) {
      expect(nodeInRect(feelRouteRect(id), feelRouteAnchor(id)), id).toBe(true);
    }
  });
});

describe('nearestNodeIdInRect', () => {
  const RECT: DriveRect = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 };
  const nodes = [node(0, 50, 50), node(1, 12, 12), node(2, 105, 5), node(3, 300, 300)];

  it('prefers an in-rect node even when an out-of-rect one is nearer', () => {
    // (101, 5) sits 4 wu from node 2, which is OUTSIDE; the nearest inside node is 0, 68 wu away.
    // The plain nearestNodeId would answer 2 — that is the whole reason this wrapper exists.
    expect(nearestNodeIdInRect(nodes, RECT, 101, 5)).toBe(0);
  });

  it('picks the nearest of the in-rect candidates', () => {
    expect(nearestNodeIdInRect(nodes, RECT, 55, 55)).toBe(0);
    expect(nearestNodeIdInRect(nodes, RECT, 0, 0)).toBe(1);
  });

  it('falls back to the whole graph when the rect contains no node at all', () => {
    // Nothing inside ⇒ plain nearest over every node: (12,12) is the closest to (−950,−950).
    const empty: DriveRect = { minX: -1000, maxX: -900, minZ: -1000, maxZ: -900 };
    expect(nearestNodeIdInRect(nodes, empty, -950, -950)).toBe(1);
  });

  it("snaps every route's live start node INSIDE that route's own rect", () => {
    // Load-bearing for determinism, not tidiness: a start node outside the rect makes the first
    // planned hop take pickDowntownWaypoint's head-back-to-centre fallback (which consumes no
    // rng), so the same seed would open on a different leg depending on graph geometry.
    for (const id of FEEL_ROUTE_IDS) {
      const rect = feelRouteRect(id);
      const anchor = feelRouteAnchor(id);
      const startId = nearestNodeIdInRect(GRAPH.nodes, rect, anchor.x, anchor.z);
      expect(nodeInRect(rect, GRAPH.nodes[startId]), id).toBe(true);
    }
  });
});

// ============================================================================================
// Route planning determinism — the reproducibility contract
// ============================================================================================

describe('feelRouteSteps', () => {
  it('plans to the HARD consumption bound, not a typical pace', () => {
    // 3 possible waypoint advances per decision tick x 10 Hz = 30/s, plus a fixed margin. Sized
    // this way because the graph's 4.1 wu hub hops sit inside the arrival radius, so consumption
    // is bounded by the TICK RATE, not by how fast the car is going.
    expect(feelRouteSteps(60, null)).toBe(60 * 30 + 16);
    expect(feelRouteSteps(10, null)).toBe(10 * 30 + 16);
  });

  it('never plans fewer waypoints than a waypoint-boxed run will consume', () => {
    expect(feelRouteSteps(1, 200)).toBeGreaterThan(200);
  });

  it('is non-decreasing in both inputs (so a longer plan is always a prefix-extension)', () => {
    expect(feelRouteSteps(120, null)).toBeGreaterThan(feelRouteSteps(60, null));
    expect(feelRouteSteps(60, 400)).toBeGreaterThanOrEqual(feelRouteSteps(60, null));
    // The waypoint floor only binds past what the time budget already covers.
    expect(feelRouteSteps(60, 5000)).toBeGreaterThan(feelRouteSteps(60, null));
  });
});

describe('planFeelRoute determinism', () => {
  const plan = (id: FeelRouteId, seed: number, steps = 60) => planFeelRoute(GRAPH, id, seed, steps);

  it('produces the identical plan for the same (route, seed) — the whole point of the harness', () => {
    for (const id of FEEL_ROUTE_IDS) {
      expect(plan(id, 1), id).toEqual(plan(id, 1));
      expect(plan(id, 416), id).toEqual(plan(id, 416));
    }
  });

  it('produces a different waypoint sequence for a different seed', () => {
    for (const id of FEEL_ROUTE_IDS) {
      expect(plan(id, 1).waypoints, id).not.toEqual(plan(id, 2).waypoints);
    }
  });

  it('gives each route its own stream (same seed, different route ⇒ different path)', () => {
    // The rng is forked on the route id, so two routes over the SAME rect (downtownDense and
    // chase3) still walk different streets at the same seed — otherwise the chase route would be
    // the plain route with cops bolted on and the two would not be independent samples.
    expect(plan('downtownDense', 1).waypoints).not.toEqual(plan('chase3', 1).waypoints);
    expect(plan('downtownDense', 1).startNodeId).toBe(plan('chase3', 1).startNodeId);
  });

  it('a longer plan is a strict prefix-extension of a shorter one (same route + seed)', () => {
    for (const id of FEEL_ROUTE_IDS) {
      const short = plan(id, 5, 20);
      const long = plan(id, 5, 90);
      expect(long.waypoints.slice(0, short.waypoints.length), id).toEqual(short.waypoints);
    }
  });

  it('plans the full step budget', () => {
    for (const id of FEEL_ROUTE_IDS) {
      expect(plan(id, 3, 150).waypoints.length, `${id} length`).toBe(150);
    }
  });

  it('keeps the drive on its own ground, and never lets an excursion last two hops', () => {
    // pickDowntownWaypoint's documented fallback: a node with NO outgoing edge that stays inside
    // the rect hands back the edge whose far node is nearest the rect CENTRE — i.e. it steps out
    // and immediately heads back. So a plan is not 100 % in-rect and asserting that would be
    // wrong. What must hold is that the excursion is a single hop (the next pick is back inside)
    // and that it is rare. MEASURED over 4 routes × 5 seeds × 300 steps: 0–8.0 % outside, maxRun
    // exactly 1 in every case — the fallback always returns on the very next waypoint.
    for (const id of FEEL_ROUTE_IDS) {
      for (const seed of [1, 3, 416]) {
        const p = plan(id, seed, 200);
        let outside = 0;
        let run = 0;
        for (const nodeId of p.waypoints) {
          if (nodeInRect(p.rect, GRAPH.nodes[nodeId])) {
            run = 0;
          } else {
            outside++;
            run++;
            expect(run, `${id} seed ${seed}: excursion ran ${run} hops`).toBeLessThanOrEqual(1);
          }
        }
        expect(outside / p.waypoints.length, `${id} seed ${seed} outside fraction`).toBeLessThan(
          0.15,
        );
      }
    }
  });

  it('actually branches (the seeded stream is doing real work, not walking one cycle)', () => {
    for (const id of FEEL_ROUTE_IDS) {
      expect(new Set(plan(id, 1, 120).waypoints).size, id).toBeGreaterThan(8);
    }
  });

  it('reports the rect and start node it planned from', () => {
    const p = plan('spineCruise', 7);
    expect(p.routeId).toBe('spineCruise');
    expect(p.rect).toEqual(feelRouteRect('spineCruise'));
    expect(nodeInRect(p.rect, GRAPH.nodes[p.startNodeId])).toBe(true);
  });
});

// ============================================================================================
// Driver maths
// ============================================================================================

describe('lookaheadFor', () => {
  it("floors at the camera lab's proven 14 m for anything slower than 14 m/s", () => {
    expect(lookaheadFor(0)).toBe(14);
    expect(lookaheadFor(5)).toBe(14); // the camera lab's own cruise
    expect(lookaheadFor(14)).toBe(14);
  });

  it('aims one second ahead once the car is quicker than that', () => {
    expect(lookaheadFor(21)).toBeCloseTo(21, 10);
    expect(lookaheadFor(32)).toBeCloseTo(32, 10);
  });

  it('never returns a negative or shrinking distance', () => {
    expect(lookaheadFor(-5)).toBe(14);
    for (let v = 0; v < 40; v += 2.5)
      expect(lookaheadFor(v + 2.5)).toBeGreaterThanOrEqual(lookaheadFor(v));
  });
});

describe('arriveDistFor', () => {
  it('floors at 7 m and widens with speed so the window stays several decision ticks wide', () => {
    expect(arriveDistFor(0)).toBe(7);
    expect(arriveDistFor(14)).toBe(7);
    expect(arriveDistFor(21)).toBeCloseTo(10.5, 10);
  });

  it('stays strictly inside the look-ahead floor at EVERY speed (the controller must not race itself)', () => {
    // An arrival radius that out-reaches the aim point means the drive "arrives" at a node it is
    // still steering toward. Checked past the fastest car in the roster (grade A = 32 m/s).
    for (let v = 0; v <= 60; v += 0.5) expect(arriveDistFor(v)).toBeLessThan(lookaheadFor(v));
    expect(arriveDistFor(1000)).toBe(12);
  });
});

describe('governedThrottle', () => {
  it('goes to full throttle from a standstill', () => {
    expect(governedThrottle(15, 0)).toBe(1);
    expect(governedThrottle(11.25, 0)).toBe(1);
  });

  it('holds a steady part-throttle once the target is met', () => {
    expect(governedThrottle(15, 15)).toBeCloseTo(0.4, 10);
    expect(governedThrottle(21, 21)).toBeCloseTo(0.4, 10);
  });

  it('closes the throttle — but never brakes — above the target', () => {
    expect(governedThrottle(15, 17)).toBeCloseTo(0.04, 10);
    expect(governedThrottle(15, 25)).toBe(0);
    expect(governedThrottle(15, 40)).toBe(0);
  });

  it('is monotonically decreasing in speed and bounded to [0,1]', () => {
    let prev = Infinity;
    for (let v = 0; v <= 40; v += 1) {
      const t = governedThrottle(18, v);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(prev);
      prev = t;
    }
  });
});

describe('speedStats', () => {
  it('reports zeros (not NaN) for an empty window', () => {
    expect(speedStats([])).toEqual({
      samples: 0,
      meanMps: 0,
      medianMps: 0,
      p95Mps: 0,
      maxMps: 0,
    });
  });

  it('summarises a known sample set', () => {
    const stats = speedStats([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(stats.samples).toBe(10);
    expect(stats.meanMps).toBeCloseTo(9, 10);
    expect(stats.medianMps).toBe(8); // nearest-rank: ceil(0.5 * 10) = 5th value
    expect(stats.p95Mps).toBe(18);
    expect(stats.maxMps).toBe(18);
  });

  it('is order-independent and does not mutate its input', () => {
    const input = [9, 1, 5, 3, 7];
    const copy = [...input];
    expect(speedStats(input)).toEqual(speedStats([...input].reverse()));
    expect(input).toEqual(copy);
  });

  it('handles a single sample', () => {
    expect(speedStats([12.5])).toEqual({
      samples: 1,
      meanMps: 12.5,
      medianMps: 12.5,
      p95Mps: 12.5,
      maxMps: 12.5,
    });
  });
});

// ============================================================================================
// Report formatting
// ============================================================================================

/**
 * A REAL, empty telemetry snapshot, built through dev/feelTelemetry.ts's own constructor +
 * summariser rather than hand-written. No casts: if that module's schema changes, these fixtures
 * stop compiling — which is exactly the coupling we want between the drive's console output and
 * the numbers it is reporting.
 */
const EMPTY_TELEMETRY: FeelTelemetrySnapshot = summarizeFeel(
  createFeelAccumulator(resolveFeelCarParams()),
);

const REPORT: FeelDriveReport = {
  routeId: 'downtownDense',
  label: 'Downtown canyon — dense streetwall, full traffic',
  districtIds: ['financial', 'entertainment', 'yongeDundasQueen', 'stLawrence'],
  rect: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 },
  seed: 1,
  seconds: 60,
  elapsedSec: 60.4,
  startNodeId: 412,
  waypoints: [12, 34, 56],
  waypointTarget: null,
  speed: { samples: 600, meanMps: 11.2, medianMps: 12, p95Mps: 17.9, maxMps: 21.4, targetMps: 15 },
  heatAtStart: 0,
  heatAtEnd: 0,
  tierAtStart: 0,
  tierAtEnd: 0,
  requiredTier: 0,
  tierArmed: true,
  pursuitUnitsAtStart: 0,
  maxPursuitUnits: 0,
  maxTrafficUnits: 24,
  toggles: {
    applied: { invincible: true },
    observed: { invincible: true, civTraffic: true, transit: true },
  },
  driver: {
    cruiseTargetMps: 15,
    cruiseFracOfTopSpeed: 0.6,
    topSpeedMps: 25,
    carId: 'rustySedan',
    waypointsPlanned: 256,
    ticks: 600,
    pathLengthM: 673.2,
    teleportSkips: 0,
    netDisplacementM: 214.8,
    timeoutAbandons: 2,
    unstickAbandons: 1,
    grindEscapes: 3,
    revives: 0,
    grindEscapeAfterSec: 4,
  },
  telemetry: EMPTY_TELEMETRY,
};

describe('formatFeelDriveReport', () => {
  it('names the route and states the pace the numbers describe', () => {
    const text = formatFeelDriveReport(REPORT);
    expect(text).toContain('[feelDrive] downtownDense');
    expect(text).toContain('target 15.0 m/s');
    expect(text).toContain('0.60 × 25.0 top, rustySedan');
    expect(text).toContain('mean 11.2');
    expect(text).toContain('max 21.4');
    expect(text).toContain('600 samples');
  });

  it('reports route coverage, driver interventions and the world it drove in', () => {
    const text = formatFeelDriveReport(REPORT);
    expect(text).toContain('3 waypoints driven / 256 planned');
    expect(text).toContain('path 673 m');
    expect(text).toContain('net 215 m');
    expect(text).toContain('2 timeouts');
    expect(text).toContain('3 grind escapes (after 4.0s)');
    expect(text).toContain('0 revives');
    expect(text).toContain('traffic 24 peak');
    expect(text).toContain('invincible ON');
  });

  it('says nothing alarming about a clean, un-chased run', () => {
    const text = formatFeelDriveReport(REPORT);
    expect(text).not.toContain('NOT ARMED');
    expect(text).not.toContain('PURSUIT WENT LIVE');
  });

  it('mentions excluded teleport jumps only when a respawn actually happened', () => {
    expect(formatFeelDriveReport(REPORT)).not.toContain('teleport jumps');
    const revived = formatFeelDriveReport({
      ...REPORT,
      driver: { ...REPORT.driver, revives: 2, teleportSkips: 2 },
    });
    expect(revived).toContain('2 revives');
    expect(revived).toContain('2 teleport jumps excluded from path');
  });

  it('flags a plain route that picked up stars mid-window (its contacts include cops)', () => {
    const text = formatFeelDriveReport({ ...REPORT, heatAtEnd: 120, tierAtEnd: 2 });
    expect(text).toContain('PURSUIT WENT LIVE');
    expect(text).toContain('★0→★2');
  });

  it('flags a chase run whose window opened below the required tier', () => {
    const text = formatFeelDriveReport({
      ...REPORT,
      routeId: 'chase3',
      requiredTier: 3,
      tierArmed: false,
    });
    expect(text).toContain('NOT ARMED');
    expect(text).toContain('discard this run');
  });

  it('does not flag an armed chase run', () => {
    const text = formatFeelDriveReport({
      ...REPORT,
      routeId: 'chase3',
      requiredTier: 3,
      tierArmed: true,
      tierAtStart: 3,
      tierAtEnd: 3,
      pursuitUnitsAtStart: 4,
      maxPursuitUnits: 8,
    });
    expect(text).not.toContain('NOT ARMED');
    expect(text).not.toContain('PURSUIT WENT LIVE'); // a chase route is SUPPOSED to be tiered
    expect(text).toContain('pursuit 4 at open / 8 peak');
  });

  it('notes a waypoint-boxed window', () => {
    expect(formatFeelDriveReport({ ...REPORT, waypointTarget: 18 })).toContain('boxed at 18');
  });

  it("always prints the telemetry block (route mode's whole point is those numbers)", () => {
    const text = formatFeelDriveReport(REPORT);
    for (const line of telemetryDigestLines(REPORT.telemetry)) expect(text).toContain(line);
  });
});

describe('telemetryDigestLines', () => {
  /** A populated snapshot, assembled by overriding the real (empty) one block by block — so the
   * fixture stays type-checked against dev/feelTelemetry.ts's schema. */
  const loaded: FeelTelemetrySnapshot = {
    ...EMPTY_TELEMETRY,
    timing: {
      ...EMPTY_TELEMETRY.timing,
      samples: 1080,
      elapsedSec: 60.2,
      meanDtSec: 0.0557,
      maxDtSec: 0.25,
      stalledSamples: 3,
      droppedEvents: 7,
    },
    contact: {
      ...EMPTY_TELEMETRY.contact,
      records: 96,
      events: 40,
      eventsPerMin: 39.9,
      meanSpeedLossMps: 1.24,
      maxSpeedLossMps: 8.5,
      byKind: [
        {
          kind: 'civilian',
          records: 50,
          events: 22,
          eventsPerMin: 21.9,
          meanForceMagN: 1200,
          maxForceMagN: 4000,
          meanSpeedLossMps: 1.8,
        },
        {
          kind: 'propStatic',
          records: 46,
          events: 18,
          eventsPerMin: 17.9,
          meanForceMagN: 600,
          maxForceMagN: 2000,
          meanSpeedLossMps: 0.6,
        },
        // Touched but never resolved into a debounced EVENT — must not appear in the digest.
        {
          kind: 'building',
          records: 2,
          events: 0,
          eventsPerMin: 0,
          meanForceMagN: 90,
          maxForceMagN: 120,
          meanSpeedLossMps: 0,
        },
      ],
    },
    stuck: {
      ...EMPTY_TELEMETRY.stuck,
      count: 4,
      unrecoverableCount: 2,
      longestSec: 5.25,
      totalStuckSec: 12.4,
      byCause: [
        { cause: 'vehicleWedge', count: 3 },
        { cause: 'onVehicle', count: 1 },
      ],
    },
    stability: {
      ...EMPTY_TELEMETRY.stability,
      airtimeFrac: 0.0125,
      flipCount: 1,
      rollPeakRad: 0.42,
      pitchPeakRad: 0.19,
    },
    cornering: { ...EMPTY_TELEMETRY.cornering, lateralSlipFrac: 0.087 },
    notes: ['3 samples exceeded maxDtSec and were skipped'],
  };

  it('reports the contact block as a rate, with both the event and the record count', () => {
    const [contacts] = telemetryDigestLines(loaded);
    expect(contacts).toContain('contacts   39.9/min');
    expect(contacts).toContain('40 events / 96 records');
    expect(contacts).toContain('loss mean 1.24 max 8.50 m/s');
  });

  it('lists the busiest counterpart kinds, most-hit first', () => {
    expect(telemetryDigestLines(loaded)[0]).toContain('[civilian 22, propStatic 18]');
  });

  it('shouts the gate number (unrecoverable stuck events) rather than burying it', () => {
    const stuck = telemetryDigestLines(loaded)[1];
    expect(stuck).toContain('4 events, 2 UNRECOVERABLE');
    expect(stuck).toContain('longest 5.25s');
    expect(stuck).toContain('[vehicleWedge 3, onVehicle 1]');
  });

  it('reports the stability + sampling blocks, flagging stalls and dropped events', () => {
    const lines = telemetryDigestLines(loaded);
    expect(lines[2]).toContain('airtime 1.3%');
    expect(lines[2]).toContain('slip 8.7%');
    expect(lines[2]).toContain('flips 1');
    expect(lines[3]).toContain('60.2s over 1080 frames');
    expect(lines[3]).toContain('3 STALLED');
    expect(lines[3]).toContain('7 events dropped');
  });

  it('surfaces every note verbatim — feelTelemetry emits them so they cannot be missed', () => {
    const lines = telemetryDigestLines(loaded);
    expect(lines[lines.length - 1]).toBe('note       3 samples exceeded maxDtSec and were skipped');
  });

  it('renders an empty session without stall/drop noise, and still shows its note', () => {
    const lines = telemetryDigestLines(EMPTY_TELEMETRY);
    expect(lines[0]).toContain('contacts   0.0/min');
    expect(lines[1]).toContain('0 events, 0 UNRECOVERABLE');
    expect(lines[3]).not.toContain('STALLED');
    expect(lines[3]).not.toContain('dropped');
    // A virgin accumulator emits exactly one caveat ("no samples were recorded…"), and it must
    // reach the console — a silent all-zero route report is the worst possible failure mode.
    expect(lines).toHaveLength(4 + EMPTY_TELEMETRY.notes.length);
    expect(lines[4]).toContain('no samples were recorded');
  });

  it('lists only the counterpart kinds that produced a contact EVENT', () => {
    // Defensive against the schema's own history: a kind row can exist with zero events, and a
    // console line reading "building 0" invites someone to read a non-event as a contact.
    expect(loaded.contact.byKind.some((k) => k.kind === 'building' && k.events === 0)).toBe(true);
    expect(telemetryDigestLines(loaded)[0]).not.toContain('building');
  });

  it('omits the per-kind and per-cause brackets entirely when there is nothing to list', () => {
    expect(telemetryDigestLines(EMPTY_TELEMETRY)[0]).not.toContain('[');
    expect(telemetryDigestLines(EMPTY_TELEMETRY)[1]).not.toContain('[');
  });
});

// ===============================================================================================
// The driver-vs-detector timer invariant (Phase 74 baseline finding)
// ===============================================================================================
//
// The first baseline battery produced 5-8 stuck events per route with 25/28 tagged
// "unrecoverable" and 100% cause-tagged `building` — because the synthetic driver's own unwedge
// timer sat BEYOND the detector's unrecoverable threshold, so every wedge it entered was
// classified a trap by construction. That is a circular measurement: the number described the
// driver's patience, not the city. See FEEL_STEERING's doc comment for the full derivation and
// the 5/9/15 m/s control sweep that ruled out "driving too fast" as the cause.
//
// These tests pin the inequality so the artefact cannot silently come back if either the shipped
// AI tuning or the telemetry defaults are retuned in Parts 17-20.
describe('synthetic driver vs stuck-detector timers', () => {
  const detectorBudgetSec =
    FEEL_TELEMETRY_DEFAULTS.stuckEnterSec + FEEL_TELEMETRY_DEFAULTS.stuckUnrecoverableSec;

  it('recovers strictly before the detector would call a wedge unrecoverable', () => {
    // Strict: at equality the driver's reversal begins on the very tick the verdict lands, which
    // is a coin flip, not a measurement.
    expect(FEEL_STEERING.stuckSec).toBeLessThan(detectorBudgetSec);
  });

  it('still waits out the qualifying dwell, so real stuck events are not suppressed', () => {
    // The other failure mode: a driver that bails instantly would recover before the detector
    // ever declares an event, and the lab would report a suspiciously clean city.
    expect(FEEL_STEERING.stuckSec).toBeGreaterThanOrEqual(FEEL_TELEMETRY_DEFAULTS.stuckEnterSec);
  });

  it('overrides the shipped tuning rather than inheriting it, and only on the wedge timers', () => {
    expect(AI_STEERING.stuckSec).toBeGreaterThan(detectorBudgetSec); // the shipped value is why
    expect(FEEL_STEERING.stuckSec).not.toBe(AI_STEERING.stuckSec);
    expect(FEEL_STEERING.steerGain).toBe(AI_STEERING.steerGain);
    expect(FEEL_STEERING.commitDistM).toBe(AI_STEERING.commitDistM);
  });
});
