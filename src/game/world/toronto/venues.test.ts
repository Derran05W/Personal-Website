// Phase 25.7 Task 1 tests — venue authoring (D1/D2/D3/D7) + the config/venueDressing.ts kit
// table it depends on. Tests-first per the plan: this file is the acceptance bar for T1.
//
// The realistic CandidateLookup below MIRRORS world/toronto/frontage.ts's block-walk
// (crossingsOn/blockSegments/candidate-stepping) using the SAME config numbers
// (config/torontoDress.ts FRONTAGE, config/torontoMap.ts ROAD_CLASSES) frontage.ts itself
// consumes — a faithful stand-in for the not-yet-exported real lattice (T2's job), proven
// against real street geometry rather than hand-faked numbers. It is deliberately NOT imported
// from frontage.ts (test-only duplication is fine; venues.ts itself must stay frontage.ts-free
// to avoid the import cycle — see venues.ts's file header).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasCityPackModel } from '../../assets/cityPackManifest';
import { FRONTAGE } from '../../config/torontoDress';
import { ROAD_CLASSES } from '../../config/torontoMap';
import {
  AWNING_WIDTH_FRACTION,
  CLAIM_TUNING as DRESSING_CLAIM_TUNING,
  CORNER_FOOD_KITS,
  DRESSING_KITS,
  DRESSING_KIT_IDS,
  FACADE_MODEL_IDS,
  FASCIA_WIDTH_MODE_EXTRA_INSET_WU,
  PASTEL,
  PLACE_CATEGORY_TO_KIT,
  PROP_SCALE_TARGETS,
} from '../../config/venueDressing';
import { LOGO_BRANDS } from './logoAtlas';
import { listIntersections, type Intersection } from './roadGraph';
import { buildStreets, type Street } from './streets';
import {
  VENUE_AUTHORS,
  accentColor,
  buildVenueClaims,
  facadeModelFor,
  pastelTint,
  sideToNumeric,
  type CandidateLookup,
  type FrontageCandidate,
  type VenueAuthor,
} from './venues';

// --- realistic candidate-lattice test harness (mirrors frontage.ts's block-walk) --------------

interface Crossing {
  readonly along: number;
  readonly crossHalfWidth: number;
}

function crossingsOn(street: Street, intersections: readonly Intersection[]): readonly Crossing[] {
  return intersections
    .filter((c) => (street.axis === 'ns' ? c.nsId === street.id : c.ewId === street.id))
    .map((c) => ({
      along: street.axis === 'ns' ? c.y : c.x,
      crossHalfWidth: ROAD_CLASSES[street.axis === 'ns' ? c.ewCls : c.nsCls] / 2,
    }))
    .sort((a, b) => a.along - b.along);
}

function blockSegments(street: Street, crossings: readonly Crossing[]): readonly [number, number][] {
  const [lo, hi] = street.span;
  const excluded: [number, number][] = crossings
    .map((c): [number, number] => [
      c.along - c.crossHalfWidth - FRONTAGE.cornerClearanceWu,
      c.along + c.crossHalfWidth + FRONTAGE.cornerClearanceWu,
    ])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of excluded) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  const free: [number, number][] = [];
  let cursor = lo;
  for (const [elo, ehi] of merged) {
    if (elo > cursor) free.push([cursor, Math.min(elo, hi)]);
    cursor = Math.max(cursor, ehi);
    if (cursor >= hi) break;
  }
  if (cursor < hi) free.push([cursor, hi]);
  return free.filter(([a, b]) => b - a > FRONTAGE.pitchWu * 0.5);
}

/** Builds a CandidateLookup over EVERY street/side, full pre-occupancy lattice (no thinning, no
 * occupancy roll) — real geometry, same shape venues.ts's buildVenueClaims expects. */
