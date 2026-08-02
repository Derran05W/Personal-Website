// Phase 48 (Part 11) — THE FINANCIAL-DISTRICT CROWN PASS: the six Bay Street bank towers as six
// DISTINGUISHABLE buildings, through the Phase-46 `namedGeometryBuilders` seam.
//
// WHAT THIS FILE IS ANSWERING. Addendum A.3 ruled in 2026-07-17 that "bank towers = plain boxes +
// crown decal — their identity is colour + height + logo, not silhouette", and Phase 24 shipped
// exactly that. Phase 38 then MEASURED, under the shipped rig E, what the player can actually see:
// the crown-decal band projects to NDC-Y 4.2–16 (i.e. metres above the top of the frame) at every
// legal vantage, and no roofline is in frame from any vantage at all. So on the shipped camera the
// A.3 identity triple reduces to COLOUR alone — six towers that differ only in a logo nobody can
// see and a silhouette nobody can see are six identical boxes. This module buys the distinction
// back where the frame actually is: the bottom ~20 wu of each tower.
//
// THE SPEND RULE, therefore, and it governs every proportion below: triangles go BELOW the eye
// line, most of them below ~12 wu — podium, colonnade, entrance, base articulation, the first two
// registers of the shaft. Crown geometry still ships, because it is what the minimap silhouette and
// every off-rig marketing frame read, but it is a few dozen triangles per tower, never hundreds.
//
// THE CROWN-BAND KEEP-OUT. Every one of these six placements carries a §4 CROWN logo decal on its
// south and east faces, at `bandCenterFrac` of the RENDER box height (TorontoScene's
// `decalTransform`). A pier, band or sawtooth standing proud of those two faces inside that band
// would slice the logo. `crownKeepOutBand()` below computes the band from the placement's own
// decals — never from a re-typed copy of CROWN_DECAL — and the whole layout is built around it:
// facade articulation stops one clear course BELOW it, and the crown mass starts above it.
//
// FACE LAW. The fixed rig (yaw 45°) only ever shows a solid's SOUTH (+Z) and EAST (+X) faces —
// pinned Phase 24, re-derived Phase 34. A face whose normal has a negative X or Z component is
// back-facing at EVERY legal vantage, so every appender here masks north/west faces off. That is
// not a micro-optimisation: it is what makes a 4-triangle pier affordable at 20 per face, which is
// what makes a curtain-wall rhythm read at all. Closed convex solids only — a masked box is still
// solid from every direction the camera can occupy, so the P46 "open shell see-through" class
// cannot occur here.
//
// SECONDARY MASSES. Two of the six lots carry a second REAL building, not decoration:
//   • TD's single-storey banking pavilion on its Front Street plaza (Mies's TD Centre is three
//     buildings; the pavilion is the one the street actually meets);
//   • Commerce Court NORTH, the 1931 Art Deco limestone tower that shares Commerce Court with
//     I.M. Pei's 1972 stainless slab.
// Both stand entirely OUTSIDE their placement's data-box footprint, and both mint an `extraClaim`
// (so every seeded placer rejects their ground) plus a matching `extraCollider` (so the car stops
// at a wall) — the Union Station GO-shed contract, unchanged. Commerce North's height is DATA:
// `data/toronto/building-specs.json` carries a `commerce-court-north` row and this file runs it
// through the same `hGame(real_h_m) × NAMED_HEIGHT_SCALE` rule namedBuildings.ts uses. Nothing here
// hardcodes a height, a footprint or a material colour (CLAUDE.md's data rule).
//
// SINGLE SOURCE OF TRUTH: every dimension derives from the placement's own DATA box (footprint,
// §3c height, §4 look) or from a config leaf. There is not one literal world coordinate; the only
// literals are proportions and material accents, and each carries the reason it has its value —
// unionStation.ts / royalYork.ts's discipline, verbatim.
//
// VERIFIED vs STATED. Everything called a "read" below comes from the R48 researcher paragraphs in
// building-specs.json's `notes` for each id. Where the researcher's own note says a detail is
// unverified (CIBC Square's sloped top, Commerce North's pyramidal crown, every exact accent hex),
// the comment at the point of use says so — "stated, not invented", the Phase 44 beacon-cadence
// precedent.

import buildingSpecsJson from '../../../../data/toronto/building-specs.json';
import { NAMED_HEIGHT_SCALE } from '../../config/torontoMap';
import { lookForMaterial, WINDOW_PATTERN } from '../../config/torontoMaterials';
import { addBox, addFace, createAccum, toGeometry, triangleCount, type Accum, type Vec3 } from './bespokeMesh';
import { hGame } from './heightCurve';
import type { DecalFace, NamedBox, NamedPlacement } from './namedBuildings';
import type { NamedBespoke, NamedBespokeGeometry, NamedGeometryCtx } from './namedGeometry';
import type { Street } from './streets';

// --- tri budgets (Part 11 rule 2: stated per model, pinned in the phase that introduces them) -----
//
// Ceilings are DELIBERATE re-pins from Addendum A's original "filler box ≤ 12" era, and they are
// generous relative to the measured counts on purpose: the low quality tier sat at 98.3 % of its
// triangle budget leaving Phase 47 (phase-47-notes), so the real constraint is the measured total,
// not the ceiling. Every budget below is pinned with a FLOOR as well, because a ceiling alone is
// passed just as happily by the 12-triangle box these six shipped as until this phase — the floor
// is what makes a silent revert fail (unionStation.test.ts / royalYork.test.ts's idiom).

export const FIRST_CANADIAN_PLACE_MAX_TRIS = 700 as const;
export const SCOTIA_PLAZA_MAX_TRIS = 700 as const;
export const TD_BANK_TOWER_MAX_TRIS = 700 as const;
/** Higher than its five siblings: this one carries a SECOND whole building (Commerce Court North). */
export const COMMERCE_COURT_MAX_TRIS = 850 as const;
export const ROYAL_BANK_PLAZA_MAX_TRIS = 700 as const;
export const CIBC_SQUARE_MAX_TRIS = 700 as const;

// --- render groups (draw-call pooling — see NamedBespoke.renderGroup) ------------------------------
//
// TWO groups, not one. A pooled group fades as a single mesh, so the seam's law is that a group may
// never span more than one city block (namedGeometry.test.ts pins ≤ 200 wu). The six towers split
// cleanly along King Street into the two blocks they actually occupy: measured member spans are
// ~74 wu (north) and ~82 wu (south), while all six pooled together span ~208 wu — over the law, and
// visibly wrong besides (a drive-by fade at Front Street would ghost Adelaide Street).
// financialTowers.test.ts measures all three of those spans rather than trusting this note.

/** First Canadian Place + Scotia Plaza + Commerce Court — the Adelaide/King block. */
export const FINANCIAL_NORTH_RENDER_GROUP = 'financial-north';
/** TD + Royal Bank Plaza + CIBC Square — the Wellington/Front block. */
export const FINANCIAL_SOUTH_RENDER_GROUP = 'financial-south';

// --- shared proportions (the only literals; each one carries its reason) ---------------------------

/**
 * The city's own storey module (config/torontoMaterials.ts's facade-grid row height). Podium and
 * pavilion heights are expressed in STOREYS × this, so a base block is exactly as tall as the
 * window rows baked onto the facade above it — rather than a fresh invented wu number per tower.
 */
const STOREY_WU = WINDOW_PATTERN.floorHeightWu;

/**
 * How far the podium block stands proud of the tower footprint (wu). CEILING ON EVERY PROUD
 * ELEMENT IN THIS FILE IS 2.5 wu: namedBuildings.ts inflates each named footprint by a 3 wu
 * massing-exclusion margin, and anything past that pokes into ground another placer owns. The
 * stack below is built up from this value and tops out at PODIUM_PROUD + 0.9 = 2.3 wu.
 */
const PODIUM_PROUD_WU = 1.4;
/** The hard ceiling on how far any facade-attached element may stand off the DATA box (see above).
 * Published as a probe so the test asserts the geometry against the LAW rather than against a
 * number it re-types. */
export const MAX_PROUD_WU = 2.5;
/** Podium colonnade: how far its piers are buried INTO the podium wall, and how deep they are.
 * Front face therefore sits at PODIUM_PROUD + 0.55. A buried back means no flush base seam ever
 * (unionStation.ts's COLUMN_BURY_WU makes the identical call). */
const COLONNADE_BURY_WU = 0.15;
const COLONNADE_DEPTH_WU = 0.7;
/** Colonnade bay pitch and pier half-width (wu). A banking-hall order: ~1.45 wu ≈ 4.5 m centres,
 * 0.84 wu ≈ 2.6 m piers — the same deliberate up-scale-for-legibility call unionStation.ts's
 * COLUMN_RADIUS_WU documents, since a to-scale mullion falls under THIN_GEOMETRY.minStripeWidthWu
 * and strobes. The COUNT is derived from the pitch and the tower's own face, never authored, so a
 * wider tower simply gets more bays. */
const COLONNADE_PITCH_WU = 1.45;
const COLONNADE_HALF_W_WU = 0.42;
/** Entrance vestibule half-width, as a fraction of the tower's own footprint half-extent — so the
 * doors scale with the building instead of being typed per tower. */
const VESTIBULE_HALF_W_FRAC = 0.28;
/** A corner mullion is this much heavier than the row it terminates. 1.3 keeps every corner pier
 * in this file NARROWER than the course that caps it, which is what buries its top face. */
const CORNER_PIER_SCALE = 1.3;
/** The cornice capping the podium colonnade. Must project past the colonnade front (1.95) so the
 * pier tops are buried under it and pay no top-cap triangles — the Union entablature pattern. */
const PODIUM_CORNICE_PROUD_WU = 2.1;
const PODIUM_CORNICE_H_WU = 0.6;
/** The entrance vestibule: the one element allowed the full stack, at 2.3 wu proud. */
const VESTIBULE_PROUD_WU = 2.3;

