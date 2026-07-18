// Tests for the Phase 25.7-shrunk places / nostalgia layer (TORONTO-MAP-SPEC-v2.md §6 vibe props +
// §8 Sam's discs / Apple-on-Eaton). The 18 business venues moved onto claimed frontage facades
// (world/toronto/venues.ts + frontage.ts) and are dressed by venueDress.ts — so this layer now only
// carries the two D7 exceptions (Sam host + Apple tag) and the §6 vibe props. Pins:
//   (a) the Sam host box sits inside the §1 polygon, clear of every ribbon, on its claimed side;
//   (b) exactly Sam host + Sankofa box become BUILDING colliders (every vibe prop is colliderless);
//   (c) Apple rides the Eaton galleria (no box) and is the only logo decal;
//   (d) determinism, Sam's two discs, gate clearance, the rainbow crosswalk, no named-box overlap.
import { describe, expect, it } from 'vitest';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildStreets } from './streets';
import { buildRibbons } from './roadGraph';
import { buildNamedBuildings } from './namedBuildings';
import { buildPlacesLayer, type PlaceBox } from './placesLayer';

const ROAD_MARGIN_WU = 1;

interface Aabb {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}
function boxAabb(b: PlaceBox): Aabb {
  return { minX: b.cx - b.hx, maxX: b.cx + b.hx, minZ: b.cz - b.hz, maxZ: b.cz + b.hz };
}
function interiorOverlap(a: Aabb, b: Aabb, tol = 1e-9): boolean {
  return a.minX < b.maxX - tol && a.maxX > b.minX + tol && a.minZ < b.maxZ - tol && a.maxZ > b.minZ + tol;
}
function corners(a: Aabb): { x: number; y: number }[] {
  return [
    { x: a.minX, y: a.minZ },
    { x: a.maxX, y: a.minZ },
    { x: a.maxX, y: a.maxZ },
    { x: a.minX, y: a.maxZ },
  ];
}

const layer = buildPlacesLayer();
const streets = buildStreets().streets;
const streetsById = new Map(streets.map((s) => [s.id, s]));
const boxes = layer.placements.filter((p) => p.box !== null).map((p) => ({ id: p.id, box: p.box as PlaceBox }));

describe('buildPlacesLayer — determinism', () => {
  it('is a pure function (deep-equal on repeat)', () => {
    expect(buildPlacesLayer()).toEqual(buildPlacesLayer());
  });
});

describe('buildPlacesLayer — the shrunk layer is just the two D7 exceptions + vibe props', () => {
  it('placements are exactly Sam (discs) + Apple (eatonTag)', () => {
    expect(layer.placements.map((p) => p.id).sort()).toEqual(['apple-eaton', 'sam-records']);
    expect(layer.placements.find((p) => p.id === 'sam-records')?.kind).toBe('discs');
    expect(layer.placements.find((p) => p.id === 'apple-eaton')?.kind).toBe('eatonTag');
  });

  it('the only box-bearing placement is the Sam host (Apple rides the Eaton galleria)', () => {
    expect(boxes.map((b) => b.id)).toEqual(['sam-records']);
    expect(layer.placements.find((p) => p.id === 'apple-eaton')?.box).toBeNull();
  });
});

describe('buildPlacesLayer — Sam host box inside the polygon, clear of ribbons, on its side', () => {
  it('all four host-box corners are polygon-inclusive', () => {
    for (const { id, box } of boxes) {
      expect(corners(boxAabb(box)).every((c) => pointInPolygon(c, PLAYABLE_POLYGON)), id).toBe(true);
    }
  });

  it('the host box overlaps no ribbon (inflated by the road margin)', () => {
    const inflated: Aabb[] = buildRibbons(streets).map((r) => ({
      minX: r.minX - ROAD_MARGIN_WU,
      maxX: r.maxX + ROAD_MARGIN_WU,
      minZ: r.minZ - ROAD_MARGIN_WU,
      maxZ: r.maxZ + ROAD_MARGIN_WU,
    }));
    for (const { id, box } of boxes) {
      expect(inflated.some((rib) => interiorOverlap(boxAabb(box), rib)), id).toBe(false);
    }
  });

  it('the host box sits on its claimed street side (Sam = E of Yonge)', () => {
    const sam = layer.placements.find((p) => p.id === 'sam-records')!;
    const st = streetsById.get(sam.refStreetId)!;
    expect(sam.box!.cx).toBeGreaterThan(st.ribbon.maxX); // side 'E'
  });
});

describe('buildPlacesLayer — building footprints + colliderless vibe props', () => {
  it('building footprints are exactly Sam host + Sankofa box (vibe props add none)', () => {
    // 1 Sam host box + the Sankofa billboard box.
    expect(layer.buildingFootprints.length).toBe(boxes.length + 1);
    expect(boxes.length).toBe(1);
  });

  it('Apple is the only logo decal (Alo moved to its claimed facade)', () => {
    expect(layer.logoDecals.map((d) => d.placeId).sort()).toEqual(['apple-eaton']);
  });

  it('the shrunk layer emits no queue field (queues moved to venueDress)', () => {
    expect((layer as unknown as { queues?: unknown }).queues).toBeUndefined();
  });
});

describe('buildPlacesLayer — vibe props', () => {
  it('the Chinatown gate keeps ≥6 wu drive-under clearance', () => {
    expect(layer.gate.clearance).toBeGreaterThanOrEqual(6);
  });

  it("Sam the Record Man has two rooftop discs above the host box's roof", () => {
    expect(layer.discs.discs.length).toBe(2);
    const roofY = layer.discs.host.hy * 2;
    for (const d of layer.discs.discs) expect(d.y).toBeGreaterThan(roofY);
    expect(layer.discs.discs.map((d) => d.brand).sort()).toEqual(['discA', 'discB']);
  });

  it('the rainbow crosswalk spans the Church ribbon width with six stripes', () => {
    const church = streetsById.get('church')!;
    expect(layer.crosswalk.stripes.length).toBe(6);
    for (const s of layer.crosswalk.stripes) {
      expect(s.minX).toBeCloseTo(church.ribbon.minX, 6);
      expect(s.maxX).toBeCloseTo(church.ribbon.maxX, 6);
    }
  });
});

describe('buildPlacesLayer — no overlap with the named-building layer', () => {
  it('no place box overlaps any named building box', () => {
    const named = buildNamedBuildings();
    const namedBoxes = named.placements.flatMap((p) => p.boxes.map((b) => ({ id: p.id, r: boxAabb(b as unknown as PlaceBox) })));
    const offenders: string[] = [];
    for (const { id, box } of boxes) {
      const fp = boxAabb(box);
      for (const nb of namedBoxes) if (interiorOverlap(fp, nb.r)) offenders.push(`${id} x ${nb.id}`);
    }
    expect(offenders).toEqual([]);
  });
});
