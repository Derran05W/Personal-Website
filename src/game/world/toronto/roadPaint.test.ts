// Phase 25.8 (D5/D3-L3) — road-paint tests: raised-sidewalk segment emission (bands never enter an
// intersection box), curb collider boxes (off the asphalt, on the sidewalk), and the palette ladder
// ordering surviving the L3 brighten.
//
// Phase 75 (T1) adds the laws the doubled ribbon widths made necessary: THE RIBBON UNION (no two
// asphalt quads may share ground on the `roadSurface` rung — the coplanar z-fight class Part 10
// exists to prevent, exposed map-wide by the Bay/York merge), the grass MEDIAN's geometry, the
// centre-dash suppression that goes with it, and a latent guard on full-ribbon road art.
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Color } from 'three';
import { CROSSWALK, LANE_OFFSET_WU, ROAD_CLASSES, ROAD_COLORS, ROAD_EDGE, ROAD_MEDIAN, SIDEWALK } from '../../config/torontoMap';
import { CAR_REF } from '../../config/cityPackScale';
import { GROUND_STACK } from '../../config/layering';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { buildStreets, type MapRect, type Street } from './streets';
import { buildTorontoRoadGraph, listIntersections, swallowedSpans } from './roadGraph';
import {
  buildRoadGeometry,
  buildSidewalkColliderBoxes,
  curbStripPieces,
  MAX_GRAPH_STEP_WU,
  MEDIAN_CUT_SETBACK_WU,
  medianTerminusInsetWu,
  ribbonPrecedence,
  sidewalkSegments,
  subtractRects,
} from './roadPaint';
import { higherRibbons } from './roadStrips';
import { crosswalkBands } from './crosswalks';
import { buildPlacesLayer } from './placesLayer';

/** Linear-light relative luminance from a hex (sRGB → linear → Rec.709). */
function lum(hex: string): number {
  const c = new Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // three Color is already linear
}

describe('sidewalkSegments', () => {
  it('never enters an intersection box (± crossHalf)', () => {
    const crossings = [
      { along: 100, crossHalf: 6 },
      { along: 300, crossHalf: 8 },
    ];
    const segs = sidewalkSegments(0, 400, crossings);
    for (const [a, b] of segs) {
      for (const c of crossings) {
        // No segment may overlap the crossing box interior.
        const boxLo = c.along - c.crossHalf;
        const boxHi = c.along + c.crossHalf;
        const overlaps = a < boxHi && b > boxLo;
        expect(overlaps).toBe(false);
      }
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(400);
      expect(b).toBeGreaterThan(a);
    }
  });

  it('a crossing-free span yields exactly one full segment', () => {
    const segs = sidewalkSegments(10, 90, []);
    expect(segs).toEqual([[10, 90]]);
  });

  it('drops slivers shorter than the minimum', () => {
    // Two crossings 3 wu apart leave a <2 wu gap between them — dropped.
    const segs = sidewalkSegments(0, 200, [
      { along: 98, crossHalf: 1 },
      { along: 102, crossHalf: 1 },
    ]);
    for (const [a, b] of segs) expect(b - a).toBeGreaterThanOrEqual(2);
  });
});

describe('buildSidewalkColliderBoxes', () => {
  const streets = buildStreets().streets;
  const intersections = listIntersections(streets);
  const boxes = buildSidewalkColliderBoxes(streets, intersections);

  it('produces boxes with positive extents, top at curbHeight', () => {
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.hx).toBeGreaterThan(0);
      expect(b.hz).toBeGreaterThan(0);
    }
  });

  it('every collider box sits OUTSIDE every ribbon (on the sidewalk, never the asphalt) — no exemptions', () => {
    // Part-8 (D1) compaction shrank the Bay/York centreline separation (~12.5 wu pre-compaction)
    // faster than their ribbon half-widths shrank, closing what used to be a comfortable gap into a
    // ~0.2 wu ribbon overlap near Union/the rail lands, and this test carried a documented
    // Bay/York EXEMPTION for it. Phase 75's doubling blew that overlap out to 7.88 wu — York's
    // whole west sidewalk would have stood in Bay's carriageway — so roadPaint.ts now suppresses
    // any raised band (and its collider) that falls inside a parallel ribbon, and the exemption is
    // GONE: the invariant holds for every street pair on the map.
    for (const b of boxes) {
      for (const s of streets) {
        const r = s.ribbon;
        const inside = b.cx > r.minX && b.cx < r.maxX && b.cz > r.minY && b.cz < r.maxY;
        expect(inside, `box (${b.cx.toFixed(2)},${b.cz.toFixed(2)}) inside ${s.id}`).toBe(false);
      }
    }
  });
});

// --- Phase 75 (T1): the emitted geometry, read back off the BufferGeometry -------------------

/** One emitted quad, recovered from the merged geometry. Every emitter (`quad` / `quadYs`) pushes
 * exactly 6 vertices in a fixed order, so quads are aligned to 18-float boundaries. `flat` is true
 * when all four corners share a Y (a plain surface quad); a chamfer is not flat. */
