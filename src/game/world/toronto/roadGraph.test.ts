// Tests authored from TORONTO-MAP-SPEC-v2.md §10 + phase-22-plan Decisions + the Task-2 brief.
// The road graph emits the EXISTING world/types.ts TrafficGraph shape (nodes/edges/outEdges) in
// WORLD coords via mapToWorld (map x→x, map y→z), with tileIndex:-1 (documented debt — no tile
// grid until the Phase 23 parity flip). The capsule reaches downtown ONLY via Yonge, so full
// reachability from node 0 proves the spine stitches the zones.
import { describe, expect, it } from 'vitest';
import { CAR_REF } from '../../config/cityPackScale';
import { LANE_OFFSET_WU, ROAD_CLASSES, ROAD_COLORS, WAYPOINT_SPACING_WU } from '../../config/torontoMap';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildRibbons, buildTorontoRoadGraph, listIntersections, swallowedSpans } from './roadGraph';
import { buildStreets, type Street } from './streets';

const { streets } = buildStreets();
const nsStreets = streets.filter((s) => s.axis === 'ns');
const ewStreets = streets.filter((s) => s.axis === 'ew');
const graph = buildTorontoRoadGraph(streets);
const { nodes, edges, outEdges } = graph;

// world (x,z) → back to map (x,y): mapToWorld is a pure identity swap (map y = world z).
const mapOf = (n: { x: number; z: number }): { x: number; y: number } => ({ x: n.x, y: n.z });

describe('TrafficGraph shape — matches world/types.ts', () => {
  it('nodes carry id, finite x/z, a valid kind, and the documented tileIndex:-1 debt', () => {
    nodes.forEach((n, i) => {
      expect(n.id).toBe(i);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.z)).toBe(true);
      expect(n.kind === 'intersection' || n.kind === 'waypoint').toBe(true);
      expect(n.tileIndex).toBe(-1);
    });
  });

  it('outEdges has one bucket per node', () => {
    expect(outEdges.length).toBe(nodes.length);
  });
});

describe('graph containment — every node lies inside the polygon', () => {
  it('holds for all nodes (world→map back-transform)', () => {
    for (const n of nodes) {
      expect(pointInPolygon(mapOf(n), PLAYABLE_POLYGON), `node ${n.id}`).toBe(true);
    }
  });
});

describe('graph connectivity — the spine stitches capsule → fold → downtown', () => {
  it('every node is reachable from node 0 via outEdges (BFS)', () => {
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (const ei of outEdges[u]) {
        const w = edges[ei].to;
        if (!seen.has(w)) {
          seen.add(w);
          queue.push(w);
        }
      }
    }
    expect(seen.size).toBe(nodes.length);
  });
});

describe('edge invariants', () => {
  // Phase 31 lane-offset fix (THE regression test — head-on eliminator): before this fix the
  // graph laid edges both ways over the SAME centreline nodes, so opposing civilian traffic
  // met head-on in one shared lane (live evidence: a 14-car jam wall on Yonge, x=1500 z 247-285,
  // both directions face-locked). Now every street gets two direction-offset waypoint chains
  // (roadGraph.ts's file header), so no directed edge should ever have a reverse-adjacent pair —
  // if one shows up, some pair of opposing lanes has collapsed back onto the same nodes.
  it('NO directed edge has a reverse-adjacent pair (opposing lanes never share nodes)', () => {
    const key = (f: number, t: number): string => `${f}->${t}`;
    const set = new Set(edges.map((e) => key(e.from, e.to)));
    for (const e of edges) {
      expect(set.has(key(e.to, e.from)), `reverse of ${e.from}->${e.to} must NOT exist`).toBe(false);
    }
  });

  it('outEdges[i] is exactly the indices of edges leaving node i', () => {
    edges.forEach((e, i) => {
      expect(outEdges[e.from]).toContain(i);
    });
    outEdges.forEach((bucket, i) => {
      for (const ei of bucket) expect(edges[ei].from).toBe(i);
    });
  });

  it('endpoints are in range and no self loops', () => {
    for (const e of edges) {
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(nodes.length);
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeLessThan(nodes.length);
      expect(e.from).not.toBe(e.to);
    }
  });
});

