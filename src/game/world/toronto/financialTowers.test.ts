/**
 * Phase 48 (Part 11) — the six financial-district bank towers, the sixth through eleventh tenants
 * of the `namedGeometryBuilders` seam.
 *
 * Three kinds of assertion, and the second and third are the point:
 *   • BUDGETS — a ceiling AND a floor. All six shipped as 12-triangle boxes from Phase 24 until
 *     this phase, and a ceiling-only budget is passed just as happily by that box as by the real
 *     landmark, so the floor is what makes a silent revert fail (royalYork / oldCityHall's idiom).
 *   • THE CROWN-BAND KEEP-OUT — measured on the mesh, not described. Every one of these placements
 *     carries a §4 CROWN logo on its south and east faces; a pier, band or sawtooth standing proud
 *     of those faces inside the logo's own vertical band would slice it. This file computes that
 *     band from the placement's own decals and then goes looking for intruding vertices.
 *   • THE SPEND RULE — Phase 38 measured that crowns and skylines are invisible in play, so the
 *     phase's whole premise is that the triangles go to STREET LEVEL. That premise is a test here:
 *     the majority of every tower's mesh sits below 12 wu and its crown costs a few dozen
 *     triangles, not hundreds.
 *
 * The builders are called DIRECTLY rather than through `resolveNamedBespoke` — at the time this
 * file was written the registry entries had not landed, and calling the exported function with the
 * real placement is the same thing the registry does.
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { CAMERA_EYE_MIN_WU } from '../../config/camera';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { NAMED_HEIGHT_SCALE } from '../../config/torontoMap';
import { CROWN_DECAL, WINDOW_PATTERN } from '../../config/torontoMaterials';
import buildingSpecsJson from '../../../../data/toronto/building-specs.json';
import { overlaps, type Aabb } from './claimIndex';
import {
  buildCibcSquareBespoke,
  buildCommerceCourtBespoke,
  buildFirstCanadianPlaceBespoke,
  buildRoyalBankPlazaBespoke,
  buildScotiaPlazaBespoke,
  buildTdBankTowerBespoke,
  CIBC_SQUARE_MAX_TRIS,
  COMMERCE_COURT_MAX_TRIS,
  crownKeepOutBand,
  FINANCIAL_NORTH_RENDER_GROUP,
  FINANCIAL_SOUTH_RENDER_GROUP,
  FIRST_CANADIAN_PLACE_MAX_TRIS,
  MAX_PROUD_WU,
  MIN_RENDER_HEIGHT_FRAC,
  ROYAL_BANK_PLAZA_MAX_TRIS,
  SCOTIA_PLAZA_MAX_TRIS,
  TD_BANK_TOWER_MAX_TRIS,
} from './financialTowers';
import { hGame } from './heightCurve';
import { buildNamedBuildings, NAMED_SECONDARY_MASS_IDS, type NamedPlacement } from './namedBuildings';
import { namedGeometryCtx, type NamedBespoke } from './namedGeometry';
import { buildStreets, type Street } from './streets';

// -------------------------------------------------------------------------------------------------
// fixtures
// -------------------------------------------------------------------------------------------------

const named = buildNamedBuildings();
const ctx = namedGeometryCtx();
const streets = buildStreets().streets;

function placement(id: string): NamedPlacement {
  const p = named.placements.find((q) => q.id === id);
  expect(p, `no named placement "${id}"`).toBeDefined();
  return p!;
}

function street(id: string): Street {
  const s = streets.find((q) => q.id === id);
  expect(s, `no street "${id}"`).toBeDefined();
  return s!;
}

/** Each tower's builder + its own budget, in one table — every `describe.each` below reads it. */
const TOWERS = [
  { id: 'first-canadian-place', build: () => buildFirstCanadianPlaceBespoke(placement('first-canadian-place')), cap: FIRST_CANADIAN_PLACE_MAX_TRIS, floor: 150, group: FINANCIAL_NORTH_RENDER_GROUP },
  { id: 'scotia-plaza', build: () => buildScotiaPlazaBespoke(placement('scotia-plaza')), cap: SCOTIA_PLAZA_MAX_TRIS, floor: 150, group: FINANCIAL_NORTH_RENDER_GROUP },
  { id: 'td-bank-tower', build: () => buildTdBankTowerBespoke(placement('td-bank-tower')), cap: TD_BANK_TOWER_MAX_TRIS, floor: 175, group: FINANCIAL_SOUTH_RENDER_GROUP },
  { id: 'commerce-court-west', build: () => buildCommerceCourtBespoke(placement('commerce-court-west'), ctx), cap: COMMERCE_COURT_MAX_TRIS, floor: 210, group: FINANCIAL_NORTH_RENDER_GROUP },
  { id: 'royal-bank-plaza', build: () => buildRoyalBankPlazaBespoke(placement('royal-bank-plaza')), cap: ROYAL_BANK_PLAZA_MAX_TRIS, floor: 135, group: FINANCIAL_SOUTH_RENDER_GROUP },
  { id: 'cibc-square', build: () => buildCibcSquareBespoke(placement('cibc-square')), cap: CIBC_SQUARE_MAX_TRIS, floor: 230, group: FINANCIAL_SOUTH_RENDER_GROUP },
] as const;

interface Vertex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface Measured {
  readonly id: string;
  readonly bespoke: NamedBespoke;
  readonly triangles: number;
  readonly geometry: BufferGeometry;
  readonly verts: readonly Vertex[];
  /** Vertices of the FIRST part only — the tower itself, without any secondary mass. `parts` are
   * appended into one accumulator in order, so a part is a contiguous triangle range. */
  readonly towerVerts: readonly Vertex[];
  readonly parts: readonly { readonly id: string; readonly triangles: number }[];
  readonly probes: Readonly<Record<string, number>>;
  readonly box: { cx: number; cz: number; hx: number; hz: number; hy: number };
}

