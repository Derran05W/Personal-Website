// Phase 46 (Part 11) — UNION STATION v2, the first tenant of the `namedGeometryBuilders` seam.
//
// v1 was one extruded box: 74 × 12 wu of limestone with a window grid on it. Union is the most
// photographed classical facade in the country and the box read as a warehouse. v2 rebuilds it
// around the features the researcher round (2026-07-27, recorded in data/toronto/building-specs.json's
// `union-station` notes) actually verified:
//
//   • TWENTY-TWO Roman Tuscan columns across the Front Street facade, each 12 m tall, in Bedford
//     limestone — a central Doric colonnade block framed by 14 three-storey bays on each side;
//   • a sunken, BALUSTRADED carriageway ("the moat") running the FULL length of the Front facade,
//     between the street and the colonnade (today's TD Carriageway);
//   • a raised central Great Hall block behind the colonnade, which is where the height above the
//     wings comes from;
//   • the modern glass GO TRAIN SHED behind the headhouse — a translucent atrium on angled pillars
//     that floats above the platforms (2010s renovation; it replaced the original steel roof).
//
// EXPLICITLY NOT MODELLED: a Front Street facade clock. The researcher round could not verify one
// on any source, and the "stated, not invented" law (Phase 44's beacon-cadence precedent) makes
// that a scope DROP rather than a guess. The part file's "modest clock element" is resolved here.
//
// CAMERA LAW decides which of those features gets which treatment. The fixed rig only ever shows a
// box's SOUTH (+Z) and EAST (+X) faces (pinned Phase 24, re-derived Phase 34), and Union's true
// facade faces NORTH — so:
//   • the full 22-column colonnade goes on the north face, because that is the truth and it is what
//     the off-rig postcard frames (the Rogers Centre's north hotel strip, Phase 45, set the
//     precedent: a camera-invisible face is still worth building when it is the building's identity);
//   • the column rhythm WRAPS onto the east face, which IS camera-visible, so a drive-by down Bay
//     reads a colonnade rather than a wall;
//   • the south face — the long camera-visible elevation — carries the researched 14-bay rhythm as
//     proud PILASTERS (cheap, and the correct architectural quote), with its lower centre covered by
//     the GO shed anyway.
//
// THE MOAT is paint + balustrade, not a hole: a real recess needs a floor, two walls and a roofless
// void the camera can fall into, and Phase 39's own sunk-flush prototype proved an apertureless
// "hole" reads as nothing. The paint strip rides `GROUND_STACK.unionMoat` — the one rung that sits
// ABOVE the raised sidewalk band (see config/layering.ts) — and the balustrade is VISUAL-ONLY: a
// 1.15 wu collider in front of a building is exactly the sub-ride-height obstacle P37 proved the
// raycast vehicle CURB-HOPS, and the P25.8 curb verdict outranks the visual either way.
//
// SINGLE SOURCE OF TRUTH: every dimension below derives from the placement's own DATA box (which
// namedBuildings.ts computes from data/toronto/building-specs.json), from the street table, or from
// the reserved rail-lands strip. There is not one literal world coordinate in this file; the only
// literals are proportions, each carrying the reason it has the value it has.

import { GROUND_STACK, WALL_STACK } from '../../config/layering';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { SIDEWALK } from '../../config/torontoMap';
import { lookForMaterial } from '../../config/torontoMaterials';
import {
  addBox,
  addFace,
  addPrismY,
  createAccum,
  toGeometry,
  triangleCount,
  type Accum,
  type Vec3,
} from './bespokeMesh';
import type { NamedBox, NamedPlacement } from './namedBuildings';
import type {
  NamedBespoke,
  NamedBespokeGeometry,
  NamedExtraClaim,
  NamedExtraCollider,
  NamedGeometryCtx,
  NamedSignQuad,
} from './namedGeometry';
import { namedSignCellAspect } from './namedSignage';
import type { Street } from './streets';

// --- tri budgets (Part 11 rule 2: stated per model, pinned in the phase that introduces them) ------

/** Headhouse + colonnade + attic + moat paint + balustrade. Pinned by unionStation.test.ts, with a
 * FLOOR as well as a ceiling — a regression that quietly reverted v2 to the old box would pass a
 * ceiling-only budget (heroes.test.ts's idiom). */
export const UNION_STATION_MAX_TRIS = 900 as const;
/** The GO train shed behind the headhouse. Massing only — Phase 57 builds the corridor under it. */
export const GO_SHED_MAX_TRIS = 300 as const;