describe('waypoint spacing — every edge touching a waypoint is within [0.1,1.5]×spacing', () => {
  // Phase 31 lane-offset fix (roadGraph.ts's file header, MIN_SEGS): every inter-hub gap is now
  // subdivided into AT LEAST 2 steps PER DIRECTION, even when the gap itself is far shorter than
  // one WAYPOINT_SPACING_WU — a bare hub-to-hub edge would have no lane separation at all and
  // would reintroduce the exact head-on bug this fix exists to remove. The rail-lands cluster
  // (King/Front/Bremner/Queens Quay all crossing within a few car-lengths of each other) has the
  // map's shortest inter-hub gap (~7.5 wu); forced into 2 sub-segments plus the lane offset, its
  // shortest resulting edge measures ≈0.10x spacing (4.10 wu) — far below the pre-fix 0.35x floor
  // (which only ever had to tolerate ONE short leftover remainder). The lower bound is loosened to
  // 0.1x to admit this whole, now-systematic, documented class of short edges; the upper bound is
  // untouched (MIN_SEGS only ever shortens segments, never lengthens them — measured ≈1.19x here).
  it('holds (short forced-minimum edges near tight intersection clusters are expected, not bugs)', () => {
    const lo = 0.1 * WAYPOINT_SPACING_WU;
    const hi = 1.5 * WAYPOINT_SPACING_WU;
    const seen = new Set<string>();
    for (const e of edges) {
      const a = nodes[e.from];
      const b = nodes[e.to];
      const k = e.from < e.to ? `${e.from}:${e.to}` : `${e.to}:${e.from}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (a.kind !== 'waypoint' && b.kind !== 'waypoint') continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      expect(d, `edge ${e.from}-${e.to}`).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(d, `edge ${e.from}-${e.to}`).toBeLessThanOrEqual(hi + 1e-6);
    }
  });
});

describe('lane-offset containment — every node lies within at least one street ribbon', () => {
  // Every offset waypoint is centreline ± LANE_OFFSET_WU[cls], and LANE_OFFSET_WU is capped well
  // under every class's half-width (config/torontoMap.ts), so no lane-offset node should ever
  // fall outside its own street's painted ribbon. Hub nodes are exactly on a centreline (offset
  // 0), so they clear trivially. Checked against ANY street's ribbon (not a specific one) because
  // a shared intersection hub legitimately belongs to two streets at once.
  it('holds for all nodes', () => {
    for (const n of nodes) {
      const m = mapOf(n);
      const inSomeRibbon = streets.some(
        (s) =>
          m.x >= s.ribbon.minX - 1e-6 &&
          m.x <= s.ribbon.maxX + 1e-6 &&
          m.y >= s.ribbon.minY - 1e-6 &&
          m.y <= s.ribbon.maxY + 1e-6,
      );
      expect(inSomeRibbon, `node ${n.id} at (${m.x},${m.y})`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PHASE 75 — THE MEDIAN LAWS (T2). Phase 75 doubled every road width and planted a one-car-wide
// grass median down the spine and the arteries (config/torontoMap.ts's ROAD_MEDIAN), then
// re-derived LANE_OFFSET_WU from "0.25 x width, capped at 2.2" to the CARRIAGEWAY CENTRE. This
// file's builder reads LANE_OFFSET_WU verbatim, so the lane chains re-derived with NO code change
// — VERIFIED, not assumed: the "lane-offset containment" block above still passes, and the census
// block below pins that the topology (node/edge/intersection counts) did not move either.
//
// These tests are the invariant that replaces the deleted 2.2 cap on the GRAPH side. A lane node
// inside a median is not cosmetic: civilian traffic (ai/traffic.ts) and every pursuit unit
// (ai/torontoNavProvider.ts) navigate by these exact nodes, so such a node is a car driving down
// the planted strip.

/** The quantum roadGraph.ts de-duplicates coincident node positions with (its own KEY_Q). Re-
 * stated here so the hub reconstruction below keys positions exactly the way the builder does. */
const NODE_Q = 1e3;
const posKey = (x: number, y: number): string => `${Math.round(x * NODE_Q)}:${Math.round(y * NODE_Q)}`;

interface HubInfo {
  /** True when some perpendicular street actually crosses here (roadGraph.ts's 'intersection'). */
  crossing: boolean;
  /** Street ids for which this hub is an END of the street's own span (a dead-end / terminus). */
  tipOf: string[];
}

/**
 * Every HUB position the builder emits, reconstructed from the street table the same way
 * roadGraph.ts's `stops` + `hubKey` do it: a street's stops are its two span ends plus every
 * centreline crossing on it, each quantized to NODE_Q, and the hub sits UNOFFSET **on the
 * centreline** at that stop. Reconstructed rather than read off the graph because `kind` alone
 * cannot tell a dead-end hub (kind 'waypoint', on the centreline) from an ordinary lane waypoint
 * (kind 'waypoint', offset into a carriageway) — and that distinction is the whole point of the
 * median laws below.
 */
function reconstructHubs(): Map<string, HubInfo> {
  const q = (v: number): number => Math.round(v * NODE_Q) / NODE_Q;
  const hubs = new Map<string, HubInfo>();
  for (const s of streets) {
    const crossVals: number[] = [];
    for (const other of streets) {
      if (other.axis === s.axis) continue;
      // roadGraph.ts's findCrossings, stated symmetrically: each centreline must fall inside the
      // OTHER street's span.
      const onOther = s.centerline >= other.span[0] - 1e-6 && s.centerline <= other.span[1] + 1e-6;
      const onThis = other.centerline >= s.span[0] - 1e-6 && other.centerline <= s.span[1] + 1e-6;
      if (onOther && onThis) crossVals.push(q(other.centerline));
    }
    const crossSet = new Set(crossVals);
    const ends = [q(s.span[0]), q(s.span[1])];
    for (const v of new Set([...ends, ...crossVals])) {
      const key = s.axis === 'ns' ? posKey(s.centerline, v) : posKey(v, s.centerline);
      const info = hubs.get(key) ?? { crossing: false, tipOf: [] };
      if (crossSet.has(v)) info.crossing = true;
      if (ends.includes(v)) info.tipOf.push(s.id);
      hubs.set(key, info);
    }
  }
  return hubs;
}

const HUBS = reconstructHubs();
const MEDIAN_STREETS = streets.filter((s) => s.medianWidth > 0);
/** Half a player car — the width a lane node has to keep clear of the median kerb on its inner
 * flank (config/torontoMap.test.ts's lane law, expressed on real node positions). */
const CAR_HALF_WU = CAR_REF.widthWu / 2;

/**
 * How far a map-space point sits INSIDE `street`'s median strip, in wu: > 0 means the point is on
 * the planted strip, < 0 is its clearance to the nearest median kerb, and -Infinity means the
 * point is not alongside this street at all (outside its span). `grow` widens the strip — used
 * only to prove the detector has teeth.
 */
function medianIntrusionWu(street: Street, p: { x: number; y: number }, grow = 0): number {
  const along = street.axis === 'ns' ? p.y : p.x;
  if (along < street.span[0] - 1e-6 || along > street.span[1] + 1e-6) return Number.NEGATIVE_INFINITY;
  const across = street.axis === 'ns' ? p.x : p.y;
  return street.medianHalfWidth + grow - Math.abs(across - street.centerline);
}

describe('median footprints — no lane chain drives through the grass (Phase 75)', () => {
  const nodesWithMap = nodes.map((n) => ({ n, m: mapOf(n) }));
  const isHub = (m: { x: number; y: number }): boolean => HUBS.has(posKey(m.x, m.y));

  it('the map really does carry medians (otherwise every law below is vacuous)', () => {
    expect(MEDIAN_STREETS.map((s) => s.id).sort()).toEqual(['bloor', 'spadina', 'university', 'yonge']);
    for (const s of MEDIAN_STREETS) expect(s.medianHalfWidth, s.id).toBeGreaterThan(0);
  });

  it('EVERY non-hub (lane) node stays out of every median, with at least half a car of clearance', () => {
    for (const { n, m } of nodesWithMap) {
      if (isHub(m)) continue;
      for (const s of MEDIAN_STREETS) {
        const intrusion = medianIntrusionWu(s, m);
        expect(
          intrusion,
          `node ${n.id} at (${m.x.toFixed(2)},${m.y.toFixed(2)}) vs ${s.id}'s median`,
        ).toBeLessThanOrEqual(-CAR_HALF_WU);
      }
    }
  });

  it('THE DETECTOR HAS TEETH — widening a median to swallow its own lane centres finds nodes inside', () => {
    // Grow each median until its half-width reaches the class lane offset: that is precisely the
    // configuration the deleted 2.2 cap would have produced on spine/artery (both lanes hugging
    // the centreline, inside the planted strip). The detector must light up.
    let caught = 0;
    for (const { m } of nodesWithMap) {
      if (isHub(m)) continue;
      for (const s of MEDIAN_STREETS) {
        const grow = LANE_OFFSET_WU[s.cls] - s.medianHalfWidth;
        if (medianIntrusionWu(s, m, grow) > 0) caught++;
      }
    }
    expect(caught).toBeGreaterThan(0);
  });

  // THE HUB-ON-THE-CENTRELINE VERDICT (recorded so nobody "fixes" it later).
  //
  // roadGraph.ts emits ONE shared, UNOFFSET hub per stop — on the centreline, i.e. geometrically
  // inside a median street's median strip. That is CORRECT, not a defect, on two independent
  // grounds:
  //
  //   1. A junction is exactly where a real median BREAKS. Cross traffic and left-turning traffic
  //      must physically pass through the centreline at an intersection, so a real boulevard's
  //      planted strip stops short of the crossing (that is what a left-turn bay IS). The hub is
  //      that break. Offsetting hubs into the carriageways instead would split every intersection
  //      into four separate nodes, destroy the shared-node turn choice the Phase 31 fix is built
  //      on (see roadGraph.ts's header), and place turning traffic on geometry no real junction
  //      has.
  //   2. The median carries NO collider (config/torontoMap.ts's ROAD_MEDIAN.colliders = false,
  //      the Phase 25.8/37 curb-hop precedents), so a vehicle transiting a hub cannot be trapped
  //      by it under any circumstance. The strip is a visual.
  //
  // The second category — a median street's own TIP (its span end, a dead-end U-turn stop) — is
  // the same geometry with a weaker story: the median simply ends there, and the return chain
  // starts on the far side, so a vehicle turning round at the terminus crosses the strip's tip.
  // Also cosmetic (no collider), but it wants a TERMINUS INSET in the emitted median geometry.
  // MEASURED requirement per tip = firstSegmentLength x (medianHalfWidth / LANE_OFFSET_WU[cls])
  // — the along-distance the hub->lane transition spends inside the strip — plus half a car length
  // for the body:
  //     Yonge  y=12    10.43 wu      Yonge  y=2470   4.67 wu
  //     Spadina y=2484  6.31 wu      Bloor  x=614    7.39 wu      Bloor x=2026   9.79 wu
  // i.e. a uniform 10.5 wu inset at these five tips covers every case. (University's two ends and
  // Spadina's north end are junctions, so the junction-break rule already governs them.)
  it('the ONLY nodes inside a median are hubs — junction breaks and street tips, never lane nodes', () => {
    for (const { n, m } of nodesWithMap) {
      const insideSome = MEDIAN_STREETS.some((s) => medianIntrusionWu(s, m) > 0);
      if (!insideSome) continue;
      expect(isHub(m), `node ${n.id} at (${m.x.toFixed(2)},${m.y.toFixed(2)}) sits in a median`).toBe(true);
      const hub = HUBS.get(posKey(m.x, m.y))!;
      expect(hub.crossing || hub.tipOf.length > 0, `node ${n.id} is a hub but neither a crossing nor a tip`).toBe(true);
    }
  });

  it('census of median-straddling hubs — pinned (32 junction breaks + 5 terminus U-turn tips)', () => {
    let crossings = 0;
    let tipsOnly = 0;
    for (const { m } of nodesWithMap) {
      if (!MEDIAN_STREETS.some((s) => medianIntrusionWu(s, m) > 0)) continue;
      const hub = HUBS.get(posKey(m.x, m.y))!;
      if (hub.crossing) crossings++;
      else tipsOnly++;
    }
    // 37 = 32 junction breaks + 5 pure termini. The 4 median streets have 8 span ends between
    // them, but 3 of those (University at Bloor and at Front, Spadina at Bloor) ARE crossings, so
    // only 5 are pure U-turn tips: Yonge's two ends (y 12 / 2470), Spadina's south end (y 2484)
    // and Bloor's two ends (x 614 / 2026).
    expect(crossings + tipsOnly).toBe(37);
    expect(crossings).toBe(32);
    expect(tipsOnly).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PHASE 75 (T2) — THE OPPOSING-LANE LAW, and the Bay x York defect that forced it.
//
// THE DEFECT: Bay (major, half 8.8) and York (minor, half 6.6) sit 7.52 wu apart on the compacted
// map — already tangent BEFORE this phase (ribbon gap −0.18 wu) and a 7.88 wu ribbon OVERLAP after
// the doubling, with York's centreline 1.28 wu inside Bay's east edge. Naively that put Bay's
// NORTHBOUND chain and York's SOUTHBOUND chain 0.184 wu apart over the whole shared corridor
// (y 2170.28 → 2484): two OPPOSING chains in one strip of asphalt, with a 2.2 wu car on each
// overlapping the other by ~2.0 wu. That is Phase 31's head-on jam (its notes: "a 14-car jam wall
// on Yonge, x=1500 z 247-285, both directions face-locked") rebuilt BETWEEN two streets instead of
// within one, and civilian traffic is kinematic with a block-ray hold, so it deadlocks
// deterministically. Before the widening the same pair sat 3.666 wu apart.
//
// THE FIX: roadGraph.ts's swallowedSpans — a street whose centreline lies inside a WIDER street's
// ribbon emits no lane chains over that span; the wider street carries the traffic. See that
// function's doc comment for why re-siting York's chains east was measured and rejected.
//
// THE LAW (the durable part, and the thing that should have existed before this phase): no two
// lane lines anywhere on the map may come within one car width of each other. It generalises the
// Phase 31 fix from "within a street" to "across the whole map", and it is what catches the next
// instance of this class automatically.

/** One directed lane line: a straight run of carriageway at `across` (the perpendicular coordinate
 * — x for an 'ns' street, y for an 'ew'), covering [lo, hi] along the street, travelling in
 * `dir` (+1 = increasing along-value: south on 'ns', east on 'ew'). */
interface LaneLine {
  readonly streetId: string;
  readonly axis: 'ns' | 'ew';
  readonly across: number;
  readonly lo: number;
  readonly hi: number;
  readonly dir: 1 | -1;
}

/**
 * The lane lines the graph lays down, derived INDEPENDENTLY of roadGraph.ts's emission loop (from
 * the street table + LANE_OFFSET_WU + the right-hand-traffic convention) so this is a real check
 * and not a restatement of the builder. `applySuppression` false reproduces the pre-fix geometry —
 * that is the law's positive control.
 */
function laneLines(applySuppression: boolean): LaneLine[] {
  const out: LaneLine[] = [];
  for (const s of streets) {
    const offset = LANE_OFFSET_WU[s.cls];
    const swallowed = applySuppression ? swallowedSpans(s, streets) : [];
    // Whole-span minus the swallowed intervals. Today every swallowed span covers a street's
    // entire span, but the subtraction is written generally so a partial swallow still resolves.
    let live: [number, number][] = [[s.span[0], s.span[1]]];
    for (const [lo, hi] of swallowed) {
      const next: [number, number][] = [];
      for (const [a, b] of live) {
        if (hi <= a || lo >= b) next.push([a, b]);
        else {
          if (a < lo) next.push([a, lo]);
          if (hi < b) next.push([hi, b]);
        }
      }
      live = next;
    }
    for (const [lo, hi] of live) {
      if (hi - lo < 1e-6) continue;
      // roadGraph.ts's forwardSign: increasing along-value offsets to −x on 'ns', +y on 'ew'.
      const forwardSign = s.axis === 'ns' ? -1 : 1;
      out.push({ streetId: s.id, axis: s.axis, across: s.centerline + forwardSign * offset, lo, hi, dir: 1 });
      out.push({ streetId: s.id, axis: s.axis, across: s.centerline - forwardSign * offset, lo, hi, dir: -1 });
    }
  }
  return out;
}

/** Closest approach between any two DISTINCT lane lines that share along-street coverage.
 * `crossStreetOnly` drops the pairs a street makes with itself — those are fixed by construction at
 * 2 x LANE_OFFSET_WU (6.6 wu on the narrowest class), so they otherwise mask the interesting
 * number, which is how close two DIFFERENT streets' lanes get. */
function closestLanePair(
  lines: readonly LaneLine[],
  crossStreetOnly = false,
): { sep: number; label: string; opposing: boolean } {
  let best = { sep: Number.POSITIVE_INFINITY, label: 'none', opposing: false };
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      if (a.axis !== b.axis) continue;
      if (crossStreetOnly && a.streetId === b.streetId) continue;
      if (a.hi <= b.lo || b.hi <= a.lo) continue; // no shared along-coverage → they never meet
      const sep = Math.abs(a.across - b.across);
      if (sep < best.sep) {
        best = { sep, label: `${a.streetId}(${a.dir > 0 ? '+' : '-'})/${b.streetId}(${b.dir > 0 ? '+' : '-'})`, opposing: a.dir !== b.dir };
      }
    }
  }
  return best;
}