function vertices(geometry: BufferGeometry): Vertex[] {
  const p = geometry.getAttribute('position').array as Float32Array;
  const out: Vertex[] = [];
  for (let i = 0; i < p.length; i += 3) out.push({ x: p[i], y: p[i + 1], z: p[i + 2] });
  return out;
}

const measured: Measured[] = TOWERS.map((t) => {
  const bespoke = t.build();
  const built = bespoke.buildGeometry();
  const verts = vertices(built.geometry);
  const box = placement(t.id).boxes[0];
  return {
    id: t.id,
    bespoke,
    triangles: built.triangles,
    geometry: built.geometry,
    verts,
    towerVerts: verts.slice(0, built.parts[0].triangles * 3),
    parts: built.parts,
    probes: bespoke.meta.probes,
    box: { cx: box.cx, cz: box.cz, hx: box.hx, hz: box.hz, hy: box.hy },
  };
});

const byId = new Map(measured.map((m) => [m.id, m]));
const each = TOWERS.map((t) => [t.id, t] as const);

/** Float32 vertex data at world coordinates ~1.4e3 carries ~1e-4 of absolute precision, so every
 * positional comparison in this file is made at 3 decimals, never at machine epsilon (the
 * oldCityHall.test.ts note, same arithmetic). */
const EPS = 1e-3;

/** Is this vertex FACADE-ATTACHED on a camera-visible face — i.e. proud of the tower's south or
 * east wall, inside that wall's own span, and within the proud ceiling? That is exactly the class
 * of geometry the CROWN keep-out and the proud limit govern; a secondary mass standing metres away
 * in the plaza is a different building and is excluded by construction. */
function proudOnVisibleFace(m: Measured, v: Vertex): boolean {
  const southProud = v.z - (m.box.cz + m.box.hz);
  const eastProud = v.x - (m.box.cx + m.box.hx);
  // The lateral bound allows one full proud budget past the corner: a COURSE that wraps both
  // elevations (CIBC Square's banded fenestration, every cornice) has all eight of its vertices AT
  // the corners, and a bound of exactly `hx` would silently exempt the whole class from the
  // keep-out this predicate exists to enforce.
  const onSouth = southProud > EPS && southProud <= MAX_PROUD_WU && Math.abs(v.x - m.box.cx) <= m.box.hx + MAX_PROUD_WU;
  const onEast = eastProud > EPS && eastProud <= MAX_PROUD_WU && Math.abs(v.z - m.box.cz) <= m.box.hz + MAX_PROUD_WU;
  return onSouth || onEast;
}

/** Triangle centroids of a vertex list (3 vertices per triangle, non-indexed). */
function centroids(verts: readonly Vertex[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < verts.length; i += 3) out.push((verts[i].y + verts[i + 1].y + verts[i + 2].y) / 3);
  return out;
}

// -------------------------------------------------------------------------------------------------
// budgets
// -------------------------------------------------------------------------------------------------

describe.each(each)('%s — tri budget (Part 11 rule 2)', (id, spec) => {
  const m = byId.get(id)!;

  it('stays inside its ceiling and clears a floor a plain box could never reach', () => {
    expect(m.triangles).toBeLessThanOrEqual(spec.cap);
    // THE FLOOR. v1 of every one of these was a single 12-triangle extruded box; a podium, a
    // colonnade, an articulated shaft and a crown cannot be built for less than this, so a
    // regression that quietly reverted any whole subsystem fails HERE even though every
    // proportion pin below would still pass.
    expect(m.triangles).toBeGreaterThan(spec.floor);
    expect(m.triangles).toBe((m.geometry.getAttribute('position').array as Float32Array).length / 9);
    expect(m.parts.reduce((n, p) => n + p.triangles, 0)).toBe(m.triangles);
    for (const part of m.parts) expect(part.triangles, part.id).toBeGreaterThan(0);
    // The seam's merged-mesh contract, proven here because these ids are the newest arrivals.
    expect(m.geometry.index).toBeNull();
    for (const attribute of ['position', 'normal', 'color']) {
      expect((m.geometry.getAttribute(attribute).array as Float32Array).length / 9, attribute).toBe(m.triangles);
    }
  });
});

describe('financial towers — the six budgets are stated constants, not measurements', () => {
  it('pins each ceiling, and gives Commerce Court the one raise (it carries a second building)', () => {
    expect(FIRST_CANADIAN_PLACE_MAX_TRIS).toBe(700);
    expect(SCOTIA_PLAZA_MAX_TRIS).toBe(700);
    expect(TD_BANK_TOWER_MAX_TRIS).toBe(700);
    expect(ROYAL_BANK_PLAZA_MAX_TRIS).toBe(700);
    expect(CIBC_SQUARE_MAX_TRIS).toBe(700);
    expect(COMMERCE_COURT_MAX_TRIS).toBe(850);
    expect(COMMERCE_COURT_MAX_TRIS).toBeGreaterThan(FIRST_CANADIAN_PLACE_MAX_TRIS);
  });

  it('the whole pass costs well under a fifth of the LOW tier\'s 120k triangle budget', () => {
    // Not a vanity number: phase-47-notes measured the low tier at 98.3 % of its triangle ceiling,
    // so the six towers' TOTAL is the number that matters, and it is pinned with headroom rather
    // than left to six independent ceilings that could all be spent at once.
    const total = measured.reduce((n, m) => n + m.triangles, 0);
    expect(total).toBeLessThan(2600);
    // The open-face pass DROPPED this from 2,058 to ~1,500: deriving the bay count from the window
    // pitch removes two thirds of the piers, and fewer/better-placed piers is what fixed the look.
    // The lower bound stays as the "someone reverted a subsystem" tripwire.
    expect(total).toBeGreaterThan(1100);
  });
});

// -------------------------------------------------------------------------------------------------
// THE SPEND RULE — Phase 38's measurement, as a test
// -------------------------------------------------------------------------------------------------