/**
 * THE FACADE RHYTHM — the constant this file's second pass exists for, and the one nobody may
 * replace with an authored count.
 *
 * Every vertical articulation below is laid on the pitch the §4 facade TEXTURE already draws its
 * window columns on (config/torontoMaterials.ts's `WINDOW_PATTERN.columnPitchWu`), or an exact
 * multiple of it, and every pier is a FRACTION of its own bay wide. That is not a style preference,
 * it is the Phase-23 material verdict as arithmetic: this city reads at blue hour THROUGH its
 * emissive windows — the unlit-literal fills crush to near-black otherwise, which is why Phases
 * 23/24 are on record that lit windows ARE the look fix. The first cut of this module authored
 * counts instead (20 piers on a 19 wu face, a continuous sawtooth skin), which left fractions of a
 * wu of glass between elements: the piers BECAME the wall, and the evidence battery photographed
 * three of the six towers as featureless slabs at exactly the close range this phase exists to
 * improve.
 *
 * Deriving the COUNT from the pitch makes the bespoke rhythm and the baked facade agree by
 * construction, so real glass survives between the mullions and the tower reads as what all six of
 * these buildings actually are: a curtain wall with expressed mullions.
 * `financialTowers.test.ts`'s OPEN-FACE LAW measures the result on the emitted geometry, never on
 * these constants, so a future re-tune cannot pass a stale assertion.
 */
const FACADE_COLUMN_PITCH_WU = WINDOW_PATTERN.columnPitchWu;
/** A pier's width as a fraction of its own bay. At or below ⅓ leaves two thirds of every bay as
 * glass, which is the coverage budget the open-face law then verifies on the mesh. */
const PIER_WIDTH_FRAC = 0.32;
/**
 * A sawtooth TOOTH's width as a fraction of its bay. The rest of the bay is a FLAT RECESS with no
 * geometry at all, so the box's textured face shows through between consecutive teeth — that is
 * what turns a serrated SKIN (which occludes 100 % of the elevation behind it) into a serrated
 * RHYTHM, while keeping the silhouette that makes Scotia and RBC themselves.
 */
const TOOTH_WIDTH_FRAC = 0.42;

/** Shaft articulation: piers/teeth are buried 0.15 into the tower wall and stand 0.45 proud of it;
 * the courses that cap them project 0.75, i.e. past the pier front, for the same buried-top reason
 * as the podium cornice. */
const SHAFT_BURY_WU = 0.15;
const SHAFT_PIER_DEPTH_WU = 0.6;
const SHAFT_COURSE_PROUD_WU = 0.75;
const COURSE_H_WU = 0.55;
/** Clearance (wu) between the top of the shaft articulation and the bottom of the CROWN decal
 * band: the logo reads on plain curtain wall, never on a rhythm of proud mullions. */
const SHAFT_BAND_CLEAR_WU = 1.2;
/** Inset (wu) each end of a face's articulated span leaves, so the end-most pier never lands ON
 * the corner where two elevations meet (royalYork.ts's DORMER_MARGIN_WU, same reasoning). */
const FACE_MARGIN_WU = 0.9;

/** Sawtooth (Scotia's north/south steps, RBC's serration): apex projection and how far the wedge
 * is sunk into the wall behind it. 0.9 wu ≈ 2.8 m of serration — an up-scale for legibility of
 * exactly the kind Union's columns document, since a to-scale curtain-wall fold would fall under
 * THIN_GEOMETRY.minStripeWidthWu and strobe. */
const SAWTOOTH_DEPTH_WU = 0.9;
const SAWTOOTH_SINK_WU = 0.1;

/** Crown: how far the crown mass is inset from the tower footprint, the height of the parapet/deck
 * plate that finishes it, and how much further in that plate sits. A non-zero inset is structural,
 * not cosmetic — it guarantees the crown's walls are never coplanar with the render box's walls
 * (the Phase 42 anti-coplanar-at-source rule), and it is what makes the top ring of the render box
 * read as a real setback. */
const CROWN_INSET_WU = 0.8;
const CROWN_DECK_H_WU = 0.45;
const CROWN_DECK_INSET_WU = 1.1;

/** Minimum fraction of the DATA height the render box may keep. Below this the §4 facade texture
 * (the lit-window pattern that IS the building at night) stops being the building. */
export const MIN_RENDER_HEIGHT_FRAC = 0.85;

// --- palette helpers -------------------------------------------------------------------------------

/**
 * Scale an sRGB hex toward white (k > 1) or black (k < 1). Every tower's own §4 fill is the single
 * source for its palette — a proud pier reads as the SAME material catching more light, not as a
 * second colour — so this file ships three literal accent hexes total (below) instead of eighteen
 * hand-picked per-tower tones that could drift away from `MATERIAL_LOOKS`.
 */
function tint(hex: string, k: number): string {
  return channels(hex, (c) => c * k);
}

/**
 * Blend two sRGB hexes. Two uses, both structural rather than decorative:
 *   • the LIGHT tone of every proud element is the tower's fill lifted toward white rather than
 *     MULTIPLIED toward it — a multiply on a near-black fill (TD's #22262e) produces no visible
 *     separation at all, and TD's mullion rhythm IS its street read;
 *   • the lit-lobby colour behind each podium colonnade is the §4 window tint carried toward the
 *     tower's own fill, so First Canadian Place's lobby reads white-warm and Scotia Plaza's reads
 *     red-warm. Six lobbies, six casts, out of data both towers already carry.
 */
function mix(a: string, b: string, t: number): string {
  const other = Number.parseInt(b.slice(1), 16);
  let shift = 24;
  return channels(a, (c) => {
    shift -= 8;
    return c * (1 - t) + ((other >> shift) & 0xff) * t;
  });
}

/** Map R, G, B (in that order) through `f`, clamped back into an sRGB hex. */
function channels(hex: string, f: (c: number) => number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (shift: number): number =>
    Math.max(0, Math.min(255, Math.round(f((n >> shift) & 0xff))));
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/** How far a proud element's tone is lifted toward white, and how far a lit lobby is carried toward
 * its building's own colour. Both picked to keep the LIGHTEST tower (FCP's white glass) from
 * blowing out while still separating the DARKEST one (TD's matte black). */
const LIGHT_LIFT = 0.22;
const LOBBY_CAST = 0.55;

/**
 * The three accent families the researcher notes name explicitly but never give a hex for —
 * STATED, NOT INVENTED (the exact tones are unverified and this comment is the record):
 *   • BRONZE — FCP's "white glass and bronze panels" (2005 reclad) and TD's "bronze-tinted glass";
 *   • GOLD_LEAF — RBC's 24-carat gold leaf across 14,000 windows ("radiant shimmering effect");
 *   • LOBBY_GLOW — not a material at all: the warm interior spill of a lit banking hall, taken from
 *     the §4 look's own `windowTint` at the point of use, so it matches the lit texels the facade
 *     texture bakes above it.
 */
const BRONZE = '#7a5c34';
const GOLD_LEAF = '#d8b25c';

// --- the CROWN keep-out band -------------------------------------------------------------------------

/** The vertical span (wu, above ground) a placement's CROWN decals occupy on the RENDER box. */
export interface CrownKeepOut {
  readonly y0: number;
  readonly y1: number;
}

/**
 * The band no proud south/east geometry may enter, computed from the placement's OWN decals: the
 * §4 rule is `centre = bandCenterFrac × renderBoxHeight`, `size = clamp(0.5 × faceWidth, 8, 16)`,
 * and TorontoScene's `decalTransform` reads exactly those two numbers off the placement. Deriving
 * the band here (rather than re-deriving it from CROWN_DECAL) means a future change to the §4 rule
 * moves the towers' articulation with it, automatically.
 *
 * Throws when a placement carries no decal: these builders are registered only for the six crowned
 * bank towers, so a decal-less placement means the registry and the data have drifted apart, and a
 * loud failure is worth far more than a silently unconstrained layout.
 */
export function crownKeepOutBand(placement: NamedPlacement, renderHeightWu: number): CrownKeepOut {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const decal of placement.decals) {
    const centre = decal.bandCenterFrac * renderHeightWu;
    y0 = Math.min(y0, centre - decal.size / 2);
    y1 = Math.max(y1, centre + decal.size / 2);
  }
  if (!(y0 < y1)) throw new Error(`financialTowers: ${placement.id} carries no CROWN decal to clear`);
  return { y0, y1 };
}

// --- layout -------------------------------------------------------------------------------------------

interface TowerLayout {
  readonly id: string;
  readonly box: NamedBox;
  /** DATA height — what the crown must top out at, exactly (the Union/Royal York law). */
  readonly height: number;
  /** Shortened render-box height: the §4 facade path stops here and the crown takes over. */
  readonly renderTopY: number;
  readonly xMin: number;
  readonly xMax: number;
  readonly zMin: number;
  readonly zMax: number;
  readonly band: CrownKeepOut;
  readonly podiumTopY: number;
  /** Top of the shaft articulation — one clear course below the CROWN band. */
  readonly shaftTopY: number;
  /** §4 fill of this tower + the two derived tones every appender uses. */
  readonly fill: string;
  readonly light: string;
  readonly dark: string;
  /** The lit-window tint the facade texture above uses — the lobby glow at street level. */
  readonly glow: string;
}

function towerLayout(placement: NamedPlacement, renderFrac: number, podiumStoreys: number): TowerLayout {
  const box = placement.boxes[0];
  if (box === undefined) throw new Error(`financialTowers: ${placement.id} has no data box`);
  if (renderFrac < MIN_RENDER_HEIGHT_FRAC || renderFrac >= 1) {
    throw new Error(`financialTowers: ${placement.id} render fraction ${renderFrac} is out of range`);
  }
  const height = box.hy * 2;
  const renderTopY = renderFrac * height;
  const band = crownKeepOutBand(placement, renderTopY);
  const podiumTopY = podiumStoreys * STOREY_WU;
  const shaftTopY = band.y0 - SHAFT_BAND_CLEAR_WU;
  // Both guards are the layout's own contract, checked rather than commented: the articulation
  // must fit between the podium and the logo, and the crown mass must start above the logo.
  if (shaftTopY <= podiumTopY + COURSE_H_WU) {
    throw new Error(`financialTowers: ${placement.id} has no room between podium and CROWN band`);
  }
  if (renderTopY <= band.y1) {
    throw new Error(`financialTowers: ${placement.id} crown mass would start inside the CROWN band`);
  }
  const fill = box.look.fill;
  return {
    id: placement.id,
    box,
    height,
    renderTopY,
    xMin: box.cx - box.hx,
    xMax: box.cx + box.hx,
    zMin: box.cz - box.hz,
    zMax: box.cz + box.hz,
    band,
    podiumTopY,
    shaftTopY,
    fill,
    // Proud elements read LIGHTER (they catch the dusk key), recessed ones darker — the same
    // two-tone trick royalYork.ts documents, here derived from the fill instead of hand-picked.
    light: mix(fill, '#ffffff', LIGHT_LIFT),
    dark: tint(fill, 0.66),
    glow: box.look.windowTint,
  };
}