describe('opposing-lane law — no two lane chains anywhere come within one car width (Phase 75)', () => {
  const LIVE = laneLines(true);

  it('THE LAW — every pair of lane lines sharing a corridor is at least one car width apart', () => {
    const worst = closestLanePair(LIVE);
    expect(worst.sep, `closest pair: ${worst.label}`).toBeGreaterThanOrEqual(CAR_REF.widthWu);
  });

  it('THE LAW HAS TEETH — without the swallowed-carriageway suppression it fails at bay/york, 0.184 wu', () => {
    const worst = closestLanePair(laneLines(false));
    expect(worst.sep).toBeCloseTo(0.184, 3);
    expect(worst.label).toContain('bay');
    expect(worst.label).toContain('york');
    expect(worst.opposing, 'the pre-fix pair is OPPOSING — the head-on/deadlock class').toBe(true);
    expect(worst.sep).toBeLessThan(CAR_REF.widthWu); // i.e. the law above would fail
  });

  it('MARGIN ON RECORD — worst overall 6.6 wu (a minor\'s own pair), worst cross-street 25.517 wu', () => {
    // Overall: the closest two lane lines get anywhere on the map is a MINOR street's own two
    // chains, 2 x LANE_OFFSET_WU.minor apart by construction — 3x the one-car-width floor.
    const worst = closestLanePair(LIVE);
    expect(worst.sep).toBeCloseTo(2 * LANE_OFFSET_WU.minor, 6);
    expect(worst.sep).toBeCloseTo(6.6, 3);
    expect(worst.sep).toBeGreaterThanOrEqual(3 * CAR_REF.widthWu - 1e-9);

    // Cross-street: the interesting margin, since that is the class Bay/York broke. Richmond and
    // Queen, 25.517 wu — 11.6x the floor. Before the fix this number was 0.184.
    const worstCross = closestLanePair(LIVE, true);
    expect(worstCross.sep).toBeCloseTo(25.517, 3);
    expect(worstCross.label).toContain('richmond');
    expect(worstCross.label).toContain('queen');
    expect(worstCross.sep / CAR_REF.widthWu).toBeGreaterThan(10);
  });

  it('the emitted GRAPH agrees with the model — every lane node sits on a live lane line', () => {
    // Ties the analytic law to what the builder actually produced: if roadGraph ever emitted a
    // chain the model does not know about, the law above would be checking the wrong thing.
    const hubKeys = new Set(HUBS.keys());
    for (const n of nodes) {
      const m = mapOf(n);
      if (hubKeys.has(posKey(m.x, m.y))) continue;
      const on = LIVE.some((l) => {
        const across = l.axis === 'ns' ? m.x : m.y;
        const along = l.axis === 'ns' ? m.y : m.x;
        return Math.abs(across - l.across) < 1e-6 && along >= l.lo - 1e-6 && along <= l.hi + 1e-6;
      });
      expect(on, `node ${n.id} at (${m.x.toFixed(2)},${m.y.toFixed(2)}) is on no live lane line`).toBe(true);
    }
  });
});

