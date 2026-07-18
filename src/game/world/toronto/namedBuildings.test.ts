// Tests for the Phase 24 named-building placement layer (TORONTO-MAP-SPEC-v2.md §3c/§4,
// Addendum A.2/A.3; phase-24-plan Task 3). Pins the invariants the renderer relies on:
//   (a) every box inside the §1 polygon, clear of every road ribbon (+1 wu margin);
//   (b) no two named buildings overlap;
//   (c) dims + material come from data/toronto/building-specs.json (fs-read compare) and heights
//       are hGame(real_h_m) — the single-source rule;
//   (d) CROWN decals live only on the two camera-visible faces {south, east}, in the 70–85%
//       band, at the §4 clamped size, only on the six bank-brand towers;
//   (e) the two twins render as two boxes, the excluded ids are exactly the heroes + Casa Loma,
//       and the hero lots sit inside the polygon.
// Canvas/texture visuals are proven by live screenshots (jsdom has no 2D context), not here.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildStreets } from './streets';
import { buildRibbons } from './roadGraph';
import { hGame } from './heightCurve';
import {
  HERO_LOTS,
  NAMED_EXCLUDED_IDS,
  NAMED_FILLER_ARCHETYPE_IDS,
  buildNamedBuildings,
  type NamedBox,
} from './namedBuildings';

const ROAD_MARGIN_WU = 1;
const EPS = 1e-6;