interface EmittedQuad {
  readonly yMin: number;
  readonly yMax: number;
  readonly flat: boolean;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly color: readonly [number, number, number];
}

function readQuads(geometry: BufferGeometry): EmittedQuad[] {
  const pos = geometry.getAttribute('position');
  const col = geometry.getAttribute('color');
  const out: EmittedQuad[] = [];
  for (let q = 0; q * 6 < pos.count; q++) {
    const base = q * 6;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let v = 0; v < 6; v++) {
      const x = pos.getX(base + v);
      const y = pos.getY(base + v);
      const z = pos.getZ(base + v);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
    }
    out.push({
      yMin,
      yMax,
      flat: yMax - yMin < Y_EPS,
      minX,
      maxX,
      minZ,
      maxZ,
      color: [col.getX(base), col.getY(base), col.getZ(base)],
    });
  }
  return out;
}

/** Positions round-trip through a Float32BufferAttribute, so a rung comparison needs a tolerance
 * wider than float32's ~1e-7 relative error — never an exact ===. */
const Y_EPS = 1e-5;

/** roadPaint.ts's MIN_SEGMENT_WU — the shortest raised band it will emit rather than ship a nub. */
const MIN_MEDIAN_SEGMENT_WU = 2;

function onRung(q: EmittedQuad, rungY: number): boolean {
  return q.flat && Math.abs(q.yMin - rungY) < Y_EPS;
}

function colorMatches(q: EmittedQuad, hex: string): boolean {
  const c = new Color(hex);
  return Math.abs(q.color[0] - c.r) < 1e-5 && Math.abs(q.color[1] - c.g) < 1e-5 && Math.abs(q.color[2] - c.b) < 1e-5;
}

function quadsOverlap(a: EmittedQuad, b: EmittedQuad): boolean {
  return a.minX < b.maxX - 1e-9 && b.minX < a.maxX - 1e-9 && a.minZ < b.maxZ - 1e-9 && b.minZ < a.maxZ - 1e-9;
}

/** Exact area of the UNION of a set of rects, by coordinate compression — an independent
 * derivation of "how much ground is road", so the union emitter can be checked for holes as well
 * as for double-cover. */
function unionArea(rects: readonly MapRect[]): number {
  const xs = [...new Set(rects.flatMap((r) => [r.minX, r.maxX]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.minY, r.maxY]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (rects.some((r) => cx > r.minX && cx < r.maxX && cy > r.minY && cy < r.maxY)) {
        area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
      }
    }
  }
  return area;
}

describe('Phase 75 — the ribbon union (no coplanar asphalt, anywhere)', () => {
  const streets = buildStreets().streets;
  const intersections = listIntersections(streets);
  const quads = readQuads(buildRoadGeometry(streets, intersections));
  const asphalt = quads.filter((q) => onRung(q, GROUND_STACK.roadSurface));

  it('emits asphalt at all', () => {
    expect(asphalt.length).toBeGreaterThanOrEqual(streets.length);
  });

  // THE LAW. Two overlapping asphalt quads on one rung are the coplanar z-fight Part 10 exists to
  // prevent (P39/P42). Before Phase 75 EVERY intersection was such a pair (whichever street came
  // later in the table simply painted over the other), and the doubled widths added the 7.88 wu
  // Bay/York merge on top. This catches the whole class permanently, not just Bay/York.
  it('no two asphalt quads on the roadSurface rung overlap', () => {
    for (let i = 0; i < asphalt.length; i++) {
      for (let j = i + 1; j < asphalt.length; j++) {
        expect(
          quadsOverlap(asphalt[i], asphalt[j]),
          `asphalt overlap: [${asphalt[i].minX.toFixed(2)},${asphalt[i].minZ.toFixed(2)}]-[${asphalt[i].maxX.toFixed(2)},${asphalt[i].maxZ.toFixed(2)}] vs [${asphalt[j].minX.toFixed(2)},${asphalt[j].minZ.toFixed(2)}]-[${asphalt[j].maxX.toFixed(2)},${asphalt[j].maxZ.toFixed(2)}]`,
        ).toBe(false);
      }
    }
  });

  it('and the union has no HOLES — emitted asphalt area equals the exact union area of every ribbon', () => {
    const emitted = asphalt.reduce((sum, q) => sum + (q.maxX - q.minX) * (q.maxZ - q.minZ), 0);
    const exact = unionArea(streets.map((s) => s.ribbon));
    // Relative, not absolute: the positions round-trip through float32, so ~370,000 wu² of road
    // carries ~0.04 wu² of representation error. A HOLE would be tens of wu², not hundredths.
    expect(Math.abs(emitted - exact) / exact, `emitted ${emitted.toFixed(3)} vs exact ${exact.toFixed(3)}`).toBeLessThan(1e-5);
  });

  it('precedence is width-ordered (spine > artery > major > minor), ties by table order', () => {
    const rank = ribbonPrecedence(streets);
    for (const a of streets) {
      for (const b of streets) {
        if (a.width > b.width) expect(rank.get(a.id)!).toBeLessThan(rank.get(b.id)!);
      }
    }
    // Yonge, the one spine, outranks everything.
    expect(rank.get('yonge')).toBe(0);
  });

  it('subtractRects tiles the remainder exactly (area is conserved, pieces never overlap)', () => {
    const base: MapRect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const cuts: MapRect[] = [
      { minX: 2, minY: -5, maxX: 4, maxY: 15 }, // full vertical band
      { minX: -5, minY: 6, maxX: 15, maxY: 7 }, // full horizontal band
      { minX: 8, minY: 8, maxX: 9, maxY: 9 }, // interior island
    ];
    const pieces = subtractRects(base, cuts);
    const area = pieces.reduce((s, p) => s + (p.maxX - p.minX) * (p.maxY - p.minY), 0);
    expect(area).toBeCloseTo(100 - 2 * 10 - 8 * 1 - 1, 9);
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i];
        const b = pieces[j];
        expect(a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY).toBe(false);
      }
    }
  });

  // The structural finding this phase surfaced, pinned so it can never silently change shape.
  it('Bay covers York entirely (the merge is real) and only York yields', () => {
    const bay = streets.find((s) => s.id === 'bay')!;
    const york = streets.find((s) => s.id === 'york')!;
    // Bay's half-width alone exceeds the centreline gap — shrinking either street cannot fix this.
    const gap = Math.abs(bay.centerline - york.centerline);
    expect(bay.halfWidth).toBeGreaterThan(gap);
    expect(york.centerline).toBeGreaterThan(bay.ribbon.minX);
    expect(york.centerline).toBeLessThan(bay.ribbon.maxX);
    // Bay outranks York (major beats minor), so Bay emits its full rectangle...
    const bayQuads = asphalt.filter((q) => q.minX >= bay.ribbon.minX - 0.01 && q.maxX <= bay.ribbon.maxX + 0.01);
    expect(bayQuads.length).toBeGreaterThan(0);
    // ...and no asphalt quad at all sits in the overlap strip more than once (covered by the law
    // above); York keeps only its eastern remainder.
    const yorkOnly = asphalt.filter((q) => q.minX > bay.ribbon.maxX - 0.01 && q.maxX <= york.ribbon.maxX + 0.01 && q.minZ >= york.ribbon.minY - 0.01);
    expect(yorkOnly.length).toBeGreaterThan(0);
  });
});