describe('Bay x York — the swallowed carriageway (Phase 75 fix)', () => {
  const byId = new Map(streets.map((s) => [s.id, s]));
  const bay = byId.get('bay')!;
  const york = byId.get('york')!;

  it('the ribbons genuinely overlap and York\'s centreline sits inside Bay\'s asphalt', () => {
    const gap = Math.abs(bay.centerline - york.centerline);
    expect(gap).toBeCloseTo(7.516, 3);
    expect(bay.halfWidth + york.halfWidth - gap, 'ribbon overlap (wu)').toBeCloseTo(7.884, 3);
    expect(bay.halfWidth - Math.abs(york.centerline - bay.centerline), 'York centreline inside Bay').toBeCloseTo(1.284, 3);
  });

  it('York is the ONLY swallowed street on the map, and Bay is what swallows it', () => {
    const swallowed = streets.filter((s) => swallowedSpans(s, streets).length > 0);
    expect(swallowed.map((s) => s.id)).toEqual(['york']);
    expect(swallowedSpans(york, streets)).toEqual([[york.span[0], york.span[1]]]); // its whole span
    expect(swallowedSpans(bay, streets)).toEqual([]); // the wider street is never the one suppressed
  });

  it('York emits no lane chain of its own — Bay carries the corridor', () => {
    const laneX = [york.centerline - LANE_OFFSET_WU.minor, york.centerline + LANE_OFFSET_WU.minor];
    for (const x of laneX) {
      const on = nodes.some((n) => Math.abs(n.x - x) < 1e-6);
      expect(on, `York lane at x=${x.toFixed(2)} must be gone`).toBe(false);
    }
    // …while Bay's own two chains still run the shared corridor (y 2170.28 → 2484).
    for (const x of [bay.centerline - LANE_OFFSET_WU.major, bay.centerline + LANE_OFFSET_WU.major]) {
      const on = nodes.some((n) => Math.abs(n.x - x) < 1e-6 && n.z >= york.span[0] && n.z <= york.span[1]);
      expect(on, `Bay lane at x=${x.toFixed(2)} must still carry the corridor`).toBe(true);
    }
  });

  it('York\'s junctions survive — its crossing hubs are still nodes (emitted by the cross streets)', () => {
    // Suppression removes chains, not the network. Every street that crosses York still stops
    // there, so the junction stays reachable and turnable; only York's own dead-end tip (y 2484,
    // which no other street stops at) goes with it.
    for (const crossId of ['king', 'front', 'bremner', 'queensquay']) {
      const cross = byId.get(crossId)!;
      const on = nodes.some((n) => Math.abs(n.x - york.centerline) < 1e-3 && Math.abs(n.z - cross.centerline) < 1e-3);
      expect(on, `York x ${crossId} hub must survive`).toBe(true);
    }
    expect(nodes.some((n) => Math.abs(n.x - york.centerline) < 1e-3 && Math.abs(n.z - york.span[1]) < 1e-3)).toBe(false);
  });
});

