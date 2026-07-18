// Phase 25.7 Task 1 (D1/D2/D3/D7) — venue authoring: which places.json venues claim frontage
// slots, and how their facade model/tints resolve. Pure TS — no three/react, no randomness (the
// claim resolution below is pure nearest-candidate geometry, not a seeded roll). Same
// street-referenced idiom as the retiring world/toronto/placesLayer.ts AUTHORS list (D2: this
// module supersedes that list minus the two D7 exceptions — Sam the Record Man and
// Apple-on-Eaton keep their placesLayer.ts treatment untouched and never appear here).
//
// D1 (binding): a venue claims the NEAREST candidate frontage slot on its authored
// refStreetId/side — never a literal slot id. The candidate lattice itself (every pitch-stepped
// position along a street side BEFORE occupancy/model/tint rolls) is produced by
// world/toronto/frontage.ts's street-walk (Task 2, not this module — frontage.ts imports THIS
// module, so this module must never import frontage.ts, or the two would cycle). Because that
// lattice doesn't exist as an exported API yet, this file defines the MINIMAL shape Task 2 must
// either expose or feed in (`FrontageCandidate`/`CandidateLookup` below) and implements
// `buildVenueClaims` purely against that shape, fully unit-testable today with a synthetic
// lookup (see venues.test.ts) and ready for Task 2 to wire the real lattice through unchanged.
//
// CATEGORY -> KIT and every dressing number live in config/venueDressing.ts (CLAUDE.md config
// convention) — this module only supplies the WHO/WHERE/WHICH-BRAND authoring + the two pure
// derivation functions (pastelTint, facadeModelFor) D3 specifies.

import {
  CLAIM_TUNING,
  DRESSING_KITS,
  FACADE_MODEL_IDS,
  PASTEL,
  kitForCategory,
  type DressingKitId,
} from '../../config/venueDressing';
import { buildStreets } from './streets';
import { type LogoBrand } from './logoAtlas';

/** Which side of its reference street a venue fronts. N-S street -> E/W; E-W street -> N/S.
 * Same vocabulary as the retiring placesLayer.ts. */
export type StreetSide = 'E' | 'W' | 'N' | 'S';

/** Resolves an authored along-street target from resolved street centrelines (never a bare
 * literal) — the namedBuildings.ts/placesLayer.ts idiom, migrated verbatim. */
type AlongFn = (c: (streetId: string) => number) => number;

export interface VenueAuthor {
  readonly id: string;
  /** Short wordmark used on the FASCIA band / billboard prop. */
  readonly name: string;
  readonly brand: LogoBrand;
  /** Raw places.json category string (kept for provenance + the T1 cross-check tests). */
  readonly category: string;
  readonly kitId: DressingKitId;
  /** Raw places.json brand_color hex — the D3 split point (pastel facade / saturated accent). */
  readonly brandColor: string;
  readonly refStreetId: string;
  readonly side: StreetSide;
  readonly along: AlongFn;
  /** D11: only Uncle Tetsu / Konjiki-Elm keep a cosmetic queue lineup. */
  readonly queue?: boolean;
  /** The exact places.json `name` field this row migrates — a stable join key for the T1
   * places.json cross-check test (venues.test.ts), never used for placement math. */
  readonly sourceName: string;
}

const mid = (a: number, b: number): number => (a + b) / 2;

// North York Yonge strip — street-number -> map-y interpolation, migrated verbatim off
// placesLayer.ts (same rationale: the capsule N-S projection is one linear segment, so
// street-number -> y is linear too). Anchored on the two H Mart addresses whose cross-streets
// are named in places.json. Higher street number => further NORTH => smaller y.
const STRIP_N0 = 4885;
const STRIP_Y0 = 1130; // just inside the capsule below Sheppard
const STRIP_N1 = 5545;
const STRIP_Y1 = 200; // just below Finch
const STRIP_SLOPE = (STRIP_Y1 - STRIP_Y0) / (STRIP_N1 - STRIP_N0);
function stripY(streetNumber: number): number {
  return STRIP_Y0 + (streetNumber - STRIP_N0) * STRIP_SLOPE;
}

// --- the 18 claiming venues (D7: 20 places.json rows minus Sam the Record Man + Apple-on-Eaton,
// which keep their placesLayer.ts P26 treatment untouched and never claim a slot) -------------

