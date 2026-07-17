// TDD-first: authored from TORONTO-MAP-SPEC-v2.md §1–§2 + §10 phase-0 row and the
// orchestrator's derived-expectations list BEFORE projection.ts existed. The spec's
// mid-table y/x values are illustrative; data/toronto/anchors.json is authoritative, so
// where they disagree the derived truth is pinned via inline snapshot ("do not hand-tune
// twice"). Reads anchors.json off disk (not a static import) so this file needs no
// resolveJsonModule change to the shared tsconfig — same pattern as
// src/app/content/credits.test.ts. process.cwd() is the repo root (vitest runs from there).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TORONTO_CALIBRATION,
  TORONTO_PROJECTION,
  ZONE_BOUNDARIES,
  buildProjection,
  mapToWorld,
} from './projection';

interface RawAnchor {
  id: string;
  kind: string;
  lat: number | null;
  lon: number | null;
  status: string;
}
interface AnchorsFile {
  anchors: RawAnchor[];
}

const anchorsPath = resolve(process.cwd(), 'data/toronto/anchors.json');
const anchors = (JSON.parse(readFileSync(anchorsPath, 'utf-8')) as AnchorsFile).anchors;
const byId = new Map(anchors.map((a) => [a.id, a]));
const anchor = (id: string): RawAnchor => {
  const a = byId.get(id);
  if (!a) throw new Error(`anchors.json missing ${id}`);
  return a;
};

// Deterministic fuzz (no Math.random — same sequence on every machine, per rng.ts ethos).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

describe('TORONTO_CALIBRATION — single source of truth', () => {
  it('transcribes every participating lat/lon exactly from anchors.json (drift either way = red)', () => {
    for (const a of TORONTO_CALIBRATION.yongeLine) {
      const raw = anchor(a.id);
      expect(raw.status).toBe('verified');
      expect(raw.kind).toBe('yonge_line');
      expect(a.lat).toBe(raw.lat);
      expect(a.lon).toBe(raw.lon);
    }
    for (const c of TORONTO_CALIBRATION.nsControls) {
      // Only the latitude is calibration data; the y value is a map constant (spec §1/§2).
      expect(anchor(c.id).lat).toBe(c.lat);
    }
  });

  it('includes EVERY verified yonge_line anchor and excludes needs_agent rows', () => {
    const verifiedYonge = anchors
      .filter((a) => a.kind === 'yonge_line' && a.status === 'verified')
      .map((a) => a.id)
      .sort();
    const calibIds = TORONTO_CALIBRATION.yongeLine.map((a) => a.id).sort();
    expect(calibIds).toEqual(verifiedYonge);
    // needs_agent tolerance anchors never participate in calibration.
    const calibSet = new Set<string>([
      ...TORONTO_CALIBRATION.yongeLine.map((a) => a.id),
      ...TORONTO_CALIBRATION.nsControls.map((c) => c.id),
    ]);
    for (const a of anchors) {
      if (a.status === 'needs_agent') expect(calibSet.has(a.id)).toBe(false);
    }
  });

  it('is the calibration behind the default TORONTO_PROJECTION', () => {
    expect(TORONTO_PROJECTION.calib).toBe(TORONTO_CALIBRATION);
  });
});

describe('projection — the Yonge spine is a straight vertical at x=1500', () => {
  it('projects every on-map verified yonge_line anchor to x=1500 (|Δ| < 1e-6)', () => {
    const onMap = anchors.filter(
      (a) => a.kind === 'yonge_line' && a.status === 'verified' && a.id !== 'yonge-steeles',
    );
    expect(onMap.length).toBeGreaterThan(8);
    for (const a of onMap) {
      const { x } = TORONTO_PROJECTION.project({ lat: a.lat!, lon: a.lon! });
      expect(Math.abs(x - 1500)).toBeLessThan(1e-6);
    }
  });
});

describe('projection — zone-boundary anchors land on their constants', () => {
  const cases: ReadonlyArray<[string, number]> = [
    ['yonge-finch', 170],
    ['yonge-sheppard', 1170],
    ['yonge-bloor', 1830],
    ['shore-yonge', 3700],
  ];
  it.each(cases)('%s → y=%d (|Δ| < 1e-6)', (id, y) => {
    const a = anchor(id);
    expect(Math.abs(TORONTO_PROJECTION.project({ lat: a.lat!, lon: a.lon! }).y - y)).toBeLessThan(
      1e-6,
    );
  });
});