// --- the shared vocabulary ----------------------------------------------------------------------------
//
// Six towers, one kit. Each appender emits only faces the fixed rig can see (see this file's FACE
// LAW note) and each is composed with different parameters by the six builders below — that IS the
// module's design, and it is why the sixth tower costs a dozen lines rather than another 200.

/** Faces of a solid that the fixed rig can never show. Every box in this file masks them. */
const HIDDEN_FACES = { nz: false, nx: false } as const;

/**
 * A low block wrapping the tower base: a podium, a granite plinth, a glazed atrium. Its top face is
 * a real, camera-visible deck (the rig looks DOWN at 58°), so `py` is always built. `proud` may be
 * any value that keeps the whole stack inside MAX_PROUD_WU.
 */
function appendBaseBlock(acc: Accum, L: TowerLayout, proud: number, y0: number, y1: number, hex: string): void {
  addBox(acc, L.box.cx, (y0 + y1) / 2, L.box.cz, L.box.hx + proud, (y1 - y0) / 2, L.box.hz + proud, hex, HIDDEN_FACES);
}

/** A proud horizontal COURSE wrapping both camera-visible elevations — a cornice, a mega-frame
 * band, a spandrel. SIX triangles covers BOTH faces at once, which is what makes CIBC Square's
 * banded fenestration affordable at fourteen courses. */
function appendCourse(acc: Accum, L: TowerLayout, y0: number, y1: number, proud: number, hex: string): void {
  appendBaseBlock(acc, L, proud, y0, y1, hex);
}

/** The world-space centre + span of one camera-visible elevation, in the axis its detail is laid
 * along (south → X, east → Z). One accessor so no appender re-derives a face position. */
function faceAxis(L: TowerLayout, face: DecalFace): { readonly along0: number; readonly along1: number; readonly at: number } {
  return face === 'south'
    ? { along0: L.xMin + FACE_MARGIN_WU, along1: L.xMax - FACE_MARGIN_WU, at: L.zMax }
    : { along0: L.zMin + FACE_MARGIN_WU, along1: L.zMax - FACE_MARGIN_WU, at: L.xMax };
}

/** How many uniform bays of `pitch` fit the articulated span of one elevation — the derivation
 * that keeps a bay rhythm a property of the BUILDING rather than a number typed per tower. Floored
 * at 2 so a wide-bay tower (Commerce Court's doubled pitch) still gets a rhythm rather than one
 * lonely pier. */
function bayCount(L: TowerLayout, face: DecalFace, pitch: number): number {
  const { along0, along1 } = faceAxis(L, face);
  return Math.max(2, Math.round((along1 - along0) / pitch));
}

/** One elevation's resolved rhythm: how many bays fit, and how wide the element standing in each
 * bay is. `pitchMultiple` is how many FACADE_COLUMN_PITCH_WU bays one structural bay spans (1 for a
 * mullion rhythm, 2 for Pei's wide structural grid); `widthFrac` is the element's share of its own
 * bay, so the coverage a row costs is `widthFrac` BY CONSTRUCTION, independent of tower size. */
interface FacadeRhythm {
  readonly count: number;
  readonly pitch: number;
  readonly halfWidth: number;
}

function facadeRhythm(L: TowerLayout, face: DecalFace, pitchMultiple: number, widthFrac: number): FacadeRhythm {
  const { along0, along1 } = faceAxis(L, face);
  const count = bayCount(L, face, FACADE_COLUMN_PITCH_WU * pitchMultiple);
  const pitch = (along1 - along0) / count;
  return { count, pitch, halfWidth: (widthFrac * pitch) / 2 };
}

/**
 * A row of proud vertical PIERS on one camera-visible elevation — the curtain-wall mullion rhythm
 * that is the base read of four of these six towers. FOUR triangles each: the front face, the one
 * side cheek the rig can see, and nothing else (the buried back and the away-facing cheek are
 * back-facing at every legal vantage; the top is buried under the course that caps the row). That
 * price is why a 20-pier rhythm is affordable twice per tower.
 */
interface PierRow {
  readonly face: DecalFace;
  readonly count: number;
  readonly halfWidth: number;
  /** How far the WALL these piers ride stands off the DATA face (0 = the tower wall itself, so the
   * same appender serves the tower shaft and the podium colonnade). */
  readonly wallProud?: number;
  /** How far each pier's back is sunk INTO that wall — no flush base seam, ever. */
  readonly bury?: number;
  readonly depth: number;
  readonly y0: number;
  readonly y1: number;
  readonly hex: string;
  /**
   * `false` when NOTHING above buries the pier tops. The rig looks DOWN at 58°, so an uncapped
   * open-topped post is a hole the camera looks straight into — the P43/P46 see-through class.
   * Default `true`: every row in this file except the rooftop rails is finished by a course that
   * projects further than the piers do.
   */
  readonly capped?: boolean;
}

function appendPierRow(acc: Accum, L: TowerLayout, row: PierRow): void {
  const { along0, along1, at } = faceAxis(L, row.face);
  const pitch = (along1 - along0) / row.count;
  const centre = at + (row.wallProud ?? 0) - (row.bury ?? 0) + row.depth / 2;
  const faces = { nz: false, nx: false, py: row.capped === false };
  for (let i = 0; i < row.count; i++) {
    const along = along0 + (i + 0.5) * pitch;
    if (row.face === 'south') {
      addBox(acc, along, (row.y0 + row.y1) / 2, centre, row.halfWidth, (row.y1 - row.y0) / 2, row.depth / 2, row.hex, faces);
    } else {
      addBox(acc, centre, (row.y0 + row.y1) / 2, along, row.depth / 2, (row.y1 - row.y0) / 2, row.halfWidth, row.hex, faces);
    }
  }
}

/**
 * A SAWTOOTH elevation: a row of wedges springing from the wall to a proud apex — Scotia Plaza's
 * researched stepped profile (engineered for 12+ corner offices per floor) and Royal Bank Plaza's
 * serrated curtain wall. Four triangles per tooth, and no top cap: the caller always finishes the
 * band with a course, exactly as the pier rows do.
 *
 * EACH TOOTH STANDS ALONE IN ITS BAY. The first cut ran the wedges edge-to-edge, which is what a
 * real serrated curtain wall is — and which made the elevation a continuous folded SKIN occluding
 * 100 % of the textured face behind it (see FACADE_COLUMN_PITCH_WU). A tooth now occupies
 * `rhythm.halfWidth × 2` of its bay and the rest is a flat recess with no geometry at all, so the
 * lit-window texture shows between consecutive teeth. The silhouette is unchanged; the skin is not.
 *
 * The wedge is SUNK into the wall behind it (SAWTOOTH_SINK_WU) so no face of it is ever coplanar
 * with the facade — the valley is a buried line, not a shared plane.
 */
function appendSawtoothFace(
  acc: Accum,
  L: TowerLayout,
  face: DecalFace,
  rhythm: FacadeRhythm,
  depth: number,
  y0: number,
  y1: number,
  hexLit: string,
  hexShade: string,
): void {
  const { along0, at } = faceAxis(L, face);
  const back = at - SAWTOOTH_SINK_WU;
  const apex = at + depth;
  const pitch = rhythm.pitch;
  const point = (along: number, across: number, y: number): Vec3 =>
    face === 'south' ? [along, y, across] : [across, y, along];
  for (let i = 0; i < rhythm.count; i++) {
    const am = along0 + (i + 0.5) * pitch;
    const a0 = am - rhythm.halfWidth;
    const a1 = am + rhythm.halfWidth;
    // The two slopes of one tooth. On a fixed 45° bearing exactly one of them faces the camera and
    // one grazes it — which IS why a sawtooth reads as a sawtooth rather than as a flat wall: the
    // alternation of a lit face and a shaded one is the whole effect, so they are coloured, not
    // culled (a culled grazing face would leave a hole at the vantages where it turns visible).
    addFace(
      acc,
      [point(a0, back, y0), point(am, apex, y0), point(am, apex, y1), point(a0, back, y1)],
      face === 'south' ? [-depth, 0, rhythm.halfWidth] : [rhythm.halfWidth, 0, -depth],
      hexShade,
    );
    addFace(
      acc,
      [point(am, apex, y0), point(a1, back, y0), point(a1, back, y1), point(am, apex, y1)],
      face === 'south' ? [depth, 0, rhythm.halfWidth] : [rhythm.halfWidth, 0, depth],
      hexLit,
    );
  }
}

/**
 * The entrance: a proud, lit vestibule box with a lintel course over it, sitting on the podium's
 * camera-visible elevation. Six triangles for the glass, six for the lintel — the cheapest element
 * in the kit that reads unambiguously as "this is where you walk in", which is the one thing a
 * 300-metre office tower's street frontage has to say.
 */
function appendVestibule(
  acc: Accum,
  L: TowerLayout,
  face: DecalFace,
  halfWidth: number,
  topY: number,
  glassHex: string,
  lintelHex: string,
): void {
  const { at } = faceAxis(L, face);
  const back = at + PODIUM_PROUD_WU - COLONNADE_BURY_WU;
  const centre = (back + at + VESTIBULE_PROUD_WU) / 2;
  const halfDepth = (at + VESTIBULE_PROUD_WU - back) / 2;
  const along = face === 'south' ? L.box.cx : L.box.cz;
  const lintelY1 = topY + COURSE_H_WU;
  if (face === 'south') {
    addBox(acc, along, topY / 2, centre, halfWidth, topY / 2, halfDepth, glassHex, HIDDEN_FACES);
    addBox(acc, along, (topY + lintelY1) / 2, centre, halfWidth + 0.25, COURSE_H_WU / 2, halfDepth + 0.1, lintelHex, HIDDEN_FACES);
  } else {
    addBox(acc, centre, topY / 2, along, halfDepth, topY / 2, halfWidth, glassHex, HIDDEN_FACES);
    addBox(acc, centre, (topY + lintelY1) / 2, along, halfDepth + 0.1, COURSE_H_WU / 2, halfWidth + 0.25, lintelHex, HIDDEN_FACES);
  }
}

/** The whole street-level base every tower shares: podium block (its wall doubles as the lit lobby
 * behind the colonnade), a colonnade of piers on both camera-visible elevations, the cornice that
 * caps them, and one entrance vestibule. */
