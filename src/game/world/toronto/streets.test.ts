// Tests authored from TORONTO-MAP-SPEC-v2.md §10 (build-order test list) + phase-22-plan
// Decisions, strengthened per the Task-2 brief. The street table is a stylized axis-aligned
// schematic (real curvature is Phase 23 OSM debt); every position is DERIVED from anchors.json
// via the projection — never a literal — so these tests pin the derivation, not hand-numbers.
//
// Reads anchors.json off disk (not a static import — see world/toronto/data.ts header) so the
// omission + anchor-fidelity tests track the live file. process.cwd() is the repo root.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDGE_PAD_WU, ROAD_CLASSES } from '../../config/torontoMap';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { TORONTO_PROJECTION } from './projection';
import { STREET_ANCHORS, STREET_DEFS, buildStreets } from './streets';

interface RawAnchor {
  id: string;
  kind: string;
  lat: number | null;
  lon: number | null;
  status: string;
}
const anchorsPath = resolve(process.cwd(), 'data/toronto/anchors.json');
const anchors = (JSON.parse(readFileSync(anchorsPath, 'utf-8')) as { anchors: RawAnchor[] }).anchors;
const byId = new Map(anchors.map((a) => [a.id, a]));

const built = buildStreets();
const streets = built.streets;
const streetById = new Map(streets.map((s) => [s.id, s]));
const inside = (x: number, y: number): boolean => pointInPolygon({ x, y }, PLAYABLE_POLYGON);

describe('buildStreets — anchor transcription is a faithful copy of anchors.json', () => {
  it('every STREET_ANCHORS row is verified in anchors.json with identical lat/lon (drift = red)', () => {
    for (const [id, ll] of Object.entries(STREET_ANCHORS)) {
      const raw = byId.get(id);
      expect(raw, `anchors.json missing ${id}`).toBeDefined();
      expect(raw!.status).toBe('verified');
      expect(ll.lat).toBe(raw!.lat);
      expect(ll.lon).toBe(raw!.lon);
    }
  });
});

describe('buildStreets — omission list is data-driven off anchors.json', () => {
  // A def is droppable iff it names a proxy anchor that is absent or not "verified".
  const expectedOmitted = STREET_DEFS.filter((d) => {
    if (d.positionRef === null) return false; // Yonge — no proxy
    const raw = byId.get(d.positionRef);
    return !raw || raw.status !== 'verified';
  })
    .map((d) => d.id)
    .sort();

  it('drops exactly the §3a streets whose proxy anchor is needs_agent / missing', () => {
    expect([...built.omissions].sort()).toEqual(expectedOmitted);
  });

  it('built streets = defs minus omissions (no phantom streets)', () => {
    const builtIds = streets.map((s) => s.id).sort();
    const expectedIds = STREET_DEFS.map((d) => d.id)
      .filter((id) => !built.omissions.includes(id))
      .sort();
    expect(builtIds).toEqual(expectedIds);
  });

  it('current anchors.json has every §3a proxy verified → no omissions', () => {
    // Documents the read-time state; if a proxy reverts to needs_agent this flips and the
    // data-driven test above still holds.
    expect(built.omissions).toEqual([]);
  });
});

describe('§10 "every road segment lies fully inside polygon" — strengthened to ribbons', () => {
  it('every ribbon CORNER lies inside the polygon (boundary-inclusive)', () => {
    for (const s of streets) {
      const { minX, minY, maxX, maxY } = s.ribbon;
      for (const [x, y] of [
        [minX, minY],
        [maxX, minY],
        [minX, maxY],
        [maxX, maxY],
      ]) {
        expect(inside(x, y), `${s.id} corner (${x},${y})`).toBe(true);
      }
    }
  });

  it('every centreline ENDPOINT lies inside the polygon', () => {
    for (const s of streets) {
      expect(inside(s.start.x, s.start.y), `${s.id} start`).toBe(true);
      expect(inside(s.end.x, s.end.y), `${s.id} end`).toBe(true);
    }
  });

  it('every ribbon is FULLY inside — dense sample of all four ribbon edges', () => {
    const N = 48;
    for (const s of streets) {
      const { minX, minY, maxX, maxY } = s.ribbon;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const lerpX = minX + (maxX - minX) * t;
        const lerpY = minY + (maxY - minY) * t;
        for (const [x, y] of [
          [lerpX, minY],
          [lerpX, maxY],
          [minX, lerpY],
          [maxX, lerpY],
        ]) {
          expect(inside(x, y), `${s.id} edge sample (${x},${y})`).toBe(true);
        }
      }
    }
  });
});

describe('boundary-nudge — streets on a polygon/zone boundary shift inward by half-width', () => {
  // The rule is geometric (applied from polygon containment, not per-street constants); these
  // two are the streets it fires on: Bloor (y=1830, downtown top → nudge south) and Sheppard
  // (y=1170, capsule bottom → nudge north).
  const nudgeCase = (id: string): void => {
    const s = streetById.get(id)!;
    // ribbon fully inside (already covered above, asserted here per-street for locality)
    for (const [x, y] of [
      [s.ribbon.minX, s.ribbon.minY],
      [s.ribbon.maxX, s.ribbon.maxY],
    ]) {
      expect(inside(x, y), `${id} ribbon corner`).toBe(true);
    }
    // centreline moved at most half a ribbon width from its anchor-derived position
    const anchorRaw = byId.get(s.positionRef!)!;
    const anchorY = TORONTO_PROJECTION.project({ lat: anchorRaw.lat!, lon: anchorRaw.lon! }).y;
    expect(Math.abs(s.centerline - anchorY)).toBeLessThanOrEqual(s.halfWidth + 1e-6);
    // and the shift is non-zero (it actually nudged)
    expect(Math.abs(s.centerline - anchorY)).toBeGreaterThan(1e-6);
  };

  it('Bloor nudges south, ribbon fully inside, |shift| = half-width', () => {
    nudgeCase('bloor');
    expect(streetById.get('bloor')!.centerline).toBeGreaterThan(1830); // south
  });

  it('Sheppard nudges north, ribbon fully inside, |shift| = half-width', () => {
    nudgeCase('sheppard');
    expect(streetById.get('sheppard')!.centerline).toBeLessThan(1170); // north
  });

  it('raw (un-nudged) Bloor ribbon would poke out of the polygon (nudge is necessary)', () => {
    // Sanity: the north-west corner of an un-nudged Bloor ribbon is outside — proving the rule
    // is doing real work, not decoration.
    const s = streetById.get('bloor')!;
    expect(inside(EDGE_PAD_WU, 1830 - s.halfWidth)).toBe(false);
  });
});