describe('graph census — pinned (Phase 75 moved lane POSITIONS, not topology)', () => {
  // MEASURED both sides of the Phase 75 widening (T2, from an isolated worktree at the pre-widening
  // HEAD): 976 nodes / 1,176 edges / 73 intersections BEFORE; 963 / 1,156 / 73 AFTER.
  //
  // THE WIDENING ITSELF MOVED NOTHING: it pushed every lane chain outward (LANE_OFFSET_WU spine
  // 2.2 -> 6.05, artery 2.2 -> 5.5, major 2.2 -> 4.4, minor 1.65 -> 3.3) and re-nudged two
  // boundary-flush centrelines (Bloor 1366.95 -> 1371.90, Sheppard 697.60 -> 693.20, since
  // streets.ts's boundary nudge is half-width-derived), but node COUNT is a function of the stop
  // set and `segs = max(2, round(gap / WAYPOINT_SPACING_WU))`, and no gap moved far enough to
  // cross a rounding boundary. Measured at 976 / 1,176 / 73 both before and after.
  //
  // THE ENTIRE −13 / −20 DELTA IS THE SWALLOWED-CARRIAGEWAY FIX, and it is all York:
  //   • −12 lane waypoints — York's 4 inter-hub segments subdivide into segs 2 / 4 / 2 / 2 at
  //     WAYPOINT_SPACING_WU 40, i.e. 1 + 3 + 1 + 1 = 6 interior waypoints PER DIRECTION.
  //   • −1 hub — York's south dead-end tip (x 1363.49, y 2484), the one stop no crossing street
  //     also stops at. Its four junction hubs (King / Front / Bremner / Queens Quay) survive,
  //     emitted by those streets' own chains.
  //   • −20 edges — 10 chain edges per direction (segs summed: 2 + 4 + 2 + 2).
  // Intersections are unchanged at 73: suppression removes chains, never crossings.
  it('matches the pinned node/edge/intersection census', () => {
    expect(nodes.length).toBe(963);
    expect(edges.length).toBe(1156);
    expect(nodes.filter((n) => n.kind === 'intersection').length).toBe(73);
  });
});