function appendPodium(acc: Accum, L: TowerLayout, entrance: DecalFace): void {
  const corniceY0 = L.podiumTopY - PODIUM_CORNICE_H_WU;
  // The block itself is the lobby GLASS: the colonnade in front of it is the stone, so the lit
  // wall between the piers costs nothing at all (no separate glazing quads, no wall stack rung).
  appendBaseBlock(acc, L, PODIUM_PROUD_WU, 0, corniceY0, mix(L.glow, L.fill, LOBBY_CAST));
  for (const face of ['south', 'east'] as const) {
    appendPierRow(acc, L, {
      face,
      count: bayCount(L, face, COLONNADE_PITCH_WU),
      halfWidth: COLONNADE_HALF_W_WU,
      wallProud: PODIUM_PROUD_WU,
      bury: COLONNADE_BURY_WU,
      depth: COLONNADE_DEPTH_WU,
      y0: 0,
      y1: corniceY0,
      hex: L.light,
    });
  }
  appendCourse(acc, L, corniceY0, L.podiumTopY, PODIUM_CORNICE_PROUD_WU, L.dark);
  appendVestibule(acc, L, entrance, VESTIBULE_HALF_W_FRAC * L.box.hx, corniceY0 - 0.9, L.glow, L.light);
}

/** A corner mullion at the SE corner — the one pier the rig sees on BOTH of its faces at once, and
 * the element that stops a tower's two articulated elevations meeting in a bare arris. */
function appendCornerPier(acc: Accum, L: TowerLayout, rowHalfWidth: number, y0: number, y1: number, hex: string): void {
  const half = rowHalfWidth * CORNER_PIER_SCALE;
  addBox(acc, L.xMax, (y0 + y1) / 2, L.zMax, half, (y1 - y0) / 2, half, hex, { nz: false, nx: false, py: false });
}

/**
 * The crown: a setback mass from the render box's top to EXACTLY the data height, finished with an
 * inset deck plate. Twenty triangles. Both boxes are built on all four sides (unlike everything
 * below them) because the crown is the silhouette — the minimap icon and every off-rig postcard —
 * and four extra triangles is the correct price for a landmark's outline reading from any bearing.
 */
function appendFlatCrown(acc: Accum, L: TowerLayout, inset: number, bodyHex: string, deckHex: string): void {
  const bodyTopY = L.height - CROWN_DECK_H_WU;
  addBox(acc, L.box.cx, (L.renderTopY + bodyTopY) / 2, L.box.cz, L.box.hx - inset, (bodyTopY - L.renderTopY) / 2, L.box.hz - inset, bodyHex);
  addBox(
    acc,
    L.box.cx,
    (bodyTopY + L.height) / 2,
    L.box.cz,
    L.box.hx - inset - CROWN_DECK_INSET_WU,
    CROWN_DECK_H_WU / 2,
    L.box.hz - inset - CROWN_DECK_INSET_WU,
    deckHex,
  );
}

/** A rectangular frustum whose top rectangle may be OFFSET as well as smaller — a sheared cap. Ten
 * triangles (four walls + the top), and the only primitive here that is not axis-aligned in
 * section. */
function addSkewBox(
  acc: Accum,
  y0: number,
  y1: number,
  lo: { cx: number; cz: number; hx: number; hz: number },
  hi: { cx: number; cz: number; hx: number; hz: number },
  hex: string,
  capHex: string,
): void {
  const corners = (r: { cx: number; cz: number; hx: number; hz: number }, y: number) => ({
    nn: [r.cx - r.hx, y, r.cz - r.hz] as Vec3,
    pn: [r.cx + r.hx, y, r.cz - r.hz] as Vec3,
    pp: [r.cx + r.hx, y, r.cz + r.hz] as Vec3,
    np: [r.cx - r.hx, y, r.cz + r.hz] as Vec3,
  });
  const a = corners(lo, y0);
  const b = corners(hi, y1);
  addFace(acc, [a.nn, a.pn, b.pn, b.nn], [0, 0, -1], hex);
  addFace(acc, [a.pn, a.pp, b.pp, b.pn], [1, 0, 0], hex);
  addFace(acc, [a.pp, a.np, b.np, b.pp], [0, 0, 1], hex);
  addFace(acc, [a.np, a.nn, b.nn, b.np], [-1, 0, 0], hex);
  addFace(acc, [b.nn, b.pn, b.pp, b.np], [0, 1, 0], capHex);
}

/**
 * A free-standing SECONDARY MASS — a real building on the same lot, outside the placement's data
 * footprint. Closed convex box with the two never-visible walls masked off, plus an optional
 * setback stack, its own base course, and a vertical pier rhythm on both camera-visible faces.
 */
interface MassRect {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hz: number;
}

function appendMassBox(acc: Accum, r: MassRect, y0: number, y1: number, hex: string): void {
  addBox(acc, r.cx, (y0 + y1) / 2, r.cz, r.hx, (y1 - y0) / 2, r.hz, hex, HIDDEN_FACES);
}

/** Vertical piers on the two camera-visible faces of a free-standing mass (the Art Deco read). */
function appendMassPiers(
  acc: Accum,
  r: MassRect,
  count: number,
  halfWidth: number,
  depth: number,
  y0: number,
  y1: number,
  hex: string,
  capped: boolean,
): void {
  const faces = { nz: false, nx: false, py: !capped };
  for (const face of ['south', 'east'] as const) {
    const along0 = (face === 'south' ? r.cx - r.hx : r.cz - r.hz) + FACE_MARGIN_WU;
    const along1 = (face === 'south' ? r.cx + r.hx : r.cz + r.hz) - FACE_MARGIN_WU;
    const at = (face === 'south' ? r.cz + r.hz : r.cx + r.hx) - SHAFT_BURY_WU + depth / 2;
    const pitch = (along1 - along0) / count;
    for (let i = 0; i < count; i++) {
      const along = along0 + (i + 0.5) * pitch;
      if (face === 'south') {
        addBox(acc, along, (y0 + y1) / 2, at, halfWidth, (y1 - y0) / 2, depth / 2, hex, faces);
      } else {
        addBox(acc, at, (y0 + y1) / 2, along, depth / 2, (y1 - y0) / 2, halfWidth, hex, faces);
      }
    }
  }
}

// --- secondary-mass heights, from the DATA ------------------------------------------------------------

interface SecondarySpec {
  readonly id: string;
  readonly real_h_m: number;
  readonly footprint_wu: number;
  readonly material: string;
}

const SPECS = buildingSpecsJson.buildings as readonly SecondarySpec[];

function secondarySpec(id: string): SecondarySpec {
  const s = SPECS.find((row) => row.id === id);
  if (s === undefined) throw new Error(`financialTowers: building-specs.json has no building "${id}"`);
  return s;
}

/** namedBuildings.ts's `namedHeight` rule, replicated for the one class of building that is real,
 * researched and height-carrying but does NOT get its own placement (see
 * namedBuildings.NAMED_SECONDARY_MASS_IDS). Same §3c curve, same Part-8 named scale — a secondary
 * mass must never be a different KIND of tall than the tower next to it. */
function namedHeight(realM: number): number {
  return hGame(realM) * NAMED_HEIGHT_SCALE;
}

// =====================================================================================================
// 1 — FIRST CANADIAN PLACE (BMO): white glass + bronze, a full-block podium, a flat crown
// =====================================================================================================
//
// R48 verified: white glass and bronze panels (2005 reclad, replacing the original Carrara marble);
// a simple rectangular tower on a FULL-BLOCK PODIUM, late-modern minimalism on a steel MEGA-FRAME;
// flat crown (photovoltaic panels added 2022); bank headquarters lobby + public banking hall in the
// podium base.
//
// STREET READ: the tallest and broadest podium of the six (2.2 storeys, the "full-block" note),
// a dense white pier rhythm on both camera-visible elevations, and TWO bronze mega-frame courses
// crossing it — the one thing that distinguishes this tower's grid from TD's next door is that its
// verticals are interrupted by heavy horizontals, because that is what a mega-frame is.

const FCP_RENDER_FRAC = 0.9;
const FCP_PODIUM_STOREYS = 2.2;
/** One structural bay per window column (see FACADE_COLUMN_PITCH_WU) — six bays on this footprint,
 * which is exactly the column count the baked facade draws on a 19 wu face. */
const FCP_PITCH_MULTIPLE = 1;
/** Where the two mega-frame courses cross the shaft, as fractions of the shaft's own span. */
const FCP_MEGAFRAME_FRACS = [0.36, 0.72] as const;

export function buildFirstCanadianPlaceBespoke(placement: NamedPlacement): NamedBespoke {
  const L = towerLayout(placement, FCP_RENDER_FRAC, FCP_PODIUM_STOREYS);
  const build = (): NamedBespokeGeometry => {
    const acc = createAccum();
    appendPodium(acc, L, 'east'); // entrance on Bay — the east elevation is the flush one
    const shaftY0 = L.podiumTopY;
    const shaftY1 = L.shaftTopY - COURSE_H_WU;
    for (const face of ['south', 'east'] as const) {
      const rhythm = facadeRhythm(L, face, FCP_PITCH_MULTIPLE, PIER_WIDTH_FRAC);
      appendPierRow(acc, L, { face, count: rhythm.count, halfWidth: rhythm.halfWidth, bury: SHAFT_BURY_WU, depth: SHAFT_PIER_DEPTH_WU, y0: shaftY0, y1: shaftY1, hex: L.light });
    }
    appendCornerPier(acc, L, facadeRhythm(L, 'south', FCP_PITCH_MULTIPLE, PIER_WIDTH_FRAC).halfWidth, shaftY0, shaftY1, L.light);
    // The mega-frame: bronze, and proud of the piers so it reads as structure OVER the curtain wall.
    for (const frac of FCP_MEGAFRAME_FRACS) {
      const y = shaftY0 + frac * (shaftY1 - shaftY0);
      appendCourse(acc, L, y, y + COURSE_H_WU, SHAFT_COURSE_PROUD_WU, BRONZE);
    }
    appendCourse(acc, L, shaftY1, L.shaftTopY, SHAFT_COURSE_PROUD_WU, BRONZE);
    // Flat crown; the deck plate is the 2022 photovoltaic array (verified as PRESENT and flat —
    // its layout is not, so it ships as one dark plate rather than an invented panel pattern).
    appendFlatCrown(acc, L, CROWN_INSET_WU, L.light, tint(L.fill, 0.42));
    const total = triangleCount(acc);
    return { geometry: toGeometry(acc, false), triangles: total, parts: [{ id: L.id, triangles: total }] };
  };
  return {
    id: placement.id,
    renderBoxes: [{ ...L.box, hy: L.renderTopY / 2 }],
    renderGroup: FINANCIAL_NORTH_RENDER_GROUP,
    signQuads: [],
    extraClaims: [],
    extraColliders: [],
    meta: {
      topY: L.height,
      probes: towerProbes(L, {
        shaftPiers: facadeRhythm(L, 'south', FCP_PITCH_MULTIPLE, PIER_WIDTH_FRAC).count +
          facadeRhythm(L, 'east', FCP_PITCH_MULTIPLE, PIER_WIDTH_FRAC).count,
        shaftPierPitchWu: facadeRhythm(L, 'south', FCP_PITCH_MULTIPLE, PIER_WIDTH_FRAC).pitch,
        megaFrameCourses: FCP_MEGAFRAME_FRACS.length,
        narrowestFeatureWu:
          2 * Math.min(facadeRhythm(L, 'south', FCP_PITCH_MULTIPLE, PIER_WIDTH_FRAC).halfWidth, COLONNADE_HALF_W_WU),
      }),
    },
    buildGeometry: build,
  };
}

