/**
 * Phase 46 (Part 11) — Union Station v2 + the GO shed + the Front Street moat.
 *
 * Two kinds of assertion live here, and the second kind is the point:
 *   • BUDGETS — a ceiling AND a floor per model. A ceiling alone is passed just as happily by the
 *     old 12-triangle box, so the floor is what makes a silent revert fail (heroes.test.ts's idiom).
 *   • VERTEX PROBES — the geometry is measured, not described. The attic really tops out at the
 *     DATA height (which is what makes the shortened render box legal — heightLaw, the claims and
 *     the camera clip volumes all read the data box); 22 shafts really stand on the north face; the
 *     moat really lies inside the flush gap and above the raised sidewalk; the shed really sits in
 *     the reserved rail-lands strip and clear of the headhouse.
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { GROUND_STACK } from '../../config/layering';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { SIDEWALK } from '../../config/torontoMap';
import { CAMERA_EYE_MIN_WU } from '../../config/camera';
import { overlaps, type Aabb } from './claimIndex';
import { buildNamedBuildings } from './namedBuildings';
import { namedGeometryCtx, resolveNamedBespoke } from './namedGeometry';
import { railLandsStrip } from './railLands';
import { buildStreets } from './streets';
import { GO_SHED_MAX_TRIS, UNION_STATION_MAX_TRIS } from './unionStation';

const named = buildNamedBuildings();
const placement = named.placements.find((p) => p.id === 'union-station')!;
const dataBox = placement.boxes[0];
const bespoke = resolveNamedBespoke(named.placements).get('union-station')!;
const built = bespoke.buildGeometry();
const probes = bespoke.meta.probes;

const streets = buildStreets().streets;
const front = streets.find((s) => s.id === 'front')!;
const strip = railLandsStrip(streets);

function positions(geometry: BufferGeometry): Float32Array {
  return geometry.getAttribute('position').array as Float32Array;
}

/** Every distinct vertex (x, y, z) triple of the merged mesh. */
function vertices(geometry: BufferGeometry): { x: number; y: number; z: number }[] {
  const p = positions(geometry);
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < p.length; i += 3) out.push({ x: p[i], y: p[i + 1], z: p[i + 2] });
  return out;
}

const verts = vertices(built.geometry);

function rectOf(claimId: string): Aabb {
  const claim = bespoke.extraClaims.find((c) => c.id === claimId);
  expect(claim, `no extra claim "${claimId}"`).toBeDefined();
  return claim!.aabb;
}

// -------------------------------------------------------------------------------------------------
// budgets
// -------------------------------------------------------------------------------------------------

describe('Union Station v2 — tri budgets (Part 11 rule 2)', () => {
  it('the whole bespoke mesh splits into exactly the headhouse and the GO shed', () => {
    expect(built.parts.map((p) => p.id)).toEqual(['union-station', 'go-shed']);
    expect(built.parts.reduce((n, p) => n + p.triangles, 0)).toBe(built.triangles);
    expect(built.triangles).toBe(positions(built.geometry).length / 9);
  });

  it('the headhouse (colonnade + attic + moat + balustrade) stays inside its 900-tri budget', () => {
    const headhouse = built.parts[0].triangles;
    expect(UNION_STATION_MAX_TRIS).toBe(900);
    expect(headhouse).toBeLessThanOrEqual(UNION_STATION_MAX_TRIS);
    // THE FLOOR: v1 was a single 12-triangle box. A regression that quietly reverted the colonnade,
    // the attic or the balustrade would still pass every proportion pin below, so the floor is a
    // test too. Headroom above the measured 608 is deliberate (a later phase buys detail with it).
    expect(headhouse).toBeGreaterThan(500);
  });

  it('the GO shed stays inside its 300-tri massing budget', () => {
    const shed = built.parts[1].triangles;
    expect(GO_SHED_MAX_TRIS).toBe(300);
    expect(shed).toBeLessThanOrEqual(GO_SHED_MAX_TRIS);
    expect(shed).toBeGreaterThan(100);
  });
});

