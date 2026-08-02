/**
 * Phase 48 (Part 11) — the Hockey Hall of Fame (1885 Bank of Montreal), the sixth
 * `namedGeometryBuilders` tenant.
 *
 * Same two kinds of assertion as oldCityHall.test.ts / royalYork.test.ts, and the second kind is
 * the point:
 *   • BUDGETS — a ceiling AND a floor. v1 was a 12-triangle extruded box, and a ceiling-only budget
 *     is passed just as happily by that box as by the real landmark, so the floor is what makes a
 *     silent revert fail.
 *   • VERTEX PROBES — the geometry is MEASURED, not described. The arcade really is four
 *     round-headed bays between five proud piers on BOTH camera-visible elevations, the corner
 *     entrance really is a canted bay that clears the building's own proudest course (the one
 *     derivation in this model that a hand-tuned literal would have got wrong), the dome really is
 *     a circle-derived profile on a rolled 10-gon drum, and the finial really lands on the DATA
 *     height.
 *
 * The builder is called DIRECTLY rather than through `resolveNamedBespoke`: the registry entry in
 * namedGeometry.ts is the orchestrator's to add, and this file must be green before it exists.
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { CAMERA_EYE_MIN_WU } from '../../config/camera';
import { WALL_STACK } from '../../config/layering';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { buildHockeyHallOfFameBespoke, HOCKEY_HALL_MAX_TRIS } from './hockeyHallOfFame';
import { buildNamedBuildings } from './namedBuildings';

const named = buildNamedBuildings();
const placement = named.placements.find((p) => p.id === 'hockey-hall-of-fame')!;
const dataBox = placement.boxes[0];
const bespoke = buildHockeyHallOfFameBespoke(placement);
const built = bespoke.buildGeometry();
const probes = bespoke.meta.probes;

/** The building's own corner and the SE unit diagonal the fixed rig looks down. */
const xEast = dataBox.cx + dataBox.hx;
const zSouth = dataBox.cz + dataBox.hz;
const SQRT1_2 = Math.SQRT1_2;

interface Vertex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function positions(geometry: BufferGeometry): Float32Array {
  return geometry.getAttribute('position').array as Float32Array;
}

function vertices(geometry: BufferGeometry): Vertex[] {
  const p = positions(geometry);
  const out: Vertex[] = [];
  for (let i = 0; i < p.length; i += 3) out.push({ x: p[i], y: p[i + 1], z: p[i + 2] });
  return out;
}

const verts = vertices(built.geometry);

/** One triangle reduced to what the assertions below care about: where it is and what colour it is.
 * Centroids (rather than raw vertices) are what make a BAND measurable — a ring of vertices is
 * shared by the band above it and the band below it, a centroid belongs to exactly one. */
interface Facet {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly color: string;
}

function facets(geometry: BufferGeometry): Facet[] {
  const p = positions(geometry);
  const c = geometry.getAttribute('color').array as Float32Array;
  const out: Facet[] = [];
  for (let i = 0; i < p.length; i += 9) {
    out.push({
      cx: (p[i] + p[i + 3] + p[i + 6]) / 3,
      cy: (p[i + 1] + p[i + 4] + p[i + 7]) / 3,
      cz: (p[i + 2] + p[i + 5] + p[i + 8]) / 3,
      color: [c[i], c[i + 1], c[i + 2]].map((v) => v.toFixed(5)).join(','),
    });
  }
  return out;
}

const tris = facets(built.geometry);

/** Group a coordinate list into clusters no wider apart than `gap` — the unionStation / oldCityHall
 * column-probe idiom, used here to count arcade piers and openings. */
function clusters(values: readonly number[], gap: number): number[][] {
  const out: number[][] = [];
  for (const v of [...new Set(values.map((n) => Math.round(n * 1000) / 1000))].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last !== undefined && v - last[last.length - 1] <= gap) last.push(v);
    else out.push([v]);
  }
  return out;
}

/** Distance from the box centre along the SE diagonal — the axis the canted corner bay lives on. */
function diagonalOf(x: number, z: number): number {
  return (x - dataBox.cx + (z - dataBox.cz)) * SQRT1_2;
}

// -------------------------------------------------------------------------------------------------
// budget
// -------------------------------------------------------------------------------------------------