describe('intersection nodes lie on both parent centrelines', () => {
  it('each intersection sits on some N-S centreline AND some E-W centreline (inside both spans)', () => {
    const on = (val: number, c: number): boolean => Math.abs(val - c) < 1e-3;
    const within = (v: number, span: readonly [number, number]): boolean =>
      v >= span[0] - 1e-3 && v <= span[1] + 1e-3;
    for (const n of nodes) {
      if (n.kind !== 'intersection') continue;
      const m = mapOf(n);
      const onNs = nsStreets.some((s) => on(m.x, s.centerline) && within(m.y, s.span));
      const onEw = ewStreets.some((s) => on(m.y, s.centerline) && within(m.x, s.span));
      expect(onNs && onEw, `node ${n.id} at (${m.x},${m.y})`).toBe(true);
    }
  });

  it('the number of intersection nodes equals the number of centreline crossings', () => {
    let crossings = 0;
    for (const a of nsStreets) {
      for (const b of ewStreets) {
        const x = a.centerline;
        const y = b.centerline;
        if (x >= b.span[0] - 1e-6 && x <= b.span[1] + 1e-6 && y >= a.span[0] - 1e-6 && y <= a.span[1] + 1e-6) {
          crossings++;
        }
      }
    }
    expect(nodes.filter((n) => n.kind === 'intersection').length).toBe(crossings);
  });
});