// -------------------------------------------------------------------------------------------------
// the massing: data-height truth + the shortened render box
// -------------------------------------------------------------------------------------------------

describe('Union Station v2 — heights are the DATA row, not a new invention', () => {
  it('the attic tops out at EXACTLY the data height (hGame(27) × NAMED_HEIGHT_SCALE)', () => {
    const dataHeight = dataBox.hy * 2;
    expect(probes.dataHeight).toBeCloseTo(dataHeight, 12);
    expect(probes.atticTopY).toBeCloseTo(dataHeight, 12);
    expect(bespoke.meta.topY).toBeCloseTo(dataHeight, 12);
    // …and the mesh really reaches it: the tallest vertex IS the attic top, to float precision.
    const maxY = Math.max(...verts.map((v) => v.y));
    expect(maxY).toBeCloseTo(dataHeight, 4);
  });

  it('the render box is the WING height — shorter than the data box, same footprint', () => {
    const render = bespoke.renderBoxes[0];
    expect(render.hy * 2).toBeCloseTo(probes.wingTopY, 12);
    expect(probes.wingTopY).toBeLessThan(probes.dataHeight);
    expect(probes.wingTopY / probes.dataHeight).toBeCloseTo(0.8, 6);
    expect([render.cx, render.cz, render.hx, render.hz]).toEqual([dataBox.cx, dataBox.cz, dataBox.hx, dataBox.hz]);
  });

  it('stays far below the eye line, so no Phase-36 dither registration is owed', () => {
    expect(probes.dataHeight).toBeLessThan(CAMERA_EYE_MIN_WU);
    expect(probes.shedTopY).toBeLessThan(CAMERA_EYE_MIN_WU);
  });
});

// -------------------------------------------------------------------------------------------------
// the colonnade
// -------------------------------------------------------------------------------------------------