describe('Hockey Hall of Fame — tri budget (Part 11 rule 2)', () => {
  it('stays inside its 500-tri budget, with a floor a plain box could never clear', () => {
    expect(HOCKEY_HALL_MAX_TRIS).toBe(500);
    expect(built.triangles).toBeLessThanOrEqual(HOCKEY_HALL_MAX_TRIS);
    // THE FLOOR: courses + two arcades + the canted corner entrance with steps + the drum and dome
    // cannot be built for less than this, so a regression that quietly reverted any whole subsystem
    // fails here even though every proportion pin below would still pass.
    expect(built.triangles).toBeGreaterThan(260);
    expect(built.triangles).toBe(positions(built.geometry).length / 9);
  });

  it('splits into a body half and a dome half, neither of which may collapse to a stub', () => {
    expect(built.parts.map((p) => p.id)).toEqual(['hockey-hall-of-fame-body', 'hockey-hall-of-fame-dome']);
    expect(built.parts.reduce((n, p) => n + p.triangles, 0)).toBe(built.triangles);
    for (const part of built.parts) expect(part.triangles, part.id).toBeGreaterThan(100);
  });
});

// -------------------------------------------------------------------------------------------------
// the massing: data-height truth + the shortened render box
// -------------------------------------------------------------------------------------------------

describe('Hockey Hall of Fame — heights are the DATA row, not a new invention', () => {
  it('the finial tops out at EXACTLY the data height', () => {
    const dataHeight = dataBox.hy * 2;
    expect(probes.dataHeight).toBeCloseTo(dataHeight, 12);
    expect(probes.topY).toBeCloseTo(dataHeight, 12);
    expect(bespoke.meta.topY).toBeCloseTo(dataHeight, 12);
    const maxY = Math.max(...verts.map((v) => v.y));
    expect(maxY).toBeCloseTo(dataHeight, 3);
    // …and the tallest geometry is the finial's own tip, on the dome's axis — not some other
    // element that grew past it. (Float32 at world coordinates ~2.2e3 carries ~1e-4 of absolute
    // precision, so positional comparisons here are made at 3 decimals, never at machine epsilon.)
    for (const v of verts.filter((p) => p.y > dataHeight - 1e-4)) {
      expect(Math.hypot(v.x - dataBox.cx, v.z - dataBox.cz)).toBeLessThan(probes.drumRadius);
    }
  });

  it('stays BELOW the eye line — this landmark can never become a heightLaw crosser', () => {
    expect(probes.dataHeight).toBeLessThan(CAMERA_EYE_MIN_WU);
    expect(bespoke.meta.topY).toBeLessThan(CAMERA_EYE_MIN_WU);
  });

  it('the render box is the BODY height — 0.62 of the data height, same footprint and look', () => {
    expect(bespoke.renderBoxes).toHaveLength(1);
    const render = bespoke.renderBoxes[0];
    expect(render.hy).toBeLessThan(dataBox.hy); // the Old City Hall pattern: the box SHRINKS
    expect(render.hy * 2).toBeCloseTo(probes.bodyTopY, 12);
    expect(probes.bodyTopY / probes.dataHeight).toBeCloseTo(0.62, 6);
    expect([render.cx, render.cz, render.hx, render.hz]).toEqual([dataBox.cx, dataBox.cz, dataBox.hx, dataBox.hz]);
    expect(render.look).toEqual(dataBox.look);
    // One data box, one render box: the identity mapping, so no `renderBoxDataIndices` is declared.
    expect(bespoke.renderBoxDataIndices).toBeUndefined();
  });

  it('is NOT pooled into a render group — its nearest poolable neighbour is a block away', () => {
    // A `renderGroup` fades as ONE unit and the seam caps a group's span at 200 wu (one city
    // block); the bank cluster is ~120 wu west of here across Yonge, which is a different block.
    expect(bespoke.renderGroup).toBeUndefined();
  });

  it('stacks in order: plinth → arcade → cornice → parapet → drum → dome → finial', () => {
    expect(probes.plinthTopY).toBeGreaterThan(0);
    expect(probes.archSpringY).toBeGreaterThan(probes.plinthTopY);
    expect(probes.archApexY).toBeLessThan(probes.arcadeTopY); // the arch heads clear the impost band
    expect(probes.arcadeCorniceTopY).toBeGreaterThan(probes.arcadeTopY);
    expect(probes.bodyTopY).toBeGreaterThan(probes.arcadeCorniceTopY); // an upper storey survives
    expect(probes.deckY).toBeGreaterThan(probes.bodyTopY); // the cornice, whose top IS the roof deck
    expect(probes.parapetTopY).toBeGreaterThan(probes.deckY);
    expect(probes.crownPlinthTopY).toBeGreaterThan(probes.deckY);
    expect(probes.drumGlassBaseY).toBeGreaterThan(probes.crownPlinthTopY);
    expect(probes.domeBaseY).toBeGreaterThan(probes.drumGlassBaseY);
    expect(probes.domeShellTopY).toBeGreaterThan(probes.domeBaseY);
    expect(probes.finialNeckTopY).toBeGreaterThan(probes.domeShellTopY);
    expect(probes.topY).toBeGreaterThan(probes.finialNeckTopY);
    // The crown really is a crown: everything above the cornice is a real share of the elevation.
    expect(probes.crownRise / probes.dataHeight).toBeGreaterThan(0.25);
  });
});