describe('Phase 75 — the grass median', () => {
  const streets = buildStreets().streets;
  const intersections = listIntersections(streets);
  const quads = readQuads(buildRoadGeometry(streets, intersections));
  const grass = quads.filter((q) => onRung(q, ROAD_MEDIAN.curbHeightWu) && colorMatches(q, ROAD_MEDIAN.grassColor));
  const medianStreets = streets.filter((s) => s.medianWidth > 0);

  it('exactly the median-carrying classes get one (spine + artery today)', () => {
    expect(medianStreets.map((s) => s.id).sort()).toEqual(['bloor', 'spadina', 'university', 'yonge']);
    expect(grass.length).toBeGreaterThan(0);
  });

  it('every grass quad sits inside its own street\'s median footprint, at the shared kerb height', () => {
    for (const q of grass) {
      const owner = medianStreets.find((s) => {
        const [pLo, pHi] = s.axis === 'ew' ? [q.minZ, q.maxZ] : [q.minX, q.maxX];
        return pLo >= s.centerline - s.medianHalfWidth - 1e-9 && pHi <= s.centerline + s.medianHalfWidth + 1e-9;
      });
      expect(owner, `grass quad x[${q.minX.toFixed(2)},${q.maxX.toFixed(2)}] z[${q.minZ.toFixed(2)},${q.maxZ.toFixed(2)}] has no median street`).toBeTruthy();
    }
    // The median steps up by the city's ONE kerb height — the same one the sidewalk band uses.
    expect(ROAD_MEDIAN.curbHeightWu).toBe(SIDEWALK.curbHeightWu);
  });

  it('reads as grass, not kerb: at least half the strip width is flat green', () => {
    for (const s of medianStreets) {
      const own = grass.filter((q) => {
        const [pLo, pHi] = s.axis === 'ew' ? [q.minZ, q.maxZ] : [q.minX, q.maxX];
        return pLo >= s.centerline - s.medianHalfWidth - 1e-9 && pHi <= s.centerline + s.medianHalfWidth + 1e-9;
      });
      expect(own.length).toBeGreaterThan(0);
      // Two half-tops per segment; their combined perpendicular width is the flat grass.
      const perpWidth = (q: EmittedQuad): number => (s.axis === 'ew' ? q.maxZ - q.minZ : q.maxX - q.minX);
      const bySegment = new Map<string, number>();
      for (const q of own) {
        const key = s.axis === 'ew' ? `${q.minX.toFixed(4)}:${q.maxX.toFixed(4)}` : `${q.minZ.toFixed(4)}:${q.maxZ.toFixed(4)}`;
        bySegment.set(key, (bySegment.get(key) ?? 0) + perpWidth(q));
      }
      // Tolerance is float32 representation error at map coordinates ~1500, not slack in the law.
      for (const [, w] of bySegment) expect(w).toBeGreaterThanOrEqual(s.medianWidth * 0.5 - 1e-3);
    }
  });

  // The reason the median's crossing cut is DEEPER than the sidewalk's: a raised 0.12 wu strip
  // would bury the 0.048 wu zebra rung it crosses, and the crossing would read as interrupted by a
  // lawn instead of painted across the road.
  it('never lands on a painted crosswalk band', () => {
    const bands = crosswalkBands(intersections);
    for (const q of grass) {
      for (const b of bands) {
        expect(
          q.minX < b.maxX - 1e-9 && b.minX < q.maxX - 1e-9 && q.minZ < b.maxZ - 1e-9 && b.minZ < q.maxZ - 1e-9,
          `median grass overlaps a zebra band at x${q.minX.toFixed(1)} z${q.minZ.toFixed(1)}`,
        ).toBe(false);
      }
    }
  });

  it('never lands inside an intersection box', () => {
    for (const q of grass) {
      for (const it of intersections) {
        const nsHalf = streets.find((s) => s.id === it.nsId)!.halfWidth;
        const ewHalf = streets.find((s) => s.id === it.ewId)!.halfWidth;
        const inBox =
          q.minX < it.x + nsHalf - 1e-9 && it.x - nsHalf < q.maxX - 1e-9 && q.minZ < it.y + ewHalf - 1e-9 && it.y - ewHalf < q.maxZ - 1e-9;
        expect(inBox, `median grass inside ${it.nsId}x${it.ewId}`).toBe(false);
      }
    }
  });

  it('a median-carrying street emits NO centre-line dashes; a plain one still does', () => {
    const dashes = quads.filter((q) => onRung(q, GROUND_STACK.roadPaint) && colorMatches(q, ROAD_EDGE.dash.color));
    // A dash runs ALONG its street, so orientation identifies which street painted it — a plain
    // "is it near this centreline" test also catches the cross streets' dashes passing through.
    const dashesOn = (s: Street): EmittedQuad[] =>
      dashes.filter((q) => {
        const alongLen = s.axis === 'ew' ? q.maxX - q.minX : q.maxZ - q.minZ;
        const perp = s.axis === 'ew' ? (q.minZ + q.maxZ) / 2 : (q.minX + q.maxX) / 2;
        return alongLen > ROAD_EDGE.dash.halfWidthWu * 2 + 1e-6 && Math.abs(perp - s.centerline) < s.halfWidth;
      });
    for (const s of medianStreets) {
      const onIt = dashesOn(s);
      expect(onIt.length, `${s.id} (median) still paints ${onIt.length} centre dashes`).toBe(0);
    }
    expect(dashesOn(streets.find((s) => s.id === 'queen')!).length).toBeGreaterThan(10);
  });
});