// =====================================================================================================
// 2 — SCOTIA PLAZA: Napoleon Red granite, a stepped/sawtooth elevation, a recessed crown
// =====================================================================================================
//
// R48 verified: deep red "Napoleon Red" granite (Swedish quarry, Italian finishing, postmodern
// 1988); a distinctive STEPPED / SAWTOOTH profile on the north and south faces, engineered to
// maximise corner offices (12+ per floor); a crown that is a large sculpted RECESS punctuated with
// latticework; a corner entry with sawtooth curtain wall.
//
// STREET READ: the south elevation is the sawtooth (the researched face, and camera-visible — the
// north one is the same feature on a face the rig can never show, so it is not built), the east
// elevation keeps a plain granite pier rhythm, and the entry is at the SOUTH-EAST corner where the
// two meet. Its crown is the only recessed one of the six.

const SCOTIA_RENDER_FRAC = 0.88;
const SCOTIA_PODIUM_STOREYS = 1.5;
/** Both elevations sit on the window pitch: the researched sawtooth on the south (a tooth per
 * window column, standing alone in its bay), plain granite piers on the east return. */
const SCOTIA_PITCH_MULTIPLE = 1;
/** Half-width of one crown lattice fin (wu). */
const SCOTIA_FIN_HALF_W_WU = 0.35;
/** How deep the crown's sculpted recess cuts into the south + east faces of the crown mass (wu). */
const SCOTIA_CROWN_RECESS_WU = 2.4;
const SCOTIA_CROWN_LATTICE_FINS = 4;

export function buildScotiaPlazaBespoke(placement: NamedPlacement): NamedBespoke {
  const L = towerLayout(placement, SCOTIA_RENDER_FRAC, SCOTIA_PODIUM_STOREYS);
  const build = (): NamedBespokeGeometry => {
    const acc = createAccum();
    appendPodium(acc, L, 'south');
    const shaftY0 = L.podiumTopY;
    const shaftY1 = L.shaftTopY - COURSE_H_WU;
    const teeth = facadeRhythm(L, 'south', SCOTIA_PITCH_MULTIPLE, TOOTH_WIDTH_FRAC);
    const eastPiers = facadeRhythm(L, 'east', SCOTIA_PITCH_MULTIPLE, PIER_WIDTH_FRAC);
    appendSawtoothFace(acc, L, 'south', teeth, SAWTOOTH_DEPTH_WU, shaftY0, shaftY1, L.light, L.dark);
    appendPierRow(acc, L, { face: 'east', count: eastPiers.count, halfWidth: eastPiers.halfWidth, bury: SHAFT_BURY_WU, depth: SHAFT_PIER_DEPTH_WU, y0: shaftY0, y1: shaftY1, hex: L.light });
    appendCornerPier(acc, L, eastPiers.halfWidth, shaftY0, shaftY1, L.light);
    appendCourse(acc, L, shaftY1, L.shaftTopY, SAWTOOTH_DEPTH_WU + 0.15, L.dark);
    // THE SCULPTED CROWN — the researched "large recess punctuated with latticework", and the only
    // non-flat crown of the six. A full-footprint granite drum, then an upper block CUT BACK on the
    // two camera-visible faces, with lattice fins standing in the notch that cut leaves behind.
    const crownY0 = L.renderTopY;
    const drumTopY = crownY0 + 0.35 * (L.height - crownY0);
    const notchTopY = L.height - CROWN_DECK_H_WU;
    const inset = CROWN_INSET_WU;
    const drumHalfX = L.box.hx - inset;
    const drumHalfZ = L.box.hz - inset;
    addBox(acc, L.box.cx, (crownY0 + drumTopY) / 2, L.box.cz, drumHalfX, (drumTopY - crownY0) / 2, drumHalfZ, L.light);
    const cut = SCOTIA_CROWN_RECESS_WU / 2;
    addBox(
      acc,
      L.box.cx - cut,
      (drumTopY + notchTopY) / 2,
      L.box.cz - cut,
      drumHalfX - cut,
      (notchTopY - drumTopY) / 2,
      drumHalfZ - cut,
      L.dark,
    );
    // The latticework, quoted on the south elevation only: it is a crown-band detail, so a second
    // row on the east return would double its cost for a face the recess already reads on.
    const finY1 = notchTopY - 0.4;
    const finSpan = 2 * drumHalfX - 2 * FACE_MARGIN_WU;
    for (let i = 0; i < SCOTIA_CROWN_LATTICE_FINS; i++) {
      const t = (i + 0.5) / SCOTIA_CROWN_LATTICE_FINS;
      addBox(
        acc,
        L.box.cx - drumHalfX + FACE_MARGIN_WU + t * finSpan,
        (drumTopY + finY1) / 2,
        L.box.cz + drumHalfZ - SCOTIA_FIN_HALF_W_WU,
        SCOTIA_FIN_HALF_W_WU,
        (finY1 - drumTopY) / 2,
        SCOTIA_FIN_HALF_W_WU,
        L.light,
        // Open air above a fin: its top face is built (see PierRow.capped).
        { nz: false, nx: false },
      );
    }
    addBox(
      acc,
      L.box.cx - cut,
      (notchTopY + L.height) / 2,
      L.box.cz - cut,
      drumHalfX - cut - CROWN_DECK_INSET_WU,
      CROWN_DECK_H_WU / 2,
      drumHalfZ - cut - CROWN_DECK_INSET_WU,
      L.light,
    );
    const total = triangleCount(acc);
    return { geometry: toGeometry(acc, false), triangles: total, parts: [{ id: L.id, triangles: total }] };
  };
  return {
    id: placement.id,
    renderBoxes: [{ ...L.box, hy: L.renderTopY / 2 }],
    renderGroup: FINANCIAL_NORTH_RENDER_GROUP,
    signQuads: [],
    extraClaims: [],
    extraColliders: [],
    meta: {
      topY: L.height,
      probes: towerProbes(L, {
        sawtoothTeeth: facadeRhythm(L, 'south', SCOTIA_PITCH_MULTIPLE, TOOTH_WIDTH_FRAC).count,
        sawtoothPitchWu: facadeRhythm(L, 'south', SCOTIA_PITCH_MULTIPLE, TOOTH_WIDTH_FRAC).pitch,
        sawtoothDepthWu: SAWTOOTH_DEPTH_WU,
        eastPiers: facadeRhythm(L, 'east', SCOTIA_PITCH_MULTIPLE, PIER_WIDTH_FRAC).count,
        crownRecessWu: SCOTIA_CROWN_RECESS_WU,
        crownLatticeFins: SCOTIA_CROWN_LATTICE_FINS,
        narrowestFeatureWu:
          2 * Math.min(facadeRhythm(L, 'east', SCOTIA_PITCH_MULTIPLE, PIER_WIDTH_FRAC).halfWidth, COLONNADE_HALF_W_WU, SCOTIA_FIN_HALF_W_WU),
      }),
    },
    buildGeometry: build,
  };
}

// =====================================================================================================
// 3 — TD BANK TOWER: Mies, matte black steel + bronze glass, and the BANKING PAVILION
// =====================================================================================================
//
// R48 verified: TD Centre (Mies van der Rohe, 1967–69) is THREE buildings — the 56-storey tower, a
// SINGLE-STOREY banking pavilion, and the Royal Trust Tower; bronze-tinted glass and black-painted
// steel; three volumes offset on a rigid proportional grid; street level is the banking pavilion on
// a public plaza (1972 Pei forecourt redesign).
//
// STREET READ: restraint. Mies is proportion, not ornament, so this tower gets the finest and most
// regular mullion grid of the six (22 per elevation of 0.48 wu steel, the closest this kit comes to
// an I-beam curtain wall) over a recessed ground-floor loggia — and no cornice, no vestibule
// flourish, no crown but a parapet. The DISTINCTION at street level is the pavilion: a separate,
// low, glass-and-steel building standing on the plaza between the tower and Front Street, which is
// the part of TD Centre a driver actually passes.

const TD_RENDER_FRAC = 0.92;
const TD_PODIUM_STOREYS = 1.5;
/** One mullion per window column, like FCP — but Mies's section is FINE, so it takes barely a sixth
 * of its bay where FCP's pier takes a third. That width difference, on the same pitch, is what a
 * driver reads between two black-and-white towers three blocks apart. */
const TD_PITCH_MULTIPLE = 1;
const TD_MULLION_WIDTH_FRAC = 0.17;
/** Loggia column half-width (wu) — structural, so twice the mullion. */
const TD_COLUMN_HALF_W_WU = 0.45;
/** Granite plinth: how far it stands proud and how tall it is (wu). */
const TD_PLINTH_PROUD_WU = 0.9;
const TD_PLINTH_H_WU = 0.6;
/** The pavilion, entirely in proportions of the tower's own footprint — no world literals. */
const TD_PAVILION = {
  /** Gap between the tower's south wall and the pavilion's north wall (the plaza). */
  revealFrac: 0.2,
  halfWidthFrac: 0.8,
  halfDepthFrac: 0.42,
  /** VERIFIED: one storey. The wu height is DERIVED — 1.6 × the city's own storey module, i.e. a
   * grand banking-hall storey rather than an office floor. The storey count is the researched fact;
   * this multiplier is stated, not researched. */
  storeys: 1.6,
  /** How far the plinth stands proud of the glass box on every side. */
  plinthProudWu: 0.7,
  plinthHWu: 0.35,
  roofProudWu: 0.5,
  roofHWu: 0.45,
  /** Steel columns per camera-visible elevation (`appendMassPiers` lays the same count on both). */
  columnsPerFace: 6,
  columnHalfWu: 0.3,
} as const;

