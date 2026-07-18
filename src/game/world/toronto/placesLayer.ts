// Toronto map v2 — the places / nostalgia layer (TORONTO-MAP-SPEC-v2.md §4 FASCIA mode, §6 vibe
// props, §8 places layer + Sam's discs; phase-26-plan Task 3). The FINAL Part-7 content pass: the
// 20 data/toronto/places.json venues dropped onto the map as small storefront boxes with §4 FASCIA
// sign-bands, plus the "highest nostalgia-per-vertex" objects — the Uncle Tetsu / Konjiki-Elm
// lineups, Sam the Record Man's spinning rooftop discs — and a handful of §6 district vibe props
// (Chinatown gate, rainbow crosswalk, Sugar Beach umbrellas, King West patio strings, Sankofa
// Square screen, Queen West graffiti wall).
//
// PLACEMENTS are street-referenced, exactly the namedBuildings.ts idiom: every address in
// places.json sits on an already-anchored street, so each venue's centre is an offset off a
// resolved buildStreets() centreline (+ a side of that street), NOT a bare literal coordinate. The
// whole layout therefore tracks the road grid and stays inside the §1 polygon / clear of the road
// ribbons by construction (asserted in placesLayer.test.ts). Approximate BY DESIGN — this is a
// nostalgia layer, not survey data (plan Decision row).
//
// LOCKED "Pedestrians: none" — the queue lineups are COSMETIC PROPS, never gameplay entities: no
// colliders, no AI, no interaction (plan Decision row; §6's own prop column lists "queues" and
// "suit-dots" as props, so this is spec-internal-consistent, not a relitigation of the lock). The
// module tags every collider-bearing footprint in `buildingFootprints`; everything else (queues,
// gate, crosswalk, umbrellas, patio, graffiti) contributes nothing there — the structural proof of
// "colliderless" the test pins.
//
// Pure TS: no three / react, no randomness (a single fixed graffiti seed). Same input → deep-equal
// output. The scene (TorontoScene.tsx PlacesLayer) consumes this and bakes the FASCIA band atlas /
// disc textures / screen animation; jsdom-unsafe canvas work stays out of here, same split as
// namedBuildings.ts (pure) ↔ NamedBuildingsLayer (scene).

import { hGame } from './heightCurve';
import { buildNamedBuildings, type NamedBuildings } from './namedBuildings';
import { buildStreets, type MapRect, type Street } from './streets';
import { type LogoBrand } from './logoAtlas';

/** The two camera-visible faces (§4 FASCIA / Addendum A.2 fixed-bearing, pinned S/E — the same
 * pair every CROWN decal uses; map north = −Z, camera at +x/+z looking toward −x/−z). */
export type DecalFace = 'south' | 'east';
/** Which side of its reference street a place fronts. N-S street → E/W; E-W street → N/S. */
export type StreetSide = 'E' | 'W' | 'N' | 'S';

/** A storefront box: world-space centre (map x → world x, map y → world z; identity swap),
 * half-extents, a §6-ish flat wall colour, and the box floor at y=0 (centre y = hy). */
export interface PlaceBox {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly color: string;
}

/** A §4 FASCIA sign-band on one camera-visible face: a full-width strip 3.5–5 wu above ground,
 * logo cell left + pixel/name text right (the scene bakes it into a shared band atlas, one row per
 * place → `bandRow`). Position/rotation follow the CROWN decalTransform convention (south = +Z
 * front, east = +X yawed +90°). */
export interface FasciaBand {
  readonly placeId: string;
  readonly bandRow: number;
  readonly face: DecalFace;
  readonly cx: number;
  /** Band vertical centre (world y); the band spans [cy - height/2, cy + height/2] ⊆ [3.5, 5]. */
  readonly cy: number;
  readonly cz: number;
  readonly rotationY: number;
  readonly width: number;
  readonly height: number;
}

/** A small logo-only decal that samples the shared LOGO atlas directly (like a CROWN quad): the
 * Apple mark on the Eaton galleria's Queen-end face and Alo's deliberately-tiny plaque. */
export interface LogoDecal {
  readonly placeId: string;
  readonly brand: LogoBrand;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly rotationY: number;
  readonly size: number;
}

/** One resolved place. `kind` selects the render treatment; `box` is present for everything except
 * the Apple-on-Eaton tag (which reuses the existing galleria box). */
