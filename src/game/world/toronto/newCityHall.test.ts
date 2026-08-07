/**
 * Phase 47 T1 (Part 11) — Toronto City Hall (crescent twins + saucer + podium) and Nathan
 * Phillips Square.
 *
 * Two kinds of assertion, and the second kind is the point (unionStation.test.ts's idiom):
 *   • BUDGETS — a ceiling AND a floor per part. A ceiling alone is passed just as happily by the
 *     three flat boxes this replaces, so the floor is what makes a silent revert fail.
 *   • VERTEX PROBES — the geometry is MEASURED, not described. The towers really curve (their
 *     convex faces really touch the data slab at mid-span and fall back to its far face at the
 *     ends); the warm window bands really exist and are really unshaded; the saucer really stands
 *     in the gap the two crescents leave; the plaza and the rink really ride their own ladder
 *     rungs; every piece of square furniture really stands inside the rect the square CLAIMS.
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { CAMERA_EYE_MIN_WU } from '../../config/camera';
import { GROUND_STACK } from '../../config/layering';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { NAMED_HEIGHT_SCALE } from '../../config/torontoMap';
import { linearRgb } from './bespokeMesh';
import { overlaps, type Aabb } from './claimIndex';
import { hGame } from './heightCurve';
import { buildNamedBuildings } from './namedBuildings';
import { namedGeometryCtx, resolveNamedBespoke, type NamedExtraClaim } from './namedGeometry';
import { CITY_HALL_CAMPUS_MAX_TRIS, NATHAN_PHILLIPS_SQUARE_MAX_TRIS } from './newCityHall';
import { buildStreets } from './streets';

const named = buildNamedBuildings();
const placement = named.placements.find((p) => p.id === 'new-city-hall')!;
const [eastBox, westBox, podiumBox] = placement.boxes;
const bespoke = resolveNamedBespoke(named.placements).get('new-city-hall')!;
const built = bespoke.buildGeometry();
const probes = bespoke.meta.probes;

const streets = buildStreets().streets;
const bay = streets.find((s) => s.id === 'bay')!;
const queen = streets.find((s) => s.id === 'queen')!;
const university = streets.find((s) => s.id === 'university')!;

interface Vertex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Vertex index — the parts are appended in order, so this is how a vertex is attributed. */
  readonly i: number;
}

function positions(geometry: BufferGeometry): Float32Array {
  return geometry.getAttribute('position').array as Float32Array;
}

function vertices(geometry: BufferGeometry): Vertex[] {
  const p = positions(geometry);
  const out: Vertex[] = [];
  for (let i = 0; i < p.length; i += 3) out.push({ x: p[i], y: p[i + 1], z: p[i + 2], i: i / 3 });
  return out;
}

const verts = vertices(built.geometry);
/** Vertex index where the SQUARE part starts (the campus is appended first, 3 vertices per tri). */
const squareStart = built.parts[0].triangles * 3;
const campusVerts = verts.filter((v) => v.i < squareStart);
const squareVerts = verts.filter((v) => v.i >= squareStart);

/** Float32 attribute storage at world coordinates ~1300/~2000: 1e-3 is the honest XZ precision. */
const XZ_EPS = 1e-3;

function rect(minX: number, maxX: number, minZ: number, maxZ: number): Aabb {
  return { minX, maxX, minZ, maxZ };
}

function claimOf(id: string): NamedExtraClaim {
  const claim = bespoke.extraClaims.find((c) => c.id === id);
  expect(claim, `no extra claim "${id}"`).toBeDefined();
  return claim!;
}

/** Exact per-vertex colour test against the accumulator's linear rgb (see bespokeMesh.linearRgb) —
 * how an UNSHADED face (a lit window band, the ice, a sign letter) is told from a shaded one. */