describe.each(each)('%s — spends its triangles where the camera actually is', (id) => {
  const m = byId.get(id)!;

  it('puts the majority of the mesh below 12 wu (the drive-past band)', () => {
    const ys = centroids(m.verts);
    const below = ys.filter((y) => y < 12).length;
    expect(below / ys.length).toBeGreaterThan(0.5);
  });

  it('keeps the crown CHEAP — it is silhouette-only, invisible in every play frame (Phase 38)', () => {
    // Phase 38 measured the crown band at NDC-Y 4.2–16 at every legal vantage: metres above the
    // top of the frame. Crown geometry ships for the minimap icon and the off-rig postcard, so it
    // is capped rather than dropped.
    const crown = centroids(m.verts).filter((y) => y > m.probes.renderTopY).length;
    expect(crown).toBeGreaterThan(0);
    expect(crown).toBeLessThanOrEqual(60);
  });

  it('carries real articulation across the whole street-level band, not one lump', () => {
    // It reaches the ground (a base, not a floating slab)…
    expect(Math.min(...m.towerVerts.map((v) => v.y))).toBeCloseTo(0, 6);
    // …and the shaft between the podium and the logo band is genuinely populated.
    const ys = centroids(m.towerVerts);
    expect(ys.filter((y) => y > m.probes.podiumTopY && y < m.probes.shaftTopY).length).toBeGreaterThan(20);
  });
});

// -------------------------------------------------------------------------------------------------
// heights + the shortened render box (the Union / Royal York law)
// -------------------------------------------------------------------------------------------------

describe.each(each)('%s — heights are the DATA row, not a new invention', (id) => {
  const m = byId.get(id)!;

  it('tops out at EXACTLY the data height', () => {
    const dataHeight = m.box.hy * 2;
    expect(m.probes.dataHeight).toBeCloseTo(dataHeight, 12);
    expect(m.bespoke.meta.topY).toBeCloseTo(dataHeight, 12);
    expect(Math.max(...m.verts.map((v) => v.y))).toBeCloseTo(dataHeight, 3);
  });

  it('crosses the eye line — which is why the scene must register this mesh as an occludable', () => {
    // All six are heightLaw.test.ts crossers by design; the crown mass now stands where the data
    // box used to, so the occlusion obligation is unchanged and this pins that it still applies.
    expect(m.probes.dataHeight).toBeGreaterThan(CAMERA_EYE_MIN_WU);
  });

  it('shrinks the render box only as far as the crown needs, never past the 0.85 floor', () => {
    expect(MIN_RENDER_HEIGHT_FRAC).toBe(0.85);
    expect(m.bespoke.renderBoxes).toHaveLength(1);
    const render = m.bespoke.renderBoxes[0];
    expect(render.hy).toBeLessThan(m.box.hy);
    expect(render.hy * 2).toBeCloseTo(m.probes.renderTopY, 12);
    expect(m.probes.renderHeightFrac).toBeGreaterThanOrEqual(MIN_RENDER_HEIGHT_FRAC);
    expect(m.probes.renderHeightFrac).toBeLessThan(1);
  });

  it('copies the data box footprint and look UNCHANGED (the seam\'s footprint-match law)', () => {
    const render = m.bespoke.renderBoxes[0];
    const data = placement(id).boxes[0];
    expect([render.cx, render.cz, render.hx, render.hz]).toEqual([data.cx, data.cz, data.hx, data.hz]);
    expect(render.look).toEqual(data.look);
    // One data box, one render box: the identity mapping IS correct, so declaring one would be a
    // second thing that can drift (see NamedBespoke.renderBoxDataIndices).
    expect(m.bespoke.renderBoxDataIndices).toBeUndefined();
    expect(placement(id).boxes).toHaveLength(1);
  });

  it('stacks podium → shaft → crown in order, each clear of the next', () => {
    expect(m.probes.podiumTopY).toBeGreaterThan(0);
    expect(m.probes.shaftTopY).toBeGreaterThan(m.probes.podiumTopY);
    expect(m.probes.crownBandY0).toBeGreaterThan(m.probes.shaftTopY);
    expect(m.probes.renderTopY).toBeGreaterThan(m.probes.crownBandY1);
    expect(m.probes.dataHeight).toBeGreaterThan(m.probes.renderTopY);
  });
});

// -------------------------------------------------------------------------------------------------
// THE CROWN-BAND KEEP-OUT
// -------------------------------------------------------------------------------------------------

describe('financial towers — the CROWN keep-out band is derived from the §4 rule', () => {
  it('reproduces TorontoScene\'s own decal placement arithmetic, per face', () => {
    for (const m of measured) {
      const p = placement(m.id);
      const render = m.bespoke.renderBoxes[0];
      expect(p.decals.map((d) => d.face).sort()).toEqual(['east', 'south']);
      const band = crownKeepOutBand(p, render.hy * 2);
      for (const decal of p.decals) {
        // `decalTransform` puts the quad centre at bandCenterFrac × the RENDER box height and the
        // quad is `size` tall; the band is the union of those spans across the two faces.
        const centre = decal.bandCenterFrac * render.hy * 2;
        expect(decal.bandCenterFrac).toBe(CROWN_DECAL.bandCenterFrac);
        expect(band.y0, `${m.id}/${decal.face}`).toBeLessThanOrEqual(centre - decal.size / 2 + 1e-9);
        expect(band.y1, `${m.id}/${decal.face}`).toBeGreaterThanOrEqual(centre + decal.size / 2 - 1e-9);
      }
      expect(band.y0).toBeCloseTo(m.probes.crownBandY0, 9);
      expect(band.y1).toBeCloseTo(m.probes.crownBandY1, 9);
    }
  });

  it('throws on a placement with no CROWN decal rather than leaving the layout unconstrained', () => {
    const noCrown = placement('fairmont-royal-york');
    expect(noCrown.decals).toEqual([]);
    expect(() => crownKeepOutBand(noCrown, 20)).toThrow(/CROWN decal/);
  });
});

