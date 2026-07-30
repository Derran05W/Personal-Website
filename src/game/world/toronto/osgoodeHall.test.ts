/**
 * Phase 47 T2 (Part 11) — Osgoode Hall, the fifth `namedGeometryBuilders` tenant and the seam's
 * first SET-BACK landmark.
 *
 * Three kinds of assertion:
 *   • BUDGETS — a ceiling AND a floor (royalYork.test.ts's idiom: v1 was a 12-triangle box, and a
 *     ceiling-only budget would happily take it back).
 *   • VERTEX PROBES — the lawn really is painted on the ladder's `parkGround` rung, the fence really
 *     has a gate, the portico really has four columns standing off the facade.
 *   • THE STREET DERIVATION — the lawn is bounded by Queen's and University's ribbons plus the
 *     sidewalk band, never by a literal, and its east edge is pinned SHORT of the civic square's
 *     own claim (the seam between this builder and newCityHall.ts, which the two agents that wrote
 *     them could not otherwise have checked against each other).
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { CAMERA_EYE_MIN_WU } from '../../config/camera';
import { GROUND_STACK, MIN_GROUND_SEP_WU } from '../../config/layering';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { SIDEWALK } from '../../config/torontoMap';
import { overlaps } from './claimIndex';
import { buildNamedBuildings } from './namedBuildings';
import { resolveNamedBespoke } from './namedGeometry';
import { OSGOODE_HALL_MAX_TRIS } from './osgoodeHall';
import { buildStreets } from './streets';

const named = buildNamedBuildings();
const placement = named.placements.find((p) => p.id === 'osgoode-hall')!;
const dataBox = placement.boxes[0];
const bespoke = resolveNamedBespoke(named.placements).get('osgoode-hall')!;
const built = bespoke.buildGeometry();
const probes = bespoke.meta.probes;

const streets = buildStreets().streets;
const street = (id: string) => streets.find((s) => s.id === id)!;
const queen = street('queen');
const university = street('university');
const bay = street('bay');

function positions(geometry: BufferGeometry): Float32Array {
  return geometry.getAttribute('position').array as Float32Array;
}

function vertices(geometry: BufferGeometry): { x: number; y: number; z: number }[] {
  const p = positions(geometry);
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < p.length; i += 3) out.push({ x: p[i], y: p[i + 1], z: p[i + 2] });
  return out;
}

const verts = vertices(built.geometry);
/** Float32 vertex data at world coordinates ~2e3 carries ~1e-4 of absolute precision, so every
 * positional comparison below is made at 3 decimals, never at machine epsilon. */
const EPS = 1e-3;

/** Group coordinates into clusters no wider apart than `gap`. Callers pass a gap a few percent
 * WIDER than the element's own width — an element's two edges are exactly its width apart in exact
 * arithmetic and a hair more in float32, which would otherwise split every element in two. */