describe('projection — f(lat) is strictly monotonic (y grows as lat falls)', () => {
  it('over [shore-0.01, steeles+0.01] across 250 samples', () => {
    const top = anchor('yonge-steeles').lat! + 0.01;
    const bottom = anchor('shore-yonge').lat! - 0.01;
    const steps = 250;
    let prevY = -Infinity;
    for (let i = 0; i <= steps; i++) {
      const lat = top - ((top - bottom) * i) / steps; // lat decreasing
      const y = TORONTO_PROJECTION.project({ lat, lon: -79.39 }).y;
      expect(y).toBeGreaterThan(prevY);
      prevY = y;
    }
  });
});

describe('projection — derived Yonge-line y table (regenerated §2 anchor table)', () => {
  const yOf = (id: string): number => {
    const a = anchor(id);
    return TORONTO_PROJECTION.project({ lat: a.lat!, lon: a.lon! }).y;
  };

  it('sanity-checks the spec-approximate y values (a >5 wu miss signals a bug)', () => {
    expect(Math.abs(yOf('yonge-eglinton') - 1573)).toBeLessThan(5);
    expect(Math.abs(yOf('yonge-stclair') - 1706)).toBeLessThan(5);
    expect(Math.abs(yOf('yonge-king') - 3177)).toBeLessThan(5);
    expect(Math.abs(yOf('yonge-front') - 3294)).toBeLessThan(5);
  });

  it('is strictly increasing and each row sits in its expected zone', () => {
    const order = [
      'yonge-eglinton',
      'yonge-stclair',
      'yonge-college',
      'yonge-dundas',
      'yonge-queen',
      'yonge-king',
      'yonge-front',
      'yonge-queensquay',
    ];
    let prev = -Infinity;
    for (const id of order) {
      const y = yOf(id);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
    expect(TORONTO_PROJECTION.zoneAt(yOf('yonge-eglinton'))).toBe('fold');
    expect(TORONTO_PROJECTION.zoneAt(yOf('yonge-stclair'))).toBe('fold');
    for (const id of ['yonge-college', 'yonge-dundas', 'yonge-queen', 'yonge-king', 'yonge-front']) {
      expect(TORONTO_PROJECTION.zoneAt(yOf(id))).toBe('downtown');
    }
  });

  it('pins the regenerated table (2-decimal) — do not hand-tune twice', () => {
    const table = {
      eglinton: round2(yOf('yonge-eglinton')),
      stClair: round2(yOf('yonge-stclair')),
      college: round2(yOf('yonge-college')),
      dundas: round2(yOf('yonge-dundas')),
      queen: round2(yOf('yonge-queen')),
      king: round2(yOf('yonge-king')),
      front: round2(yOf('yonge-front')),
      queensQuay: round2(yOf('yonge-queensquay')),
    };
    expect(table).toMatchInlineSnapshot(`
      {
        "college": 2457.43,
        "dundas": 2715.79,
        "eglinton": 1572.85,
        "front": 3294.01,
        "king": 3177.14,
        "queen": 2937.24,
        "queensQuay": 3632.34,
        "stClair": 1706.16,
      }
    `);
  });
});

describe('projection — cross-street tolerance anchors (wobbly building-centroid proxies)', () => {
  // x-expectations are the spec §2 anchor values; ±80 wu because the proxies (Osgoode Hall,
  // Old City Hall, …) sit off the true centreline (anchors.json notes call for wide tolerance).
  const xCases: ReadonlyArray<[string, number]> = [
    ['queen-university', 1080],
    ['queen-bay', 1330],
    ['queen-church', 1670],
    ['queen-jarvis', 1840],
  ];
  it.each(xCases)('%s projects within 80 wu of x=%d', (id, expectedX) => {
    const a = anchor(id);
    const p = TORONTO_PROJECTION.project({ lat: a.lat!, lon: a.lon! });
    expect(Math.abs(p.x - expectedX)).toBeLessThanOrEqual(80);
    expect(TORONTO_PROJECTION.zoneAt(p.y)).toBe('downtown');
  });

  it('each lands near the Yonge&Queen latitude band', () => {
    // FORCED DEVIATION from the orchestrator's suggested 40 wu bound: these anchors are
    // building-centroid proxies, not points on the Queen centreline. Their latitudes scatter
    // up to ~0.0018° off Yonge&Queen (Moss Park Armoury/queen-jarvis is the outlier), and in
    // the downtown zone the N-S scale is ≈61,500 wu/° — so that scatter is ≈111 wu. A 40 wu
    // bound is not physical; loosened to 120 wu (real proxy scatter). Reported to orchestrator.
    const refY = TORONTO_PROJECTION.project({
      lat: anchor('yonge-queen').lat!,
      lon: anchor('yonge-queen').lon!,
    }).y;
    for (const [id] of xCases) {
      const a = anchor(id);
      const y = TORONTO_PROJECTION.project({ lat: a.lat!, lon: a.lon! }).y;
      expect(Math.abs(y - refY)).toBeLessThanOrEqual(120);
    }
  });

  // Phase 22 fills queen-bathurst / queen-spadina from OSM road polylines.
  it.skip('queen-bathurst / queen-spadina — needs_agent, Phase 22 fills from OSM', () => {
    expect(anchor('queen-bathurst').status).toBe('needs_agent');
    expect(anchor('queen-spadina').status).toBe('needs_agent');
  });
});

describe('projection — derived zone scales', () => {
  it('N-S m/wu sit inside sanity bands', () => {
    const s = TORONTO_PROJECTION.derivedZoneScales();
    expect(s.northYork).toBeGreaterThanOrEqual(1.8);
    expect(s.northYork).toBeLessThanOrEqual(2.8);
    expect(s.fold).toBeGreaterThanOrEqual(10);
    expect(s.fold).toBeLessThanOrEqual(18);
    expect(s.downtown).toBeGreaterThanOrEqual(1.5);
    expect(s.downtown).toBeLessThanOrEqual(2.2);
    // Downtown deviates from the spec table's 1.55 m/wu because the real Bloor→shore distance
    // is 3.39 km, not 2.9 km — the polygon's fixed y-constants (1830→3700) win, stretching the
    // implied scale to ≈1.81. The water band shares the Bloor→shore slope (south extrapolation).
    expect(s.water).toBeCloseTo(s.downtown, 6);
    expect(s.ewMPerWu).toBe(1.55);
  });

  it('pins exact derived scales', () => {
    const s = TORONTO_PROJECTION.derivedZoneScales();
    const pinned = {
      northYork: round2(s.northYork * 100) / 100,
      fold: round2(s.fold * 100) / 100,
      downtown: round2(s.downtown * 100) / 100,
      ewMPerWu: s.ewMPerWu,
    };
    expect(pinned).toMatchInlineSnapshot(`
      {
        "downtown": 1.8097,
        "ewMPerWu": 1.55,
        "fold": 15.281199999999998,
        "northYork": 2.2264,
      }
    `);
  });
});

describe('projection — round-trip unproject∘project', () => {
  it('recovers ≥120 seeded points across all zones within 1e-9°', () => {
    const rand = mulberry32(0x516969);
    // lat span covers north_york → water; lon span brackets the tilted Yonge centreline.
    const latHi = 43.79;
    const latLo = 43.635;
    let n = 0;
    for (let i = 0; i < 120; i++) {
      const lat = latLo + (latHi - latLo) * rand();
      const lon = -79.44 + 0.09 * rand();
      const back = TORONTO_PROJECTION.unproject(TORONTO_PROJECTION.project({ lat, lon }));
      expect(Math.abs(back.lat - lat)).toBeLessThan(1e-9);
      expect(Math.abs(back.lon - lon)).toBeLessThan(1e-9);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(120);
  });
});

describe('projection — ZONE_BOUNDARIES and mapToWorld seam', () => {
  it('exports the boundary constants', () => {
    expect([...ZONE_BOUNDARIES]).toEqual([0, 1170, 1830, 3700, 4100]);
  });

  it('buildProjection reproduces the default projection', () => {
    const p = buildProjection(TORONTO_CALIBRATION);
    const q = p.project({ lat: 43.6528, lon: -79.3794 });
    expect(q.x).toBeCloseTo(1500, 6);
    expect(q.y).toBeCloseTo(TORONTO_PROJECTION.project({ lat: 43.6528, lon: -79.3794 }).y, 6);
  });

  it('maps map-space → three.js world with map-north = −Z', () => {
    expect(mapToWorld({ x: 1500, y: 3700 })).toEqual([1500, 3700]);
    expect(mapToWorld({ x: 0, y: 0 })).toEqual([0, 0]);
  });
});

describe('projection — yonge-steeles is deliberately off-map', () => {
  it('projects to y < 0 (capsule top is north of Finch)', () => {
    const a = anchor('yonge-steeles');
    expect(TORONTO_PROJECTION.project({ lat: a.lat!, lon: a.lon! }).y).toBeLessThan(0);
  });
});