describe.each(each)('%s — nothing proud intrudes into the CROWN band', (id) => {
  const m = byId.get(id)!;

  it('has ZERO facade-attached vertices inside the logo band on either camera-visible face', () => {
    const intruders = m.verts.filter(
      (v) => proudOnVisibleFace(m, v) && v.y > m.probes.crownBandY0 - 1e-6 && v.y < m.probes.crownBandY1 + 1e-6,
    );
    expect(intruders, `${id}: ${intruders.length} vertices inside the CROWN band`).toHaveLength(0);
  });

  it('is non-vacuous — the tower really does carry proud geometry on both visible faces', () => {
    const south = m.towerVerts.filter((v) => v.z > m.box.cz + m.box.hz + EPS && v.z <= m.box.cz + m.box.hz + MAX_PROUD_WU);
    const east = m.towerVerts.filter((v) => v.x > m.box.cx + m.box.hx + EPS && v.x <= m.box.cx + m.box.hx + MAX_PROUD_WU);
    expect(south.length, `${id} south`).toBeGreaterThan(20);
    expect(east.length, `${id} east`).toBeGreaterThan(20);
  });

  it('keeps every facade-attached element inside the 2.5 wu massing-exclusion budget', () => {
    // namedBuildings.ts inflates every named footprint by 3 wu before it becomes a massing
    // exclusion; anything past that pokes into ground another placer owns.
    const maxX = Math.max(...m.towerVerts.map((v) => v.x));
    const maxZ = Math.max(...m.towerVerts.map((v) => v.z));
    expect(maxX - (m.box.cx + m.box.hx), `${id} east proud`).toBeLessThanOrEqual(MAX_PROUD_WU + EPS);
    expect(maxZ - (m.box.cz + m.box.hz), `${id} south proud`).toBeLessThanOrEqual(MAX_PROUD_WU + EPS);
    expect(MAX_PROUD_WU).toBeLessThan(3);
  });
});

// -------------------------------------------------------------------------------------------------
// THE OPEN-FACE LAW — the §4 lit-window texture must survive the articulation
// -------------------------------------------------------------------------------------------------
//
// WHY THIS EXISTS: the first cut of financialTowers.ts authored its bay counts (20 piers on a 19 wu
// face; a continuous, edge-to-edge sawtooth). The unit tests were all green and the evidence
// battery photographed three of six towers as FEATURELESS SLABS — the proud geometry had become the
// wall, and the §4 facade texture behind it (which is how this city reads at blue hour: Phase 23's
// material verdict, "lit windows ARE the look fix") was completely occluded.
//
// Nothing in a triangle budget or a proportion pin can see that, so the law is measured COVERAGE,
// taken off the EMITTED GEOMETRY rather than off the constants — a re-tune of PIER_WIDTH_FRAC or a
// new pitch multiple cannot pass a stale assertion, because the assertion never reads them.
//
// Two numbers per camera-visible face, over the shaft band (podium top → CROWN band bottom):
//   • OPEN WIDTH  — the coordinator's law verbatim: project the proud geometry onto the face's own
//     axis, union the spans, and take the fraction of the face width left over. Restricted to TALL
//     elements (spanning ≥ half the band's height), because those are the ones that occlude a whole
//     COLUMN of windows; a 0.4 wu spandrel course spans the full width but hides ~3 % of the face,
//     and CIBC Square — the battery's reference for "articulated but still glazed" — is made of
//     twelve of them.
//   • OPEN AREA   — the general form the sawtooth demanded: the fraction of the shaft band's face
//     RECTANGLE left uncovered. Every proud face this module emits is an axis-aligned rectangle in
//     (along, y), so a per-slice interval union is EXACT, not an approximation.
// Both must clear 0.5. Measured on the pre-fix geometry they read 0.16 (FCP) and 0.10 (Scotia
// south); that is the defect this law now makes unshippable.

/** Fraction of `[0, total]` NOT covered by the union of `spans`. */
function openFraction(spans: readonly (readonly [number, number])[], total: number): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = -Infinity;
  for (const [lo, hi] of sorted) {
    const from = Math.max(lo, cursor);
    if (hi > from) {
      covered += hi - from;
      cursor = hi;
    }
  }
  return Math.max(0, 1 - covered / total);
}

interface FaceOpening {
  readonly openWidth: number;
  readonly openArea: number;
  /** The deepest projection of any TALL element standing in the FIELD of the elevation (i.e. not
   * the corner mullion, which terminates both rows and is deliberately the heaviest thing on the
   * facade). This is what separates a serrated tower from a piered one on measurement rather than
   * on a constant: a tooth apex projects SAWTOOTH_DEPTH_WU, a pier projects half that. */
  readonly tallProudWu: number;
}

/**
 * Measure one camera-visible elevation. `along` is the face's own axis (south → X, east → Z),
 * `across` the face normal's axis; a triangle counts as PROUD when it stands off the data face by
 * more than float noise and no further than the massing budget.
 */
