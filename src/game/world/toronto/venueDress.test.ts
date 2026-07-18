// Phase 25.7 Task 3 tests — the pure venue-dressing builder (venueDress.ts). Driven off the REAL
// resolved venue claims (frontage.ts venueClaims) so the geometry is proven against live facade
// placements, not hand-faked ones. Pins: per-kit dressing built (fine-dining = plaque, no band;
// karaoke magenta backing), fascia faces obey the D4 street + S/E-side rule, prop ids all in the
// manifest, queue survival (Tetsu/Konjiki) hugging the facade inside the sidewalk band, awning/prop
// footprints off every road ribbon + inside the polygon, determinism.
import { describe, expect, it } from 'vitest';
import { hasCityPackModel } from '../../assets/cityPackManifest';
import { DRESSING_KITS, KARAOKE_BAND_BACKING, VENUE_QUEUE } from '../../config/venueDressing';
import { SIDEWALK } from '../../config/torontoMap';
import { buildFrontage } from './frontage';
import { buildRibbons } from './roadGraph';
import { buildStreets } from './streets';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildVenueDress } from './venueDress';

const claims = buildFrontage(416).venueClaims;
const dress = buildVenueDress(claims);
const byVenue = new Map(claims.map((c) => [c.venueId, c]));

interface Aabb {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}
const ribbons: Aabb[] = buildRibbons(buildStreets().streets).map((r) => ({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }));
function pointInRibbon(x: number, z: number): boolean {
  return ribbons.some((r) => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ);
}

describe('buildVenueDress — determinism', () => {
  it('same claims → deep-equal output', () => {
    expect(buildVenueDress(claims)).toEqual(buildVenueDress(claims));
  });
});

describe('buildVenueDress — fascia bands (D4/D7)', () => {
  it('fine-dining (Alo) gets a plaque and NO fascia band', () => {
    expect(dress.plaques.map((p) => p.venueId)).toEqual(['alo']);
    expect(dress.bands.some((b) => b.venueId === 'alo')).toBe(false);
    expect(dress.bandRows.some((r) => r.venueId === 'alo')).toBe(false);
  });

  it('every fascia-present kit venue has exactly one band-atlas row', () => {
    for (const claim of claims) {
      const kit = DRESSING_KITS[claim.kitId];
      const rows = dress.bandRows.filter((r) => r.venueId === claim.venueId);
      expect(rows.length, claim.venueId).toBe(kit.fascia.present ? 1 : 0);
    }
  });

  it('every venue with a fascia carries a street band; W/N-fronting venues add a camera-visible S/E side band', () => {
    for (const claim of claims) {
      const kit = DRESSING_KITS[claim.kitId];
      if (!kit.fascia.present) continue;
      const vb = dress.bands.filter((b) => b.venueId === claim.venueId);
      expect(vb.some((b) => b.kind === 'street'), claim.venueId).toBe(true);
      const hasSide = vb.some((b) => b.kind === 'side');
      expect(hasSide, claim.venueId).toBe(claim.facing === 'west' || claim.facing === 'north');
      // Side bands must land on a camera-visible face (rotationY 0 = south, π/2 = east).
      for (const b of vb.filter((x) => x.kind === 'side')) {
        expect([0, Math.PI / 2].some((a) => Math.abs(a - b.rotationY) < 1e-9), claim.venueId).toBe(true);
      }
    }
  });

  it('all bands reference a real bandRow, and karaoke uses the magenta backing', () => {
    const rowIds = new Set(dress.bandRows.map((r) => r.bandRow));
    for (const b of dress.bands) expect(rowIds.has(b.bandRow)).toBe(true);
    const echo = dress.bandRows.find((r) => r.venueId === 'echo-karaoke');
    expect(echo?.backingColor).toBe(KARAOKE_BAND_BACKING);
  });

  it('every band vertical extent is a positive slab above ground', () => {
    for (const b of dress.bands) {
      expect(b.height).toBeGreaterThan(0);
      expect(b.cy - b.height / 2).toBeGreaterThan(0);
      expect(b.width).toBeGreaterThan(0);
    }
  });
});

describe('buildVenueDress — dressing props', () => {
  it('every prop modelId exists in the city-pack manifest', () => {
    for (const p of dress.props) expect(hasCityPackModel(p.modelId), `${p.venueId}/${p.modelId}`).toBe(true);
  });

  it('emits exactly the sum of kit prop counts across all claims', () => {
    const expected = claims.reduce((n, c) => n + DRESSING_KITS[c.kitId].props.reduce((m, s) => m + s.count, 0), 0);
    expect(dress.props.length).toBe(expected);
  });

  it('no prop lands inside a road ribbon, and every prop is inside the playable polygon', () => {
    const offRibbon: string[] = [];
    const inPoly: string[] = [];
    for (const p of dress.props) {
      const [x, , z] = p.position;
      if (pointInRibbon(x, z)) offRibbon.push(`${p.venueId}/${p.modelId}`);
      if (!pointInPolygon({ x, y: z }, PLAYABLE_POLYGON)) inPoly.push(`${p.venueId}/${p.modelId}`);
    }
    expect(offRibbon).toEqual([]);
    expect(inPoly).toEqual([]);
  });
});

describe('buildVenueDress — awnings (D6)', () => {
  it('exactly the awning-kit venues get an awning, coloured with the brand accent', () => {
    for (const claim of claims) {
      const has = dress.awnings.some((a) => a.venueId === claim.venueId);
      expect(has, claim.venueId).toBe(DRESSING_KITS[claim.kitId].awning !== null);
    }
    for (const a of dress.awnings) expect(a.color).toBe(byVenue.get(a.venueId)!.accentColor);
  });

  it("no awning's outer canopy edge pokes into a road ribbon", () => {
    for (const a of dress.awnings) {
      const ex = a.anchorX + a.outX * a.canopyDepth;
      const ez = a.anchorZ + a.outZ * a.canopyDepth;
      expect(pointInRibbon(ex, ez), a.venueId).toBe(false);
    }
  });
});

describe('buildVenueDress — queues (D11)', () => {
  it('exactly Uncle Tetsu + Konjiki-Elm keep a queue', () => {
    expect(dress.queues.map((q) => q.venueId).sort()).toEqual(['konjiki-elm', 'uncle-tetsu']);
  });

  it('each queue has the configured blob count + two end posts, and hugs the sidewalk band off the facade', () => {
    for (const q of dress.queues) {
      expect(q.blobs.length).toBe(VENUE_QUEUE.blobCount);
      expect(q.posts.length).toBe(2);
      const claim = byVenue.get(q.venueId)!;
      // Perpendicular distance of every blob from the facade footprint centre must lie inside the
      // sidewalk band (facade front sits SIDEWALK.widthWu off the ribbon; blobs sit just off the
      // front edge). Cheap check: no blob is inside a ribbon, and none is absurdly far off.
      for (const b of q.blobs) {
        expect(pointInRibbon(b.x, b.z), `${q.venueId} blob in ribbon`).toBe(false);
        const dx = b.x - claim.position[0];
        const dz = b.z - claim.position[2];
        expect(Math.hypot(dx, dz)).toBeLessThan(Math.max(claim.hx, claim.hz) + SIDEWALK.widthWu + 4);
      }
    }
  });
});