describe('Phase 75 — the median stops clear of a terminus (the hub→lane swing)', () => {
  const streets = buildStreets().streets;
  const intersections = listIntersections(streets);
  const graph = buildTorontoRoadGraph(streets);
  const quads = readQuads(buildRoadGeometry(streets, intersections));
  const grass = quads.filter((q) => onRung(q, ROAD_MEDIAN.curbHeightWu) && colorMatches(q, ROAD_MEDIAN.grassColor));
  const medianStreets = streets.filter((s) => s.medianWidth > 0);

  /** Grass quads belonging to `s`, as along-intervals. */
  const grassAlong = (s: Street): readonly [number, number][] =>
    grass
      .filter((q) => {
        const [pLo, pHi] = s.axis === 'ew' ? [q.minZ, q.maxZ] : [q.minX, q.maxX];
        return pLo >= s.centerline - s.medianHalfWidth - 0.01 && pHi <= s.centerline + s.medianHalfWidth + 0.01;
      })
      .map((q) => (s.axis === 'ew' ? ([q.minX, q.maxX] as [number, number]) : ([q.minZ, q.maxZ] as [number, number])));

  /**
   * The REQUIRED inset at one terminus, measured off the real traffic graph rather than assumed:
   * find this street's nearest own-lane waypoint to the tip (a node offset by LANE_OFFSET_WU on the
   * perpendicular axis), which fixes the first step length; the swing leaves the strip at
   * along-fraction medianHalfWidth / laneOffset of it; add half a car body.
   */
  function measuredRequirement(s: Street, tip: number): { step: number; required: number } {
    const laneOffset = LANE_OFFSET_WU[s.cls];
    let step = Infinity;
    for (const n of graph.nodes) {
      const [perp, along] = s.axis === 'ns' ? [n.x, n.z] : [n.z, n.x];
      if (Math.abs(Math.abs(perp - s.centerline) - laneOffset) > 0.01) continue;
      if (along < s.span[0] - 0.01 || along > s.span[1] + 0.01) continue;
      step = Math.min(step, Math.abs(along - tip));
    }
    return { step, required: (step * s.medianHalfWidth) / laneOffset + CAR_REF.lengthWu / 2 };
  }

  it('the mirrored graph step bound is never exceeded at a real median terminus', () => {
    for (const s of medianStreets) {
      for (const tip of s.span) {
        const { step } = measuredRequirement(s, tip);
        expect(step, `${s.id}@${tip} step=${step.toFixed(2)}`).toBeLessThanOrEqual(MAX_GRAPH_STEP_WU + 1e-6);
      }
    }
  });

  it('the derived inset covers the measured requirement at every terminus of every median street', () => {
    for (const s of medianStreets) {
      const inset = medianTerminusInsetWu(s);
      for (const tip of s.span) {
        const { required } = measuredRequirement(s, tip);
        expect(inset, `${s.id}@${tip} inset=${inset.toFixed(2)} required=${required.toFixed(2)}`).toBeGreaterThanOrEqual(required);
      }
    }
  });

  it('and no grass is actually emitted inside either terminus inset', () => {
    for (const s of medianStreets) {
      const inset = medianTerminusInsetWu(s);
      const [lo, hi] = s.span;
      for (const [a, b] of grassAlong(s)) {
        expect(a, `${s.id} grass starts ${(a - lo).toFixed(2)} from the low tip`).toBeGreaterThanOrEqual(lo + inset - 1e-3);
        expect(b, `${s.id} grass ends ${(hi - b).toFixed(2)} from the high tip`).toBeLessThanOrEqual(hi - inset + 1e-3);
      }
    }
  });

  // COUNT RECONCILIATION (measured here, not assumed): the four median streets carry **36**
  // crossings in total — yonge 13, university 8, spadina 8, bloor 7. Three of those sit ON a
  // terminus (university x bloor and university x front at its two ends, spadina x bloor at its
  // north end), so they are absorbed by the terminus inset rather than by the junction cut-out,
  // leaving **33** interior breaks. Both numbers are asserted below so the reconciliation is
  // executable; the SUBSTANCE — every crossing without exception interrupts the strip — is the law
  // that matters and is asserted over all 36.
  it('the junction cut-out breaks the median at every crossing of the four median streets', () => {
    const crossings = medianStreets.flatMap((s) =>
      intersections
        .filter((it) => (s.axis === 'ns' ? it.nsId === s.id : it.ewId === s.id))
        .map((it) => ({ s, along: s.axis === 'ns' ? it.y : it.x })),
    );
    expect(crossings.length).toBe(36);
    for (const { s, along } of crossings) {
      for (const [a, b] of grassAlong(s)) {
        expect(along > a && along < b, `${s.id} median runs through a crossing at ${along.toFixed(1)}`).toBe(false);
      }
    }
  });

  // ...and 32 of those 33 are TWO-SIDED breaks — grass resuming on both sides. The one that is
  // not is Yonge x Queens Quay: its cut-out ends 1.46 wu short of where the south terminus inset
  // already ends the strip, and MIN_SEGMENT_WU drops that sliver rather than ship a 1.5 wu nub of
  // grass. So the median simply stops there instead of breaking. 36 crossings → 33 interior → 32
  // two-sided breaks is the full reconciliation.
  it('32 of the 33 interior crossings are two-sided breaks; the 33rd ends the strip on a dropped sliver', () => {
    let interior = 0;
    let twoSided = 0;
    for (const s of medianStreets) {
      const inset = medianTerminusInsetWu(s);
      const segs = [...grassAlong(s)].sort((p, q) => p[0] - q[0]);
      const own = intersections.filter((it) => (s.axis === 'ns' ? it.nsId === s.id : it.ewId === s.id));
      for (const it of own) {
        const along = s.axis === 'ns' ? it.y : it.x;
        if (along <= s.span[0] + inset || along >= s.span[1] - inset) continue; // terminus junction
        interior++;
        const before = segs.some(([, b]) => b <= along);
        const after = segs.some(([a]) => a >= along);
        if (before && after) {
          twoSided++;
          continue;
        }
        // The only legal one-sided case: what the cut-out leaves between itself and the terminus
        // inset is shorter than the minimum segment, so there was nothing to emit — never a
        // silently missing break.
        expect(before || after, `${s.id}: crossing at ${along.toFixed(1)} has median on neither side`).toBe(true);
        const crossHalf = ROAD_CLASSES[s.axis === 'ns' ? it.ewCls : it.nsCls] / 2;
        const cutEnd = along + crossHalf + MEDIAN_CUT_SETBACK_WU;
        const remainder = s.span[1] - inset - cutEnd;
        expect(remainder, `${s.id}: crossing at ${along.toFixed(1)} dropped a non-sliver remainder`).toBeLessThan(MIN_MEDIAN_SEGMENT_WU);
        expect(remainder).toBeGreaterThan(0);
      }
    }
    expect(interior).toBe(33);
    expect(twoSided).toBe(32);
  });
});