function clusters(values: readonly number[], gap: number): number[][] {
  const out: number[][] = [];
  for (const v of [...new Set(values.map((n) => Math.round(n * 1000) / 1000))].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last !== undefined && v - last[last.length - 1] <= gap) last.push(v);
    else out.push([v]);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// budget
// -------------------------------------------------------------------------------------------------

describe('Osgoode Hall — tri budget (Part 11 rule 2)', () => {
  it('stays inside its 400-tri budget, with a floor a plain box could never clear', () => {
    expect(OSGOODE_HALL_MAX_TRIS).toBe(400);
    expect(built.parts.map((p) => p.id)).toEqual(['osgoode-hall', 'osgoode-grounds']);
    expect(built.parts.reduce((n, p) => n + p.triangles, 0)).toBe(built.triangles);
    expect(built.triangles).toBeLessThanOrEqual(OSGOODE_HALL_MAX_TRIS);
    expect(built.triangles).toBeGreaterThan(150);
    expect(built.triangles).toBe(positions(built.geometry).length / 9);
    // Both halves are real: the building (roof + cupola + portico) and the GROUNDS (lawn + fence)
    // are the two things this landmark is, and neither may quietly disappear.
    for (const part of built.parts) expect(part.triangles, part.id).toBeGreaterThan(40);
  });
});

// -------------------------------------------------------------------------------------------------
// the massing — and the deliberate contrast with the Royal York / Old City Hall pattern
// -------------------------------------------------------------------------------------------------

describe('Osgoode Hall — a FULL-height render box (not the shrunk-body pattern)', () => {
  it('keeps the data box exactly, so the §4 limestone facade paints the whole 3-storey building', () => {
    expect(bespoke.renderBoxes).toHaveLength(1);
    const render = bespoke.renderBoxes[0];
    expect(render.hy).toBeCloseTo(dataBox.hy, 12); // NOT shrunk — the header explains why
    expect([render.cx, render.cz, render.hx, render.hz]).toEqual([dataBox.cx, dataBox.cz, dataBox.hx, dataBox.hz]);
    expect(render.look).toEqual(dataBox.look);
    expect(probes.dataHeight).toBeCloseTo(dataBox.hy * 2, 12);
  });

  it('the whole crown (roof + cupola) is exactly CROWN_RISE_WU above the box — and stays there', () => {
    expect(probes.crownRiseWu).toBe(1.5);
    expect(bespoke.meta.topY).toBeCloseTo(probes.dataHeight + probes.crownRiseWu, 12);
    expect(probes.cupolaTopY).toBeCloseTo(bespoke.meta.topY, 12);
    const maxY = Math.max(...verts.map((v) => v.y));
    expect(maxY).toBeCloseTo(bespoke.meta.topY, 4);
    // …which keeps this landmark far below the eye line: it can never become a heightLaw crosser,
    // and the camera's anti-clip guard never has to think about it.
    expect(bespoke.meta.topY).toBeLessThan(CAMERA_EYE_MIN_WU);
  });

  it('the roof plugs INTO the body and the cupola stacks on the ridge, in order', () => {
    expect(probes.roofBaseY).toBeLessThan(probes.dataHeight); // the skirt: no shared plane with the box cap
    expect(probes.roofRidgeY).toBeGreaterThan(probes.dataHeight);
    expect(probes.cupolaPedestalTopY).toBeGreaterThan(probes.roofRidgeY);
    expect(probes.cupolaDrumTopY).toBeGreaterThan(probes.cupolaPedestalTopY);
    expect(probes.cupolaTopY).toBeGreaterThan(probes.cupolaDrumTopY);
    expect(probes.cupolaSides).toBe(8); // an octagonal lantern, the cheapest "round" read
    // A real (short) ridge, never a degenerate point.
    expect(probes.roofRidgeHalfX).toBeGreaterThan(0);
    expect(probes.roofRidgeHalfZ).toBeGreaterThan(0);
    expect(probes.roofRidgeHalfX).toBeLessThan(dataBox.hx / 2);
  });
});

// -------------------------------------------------------------------------------------------------
// the portico
// -------------------------------------------------------------------------------------------------

describe('Osgoode Hall — the south portico', () => {
  it('is four columns standing off the facade, inside the exclusion margin', () => {
    expect(probes.porticoColumnCount).toBe(4);
    const zSouth = dataBox.cz + dataBox.hz;
    expect(probes.porticoFaceZ).toBeCloseTo(zSouth + probes.porticoDepthWu, 9);
    expect(probes.porticoDepthWu).toBeLessThan(3); // namedBuildings.ts's massing-exclusion margin
    expect(probes.porticoRidgeY).toBeGreaterThan(probes.porticoColumnTopY);
    expect(probes.porticoRidgeY).toBeLessThan(probes.dataHeight); // the pediment stays under the eaves
  });

  it('every column clears the thin-geometry floor (a to-scale column would strobe)', () => {
    expect(probes.porticoColumnThicknessWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });

  it('the four columns really stand there — one distinct cluster each', () => {
    // Between half the column height and the entablature there is nothing else in front of the
    // facade: the lawn is at ground level and the fence tops out around 1 wu.
    const xs = verts
      .filter((v) => v.y > probes.porticoColumnTopY / 2 && v.y <= probes.porticoColumnTopY + EPS && v.z > dataBox.cz + dataBox.hz + EPS)
      .map((v) => v.x);
    expect(clusters(xs, 1.05 * probes.porticoColumnThicknessWu)).toHaveLength(probes.porticoColumnCount);
  });
});

// -------------------------------------------------------------------------------------------------
// THE GROUNDS: the lawn (street-derived, on the ladder) and the 1867 fence
// -------------------------------------------------------------------------------------------------

describe('Osgoode Hall — the lawn is derived from the RIBBONS, never from literals', () => {
  it('reaches from the building to the far edge of each street\'s sidewalk band', () => {
    // South: the lawn ends where Queen's north walk begins. West: it ends where University's east
    // walk ends. Both are one arithmetic step off the ribbon the street table resolves.
    expect(probes.lawnSMaxZ).toBeCloseTo(queen.ribbon.minY - SIDEWALK.widthWu, 9);
    expect(probes.lawnWMinX).toBeCloseTo(university.ribbon.maxX + SIDEWALK.widthWu, 9);
    expect(probes.lawnSMinX).toBeCloseTo(probes.lawnWMinX, 9);
    // It starts south of the portico (the porch stands on its own ground, not in the grass) and
    // stops at the building's west wall.
    expect(probes.lawnSMinZ).toBeCloseTo(dataBox.cz + dataBox.hz + probes.porticoDepthWu, 9);
    expect(probes.lawnWMaxX).toBeCloseTo(dataBox.cx - dataBox.hx, 9);
    expect(probes.lawnWMinZ).toBeCloseTo(dataBox.cz - dataBox.hz, 9);
    expect(probes.lawnWMaxZ).toBeCloseTo(probes.lawnSMinZ, 9);
  });

  it('is a REAL set-back: the yard between facade and kerb is deeper than the flush-frontage gap', () => {
    // The point of the AUTHORS entry's "deliberately NOT flush" note, measured: a flush landmark
    // sits 3 wu off the ribbon edge; this one is set back far enough for a lawn to read.
    expect(probes.lawnSMaxZ - probes.lawnSMinZ).toBeGreaterThan(3);
    expect(probes.lawnWMaxX - probes.lawnWMinX).toBeGreaterThan(3);
  });

  it('THE SEAM WITH THE CIVIC SQUARE: the lawn never reaches Nathan Phillips Square\'s claim', () => {
    // Two agents built these layers in parallel this phase, so the boundary is pinned here rather
    // than discovered at integration. `campusX` mirrors newCityHall's placement rule (the midpoint
    // of the University and Bay centrelines) and the square's west edge is campusX − 24.
    const campusX = (university.centerline + bay.centerline) / 2;
    const squareMinX = campusX - 24;
    expect(probes.lawnSMaxX).toBeLessThan(squareMinX);
    // …and it never runs more than 3 wu past the building's own footprint either.
    expect(probes.lawnSMaxX).toBeLessThanOrEqual(dataBox.cx + dataBox.hx + 3);
  });

  it('is painted on the ladder\'s parkGround rung — never on a hand-rolled epsilon', () => {
    expect(probes.lawnY).toBe(GROUND_STACK.parkGround);
    // MEASURED: every near-ground vertex sits either on the ground (fence posts / column bases at
    // y = 0) or exactly on the rung. A stray hand-picked Y would show up here as a third value.
    const lowYs = [...new Set(verts.filter((v) => v.y < 0.1).map((v) => Math.round(v.y * 1e6) / 1e6))].sort((a, b) => a - b);
    expect(lowYs).toEqual([0, Math.round(GROUND_STACK.parkGround * 1e6) / 1e6]);
    // …and the quads on that rung are exactly the two claimed rects.
    const lawnVerts = verts.filter((v) => Math.abs(v.y - GROUND_STACK.parkGround) < 1e-6);
    expect(lawnVerts.length).toBe(12); // two quads × two triangles × three vertices
    expect(Math.min(...lawnVerts.map((v) => v.x))).toBeCloseTo(probes.lawnSMinX, 3);
    expect(Math.max(...lawnVerts.map((v) => v.x))).toBeCloseTo(probes.lawnSMaxX, 3);
    expect(Math.min(...lawnVerts.map((v) => v.z))).toBeCloseTo(probes.lawnWMinZ, 3);
    expect(Math.max(...lawnVerts.map((v) => v.z))).toBeCloseTo(probes.lawnSMaxZ, 3);
  });
});

describe('Osgoode Hall — the 1867 wrought-iron fence', () => {
  it('every member clears the thin-geometry floor (a to-scale picket would strobe)', () => {
    expect(probes.fenceMinMemberWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });

  it('runs the lawn\'s south and west edges with posts derived from each run\'s own length', () => {
    expect(probes.fencePostCount).toBeGreaterThan(6);
    expect(probes.fencePostTopY).toBeGreaterThan(0.5);
    // MEASURED: the posts really stand on the two lawn edges, and nowhere else.
    const postTops = verts.filter((v) => Math.abs(v.y - probes.fencePostTopY) < 1e-4);
    expect(postTops.length).toBeGreaterThan(0);
    for (const v of postTops) {
      const onSouth = Math.abs(v.z - probes.lawnSMaxZ) <= probes.fenceMinMemberWu;
      const onWest = Math.abs(v.x - probes.lawnSMinX) <= probes.fenceMinMemberWu;
      expect(onSouth || onWest, `${v.x},${v.z}`).toBe(true);
    }
  });

  it('leaves a GATE on the building\'s own axis (the walk from Queen lines up with the portico)', () => {
    expect((probes.fenceGateMinX + probes.fenceGateMaxX) / 2).toBeCloseTo(dataBox.cx, 9);
    expect(probes.fenceGateMaxX - probes.fenceGateMinX).toBeGreaterThan(3);
    // MEASURED: the opening is really empty. The two GATE POSTS stand ON the opening's edges (a
    // gate needs jambs), so the clear span is measured inside their own half-widths.
    const jamb = probes.fenceMinMemberWu / 2 + EPS;
    const inGate = verts.filter(
      (v) =>
        v.y > 0.2 &&
        Math.abs(v.z - probes.lawnSMaxZ) < 1 &&
        v.x > probes.fenceGateMinX + jamb &&
        v.x < probes.fenceGateMaxX - jamb,
    );
    expect(inGate).toEqual([]);
  });

  it('is VISUAL-ONLY — no collider, because P37 proved the car curb-hops sub-ride-height obstacles', () => {
    expect(bespoke.extraColliders).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// claims
// -------------------------------------------------------------------------------------------------

describe('Osgoode Hall — the lawn claims keep the placers off the grounds', () => {
  it('claims exactly the two lawn rects as blocking decor', () => {
    expect(bespoke.extraClaims.map((c) => c.id)).toEqual(['osgoode-lawn-s', 'osgoode-lawn-w']);
    for (const claim of bespoke.extraClaims) {
      expect(claim.kind, claim.id).toBe('decor'); // a colliderless SURFACE, not a building volume
      expect(claim.yRange[0], claim.id).toBe(0);
      expect(claim.yRange[1], claim.id).toBeCloseTo(GROUND_STACK.parkGround + MIN_GROUND_SEP_WU, 12);
    }
    const south = bespoke.extraClaims[0].aabb;
    expect([south.minX, south.maxX, south.minZ, south.maxZ]).toEqual([
      probes.lawnSMinX,
      probes.lawnSMaxX,
      probes.lawnSMinZ,
      probes.lawnSMaxZ,
    ]);
    const west = bespoke.extraClaims[1].aabb;
    expect([west.minX, west.maxX, west.minZ, west.maxZ]).toEqual([
      probes.lawnWMinX,
      probes.lawnWMaxX,
      probes.lawnWMinZ,
      probes.lawnWMaxZ,
    ]);
  });

  it('neither rect overlaps the DATA box (the collider stays the truth) nor the other', () => {
    const dataAabb = {
      minX: dataBox.cx - dataBox.hx,
      maxX: dataBox.cx + dataBox.hx,
      minZ: dataBox.cz - dataBox.hz,
      maxZ: dataBox.cz + dataBox.hz,
    };
    for (const claim of bespoke.extraClaims) expect(overlaps(claim.aabb, dataAabb), claim.id).toBe(false);
    expect(overlaps(bespoke.extraClaims[0].aabb, bespoke.extraClaims[1].aabb)).toBe(false);
  });

  it('carries no atlas wordmark (a Georgian courthouse has no signage)', () => {
    expect(bespoke.signQuads).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// determinism
// -------------------------------------------------------------------------------------------------

describe('Osgoode Hall — determinism', () => {
  it('rebuilds byte-identically', () => {
    const again = resolveNamedBespoke(named.placements).get('osgoode-hall')!.buildGeometry();
    for (const name of ['position', 'normal', 'color']) {
      expect(Array.from(again.geometry.getAttribute(name).array as Float32Array)).toEqual(
        Array.from(built.geometry.getAttribute(name).array as Float32Array),
      );
    }
    expect(again.parts).toEqual(built.parts);
  });

  it('derives every dimension from the placement and the street table alone', () => {
    const viaFresh = resolveNamedBespoke(buildNamedBuildings().placements, streets).get('osgoode-hall')!;
    expect(viaFresh.meta.probes).toEqual(probes);
    expect(viaFresh.extraClaims).toEqual(bespoke.extraClaims);
  });
});