export interface PlacePlacement {
  readonly id: string;
  readonly name: string;
  readonly brand: LogoBrand;
  readonly refStreetId: string;
  readonly side: StreetSide;
  readonly recognizability: number;
  readonly kind: 'storefront' | 'discs' | 'plaque' | 'eatonTag';
  readonly box: PlaceBox | null;
  readonly fascias: readonly FasciaBand[];
}

/** A cosmetic queue lineup (Uncle Tetsu / Konjiki-Elm): rope posts + ≤1 wu person-blobs. NO
 * colliders, NO AI — the locked "Pedestrians: none" decision governs entities; this is a prop. */
export interface QueueProp {
  readonly placeId: string;
  readonly posts: readonly { readonly x: number; readonly z: number }[];
  readonly blobs: readonly { readonly x: number; readonly z: number }[];
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
  readonly queues: readonly QueueProp[];
  readonly discs: DiscSign;
  readonly logoDecals: readonly LogoDecal[]; // Apple-on-Eaton + Alo plaque
  readonly gate: GateProp;
  readonly crosswalk: CrosswalkProp;
  readonly umbrellas: UmbrellaProp;
  readonly patio: PatioProp;
  readonly sankofa: SankofaProp;
  readonly graffiti: GraffitiProp;
  /** Every footprint that gets a BUILDING collider (storefront boxes + Sam's host + Sankofa box).
   * The cosmetic props (queues/gate/crosswalk/umbrellas/patio/graffiti) are NOT here — the
   * structural proof of "colliderless" (test) and the exact set that becomes fixed colliders. */
  readonly buildingFootprints: readonly MapRect[];
  /** Massing exclusions: buildingFootprints (+ margin) — filler must avoid every place box so a
   * storefront never collides with a generated block (fed to buildMassing alongside named). */
  readonly exclusions: readonly MapRect[];
}

// --- tunables -------------------------------------------------------------------------------
const FASCIA_BOTTOM_Y = 3.5; // §4: band 3.5–5 wu above ground
const FASCIA_TOP_Y = 5.0;
const FASCIA_CY = (FASCIA_BOTTOM_Y + FASCIA_TOP_Y) / 2; // 4.25 — band vertical centre
const FASCIA_H = FASCIA_TOP_Y - FASCIA_BOTTOM_Y; // 1.5 — band thickness
const FACE_OFFSET = 0.06; // decal proud of the wall (no z-fight)

const STOREFRONT_GAP = 3; // facade-to-ribbon-edge gap (wu) — inside the §5 2–4 band, > road margin
const STOREFRONT_HALF = 4; // default footprint half-extent (8 wu box)
const GROCERY_HALF = 6; // H Mart / Loblaws read as bigger boxes
const STOREFRONT_REAL_M = 14; // 3–4 storeys → hGame ≈ 9.96 wu tall (fascia band clears the roof)
const GROCERY_REAL_M = 16;

const EXCLUSION_MARGIN_WU = 2; // margin around each place footprint before it excludes filler

// North York Yonge strip — street-number → map-y interpolation. The capsule N-S projection is a
// single linear segment (Finch→Sheppard, §2), so street-number → y is linear too. Anchor it on the
// two H Mart addresses whose cross-streets are named in places.json: 4885 Yonge ("Yonge &
// Sheppard", near the capsule/fold seam y≈1170) and 5545 Yonge ("Yonge & Finch", near the capsule
// top y≈170). Higher street number ⇒ further NORTH ⇒ smaller y (the ordering the test pins).
const STRIP_N0 = 4885;
const STRIP_Y0 = 1130; // just inside the capsule below Sheppard
const STRIP_N1 = 5545;
const STRIP_Y1 = 200; // just below Finch
const STRIP_SLOPE = (STRIP_Y1 - STRIP_Y0) / (STRIP_N1 - STRIP_N0);
function stripY(streetNumber: number): number {
  return STRIP_Y0 + (streetNumber - STRIP_N0) * STRIP_SLOPE;
}

// --- authored places -----------------------------------------------------------------------
// Each `along` is the along-street coordinate (map y for an N-S ref street, map x for an E-W ref
// street), derived from resolved street centrelines — never a bare literal. `side` picks which
// side of the reference street the storefront sits on (and thus the ribbon edge it hugs).

type AlongFn = (c: (id: string) => number) => number;

interface PlaceAuthor {
  readonly id: string;
  readonly name: string;
  readonly brand: LogoBrand;
  readonly refStreetId: string;
  readonly side: StreetSide;
  readonly along: AlongFn;
  readonly recognizability: number;
  readonly kind: PlacePlacement['kind'];
  readonly grocery?: boolean;
  readonly queue?: boolean;
}