function faceOpening(m: Measured, face: 'south' | 'east'): FaceOpening {
  const faceAt = face === 'south' ? m.box.cz + m.box.hz : m.box.cx + m.box.hx;
  const halfAlong = face === 'south' ? m.box.hx : m.box.hz;
  const centreAlong = face === 'south' ? m.box.cx : m.box.cz;
  const width = 2 * halfAlong;
  const bandY0 = m.probes.podiumTopY;
  const bandY1 = m.probes.crownBandY0;
  const bandH = bandY1 - bandY0;

  // Every proud face in this module is an axis-aligned rectangle in (along, y) — even the sawtooth
  // wedges, whose slopes are slanted in PLAN but rectangular in elevation — so a triangle's AABB in
  // those two axes is its exact footprint on the face.
  const rects: { lo: number; hi: number; y0: number; y1: number; proud: number }[] = [];
  for (let i = 0; i < m.verts.length; i += 3) {
    const tri = [m.verts[i], m.verts[i + 1], m.verts[i + 2]];
    const across = tri.map((v) => (face === 'south' ? v.z : v.x));
    const proud = Math.max(...across) - faceAt;
    if (proud <= EPS || Math.min(...across) > faceAt + MAX_PROUD_WU) continue;
    const alongs = tri.map((v) => (face === 'south' ? v.x : v.z));
    const lo = Math.max(centreAlong - halfAlong, Math.min(...alongs));
    const hi = Math.min(centreAlong + halfAlong, Math.max(...alongs));
    const y0 = Math.max(bandY0, Math.min(...tri.map((v) => v.y)));
    const y1 = Math.min(bandY1, Math.max(...tri.map((v) => v.y)));
    if (hi <= lo || y1 <= y0) continue;
    rects.push({ lo, hi, y0, y1, proud });
  }

  const tall = rects.filter((r) => r.y1 - r.y0 >= 0.5 * bandH).map((r) => [r.lo, r.hi] as const);
  // Area: sample the band on a fine ladder and union the along-intervals live at each height. 200
  // slices over a ~13 wu band is ~7 cm of resolution — far finer than the 0.4 wu thinnest element.
  const SLICES = 200;
  let openSum = 0;
  for (let i = 0; i < SLICES; i++) {
    const y = bandY0 + ((i + 0.5) * bandH) / SLICES;
    openSum += openFraction(
      rects.filter((r) => r.y0 <= y && y <= r.y1).map((r) => [r.lo, r.hi] as const),
      width,
    );
  }
  // "In the field" = the element's midpoint stands clear of both ends of the elevation. The corner
  // mullion's midpoint sits exactly ON the end (it is half-buried in the return), so it is excluded
  // by construction rather than by a name.
  const field = rects.filter(
    (r) =>
      r.y1 - r.y0 >= 0.5 * bandH &&
      (r.lo + r.hi) / 2 > centreAlong - halfAlong + 1 &&
      (r.lo + r.hi) / 2 < centreAlong + halfAlong - 1,
  );
  return {
    openWidth: openFraction(tall, width),
    openArea: openSum / SLICES,
    tallProudWu: field.reduce((n, r) => Math.max(n, r.proud), 0),
  };
}

/** The floor both measures must clear. Half the elevation stays glass — anything less and the
 * lit-window read that carries this city at blue hour starts disappearing behind the mullions. */
const MIN_OPEN_FRACTION = 0.5;

describe.each(each)('%s — the open-face law: the lit-window texture survives', (id) => {
  const m = byId.get(id)!;

  it('leaves at least half of each camera-visible elevation as GLASS, by width and by area', () => {
    for (const face of ['south', 'east'] as const) {
      const { openWidth, openArea } = faceOpening(m, face);
      expect(openWidth, `${id} ${face} open width`).toBeGreaterThanOrEqual(MIN_OPEN_FRACTION);
      expect(openArea, `${id} ${face} open area`).toBeGreaterThanOrEqual(MIN_OPEN_FRACTION);
    }
  });

  it('is non-vacuous — the measure really sees this tower\'s articulation', () => {
    // A law that measured nothing would read 1.0 everywhere and pass forever. Every tower must
    // cover a real, non-trivial slice of at least one elevation.
    const covered = ['south', 'east'].map((f) => 1 - faceOpening(m, f as 'south' | 'east').openArea);
    expect(Math.max(...covered), `${id} covers nothing`).toBeGreaterThan(0.1);
  });
});

