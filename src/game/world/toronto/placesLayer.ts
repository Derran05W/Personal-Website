// Toronto map v2 — the places / nostalgia layer (TORONTO-MAP-SPEC-v2.md §6 vibe props, §8 Sam's
// discs + the Apple-on-Eaton tag). Phase 25.7 (Task 3) SHRANK this module: the 18 places.json
// business venues that used to drop here as small storefront boxes with §4 FASCIA sign-bands now
// CLAIM real pack-building frontage slots (world/toronto/frontage.ts venueClaims) and are dressed by
// world/toronto/venueDress.ts. What stays here is the handful of objects that were never plain
// storefronts and can't ride a claimed facade:
//   • Sam the Record Man's spinning rooftop discs — a LOW host box (discs mounted on a claimed
//     19.4 wu family facade would sit at ~25 wu, above the §5.3 eye line — config/camera.ts's
//     CAMERA_EYE_MIN_WU — and leave the frame; places.json itself says "NOT a building");
//   • the Apple-on-Eaton tag — a decal on the P24 named Eaton galleria (a named building, out of the
//     frontage-claim seam);
//   • the §6 district vibe props (Chinatown gate, rainbow crosswalk, Sugar Beach umbrellas, King
//     West patio strings, Sankofa Square screen, Queen West graffiti wall).
//
// PLACEMENTS stay street-referenced (the namedBuildings.ts idiom): every anchor is an offset off a
// resolved buildStreets() centreline, so the layout tracks the road grid and stays inside the §1
// polygon / clear of the road ribbons by construction (placesLayer.test.ts). Pure TS: no three /
// react, no randomness (a single fixed graffiti seed). Same input → deep-equal output.
//
// LOCKED "Pedestrians: none" — every prop here is COSMETIC (no colliders, no AI). Only the Sam host
// box + the Sankofa billboard box get a BUILDING collider; `buildingFootprints` is that exact set,
// and everything else contributes nothing to it (the structural proof the test pins).

import { GROUND_STACK, WALL_STACK } from '../../config/layering';
import { hGame } from './heightCurve';
import { buildNamedBuildings, type NamedBuildings } from './namedBuildings';
import { scaleAboutYonge } from './polygon';
import { scaleBaseY } from './projection';
import { buildStreets, type MapRect, type Street } from './streets';
import { type LogoBrand } from './logoAtlas';

/** Which side of its reference street a place fronts. N-S street → E/W; E-W street → N/S. */
export type StreetSide = 'E' | 'W' | 'N' | 'S';

/** A storefront/host box: world-space centre (map x → world x, map y → world z; identity swap),
 * half-extents, a §6-ish flat wall colour, and the box floor at y=0 (centre y = hy). */
export interface PlaceBox {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly color: string;
}

/** A small logo-only decal sampling the shared LOGO atlas directly (like a CROWN quad): the Apple
 * mark on the Eaton galleria's Queen-end face. (Alo's plaque moved onto its claimed facade —
 * venueDress.ts — in Phase 25.7.) */
export interface LogoDecal {
  readonly placeId: string;
  readonly brand: LogoBrand;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly rotationY: number;
  readonly size: number;
}

/** One resolved place. `kind` selects the render treatment; `box` is present for the Sam host and
 * absent for the Apple-on-Eaton tag (which reuses the existing galleria box). */
export interface PlacePlacement {
  readonly id: string;
  readonly name: string;
  readonly brand: LogoBrand;
  readonly refStreetId: string;
  readonly side: StreetSide;
  readonly kind: 'discs' | 'eatonTag';
  readonly box: PlaceBox | null;
}

/** Sam the Record Man — two neon record discs on a rooftop box, spun in useFrame. `brand` picks
 * the atlas frame (discA/discB) so the two discs read as different phases of the same spin. */
export interface DiscSign {
  readonly host: PlaceBox;
  readonly discs: readonly {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly radius: number;
    readonly brand: LogoBrand;
  }[];
}