// --- proportions (the only literals; each one carries its reason) ----------------------------------

/** Wing (render-box) height as a fraction of the DATA height. The data height is the CENTRAL Great
 * Hall block; the flanking wings are lower, and shrinking the render box is what leaves room for a
 * bespoke attic that tops out at exactly the data height (so heightLaw, the claims and the camera
 * clip volumes — all of which read the DATA box — stay valid). */
const WING_HEIGHT_FRAC = 0.8;
/** Central block half-width as a fraction of the facade half-length. The real colonnade block spans
 * roughly the middle 45% of the 229 m facade (22 columns at ~4.5 m centres ≈ 100 m). */
const CENTRE_HALF_FRAC = 0.44;
/** Researcher-verified column count on the Front Street facade. */
const COLUMN_COUNT_NORTH = 22;
/** Columns wrapped onto the camera-visible EAST return. Four is what fits the 12 wu depth at the
 * north face's own centre pitch without crowding the corners. */
const COLUMN_COUNT_EAST = 4;
/** Researcher-verified bay count flanking the colonnade on each side — quoted onto the south
 * elevation as a pilaster rhythm. */
const PILASTER_COUNT_SOUTH = 14;
/** Column height as a fraction of the DATA height. The real shafts are 12 m of a 27 m building. */
const COLUMN_HEIGHT_FRAC = 0.46;
/**
 * Column circumradius (wu). To scale, a 1.2 m Tuscan shaft would be 0.19 wu — under
 * THIN_GEOMETRY.minStripeWidthWu and invisible past ~20 wu. This is a DELIBERATE up-scale for
 * legibility (0.84 wu ⌀ ≈ 2.6 m), the same call the rail-lands tie bands made: a landmark's
 * signature element ships at the width it can be SEEN at, and the law's floor is the hard minimum.
 */
const COLUMN_RADIUS_WU = 0.42;
/** How far a column's back is buried in the wall behind it (wu) — no flush base seam ever. */
const COLUMN_BURY_WU = 0.12;
/** Entablature band height above the colonnade (wu) — it also caps the columns, which is why the
 * column prisms pay no top-cap triangles. */
const ENTABLATURE_H_WU = 0.6;
/** Cornice / plinth projection past the wing wall (wu). Both stay far inside namedBuildings'
 * 3 wu exclusion margin, so no claim or collider changes. */
const CORNICE_PROUD_WU = 0.35;
const PLINTH_PROUD_WU = 0.25;
const PLINTH_H_WU = 0.55;
const CORNICE_H_WU = 0.65;
/** South pilaster projection + half-width (wu). */
const PILASTER_PROUD_WU = 0.35;
const PILASTER_HALF_W_WU = 0.45;
/** Attic (Great Hall clerestory) inset from the wing's own depth (wu), so its faces never share a
 * plane with the wing walls below (the Phase 42 anti-coplanar rule applied at the source). */
const ATTIC_INSET_WU = 0.7;
/** Clerestory glazing band: distance below the top for its bottom / its top (wu). */
const CLERESTORY_BOTTOM_BELOW_TOP_WU = 1.6;
const CLERESTORY_TOP_BELOW_TOP_WU = 0.6;
/** How far the attic's skirt reaches DOWN past the wing roofline (wu) — it plugs into the wing
 * instead of floating on it. */
const ATTIC_SKIRT_WU = 1.2;

/** Clearance (wu) the moat leaves between its street edge and Front's ribbon edge — the kerb. */
const MOAT_KERB_MARGIN_WU = 0.6;
/** Balustrade member dimensions (wu). Every one clears THIN_GEOMETRY.minStripeWidthWu; the test
 * asserts it rather than trusting the comment. */
const BALUSTRADE = {
  dadoHalfThick: 0.2,
  dadoTop: 0.7,
  railHalfThick: 0.27,
  railTop: 0.95,
  pierHalf: 0.31,
  pierTop: 1.15,
  /** Centre of the run, measured out from the moat's street edge. ≥ `pierHalf` by construction, so
   * the widest member still stands INSIDE the strip this layer claims (geometry never overhangs
   * its own claim — the arbiter's whole premise). */
  offsetFromKerb: 0.35,
  /** Two stair/bridge openings, at these fractions of the facade length, this wide (wu). */
  gapFracs: [0.3, 0.7] as const,
  gapWidth: 4,
} as const;