describe('Union Station v2 — the researched colonnade', () => {
  it('carries the researcher-verified counts: 22 columns on Front, 14 south bays', () => {
    expect(probes.columnCountNorth).toBe(22);
    expect(probes.pilasterCountSouth).toBe(14);
    expect(probes.columnCountEast).toBeGreaterThan(0);
  });

  it('22 distinct shafts really stand proud of the NORTH face, and each is buried in the wall', () => {
    const zNorth = dataBox.cz - dataBox.hz;
    const r = probes.columnRadiusWu;
    // A shaft's front facet is the only geometry in the thin band just in FRONT of the facade at
    // colonnade height; every other element (plinth, entablature, moat, balustrade) is outside it
    // in z or in y. Cluster the X values found there: one cluster per shaft.
    const bandMinZ = probes.colonnadeCentreZ - r - 1e-3;
    const bandMaxZ = zNorth - 0.5;
    const xs = [
      ...new Set(
        verts
          .filter((v) => v.y <= probes.columnTopY + 1e-4 && v.z >= bandMinZ && v.z <= bandMaxZ)
          .map((v) => Math.round(v.x * 1000) / 1000),
      ),
    ].sort((a, b) => a - b);
    const clusters: number[][] = [];
    for (const x of xs) {
      const last = clusters[clusters.length - 1];
      if (last !== undefined && x - last[last.length - 1] <= 2 * r) last.push(x);
      else clusters.push([x]);
    }
    expect(clusters).toHaveLength(probes.columnCountNorth);
    // The run is centred on the facade and spans the researched CENTRAL colonnade block only.
    expect(clusters[0][0]).toBeGreaterThan(probes.colonnadeMinX - 1e-3);
    expect(clusters[clusters.length - 1].at(-1)!).toBeLessThan(probes.colonnadeMaxX + 1e-3);
    // No shaft floats: each one's back reaches INTO the wall (its centre + radius is past zNorth).
    expect(probes.colonnadeCentreZ + r).toBeGreaterThan(zNorth);
  });

  it('the column shafts clear the thin-geometry floor (a to-scale shaft would strobe)', () => {
    expect(2 * probes.columnRadiusWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });

  it('the east return really carries columns on the camera-visible +X face', () => {
    const xEast = dataBox.cx + dataBox.hx;
    const r = probes.columnRadiusWu;
    // Same probe, rotated: a hex shaft has exactly one vertex per ring at its outermost X, and no
    // other element (the entablature above it stops 0.15 wu further out) shares that plane.
    const zs = [
      ...new Set(
        verts
          .filter(
            (v) =>
              v.y <= probes.columnTopY + 1e-4 &&
              Math.abs(v.x - (probes.eastColumnX + r)) < 1e-3 &&
              v.z >= probes.eastColumnMinZ - 1 &&
              v.z <= probes.eastColumnMaxZ + 1,
          )
          .map((v) => Math.round(v.z * 1000) / 1000),
      ),
    ].sort((a, b) => a - b);
    const clusters: number[][] = [];
    for (const z of zs) {
      const last = clusters[clusters.length - 1];
      if (last !== undefined && z - last[last.length - 1] <= 2 * r) last.push(z);
      else clusters.push([z]);
    }
    expect(clusters).toHaveLength(probes.columnCountEast);
    expect(probes.eastColumnX).toBeGreaterThan(xEast);
    expect(probes.eastColumnX - r).toBeLessThan(xEast); // buried in the wall, no floating shaft
  });
});

// -------------------------------------------------------------------------------------------------
// the moat
// -------------------------------------------------------------------------------------------------

describe('Union Station v2 — the sunken carriageway (moat)', () => {
  it('lies wholly inside the flush gap between Front\'s ribbon edge and the facade', () => {
    const zNorth = dataBox.cz - dataBox.hz;
    expect(probes.moatMinZ).toBeGreaterThan(front.ribbon.maxY);
    expect(probes.moatMaxZ).toBeCloseTo(zNorth, 9);
    expect(probes.moatMaxZ - probes.moatMinZ).toBeGreaterThan(THIN_GEOMETRY.minStripeWidthWu);
  });

  it('runs the FULL length of the Front Street facade (the researched "full-length" driveway)', () => {
    const moat = rectOf('moat');
    expect(moat.minX).toBeCloseTo(dataBox.cx - dataBox.hx, 9);
    expect(moat.maxX).toBeCloseTo(dataBox.cx + dataBox.hx, 9);
  });

  it('its paint rides the unionMoat rung, which clears the RAISED sidewalk band', () => {
    expect(probes.moatPaintY).toBe(GROUND_STACK.unionMoat);
    expect(probes.moatPaintY).toBeGreaterThan(SIDEWALK.curbHeightWu);
    // The paint quad is really AT that Y — no other geometry shares the plane.
    const onRung = verts.filter((v) => Math.abs(v.y - GROUND_STACK.unionMoat) < 1e-6);
    expect(onRung).toHaveLength(6); // one quad = two triangles
    // Float32 attribute storage — 3 decimals is the honest precision at world coordinate ~2245.
    expect(Math.min(...onRung.map((v) => v.z))).toBeCloseTo(probes.moatMinZ, 3);
    expect(Math.max(...onRung.map((v) => v.z))).toBeCloseTo(probes.moatMaxZ, 3);
  });

  it('the balustrade stands ON the raised walk, every member over the thin-geometry floor', () => {
    expect(probes.balustradeMinMemberWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    expect(probes.balustradeTopY).toBeGreaterThan(SIDEWALK.curbHeightWu + 1);
    const base = verts.filter((v) => Math.abs(v.y - SIDEWALK.curbHeightWu) < 1e-6);
    expect(base.length).toBeGreaterThan(0);
  });

  it('the balustrade has real openings (stairs/bridges), not one unbroken 74 wu wall', () => {
    // The dado/rail runs share their end X values, so walking the band's distinct X values gives
    // [run0.min, run0.max, run1.min, run1.max, run2.min, run2.max]: the ODD→EVEN steps are the
    // openings, the even→odd steps are the runs themselves.
    const railY = SIDEWALK.curbHeightWu + 0.5;
    const xs = [
      ...new Set(
        verts
          .filter((v) => Math.abs(v.y - railY) < 0.25 && v.z < probes.moatRailZ + 0.5 && v.z > probes.moatRailZ - 0.5)
          .map((v) => Math.round(v.x * 1000) / 1000),
      ),
    ].sort((a, b) => a - b);
    expect(xs).toHaveLength(2 * (probes.balustradeGapCount + 1));
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    const openings = steps.filter((_, i) => i % 2 === 1);
    const runs = steps.filter((_, i) => i % 2 === 0);
    expect(openings).toHaveLength(probes.balustradeGapCount);
    for (const opening of openings) expect(opening).toBeCloseTo(probes.balustradeGapWidthWu, 2);
    for (const run of runs) expect(run).toBeGreaterThan(probes.balustradeGapWidthWu);
  });

  it('is VISUAL-ONLY — it registers a decor claim and never a collider (the P37 curb-hop law)', () => {
    const moatClaim = bespoke.extraClaims.find((c) => c.id === 'moat')!;
    expect(moatClaim.kind).toBe('decor');
    expect(bespoke.extraColliders.some((c) => c.id === 'moat')).toBe(false);
  });

  it('never reaches Front\'s ROAD ribbon (a non-on-road blocking claim there breaks the zone law)', () => {
    const moat = rectOf('moat');
    const ribbon: Aabb = {
      minX: front.ribbon.minX,
      maxX: front.ribbon.maxX,
      minZ: front.ribbon.minY,
      maxZ: front.ribbon.maxY,
    };
    expect(overlaps(moat, ribbon)).toBe(false);
    // …and no vertex of the whole mesh crosses the kerb either. The bound is rounded to the
    // precision the vertex actually has: `verts` is read back out of a Float32Array, and the moat's
    // north row of vertices sits exactly ON `moat.minZ`, so the stored value is fround(minZ) —
    // which at this coordinate's magnitude is up to 1.2e-4 wu away from the float64 original, i.e.
    // ~240× the 1e-6 slack below. PHASE 75 exposed that (Front's kerb moved 4.4 wu with the road
    // widening and the new value happens to round DOWN); the assertion itself is unchanged.
    expect(Math.min(...verts.map((v) => v.z))).toBeGreaterThanOrEqual(Math.fround(moat.minZ) - 1e-6);
  });
});

// -------------------------------------------------------------------------------------------------
// the GO shed
// -------------------------------------------------------------------------------------------------

describe('Union Station v2 — the GO train shed', () => {
  it('stands BEHIND the headhouse with a reveal gap, never inside it', () => {
    const zSouth = dataBox.cz + dataBox.hz;
    expect(probes.shedMinZ).toBeGreaterThan(zSouth);
    const shed = rectOf('go-shed');
    const data: Aabb = {
      minX: dataBox.cx - dataBox.hx,
      maxX: dataBox.cx + dataBox.hx,
      minZ: dataBox.cz - dataBox.hz,
      maxZ: dataBox.cz + dataBox.hz,
    };
    expect(overlaps(shed, data)).toBe(false);
  });

  it('sits inside the Phase-45 rail-lands strip it was given room in', () => {
    const shed = rectOf('go-shed');
    expect(shed.maxZ).toBeLessThanOrEqual(strip.maxY);
    expect(shed.minX).toBeGreaterThanOrEqual(strip.minX);
    expect(shed.maxX).toBeLessThanOrEqual(strip.maxX);
    expect(overlaps(shed, { minX: strip.minX, maxX: strip.maxX, minZ: strip.minY, maxZ: strip.maxY })).toBe(true);
  });

  it('covers the central portion of the facade, centred on it', () => {
    const shed = rectOf('go-shed');
    const width = shed.maxX - shed.minX;
    expect((shed.minX + shed.maxX) / 2).toBeCloseTo(dataBox.cx, 6);
    expect(width).toBeGreaterThan(dataBox.hx); // more than a quarter of the facade
    expect(width).toBeLessThan(2 * dataBox.hx); // …and never wider than the headhouse
  });

  it('is ONE BUILDING cuboid whose collider is exactly its claim', () => {
    const colliders = bespoke.extraColliders.filter((c) => c.id === 'go-shed');
    expect(colliders).toHaveLength(1);
    const shed = rectOf('go-shed');
    const c = colliders[0];
    expect(c.cx).toBeCloseTo((shed.minX + shed.maxX) / 2, 9);
    expect(c.cz).toBeCloseTo((shed.minZ + shed.maxZ) / 2, 9);
    expect(2 * c.hy).toBeCloseTo(probes.shedTopY, 9);
  });

  it('every shed vertex stays inside the footprint it claims (geometry never overhangs its claim)', () => {
    const shed = rectOf('go-shed');
    // Everything south of the shed's own north edge IS the shed: the headhouse's proudest element
    // on that side is the cornice, which stops inside the reveal gap (asserted here so the filter
    // can never silently start including headhouse geometry).
    const zSouth = dataBox.cz + dataBox.hz;
    const headhouseMaxZ = Math.max(...verts.filter((v) => v.z < shed.minZ - 1e-6).map((v) => v.z));
    expect(headhouseMaxZ).toBeGreaterThan(zSouth);
    expect(headhouseMaxZ).toBeLessThan(shed.minZ);
    const inShed = verts.filter((v) => v.z >= shed.minZ - 1e-6);
    expect(inShed.length).toBeGreaterThan(0);
    const EPS = 1e-3; // float32 attribute storage at world coordinates ~1300/~2265
    for (const v of inShed) {
      expect(v.x).toBeGreaterThanOrEqual(shed.minX - EPS);
      expect(v.x).toBeLessThanOrEqual(shed.maxX + EPS);
      expect(v.z).toBeGreaterThanOrEqual(shed.minZ - EPS);
      expect(v.z).toBeLessThanOrEqual(shed.maxZ + EPS);
      expect(v.y).toBeLessThanOrEqual(probes.shedTopY + EPS);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// wordmarks + determinism
// -------------------------------------------------------------------------------------------------

describe('Union Station v2 — the frieze wordmark', () => {
  it('carries the UNION STATION band on the true north facade AND on both camera-visible faces', () => {
    const faces = bespoke.signQuads.map((q) => q.face).sort();
    expect(faces).toEqual(['east', 'north', 'south']);
    for (const quad of bespoke.signQuads) expect(quad.cell).toBe('union-frieze');
  });

  it('every band sits between the colonnade entablature and the wing cornice (never through either)', () => {
    for (const quad of bespoke.signQuads) {
      const bottom = quad.position[1] - quad.heightWu / 2;
      const top = quad.position[1] + quad.heightWu / 2;
      expect(bottom, quad.id).toBeGreaterThan(probes.columnTopY);
      expect(top, quad.id).toBeLessThan(probes.wingTopY);
    }
  });

  it('the camera-visible bands stand PROUD of the facade they ride', () => {
    const south = bespoke.signQuads.find((q) => q.face === 'south')!;
    const east = bespoke.signQuads.find((q) => q.face === 'east')!;
    expect(south.position[2]).toBeGreaterThan(dataBox.cz + dataBox.hz);
    expect(east.position[0]).toBeGreaterThan(dataBox.cx + dataBox.hx);
  });
});

describe('Union Station v2 — determinism', () => {
  it('rebuilds byte-identically', () => {
    const again = resolveNamedBespoke(named.placements).get('union-station')!.buildGeometry();
    for (const name of ['position', 'normal', 'color']) {
      expect(Array.from(again.geometry.getAttribute(name).array as Float32Array)).toEqual(
        Array.from(built.geometry.getAttribute(name).array as Float32Array),
      );
    }
    expect(again.parts).toEqual(built.parts);
  });

  it('derives every dimension from the placement + the street table (no literal coordinates)', () => {
    // The tripwire for the P27 literal-drift class: rebuilt against an explicitly-passed street
    // table, every derived edge must land in the same place.
    const viaCtx = resolveNamedBespoke(named.placements, namedGeometryCtx(streets).streets).get('union-station')!;
    expect(viaCtx.meta.probes).toEqual(probes);
  });
});
