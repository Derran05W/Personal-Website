// Tests for the Phase 26 places / nostalgia layer (TORONTO-MAP-SPEC-v2.md §4 FASCIA, §6 vibe
// props, §8 places layer). Pins the invariants the renderer + the locked decisions rely on:
//   (a) every storefront box inside the §1 polygon, clear of every road ribbon (+1 wu margin);
//   (b) each place sits on the side of its reference street it claims;
//   (c) FASCIA bands live only on {south, east} and their vertical extent ⊆ [3.5, 5] wu;
//   (d) the North York Yonge strip is ordered by street number (higher number ⇒ further north ⇒
//       smaller y — the northward-decreasing-y invariant);
//   (e) the queue lineups are COSMETIC — they add zero collider-bearing footprints ("Pedestrians:
//       none" stays intact), and the Chinatown gate keeps ≥6 wu drive-under clearance;
//   (f) determinism (deep-equal on repeat) + no overlap with the named-building layer.
// Canvas/texture visuals (band atlas, spinning discs, animated screen) are proven by live
// screenshots (jsdom has no 2D context), not here.
import { describe, expect, it } from 'vitest';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildStreets } from './streets';
import { buildRibbons } from './roadGraph';
import { buildNamedBuildings } from './namedBuildings';
import { buildPlacesLayer, type PlaceBox } from './placesLayer';

const ROAD_MARGIN_WU = 1;
const EPS = 1e-6;