// -------------------------------------------------------------------------------------------------
// the exclusion-margin law: nothing may leave the 3 wu massing margin
// -------------------------------------------------------------------------------------------------

describe('Hockey Hall of Fame — every proud element stays inside the massing margin', () => {
  it('no vertex is more than 2.5 wu outside any data-box face, or below the ground', () => {
    // namedBuildings.ts inflates every named footprint by a 3 wu massing-exclusion margin; anything
    // beyond that pokes into ground other placers own. 2.5 keeps a visible margin inside that.
    const limit = 2.5;
    expect(Math.max(...verts.map((v) => v.x)) - xEast).toBeLessThanOrEqual(limit);
    expect(Math.max(...verts.map((v) => v.z)) - zSouth).toBeLessThanOrEqual(limit);
    expect(dataBox.cx - dataBox.hx - Math.min(...verts.map((v) => v.x))).toBeLessThanOrEqual(limit);
    expect(dataBox.cz - dataBox.hz - Math.min(...verts.map((v) => v.z))).toBeLessThanOrEqual(limit);
    expect(Math.min(...verts.map((v) => v.y))).toBeGreaterThanOrEqual(0);
  });

  it('declares no extra claim, collider or wordmark — the DATA box already describes it', () => {
    expect(bespoke.extraClaims).toEqual([]);
    expect(bespoke.extraColliders).toEqual([]);
    // NO wordmark and NO league/team iconography of any kind: this landmark is depicted as
    // architecture only (see the module header and its credits entry).
    expect(bespoke.signQuads).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// THE landmark feature: the arcade on both camera-visible elevations
// -------------------------------------------------------------------------------------------------

describe.each([
  ['south', 'z', 'x'] as const,
  ['east', 'x', 'z'] as const,
])('Hockey Hall of Fame — the %s arcade', (elevation, outAxis, alongAxis) => {
  const facePlane = elevation === 'south' ? zSouth : xEast;
  const out = (v: Vertex): number => (outAxis === 'z' ? v.z : v.x);
  const along = (v: Vertex): number => (alongAxis === 'x' ? v.x : v.z);
  /** The arcade storey, INCLUSIVE of its own top and bottom rings — a box's only vertices are at
   * its extremes, so a strict-interior filter would find no pier at all. */
  const inStorey = (v: Vertex): boolean => v.y >= probes.plinthTopY - 1e-3 && v.y <= probes.arcadeTopY + 1e-3;

  it('carries one proud pier at every bay boundary, standing clear of the facade', () => {
    // Exactly at the pier's own proud plane: the plinth ring below (0.42 proud) and the impost band
    // above (0.44) are both prouder and fall outside this window, so what is left is piers.
    const piers = verts.filter((v) => inStorey(v) && Math.abs(out(v) - (facePlane + probes.pierProudWu)) < 1e-3);
    expect(clusters(piers.map(along), 1.05 * probes.pierWidthWu)).toHaveLength(probes.pierCount);
    expect(probes.pierCount).toBe(probes.archBays + 1); // one pier at every bay boundary
  });

  it('carries four round-headed openings, one per bay, set BACK behind the piers', () => {
    // The openings live one WALL_STACK rung proud of the facade — never coplanar with the §4
    // textured render box (the Phase 42 anti-coplanar rule applied at the source) and a full pier
    // depth behind the piers, which is what makes this an arcade rather than a decal.
    const openings = verts.filter((v) => inStorey(v) && Math.abs(out(v) - (facePlane + WALL_STACK.crownDecal)) < 1e-3);
    expect(openings.length).toBeGreaterThan(0);
    // Counted at the arch CROWNS: one per opening, and they are a full bay pitch apart. (The
    // openings' own flanks cannot be clustered — an opening is wider than the pier between two of
    // them, so an x-cluster of jamb vertices merges the whole arcade into one run.)
    const crowns = openings.filter((v) => Math.abs(v.y - probes.archApexY) < 1e-3).map(along);
    expect(clusters(crowns, 1e-2)).toHaveLength(probes.archBays);
    const spacing = [...new Set(crowns.map((n) => Math.round(n * 1000) / 1000))].sort((a, b) => a - b);
    expect(spacing[1] - spacing[0]).toBeCloseTo(probes.bayPitch, 3);
    expect(WALL_STACK.crownDecal).toBeLessThan(probes.pierProudWu);
  });

  it('the openings are ARCHES: a semicircular head springs above the rectangle', () => {
    const heads = verts.filter(
      (v) =>
        Math.abs(out(v) - (facePlane + WALL_STACK.crownDecal)) < 1e-3 &&
        v.y > probes.archSpringY + 1e-3 &&
        v.y < probes.arcadeTopY,
    );
    expect(heads.length).toBeGreaterThan(0);
    // A semicircular head rises by exactly its own half-width above the springing line.
    expect(Math.max(...heads.map((v) => v.y))).toBeCloseTo(probes.archSpringY + probes.archHalfWidth, 3);
    expect(probes.archApexY).toBeCloseTo(probes.archSpringY + probes.archHalfWidth, 12);
  });

  it('an impost band runs over the whole arcade, prouder than the piers it caps', () => {
    const band = verts.filter((v) => v.y > probes.arcadeTopY + 1e-3 && v.y < probes.arcadeCorniceTopY + 1e-3);
    expect(band.length).toBeGreaterThan(0);
    expect(Math.max(...band.map(out))).toBeCloseTo(facePlane + probes.arcadeCorniceProudWu, 3);
    expect(probes.arcadeCorniceProudWu).toBeGreaterThan(probes.pierProudWu);
  });
});

describe('Hockey Hall of Fame — the arcade clears the thin-geometry floor', () => {
  it('piers are wide enough and deep enough to survive minification (P41 law)', () => {
    // A to-scale pilaster is well under 0.3 wu and would strobe at play distance, so these are
    // deliberately up-scaled — the same call royalYork.ts's dormers document.
    expect(probes.pierWidthWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    expect(probes.pierProudWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    expect(2 * probes.archHalfWidth).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });

  it('the entrance treads clear it too — the tread is what a 58° camera sees of a step', () => {
    expect(probes.stepTreadWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });
});

// -------------------------------------------------------------------------------------------------
// the canted corner entrance (researched: the grand arched entrance is AT the corner)
// -------------------------------------------------------------------------------------------------

describe('Hockey Hall of Fame — the canted corner entrance', () => {
  const cantedFace = verts.filter((v) => Math.abs(diagonalOf(v.x, v.z) - probes.cornerFaceDiagonalWu) < 1e-3);

  it('stands on the SE corner — the one the fixed rig frames head-on', () => {
    expect(cantedFace.length).toBeGreaterThan(0);
    // Its shoulders sit CORNER_BAY_RUN_WU back along each elevation, and the face spans the
    // diagonal between them.
    expect(probes.cornerBayShoulderU).toBeCloseTo(dataBox.hx - probes.cornerBayRunWu, 12);
    expect(probes.cornerBayHalfWidth).toBeCloseTo((probes.cornerBayRunWu * Math.SQRT2) / 2, 12);
    expect(Math.max(...cantedFace.map((v) => v.y))).toBeCloseTo(probes.cornerBayTopY, 3);
  });

  it('is pushed out far enough to clear the building CORNER and its proudest course', () => {
    // THE derivation this model would most easily get wrong: a canted face pushed out by less than
    // run/√2 has the box's own corner poking through it, and one pushed out by less than that plus
    // the plinth's diagonal reach has the PLINTH's corner poking through it.
    expect(probes.widestCourseProudWu).toBeGreaterThan(0);
    expect(probes.cornerBayProudWu).toBeCloseTo(
      probes.cornerBayRunWu * SQRT1_2 + probes.widestCourseProudWu * Math.SQRT2 + probes.cornerFaceMarginWu,
      12,
    );
    // Measured, not asserted from the constants: the box corner and every course ring below the
    // cornice sits BEHIND the canted plane.
    expect(diagonalOf(xEast, zSouth)).toBeLessThan(probes.cornerFaceDiagonalWu);
    for (const y of [probes.plinthTopY, probes.bodyTopY]) {
      const ring = verts.filter((v) => Math.abs(v.y - y) < 1e-3 && diagonalOf(v.x, v.z) > diagonalOf(xEast, zSouth));
      for (const v of ring) expect(diagonalOf(v.x, v.z)).toBeLessThan(probes.cornerFaceDiagonalWu);
    }
  });

  it('carries an arched portal springing from the arcade\'s own line, inside a stone surround', () => {
    // The portal shares its springing line with the arcade beside it — that shared line is what
    // makes the corner read as part of the same building rather than as a bolted-on porch.
    expect(probes.portalSpringY).toBeGreaterThan(probes.plinthTopY);
    expect(probes.portalSpringY).toBeLessThan(probes.arcadeTopY);
    expect(probes.portalHalfWidth).toBeLessThan(probes.cornerBayHalfWidth);
    // Surround at one rung, opening at the next — never coplanar with each other or with the face.
    const surround = verts.filter((v) => Math.abs(diagonalOf(v.x, v.z) - (probes.cornerFaceDiagonalWu + WALL_STACK.crownDecal)) < 1e-3);
    const opening = verts.filter((v) => Math.abs(diagonalOf(v.x, v.z) - (probes.cornerFaceDiagonalWu + WALL_STACK.fasciaBand)) < 1e-3);
    expect(surround.length).toBeGreaterThan(0);
    expect(opening.length).toBeGreaterThan(0);
    expect(WALL_STACK.fasciaBand).toBeGreaterThan(WALL_STACK.crownDecal);
    expect(Math.max(...opening.map((v) => v.y))).toBeCloseTo(probes.portalSpringY + probes.portalHalfWidth, 3);
  });

  it('has steps down to the pavement — real geometry, on no GROUND_STACK rung', () => {
    // Painted ground would need a new rung in config/layering.ts's ladder, and that ladder is LAW
    // (Phase 39): a landmark builder expresses a step as geometry instead.
    const treads = verts.filter(
      (v) => v.y > 1e-3 && v.y < probes.plinthTopY - 1e-3 && diagonalOf(v.x, v.z) > probes.cornerFaceDiagonalWu + 1e-3,
    );
    expect(clusters(treads.map((v) => v.y), 1e-2)).toHaveLength(probes.stepCount);
    // The flight descends AWAY from the door: each tread further out is lower than the last.
    const outerMost = Math.max(...treads.map((v) => diagonalOf(v.x, v.z)));
    expect(outerMost).toBeCloseTo(probes.cornerFaceDiagonalWu + probes.stepRunWu, 3);
    const lowest = treads.filter((v) => diagonalOf(v.x, v.z) > outerMost - 1e-3);
    expect(Math.min(...lowest.map((v) => v.y))).toBeLessThan(probes.plinthTopY / 2);
  });
});

// -------------------------------------------------------------------------------------------------
// the dome on its drum
// -------------------------------------------------------------------------------------------------

describe('Hockey Hall of Fame — the dome on its drum', () => {
  const radial = (v: Vertex): number => Math.hypot(v.x - dataBox.cx, v.z - dataBox.cz);

  it('sits SET BACK on the roof, entirely inside the building footprint', () => {
    const crown = verts.filter((v) => v.y > probes.deckY + 1e-3);
    expect(crown.length).toBeGreaterThan(0);
    // Nothing above the roof deck except the parapet ring may reach the footprint edge.
    const domeOnly = crown.filter((v) => v.y > probes.parapetTopY + 1e-3);
    expect(Math.max(...domeOnly.map(radial))).toBeLessThanOrEqual(probes.domeEaveRadius + 1e-3);
    expect(probes.domeEaveRadius).toBeLessThan(dataBox.hx);
  });

  it('the drum is a true cylinder of DOME_SIDES facets, rolled onto the camera boresight', () => {
    // The parapet ring's top edge also falls in this Y range — it is out at the footprint edge, so
    // "inboard of half the footprint" separates the crown from it without assuming the answer.
    const drum = verts.filter(
      (v) => v.y > probes.drumBaseY + 1e-3 && v.y < probes.domeBaseY - 1e-3 && radial(v) < dataBox.hx / 2,
    );
    expect(drum.length).toBeGreaterThan(0);
    for (const v of drum) expect(radial(v)).toBeCloseTo(probes.drumRadius, 3);
    // A FACET, not a corner, faces the fixed rig: the nearest vertex azimuth to the SE boresight
    // (π/4) is exactly half a facet away, i.e. the boresight bisects a facet (the CN-tower roll).
    const azimuths = drum.map((v) => Math.atan2(v.z - dataBox.cz, v.x - dataBox.cx));
    const nearest = Math.min(...azimuths.map((a) => Math.abs(a - Math.PI / 4)));
    expect(nearest).toBeCloseTo(Math.PI / probes.domeSides, 3);
    expect(probes.boresightRoll).toBeCloseTo(Math.PI / 4 - Math.PI / probes.domeSides, 12);
  });

  it('the shell is a CIRCLE-derived profile, not a cone', () => {
    // r = R·√(1 − t²) at the profile's own heights: a straight-sided cone would put the mid band's
    // radius at the linear interpolant, which is measurably smaller.
    const eave = probes.domeEaveRadius;
    const shellRise = probes.domeShellTopY - probes.domeBaseY;
    const t = 0.42; // DOME_PROFILE_T[1]
    const tMax = 0.96;
    const y = probes.domeBaseY + (t / tMax) * shellRise;
    const ring = verts.filter((v) => Math.abs(v.y - y) < 1e-3);
    expect(ring.length).toBeGreaterThan(0);
    const measured = Math.max(...ring.map(radial));
    expect(measured).toBeCloseTo(eave * Math.sqrt(1 - t * t), 3);
    const cone = eave * (1 - t / tMax);
    expect(measured).toBeGreaterThan(cone + 0.2);
    // Three bands, and the shell springs from an eave wider than the drum it stands on.
    expect(probes.domeBands).toBe(3);
    expect(probes.domeEaveRadius).toBeGreaterThan(probes.drumRadius);
  });

  it('the glazed drum band is UNSHADED (lit from within) while the stone band below is shaded', () => {
    const band = (y0: number, y1: number): string[] => [
      ...new Set(
        tris
          .filter((f) => f.cy > y0 && f.cy < y1 && Math.abs(Math.hypot(f.cx - dataBox.cx, f.cz - dataBox.cz) - probes.drumRadius) < 0.2)
          .map((f) => f.color),
      ),
    ];
    // The glass band's facets all carry the SAME colour — that is what `unshaded` means: the baked
    // directional key is skipped, so a lit surface cannot go dark on the facets facing away.
    expect(band(probes.drumGlassBaseY, probes.domeBaseY)).toHaveLength(1);
    // The stone drum immediately below it takes the bake, so its facets differ.
    expect(band(probes.drumBaseY, probes.drumGlassBaseY).length).toBeGreaterThan(1);
  });

  it('carries the stone and the copper-patina colour families (and one lit accent)', () => {
    // Stone reads warm (R > B); oxidized copper reads the opposite (G dominant). A crude but
    // decisive channel split, robust to the baked directional shade — a uniform per-vertex scalar
    // cannot change which channel is largest (royalYork.test.ts's idiom).
    const colors = built.geometry.getAttribute('color').array as Float32Array;
    let warm = 0;
    let green = 0;
    for (let i = 0; i < colors.length; i += 3) {
      const [r, g, b] = [colors[i], colors[i + 1], colors[i + 2]];
      if (r > b) warm++;
      else if (g >= r && g >= b) green++;
    }
    expect(warm).toBeGreaterThan(0);
    expect(green).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------------
// determinism
// -------------------------------------------------------------------------------------------------

describe('Hockey Hall of Fame — determinism', () => {
  it('rebuilds byte-identically', () => {
    const again = buildHockeyHallOfFameBespoke(placement).buildGeometry();
    for (const name of ['position', 'normal', 'color']) {
      expect(Array.from(again.geometry.getAttribute(name).array as Float32Array)).toEqual(
        Array.from(built.geometry.getAttribute(name).array as Float32Array),
      );
    }
    expect(again.parts).toEqual(built.parts);
  });

  it('derives every dimension from the placement alone (no literal world coordinates)', () => {
    const fresh = buildNamedBuildings().placements.find((p) => p.id === 'hockey-hall-of-fame')!;
    expect(buildHockeyHallOfFameBespoke(fresh).meta.probes).toEqual(probes);
  });
});