const mid = (a: number, b: number): number => (a + b) / 2;

const AUTHORS: readonly PlaceAuthor[] = [
  // --- Downtown -----------------------------------------------------------------------------
  { id: 'yonge-warehouse', name: 'WAREHOUSE', brand: 'warehouse', refStreetId: 'yonge', side: 'E', along: (c) => c('dundas') - 40, recognizability: 3, kind: 'storefront' },
  { id: 'queen-warehouse', name: 'WAREHOUSE', brand: 'warehouse', refStreetId: 'queen', side: 'N', along: (c) => c('john') + 20, recognizability: 2, kind: 'storefront' },
  { id: 'alo', name: 'ALO', brand: 'alo', refStreetId: 'spadina', side: 'E', along: (c) => c('queen') - 25, recognizability: 2, kind: 'plaque' },
  { id: 'uncle-tetsu', name: 'UNCLE TETSU', brand: 'tetsu', refStreetId: 'bay', side: 'W', along: (c) => c('dundas') - 24, recognizability: 3, kind: 'storefront', queue: true },
  { id: 'loblaws-mlg', name: 'LOBLAWS', brand: 'loblaws', refStreetId: 'college', side: 'S', along: (c) => c('church') - 35, recognizability: 3, kind: 'storefront', grocery: true },
  { id: 'rec-room', name: 'REC ROOM', brand: 'recroom', refStreetId: 'bremner', side: 'S', along: (c) => c('spadina') + 80, recognizability: 2, kind: 'storefront' },
  { id: 'real-sports', name: 'REAL SPORTS', brand: 'realsports', refStreetId: 'york', side: 'E', along: (c) => mid(c('front'), c('bremner')), recognizability: 3, kind: 'storefront' },
  { id: 'mec', name: 'MEC', brand: 'mec', refStreetId: 'king', side: 'S', along: (c) => c('spadina') + 60, recognizability: 2, kind: 'storefront' },
  { id: 'sam-records', name: 'SAM', brand: 'discA', refStreetId: 'yonge', side: 'E', along: (c) => c('dundas') - 25, recognizability: 3, kind: 'discs' },
  { id: 'apple-eaton', name: 'APPLE', brand: 'apple', refStreetId: 'yonge', side: 'W', along: (c) => mid(c('queen'), c('dundas')), recognizability: 3, kind: 'eatonTag' },
  { id: 'konjiki-elm', name: 'KONJIKI', brand: 'konjiki', refStreetId: 'yonge', side: 'W', along: (c) => c('dundas') - 45, recognizability: 2, kind: 'storefront', queue: true },
  { id: 'mcdonalds-spadina', name: 'MCDONALDS', brand: 'arches', refStreetId: 'spadina', side: 'W', along: (c) => c('queen') - 24, recognizability: 3, kind: 'storefront' },
  { id: 'tims-front', name: 'TIM HORTONS', brand: 'tims', refStreetId: 'front', side: 'S', along: (c) => c('york') + 18, recognizability: 3, kind: 'storefront' },
  { id: 'the-alley', name: 'THE ALLEY', brand: 'stag', refStreetId: 'yonge', side: 'E', along: (c) => c('college') + 80, recognizability: 2, kind: 'storefront' },
  // --- North York Yonge strip (street-number interpolation; northward = decreasing y) ---------
  { id: 'konjiki-ny', name: 'KONJIKI', brand: 'konjiki', refStreetId: 'yonge', side: 'E', along: () => stripY(5051), recognizability: 3, kind: 'storefront' },
  { id: 'hmart-finch', name: 'H MART', brand: 'hmart', refStreetId: 'yonge', side: 'E', along: () => stripY(5545), recognizability: 3, kind: 'storefront', grocery: true },
  { id: 'buk-chang-dong', name: 'BCD TOFU', brand: 'hangul', refStreetId: 'yonge', side: 'W', along: () => stripY(5445), recognizability: 3, kind: 'storefront' },
  { id: 'hmart-sheppard', name: 'H MART', brand: 'hmart', refStreetId: 'yonge', side: 'W', along: () => stripY(4885), recognizability: 2, kind: 'storefront', grocery: true },
  { id: 'owl-of-minerva', name: 'OWL BBQ', brand: 'hangul', refStreetId: 'yonge', side: 'E', along: () => stripY(5324), recognizability: 2, kind: 'storefront' },
  { id: 'echo-karaoke', name: 'KARAOKE', brand: 'hangul', refStreetId: 'yonge', side: 'W', along: () => stripY(5592), recognizability: 2, kind: 'storefront' },
];