/** GO shed. Length is a fraction of the facade; depth/heights are absolute because the shed is a
 * platform canopy, not a facade element (its span is set by what it covers, not by the headhouse). */
const SHED = {
  lengthFrac: 0.66,
  revealWu: 0.9,
  depthWu: 9,
  springY: 2.6,
  crownY: 4.6,
  slabThickWu: 0.35,
  /** Facets across the arch (per x-strip) — 4 is where a 9 wu vault stops reading as a tent. */
  archFacets: 4,
  /** Structural rib strips along the length, and their width (wu). The bays between them are the
   * glass; ribs are part of the SAME cambered surface (adjacent, never overlapping), so there is no
   * proud lip to z-fight and no crack to see the culled interior through. */
  ribCount: 5,
  ribWidthWu: 0.9,
  /** Angled pillars per side. They lean INWARD as they rise (a wide base carrying a narrower span),
   * and both insets are chosen so a pillar's base — the widest part of its footprint — stays inside
   * the shed's own claimed/collided rectangle: geometry never overhangs its own claim. */
  pillarsPerSide: 4,
  pillarHalfWu: 0.28,
  pillarBaseInsetWu: 0.4,
  pillarTopInsetWu: 1.7,
  platformHWu: 0.35,
} as const;

// --- palette (unlit-literal; the §4 limestone look is the single source for the facade colour) -----

const LIMESTONE = lookForMaterial('limestone').fill;
const LIMESTONE_LIGHT = '#c8b382'; // columns / cornice / balustrade — proud elements read lighter
const LIMESTONE_SHADE = '#9a8455'; // plinth course + entablature — recessive, so the courses read
const CLERESTORY_GLASS = lookForMaterial('limestone').windowTint; // lit Great Hall clerestory
const MOAT_FLOOR = '#26241f'; // the sunken carriageway: dark = the drop reads as depth
const SHED_GLASS = '#a9bccb'; // translucent-READ panels (pale, unlit-literal)
const SHED_RIB = '#3c434c'; // the dark structure between the glass bays
const SHED_UNDER = '#2f353d'; // the slab's underside — darker than the ribs, so the float reads
const SHED_PILLAR = '#4a525c';
const SHED_PLATFORM = '#55585d';

// --- layout ----------------------------------------------------------------------------------------

interface Span {
  readonly min: number;
  readonly max: number;
}

interface UnionLayout {
  readonly box: NamedBox;
  readonly height: number;
  readonly x: Span;
  /** North face (the true Front Street facade) and south face, in world Z. */
  readonly zNorth: number;
  readonly zSouth: number;
  readonly wingTopY: number;
  readonly columnTopY: number;
  readonly centreHalfX: number;
  readonly colonnadeCentreZ: number;
  readonly eastColumnX: number;
  readonly eastColumnSpan: Span;
  readonly moat: { readonly x: Span; readonly z: Span; readonly paintY: number; readonly railZ: number };
  readonly shed: {
    readonly x: Span;
    readonly z: Span;
    readonly topY: number;
  };
}

function streetById(streets: readonly Street[], id: string): Street {
  const st = streets.find((s) => s.id === id);
  if (!st) throw new Error(`unionStation: street "${id}" not in the built table`);
  return st;
}