interface TdPavilion {
  readonly rect: MassRect;
  readonly claim: MassRect;
  readonly height: number;
}

function tdPavilion(L: TowerLayout): TdPavilion {
  const hx = TD_PAVILION.halfWidthFrac * L.box.hx;
  const hz = TD_PAVILION.halfDepthFrac * L.box.hx;
  const north = L.zMax + TD_PAVILION.revealFrac * L.box.hx;
  const rect: MassRect = { cx: L.box.cx, cz: north + hz, hx, hz };
  const grow = TD_PAVILION.plinthProudWu;
  return {
    rect,
    claim: { cx: rect.cx, cz: rect.cz, hx: hx + grow, hz: hz + grow },
    height: TD_PAVILION.storeys * STOREY_WU,
  };
}

export function buildTdBankTowerBespoke(placement: NamedPlacement): NamedBespoke {
  const L = towerLayout(placement, TD_RENDER_FRAC, TD_PODIUM_STOREYS);
  const pavilion = tdPavilion(L);
  const build = (): NamedBespokeGeometry => {
    const acc = createAccum();
    // NO PODIUM. The ground floor of a Mies tower stands BEHIND its columns, and a render box is a
    // solid — nothing can be carved INTO it, so a "recessed lobby" would simply be invisible inside
    // the box. What is left is what Mies actually built: a granite plinth and a colonnade of black
    // steel columns standing off the wall, with the §4 facade texture reading as the glass behind.
    const loggiaTopY = L.podiumTopY;
    appendBaseBlock(acc, L, TD_PLINTH_PROUD_WU, 0, TD_PLINTH_H_WU, tint(L.fill, 0.8));
    for (const face of ['south', 'east'] as const) {
      appendPierRow(acc, L, {
        face,
        count: bayCount(L, face, COLONNADE_PITCH_WU),
        halfWidth: TD_COLUMN_HALF_W_WU,
        depth: 0.7,
        y0: 0,
        y1: loggiaTopY,
        hex: L.light,
      });
    }
    appendCourse(acc, L, loggiaTopY, loggiaTopY + COURSE_H_WU, 0.85, BRONZE);
    const shaftY0 = loggiaTopY + COURSE_H_WU;
    const shaftY1 = L.shaftTopY - COURSE_H_WU;
    for (const face of ['south', 'east'] as const) {
      const rhythm = facadeRhythm(L, face, TD_PITCH_MULTIPLE, TD_MULLION_WIDTH_FRAC);
      appendPierRow(acc, L, { face, count: rhythm.count, halfWidth: rhythm.halfWidth, bury: SHAFT_BURY_WU, depth: 0.45, y0: shaftY0, y1: shaftY1, hex: L.light });
    }
    appendCornerPier(acc, L, facadeRhythm(L, 'south', TD_PITCH_MULTIPLE, TD_MULLION_WIDTH_FRAC).halfWidth, shaftY0, shaftY1, L.light);
    appendCourse(acc, L, shaftY1, L.shaftTopY, 0.6, BRONZE);
    appendFlatCrown(acc, L, CROWN_INSET_WU, L.light, tint(L.fill, 1.6));
    const tower = triangleCount(acc);

    // --- the banking pavilion ---------------------------------------------------------------------
    const p = pavilion;
    const glassTopY = TD_PAVILION.plinthHWu + p.height - TD_PAVILION.roofHWu;
    appendMassBox(acc, p.claim, 0, TD_PAVILION.plinthHWu, tint(L.fill, 1.9));
    appendMassBox(acc, p.rect, TD_PAVILION.plinthHWu, glassTopY, mix(L.glow, L.fill, LOBBY_CAST));
    appendMassPiers(acc, p.rect, TD_PAVILION.columnsPerFace, TD_PAVILION.columnHalfWu, 0.45, TD_PAVILION.plinthHWu, glassTopY, L.light, true);
    appendMassBox(
      acc,
      { cx: p.rect.cx, cz: p.rect.cz, hx: p.rect.hx + TD_PAVILION.roofProudWu, hz: p.rect.hz + TD_PAVILION.roofProudWu },
      glassTopY,
      TD_PAVILION.plinthHWu + p.height,
      L.fill,
    );
    const total = triangleCount(acc);
    return {
      geometry: toGeometry(acc, false),
      triangles: total,
      parts: [
        { id: L.id, triangles: tower },
        { id: 'td-banking-pavilion', triangles: total - tower },
      ],
    };
  };
  const claimTop = TD_PAVILION.plinthHWu + pavilion.height;
  return {
    id: placement.id,
    renderBoxes: [{ ...L.box, hy: L.renderTopY / 2 }],
    renderGroup: FINANCIAL_SOUTH_RENDER_GROUP,
    signQuads: [],
    extraClaims: [
      {
        id: 'td-banking-pavilion',
        kind: 'namedBuilding',
        aabb: {
          minX: pavilion.claim.cx - pavilion.claim.hx,
          maxX: pavilion.claim.cx + pavilion.claim.hx,
          minZ: pavilion.claim.cz - pavilion.claim.hz,
          maxZ: pavilion.claim.cz + pavilion.claim.hz,
        },
        yRange: [0, claimTop],
      },
    ],
    extraColliders: [
      {
        id: 'td-banking-pavilion',
        cx: pavilion.claim.cx,
        cy: claimTop / 2,
        cz: pavilion.claim.cz,
        hx: pavilion.claim.hx,
        hy: claimTop / 2,
        hz: pavilion.claim.hz,
      },
    ],
    meta: {
      topY: L.height,
      probes: towerProbes(L, {
        mullions: facadeRhythm(L, 'south', TD_PITCH_MULTIPLE, TD_MULLION_WIDTH_FRAC).count +
          facadeRhythm(L, 'east', TD_PITCH_MULTIPLE, TD_MULLION_WIDTH_FRAC).count,
        mullionPitchWu: facadeRhythm(L, 'south', TD_PITCH_MULTIPLE, TD_MULLION_WIDTH_FRAC).pitch,
        loggiaColumns: bayCount(L, 'south', COLONNADE_PITCH_WU) + bayCount(L, 'east', COLONNADE_PITCH_WU),
        narrowestFeatureWu:
          2 * Math.min(facadeRhythm(L, 'south', TD_PITCH_MULTIPLE, TD_MULLION_WIDTH_FRAC).halfWidth, TD_PAVILION.columnHalfWu),
        loggiaTopY: L.podiumTopY,
        pavilionHeight: claimTop,
        pavilionMinZ: pavilion.claim.cz - pavilion.claim.hz,
        pavilionMaxZ: pavilion.claim.cz + pavilion.claim.hz,
        pavilionMinX: pavilion.claim.cx - pavilion.claim.hx,
        pavilionMaxX: pavilion.claim.cx + pavilion.claim.hx,
        pavilionStoreys: TD_PAVILION.storeys,
      }),
    },
    buildGeometry: build,
  };
}

// =====================================================================================================
// 4 — COMMERCE COURT: Pei's 1972 stainless slab (WEST) + the 1931 Art Deco tower (NORTH)
// =====================================================================================================
//
// R48 verified (west): I.M. Pei & Partners 1972; stainless steel and grey-tinted glass curtain wall;
// rectangular tower in a plaza-focused complex; flat minimal crown; a 50 × 50 m public plaza
// forecourt with the banking entry — surrounding the separate 1931 Art Deco tower.
// R48 verified (north): Darling & Pearson 1931, 34 storeys / 137 m, Canada's tallest until 1962;
// limestone-clad with extensive ornate carved stonework. UNVERIFIED and therefore NOT modelled: the
// pyramidal observatory crown with carved heads — the researcher round could not confirm the
// exterior crown geometry, so this ships a stepped Art Deco setback cap and says so here rather
// than inventing the real one (Phase 44 beacon-cadence / Phase 46 Union-clock precedent).
//
// STREET READ: the WEST tower's stainless piers are wider and fewer than FCP's white ones and carry
// no mega-frame — Pei's slab is a plain, taut grid — and its podium is deliberately shallow, because
// the researched street event on this lot is the PLAZA. Standing in that plaza, on the King Street
// frontage where the real one is, is Commerce Court North: a 23.5 wu limestone Art Deco tower with
// its own claim, its own collider and its own height straight out of the data.
//
// THIS is the one builder that takes the seam's `ctx`: Commerce North's south facade flushes to King
// Street's ribbon edge exactly the way Union Station's moat derives off Front Street's, because "how
// much room is there on the King frontage" is a fact about the street table, not about the tower.

const CCW_RENDER_FRAC = 0.92;
const CCW_PODIUM_STOREYS = 1.4;
/** Pei's 1972 slab is a plain, TAUT structural grid, not a mullion rhythm: one bay per TWO window
 * columns, with a correspondingly broad stainless pier in each. Three deep bays per elevation is
 * the whole articulation — the opposite temperament from First Canadian Place's six, three blocks
 * north on the same street, and the difference is legible at a glance. */
const CCW_PITCH_MULTIPLE = 2;
const CCW_PIER_WIDTH_FRAC = 0.28;
/** Commerce North's limestone piers (wu). */
const CCN_PIER_HALF_W_WU = 0.4;
/** Commerce North: gap (wu) its south facade keeps off King's ribbon edge. namedBuildings.ts's own
 * FLUSH_GAP_WU — the §5 "2–4 wu" band — so the 1931 tower walls King exactly like every flushed
 * named building walls its street. */
const CCN_FLUSH_GAP_WU = 3;
/** The minimum forecourt (wu) that must survive between the two towers, or the layout throws
 * rather than quietly burying the 1931 building in Pei's slab. */
const CCN_MIN_PLAZA_WU = 4;
const CCN_PIERS_PER_FACE = 9;
const CCN_SETBACKS = 3;
/** Plan lost off each camera-visible face per Art Deco setback step (wu). */
const CCN_SETBACK_STEP_WU = 0.9;
/** Depth of Commerce North's limestone piers and, derived from it, how far they project past the
 * wall they ride. The claim + collider are inflated by that projection: GEOMETRY NEVER OVERHANGS
 * ITS OWN CLAIM (unionStation.ts's shed rule — the arbiter's whole premise is that a claim is the
 * ground a thing actually occupies). */