/** Chinatown red gate spanning Spadina at Dundas: two posts + a lintel with ≥6 wu drive-under
 * clearance. Colliderless (the lintel would otherwise be an invisible ceiling; posts too). */
export interface GateProp {
  readonly posts: readonly [{ readonly x: number; readonly z: number }, { readonly x: number; readonly z: number }];
  readonly postThick: number;
  readonly postTopY: number;
  readonly lintel: { readonly minX: number; readonly maxX: number; readonly y0: number; readonly y1: number; readonly z: number };
  readonly clearance: number;
}

/** Rainbow crosswalk band across Church at ~Alexander: coloured stripes on the road surface. */
export interface CrosswalkProp {
  readonly y: number;
  readonly stripes: readonly {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
    readonly color: string;
  }[];
}

/** Sugar Beach pink umbrellas (harbourfront): a cluster of umbrella posts + disc canopies. */
export interface UmbrellaProp {
  readonly postTopY: number;
  readonly discY: number;
  readonly discR: number;
  readonly units: readonly { readonly x: number; readonly z: number }[];
}

/** King West patio string-lights: a couple of posts + a warm bright bulb-line between them. */
export interface PatioProp {
  readonly posts: readonly { readonly x: number; readonly z: number }[];
  readonly postTopY: number;
  readonly strip: { readonly minX: number; readonly maxX: number; readonly z: number; readonly y: number };
}

/** Sankofa Square screen billboard at Yonge×Dundas: a box + an animated colour-block screen face. */
export interface SankofaProp {
  readonly box: PlaceBox;
  readonly screen: { readonly cx: number; readonly cy: number; readonly cz: number; readonly rotationY: number; readonly width: number; readonly height: number };
}

/** Queen West (Rush Lane) graffiti wall: one storefront-side quad with a seeded noisy texture. */
export interface GraffitiProp {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly rotationY: number;
  readonly width: number;
  readonly height: number;
  readonly seed: string;
}

export interface PlacesLayer {
  readonly placements: readonly PlacePlacement[];
  readonly discs: DiscSign;
  readonly logoDecals: readonly LogoDecal[]; // Apple-on-Eaton
  readonly gate: GateProp;
  readonly crosswalk: CrosswalkProp;
  readonly umbrellas: UmbrellaProp;
  readonly patio: PatioProp;
  readonly sankofa: SankofaProp;
  readonly graffiti: GraffitiProp;
  /** Every footprint that gets a BUILDING collider — now just Sam's host + the Sankofa box. The
   * cosmetic props contribute nothing (the structural proof of "colliderless" the test pins). */
  readonly buildingFootprints: readonly MapRect[];
  /** Massing exclusions: buildingFootprints (+ margin) + the thin cosmetic geometry (graffiti /
   * umbrellas) filler must avoid. Fed to frontage.ts + furniture.ts. */
  readonly exclusions: readonly MapRect[];
}

// --- tunables -------------------------------------------------------------------------------
// Decal proud of the wall (no z-fight) — the `fasciaBand` rung of config/layering.ts's
// WALL_STACK (Phase 39). Was a hand-picked 0.06, which sat exactly MIN_WALL_SEP_WU above the
// CROWN decal rung with zero headroom; the ladder moved it to 0.07.
const FACE_OFFSET = WALL_STACK.fasciaBand;
const STOREFRONT_GAP = 3; // facade-to-ribbon-edge gap (wu) — inside the §5 2–4 band, > road margin
const HOST_HALF = 4; // Sam host footprint half-extent (8 wu box)
const DEFAULT_WALL = '#33343a';
const EXCLUSION_MARGIN_WU = 2; // margin around each place footprint before it excludes filler

// --- authored places -----------------------------------------------------------------------
// Only the two D7 exceptions survive the Phase 25.7 shrink (every business venue now claims a
// frontage slot in world/toronto/venues.ts). Each `along` is the along-street coordinate derived
// from a resolved street centreline — never a bare literal.