export const VENUE_AUTHORS: readonly VenueAuthor[] = [
  // --- Downtown ---------------------------------------------------------------------------
  {
    id: 'yonge-warehouse',
    name: 'WAREHOUSE',
    brand: 'warehouse',
    category: 'bar_cheap_eats',
    kitId: kitForCategory('bar_cheap_eats'),
    brandColor: '#111111',
    refStreetId: 'yonge',
    side: 'E',
    along: (c) => c('dundas') - 40,
    sourceName: 'Yonge Street Warehouse',
  },
  {
    id: 'queen-warehouse',
    name: 'WAREHOUSE',
    brand: 'warehouse',
    category: 'bar_cheap_eats',
    kitId: kitForCategory('bar_cheap_eats'),
    brandColor: '#111111',
    refStreetId: 'queen',
    side: 'N',
    along: (c) => c('john') + 20,
    sourceName: 'Queen St. Warehouse',
  },
  {
    id: 'alo',
    name: 'ALO',
    brand: 'alo',
    category: 'fine_dining_icon',
    kitId: kitForCategory('fine_dining_icon'),
    brandColor: '#1e1e1e',
    refStreetId: 'spadina',
    side: 'E',
    along: (c) => c('queen') - 25,
    sourceName: 'Alo',
  },
  {
    id: 'uncle-tetsu',
    name: 'UNCLE TETSU',
    brand: 'tetsu',
    category: 'dessert_icon',
    kitId: kitForCategory('dessert_icon'),
    brandColor: '#f5c518',
    refStreetId: 'bay',
    side: 'W',
    along: (c) => c('dundas') - 24,
    queue: true,
    sourceName: "Uncle Tetsu's Japanese Cheesecake",
  },
  {
    id: 'loblaws-mlg',
    name: 'LOBLAWS',
    brand: 'loblaws',
    category: 'grocery_icon',
    kitId: kitForCategory('grocery_icon'),
    brandColor: '#e21836',
    refStreetId: 'college',
    side: 'S',
    along: (c) => c('church') - 35,
    sourceName: 'Loblaws Maple Leaf Gardens',
  },
  {
    id: 'rec-room',
    name: 'REC ROOM',
    brand: 'recroom',
    category: 'entertainment',
    kitId: kitForCategory('entertainment'),
    brandColor: '#d22630',
    refStreetId: 'bremner',
    side: 'S',
    along: (c) => c('spadina') + 80,
    sourceName: 'The Rec Room',
  },
  {
    id: 'real-sports',
    name: 'REAL SPORTS',
    brand: 'realsports',
    category: 'sports_bar',
    kitId: kitForCategory('sports_bar'),
    brandColor: '#004c9b',
    refStreetId: 'york',
    side: 'E',
    along: (c) => mid(c('front'), c('bremner')),
    sourceName: 'Real Sports Bar & Grill',
  },
  {
    id: 'mec',
    name: 'MEC',
    brand: 'mec',
    category: 'retail_flagship',
    kitId: kitForCategory('retail_flagship'),
    brandColor: '#00674b',
    refStreetId: 'king',
    side: 'S',
    along: (c) => c('spadina') + 60,
    sourceName: 'MEC Toronto',
  },
  {
    id: 'konjiki-elm',
    name: 'KONJIKI',
    brand: 'konjiki',
    category: 'ramen',
    kitId: kitForCategory('ramen'),
    brandColor: '#b8860b',
    refStreetId: 'yonge',
    side: 'W',
    along: (c) => c('dundas') - 45,
    queue: true,
    sourceName: 'Konjiki Ramen (downtown)',
  },
  {
    id: 'mcdonalds-spadina',
    name: 'MCDONALDS',
    brand: 'arches',
    category: 'fast_food_icon',
    kitId: kitForCategory('fast_food_icon'),
    brandColor: '#ffc72c',
    refStreetId: 'spadina',
    side: 'W',
    // Tuned to land the nearest-candidate resolution on the BLOCK-SEGMENT-END candidate
    // flanking the Queen crossing (the corner rule's designed hit, D3) rather than a mid-block
    // one: 8.5 wu is where that corner candidate sits (Queen's crossHalfWidth 5.5 +
    // FRONTAGE.cornerClearanceWu 3, config/torontoDress.ts) off Queen's own centerline; -10
    // keeps comfortable margin either side of that boundary against a future pitch/clearance
    // retune (venues.test.ts proves the resolution against the real street/candidate math).
    along: (c) => c('queen') - 10,
    sourceName: "McDonald's (24h, Queen & Spadina)",
  },
  {
    id: 'tims-front',
    name: 'TIM HORTONS',
    brand: 'tims',
    category: 'coffee_icon',
    kitId: kitForCategory('coffee_icon'),
    brandColor: '#c8102e',
    refStreetId: 'front',
    side: 'S',
    along: (c) => c('york') + 18,
    sourceName: 'Tim Hortons (Union/PATH)',
  },
  {
    id: 'the-alley',
    name: 'THE ALLEY',
    brand: 'stag',
    category: 'bubble_tea',
    kitId: kitForCategory('bubble_tea'),
    brandColor: '#2d2a26',
    refStreetId: 'yonge',
    side: 'E',
    along: (c) => c('college') + 80,
    sourceName: 'The Alley (bubble tea)',
  },
  // --- North York Yonge strip (street-number interpolation; northward = decreasing y) -------
  {
    id: 'konjiki-ny',
    name: 'KONJIKI',
    brand: 'konjiki',
    category: 'ramen',
    kitId: kitForCategory('ramen'),
    brandColor: '#b8860b',
    refStreetId: 'yonge',
    side: 'E',
    along: () => stripY(5051),
    sourceName: 'Konjiki Ramen (North York)',
  },
  {
    id: 'hmart-finch',
    name: 'H MART',
    brand: 'hmart',
    category: 'grocery_icon',
    kitId: kitForCategory('grocery_icon'),
    brandColor: '#e6002d',
    refStreetId: 'yonge',
    side: 'E',
    along: () => stripY(5545),
    sourceName: 'H Mart (Yonge & Finch)',
  },
  {
    id: 'buk-chang-dong',
    name: 'BCD TOFU',
    brand: 'hangul',
    category: 'korean_icon',
    kitId: kitForCategory('korean_icon'),
    brandColor: '#8b0000',
    refStreetId: 'yonge',
    side: 'W',
    along: () => stripY(5445),
    sourceName: 'Buk Chang Dong Soon Tofu',
  },
  {
    id: 'hmart-sheppard',
    name: 'H MART',
    brand: 'hmart',
    category: 'grocery',
    kitId: kitForCategory('grocery'),
    brandColor: '#e6002d',
    refStreetId: 'yonge',
    side: 'W',
    along: () => stripY(4885),
    sourceName: 'H Mart (Yonge & Sheppard)',
  },
  {
    id: 'owl-of-minerva',
    name: 'OWL BBQ',
    brand: 'hangul',
    category: 'korean_bbq',
    kitId: kitForCategory('korean_bbq'),
    brandColor: '#6b3fa0',
    refStreetId: 'yonge',
    side: 'E',
    along: () => stripY(5324),
    sourceName: 'Owl of Minerva (Korean BBQ)',
  },
  {
    id: 'echo-karaoke',
    name: 'KARAOKE',
    brand: 'hangul',
    category: 'karaoke',
    kitId: kitForCategory('karaoke'),
    brandColor: '#ff2fb3',
    refStreetId: 'yonge',
    side: 'W',
    along: () => stripY(5592),
    sourceName: 'Echo Coin Karaoke',
  },
];