const CCN_PIER_DEPTH_WU = 0.55;
const CCN_PIER_PROUD_WU = CCN_PIER_DEPTH_WU - SHAFT_BURY_WU;

interface CommerceNorth {
  /** The 1931 tower's WALL footprint — `footprint_wu` from the data, exactly. */
  readonly rect: MassRect;
  /** `rect` inflated by the pier projection: the claim + collider footprint. */
  readonly claim: MassRect;
  readonly height: number;
  readonly fill: string;
}

function streetById(streets: readonly Street[], id: string): Street {
  const st = streets.find((s) => s.id === id);
  if (st === undefined) throw new Error(`financialTowers: street "${id}" not in the built table`);
  return st;
}

function commerceNorth(L: TowerLayout, ctx: NamedGeometryCtx): CommerceNorth {
  const spec = secondarySpec('commerce-court-north');
  const half = spec.footprint_wu / 2;
  const outerHalf = half + CCN_PIER_PROUD_WU;
  const king = streetById(ctx.streets, 'king');
  // The CLAIM's south edge takes the flush gap (that is the edge the street actually meets), so the
  // wall itself sits one pier projection further back.
  const south = king.ribbon.minY - CCN_FLUSH_GAP_WU - CCN_PIER_PROUD_WU;
  const north = south - 2 * half;
  if (north - CCN_PIER_PROUD_WU - L.zMax < CCN_MIN_PLAZA_WU) {
    throw new Error('financialTowers: the King frontage cannot hold Commerce Court North + its plaza');
  }
  // West facade aligned with Pei's own west wall — which namedBuildings flushed to Bay Street, so
  // the 1931 tower lands on the King × Bay corner, where it stands.
  const rect: MassRect = { cx: L.xMin + outerHalf, cz: (north + south) / 2, hx: half, hz: half };
  return {
    rect,
    claim: { cx: rect.cx, cz: rect.cz, hx: outerHalf, hz: outerHalf },
    height: namedHeight(spec.real_h_m),
    fill: lookForMaterial(spec.material).fill,
  };
}

export function buildCommerceCourtBespoke(placement: NamedPlacement, ctx: NamedGeometryCtx): NamedBespoke {
  const L = towerLayout(placement, CCW_RENDER_FRAC, CCW_PODIUM_STOREYS);
  const north = commerceNorth(L, ctx);
  const build = (): NamedBespokeGeometry => {
    const acc = createAccum();
    appendPodium(acc, L, 'south');
    const shaftY0 = L.podiumTopY;
    const shaftY1 = L.shaftTopY - COURSE_H_WU;
    for (const face of ['south', 'east'] as const) {
      const rhythm = facadeRhythm(L, face, CCW_PITCH_MULTIPLE, CCW_PIER_WIDTH_FRAC);
      appendPierRow(acc, L, { face, count: rhythm.count, halfWidth: rhythm.halfWidth, bury: SHAFT_BURY_WU, depth: SHAFT_PIER_DEPTH_WU, y0: shaftY0, y1: shaftY1, hex: L.light });
    }
    appendCornerPier(acc, L, facadeRhythm(L, 'south', CCW_PITCH_MULTIPLE, CCW_PIER_WIDTH_FRAC).halfWidth, shaftY0, shaftY1, L.light);
    appendCourse(acc, L, shaftY1, L.shaftTopY, SHAFT_COURSE_PROUD_WU, L.dark);
    appendFlatCrown(acc, L, CROWN_INSET_WU, L.light, L.dark);
    const west = triangleCount(acc);

    // --- Commerce Court North (1931) ----------------------------------------------------------------
    const n = north;
    const stone = n.fill;
    const stoneLight = tint(stone, 1.22);
    const stoneDark = tint(stone, 0.68);
    const baseTopY = 1.4 * STOREY_WU;
    // Setback stack: the Art Deco silhouette — each step loses a fixed slice of plan and the top
    // one carries the cap. The observatory crown is deliberately absent (see this section's header).
    const shaftTopN = baseTopY + 0.62 * (n.height - baseTopY);
    appendMassBox(acc, n.rect, 0, baseTopY, stoneDark);
    appendMassBox(acc, n.rect, baseTopY, shaftTopN, stone);
    // The setback above is cut back further than these piers project, so their tops are exposed.
    appendMassPiers(acc, n.rect, CCN_PIERS_PER_FACE, CCN_PIER_HALF_W_WU, CCN_PIER_DEPTH_WU, baseTopY, shaftTopN, stoneLight, false);
    // Each step loses CCN_SETBACK_STEP_WU of plan off the two camera-visible faces alone (the
    // centre slides with the half-extent, so the north and west walls stay put — a setback the rig
    // can see costs half of what a concentric one costs).
    let y = shaftTopN;
    let inset = 0;
    const step = (rect: MassRect, cut: number): MassRect => ({
      cx: rect.cx - cut / 2,
      cz: rect.cz - cut / 2,
      hx: rect.hx - cut / 2,
      hz: rect.hz - cut / 2,
    });
    for (let i = 0; i <= CCN_SETBACKS; i++) {
      const y1 = i === CCN_SETBACKS ? n.height : y + (n.height - shaftTopN) / (CCN_SETBACKS + 1);
      inset += CCN_SETBACK_STEP_WU;
      appendMassBox(acc, step(n.rect, inset), y, y1, i % 2 === 0 ? stoneLight : stoneDark);
      y = y1;
    }
    const total = triangleCount(acc);
    return {
      geometry: toGeometry(acc, false),
      triangles: total,
      parts: [
        { id: L.id, triangles: west },
        { id: 'commerce-court-north', triangles: total - west },
      ],
    };
  };
  return {
    id: placement.id,
    renderBoxes: [{ ...L.box, hy: L.renderTopY / 2 }],
    renderGroup: FINANCIAL_NORTH_RENDER_GROUP,
    signQuads: [],
    extraClaims: [
      {
        id: 'commerce-court-north',
        kind: 'namedBuilding',
        aabb: {
          minX: north.claim.cx - north.claim.hx,
          maxX: north.claim.cx + north.claim.hx,
          minZ: north.claim.cz - north.claim.hz,
          maxZ: north.claim.cz + north.claim.hz,
        },
        yRange: [0, north.height],
      },
    ],
    extraColliders: [
      {
        id: 'commerce-court-north',
        cx: north.claim.cx,
        cy: north.height / 2,
        cz: north.claim.cz,
        hx: north.claim.hx,
        hy: north.height / 2,
        hz: north.claim.hz,
      },
    ],
    meta: {
      topY: L.height,
      probes: towerProbes(L, {
        shaftPiers: facadeRhythm(L, 'south', CCW_PITCH_MULTIPLE, CCW_PIER_WIDTH_FRAC).count +
          facadeRhythm(L, 'east', CCW_PITCH_MULTIPLE, CCW_PIER_WIDTH_FRAC).count,
        shaftPierPitchWu: facadeRhythm(L, 'south', CCW_PITCH_MULTIPLE, CCW_PIER_WIDTH_FRAC).pitch,
        northHeight: north.height,
        northMinX: north.claim.cx - north.claim.hx,
        northMaxX: north.claim.cx + north.claim.hx,
        northMinZ: north.claim.cz - north.claim.hz,
        northMaxZ: north.claim.cz + north.claim.hz,
        northPiers: 2 * CCN_PIERS_PER_FACE,
        narrowestFeatureWu: 2 * Math.min(COLONNADE_HALF_W_WU, CCN_PIER_HALF_W_WU),
        northSetbacks: CCN_SETBACKS,
        plazaDepth: north.claim.cz - north.claim.hz - L.zMax,
      }),
    },
    buildGeometry: build,
  };
}

// =====================================================================================================
// 5 — ROYAL BANK PLAZA: gold glass, a SERRATED facade, a 40-metre glass banking hall
// =====================================================================================================
//
// R48 verified: gold-bronze reflective glass incorporating 24-carat gold leaf (~2,500 oz across
// 14,000 windows); dual triangular towers connected by a 40 m glass atrium; a flat/minimal crown;
// a DISTINCTIVE SERRATED / SAWTOOTH facade profile reflecting the surrounding cityscape; street
// level is a large glass-walled banking hall atrium framed by the towers.
//
// STREET READ: the serration, on BOTH camera-visible elevations — it is this tower's identity and
// the one feature that has to survive at 20 wu, so it gets more teeth than Scotia's single face and
// runs from the atrium head all the way to the crown course. Below it the atrium: a tall (2.2
// storey) glazed volume standing proud of the tower with a gold-leaf head band, which is what makes
// this the only one of the six whose base is GLASS rather than stone.

const RBC_RENDER_FRAC = 0.91;
const RBC_ATRIUM_STOREYS = 2.2;
/** The serration runs on BOTH camera-visible elevations — it is this tower's whole identity — one
 * tooth per window column, each standing alone in its bay so the gold glass between them survives. */
const RBC_PITCH_MULTIPLE = 1;
/** The atrium's frame is METAL, not stone, so its mullions are finer and closer than a podium
 * colonnade's: a 40 m glass banking hall reads as a glazed wall with a frame, not as an arcade. */
const RBC_ATRIUM_PITCH_WU = 1.15;
const RBC_ATRIUM_MULLION_HALF_W_WU = 0.3;