interface Aabb {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

interface SpecRow {
  id: string;
  name: string;
  real_h_m: number;
  floors: number | null;
  footprint_wu: number;
  material: string;
}

const specsPath = resolve(process.cwd(), 'data/toronto/building-specs.json');
const specs: SpecRow[] = existsSync(specsPath)
  ? (JSON.parse(readFileSync(specsPath, 'utf-8')) as { buildings: SpecRow[] }).buildings
  : [];
const specById = new Map(specs.map((s) => [s.id, s]));

const named = buildNamedBuildings();

function boxAabb(b: NamedBox): Aabb {
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

describe('buildNamedBuildings — determinism', () => {
  it('is a pure function of the street table (deep-equal on repeat)', () => {
    expect(buildNamedBuildings()).toEqual(buildNamedBuildings());
  });
});

describe('buildNamedBuildings — every box inside the playable polygon', () => {
  it('all four footprint corners of every box are polygon-inclusive', () => {
    const offenders: string[] = [];
    for (const p of named.placements) {
      p.boxes.forEach((b, i) => {
        if (!corners(boxAabb(b)).every((c) => pointInPolygon(c, PLAYABLE_POLYGON))) {
          offenders.push(`${p.id}#${i}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildNamedBuildings — zero road-ribbon violations', () => {
  it('no box overlaps any ribbon inflated by the road margin', () => {
    const ribbons = buildRibbons(buildStreets().streets);
    const inflated: Aabb[] = ribbons.map((r) => ({
      minX: r.minX - ROAD_MARGIN_WU,
      maxX: r.maxX + ROAD_MARGIN_WU,
      minZ: r.minZ - ROAD_MARGIN_WU,
      maxZ: r.maxZ + ROAD_MARGIN_WU,
    }));
    const offenders: string[] = [];
    for (const p of named.placements) {
      p.boxes.forEach((b, i) => {
        const fp = boxAabb(b);
        if (inflated.some((rib) => interiorOverlap(fp, rib))) offenders.push(`${p.id}#${i}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildNamedBuildings — no two named buildings overlap', () => {
  it('boxes of distinct placements never overlap (own boxes may abut)', () => {
    const all = named.placements.flatMap((p) => p.boxes.map((b) => ({ id: p.id, r: boxAabb(b) })));
    const offenders: string[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (all[i].id !== all[j].id && interiorOverlap(all[i].r, all[j].r)) {
          offenders.push(`${all[i].id} x ${all[j].id}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('buildNamedBuildings — dims + material single-sourced from building-specs.json', () => {
  it('the specs file is present (this suite is data-driven)', () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  it('every placement carries the JSON material', () => {
    for (const p of named.placements) {
      expect(p.material).toBe(specById.get(p.id)?.material);
    }
  });

  it("main box height == hGame(real_h_m) and footprint_wu is one of its plan dimensions", () => {
    for (const p of named.placements) {
      const s = specById.get(p.id);
      expect(s, p.id).toBeDefined();
      if (!s) continue;
      const main = p.boxes[0];
      expect(main.hy * 2).toBeCloseTo(hGame(s.real_h_m), 6);
      // footprint_wu maps to the square edge (towers) or the long edge (colonnade/galleria).
      const dims = [main.hx * 2, main.hz * 2];
      expect(dims.some((d) => Math.abs(d - s.footprint_wu) < 1e-6)).toBe(true);
    }
  });
});

describe('buildNamedBuildings — CROWN decals (§4 / Addendum A.2)', () => {
  const BANK_BUILDINGS = new Map<string, string>([
    ['td-bank-tower', 'td'],
    ['commerce-court-west', 'cibc'],
    ['scotia-plaza', 'scotiabank'],
    ['first-canadian-place', 'bmo'],
    ['royal-bank-plaza', 'rbc'],
    ['cibc-square', 'cibc'],
  ]);

  it('exactly the six bank-brand towers carry decals; all others carry none', () => {
    for (const p of named.placements) {
      if (BANK_BUILDINGS.has(p.id)) expect(p.decals.length, p.id).toBeGreaterThan(0);
      else expect(p.decals.length, p.id).toBe(0);
    }
  });

  it('every decal face is SOUTH or EAST only, one of each per bank tower, on the brand + main box', () => {
    for (const p of named.placements) {
      if (p.decals.length === 0) continue;
      expect(p.decals.map((d) => d.face).sort()).toEqual(['east', 'south']);
      for (const d of p.decals) {
        expect(d.brand).toBe(BANK_BUILDINGS.get(p.id));
        expect(d.boxIndex).toBe(0);
      }
    }
  });

  it('crown band centre lies in [0.70, 0.85]·h', () => {
    for (const p of named.placements) {
      for (const d of p.decals) {
        expect(d.bandCenterFrac).toBeGreaterThanOrEqual(0.7 - EPS);
        expect(d.bandCenterFrac).toBeLessThanOrEqual(0.85 + EPS);
      }
    }
  });

  it('crown size is clamped to [8, 16] wu', () => {
    for (const p of named.placements) {
      for (const d of p.decals) {
        expect(d.size).toBeGreaterThanOrEqual(8 - EPS);
        expect(d.size).toBeLessThanOrEqual(16 + EPS);
      }
    }
  });
});

describe('buildNamedBuildings — twins render as two boxes', () => {
  it('hullmark and emerald-park each have two boxes', () => {
    for (const id of ['hullmark', 'emerald-park']) {
      const p = named.placements.find((q) => q.id === id);
      expect(p, id).toBeDefined();
      expect(p?.boxes.length).toBe(2);
    }
  });

  it('a twin secondary tower is shorter than its main (floor-ratio height)', () => {
    for (const id of ['hullmark', 'emerald-park']) {
      const p = named.placements.find((q) => q.id === id)!;
      expect(p.boxes[1].hy).toBeLessThan(p.boxes[0].hy);
    }
  });
});

describe('buildNamedBuildings — placement set vs the spec file', () => {
  it('excluded ids are exactly {cn-tower, rogers-centre, casa-loma}', () => {
    expect([...NAMED_EXCLUDED_IDS].sort()).toEqual(['casa-loma', 'cn-tower', 'rogers-centre']);
  });

  it('places every spec building except the excluded + filler-archetype ids', () => {
    const skip = new Set<string>([...NAMED_EXCLUDED_IDS, ...NAMED_FILLER_ARCHETYPE_IDS]);
    const expected = specs.map((s) => s.id).filter((id) => !skip.has(id)).sort();
    const placed = named.placements.map((p) => p.id).sort();
    expect(placed).toEqual(expected);
  });

  it('no placement uses an excluded id', () => {
    const excluded = new Set<string>(NAMED_EXCLUDED_IDS);
    expect(named.placements.filter((p) => excluded.has(p.id))).toEqual([]);
  });
});

describe('buildNamedBuildings — flush-frontage pass (Phase 25)', () => {
  // The six bank towers + Aura + Eaton front the primary drive-by corridors (King & Bay canyon,
  // Yonge spine), so their main facade must sit within a few wu of a road ribbon edge to fill the
  // frame on drive-past (§10.3 read, phase-24 debt). We assert ≤ 5 wu (the flush pass targets 3).
  const FLUSH_IDS = [
    'td-bank-tower',
    'scotia-plaza',
    'first-canadian-place',
    'commerce-court-west',
    'royal-bank-plaza',
    'cibc-square',
    'aura',
    'eaton-centre-galleria',
  ];

  /** Min AABB separation (0 if touching/overlapping); flush buildings never overlap a ribbon, so
   * this is the facade-to-ribbon-edge gap along the flushed axis. */
  function aabbGap(a: Aabb, b: Aabb): number {
    const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
    const dz = Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ);
    return Math.hypot(dx, dz);
  }

  it('the main facade of each corridor tower is ≤ 5 wu from the nearest ribbon edge', () => {
    const ribbons = buildRibbons(buildStreets().streets).map(
      (r): Aabb => ({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }),
    );
    for (const id of FLUSH_IDS) {
      const p = named.placements.find((q) => q.id === id);
      expect(p, id).toBeDefined();
      const box = boxAabb(p!.boxes[0]);
      const nearest = Math.min(...ribbons.map((r) => aabbGap(box, r)));
      expect(nearest, `${id} facade-to-ribbon gap`).toBeLessThanOrEqual(5);
    }
  });
});

describe('buildNamedBuildings — hero lots + exclusions', () => {
  it('both hero lots sit wholly inside the polygon', () => {
    for (const lot of named.heroLots) {
      const a: Aabb = { minX: lot.minX, minZ: lot.minY, maxX: lot.maxX, maxZ: lot.maxY };
      expect(corners(a).every((c) => pointInPolygon(c, PLAYABLE_POLYGON))).toBe(true);
    }
    expect(named.heroLots.length).toBe(HERO_LOTS.length);
  });

  it('exclusions cover every named box (inflated) plus the hero lots', () => {
    const boxCount = named.placements.reduce((n, p) => n + p.boxes.length, 0);
    expect(named.exclusions.length).toBe(boxCount + named.heroLots.length);
  });
});