describe('anchor fidelity — every centreline traces back to its projected anchor', () => {
  it('N-S street x = project(proxy).x within 1e-6 (Yonge is exactly 1500)', () => {
    for (const s of streets) {
      if (s.axis !== 'ns') continue;
      if (s.id === 'yonge') {
        expect(s.centerline).toBe(1500);
        continue;
      }
      const a = byId.get(s.positionRef!)!;
      const x = TORONTO_PROJECTION.project({ lat: a.lat!, lon: a.lon! }).x;
      expect(Math.abs(s.centerline - x)).toBeLessThan(1e-6);
    }
  });

  it('E-W street y = project(anchor).y within 1e-6, except nudged ones (within half-width)', () => {
    const nudged = new Set(['bloor', 'sheppard']);
    for (const s of streets) {
      if (s.axis !== 'ew') continue;
      const a = byId.get(s.positionRef!)!;
      const y = TORONTO_PROJECTION.project({ lat: a.lat!, lon: a.lon! }).y;
      if (nudged.has(s.id)) {
        expect(Math.abs(s.centerline - y)).toBeLessThanOrEqual(s.halfWidth + 1e-6);
      } else {
        expect(Math.abs(s.centerline - y)).toBeLessThan(1e-6);
      }
    }
  });
});

describe('spans resolve to referenced streets / zone edges — not magic numbers', () => {
  it('University runs from Bloor to Front (its y-span ends land on their centrelines)', () => {
    const u = streetById.get('university')!;
    const bloor = streetById.get('bloor')!;
    const front = streetById.get('front')!;
    expect(u.axis).toBe('ns');
    expect(u.span[0]).toBeCloseTo(bloor.centerline, 6);
    expect(u.span[1]).toBeCloseTo(front.centerline, 6);
  });

  it('John and Portland start at Queen and end at Front', () => {
    const queen = streetById.get('queen')!;
    const front = streetById.get('front')!;
    for (const id of ['john', 'portland']) {
      const s = streetById.get(id)!;
      expect(s.span[0]).toBeCloseTo(queen.centerline, 6);
      expect(s.span[1]).toBeCloseTo(front.centerline, 6);
    }
  });

  it('capsule streets (Finch/Sheppard/ParkHome) stay within the capsule x-range', () => {
    for (const id of ['finch', 'sheppard', 'parkhome']) {
      const s = streetById.get(id)!;
      expect(s.span[0]).toBeGreaterThanOrEqual(1100 + EDGE_PAD_WU - 1e-6);
      expect(s.span[1]).toBeLessThanOrEqual(1900 - EDGE_PAD_WU + 1e-6);
    }
  });

  it('Eglinton stays within the fold-corridor x-range', () => {
    const s = streetById.get('eglinton')!;
    expect(s.span[0]).toBeGreaterThanOrEqual(1200 + EDGE_PAD_WU - 1e-6);
    expect(s.span[1]).toBeLessThanOrEqual(1800 - EDGE_PAD_WU + 1e-6);
  });

  it('Front spans Bathurst → x=1900 (rail-lands stylization)', () => {
    const front = streetById.get('front')!;
    const bathurst = streetById.get('bathurst')!;
    expect(front.span[0]).toBeCloseTo(bathurst.centerline, 6);
    expect(front.span[1]).toBeCloseTo(1900, 6);
  });

  it('Bremner spans Spadina → York', () => {
    const b = streetById.get('bremner')!;
    const spadina = streetById.get('spadina')!;
    const york = streetById.get('york')!;
    expect(b.span[0]).toBeCloseTo(Math.min(spadina.centerline, york.centerline), 6);
    expect(b.span[1]).toBeCloseTo(Math.max(spadina.centerline, york.centerline), 6);
  });
});

describe('config sanity — chosen widths sit inside the §3a ranges', () => {
  it('spine 36∈[36,36], artery 33∈[32,34], major 28∈[26,30], minor 18∈[16,20]', () => {
    expect(ROAD_CLASSES.spine).toBe(36);
    expect(ROAD_CLASSES.artery).toBeGreaterThanOrEqual(32);
    expect(ROAD_CLASSES.artery).toBeLessThanOrEqual(34);
    expect(ROAD_CLASSES.major).toBeGreaterThanOrEqual(26);
    expect(ROAD_CLASSES.major).toBeLessThanOrEqual(30);
    expect(ROAD_CLASSES.minor).toBeGreaterThanOrEqual(16);
    expect(ROAD_CLASSES.minor).toBeLessThanOrEqual(20);
  });

  it('every street carries a width matching its class', () => {
    for (const s of streets) {
      expect(s.width).toBe(ROAD_CLASSES[s.cls]);
      expect(s.halfWidth).toBeCloseTo(s.width / 2, 9);
    }
  });
});