interface Aabb {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}
function boxAabb(b: PlaceBox): Aabb {
  return { minX: b.cx - b.hx, maxX: b.cx + b.hx, minZ: b.cz - b.hz, maxZ: b.cz + b.hz };
}
function rectAabb(r: { minX: number; maxX: number; minY: number; maxY: number }): Aabb {
  return { minX: r.minX, maxX: r.maxX, minZ: r.minY, maxZ: r.maxY };
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

describe('buildPlacesLayer — every storefront box inside the playable polygon', () => {
  it('all four footprint corners of every box are polygon-inclusive', () => {
    const offenders: string[] = [];
    for (const { id, box } of boxes) {
      if (!corners(boxAabb(box)).every((c) => pointInPolygon(c, PLAYABLE_POLYGON))) offenders.push(id);
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildPlacesLayer — zero road-ribbon violations', () => {
  it('no box overlaps any ribbon inflated by the road margin', () => {
    const inflated: Aabb[] = buildRibbons(streets).map((r) => ({
      minX: r.minX - ROAD_MARGIN_WU,
      maxX: r.maxX + ROAD_MARGIN_WU,
      minZ: r.minZ - ROAD_MARGIN_WU,
      maxZ: r.maxZ + ROAD_MARGIN_WU,
    }));
    const offenders: string[] = [];
    for (const { id, box } of boxes) {
      if (inflated.some((rib) => interiorOverlap(boxAabb(box), rib))) offenders.push(id);
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildPlacesLayer — each place sits on its claimed street side', () => {
  it('box centre lies on the correct side of the reference street ribbon', () => {
    const offenders: string[] = [];
    for (const p of layer.placements) {
      if (!p.box || p.kind === 'eatonTag') continue;
      const st = streetsById.get(p.refStreetId);
      expect(st, p.refStreetId).toBeDefined();
      if (!st) continue;
      const b = p.box;
      const ok =
        (p.side === 'E' && b.cx > st.ribbon.maxX) ||
        (p.side === 'W' && b.cx < st.ribbon.minX) ||
        (p.side === 'N' && b.cz < st.ribbon.minY) ||
        (p.side === 'S' && b.cz > st.ribbon.maxY);
      if (!ok) offenders.push(`${p.id} (${p.side} of ${p.refStreetId})`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildPlacesLayer — FASCIA bands (§4 / Addendum A.2)', () => {
  it('every band face is south or east only', () => {
    for (const p of layer.placements) {
      for (const f of p.fascias) expect(['south', 'east']).toContain(f.face);
    }
  });

  it('storefront places carry exactly one south + one east band', () => {
    for (const p of layer.placements) {
      if (p.kind !== 'storefront') continue;
      expect(p.fascias.map((f) => f.face).sort(), p.id).toEqual(['east', 'south']);
    }
  });

  it('every band vertical extent lies within [3.5, 5] wu above ground', () => {
    for (const p of layer.placements) {
      for (const f of p.fascias) {
        expect(f.cy - f.height / 2).toBeGreaterThanOrEqual(3.5 - EPS);
        expect(f.cy + f.height / 2).toBeLessThanOrEqual(5 + EPS);
      }
    }
  });

  it('the Apple tag rides the Eaton galleria (no new box) and only Alo/Apple are logo-decal-only', () => {
    const apple = layer.placements.find((p) => p.id === 'apple-eaton');
    expect(apple?.kind).toBe('eatonTag');
    expect(apple?.box).toBeNull();
    expect(layer.logoDecals.map((d) => d.placeId).sort()).toEqual(['alo', 'apple-eaton']);
  });
});

describe('buildPlacesLayer — North York Yonge strip ordering', () => {
  // Higher street number ⇒ further NORTH ⇒ smaller map-y (§2 capsule projection).
  const STRIP_NUMBERS: Record<string, number> = {
    'hmart-sheppard': 4885,
    'konjiki-ny': 5051,
    'owl-of-minerva': 5324,
    'buk-chang-dong': 5445,
    'hmart-finch': 5545,
    'echo-karaoke': 5592,
  };

  it('places ordered by street number have strictly decreasing y (northward)', () => {
    const rows = Object.keys(STRIP_NUMBERS)
      .map((id) => {
        const p = layer.placements.find((q) => q.id === id);
        expect(p?.box, id).toBeDefined();
        return { id, num: STRIP_NUMBERS[id], z: (p!.box as PlaceBox).cz };
      })
      .sort((a, b) => a.num - b.num);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].z, `${rows[i].id} vs ${rows[i - 1].id}`).toBeLessThan(rows[i - 1].z);
    }
  });

  it('every strip place sits inside the North York capsule (y < 1170)', () => {
    for (const id of Object.keys(STRIP_NUMBERS)) {
      const box = layer.placements.find((q) => q.id === id)!.box as PlaceBox;
      expect(box.cz, id).toBeLessThan(1170);
      expect(box.cz, id).toBeGreaterThan(0);
    }
  });
});

describe('buildPlacesLayer — cosmetic props stay colliderless (Pedestrians: none)', () => {
  it('exactly the two lineup venues (Uncle Tetsu + Konjiki-Elm) get queues', () => {
    expect(layer.queues.map((q) => q.placeId).sort()).toEqual(['konjiki-elm', 'uncle-tetsu']);
  });

  it('queues carry rope posts + person-blobs (~6-8) and no collider data', () => {
    for (const q of layer.queues) {
      expect(q.blobs.length).toBeGreaterThanOrEqual(6);
      expect(q.blobs.length).toBeLessThanOrEqual(8);
      expect(q.posts.length).toBe(2);
      // Structural: a QueueProp is posts + blobs only — no MapRect ever reaches buildingFootprints.
      for (const blob of q.blobs) {
        const inside = layer.buildingFootprints.some((r) =>
          interiorOverlap({ minX: blob.x, maxX: blob.x, minZ: blob.z, maxZ: blob.z }, rectAabb(r)),
        );
        expect(inside, `${q.placeId} blob inside a collider`).toBe(false);
      }
    }
  });

  it('building footprints are exactly the boxes (queues/gate/crosswalk/umbrellas/patio/graffiti add none)', () => {
    // 19 place boxes (all but the Apple-on-Eaton tag) + the Sankofa billboard box.
    expect(layer.buildingFootprints.length).toBe(boxes.length + 1);
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