// Storefront wall colours — a muted §6-ish palette keyed loosely to each brand family, kept
// distinct from the §4 named-tower fills so the strip reads as small retail, not skyline.
const BRAND_WALL: Partial<Record<LogoBrand, string>> = {
  warehouse: '#2b2b2f',
  tetsu: '#3a3320',
  loblaws: '#4a2f30',
  recroom: '#40282b',
  realsports: '#2a3550',
  mec: '#25382f',
  konjiki: '#39301c',
  arches: '#4a3a1c',
  tims: '#43242a',
  stag: '#2c2a26',
  hmart: '#4a2126',
  hangul: '#3d2323',
  alo: '#2a2a2a',
};
const DEFAULT_WALL = '#33343a';

const STRIP_DECAL_FACES: readonly DecalFace[] = ['south', 'east'];

// --- resolver -------------------------------------------------------------------------------

/** For an N-S street on side E/W, or an E-W street on side N/S, return the storefront box centre
 * (world x/z) so its facade sits STOREFRONT_GAP off the ribbon edge on that side. */
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

/** S + E FASCIA bands for a storefront box (§4 full-width band, both camera-visible faces). */
function fasciasFor(placeId: string, bandRow: number, box: PlaceBox): FasciaBand[] {
  return STRIP_DECAL_FACES.map((face) =>
    face === 'south'
      ? {
          placeId,
          bandRow,
          face,
          cx: box.cx,
          cy: FASCIA_CY,
          cz: box.cz + box.hz + FACE_OFFSET,
          rotationY: 0,
          width: box.hx * 2,
          height: FASCIA_H,
        }
      : {
          placeId,
          bandRow,
          face,
          cx: box.cx + box.hx + FACE_OFFSET,
          cy: FASCIA_CY,
          cz: box.cz,
          rotationY: Math.PI / 2,
          width: box.hz * 2,
          height: FASCIA_H,
        },
  );
}