type AlongFn = (c: (id: string) => number) => number;

interface PlaceAuthor {
  readonly id: string;
  readonly name: string;
  readonly brand: LogoBrand;
  readonly refStreetId: string;
  readonly side: StreetSide;
  readonly along: AlongFn;
  readonly kind: PlacePlacement['kind'];
}

const mid = (a: number, b: number): number => (a + b) / 2;

const AUTHORS: readonly PlaceAuthor[] = [
  { id: 'sam-records', name: 'SAM', brand: 'discA', refStreetId: 'yonge', side: 'E', along: (c) => c('dundas') - 25, kind: 'discs' },
  { id: 'apple-eaton', name: 'APPLE', brand: 'apple', refStreetId: 'yonge', side: 'W', along: (c) => mid(c('queen'), c('dundas')), kind: 'eatonTag' },
];

// --- resolver -------------------------------------------------------------------------------

/** For an N-S street on side E/W, or an E-W street on side N/S, return the box centre (world x/z)
 * so its facade sits STOREFRONT_GAP off the ribbon edge on that side. */
function boxCentre(st: Street, side: StreetSide, along: number, hx: number, hz: number): { cx: number; cz: number } {
  if (st.axis === 'ns') {
    const cx = side === 'E' ? st.ribbon.maxX + STOREFRONT_GAP + hx : st.ribbon.minX - STOREFRONT_GAP - hx;
    return { cx, cz: along };
  }
  const cz = side === 'S' ? st.ribbon.maxY + STOREFRONT_GAP + hz : st.ribbon.minY - STOREFRONT_GAP - hz;
  return { cx: along, cz };
}

function footprintOf(box: PlaceBox): MapRect {
  return { minX: box.cx - box.hx, maxX: box.cx + box.hx, minY: box.cz - box.hz, maxY: box.cz + box.hz };
}
function inflate(r: MapRect, m: number): MapRect {
  return { minX: r.minX - m, minY: r.minY - m, maxX: r.maxX + m, maxY: r.maxY + m };
}

/** Resolve the whole places / nostalgia layer. Deterministic, pure. `named` (optional) supplies the
 * Eaton galleria box the Apple tag rides — defaults to buildNamedBuildings() so tests can call with
 * no args; the scene passes its already-memoized named set. */