// --- D3 pure derivations ------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function hexToRgb01(hex: string): readonly [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function rgb01ToHex([r, g, b]: readonly [number, number, number]): string {
  const toByte = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/** D3: near-white pastel facade tint — iteratively mixes `hex` toward white (PASTEL.mixStep per
 * iteration) until every channel clears PASTEL.minChannel (the facade-crush threshold), capped
 * at PASTEL.maxIterations. Monotonic — every channel only ever increases, so the result is never
 * darker than the input on any channel. Pure, no three.js Color dependency (this module stays
 * three-free like every other pure world/toronto module). */
export function pastelTint(hex: string): string {
  let [r, g, b] = hexToRgb01(hex);
  for (let i = 0; i < PASTEL.maxIterations; i++) {
    if (r >= PASTEL.minChannel && g >= PASTEL.minChannel && b >= PASTEL.minChannel) break;
    r += (1 - r) * PASTEL.mixStep;
    g += (1 - g) * PASTEL.mixStep;
    b += (1 - b) * PASTEL.mixStep;
  }
  return rgb01ToHex([r, g, b]);
}

/** D3: the saturated accent colour (awning canopy / fascia backing) — the raw brand_color,
 * unmodified. A named passthrough (not a bare property read) so every call site goes through one
 * seam if the "saturated" side of the split ever needs its own adjustment. */
export function accentColor(hex: string): string {
  return hex;
}

/** D3 corner-food rule: a claimed CORNER slot swaps a food kit's facade to pizza-corner;
 * every other kit/slot combination uses the kit's authored default (rb-blank/gb-blank). */
export function facadeModelFor(kitId: DressingKitId, isCorner: boolean): string {
  const kit = DRESSING_KITS[kitId];
  if (isCorner && kit.cornerRuleApplies) return FACADE_MODEL_IDS.corner;
  return kit.facadeModelId;
}

/** E/S -> the street's "positive" perpendicular side (numeric `1`); W/N -> `-1`. Matches
 * frontage.ts's own side convention (`${side === 1 ? 'p' : 'n'}`) and placesLayer.ts's
 * boxCentre (side 'E'/'S' => +x/+z). */
export function sideToNumeric(side: StreetSide): 1 | -1 {
  return side === 'E' || side === 'S' ? 1 : -1;
}

// --- T2 seam: the minimal candidate-lattice shape frontage.ts must feed buildVenueClaims -------