const colorAttr = built.geometry.getAttribute('color').array as Float32Array;
function matchesColor(vertexIndex: number, r: number, g: number, b: number): boolean {
  const o = vertexIndex * 3;
  return (
    Math.abs(colorAttr[o] - r) < 1e-6 && Math.abs(colorAttr[o + 1] - g) < 1e-6 && Math.abs(colorAttr[o + 2] - b) < 1e-6
  );
}

function boxRect(b: { cx: number; cz: number; hx: number; hz: number }): Aabb {
  return rect(b.cx - b.hx, b.cx + b.hx, b.cz - b.hz, b.cz + b.hz);
}

// -------------------------------------------------------------------------------------------------
// budgets
// -------------------------------------------------------------------------------------------------

describe('City Hall — tri budgets (Part 11 rule 2)', () => {
  it('the mesh splits into exactly the campus and the square', () => {
    expect(built.parts.map((p) => p.id)).toEqual(['campus', 'square']);
    expect(built.parts.reduce((n, p) => n + p.triangles, 0)).toBe(built.triangles);
    expect(built.triangles).toBe(positions(built.geometry).length / 9);
  });

  it('the campus (two crescents + saucer + podium detail) stays inside its 1,800-tri budget', () => {
    const campus = built.parts[0].triangles;
    expect(CITY_HALL_CAMPUS_MAX_TRIS).toBe(1800);
    expect(campus).toBeLessThanOrEqual(CITY_HALL_CAMPUS_MAX_TRIS);
    // THE FLOOR: the v1 read was three extruded boxes (36 triangles). A regression that quietly
    // reverted the curves, the window bands or the saucer would still pass every proportion pin
    // below, so the floor is a test too. Measured at 1,024.
    expect(campus).toBeGreaterThan(700);
  });

  it('Nathan Phillips Square (plaza, rink, arches, sign, flagpoles) stays inside its 600-tri budget', () => {
    const square = built.parts[1].triangles;
    expect(NATHAN_PHILLIPS_SQUARE_MAX_TRIS).toBe(600);
    expect(square).toBeLessThanOrEqual(NATHAN_PHILLIPS_SQUARE_MAX_TRIS);
    expect(square).toBeGreaterThan(200); // measured at 492
  });
});

// -------------------------------------------------------------------------------------------------
// heights: the DATA row, not a new invention
// -------------------------------------------------------------------------------------------------