/** A short staggered double-file lineup along the storefront's street-facing edge (cosmetic). */
function buildQueue(placeId: string, box: PlaceBox, side: StreetSide): QueueProp {
  const nBlobs = 7;
  const spacing = 1.2;
  const blobs: { x: number; z: number }[] = [];
  const posts: { x: number; z: number }[] = [];
  // The lineup runs PARALLEL to the storefront front, just off the street-facing edge.
  if (side === 'E' || side === 'W') {
    // N-S street: front faces ±x; queue runs along z just outside the front edge.
    const frontX = side === 'E' ? box.cx - box.hx - 0.6 : box.cx + box.hx + 0.6;
    const z0 = box.cz - (nBlobs - 1) * spacing * 0.5;
    for (let i = 0; i < nBlobs; i++) {
      blobs.push({ x: frontX + (i % 2 === 0 ? 0 : 0.7) * (side === 'E' ? -1 : 1), z: z0 + i * spacing });
    }
    posts.push({ x: frontX, z: z0 - 0.8 }, { x: frontX, z: z0 + nBlobs * spacing });
  } else {
    const frontZ = side === 'N' ? box.cz + box.hz + 0.6 : box.cz - box.hz - 0.6;
    const x0 = box.cx - (nBlobs - 1) * spacing * 0.5;
    for (let i = 0; i < nBlobs; i++) {
      blobs.push({ x: x0 + i * spacing, z: frontZ + (i % 2 === 0 ? 0 : 0.7) * (side === 'N' ? 1 : -1) });
    }
    posts.push({ x: x0 - 0.8, z: frontZ }, { x: x0 + nBlobs * spacing, z: frontZ });
  }
  return { placeId, posts, blobs };
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
  const queues: QueueProp[] = [];
  const buildingFootprints: MapRect[] = [];
  const logoDecals: LogoDecal[] = [];
  let bandRow = 0;
  let discSign: DiscSign | null = null;

  for (const a of AUTHORS) {
    const st = street(a.refStreetId);
    const along = a.along(c);

    if (a.kind === 'eatonTag') {
      // Apple mark on the existing Eaton galleria's Queen-end (south) face — no new box.
      const eaton = named.placements.find((p) => p.id === 'eaton-centre-galleria');
      if (!eaton) throw new Error('placesLayer: eaton-centre-galleria not found for the Apple tag');
      const box = eaton.boxes[0];
      const size = 7;
      logoDecals.push({
        placeId: a.id,
        brand: a.brand,
        cx: box.cx,
        cy: 6, // low on the Queen St face — in the §5.3 camera's visible band (see disc note)
        cz: box.cz + box.hz + FACE_OFFSET,
        rotationY: 0,
        size,
      });
      placements.push({ id: a.id, name: a.name, brand: a.brand, refStreetId: a.refStreetId, side: a.side, recognizability: a.recognizability, kind: a.kind, box: null, fascias: [] });
      continue;
    }

    const grocery = a.grocery ?? false;
    const half = grocery ? GROCERY_HALF : STOREFRONT_HALF;
    const realM = grocery ? GROCERY_REAL_M : STOREFRONT_REAL_M;
    const hx = half;
    const hz = half;
    const { cx, cz } = boxCentre(st, a.side, along, hx, hz);
    const box: PlaceBox = { cx, cz, hx, hy: hGame(realM) / 2, hz, color: BRAND_WALL[a.brand] ?? DEFAULT_WALL };

    buildingFootprints.push(footprintOf(box));

    if (a.kind === 'discs') {
      // Sam the Record Man — a 2-storey rooftop host box + two neon discs above it (spun in-scene).
      // Host kept low (~6 wu) so the discs above it sit in the §5.3 camera's visible band (the
      // camera looks DOWN ~50° and can never frame anything above its own ~13.8 wu height — the
      // documented "camera wall"; a true skyscraper-height sign would be geometrically invisible).
      const hostM = 6;
      const host: PlaceBox = { ...box, hy: hGame(hostM) / 2 };
      const roofY = host.hy * 2;
      const radius = 3; // 6 wu discs
      discSign = {
        host,
        discs: [
          { x: host.cx - 3.6, y: roofY + radius, z: host.cz + host.hz + FACE_OFFSET, radius, brand: 'discA' },
          { x: host.cx + 3.6, y: roofY + radius, z: host.cz + host.hz + FACE_OFFSET, radius, brand: 'discB' },
        ],
      };
      // Replace the footprint we just pushed (default-height box) with the host's.
      buildingFootprints[buildingFootprints.length - 1] = footprintOf(host);
      placements.push({ id: a.id, name: a.name, brand: a.brand, refStreetId: a.refStreetId, side: a.side, recognizability: a.recognizability, kind: a.kind, box: host, fascias: [] });
      continue;
    }

    if (a.kind === 'plaque') {
      // Alo — the joke IS how subtle it is: a tiny plaque decal, no full FASCIA band.
      const size = 1.6;
      const eastX = box.cx + box.hx + FACE_OFFSET;
      logoDecals.push({ placeId: a.id, brand: a.brand, cx: eastX, cy: FASCIA_CY, cz: box.cz, rotationY: Math.PI / 2, size });
      placements.push({ id: a.id, name: a.name, brand: a.brand, refStreetId: a.refStreetId, side: a.side, recognizability: a.recognizability, kind: a.kind, box, fascias: [] });
      continue;
    }

    // storefront — full-width S + E FASCIA bands.
    const fascias = fasciasFor(a.id, bandRow++, box);
    placements.push({ id: a.id, name: a.name, brand: a.brand, refStreetId: a.refStreetId, side: a.side, recognizability: a.recognizability, kind: a.kind, box, fascias });
    if (a.queue) queues.push(buildQueue(a.id, box, a.side));
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
    y: 0.03,
    stripes: crossColors.map((color, i) => ({
      minX: church.ribbon.minX,
      maxX: church.ribbon.maxX,
      minZ: crossZ - (crossColors.length * stripeW) / 2 + i * stripeW,
      maxZ: crossZ - (crossColors.length * stripeW) / 2 + (i + 1) * stripeW,
      color,
    })),
  };

  // Sugar Beach pink umbrellas — a small harbourfront cluster (open ground, well N of the water).
  const umbCx = 2050;
  const umbCz = 3480;
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
  const patioX = 326; // mid Bathurst–Spadina
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
  const graffitiX = 418;
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
  // Keep filler off the graffiti wall + umbrella cluster + patio too (thin cosmetic geometry the
  // frontage filter might otherwise place a box through). Not colliders — exclusions only.
  exclusions.push(
    inflate({ minX: graffitiX - graffiti.width / 2, maxX: graffitiX + graffiti.width / 2, minY: graffiti.cz - 1, maxY: graffiti.cz + 1 }, EXCLUSION_MARGIN_WU),
    inflate({ minX: umbCx - 12, maxX: umbCx + 12, minY: umbCz - 12, maxY: umbCz + 12 }, 0),
  );

  return {
    placements,
    queues,
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