/** Resolve every derived dimension from the DATA box + the street table + the reserved strip. */
function unionLayout(placement: NamedPlacement, ctx: NamedGeometryCtx): UnionLayout {
  const box = placement.boxes[0];
  if (box === undefined) throw new Error('unionStation: placement has no data box');
  const height = box.hy * 2;
  const x: Span = { min: box.cx - box.hx, max: box.cx + box.hx };
  const zNorth = box.cz - box.hz;
  const zSouth = box.cz + box.hz;

  // The moat lives in the flush gap namedBuildings.ts left between Union's facade and Front's
  // ribbon edge. DERIVED, never re-typed: if a future frontage change closes that gap, this throws
  // instead of silently painting a strip across the roadway.
  const front = streetById(ctx.streets, 'front');
  const kerbZ = front.ribbon.maxY + MOAT_KERB_MARGIN_WU;
  if (kerbZ >= zNorth - THIN_GEOMETRY.minStripeWidthWu) {
    throw new Error('unionStation: no room between Front\'s kerb and the facade for the moat strip');
  }

  // The GO shed reaches INTO the Phase-45 rail-lands strip (the reserved corridor room), clamped so
  // it can never poke out of the far side of it.
  const shedNorth = zSouth + SHED.revealWu;
  const shedSouth = Math.min(shedNorth + SHED.depthWu, ctx.strip.maxY - SHED.depthWu);
  const shedHalfX = Math.min(
    SHED.lengthFrac * box.hx,
    ctx.strip.maxX - box.cx - SHED.revealWu,
    box.cx - ctx.strip.minX - SHED.revealWu,
  );
  if (shedSouth <= shedNorth || shedHalfX <= 0) throw new Error('unionStation: the rail strip cannot hold the GO shed');

  return {
    box,
    height,
    x,
    zNorth,
    zSouth,
    wingTopY: WING_HEIGHT_FRAC * height,
    columnTopY: COLUMN_HEIGHT_FRAC * height,
    centreHalfX: CENTRE_HALF_FRAC * box.hx,
    colonnadeCentreZ: zNorth - COLUMN_RADIUS_WU + COLUMN_BURY_WU,
    eastColumnX: x.max + COLUMN_RADIUS_WU - COLUMN_BURY_WU,
    eastColumnSpan: { min: zNorth + 1.5, max: zSouth - 1.5 },
    moat: {
      x,
      z: { min: kerbZ, max: zNorth },
      paintY: GROUND_STACK.unionMoat,
      railZ: kerbZ + BALUSTRADE.offsetFromKerb,
    },
    shed: {
      x: { min: box.cx - shedHalfX, max: box.cx + shedHalfX },
      z: { min: shedNorth, max: shedSouth },
      topY: SHED.crownY,
    },
  };
}

// --- the headhouse ------------------------------------------------------------------------------------