describe('City Hall — heights are the data boxes', () => {
  it('each tower tops out at EXACTLY its own data-box top, east taller than west', () => {
    expect(probes.towerTopEast).toBeCloseTo(eastBox.hy * 2, 12);
    expect(probes.towerTopWest).toBeCloseTo(westBox.hy * 2, 12);
    expect(probes.towerTopWest).toBeLessThan(probes.towerTopEast);
    expect(bespoke.meta.topY).toBeCloseTo(eastBox.hy * 2, 12);
    // …and the mesh really reaches it: the tallest vertex IS the east tower's parapet.
    expect(Math.max(...verts.map((v) => v.y))).toBeCloseTo(eastBox.hy * 2, 4);
  });

  it('the whole complex stays under the eye line — no new Phase-36 crossers are owed', () => {
    expect(probes.towerTopEast).toBeLessThan(CAMERA_EYE_MIN_WU);
    expect(probes.saucerTopY).toBeLessThan(CAMERA_EYE_MIN_WU);
    expect(probes.archTopY).toBeLessThan(CAMERA_EYE_MIN_WU);
    expect(probes.eyeLineMinWu).toBe(CAMERA_EYE_MIN_WU);
  });

  it('the podium is the ONLY render box (the §4 facade path); both tower boxes are DROPPED', () => {
    const render = bespoke.renderBoxes;
    expect(render).toHaveLength(1);
    // Declared as data box 2, so the podium keeps the facade-texture / occlusion key it would have
    // had all along (`new-city-hall#2`) instead of being renumbered by its array position.
    expect(bespoke.renderBoxDataIndices).toEqual([2]);
    const [box] = render;
    expect([box.cx, box.cz, box.hx, box.hz]).toEqual([podiumBox.cx, podiumBox.cz, podiumBox.hx, podiumBox.hz]);
    expect(box.hy).toBeCloseTo(podiumBox.hy, 12); // full data height — nothing shrinks here
    // WHY dropped rather than kept as buried 0.1 wu pads (which is how the towers first shipped):
    // an invisible pad still costs a whole draw call on the per-box facade-texture path, and two of
    // them pushed the low tier to 93/90. The tower MASS is bespoke geometry now; their data boxes
    // still carry the claims, colliders and massing exclusions.
    for (const tower of [eastBox, westBox]) {
      expect(render.some((b) => b.cx === tower.cx && b.cz === tower.cz)).toBe(false);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// the crescents
// -------------------------------------------------------------------------------------------------

describe('City Hall — the towers really curve', () => {
  /** Tower geometry only: above the podium parapet, nothing else in the campus reaches. */
  const towerVerts = campusVerts.filter((v) => v.y > probes.podiumTopY + 1);

  function maxXNear(zCentre: number, halfBand: number): number {
    return Math.max(...towerVerts.filter((v) => Math.abs(v.z - zCentre) <= halfBand).map((v) => v.x));
  }
  function minXNear(zCentre: number, halfBand: number): number {
    return Math.min(...towerVerts.filter((v) => Math.abs(v.z - zCentre) <= halfBand).map((v) => v.x));
  }

  it('the EAST crescent is inscribed: its convex face touches the slab at mid-span, the slab\'s far face at the ends', () => {
    const east = boxRect(eastBox);
    expect(maxXNear(eastBox.cz, 0.5)).toBeCloseTo(east.maxX, 2);
    // At the arc ends the convex face has fallen back by (nearly) the whole slab depth — that is
    // what "inscribed in the data slab" means, and a straight slab would fail it flat.
    const atEnd = maxXNear(eastBox.cz + eastBox.hz - 1, 1);
    expect(atEnd).toBeLessThan(east.maxX - 1.5 * eastBox.hx);
    expect(atEnd).toBeGreaterThan(east.minX - XZ_EPS);
  });

  it('the WEST crescent mirrors it (its convex face bulges the other way)', () => {
    const west = boxRect(westBox);
    expect(minXNear(westBox.cz, 0.5)).toBeCloseTo(west.minX, 2);
    expect(minXNear(westBox.cz + westBox.hz - 1, 1)).toBeGreaterThan(west.minX + 1.5 * westBox.hx);
  });

  it('the concave faces point INTO the gap, and the gap opens N–S onto the square', () => {
    // Each crescent's inner surface at mid-span (a probe) sits between the two slabs — i.e. the
    // hollow sides face each other, which is the whole composition.
    expect(probes.gapWestX).toBeGreaterThan(westBox.cx - westBox.hx);
    expect(probes.gapEastX).toBeLessThan(eastBox.cx + eastBox.hx);
    expect(probes.gapWestX).toBeLessThan(probes.gapEastX);
    // The arc centres lie on the far side of each tower from the gap (concave-toward-the-gap).
    expect(probes.towerArcCentreXEast).toBeLessThan(eastBox.cx);
    expect(probes.towerArcCentreXWest).toBeGreaterThan(westBox.cx);
    // Nothing closes the gap north or south: both crescents span the full slab depth in Z, so the
    // opening runs N–S (the saucer reads from the square, which lies south).
    const towerZ = campusVerts.filter((v) => v.y > probes.podiumTopY + 1);
    expect(Math.min(...towerZ.map((v) => v.z))).toBeCloseTo(eastBox.cz - eastBox.hz, 2);
    expect(Math.max(...towerZ.map((v) => v.z))).toBeCloseTo(eastBox.cz + eastBox.hz, 2);
  });

  it('carries real warm window bands on the concave faces, unshaded, on both towers', () => {
    // The lit bands are the ONLY unshaded warm-tinted faces in the campus part, so an exact colour
    // match counts them: bands × facets × 6 vertices per quad, twice (one crescent each).
    const [r, g, b] = linearRgb('#ffc879');
    const litVerts = campusVerts.filter((v) => matchesColor(v.i, r, g, b));
    expect(litVerts.length).toBe(2 * probes.litBandCount * probes.towerSegments * 6);
    // …and every one of them stands above the podium roof (no window band buried in the base).
    expect(Math.min(...litVerts.map((v) => v.y))).toBeGreaterThanOrEqual(probes.podiumTopY - 1e-4);
  });

  it('the rib fins on the convex backs clear the thin-geometry floor', () => {
    expect(probes.finWidthWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    expect(probes.finCount).toBeGreaterThan(0);
  });

  it('every campus vertex stays inside the campus rect (+1 wu for proud lips) the exclusion reserves', () => {
    // namedBuildings.ts inflates every data box by 3 wu into a massing exclusion, and the podium's
    // covers the whole union rect — so 1 wu of proud parapet/canopy is inside the reservation with
    // 2 wu to spare, and nothing here can ever overhang into another placer's ground.
    const allowed = rect(probes.campusMinX - 1, probes.campusMaxX + 1, probes.campusMinZ - 1, probes.campusMaxZ + 1);
    for (const v of campusVerts) {
      expect(v.x, `campus vertex ${v.i}`).toBeGreaterThanOrEqual(allowed.minX);
      expect(v.x, `campus vertex ${v.i}`).toBeLessThanOrEqual(allowed.maxX);
      expect(v.z, `campus vertex ${v.i}`).toBeGreaterThanOrEqual(allowed.minZ);
      expect(v.z, `campus vertex ${v.i}`).toBeLessThanOrEqual(allowed.maxZ);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// the council chamber
// -------------------------------------------------------------------------------------------------

describe('City Hall — the saucer', () => {
  it('is the researched 47.2 m chamber through the spec row\'s OWN footprint rule', () => {
    expect(probes.saucerRadius).toBeCloseTo((47.2 / 1.55) * 0.5 * 0.5, 9);
  });

  it('rises the researched 12.2 m above the podium roof, through the §3c named-height rule', () => {
    expect(probes.saucerBaseY).toBeCloseTo(probes.podiumTopY, 12);
    expect(probes.saucerTopY - probes.saucerBaseY).toBeCloseTo(hGame(12.2) * NAMED_HEIGHT_SCALE, 9);
    // It is the composition's focal point, not its summit: both towers still overtop it.
    expect(probes.saucerTopY).toBeLessThan(probes.towerTopWest);
  });

  it('stands centred in the gap with clearance from both concave walls', () => {
    expect(probes.saucerCx).toBeCloseTo((eastBox.cx + westBox.cx) / 2, 12);
    expect(probes.saucerCz).toBeCloseTo(eastBox.cz, 12);
    expect(probes.saucerCx - probes.saucerRadius).toBeGreaterThan(probes.gapWestX + 1);
    expect(probes.saucerCx + probes.saucerRadius).toBeLessThan(probes.gapEastX - 1);
  });

  it('really reaches its peak: the tallest vertex over the chamber disc IS the dome', () => {
    const overDisc = campusVerts.filter(
      (v) => Math.hypot(v.x - probes.saucerCx, v.z - probes.saucerCz) < probes.saucerRadius - 1,
    );
    expect(Math.max(...overDisc.map((v) => v.y))).toBeCloseTo(probes.saucerTopY, 3);
  });
});

// -------------------------------------------------------------------------------------------------
// Nathan Phillips Square: the rect, and what it protects
// -------------------------------------------------------------------------------------------------

describe('Nathan Phillips Square — a street-referenced rect', () => {
  it('sits SOUTH of the podium, clear of its data box (the collider stays the truth)', () => {
    expect(probes.squareMinZ).toBeGreaterThan(podiumBox.cz + podiumBox.hz);
    expect(overlaps(claimOf('nps-square').aabb, boxRect(podiumBox))).toBe(false);
  });

  it('clears Queen\'s ribbon by more than the 3 wu sidewalk band', () => {
    expect(probes.squareMaxZ).toBeLessThan(queen.ribbon.minY - 3);
  });

  it('clears Bay\'s ribbon by more than the 3 wu sidewalk band', () => {
    expect(probes.squareMaxX).toBeLessThan(bay.ribbon.minX - 3);
  });

  it('stops east of Osgoode Hall\'s massing exclusion (its lawn is the next builder\'s room)', () => {
    const osgoode = named.placements.find((p) => p.id === 'osgoode-hall')!;
    const exclusionMaxX = Math.max(...osgoode.boxes.map((b) => b.cx + b.hx)) + 3; // EXCLUSION_MARGIN_WU
    expect(probes.squareMinX).toBeGreaterThan(exclusionMaxX + 1);
  });

  it('is anchored on the campus centreline derived from University and Bay', () => {
    // PHASE 75: the west offset re-pinned 24 → 19 (SQUARE.westOfCampusWu). University Avenue is an
    // `artery`, so its widening pushed Osgoode Hall's set-back lot east into the strip the old
    // offset assumed; the square yields that room and the seam above still holds. The anchor RULE
    // — the midpoint of the two centrelines — is what this test exists to pin, and it is unchanged.
    expect(probes.campusX).toBeCloseTo((university.centerline + bay.centerline) / 2, 12);
    expect(probes.squareMinX).toBeCloseTo(probes.campusX - 19, 12);
  });

  it('claims the whole rect as blocking DECOR — the one thing that keeps placers off the square', () => {
    const claim = claimOf('nps-square');
    expect(claim.kind).toBe('decor');
    expect(claim.aabb).toEqual(rect(probes.squareMinX, probes.squareMaxX, probes.squareMinZ, probes.squareMaxZ));
    expect(claim.yRange[0]).toBe(0);
    expect(bespoke.extraColliders.some((c) => c.id === 'nps-square')).toBe(false);
  });

  it('the rink lies wholly INSIDE the plaza, in its northern portion', () => {
    expect(probes.rinkMinX).toBeGreaterThan(probes.squareMinX);
    expect(probes.rinkMaxX).toBeLessThan(probes.squareMaxX);
    expect(probes.rinkMinZ).toBeGreaterThan(probes.squareMinZ);
    expect(probes.rinkMaxZ).toBeLessThan(probes.squareMaxZ);
    // …leaving the southern strip for the sign and the flagpole row.
    expect(probes.rinkMaxZ).toBeLessThan(probes.signMinZ);
  });
});

// -------------------------------------------------------------------------------------------------
// the ground stack
// -------------------------------------------------------------------------------------------------

describe('Nathan Phillips Square — plaza and rink ride their own ladder rungs', () => {
  it('the plaza quad is AT GROUND_STACK.civicPlaza and covers exactly the claimed rect', () => {
    expect(probes.plazaY).toBe(GROUND_STACK.civicPlaza);
    const onRung = squareVerts.filter((v) => Math.abs(v.y - GROUND_STACK.civicPlaza) < 1e-6);
    expect(onRung.length).toBeGreaterThanOrEqual(6);
    // The plaza is the OUTERMOST thing on its rung (the sign's letters and the flagpoles stand on
    // it, strictly inside), so the extremes of that rung ARE the square rect.
    expect(Math.min(...onRung.map((v) => v.x))).toBeCloseTo(probes.squareMinX, 2);
    expect(Math.max(...onRung.map((v) => v.x))).toBeCloseTo(probes.squareMaxX, 2);
    expect(Math.min(...onRung.map((v) => v.z))).toBeCloseTo(probes.squareMinZ, 2);
    expect(Math.max(...onRung.map((v) => v.z))).toBeCloseTo(probes.squareMaxZ, 2);
  });

  it('the rink quad is AT GROUND_STACK.civicRink — its own rung, one step above the paving', () => {
    expect(probes.rinkY).toBe(GROUND_STACK.civicRink);
    expect(GROUND_STACK.civicRink).toBeGreaterThan(GROUND_STACK.civicPlaza);
    const onRung = squareVerts.filter((v) => Math.abs(v.y - GROUND_STACK.civicRink) < 1e-6);
    expect(onRung).toHaveLength(6); // one quad = two triangles, and nothing else shares the rung
    expect(Math.min(...onRung.map((v) => v.x))).toBeCloseTo(probes.rinkMinX, 2);
    expect(Math.max(...onRung.map((v) => v.x))).toBeCloseTo(probes.rinkMaxX, 2);
    expect(Math.min(...onRung.map((v) => v.z))).toBeCloseTo(probes.rinkMinZ, 2);
    expect(Math.max(...onRung.map((v) => v.z))).toBeCloseTo(probes.rinkMaxZ, 2);
  });

  it('the ice is UNSHADED — the blue-hour rink glow is the whole point of it', () => {
    const [r, g, b] = linearRgb('#cfe4f2');
    const ice = squareVerts.filter((v) => matchesColor(v.i, r, g, b));
    expect(ice).toHaveLength(6);
  });
});

// -------------------------------------------------------------------------------------------------
// the arches, the sign, the flagpoles
// -------------------------------------------------------------------------------------------------

describe('Nathan Phillips Square — the Freedom Arches', () => {
  it('are three, spanning the rink N–S, in an E–W row (the Old City Hall axis)', () => {
    expect(probes.archCount).toBe(3);
    expect(probes.archMinZ).toBeLessThan(probes.rinkMinZ);
    expect(probes.archMaxZ).toBeGreaterThan(probes.rinkMaxZ);
    expect(probes.archTopY).toBeGreaterThan(probes.plazaY + 3);
  });

  it('are VISUAL-ONLY: the sign row is the square\'s only collider (the P37 curb-hop law)', () => {
    expect(bespoke.extraColliders.map((c) => c.id)).toEqual(['toronto-sign']);
  });

  it('their beam section clears the thin-geometry floor', () => {
    expect(probes.archSectionWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });
});

describe('Nathan Phillips Square — the TORONTO sign', () => {
  it('keeps the researched 22 m × 3 m aspect at prop scale', () => {
    const run = probes.signMaxX - probes.signMinX;
    expect(run / probes.signLetterHeightWu).toBeCloseTo(22 / 3, 9);
    expect(probes.signLetterCount).toBe(7);
    expect(probes.signLetterHeightWu).toBe(2.6);
  });

  it('stands on the plaza, in the square\'s southern strip, facing the S/SE camera', () => {
    expect(probes.signBaseY).toBe(GROUND_STACK.civicPlaza);
    expect(probes.signMinZ).toBeGreaterThan((probes.squareMinZ + probes.squareMaxZ) / 2);
    expect(probes.signMaxZ).toBeLessThan(probes.squareMaxZ);
  });

  it('is ONE ring-height cuboid collider whose footprint IS its claim (the letters STOP the car)', () => {
    const colliders = bespoke.extraColliders.filter((c) => c.id === 'toronto-sign');
    expect(colliders).toHaveLength(1);
    const c = colliders[0];
    expect(2 * c.hy).toBe(3); // P37: ring height, never the 2.6 wu visual height
    expect(2 * c.hy).toBe(probes.signColliderHeightWu);
    expect(c.cy).toBeCloseTo(c.hy, 12);
    const claim = claimOf('toronto-sign');
    expect(claim.kind).toBe('namedBuilding');
    expect(claim.aabb).toEqual(rect(c.cx - c.hx, c.cx + c.hx, c.cz - c.hz, c.cz + c.hz));
    expect(claim.yRange[1]).toBe(3);
    // The claim wraps the letter run with a margin, and the run really sits inside it.
    expect(claim.aabb.minX).toBeLessThan(probes.signMinX);
    expect(claim.aabb.maxX).toBeGreaterThan(probes.signMaxX);
  });

  it('renders seven distinctly-coloured, unshaded block letters (the LED homage)', () => {
    const hues = ['#e0453c', '#f08b2a', '#f4d03f', '#4caf50', '#3a8fd8', '#7b5bd6', '#e0559b'];
    const inSign = squareVerts.filter(
      (v) => v.x > probes.signMinX - 0.1 && v.x < probes.signMaxX + 0.1 && v.z > probes.signMinZ - 0.1 && v.z < probes.signMaxZ + 0.1,
    );
    for (const hue of hues) {
      const [r, g, b] = linearRgb(hue);
      expect(inSign.some((v) => matchesColor(v.i, r, g, b)), hue).toBe(true);
    }
    // Every letter stands on the plaza and none of them overtops the collider that guards them.
    expect(Math.min(...inSign.map((v) => v.y))).toBeCloseTo(GROUND_STACK.civicPlaza, 5);
    expect(Math.max(...inSign.map((v) => v.y))).toBeCloseTo(GROUND_STACK.civicPlaza + probes.signLetterHeightWu, 4);
    expect(Math.max(...inSign.map((v) => v.y))).toBeLessThan(probes.signColliderHeightWu);
  });
});

describe('Nathan Phillips Square — the flagpole row', () => {
  it('is three poles over the thin-geometry floor, standing on the plaza', () => {
    expect(probes.flagpoleCount).toBe(3);
    expect(probes.flagpoleThicknessWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    expect(probes.flagpoleTopY).toBeGreaterThan(GROUND_STACK.civicPlaza + 4);
    expect(probes.flagpoleTopY).toBeLessThan(probes.podiumTopY + 4); // a pole, not a mast
  });
});

describe('Nathan Phillips Square — nothing overhangs the claim', () => {
  it('every square vertex (paving, ice, arches, letters, poles) lies inside the claimed rect', () => {
    const claim = claimOf('nps-square').aabb;
    const EPS = 0.1;
    for (const v of squareVerts) {
      expect(v.x, `square vertex ${v.i}`).toBeGreaterThanOrEqual(claim.minX - EPS);
      expect(v.x, `square vertex ${v.i}`).toBeLessThanOrEqual(claim.maxX + EPS);
      expect(v.z, `square vertex ${v.i}`).toBeGreaterThanOrEqual(claim.minZ - EPS);
      expect(v.z, `square vertex ${v.i}`).toBeLessThanOrEqual(claim.maxZ + EPS);
    }
    expect(squareVerts.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------------
// determinism
// -------------------------------------------------------------------------------------------------

describe('City Hall — determinism', () => {
  it('rebuilds byte-identically', () => {
    const again = resolveNamedBespoke(named.placements).get('new-city-hall')!.buildGeometry();
    for (const name of ['position', 'normal', 'color']) {
      expect(Array.from(again.geometry.getAttribute(name).array as Float32Array)).toEqual(
        Array.from(built.geometry.getAttribute(name).array as Float32Array),
      );
    }
    expect(again.parts).toEqual(built.parts);
    expect(again.triangles).toBe(built.triangles);
  });

  it('derives every dimension from the placement + the street table (no literal coordinates)', () => {
    // The tripwire for the P27 literal-drift class: rebuilt against an explicitly-passed street
    // table, every derived edge must land in the same place.
    const viaCtx = resolveNamedBespoke(named.placements, namedGeometryCtx(streets).streets).get('new-city-hall')!;
    expect(viaCtx.meta.probes).toEqual(probes);
    expect(viaCtx.extraClaims).toEqual(bespoke.extraClaims);
    expect(viaCtx.extraColliders).toEqual(bespoke.extraColliders);
  });
});