describe('financial towers — the rhythm is DERIVED from the facade texture, never authored', () => {
  it('lays every vertical rhythm on the window-column pitch (or an exact multiple)', () => {
    // WINDOW_PATTERN.columnPitchWu is the pitch the baked §4 facade draws its window columns on.
    // Each tower publishes the pitch it actually resolved; every one must be that pitch (or a
    // multiple) to within the rounding the face width forces — which is what makes the bespoke
    // mullions land on the texture's own columns instead of across them.
    expect(WINDOW_PATTERN.columnPitchWu).toBe(3);
    const pitches: Record<string, { key: string; multiple: number }> = {
      'first-canadian-place': { key: 'shaftPierPitchWu', multiple: 1 },
      'scotia-plaza': { key: 'sawtoothPitchWu', multiple: 1 },
      'td-bank-tower': { key: 'mullionPitchWu', multiple: 1 },
      'commerce-court-west': { key: 'shaftPierPitchWu', multiple: 2 },
      'royal-bank-plaza': { key: 'sawtoothPitchWu', multiple: 1 },
    };
    for (const [towerId, { key, multiple }] of Object.entries(pitches)) {
      const pitch = byId.get(towerId)!.probes[key];
      const target = WINDOW_PATTERN.columnPitchWu * multiple;
      // A face of finite width cannot hold a whole number of exact-pitch bays, so the resolved
      // pitch is the nearest that DIVIDES the face — never a free number. The tolerance is the
      // rounding a ~17 wu elevation forces on a 6 wu bay (Commerce Court: 2.53 bays → 3, i.e.
      // 5.07 wu), which is the worst case any of the six produces.
      expect(Math.abs(pitch - target) / target, `${towerId} ${key}`).toBeLessThan(0.2);
    }
    // CIBC Square is the deliberate exception: its rhythm is HORIZONTAL, so it publishes no
    // vertical pitch at all (see CIBC_BANDS' note).
    expect(byId.get('cibc-square')!.probes.shaftPierPitchWu).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------------
// SIX DISTINCT TOWERS — the phase's acceptance gate, measured
// -------------------------------------------------------------------------------------------------

/**
 * Facade-attached tower vertices inside the SHAFT band, on the south face — the register whose
 * articulation is each tower's signature. The lower bound clears the podium deck by 1.5 wu, which
 * is what keeps rooftop furniture standing ON the podium (CIBC's planters and park rail) out of a
 * measurement about the curtain wall above it.
 */
function shaftSouth(m: Measured): Vertex[] {
  return m.towerVerts.filter(
    (v) =>
      v.y > m.probes.podiumTopY + 1.5 &&
      v.y < m.probes.shaftTopY - 0.2 &&
      v.z > m.box.cz + m.box.hz + EPS &&
      v.z <= m.box.cz + m.box.hz + MAX_PROUD_WU &&
      Math.abs(v.x - m.box.cx) <= m.box.hx + MAX_PROUD_WU,
  );
}

function clusterCount(values: readonly number[], gap: number): number {
  const sorted = [...new Set(values.map((n) => Math.round(n * 100) / 100))].sort((a, b) => a - b);
  let n = 0;
  let last = -Infinity;
  for (const v of sorted) {
    if (v - last > gap) n++;
    last = v;
  }
  return n;
}

describe('financial towers — six DISTINGUISHABLE buildings, not six boxes', () => {
  it('all six carry a DIFFERENT §4 fill colour (steel_stainless was added for exactly this)', () => {
    const fills = measured.map((m) => placement(m.id).boxes[0].look.fill);
    expect(new Set(fills).size).toBe(6);
  });

  it('CIBC Square is the only HORIZONTALLY articulated tower — that IS its distinctness', () => {
    for (const m of measured) {
      const south = faceOpening(m, 'south');
      if (m.id === 'cibc-square') {
        // Not one tall vertical element anywhere on the elevation — its whole rhythm runs the other
        // way — yet the face is genuinely articulated, which is what the AREA measure catches and
        // the WIDTH measure structurally cannot.
        expect(south.openWidth, `${m.id} open width`).toBe(1);
        expect(south.openArea, `${m.id} open area`).toBeLessThan(0.75);
        expect(clusterCount(shaftSouth(m).map((v) => v.y), 0.25), `${m.id} y-levels`).toBeGreaterThan(10);
      } else {
        // Everyone else's rhythm is vertical, so real width is taken.
        expect(south.openWidth, `${m.id} open width`).toBeLessThan(1);
      }
    }
  });

  it('Scotia Plaza and Royal Bank Plaza are the SAWTOOTH pair, and only they are', () => {
    // A tooth apex projects SAWTOOTH_DEPTH_WU (0.9); the deepest thing any pier-articulated tower
    // puts on its shaft is a 0.75 wu course. The 0.85 threshold separates the two families with
    // real margin in both directions.
    const serrated = new Set(['scotia-plaza', 'royal-bank-plaza']);
    for (const m of measured) {
      const proud = faceOpening(m, 'south').tallProudWu;
      if (serrated.has(m.id)) expect(proud, `${m.id} shaft proud`).toBeGreaterThanOrEqual(0.85);
      else expect(proud, `${m.id} shaft proud`).toBeLessThan(0.85);
    }
    expect(byId.get('scotia-plaza')!.probes.sawtoothTeeth).toBeGreaterThanOrEqual(4);
    expect(byId.get('royal-bank-plaza')!.probes.teethPerFace).toBeGreaterThanOrEqual(4);
    // Scotia's sawtooth is the researched NORTH/SOUTH feature, so its east return is plain piers;
    // RBC's serration is the whole envelope, so it runs on both camera-visible faces.
    expect(byId.get('scotia-plaza')!.probes.eastPiers).toBeGreaterThanOrEqual(4);
    expect(byId.get('royal-bank-plaza')!.probes.eastPiers).toBeUndefined();
  });

  it('each tower publishes its own signature probe, and no other tower publishes it', () => {
    const signature: Record<string, string> = {
      'first-canadian-place': 'megaFrameCourses',
      'scotia-plaza': 'crownLatticeFins',
      'td-bank-tower': 'pavilionHeight',
      'commerce-court-west': 'northHeight',
      'royal-bank-plaza': 'atriumTopY',
      'cibc-square': 'capShearWu',
    };
    for (const m of measured) {
      for (const [ownerId, key] of Object.entries(signature)) {
        if (m.id === ownerId) expect(m.probes[key], `${m.id}.${key}`).toBeGreaterThan(0);
        else expect(m.probes[key], `${m.id}.${key}`).toBeUndefined();
      }
    }
  });

  it('every element that has to READ clears the thin-geometry floor', () => {
    // THIN_GEOMETRY.minStripeWidthWu is the Phase-41 law for a hard-edged thin solid: anything
    // narrower strobes when it minifies. Each tower publishes its NARROWEST authored feature, so
    // this asserts the law against the constants rather than against a re-typed number.
    expect(THIN_GEOMETRY.minStripeWidthWu).toBe(0.3);
    for (const m of measured) {
      expect(m.probes.narrowestFeatureWu, `${m.id}`).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    }
    // The two towers that sit closest to the floor are the two whose identity IS a fine repeating
    // section: TD's Miesian steel mullion (0.48) and CIBC Square's spandrel band (0.40). Both are
    // pinned, because "make it thinner, it'll look sharper" is exactly the edit the P41 law exists
    // to stop.
    expect(byId.get('td-bank-tower')!.probes.narrowestFeatureWu).toBeCloseTo(0.487, 3);
    expect(byId.get('cibc-square')!.probes.narrowestFeatureWu).toBeCloseTo(0.4, 9);
    const narrowest = Math.min(...measured.map((m) => m.probes.narrowestFeatureWu));
    expect(narrowest).toBeCloseTo(0.4, 9);
    expect(narrowest).toBeLessThan(2 * THIN_GEOMETRY.minStripeWidthWu);
  });
});

// -------------------------------------------------------------------------------------------------
// SECONDARY MASSES — TD's banking pavilion + Commerce Court North
// -------------------------------------------------------------------------------------------------

describe('financial towers — secondary masses are real buildings, claimed and collided', () => {
  const withMass = ['td-bank-tower', 'commerce-court-west'] as const;

  it('exactly two of the six carry one; the other four claim and collide nothing extra', () => {
    for (const m of measured) {
      if ((withMass as readonly string[]).includes(m.id)) {
        expect(m.bespoke.extraClaims, m.id).toHaveLength(1);
        expect(m.bespoke.extraColliders, m.id).toHaveLength(1);
        expect(m.parts).toHaveLength(2);
      } else {
        expect(m.bespoke.extraClaims, m.id).toEqual([]);
        expect(m.bespoke.extraColliders, m.id).toEqual([]);
        expect(m.parts, m.id).toHaveLength(1);
      }
    }
  });

  it('every extra collider matches its claim exactly and is floored at y = 0 (the seam contract)', () => {
    for (const m of measured) {
      for (const collider of m.bespoke.extraColliders) {
        for (const h of [collider.hx, collider.hy, collider.hz]) expect(h, collider.id).toBeGreaterThan(0);
        expect(collider.cy, collider.id).toBeCloseTo(collider.hy, 9);
        const claim = m.bespoke.extraClaims.find((c) => c.id === collider.id);
        expect(claim, `${collider.id} has no matching claim`).toBeDefined();
        expect(claim?.kind).toBe('namedBuilding');
        expect(claim?.yRange[0]).toBe(0);
        expect(claim?.yRange[1]).toBeCloseTo(2 * collider.hy, 9);
        expect(claim?.aabb).toEqual({
          minX: collider.cx - collider.hx,
          maxX: collider.cx + collider.hx,
          minZ: collider.cz - collider.hz,
          maxZ: collider.cz + collider.hz,
        });
      }
    }
  });

  it('no extra claim overlaps its own placement DATA box (the collider stays the truth)', () => {
    for (const m of measured) {
      const data: Aabb[] = placement(m.id).boxes.map((b) => ({
        minX: b.cx - b.hx,
        maxX: b.cx + b.hx,
        minZ: b.cz - b.hz,
        maxZ: b.cz + b.hz,
      }));
      for (const claim of m.bespoke.extraClaims) {
        for (const d of data) expect(overlaps(claim.aabb, d), `${m.id}:${claim.id}`).toBe(false);
      }
    }
  });

  it('every secondary-mass triangle stands INSIDE the claim it publishes', () => {
    // The arbiter's whole premise: a claim is the ground a thing actually occupies. Union's GO shed
    // set this rule; a pier that pokes past its own claim is the way to break it silently.
    for (const m of measured) {
      if (m.parts.length < 2) continue;
      const claim = m.bespoke.extraClaims[0];
      const mass = m.verts.slice(m.parts[0].triangles * 3);
      expect(mass.length).toBeGreaterThan(0);
      for (const v of mass) {
        expect(v.x, `${m.id} x`).toBeGreaterThanOrEqual(claim.aabb.minX - EPS);
        expect(v.x, `${m.id} x`).toBeLessThanOrEqual(claim.aabb.maxX + EPS);
        expect(v.z, `${m.id} z`).toBeGreaterThanOrEqual(claim.aabb.minZ - EPS);
        expect(v.z, `${m.id} z`).toBeLessThanOrEqual(claim.aabb.maxZ + EPS);
        expect(v.y, `${m.id} y`).toBeLessThanOrEqual(claim.yRange[1] + EPS);
      }
    }
  });
});

describe('Commerce Court North — the 1931 tower, height straight out of the data', () => {
  const m = byId.get('commerce-court-west')!;
  const row = buildingSpecsJson.buildings.find((b) => b.id === 'commerce-court-north')!;

  it('is a declared SECONDARY MASS, so it never gets a box placement of its own', () => {
    expect([...NAMED_SECONDARY_MASS_IDS]).toContain('commerce-court-north');
    expect(named.placements.some((p) => p.id === 'commerce-court-north')).toBe(false);
  });

  it('is hGame(real_h_m) × NAMED_HEIGHT_SCALE — never a literal', () => {
    expect(row.real_h_m).toBe(137);
    expect(m.probes.northHeight).toBeCloseTo(hGame(row.real_h_m) * NAMED_HEIGHT_SCALE, 9);
    // …and it really is the tall thing in the plaza: above the eye line, which is why it belongs in
    // the bespoke mesh (registered as an occludable) rather than as loose decoration.
    expect(m.probes.northHeight).toBeGreaterThan(CAMERA_EYE_MIN_WU);
    expect(m.probes.northHeight).toBeLessThan(m.probes.dataHeight);
    expect(m.parts[1].id).toBe('commerce-court-north');
  });

  it('its footprint is the data row\'s, and its geometry really reaches its stated height', () => {
    expect(m.probes.northMaxX - m.probes.northMinX).toBeGreaterThanOrEqual(row.footprint_wu);
    expect(m.probes.northMaxZ - m.probes.northMinZ).toBeGreaterThanOrEqual(row.footprint_wu);
    const mass = m.verts.slice(m.parts[0].triangles * 3);
    expect(Math.max(...mass.map((v) => v.y))).toBeCloseTo(m.probes.northHeight, 3);
  });

  it('stands on the KING STREET frontage with a real forecourt behind it and a real kerb gap', () => {
    const king = street('king');
    expect(m.probes.northMaxZ).toBeLessThanOrEqual(king.ribbon.minY - 2);
    expect(m.probes.plazaDepth).toBeGreaterThan(4); // I.M. Pei's forecourt, between the two towers
    // Its west wall aligns with Pei's own (which namedBuildings flushed to Bay), i.e. the King ×
    // Bay corner — and it stays clear of Bay's ribbon.
    expect(m.probes.northMinX).toBeCloseTo(m.box.cx - m.box.hx, 6);
    expect(m.probes.northMinX).toBeGreaterThan(street('bay').ribbon.maxX + 2);
  });
});

describe('TD banking pavilion — the single-storey building the street actually meets', () => {
  const m = byId.get('td-bank-tower')!;

  it('is ONE storey (the verified fact) at a derived, grand-storey height', () => {
    expect(m.probes.pavilionStoreys).toBeGreaterThan(1);
    expect(m.probes.pavilionStoreys).toBeLessThan(2);
    expect(m.probes.pavilionHeight).toBeGreaterThan(4);
    expect(m.probes.pavilionHeight).toBeLessThan(CAMERA_EYE_MIN_WU);
    expect(m.parts[1].id).toBe('td-banking-pavilion');
  });

  it('sits on the plaza between the tower and Front Street, clear of both', () => {
    expect(m.probes.pavilionMinZ).toBeGreaterThan(m.box.cz + m.box.hz); // outside the data footprint
    expect(m.probes.pavilionMaxZ).toBeLessThanOrEqual(street('front').ribbon.minY - 2);
    expect(m.probes.pavilionMaxX).toBeLessThanOrEqual(street('bay').ribbon.minX - 2);
    expect(m.probes.pavilionMaxX - m.probes.pavilionMinX).toBeGreaterThan(8);
  });
});

// -------------------------------------------------------------------------------------------------
// render groups
// -------------------------------------------------------------------------------------------------

describe('financial towers — two render groups, split on the block they occupy', () => {
  /** A bespoke's world centre from its own built geometry — `buildBespokeRenderMeshes`'s own
   * measure, replicated so the ≤ 200 wu law is checked before the registry ever pools these. */
  function centre(m: Measured): { x: number; z: number } {
    const xs = m.verts.map((v) => v.x);
    const zs = m.verts.map((v) => v.z);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
  }

  function span(ids: readonly string[]): number {
    const centres = ids.map((id) => centre(byId.get(id)!));
    let out = 0;
    for (const a of centres) for (const b of centres) out = Math.max(out, Math.hypot(a.x - b.x, a.z - b.z));
    return out;
  }

  it('names the two groups and assigns every tower to exactly one', () => {
    expect(FINANCIAL_NORTH_RENDER_GROUP).toBe('financial-north');
    expect(FINANCIAL_SOUTH_RENDER_GROUP).toBe('financial-south');
    for (const t of TOWERS) expect(byId.get(t.id)!.bespoke.renderGroup, t.id).toBe(t.group);
    const north = TOWERS.filter((t) => t.group === FINANCIAL_NORTH_RENDER_GROUP).map((t) => t.id);
    const south = TOWERS.filter((t) => t.group === FINANCIAL_SOUTH_RENDER_GROUP).map((t) => t.id);
    expect([...north].sort()).toEqual(['commerce-court-west', 'first-canadian-place', 'scotia-plaza']);
    expect([...south].sort()).toEqual(['cibc-square', 'royal-bank-plaza', 'td-bank-tower']);
  });

  it('each group stays inside the seam\'s 200 wu block-local law — and ONE group would not', () => {
    // A pooled group fades as a single mesh, so grouping across blocks ghosts unrelated skyline
    // (NamedBespoke.renderGroup). This is the number that forces the split, pinned rather than
    // asserted in a comment.
    const north = span(['first-canadian-place', 'scotia-plaza', 'commerce-court-west']);
    const south = span(['td-bank-tower', 'royal-bank-plaza', 'cibc-square']);
    expect(north).toBeLessThanOrEqual(200);
    expect(south).toBeLessThanOrEqual(200);
    expect(span(TOWERS.map((t) => t.id))).toBeGreaterThan(200);
  });
});

// -------------------------------------------------------------------------------------------------
// wordmarks / determinism
// -------------------------------------------------------------------------------------------------

describe('financial towers — no atlas wordmark, and full determinism', () => {
  it('carries no signQuads: a bank tower\'s wordmark IS its §4 CROWN decal', () => {
    for (const m of measured) expect(m.bespoke.signQuads, m.id).toEqual([]);
    for (const m of measured) expect(placement(m.id).decals.length, m.id).toBe(2);
  });

  it('rebuilds byte-identically', () => {
    for (const t of TOWERS) {
      const again = t.build().buildGeometry();
      const first = byId.get(t.id)!;
      for (const name of ['position', 'normal', 'color']) {
        expect(Array.from(again.geometry.getAttribute(name).array as Float32Array), `${t.id}.${name}`).toEqual(
          Array.from(first.geometry.getAttribute(name).array as Float32Array),
        );
      }
      expect(again.parts).toEqual(first.parts);
    }
  });

  it('derives every dimension from the placement alone (the P27 literal-drift tripwire)', () => {
    // Resolved a second time from a freshly built world, every derived edge must land in the same
    // place — the assertion that catches a world coordinate typed into this module by hand.
    const fresh = buildNamedBuildings();
    const freshCtx = namedGeometryCtx(buildStreets().streets);
    const rebuilt: Record<string, NamedBespoke> = {
      'first-canadian-place': buildFirstCanadianPlaceBespoke(fresh.placements.find((p) => p.id === 'first-canadian-place')!),
      'scotia-plaza': buildScotiaPlazaBespoke(fresh.placements.find((p) => p.id === 'scotia-plaza')!),
      'td-bank-tower': buildTdBankTowerBespoke(fresh.placements.find((p) => p.id === 'td-bank-tower')!),
      'commerce-court-west': buildCommerceCourtBespoke(fresh.placements.find((p) => p.id === 'commerce-court-west')!, freshCtx),
      'royal-bank-plaza': buildRoyalBankPlazaBespoke(fresh.placements.find((p) => p.id === 'royal-bank-plaza')!),
      'cibc-square': buildCibcSquareBespoke(fresh.placements.find((p) => p.id === 'cibc-square')!),
    };
    for (const m of measured) {
      expect(rebuilt[m.id].meta.probes, m.id).toEqual(m.probes);
      expect(rebuilt[m.id].extraClaims, m.id).toEqual(m.bespoke.extraClaims);
      expect(rebuilt[m.id].renderBoxes, m.id).toEqual(m.bespoke.renderBoxes);
    }
  });

  it('throws loudly when the world cannot hold a secondary mass, instead of burying it', () => {
    // The one place this module reads the street table: Commerce North flushes to King. A future
    // frontage change that closed the plaza must fail, not silently overlap Pei's slab.
    const shifted = {
      ...placement('commerce-court-west'),
      boxes: [{ ...placement('commerce-court-west').boxes[0], cz: street('king').ribbon.minY - 4 }],
    };
    expect(() => buildCommerceCourtBespoke(shifted, ctx)).toThrow(/King frontage/);
  });
});