function appendHeadhouse(acc: Accum, L: UnionLayout): void {
  const { box, height, x, zNorth, zSouth, wingTopY } = L;
  const walkTop = SIDEWALK.curbHeightWu;

  // Plinth course + wing cornice: two proud bands that give the long elevation a top and a bottom
  // (a 74 wu wall without them reads as a shipping container at any distance).
  addBox(acc, box.cx, PLINTH_H_WU / 2, box.cz, box.hx + PLINTH_PROUD_WU, PLINTH_H_WU / 2, box.hz + PLINTH_PROUD_WU, LIMESTONE_SHADE);
  const corniceCy = wingTopY + CORNICE_H_WU / 2 - 0.5;
  addBox(acc, box.cx, corniceCy, box.cz, box.hx + CORNICE_PROUD_WU, CORNICE_H_WU / 2, box.hz + CORNICE_PROUD_WU, LIMESTONE_LIGHT);

  // The central Great Hall attic — the ONLY part that reaches the DATA height, which is what makes
  // the wings' shortened render box legal (see WING_HEIGHT_FRAC).
  const atticHx = L.centreHalfX;
  const atticHz = box.hz - ATTIC_INSET_WU;
  const glazY0 = height - CLERESTORY_BOTTOM_BELOW_TOP_WU;
  const glazY1 = height - CLERESTORY_TOP_BELOW_TOP_WU;
  const bodyY0 = wingTopY - ATTIC_SKIRT_WU;
  addBox(acc, box.cx, (bodyY0 + glazY0) / 2, box.cz, atticHx, (glazY0 - bodyY0) / 2, atticHz, LIMESTONE, { py: false });
  // The clerestory band: glazing on the two long elevations (bright texels ARE lit glass on this
  // unlit slice), limestone on the short returns.
  addBox(acc, box.cx, (glazY0 + glazY1) / 2, box.cz, atticHx, (glazY1 - glazY0) / 2, atticHz, CLERESTORY_GLASS, {
    px: false,
    nx: false,
    py: false,
  });
  addBox(acc, box.cx, (glazY0 + glazY1) / 2, box.cz, atticHx, (glazY1 - glazY0) / 2, atticHz, LIMESTONE, {
    pz: false,
    nz: false,
    py: false,
  });
  addBox(acc, box.cx, (glazY1 + height) / 2, box.cz, atticHx, (height - glazY1) / 2, atticHz, LIMESTONE_LIGHT);

  // --- the colonnade ---------------------------------------------------------------------------
  // Hexagonal shafts, rolled so a FACET (never a corner) faces the street: with vertices sampled at
  // `i·60° + 30°` the facet centres land on 0/60/…/300°, i.e. one squarely on −Z (north) and one on
  // +X (east), which is what keeps each shaft's lit face flat instead of a specular edge.
  const HEX_ROLL = Math.PI / 6;
  const pitch = (2 * L.centreHalfX) / COLUMN_COUNT_NORTH;
  for (let i = 0; i < COLUMN_COUNT_NORTH; i++) {
    const cx = box.cx - L.centreHalfX + (i + 0.5) * pitch;
    addPrismY(acc, 6, 0, L.columnTopY, cx, L.colonnadeCentreZ, COLUMN_RADIUS_WU, COLUMN_RADIUS_WU, LIMESTONE_LIGHT, {
      angleOffset: HEX_ROLL,
    });
  }
  // North entablature — caps every shaft (so the prisms pay no top-cap triangles) and carries the
  // frieze the wordmark sits on. Its +Z face is buried in the wall and is not built.
  const colFrontZ = L.colonnadeCentreZ - COLUMN_RADIUS_WU;
  const northEntZ: Span = { min: colFrontZ - 0.15, max: zNorth + 0.15 };
  addBox(
    acc,
    box.cx,
    L.columnTopY + ENTABLATURE_H_WU / 2,
    (northEntZ.min + northEntZ.max) / 2,
    L.centreHalfX + 0.6,
    ENTABLATURE_H_WU / 2,
    (northEntZ.max - northEntZ.min) / 2,
    LIMESTONE_SHADE,
    { pz: false },
  );

  // The east return: the same rhythm on the one camera-visible short elevation.
  const eastPitch = (L.eastColumnSpan.max - L.eastColumnSpan.min) / COLUMN_COUNT_EAST;
  for (let i = 0; i < COLUMN_COUNT_EAST; i++) {
    const cz = L.eastColumnSpan.min + (i + 0.5) * eastPitch;
    addPrismY(acc, 6, 0, L.columnTopY, L.eastColumnX, cz, COLUMN_RADIUS_WU, COLUMN_RADIUS_WU, LIMESTONE_LIGHT, {
      angleOffset: HEX_ROLL,
    });
  }
  const eastEntX: Span = { min: x.max - 0.15, max: L.eastColumnX + COLUMN_RADIUS_WU + 0.15 };
  addBox(
    acc,
    (eastEntX.min + eastEntX.max) / 2,
    L.columnTopY + ENTABLATURE_H_WU / 2,
    (L.eastColumnSpan.min + L.eastColumnSpan.max) / 2,
    (eastEntX.max - eastEntX.min) / 2,
    ENTABLATURE_H_WU / 2,
    (L.eastColumnSpan.max - L.eastColumnSpan.min) / 2 + 0.5,
    LIMESTONE_SHADE,
    { nx: false },
  );

  // --- the south elevation's 14-bay pilaster rhythm ---------------------------------------------
  const pilasterSpan = 2 * box.hx - 2;
  const pilasterPitch = pilasterSpan / PILASTER_COUNT_SOUTH;
  const pilasterY0 = PLINTH_H_WU;
  const pilasterY1 = corniceCy - CORNICE_H_WU / 2;
  for (let i = 0; i < PILASTER_COUNT_SOUTH; i++) {
    const cx = x.min + 1 + (i + 0.5) * pilasterPitch;
    addBox(
      acc,
      cx,
      (pilasterY0 + pilasterY1) / 2,
      zSouth + PILASTER_PROUD_WU / 2 - 0.1,
      PILASTER_HALF_W_WU,
      (pilasterY1 - pilasterY0) / 2,
      PILASTER_PROUD_WU / 2 + 0.1,
      LIMESTONE_LIGHT,
      { nz: false },
    );
  }

  // --- the moat: sunken-carriageway paint + its stone balustrade --------------------------------
  const m = L.moat;
  addFace(
    acc,
    [
      [m.x.min, m.paintY, m.z.min],
      [m.x.min, m.paintY, m.z.max],
      [m.x.max, m.paintY, m.z.max],
      [m.x.max, m.paintY, m.z.min],
    ],
    [0, 1, 0],
    MOAT_FLOOR,
  );

  const length = m.x.max - m.x.min;
  const gaps = BALUSTRADE.gapFracs.map((f) => ({
    min: m.x.min + f * length - BALUSTRADE.gapWidth / 2,
    max: m.x.min + f * length + BALUSTRADE.gapWidth / 2,
  }));
  const runs: Span[] = [];
  let cursor = m.x.min;
  for (const gap of gaps) {
    runs.push({ min: cursor, max: gap.min });
    cursor = gap.max;
  }
  runs.push({ min: cursor, max: m.x.max });
  for (const run of runs) {
    const cx = (run.min + run.max) / 2;
    const hx = (run.max - run.min) / 2;
    addBox(acc, cx, walkTop + BALUSTRADE.dadoTop / 2, m.railZ, hx, BALUSTRADE.dadoTop / 2, BALUSTRADE.dadoHalfThick, LIMESTONE_LIGHT);
    addBox(
      acc,
      cx,
      walkTop + (BALUSTRADE.dadoTop + BALUSTRADE.railTop) / 2,
      m.railZ,
      hx,
      (BALUSTRADE.railTop - BALUSTRADE.dadoTop) / 2,
      BALUSTRADE.railHalfThick,
      LIMESTONE_LIGHT,
    );
    for (const px of [run.min, run.max]) {
      addBox(acc, px, walkTop + BALUSTRADE.pierTop / 2, m.railZ, BALUSTRADE.pierHalf, BALUSTRADE.pierTop / 2, BALUSTRADE.pierHalf, LIMESTONE_LIGHT);
    }
  }
}