describe('determinism — the graph is a pure function of the streets', () => {
  it('rebuilding yields byte-identical nodes and edges', () => {
    const g2 = buildTorontoRoadGraph(buildStreets().streets);
    expect(g2.nodes).toEqual(nodes);
    expect(g2.edges).toEqual(edges);
    expect(g2.outEdges).toEqual(outEdges);
  });
});

// Phase 25.6 (D16) — listIntersections was private (findCrossings); now a public MAP-space
// crossing list furniture.ts's traffic-light/stop-sign rule keys off.
describe('listIntersections — MAP-space crossing list', () => {
  const intersections = listIntersections(streets);

  it('count matches the same crossing count roadGraph itself derives intersection nodes from', () => {
    let crossings = 0;
    for (const a of nsStreets) {
      for (const b of ewStreets) {
        const x = a.centerline;
        const y = b.centerline;
        if (x >= b.span[0] - 1e-6 && x <= b.span[1] + 1e-6 && y >= a.span[0] - 1e-6 && y <= a.span[1] + 1e-6) {
          crossings++;
        }
      }
    }
    expect(intersections.length).toBe(crossings);
  });

  it('every entry carries the correct nsId/ewId classes off the actual street table', () => {
    const byId = new Map(streets.map((s) => [s.id, s]));
    for (const c of intersections) {
      expect(byId.get(c.nsId)!.cls).toBe(c.nsCls);
      expect(byId.get(c.ewId)!.cls).toBe(c.ewCls);
      expect(byId.get(c.nsId)!.axis).toBe('ns');
      expect(byId.get(c.ewId)!.axis).toBe('ew');
    }
  });

  it('every crossing position sits on both parent centrelines, inside both spans', () => {
    const byId = new Map(streets.map((s) => [s.id, s]));
    for (const c of intersections) {
      const ns = byId.get(c.nsId)!;
      const ew = byId.get(c.ewId)!;
      expect(c.x).toBeCloseTo(ns.centerline, 6);
      expect(c.y).toBeCloseTo(ew.centerline, 6);
      expect(c.x).toBeGreaterThanOrEqual(ew.span[0] - 1e-6);
      expect(c.x).toBeLessThanOrEqual(ew.span[1] + 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(ns.span[0] - 1e-6);
      expect(c.y).toBeLessThanOrEqual(ns.span[1] + 1e-6);
    }
  });

  it('is sorted deterministically by (x, then y)', () => {
    for (let i = 1; i < intersections.length; i++) {
      const a = intersections[i - 1];
      const b = intersections[i];
      expect(a.x < b.x || (a.x === b.x && a.y <= b.y)).toBe(true);
    }
  });

  it('King x Bay is present and both classes are "major" (the D16 4-mast signalized example)', () => {
    const kingBay = intersections.find((c) => (c.nsId === 'bay' && c.ewId === 'king') || (c.nsId === 'king' && c.ewId === 'bay'));
    expect(kingBay).toBeDefined();
    expect(kingBay!.nsCls).toBe('major');
    expect(kingBay!.ewCls).toBe('major');
  });

  it('determinism — two independent calls are deep-equal', () => {
    expect(listIntersections(buildStreets().streets)).toEqual(intersections);
  });
});

describe('ribbon list for the scene — world-space rects + class + colour key', () => {
  const ribbons = buildRibbons(streets);

  it('one ribbon per street, class + colour resolved from config', () => {
    expect(ribbons.length).toBe(streets.length);
    for (const r of ribbons) {
      expect(ROAD_CLASSES[r.cls]).toBeGreaterThan(0);
      expect(r.color).toBe(ROAD_COLORS[r.cls]);
    }
  });

  it('world rect = mapToWorld of the street ribbon (identity swap, map y→z)', () => {
    const byStreet = new Map(ribbons.map((r) => [r.streetId, r]));
    for (const s of streets) {
      const r = byStreet.get(s.id)!;
      expect(r.minX).toBeCloseTo(s.ribbon.minX, 6);
      expect(r.maxX).toBeCloseTo(s.ribbon.maxX, 6);
      expect(r.minZ).toBeCloseTo(s.ribbon.minY, 6);
      expect(r.maxZ).toBeCloseTo(s.ribbon.maxY, 6);
    }
  });
});