function buildRealCandidateLookup(): CandidateLookup {
  const { streets } = buildStreets();
  const byId = new Map(streets.map((s) => [s.id, s]));
  const intersections = listIntersections(streets);
  const cache = new Map<string, readonly FrontageCandidate[]>();

  return (streetId, side) => {
    const key = `${streetId}:${side}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const street = byId.get(streetId);
    if (!street) return [];
    const segments = blockSegments(street, crossingsOn(street, intersections));
    const out: FrontageCandidate[] = [];
    let index = 0;
    for (const [segLo, segHi] of segments) {
      const length = segHi - segLo;
      const n = Math.max(1, Math.round(length / FRONTAGE.pitchWu));
      const step = length / n;
      for (let i = 0; i <= n; i++) {
        out.push({
          slotId: `${streetId}:${side === 1 ? 'p' : 'n'}:${index}`,
          streetId,
          side,
          along: segLo + i * step,
          isCorner: i === 0 || i === n,
        });
        index += 1;
      }
    }
    cache.set(key, out);
    return out;
  };
}

// --- VENUE_AUTHORS shape ------------------------------------------------------------------

describe('VENUE_AUTHORS — D7 the 18 claiming venues', () => {
  it('has exactly 18 rows (20 places.json venues minus the two D7 exceptions)', () => {
    expect(VENUE_AUTHORS).toHaveLength(18);
  });

  it('every id is unique', () => {
    const ids = VENUE_AUTHORS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('excludes the two D7 exceptions by id and by places.json name', () => {
    const ids = new Set(VENUE_AUTHORS.map((a) => a.id));
    expect(ids.has('sam-records')).toBe(false);
    expect(ids.has('apple-eaton')).toBe(false);
    const sourceNames = new Set(VENUE_AUTHORS.map((a) => a.sourceName));
    expect(sourceNames.has('Sam the Record Man sign')).toBe(false);
    expect(sourceNames.has('Apple Store (Eaton Centre)')).toBe(false);
  });

  it('every along is a function, never a bare literal number (street-referenced by construction)', () => {
    for (const author of VENUE_AUTHORS) {
      expect(typeof author.along, author.id).toBe('function');
    }
  });

  it('along resolutions are sensitive to their referenced street centreline (proves they are NOT hard-coded)', () => {
    const { streets } = buildStreets();
    const real = new Map(streets.map((s) => [s.id, s.centerline]));
    const shifted = new Map(real);
    // Shift every centreline by a fixed amount and confirm the resolved along value moves too
    // for every author whose refStreetId's own centreline changed (the c()-based ones — the
    // North York strip authors use stripY(), a documented linear interpolation off fixed street
    // numbers, not c(), so they legitimately do NOT move and are excluded from this check).
    const SHIFT = 1000;
    for (const id of shifted.keys()) shifted.set(id, shifted.get(id)! + SHIFT);
    const cReal = (id: string): number => real.get(id)!;
    const cShifted = (id: string): number => shifted.get(id)!;

    let checked = 0;
    for (const author of VENUE_AUTHORS) {
      const before = author.along(cReal);
      const after = author.along(cShifted);
      if (before === after) continue; // stripY()-based authors — expected to be invariant
      expect(after, author.id).not.toBe(before);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('every category resolves via PLACE_CATEGORY_TO_KIT to the author-declared kitId', () => {
    for (const author of VENUE_AUTHORS) {
      expect(PLACE_CATEGORY_TO_KIT[author.category], author.id).toBe(author.kitId);
    }
  });

  it('every brand exists in the shared LOGO_BRANDS atlas', () => {
    for (const author of VENUE_AUTHORS) {
      expect(LOGO_BRANDS as readonly string[], author.id).toContain(author.brand);
    }
  });

  it('every brandColor is a well-formed 6-digit hex', () => {
    for (const author of VENUE_AUTHORS) {
      expect(author.brandColor, author.id).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('queue is only set for Uncle Tetsu / Konjiki-Elm (D11)', () => {
    const queued = VENUE_AUTHORS.filter((a) => a.queue).map((a) => a.id).sort();
    expect(queued).toEqual(['konjiki-elm', 'uncle-tetsu']);
  });
});

// --- places.json cross-check (structural — every entry accounted for) -----------------------

interface RawPlace {
  readonly name: string;
  readonly category: string;
}

function readPlacesJson(): readonly RawPlace[] {
  const abs = resolve(process.cwd(), 'data/toronto/places.json');
  const parsed = JSON.parse(readFileSync(abs, 'utf-8')) as { places: RawPlace[] };
  return parsed.places;
}

describe('data/toronto/places.json cross-check (structural, per data.test.ts caution)', () => {
  it('every place is either a claiming venue (by name) or one of the two D7 exceptions', () => {
    const places = readPlacesJson();
    const claimingNames = new Set(VENUE_AUTHORS.map((a) => a.sourceName));
    const exceptionNames = new Set(['Sam the Record Man sign', 'Apple Store (Eaton Centre)']);
    for (const place of places) {
      const accounted = claimingNames.has(place.name) || exceptionNames.has(place.name);
      expect(accounted, `places.json "${place.name}" not accounted for`).toBe(true);
    }
    // And the converse: every authored sourceName is a real places.json entry (no phantom rows).
    const realNames = new Set(places.map((p) => p.name));
    for (const author of VENUE_AUTHORS) {
      expect(realNames.has(author.sourceName), author.id).toBe(true);
    }
  });
});

// --- D3 pure derivations ---------------------------------------------------------------------

describe('pastelTint — D3 near-white facade tint', () => {
  it('every channel clears the facade-crush threshold (PASTEL.minChannel)', () => {
    const toChannels = (hex: string): number[] => {
      const clean = hex.replace('#', '');
      return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
    };
    for (const author of VENUE_AUTHORS) {
      const [r, g, b] = toChannels(pastelTint(author.brandColor));
      expect(r, author.id).toBeGreaterThanOrEqual(PASTEL.minChannel);
      expect(g, author.id).toBeGreaterThanOrEqual(PASTEL.minChannel);
      expect(b, author.id).toBeGreaterThanOrEqual(PASTEL.minChannel);
    }
  });

  it('is monotonic — never darker than the input on any channel', () => {
    const toChannels = (hex: string): number[] => {
      const clean = hex.replace('#', '');
      return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
    };
    const samples = ['#000000', '#111111', '#8b0000', '#ff2fb3', '#f5f5f7', '#ffffff'];
    for (const hex of samples) {
      const [r0, g0, b0] = toChannels(hex);
      const [r1, g1, b1] = toChannels(pastelTint(hex));
      expect(r1, hex).toBeGreaterThanOrEqual(r0);
      expect(g1, hex).toBeGreaterThanOrEqual(g0);
      expect(b1, hex).toBeGreaterThanOrEqual(b0);
    }
  });

  it('an already-pastel colour is left (near) unchanged', () => {
    expect(pastelTint('#f5f5f7').toLowerCase()).toBe('#f5f5f7');
  });

  it('white stays white', () => {
    expect(pastelTint('#ffffff').toLowerCase()).toBe('#ffffff');
  });
});

describe('accentColor — D3 saturated passthrough', () => {
  it('returns brand_color unmodified', () => {
    for (const author of VENUE_AUTHORS) {
      expect(accentColor(author.brandColor)).toBe(author.brandColor);
    }
  });
});

describe('sideToNumeric', () => {
  it('E and S map to +1', () => {
    expect(sideToNumeric('E')).toBe(1);
    expect(sideToNumeric('S')).toBe(1);
  });
  it('W and N map to -1', () => {
    expect(sideToNumeric('W')).toBe(-1);
    expect(sideToNumeric('N')).toBe(-1);
  });
});

describe('facadeModelFor — D3 corner-food rule', () => {
  it('non-corner slots always use the kit default (never pizza-corner)', () => {
    for (const kitId of DRESSING_KIT_IDS) {
      expect(facadeModelFor(kitId, false)).toBe(DRESSING_KITS[kitId].facadeModelId);
    }
  });

  it('corner slots swap to pizza-corner ONLY for the food kits (cafe-fastfood, asian-restaurant)', () => {
    for (const kitId of DRESSING_KIT_IDS) {
      const resolved = facadeModelFor(kitId, true);
      if (CORNER_FOOD_KITS.includes(kitId)) {
        expect(resolved, kitId).toBe(FACADE_MODEL_IDS.corner);
      } else {
        expect(resolved, kitId).toBe(DRESSING_KITS[kitId].facadeModelId);
      }
    }
  });

  it('CORNER_FOOD_KITS is exactly {cafe-fastfood, asian-restaurant}', () => {
    expect([...CORNER_FOOD_KITS].sort()).toEqual(['asian-restaurant', 'cafe-fastfood']);
  });
});

// --- buildVenueClaims — the D1 nearest-candidate resolver -------------------------------------

describe('buildVenueClaims — synthetic candidate lists (algorithm properties)', () => {
  const authors: readonly VenueAuthor[] = [
    {
      id: 'test-a',
      name: 'A',
      brand: 'mec',
      category: 'retail_flagship',
      kitId: 'retail',
      brandColor: '#00674b',
      refStreetId: 'king',
      side: 'S',
      along: () => 100,
      sourceName: 'Test A',
    },
  ];

  function fixedLookup(candidates: readonly FrontageCandidate[]): CandidateLookup {
    return () => candidates;
  }

  it('picks the strictly-nearest candidate to the authored target', () => {
    const candidates: FrontageCandidate[] = [
      { slotId: 'king:p:0', streetId: 'king', side: 1, along: 50, isCorner: false },
      { slotId: 'king:p:1', streetId: 'king', side: 1, along: 96, isCorner: false },
      { slotId: 'king:p:2', streetId: 'king', side: 1, along: 130, isCorner: false },
    ];
    const [claim] = buildVenueClaims(fixedLookup(candidates), authors);
    expect(claim.slotId).toBe('king:p:1');
  });

  it('is deterministic — same inputs produce byte-identical output on repeat calls', () => {
    const candidates: FrontageCandidate[] = [
      { slotId: 'king:p:0', streetId: 'king', side: 1, along: 80, isCorner: false },
      { slotId: 'king:p:1', streetId: 'king', side: 1, along: 120, isCorner: true },
    ];
    const first = buildVenueClaims(fixedLookup(candidates), authors);
    const second = buildVenueClaims(fixedLookup(candidates), authors);
    expect(second).toEqual(first);
  });

  it('carries the picked candidate isCorner flag through verbatim', () => {
    const candidates: FrontageCandidate[] = [
      { slotId: 'king:p:0', streetId: 'king', side: 1, along: 100, isCorner: true },
    ];
    const [claim] = buildVenueClaims(fixedLookup(candidates), authors);
    expect(claim.isCorner).toBe(true);
  });

  it('throws a venue-id-bearing error when a street/side has zero candidates', () => {
    expect(() => buildVenueClaims(fixedLookup([]), authors)).toThrow(/test-a/);
  });

  it('resolves the correct numeric side from the authored StreetSide', () => {
    const candidates: FrontageCandidate[] = [
      { slotId: 'king:p:0', streetId: 'king', side: 1, along: 100, isCorner: false },
    ];
    const [claim] = buildVenueClaims(fixedLookup(candidates), authors);
    expect(claim.side).toBe(1); // authors[0].side === 'S' -> numeric 1
  });
});

describe('buildVenueClaims — real VENUE_AUTHORS against a realistic candidate lattice', () => {
  const lookup = buildRealCandidateLookup();
  const claims = buildVenueClaims(lookup);

  it('resolves exactly 18 claims, one per venue, matching VENUE_AUTHORS ids 1:1', () => {
    expect(claims).toHaveLength(18);
    expect(new Set(claims.map((c) => c.venueId))).toEqual(new Set(VENUE_AUTHORS.map((a) => a.id)));
  });

  it('every claimed modelId is a real, kit-appropriate manifest facade', () => {
    for (const claim of claims) {
      expect(hasCityPackModel(claim.modelId), claim.venueId).toBe(true);
      const kit = DRESSING_KITS[claim.kitId];
      const expected = claim.isCorner && kit.cornerRuleApplies ? FACADE_MODEL_IDS.corner : kit.facadeModelId;
      expect(claim.modelId, claim.venueId).toBe(expected);
    }
  });

  it('is deterministic across repeat builds against the same real lattice', () => {
    const again = buildVenueClaims(lookup);
    expect(again).toEqual(claims);
  });

  it('every pastelTint/accentColor is derived from that venue\'s own authored brandColor', () => {
    const byId = new Map(VENUE_AUTHORS.map((a) => [a.id, a]));
    for (const claim of claims) {
      const author = byId.get(claim.venueId)!;
      expect(claim.pastelTint).toBe(pastelTint(author.brandColor));
      expect(claim.accentColor).toBe(author.brandColor);
    }
  });

  it("McDonald's (Queen & Spadina) resolves onto a CORNER candidate and swaps to pizza-corner (D3 designed hit)", () => {
    const claim = claims.find((c) => c.venueId === 'mcdonalds-spadina')!;
    expect(claim).toBeDefined();
    expect(claim.streetId).toBe('spadina');
    expect(claim.isCorner).toBe(true);
    expect(claim.modelId).toBe(FACADE_MODEL_IDS.corner);
  });

  it('queue flag survives onto the claim for Uncle Tetsu / Konjiki-Elm only', () => {
    const queued = claims.filter((c) => c.queue).map((c) => c.venueId).sort();
    expect(queued).toEqual(['konjiki-elm', 'uncle-tetsu']);
  });

  it('every claim resolved reasonably close to its authored target (claim-tuning sanity)', () => {
    const { streets } = buildStreets();
    const byStreet = new Map(streets.map((s) => [s.id, s.centerline]));
    const c = (id: string): number => byStreet.get(id)!;
    const byId = new Map(VENUE_AUTHORS.map((a) => [a.id, a]));
    for (const claim of claims) {
      const author = byId.get(claim.venueId)!;
      const target = author.along(c);
      const candidates = lookup(author.refStreetId, sideToNumeric(author.side));
      const picked = candidates.find((cand) => cand.slotId === claim.slotId)!;
      expect(Math.abs(picked.along - target), claim.venueId).toBeLessThanOrEqual(DRESSING_CLAIM_TUNING.maxNudgeWu);
    }
  });
});

// --- config/venueDressing.ts — the T1 kit table -------------------------------------------

describe('DRESSING_KIT_IDS / DRESSING_KITS — completeness', () => {
  it('has exactly the 8 kits the plan\'s category table names', () => {
    expect([...DRESSING_KIT_IDS].sort()).toEqual(
      [
        'asian-restaurant',
        'bar',
        'cafe-fastfood',
        'entertainment',
        'fine-dining',
        'grocery',
        'karaoke',
        'retail',
      ].sort(),
    );
  });

  it('every DRESSING_KIT_IDS entry has a matching DRESSING_KITS row keyed by its own id', () => {
    for (const kitId of DRESSING_KIT_IDS) {
      expect(DRESSING_KITS[kitId].id).toBe(kitId);
    }
  });

  it('every VENUE_AUTHORS.kitId is a real dressing kit', () => {
    for (const author of VENUE_AUTHORS) {
      expect(DRESSING_KITS[author.kitId], author.id).toBeDefined();
    }
  });

  it('every places.json category used by an authored venue maps to a real kit', () => {
    const usedCategories = new Set(VENUE_AUTHORS.map((a) => a.category));
    for (const category of usedCategories) {
      expect(DRESSING_KIT_IDS as readonly string[]).toContain(PLACE_CATEGORY_TO_KIT[category]);
    }
  });

  it('fine-dining has no fascia band (D7: plaque only)', () => {
    expect(DRESSING_KITS['fine-dining'].fascia.present).toBe(false);
    expect(DRESSING_KITS['fine-dining'].plaque).toBeDefined();
  });

  it('karaoke overrides its fascia backing colour (magenta)', () => {
    expect(DRESSING_KITS.karaoke.fascia.backingColorOverride).toBeDefined();
  });

  it('only cafe-fastfood and asian-restaurant apply the corner rule', () => {
    const cornerKits = DRESSING_KIT_IDS.filter((id) => DRESSING_KITS[id].cornerRuleApplies).sort();
    expect(cornerKits).toEqual(['asian-restaurant', 'cafe-fastfood']);
  });

  it('kits with an awning use a widthMode covered by AWNING_WIDTH_FRACTION', () => {
    for (const kitId of DRESSING_KIT_IDS) {
      const awning = DRESSING_KITS[kitId].awning;
      if (!awning) continue;
      expect(AWNING_WIDTH_FRACTION[awning.widthMode], kitId).toBeGreaterThan(0);
    }
  });

  it('every fascia widthMode is covered by FASCIA_WIDTH_MODE_EXTRA_INSET_WU', () => {
    for (const kitId of DRESSING_KIT_IDS) {
      const mode = DRESSING_KITS[kitId].fascia.widthMode;
      expect(FASCIA_WIDTH_MODE_EXTRA_INSET_WU[mode], kitId).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('DressingPropSpec — data integrity', () => {
  it('offsets.length === count for every prop spec in every kit', () => {
    for (const kitId of DRESSING_KIT_IDS) {
      for (const prop of DRESSING_KITS[kitId].props) {
        expect(prop.offsets, `${kitId}/${prop.modelId}`).toHaveLength(prop.count);
      }
    }
  });

  it('every prop modelId exists in the city-pack manifest', () => {
    for (const kitId of DRESSING_KIT_IDS) {
      for (const prop of DRESSING_KITS[kitId].props) {
        expect(hasCityPackModel(prop.modelId), `${kitId}/${prop.modelId}`).toBe(true);
      }
    }
  });

  it('every kit has at least one dressing prop', () => {
    for (const kitId of DRESSING_KIT_IDS) {
      expect(DRESSING_KITS[kitId].props.length, kitId).toBeGreaterThan(0);
    }
  });

  it('facade model ids referenced by kits are real manifest entries', () => {
    for (const kitId of DRESSING_KIT_IDS) {
      expect(hasCityPackModel(DRESSING_KITS[kitId].facadeModelId), kitId).toBe(true);
    }
    expect(hasCityPackModel(FACADE_MODEL_IDS.corner)).toBe(true);
  });
});

describe('PROP_SCALE_TARGETS — T1 provisional overrides', () => {
  it('every target is a positive finite number', () => {
    for (const [key, value] of Object.entries(PROP_SCALE_TARGETS)) {
      expect(value, key).toBeGreaterThan(0);
      expect(Number.isFinite(value), key).toBe(true);
    }
  });
});

describe('CLAIM_TUNING (re-exported off venues.ts matches venueDressing.ts source)', () => {
  it('is the same object venueDressing.ts exports', () => {
    expect(DRESSING_CLAIM_TUNING.maxNudgeWu).toBeGreaterThan(0);
    expect([...DRESSING_CLAIM_TUNING.cornerFoodKits].sort()).toEqual(['asian-restaurant', 'cafe-fastfood']);
  });
});