// --- the GO shed ---------------------------------------------------------------------------------------

/** One angled pillar: a 4-sided post leaning outward from its splayed base to the slab edge. */
function addAngledPost(
  acc: Accum,
  base: readonly [number, number],
  top: readonly [number, number],
  halfW: number,
  y0: number,
  y1: number,
  hex: string,
): void {
  const corners = (p: readonly [number, number], y: number): Vec3[] => [
    [p[0] - halfW, y, p[1] - halfW],
    [p[0] + halfW, y, p[1] - halfW],
    [p[0] + halfW, y, p[1] + halfW],
    [p[0] - halfW, y, p[1] + halfW],
  ];
  const lo = corners(base, y0);
  const hi = corners(top, y1);
  const outward: Vec3[] = [
    [0, 0, -1],
    [1, 0, 0],
    [0, 0, 1],
    [-1, 0, 0],
  ];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    addFace(acc, [lo[i], lo[j], hi[j], hi[i]], outward[i], hex);
  }
}

function appendGoShed(acc: Accum, L: UnionLayout): void {
  const s = L.shed;
  const depth = s.z.max - s.z.min;
  const cx = (s.x.min + s.x.max) / 2;
  const arch = (t: number): number => SHED.springY + (SHED.crownY - SHED.springY) * Math.sin(Math.PI * t);
  const zAt = (t: number): number => s.z.min + t * depth;

  // Alternating rib / glass strips along the length. Ribs and bays are STRIPS OF THE SAME cambered
  // surface — adjacent quads sharing an edge exactly, never overlapping — so the "dark structure
  // over pale glass" read costs nothing but a colour change and can never z-fight.
  const bayCount = SHED.ribCount - 1;
  const ribTotal = SHED.ribCount * SHED.ribWidthWu;
  const bayWidth = (s.x.max - s.x.min - ribTotal) / bayCount;
  const strips: { readonly min: number; readonly max: number; readonly hex: string }[] = [];
  let cursor = s.x.min;
  for (let i = 0; i < SHED.ribCount; i++) {
    strips.push({ min: cursor, max: cursor + SHED.ribWidthWu, hex: SHED_RIB });
    cursor += SHED.ribWidthWu;
    if (i < bayCount) {
      strips.push({ min: cursor, max: cursor + bayWidth, hex: SHED_GLASS });
      cursor += bayWidth;
    }
  }

  for (const strip of strips) {
    for (let f = 0; f < SHED.archFacets; f++) {
      const t0 = f / SHED.archFacets;
      const t1 = (f + 1) / SHED.archFacets;
      addFace(
        acc,
        [
          [strip.min, arch(t0), zAt(t0)],
          [strip.max, arch(t0), zAt(t0)],
          [strip.max, arch(t1), zAt(t1)],
          [strip.min, arch(t1), zAt(t1)],
        ],
        [0, 1, 0],
        strip.hex,
      );
    }
  }
  // Underside (one strip across the whole length — the slab reads as one floating plane from below).
  for (let f = 0; f < SHED.archFacets; f++) {
    const t0 = f / SHED.archFacets;
    const t1 = (f + 1) / SHED.archFacets;
    addFace(
      acc,
      [
        [s.x.min, arch(t0) - SHED.slabThickWu, zAt(t0)],
        [s.x.max, arch(t0) - SHED.slabThickWu, zAt(t0)],
        [s.x.max, arch(t1) - SHED.slabThickWu, zAt(t1)],
        [s.x.min, arch(t1) - SHED.slabThickWu, zAt(t1)],
      ],
      [0, -1, 0],
      SHED_UNDER,
    );
  }
  // Slab edges: the two short (arched) ends and the two long fascias.
  for (const [edgeX, out] of [
    [s.x.min, [-1, 0, 0] as Vec3],
    [s.x.max, [1, 0, 0] as Vec3],
  ] as const) {
    for (let f = 0; f < SHED.archFacets; f++) {
      const t0 = f / SHED.archFacets;
      const t1 = (f + 1) / SHED.archFacets;
      addFace(
        acc,
        [
          [edgeX, arch(t0), zAt(t0)],
          [edgeX, arch(t1), zAt(t1)],
          [edgeX, arch(t1) - SHED.slabThickWu, zAt(t1)],
          [edgeX, arch(t0) - SHED.slabThickWu, zAt(t0)],
        ],
        out,
        SHED_RIB,
      );
    }
  }
  for (const [t, out] of [
    [0, [0, 0, -1] as Vec3],
    [1, [0, 0, 1] as Vec3],
  ] as const) {
    addFace(
      acc,
      [
        [s.x.min, arch(t), zAt(t)],
        [s.x.max, arch(t), zAt(t)],
        [s.x.max, arch(t) - SHED.slabThickWu, zAt(t)],
        [s.x.min, arch(t) - SHED.slabThickWu, zAt(t)],
      ],
      out,
      SHED_RIB,
    );
  }

  // Angled pillars — the researched read ("a glass atrium on angled pillars, floating above the
  // platforms"), leaning outward from a splayed base so the slab looks carried, not balanced.
  const pillarPitch = (s.x.max - s.x.min) / SHED.pillarsPerSide;
  for (let i = 0; i < SHED.pillarsPerSide; i++) {
    const px = s.x.min + (i + 0.5) * pillarPitch;
    for (const [baseZ, topZ] of [
      [s.z.min + SHED.pillarBaseInsetWu, s.z.min + SHED.pillarTopInsetWu],
      [s.z.max - SHED.pillarBaseInsetWu, s.z.max - SHED.pillarTopInsetWu],
    ] as const) {
      addAngledPost(acc, [px, baseZ], [px, topZ], SHED.pillarHalfWu, 0, SHED.springY + 0.2, SHED_PILLAR);
    }
  }

  // The platform deck the canopy floats over.
  addBox(acc, cx, SHED.platformHWu / 2, (s.z.min + s.z.max) / 2, (s.x.max - s.x.min) / 2, SHED.platformHWu / 2, depth / 2, SHED_PLATFORM);
}