describe('Phase 75 — the render union and the traffic graph agree on who yields', () => {
  const streets = buildStreets().streets;
  const intersections = listIntersections(streets);
  const rank = ribbonPrecedence(streets);
  const asphalt = readQuads(buildRoadGeometry(streets, intersections)).filter((q) => onRung(q, GROUND_STACK.roadSurface));

  // roadGraph.ts's `swallowedSpans` answers "is this still an independent carriageway?" by
  // CENTRELINE CONTAINMENT; the union here answers "does any ground get painted twice?" by RECT
  // OVERLAP, which is deliberately broader (it also covers every perpendicular intersection box).
  // The two must never disagree about WHICH street of a pair gives way — that would suppress
  // York's lane chains while clipping Bay's asphalt — so the relationship is a subsumption, tested
  // rather than asserted in a comment.
  it('every street the graph calls swallowed is outranked by the street that swallowed it', () => {
    for (const s of streets) {
      if (swallowedSpans(s, streets).length === 0) continue;
      const swallowers = streets.filter(
        (o) =>
          o.id !== s.id &&
          o.axis === s.axis &&
          (o.width > s.width || (o.width === s.width && o.id < s.id)) &&
          Math.abs(s.centerline - o.centerline) <= o.halfWidth,
      );
      expect(swallowers.length).toBeGreaterThan(0);
      for (const o of swallowers) {
        expect(rank.get(o.id)!, `${o.id} swallows ${s.id} but does not outrank it in the render union`).toBeLessThan(rank.get(s.id)!);
      }
    }
  });

  it('over a swallowed span the swallowed street emits no asphalt at its own centreline', () => {
    for (const s of streets) {
      for (const [lo, hi] of swallowedSpans(s, streets)) {
        for (let t = lo + 1; t < hi; t += (hi - lo) / 20) {
          const [px, pz] = s.axis === 'ns' ? [s.centerline, t] : [t, s.centerline];
          const owners = asphalt.filter((q) => px > q.minX && px < q.maxX && pz > q.minZ && pz < q.maxZ);
          // Exactly one quad owns the point (the union law), and it is NOT a piece of `s` —
          // `s`'s own remainder never reaches its centreline over a swallowed span.
          expect(owners.length, `${s.id} centreline at ${t.toFixed(1)} is covered ${owners.length}x`).toBe(1);
          const [pLo, pHi] = s.axis === 'ns' ? [owners[0].minX, owners[0].maxX] : [owners[0].minZ, owners[0].maxZ];
          expect(pHi - pLo, `${s.id} still paints its own centreline at ${t.toFixed(1)}`).toBeGreaterThan(s.width + 0.01);
        }
      }
    }
  });

  it('the tie-break matches roadGraph.ts exactly (wider wins, then id) — no second definition', () => {
    const ordered = [...streets].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (a.width === b.width) expect(a.id < b.id).toBe(true);
      else expect(a.width).toBeGreaterThan(b.width);
    }
  });
});