export function buildPlacesLayer(named: NamedBuildings = buildNamedBuildings()): PlacesLayer {
  const streets = buildStreets().streets;
  const byId = new Map<string, Street>(streets.map((s) => [s.id, s]));
  const c = (id: string): number => {
    const st = byId.get(id);
    if (!st) throw new Error(`placesLayer: street "${id}" not in the built table`);
    return st.centerline;
  };
  const street = (id: string): Street => {
    const st = byId.get(id);
    if (!st) throw new Error(`placesLayer: street "${id}" not in the built table`);
    return st;
  };

  const placements: PlacePlacement[] = [];
  const buildingFootprints: MapRect[] = [];
  const logoDecals: LogoDecal[] = [];
  let discSign: DiscSign | null = null;

  for (const a of AUTHORS) {
    const st = street(a.refStreetId);
    const along = a.along(c);

    if (a.kind === 'eatonTag') {
      // Apple mark on the existing Eaton galleria's Queen-end (south) face — no new box.
      const eaton = named.placements.find((p) => p.id === 'eaton-centre-galleria');
      if (!eaton) throw new Error('placesLayer: eaton-centre-galleria not found for the Apple tag');
      const box = eaton.boxes[0];
      logoDecals.push({
        placeId: a.id,
        brand: a.brand,
        cx: box.cx,
        cy: 6, // low on the Queen St face — street-level, far under the §5.3 eye line (22.05 wu)
        cz: box.cz + box.hz + FACE_OFFSET,
        rotationY: 0,
        size: 7,
      });
      placements.push({ id: a.id, name: a.name, brand: a.brand, refStreetId: a.refStreetId, side: a.side, kind: a.kind, box: null });
      continue;
    }

    // discs — Sam the Record Man: a LOW rooftop host box + two neon discs above it (spun in-scene).
    // Host kept low (hGame(6) → ~6 wu, discs topping out ~12 wu) so the whole sign sits well inside
    // the frame under the shipped rig E: the camera looks DOWN 58° from an eye at
    // CAMERA_EYE_MIN_WU (22.05 wu above the car, config/camera.ts), so signage mounted much higher
    // than that leaves the frame upward and reads as roofline clutter at best. (This comment used to
    // cite a "~13.8 wu camera wall" from the long-dead TDD baseDist-18 rig — Phase 35 replaced that
    // stale doctrine with the derived constant; the hosting decision itself is unchanged and still
    // correct, since 12 wu clears the eye line by a wide margin either way.)
    const { cx, cz } = boxCentre(st, a.side, along, HOST_HALF, HOST_HALF);
    const host: PlaceBox = { cx, cz, hx: HOST_HALF, hy: hGame(6) / 2, hz: HOST_HALF, color: DEFAULT_WALL };
    const roofY = host.hy * 2;
    const radius = 3; // 6 wu discs
    discSign = {
      host,
      discs: [
        { x: host.cx - 3.6, y: roofY + radius, z: host.cz + host.hz + FACE_OFFSET, radius, brand: 'discA' },
        { x: host.cx + 3.6, y: roofY + radius, z: host.cz + host.hz + FACE_OFFSET, radius, brand: 'discB' },
      ],
    };
    buildingFootprints.push(footprintOf(host));
    placements.push({ id: a.id, name: a.name, brand: a.brand, refStreetId: a.refStreetId, side: a.side, kind: a.kind, box: host });
  }

  if (!discSign) throw new Error('placesLayer: Sam the Record Man disc sign not authored');

  // --- vibe props (§6 column 4 — cheap wins) ------------------------------------------------
  const spadina = street('spadina');
  const church = street('church');

  // Chinatown red gate spanning Spadina at Dundas — posts straddle the ribbon, lintel above with
  // ≥6 wu drive-under clearance. Colliderless (never a ceiling the car can hit).
  const gateZ = c('dundas');
  const gatePostTopY = 8.5;
  const gateClearance = 6.5; // ≥6 wu drive-under (§6 / plan): the lintel bottom sits here
  const gate: GateProp = {
    posts: [
      { x: spadina.ribbon.minX - 2, z: gateZ },
      { x: spadina.ribbon.maxX + 2, z: gateZ },
    ],
    postThick: 1.4,
    postTopY: gatePostTopY,
    lintel: { minX: spadina.ribbon.minX - 3, maxX: spadina.ribbon.maxX + 3, y0: gateClearance, y1: gatePostTopY, z: gateZ },
    clearance: gateClearance,
  };

  // Rainbow crosswalk across Church at ~Alexander (Church-Wellesley, just north of College).
  const crossZ = c('college') - 40;
  const crossColors = ['#e40303', '#ff8c00', '#ffed00', '#008026', '#004dff', '#750787'];
  const stripeW = 1.5;
  const crosswalk: CrosswalkProp = {
    // `placesRoadArt` rung of the Phase 39 ladder. Was 0.03 — an EXACT tie with SKID.yOffset,
    // so braking over the rainbow tore it. Skids now sit a rung above and paint over it.
    y: GROUND_STACK.placesRoadArt,
    stripes: crossColors.map((color, i) => ({
      minX: church.ribbon.minX,
      maxX: church.ribbon.maxX,
      minZ: crossZ - (crossColors.length * stripeW) / 2 + i * stripeW,
      maxZ: crossZ - (crossColors.length * stripeW) / 2 + (i + 1) * stripeW,
      color,
    })),
  };

  // Sugar Beach pink umbrellas — a small harbourfront cluster (open ground, well N of the water).
  // Part-8 (D2): BASE anchor (2050, 3480) re-derived via scaleAboutYonge/scaleBaseY — the
  // per-unit spread offsets below (±4..9 wu) are cluster art direction, not map geometry, so they
  // stay absolute.
  const umbCx = scaleAboutYonge(2050);
  const umbCz = scaleBaseY(3480);
  const umbrellas: UmbrellaProp = {
    postTopY: 3.6,
    discY: 4.0,
    discR: 2.4,
    units: [
      { x: umbCx, z: umbCz },
      { x: umbCx + 8, z: umbCz - 5 },
      { x: umbCx - 7, z: umbCz + 4 },
      { x: umbCx + 5, z: umbCz + 8 },
      { x: umbCx - 4, z: umbCz - 9 },
    ],
  };

  // King West patio string-lights — a couple of posts + a warm bulb-line just N of King.
  const king = street('king');
  const patioX = scaleAboutYonge(326); // mid Bathurst–Spadina (Part-8 D2: BASE literal re-derived)
  const patioZ = king.ribbon.minY - 6; // north side, off the ribbon
  const patio: PatioProp = {
    posts: [
      { x: patioX - 10, z: patioZ },
      { x: patioX, z: patioZ },
      { x: patioX + 10, z: patioZ },
    ],
    postTopY: 4.2,
    strip: { minX: patioX - 10, maxX: patioX + 10, z: patioZ, y: 4.0 },
  };

  // Sankofa Square screen billboard at Yonge×Dundas (SE of the intersection).
  const sankofaCx = c('yonge') + 55;
  const sankofaCz = c('dundas') + 22;
  const sankofaBox: PlaceBox = { cx: sankofaCx, cz: sankofaCz, hx: 6, hy: hGame(14) / 2, hz: 6, color: '#1c1e26' };
  buildingFootprints.push(footprintOf(sankofaBox));
  const sankofa: SankofaProp = {
    box: sankofaBox,
    screen: { cx: sankofaBox.cx, cy: sankofaBox.hy * 2 * 0.66, cz: sankofaBox.cz + sankofaBox.hz + FACE_OFFSET, rotationY: 0, width: sankofaBox.hx * 2 * 0.9, height: sankofaBox.hy * 2 * 0.5 },
  };

  // Queen West (Rush Lane) graffiti wall — a south-facing quad off Queen between Portland & Spadina.
  // Part-8 (D2): BASE literal re-derived via scaleAboutYonge (the wall's own 24 wu width is art
  // direction, not map geometry, so it stays absolute).
  const graffitiX = scaleAboutYonge(418);
  const graffiti: GraffitiProp = {
    cx: graffitiX,
    cy: 3.5,
    cz: c('queen') - 30,
    rotationY: 0,
    width: 24,
    height: 6,
    seed: 'rush-lane-graffiti',
  };

  const exclusions = buildingFootprints.map((r) => inflate(r, EXCLUSION_MARGIN_WU));
  // Keep filler off the graffiti wall + umbrella cluster too (thin cosmetic geometry the frontage
  // filter might otherwise place a box through). Not colliders — exclusions only.
  exclusions.push(
    inflate({ minX: graffitiX - graffiti.width / 2, maxX: graffitiX + graffiti.width / 2, minY: graffiti.cz - 1, maxY: graffiti.cz + 1 }, EXCLUSION_MARGIN_WU),
    inflate({ minX: umbCx - 12, maxX: umbCx + 12, minY: umbCz - 12, maxY: umbCz + 12 }, 0),
  );

  return {
    placements,
    discs: discSign,
    logoDecals,
    gate,
    crosswalk,
    umbrellas,
    patio,
    sankofa,
    graffiti,
    buildingFootprints,
    exclusions,
  };
}