// --- the render plan -----------------------------------------------------------------------------------

function unionRenderBoxes(L: UnionLayout): readonly NamedBox[] {
  return [{ ...L.box, hy: L.wingTopY / 2 }];
}

function unionSignQuads(L: UnionLayout): readonly NamedSignQuad[] {
  const aspect = namedSignCellAspect('union-frieze');
  const friezeY = (L.columnTopY + ENTABLATURE_H_WU + L.wingTopY - 0.5) / 2;
  const proud = WALL_STACK.fasciaBand;
  const northW = Math.min(12, L.centreHalfX);
  const southW = 10;
  const eastW = 6;
  return [
    // The TRUE frieze: on the north face, on the wall above the colonnade's entablature. Never
    // camera-visible on-rig (Union's facade faces Front Street) — the off-rig postcard's subject.
    {
      id: 'union-frieze-north',
      cell: 'union-frieze',
      face: 'north',
      position: [L.box.cx, friezeY, L.zNorth - proud],
      widthWu: northW,
      heightWu: northW * aspect,
    },
    // The two CAMERA-VISIBLE faces (Phase 34's pinned pair). Proud of the south pilasters, so the
    // band reads as a mounted signboard rather than being sliced by every bay.
    {
      id: 'union-frieze-south',
      cell: 'union-frieze',
      face: 'south',
      position: [L.box.cx, friezeY, L.zSouth + PILASTER_PROUD_WU + proud],
      widthWu: southW,
      heightWu: southW * aspect,
    },
    {
      id: 'union-frieze-east',
      cell: 'union-frieze',
      face: 'east',
      position: [L.x.max + proud, friezeY, L.box.cz],
      widthWu: eastW,
      heightWu: eastW * aspect,
    },
  ];
}