export function buildRoyalBankPlazaBespoke(placement: NamedPlacement): NamedBespoke {
  const L = towerLayout(placement, RBC_RENDER_FRAC, RBC_ATRIUM_STOREYS);
  const build = (): NamedBespokeGeometry => {
    const acc = createAccum();
    // The atrium IS the podium here: the block is the glazing and the mullions in front of it are
    // the frame, so a 40 m glass banking hall costs one box and a pier row.
    const headY0 = L.podiumTopY - PODIUM_CORNICE_H_WU;
    appendBaseBlock(acc, L, PODIUM_PROUD_WU, 0, headY0, mix(L.glow, L.fill, LOBBY_CAST));
    for (const face of ['south', 'east'] as const) {
      appendPierRow(acc, L, {
        face,
        count: bayCount(L, face, RBC_ATRIUM_PITCH_WU),
        halfWidth: RBC_ATRIUM_MULLION_HALF_W_WU,
        wallProud: PODIUM_PROUD_WU,
        bury: COLONNADE_BURY_WU,
        depth: COLONNADE_DEPTH_WU,
        y0: 0,
        y1: headY0,
        hex: GOLD_LEAF,
      });
    }
    // The gold-leaf head band — the verified material, used where it can actually be seen.
    appendCourse(acc, L, headY0, L.podiumTopY, PODIUM_CORNICE_PROUD_WU, GOLD_LEAF);
    appendVestibule(acc, L, 'south', VESTIBULE_HALF_W_FRAC * L.box.hx, headY0 - 1.1, L.glow, GOLD_LEAF);
    const shaftY0 = L.podiumTopY;
    const shaftY1 = L.shaftTopY - COURSE_H_WU;
    for (const face of ['south', 'east'] as const) {
      appendSawtoothFace(acc, L, face, facadeRhythm(L, face, RBC_PITCH_MULTIPLE, TOOTH_WIDTH_FRAC), SAWTOOTH_DEPTH_WU, shaftY0, shaftY1, L.light, L.dark);
    }
    appendCornerPier(acc, L, RBC_ATRIUM_MULLION_HALF_W_WU, shaftY0, shaftY1, GOLD_LEAF);
    appendCourse(acc, L, shaftY1, L.shaftTopY, SAWTOOTH_DEPTH_WU + 0.15, GOLD_LEAF);
    appendFlatCrown(acc, L, CROWN_INSET_WU, L.light, GOLD_LEAF);
    const total = triangleCount(acc);
    return { geometry: toGeometry(acc, false), triangles: total, parts: [{ id: L.id, triangles: total }] };
  };
  return {
    id: placement.id,
    renderBoxes: [{ ...L.box, hy: L.renderTopY / 2 }],
    renderGroup: FINANCIAL_SOUTH_RENDER_GROUP,
    signQuads: [],
    extraClaims: [],
    extraColliders: [],
    meta: {
      topY: L.height,
      probes: towerProbes(L, {
        teethPerFace: facadeRhythm(L, 'south', RBC_PITCH_MULTIPLE, TOOTH_WIDTH_FRAC).count,
        sawtoothPitchWu: facadeRhythm(L, 'south', RBC_PITCH_MULTIPLE, TOOTH_WIDTH_FRAC).pitch,
        sawtoothDepthWu: SAWTOOTH_DEPTH_WU,
        atriumTopY: L.podiumTopY,
        atriumMullions: bayCount(L, 'south', RBC_ATRIUM_PITCH_WU) + bayCount(L, 'east', RBC_ATRIUM_PITCH_WU),
        narrowestFeatureWu: 2 * RBC_ATRIUM_MULLION_HALF_W_WU,
      }),
    },
    buildGeometry: build,
  };
}

// =====================================================================================================
// 6 — CIBC SQUARE (81 Bay): blue glass, BANDED fenestration, an elevated park podium
// =====================================================================================================
//
// R48 verified: blue reflective glass with BANDED FENESTRATION; a rectangular modernist tower (dual
// south/north towers on the site — this placement is the south one, 241.3 m / 49 floors); street
// level is a podium plaza with a PARK OVER THE RAIL CORRIDOR (civic integration with the GO
// corridor below). UNVERIFIED, and flagged as such by the researcher: the sloped/angled top — "crown
// geometry details unverified". A modest shear ships here and this comment is the record that it is
// a stated reading, not a measured one.
//
// STREET READ: horizontal. Every other tower on this street is articulated with VERTICALS; this one
// is banded, and that opposite direction is the whole distinction — twelve proud spandrel courses
// wrapping both camera-visible elevations. Its podium top is the elevated park (planters standing on
// the deck, where no car can ever reach them), and its cap is the only sheared one of the six.

const CIBC_RENDER_FRAC = 0.87;
const CIBC_PODIUM_STOREYS = 1.5;
/**
 * Spandrel courses. AUTHORED, not pitch-derived, and this is the exception that proves the rule: a
 * course per baked FLOOR row (WINDOW_PATTERN.floorHeightWu = 3.4) would be three bands over the
 * whole shaft at this map's compressed heights, which does not read as banded fenestration at all.
 * A course is thin and horizontal, so it costs a few per cent of the face's area rather than a
 * third of its width — the open-face law is what bounds this number, and twelve clears it with
 * room. (This tower is the evidence battery's reference for "articulated but still glazed".)
 */
const CIBC_BANDS = 12;
const CIBC_BAND_H_WU = 0.4;
const CIBC_PLANTERS = 6;
/** How far the sheared cap's top rectangle slides north-west (wu) — the angled top. UNVERIFIED (see
 * this section's header): the direction is chosen so the slope faces the camera's own quadrant,
 * which is the only way a shear is visible at all under a fixed bearing. */
const CIBC_CAP_SHEAR_WU = 2.6;
/** The elevated park's guardrail: posts standing on the podium cornice, per camera-visible face. */
const CIBC_RAIL_POSTS = 8;
const CIBC_RAIL_H_WU = 0.85;
const CIBC_RAIL_POST_HALF_W_WU = 0.24;
/** Planter half-extents + height above the deck (wu). */
const CIBC_PLANTER_HALF_X_WU = 1.05;
const CIBC_PLANTER_HALF_Z_WU = 0.75;
const CIBC_PLANTER_H_WU = 0.85;

export function buildCibcSquareBespoke(placement: NamedPlacement): NamedBespoke {
  const L = towerLayout(placement, CIBC_RENDER_FRAC, CIBC_PODIUM_STOREYS);
  const build = (): NamedBespokeGeometry => {
    const acc = createAccum();
    appendPodium(acc, L, 'south');
    // The elevated park: planters standing ON the podium deck. Deliberately up there rather than at
    // grade — the researched park really is over the rail corridor, and geometry on the deck can
    // never be clipped by a car (P37's curb-hop law makes a knee-high kerb at grade a defect).
    const parkY1 = L.podiumTopY + CIBC_PLANTER_H_WU;
    for (let i = 0; i < CIBC_PLANTERS; i++) {
      const t = (i + 0.5) / CIBC_PLANTERS;
      addBox(
        acc,
        L.xMin + FACE_MARGIN_WU + t * (2 * L.box.hx - 2 * FACE_MARGIN_WU),
        (L.podiumTopY + parkY1) / 2,
        L.zMax + PODIUM_CORNICE_PROUD_WU - 1.1,
        CIBC_PLANTER_HALF_X_WU,
        (parkY1 - L.podiumTopY) / 2,
        CIBC_PLANTER_HALF_Z_WU,
        // The one green in this file. Stated: the researched fact is "park", not a species list.
        '#3f6b4a',
        { nz: false, nx: false },
      );
    }
    // …and the park's guardrail, standing on the cornice's outer edge: the element that makes the
    // podium read as an occupied DECK rather than as a plinth, from the one angle the rig has
    // (looking down at 58°).
    for (const face of ['south', 'east'] as const) {
      appendPierRow(acc, L, {
        face,
        count: CIBC_RAIL_POSTS,
        halfWidth: CIBC_RAIL_POST_HALF_W_WU,
        wallProud: PODIUM_CORNICE_PROUD_WU - 0.55,
        depth: 0.5,
        y0: L.podiumTopY,
        y1: L.podiumTopY + CIBC_RAIL_H_WU,
        hex: L.light,
        // Nothing stands above a rooftop rail — its posts must be closed at the top.
        capped: false,
      });
    }
    const shaftY0 = L.podiumTopY;
    const shaftY1 = L.shaftTopY - COURSE_H_WU;
    const pitch = (shaftY1 - shaftY0) / CIBC_BANDS;
    for (let i = 0; i < CIBC_BANDS; i++) {
      const y0 = shaftY0 + i * pitch;
      appendCourse(acc, L, y0, y0 + CIBC_BAND_H_WU, 0.45, L.dark);
    }
    appendCourse(acc, L, shaftY1, L.shaftTopY, SHAFT_COURSE_PROUD_WU, L.light);
    // The sheared cap: full footprint at the render-box top, sliding north-west as it rises.
    addSkewBox(
      acc,
      L.renderTopY,
      L.height,
      { cx: L.box.cx, cz: L.box.cz, hx: L.box.hx - CROWN_INSET_WU, hz: L.box.hz - CROWN_INSET_WU },
      {
        cx: L.box.cx - CIBC_CAP_SHEAR_WU / 2,
        cz: L.box.cz - CIBC_CAP_SHEAR_WU / 2,
        hx: L.box.hx - CROWN_INSET_WU - CIBC_CAP_SHEAR_WU / 2,
        hz: L.box.hz - CROWN_INSET_WU - CIBC_CAP_SHEAR_WU / 2,
      },
      L.light,
      L.dark,
    );
    const total = triangleCount(acc);
    return { geometry: toGeometry(acc, false), triangles: total, parts: [{ id: L.id, triangles: total }] };
  };
  return {
    id: placement.id,
    renderBoxes: [{ ...L.box, hy: L.renderTopY / 2 }],
    renderGroup: FINANCIAL_SOUTH_RENDER_GROUP,
    signQuads: [],
    extraClaims: [],
    extraColliders: [],
    meta: {
      topY: L.height,
      probes: towerProbes(L, {
        bands: CIBC_BANDS,
        bandHeightWu: CIBC_BAND_H_WU,
        planters: CIBC_PLANTERS,
        capShearWu: CIBC_CAP_SHEAR_WU,
        narrowestFeatureWu: 2 * Math.min(CIBC_RAIL_POST_HALF_W_WU, COLONNADE_HALF_W_WU, CIBC_BAND_H_WU / 2),
      }),
    },
    buildGeometry: build,
  };
}

// --- probes -------------------------------------------------------------------------------------------

/** The numbers every tower publishes, plus that tower's own. `meta.probes` is
 * `Record<string, number>` by the seam's contract — numbers only, which is what keeps it type-safe
 * without an `any` and without a union every new builder has to edit. */
function towerProbes(L: TowerLayout, own: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return {
    dataHeight: L.height,
    renderTopY: L.renderTopY,
    renderHeightFrac: L.renderTopY / L.height,
    crownBandY0: L.band.y0,
    crownBandY1: L.band.y1,
    podiumTopY: L.podiumTopY,
    shaftTopY: L.shaftTopY,
    southFaceZ: L.zMax,
    eastFaceX: L.xMax,
    footprintHalfX: L.box.hx,
    footprintHalfZ: L.box.hz,
    maxProudWu: MAX_PROUD_WU,
    ...own,
  };
}