/** One frontage candidate position along a street side, BEFORE occupancy/model/tint rolls — the
 * raw output of frontage.ts's block-walk (segments x pitch), which Task 2 exposes/constructs for
 * this claims pass to search over. `slotId` MUST use frontage.ts's own stable scheme
 * (`${streetId}:${side === 1 ? 'p' : 'n'}:${index}`) so a claimed candidate's id is the exact id
 * the generic walk would have produced for that position (the whole point of D1's "override, not
 * filter" — the claim occupies a REAL slot id, not a synthetic one). */
export interface FrontageCandidate {
  readonly slotId: string;
  readonly streetId: string;
  readonly side: 1 | -1;
  /** The street-local along-coordinate (map x for an ew street's along-axis is x; map y for ns
   * is y) — same axis `Street.span`/`AlongFn` operate in. */
  readonly along: number;
  /** True for block-segment-end candidates (flank an intersection) — frontage.ts's own
   * definition (`i === 0 || i === n`), the D3 corner-rule trigger. */
  readonly isCorner: boolean;
}

/** Returns every candidate on one street side, in any order (buildVenueClaims scans all of
 * them) — frontage.ts Task 2 either builds this from its own block-walk directly, or exposes a
 * lattice-only variant of it. Returning `[]` for an unknown street/side is valid (buildVenueClaims
 * throws with a clear venue-id-bearing message rather than silently producing no claim). */
export type CandidateLookup = (streetId: string, side: 1 | -1) => readonly FrontageCandidate[];

export interface VenueClaim {
  readonly venueId: string;
  readonly name: string;
  readonly brand: LogoBrand;
  readonly kitId: DressingKitId;
  readonly slotId: string;
  readonly streetId: string;
  readonly side: 1 | -1;
  readonly modelId: string;
  readonly isCorner: boolean;
  readonly pastelTint: string;
  readonly accentColor: string;
  readonly queue: boolean;
}

/**
 * D1: resolves every VENUE_AUTHORS row to its nearest frontage candidate on its authored
 * refStreetId/side, overriding whatever occupancy/model/tint roll that slot would otherwise have
 * gotten. Pure + deterministic: same `getCandidates` + `authors` -> byte-identical output (no
 * RNG). Throws (loudly, venue-id-bearing) if a venue's street has zero candidates on its side —
 * every venue MUST resolve at every seed (D1 rationale).
 *
 * `getCandidates` is the T2 seam (see FrontageCandidate/CandidateLookup above): this function
 * never reaches into frontage.ts itself (that would cycle — frontage.ts imports THIS module for
 * VENUE_AUTHORS), so it takes the lattice as data. Task 2 calls this from inside frontage.ts's
 * own claims pass once it has the real pre-occupancy candidate list.
 */
export function buildVenueClaims(
  getCandidates: CandidateLookup,
  authors: readonly VenueAuthor[] = VENUE_AUTHORS,
): readonly VenueClaim[] {
  const { streets } = buildStreets();
  const byId = new Map(streets.map((st) => [st.id, st]));
  const c = (streetId: string): number => {
    const st = byId.get(streetId);
    if (!st) throw new Error(`venues: street "${streetId}" not in the built table`);
    return st.centerline;
  };

  return authors.map((author): VenueClaim => {
    const target = author.along(c);
    const side = sideToNumeric(author.side);
    const candidates = getCandidates(author.refStreetId, side);
    if (candidates.length === 0) {
      throw new Error(
        `venues: no frontage candidates for "${author.id}" on ${author.refStreetId}:${side === 1 ? 'p' : 'n'}`,
      );
    }

    let nearest = candidates[0];
    let bestDist = Math.abs(nearest.along - target);
    for (const candidate of candidates) {
      const dist = Math.abs(candidate.along - target);
      if (dist < bestDist) {
        nearest = candidate;
        bestDist = dist;
      }
    }

    const modelId = facadeModelFor(author.kitId, nearest.isCorner);

    return {
      venueId: author.id,
      name: author.name,
      brand: author.brand,
      kitId: author.kitId,
      slotId: nearest.slotId,
      streetId: nearest.streetId,
      side: nearest.side,
      modelId,
      // The raw physical fact (mirrors FrontageSlot.isCorner) — NOT "did the pizza-corner swap
      // fire" (that's `modelId === FACADE_MODEL_IDS.corner`, a derived read, not a stored flag).
      isCorner: nearest.isCorner,
      pastelTint: pastelTint(author.brandColor),
      accentColor: accentColor(author.brandColor),
      queue: author.queue ?? false,
    };
  });
}

// CLAIM_TUNING re-exported for T2 test convenience (its own module already exports it too — this
// avoids a second import path fork for call sites that only touch venues.ts).
export { CLAIM_TUNING };