function unionExtraClaims(L: UnionLayout): readonly NamedExtraClaim[] {
  return [
    {
      id: 'go-shed',
      kind: 'namedBuilding',
      aabb: { minX: L.shed.x.min, maxX: L.shed.x.max, minZ: L.shed.z.min, maxZ: L.shed.z.max },
      yRange: [0, L.shed.topY],
    },
    {
      // The moat strip: paint + a colliderless stone balustrade. Blocking `decor` so no seeded
      // bench, bin or tree can ever stand in the carriageway (the Phase 40 embedded-shelter class).
      id: 'moat',
      kind: 'decor',
      aabb: { minX: L.moat.x.min, maxX: L.moat.x.max, minZ: L.moat.z.min, maxZ: L.moat.z.max },
      yRange: [0, SIDEWALK.curbHeightWu + BALUSTRADE.pierTop],
    },
  ];
}

function unionExtraColliders(L: UnionLayout): readonly NamedExtraCollider[] {
  const hy = L.shed.topY / 2;
  return [
    {
      id: 'go-shed',
      cx: (L.shed.x.min + L.shed.x.max) / 2,
      cy: hy,
      cz: (L.shed.z.min + L.shed.z.max) / 2,
      hx: (L.shed.x.max - L.shed.x.min) / 2,
      hy,
      hz: (L.shed.z.max - L.shed.z.min) / 2,
    },
  ];
}

function buildUnionGeometry(L: UnionLayout): NamedBespokeGeometry {
  const acc = createAccum();
  appendHeadhouse(acc, L);
  const headhouse = triangleCount(acc);
  appendGoShed(acc, L);
  const total = triangleCount(acc);
  return {
    geometry: toGeometry(acc, false),
    triangles: total,
    parts: [
      { id: 'union-station', triangles: headhouse },
      { id: 'go-shed', triangles: total - headhouse },
    ],
  };
}

/** The seam entry point (registered in namedGeometry.ts's `namedGeometryBuilders`). */
export function buildUnionStationBespoke(placement: NamedPlacement, ctx: NamedGeometryCtx): NamedBespoke {
  const L = unionLayout(placement, ctx);
  return {
    id: placement.id,
    renderBoxes: unionRenderBoxes(L),
    signQuads: unionSignQuads(L),
    extraClaims: unionExtraClaims(L),
    extraColliders: unionExtraColliders(L),
    meta: {
      topY: L.height,
      probes: {
        dataHeight: L.height,
        wingTopY: L.wingTopY,
        atticTopY: L.height,
        columnTopY: L.columnTopY,
        columnCountNorth: COLUMN_COUNT_NORTH,
        columnCountEast: COLUMN_COUNT_EAST,
        pilasterCountSouth: PILASTER_COUNT_SOUTH,
        columnRadiusWu: COLUMN_RADIUS_WU,
        colonnadeMinX: L.box.cx - L.centreHalfX,
        colonnadeMaxX: L.box.cx + L.centreHalfX,
        colonnadeCentreZ: L.colonnadeCentreZ,
        eastColumnX: L.eastColumnX,
        eastColumnMinZ: L.eastColumnSpan.min,
        eastColumnMaxZ: L.eastColumnSpan.max,
        moatMinZ: L.moat.z.min,
        moatMaxZ: L.moat.z.max,
        moatPaintY: L.moat.paintY,
        moatRailZ: L.moat.railZ,
        balustradeGapCount: BALUSTRADE.gapFracs.length,
        balustradeGapWidthWu: BALUSTRADE.gapWidth,
        balustradeMinMemberWu: Math.min(
          2 * BALUSTRADE.dadoHalfThick,
          2 * BALUSTRADE.railHalfThick,
          2 * BALUSTRADE.pierHalf,
        ),
        balustradeTopY: SIDEWALK.curbHeightWu + BALUSTRADE.pierTop,
        shedMinX: L.shed.x.min,
        shedMaxX: L.shed.x.max,
        shedMinZ: L.shed.z.min,
        shedMaxZ: L.shed.z.max,
        shedTopY: L.shed.topY,
      },
    },
    buildGeometry: () => buildUnionGeometry(L),
  };
}