describe('Phase 75 — painted-stripe legibility survives the doubling (P41 THIN_GEOMETRY law)', () => {
  // The re-grade verdict: NO CHANGE. Width is the only quantity the doubling touched — the dash
  // length/gap pattern runs ALONG the street — and 0.4 wu on a 17.6 wu major is already ~3× the
  // proportion of a real centre line. The two widest classes no longer draw one at all (the median
  // is their centre marker). Recorded here as an executable statement, not just a comment.
  it('the centre dash and the crosswalk stripe both still clear the measured minimum', () => {
    expect(ROAD_EDGE.dash.halfWidthWu * 2).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    expect(CROSSWALK.stripeWidthWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    expect(ROAD_EDGE.widthWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });

  it('a doubled-width crossing still reads as a zebra (many stripes, not a handful)', () => {
    const streets = buildStreets().streets;
    const intersections = listIntersections(streets);
    const quads = readQuads(buildRoadGeometry(streets, intersections));
    const zebra = quads.filter((q) => onRung(q, GROUND_STACK.crosswalk));
    const spine = streets.find((s) => s.id === 'yonge')!;
    // Stripe count across the widest ribbon: floor of span / (stripe + gap).
    const expected = Math.floor((spine.width - CROSSWALK.stripeGapWu) / (CROSSWALK.stripeWidthWu + CROSSWALK.stripeGapWu));
    expect(expected).toBeGreaterThanOrEqual(15);
    expect(zebra.length).toBeGreaterThan(0);
  });

  it('no two crosswalk bands overlap (they would be coplanar on the crosswalk rung)', () => {
    const bands = crosswalkBands(listIntersections(buildStreets().streets));
    for (let i = 0; i < bands.length; i++) {
      for (let j = i + 1; j < bands.length; j++) {
        const a = bands[i];
        const b = bands[j];
        expect(
          a.minX < b.maxX - 1e-9 && b.minX < a.maxX - 1e-9 && a.minZ < b.maxZ - 1e-9 && b.minZ < a.maxZ - 1e-9,
          `zebra bands overlap: #${a.intersectionIndex} ${a.side} vs #${b.intersectionIndex} ${b.side}`,
        ).toBe(false);
      }
    }
  });
});

describe('Phase 75 — latent guard: full-ribbon road art vs the median', () => {
  // world/toronto/placesLayer.ts paints the Church Street rainbow crosswalk across the FULL ribbon
  // (`church.ribbon.minX..maxX`) on the `placesRoadArt` rung — BELOW the 0.12 wu median top. Church
  // is a `major` and no major opts into a median this phase, so nothing breaks today. The moment
  // one does, the artwork paints across (and is buried by) the grass. placesLayer.ts belongs to
  // another task, so this is the guard rather than the fix: it fails loudly the day the two meet.
  it('no places-layer road art spans a median-carrying street\'s ribbon', () => {
    const streets = buildStreets().streets;
    const places = buildPlacesLayer();
    const withMedian = streets.filter((s: Street) => s.medianWidth > 0);
    for (const stripe of places.crosswalk.stripes) {
      for (const s of withMedian) {
        const crossesMedian =
          s.axis === 'ns'
            ? stripe.minX <= s.centerline - s.medianHalfWidth && stripe.maxX >= s.centerline + s.medianHalfWidth
            : stripe.minZ <= s.centerline - s.medianHalfWidth && stripe.maxZ >= s.centerline + s.medianHalfWidth;
        expect(
          crossesMedian,
          `places road art spans ${s.id}'s median — it paints on (and is buried by) the grass strip`,
        ).toBe(false);
      }
    }
  });
});

describe('L3 ladder ordering (brightened palette preserves order)', () => {
  it('void < asphalt(minor≤major≤artery≤spine) < ground < sidewalk < curb < crosswalk', () => {
    const spine = lum(ROAD_COLORS.spine);
    const artery = lum(ROAD_COLORS.artery);
    const major = lum(ROAD_COLORS.major);
    const minor = lum(ROAD_COLORS.minor);
    const ground = lum('#4d545e'); // GROUND_COLOR (TorontoScene, brightened)
    const sidewalk = lum(SIDEWALK.color);
    const curb = lum(ROAD_EDGE.color);
    const crosswalk = lum('#c7c4ba');
    const voidC = lum('#121a2b');

    expect(minor).toBeLessThanOrEqual(major);
    expect(major).toBeLessThanOrEqual(artery);
    expect(artery).toBeLessThanOrEqual(spine);
    expect(voidC).toBeLessThan(minor);
    expect(spine).toBeLessThan(ground);
    expect(ground).toBeLessThan(sidewalk);
    expect(sidewalk).toBeLessThan(curb);
    expect(curb).toBeLessThan(crosswalk);
  });

  it('the curb FACE (D5) sits between asphalt and the sidewalk top', () => {
    const spine = lum(ROAD_COLORS.spine);
    const face = lum(SIDEWALK.curbFaceColor);
    const sidewalk = lum(SIDEWALK.color);
    expect(face).toBeGreaterThan(spine);
    expect(face).toBeLessThan(sidewalk);
  });
});

// ---------------------------------------------------------------------------------------------
// PHASE 75 (2026-08-06) — THE CURB-STRIP FLICKER FIX
// ---------------------------------------------------------------------------------------------
//
// THE FINDING. The Part-10 flicker sweep escalated `district-northYorkCentre` (x 1500, z 577.5, on
// the Yonge spine) to a hotspot: 247 tiles, 14,902 hot px, r12.33, 9/9 toggles, and — the tell —
// 100% unexplained at zero shift with the best registration pinned at the (12,12) CORNER of the
// search window, i.e. no real translation explains it. Colour decoding of the dumped frame pair
// identified the two surfaces exactly: `ROAD_EDGE.color` #8b95a0 (the painted curb strip) in one
// frame, `ROAD_COLORS.spine` #3b4350 (the asphalt) in the other, over the strip's full 0.8 wu width
// with only its anti-aliased edges surviving in both. A winner swap.
//
// THE MEASUREMENT (`.planning/tools/p75-curb-ladder.mjs` — world FROZEN, camera walked through 31
// pure-translation rungs 0.01 wu apart, counting each surface's literal unlit colour):
//   curb strip   19,990 → 33,593 px   spread 40.5%   ← collapses, and the asphalt gains the exact
//   spine asphalt 604,562 → 618,477   spread  2.2%     pixels it loses (anti-phase)
//   sidewalk top  69,596 → 71,522     spread  2.7%   ← every RAISED surface in the same frame
//   kerb chamfer  65,466 → 67,949     spread  3.7%     holds flat: the stimulus is not the cause
//   median grass  37,001 → 37,079     spread  0.2%
// The same ladder on the pre-phase tree (00eaeb1) reads 7% — the pair is older than Phase 75; the
// doubled ribbon widths pushed the strips into the deep half of the camera's visible ground band,
// where one 0.006 wu ladder step is ~4 depth-buffer LSBs, and took it over the sweep's threshold.
//
// THE FIX is structural, not a bigger epsilon: a painted curb strip is not a mark ON the road, it
// is a differently-coloured piece OF the road surface, so it joins the ribbon union on
// `GROUND_STACK.roadSurface` and the asphalt gives up the ground underneath it. See
// roadPaint.ts's `curbStripPieces` for the disjointness argument.
//
// AFTER, on the identical ladder: curb strip 33,199 → 33,603 px, spread 1.2% — BELOW every control
// surface in the frame, and it never loses a pixel to the asphalt again. The sweep vantage went
// 258 hot tiles / 1 hotspot → 11 tiles / 0 hotspots (the pre-phase tree read 18 tiles), with every
// other vantage in the slice unchanged within run-to-run noise.
describe('Phase 75 — painted curb strips are union members, not decals (the flicker fix)', () => {
  const streets = buildStreets().streets;
  const intersections = listIntersections(streets);
  const quads = readQuads(buildRoadGeometry(streets, intersections));
  const rank = ribbonPrecedence(streets);
  const curb = quads.filter((q) => colorMatches(q, ROAD_EDGE.color));
  const surface = quads.filter((q) => onRung(q, GROUND_STACK.roadSurface));
  const asRect = (q: EmittedQuad): MapRect => ({ minX: q.minX, minY: q.minZ, maxX: q.maxX, maxY: q.maxZ });

  /** Pairs of rects that share area. The SAME predicate the roadSurface law uses — reused here so
   * the positive control below exercises the real checker rather than a lookalike. */
  function overlappingPairs(rects: readonly MapRect[]): number {
    let n = 0;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a.minX < b.maxX - 1e-9 && b.minX < a.maxX - 1e-9 && a.minY < b.maxY - 1e-9 && b.minY < a.maxY - 1e-9) n++;
      }
    }
    return n;
  }

  it('curb paint exists, and EVERY piece sits on the roadSurface rung — none floats above the road', () => {
    // Two strips per street at minimum; higher-ranked crossings split them into more.
    expect(curb.length).toBeGreaterThanOrEqual(streets.length * 2);
    for (const q of curb) {
      expect(onRung(q, GROUND_STACK.roadSurface), `curb piece at y=${q.yMin} (expected the roadSurface rung)`).toBe(true);
    }
  });

  it('the roadPaint rung now carries ONLY the centre-line dashes', () => {
    const paintRung = quads.filter((q) => onRung(q, GROUND_STACK.roadPaint));
    expect(paintRung.length).toBeGreaterThan(0);
    for (const q of paintRung) {
      expect(colorMatches(q, ROAD_EDGE.dash.color), `unexpected quad on the roadPaint rung: colour ${q.color.join(',')}`).toBe(true);
    }
  });

  it('and it covers real ground, so the disjointness law below cannot pass by the strips vanishing', () => {
    const area = curb.reduce((s, q) => s + (q.maxX - q.minX) * (q.maxZ - q.minZ), 0);
    // Lower bound derived, not pinned: every street paints 2 × ROAD_EDGE.widthWu along its own
    // span, and the union can only take ground away — so half of that is a safe floor.
    const span = (st: Street): number => (st.axis === 'ew' ? st.ribbon.maxX - st.ribbon.minX : st.ribbon.maxY - st.ribbon.minY);
    const floor = streets.reduce((s, st) => s + 2 * ROAD_EDGE.widthWu * span(st), 0) / 2;
    expect(area).toBeGreaterThan(floor);
  });

  // Joining the union means a strip is now clipped by RECT subtraction rather than along its own
  // axis only, so a cover could in principle shave one thin instead of ending it. Measured today:
  // every piece is a full ROAD_EDGE.widthWu (0.8) wide and the shortest is 31.8 wu long. Pinned
  // against config/surfaces.ts's P41 law so a future street ever clipped narrow fails HERE — as a
  // geometry bug — instead of shimmering its way back into the flicker sweep.
  it('no piece is clipped thinner than the P41 THIN_GEOMETRY law allows', () => {
    for (const s of streets) {
      for (const p of curbStripPieces(s, streets, rank)) {
        const narrow = Math.min(p.maxX - p.minX, p.maxY - p.minY);
        expect(narrow, `${s.id} curb piece [${p.minX.toFixed(2)},${p.minY.toFixed(2)}]-[${p.maxX.toFixed(2)},${p.maxY.toFixed(2)}]`).toBeGreaterThanOrEqual(
          THIN_GEOMETRY.minStripeWidthWu,
        );
      }
    }
  });

  // THE REGRESSION, with the positive control that proves it is load-bearing.
  it('no curb piece shares ground with any other roadSurface quad — and the check is NOT vacuous', () => {
    expect(overlappingPairs(surface.map(asRect))).toBe(0);

    // POSITIVE CONTROL: rebuild the PRE-FIX emission from the same pure functions — asphalt cut
    // only by higher-ranked ribbons (nothing subtracted for the paint) plus the very same curb
    // pieces. That is precisely what shipped before this fix, one 0.006 wu ladder step apart; as
    // one surface it is the coplanar pair the camera ladder measured, and this checker must catch
    // it. If this expectation ever fails, the law above has gone blind and the fix is unguarded.
    const preFix: MapRect[] = [];
    for (const s of streets) {
      preFix.push(
        ...subtractRects(
          s.ribbon,
          higherRibbons(s, streets, rank).map((o) => o.ribbon),
        ),
      );
      preFix.push(...curbStripPieces(s, streets, rank));
    }
    // At least one collision per street: its own asphalt still covers its own curb paint.
    expect(overlappingPairs(preFix)).toBeGreaterThanOrEqual(streets.length);
  });
});
