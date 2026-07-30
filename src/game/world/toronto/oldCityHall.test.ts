/**
 * Phase 47 T2 (Part 11) — Old City Hall v2, the fourth `namedGeometryBuilders` tenant.
 *
 * Same two kinds of assertion as royalYork.test.ts / unionStation.test.ts, and the second kind is
 * the point:
 *   • BUDGETS — a ceiling AND a floor. v1 was a 12-triangle flat-topped box, and a ceiling-only
 *     budget is passed just as happily by that box as by the real landmark, so the floor is what
 *     makes a silent revert fail.
 *   • VERTEX PROBES — the geometry is MEASURED, not described. The clock tower really is off-centre
 *     and really is to the WEST (which is the whole reason this landmark reads as Old City Hall
 *     rather than as a generic pile), its cap really lands on the DATA height, the dials really sit
 *     on all four stage faces, and the dormer rows really stand proud of the two camera-visible
 *     roof slopes.
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { CAMERA_EYE_MIN_WU } from '../../config/camera';
import { WALL_STACK } from '../../config/layering';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { buildNamedBuildings } from './namedBuildings';
import { resolveNamedBespoke } from './namedGeometry';
import { OLD_CITY_HALL_MAX_TRIS } from './oldCityHall';

const named = buildNamedBuildings();
const placement = named.placements.find((p) => p.id === 'old-city-hall')!;
const dataBox = placement.boxes[0];
const bespoke = resolveNamedBespoke(named.placements).get('old-city-hall')!;
const built = bespoke.buildGeometry();
const probes = bespoke.meta.probes;

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

/** Group a sorted coordinate list into clusters no wider apart than `gap` — the unionStation /
 * royalYork column-probe idiom, used here for the dormer rows. Callers pass a gap a few percent
 * WIDER than the element's own width: a dormer's two edges are exactly `2 × half` apart in exact
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

describe('Old City Hall v2 — tri budget (Part 11 rule 2)', () => {
  it('stays inside its 900-tri budget, with a floor a plain box could never clear', () => {
    expect(OLD_CITY_HALL_MAX_TRIS).toBe(900);
    expect(built.parts.map((p) => p.id)).toEqual(['old-city-hall-block', 'old-city-hall-tower']);
    expect(built.parts.reduce((n, p) => n + p.triangles, 0)).toBe(built.triangles);
    expect(built.triangles).toBeLessThanOrEqual(OLD_CITY_HALL_MAX_TRIS);
    // THE FLOOR (phase-47-plan's pinned pair): courses + roof + dormers + turrets + the whole clock
    // tower + the triple-arched entry cannot be built for less than this, so a regression that
    // quietly reverted any whole subsystem fails here even though every proportion pin below would
    // still pass.
    expect(built.triangles).toBeGreaterThan(250);
    expect(built.triangles).toBe(positions(built.geometry).length / 9);
    // Both halves are real: neither the block nor the tower may collapse to a stub.
    for (const part of built.parts) expect(part.triangles, part.id).toBeGreaterThan(80);
  });
});

// -------------------------------------------------------------------------------------------------
// the massing: data-height truth + the shortened render box
// -------------------------------------------------------------------------------------------------

describe('Old City Hall v2 — heights are the DATA row, not a new invention', () => {
  it('the clock tower tops out at EXACTLY the data height (which IS the height to the tower top)', () => {
    // building-specs.json's R47 note is explicit: 103.6 m is the height "to top of off-centre clock
    // tower". So the DATA height describes the tower's APEX, and the apex is what has to land on
    // it — not the shaft, and certainly not the roof ridge.
    const dataHeight = dataBox.hy * 2;
    expect(probes.dataHeight).toBeCloseTo(dataHeight, 12);
    expect(probes.towerTopY).toBeCloseTo(dataHeight, 12);
    expect(bespoke.meta.topY).toBeCloseTo(dataHeight, 12);
    const maxY = Math.max(...verts.map((v) => v.y));
    expect(maxY).toBeCloseTo(dataHeight, 4);
    // …and the tallest vertex is the tower's own apex, not some other element that grew past it.
    const apex = verts.filter((v) => v.y > dataHeight - 1e-4);
    expect(apex.length).toBeGreaterThan(0);
    for (const v of apex) {
      // Float32 vertex data at world coordinates ~1.4e3 carries ~1e-4 of absolute precision, so
      // every positional comparison in this file is made at 3 decimals, never at machine epsilon.
      expect(v.x).toBeCloseTo(probes.towerCenterX, 3);
      expect(v.z).toBeCloseTo(probes.towerCenterZ, 3);
    }
  });

  it('stays BELOW the eye line — this landmark can never become a heightLaw crosser', () => {
    expect(probes.dataHeight).toBeLessThan(CAMERA_EYE_MIN_WU);
    expect(bespoke.meta.topY).toBeLessThan(CAMERA_EYE_MIN_WU);
  });

  it('the render box is the BODY height — 0.52 of the data height, same footprint and look', () => {
    expect(bespoke.renderBoxes).toHaveLength(1);
    const render = bespoke.renderBoxes[0];
    expect(render.hy).toBeLessThan(dataBox.hy); // the Royal York pattern: the box SHRINKS
    expect(render.hy * 2).toBeCloseTo(probes.bodyTopY, 12);
    expect(probes.bodyTopY / probes.dataHeight).toBeCloseTo(0.52, 6);
    expect([render.cx, render.cz, render.hx, render.hz]).toEqual([dataBox.cx, dataBox.cz, dataBox.hx, dataBox.hz]);
    expect(render.look).toEqual(dataBox.look);
  });

  it('the courses, the roof and the tower stack in order, each above the last', () => {
    expect(probes.bandCourseY).toBeGreaterThan(0);
    expect(probes.bandCourseY).toBeLessThan(probes.bodyTopY); // the darker string course, mid-facade
    expect(probes.roofBaseY).toBeGreaterThan(probes.bodyTopY); // the eave cornice
    expect(probes.roofRidgeY).toBeGreaterThan(probes.roofBaseY); // the hipped roof
    expect(probes.ridgeCrestTopY).toBeGreaterThan(probes.roofRidgeY); // its cresting
    expect(probes.towerShaftTopY).toBeGreaterThan(probes.bodyTopY); // the tower clears the block…
    expect(probes.towerStageTopY).toBeGreaterThan(probes.towerShaftTopY); // …carries the clock stage…
    expect(probes.towerCollarTopY).toBeGreaterThan(probes.towerStageTopY); // …the copper collar…
    expect(probes.towerTopY).toBeGreaterThan(probes.towerCollarTopY); // …and the pyramidal cap.
    // The tower is the tall thing: it stands well clear of the ridge it rises behind.
    expect(probes.towerTopY - probes.roofRidgeY).toBeGreaterThan(2);
  });

  it('the roof is a real hip — a short ridge over a full-footprint eave, not a flat lid', () => {
    expect(probes.roofRidgeHalfX).toBeGreaterThan(0);
    expect(probes.roofRidgeHalfZ).toBeGreaterThan(0);
    expect(probes.roofRidgeHalfX).toBeLessThan(dataBox.hx / 2);
    expect(probes.roofRidgeHalfZ).toBeLessThan(dataBox.hz / 2);
    // Pitch: rise over the run from eave to ridge, in degrees. The Royal York's apron measured 6–19°
    // and shaded as a flat plate; this roof is deliberately steeper (the researched "steep hipped
    // form"), and the number is pinned so a future re-proportion can't quietly flatten it.
    const rise = probes.roofRidgeY - probes.roofBaseY;
    const run = dataBox.hx - probes.roofRidgeHalfX;
    expect((Math.atan2(rise, run) * 180) / Math.PI).toBeGreaterThan(25);
  });

  it('the three corner turrets rise past the ridge without leaving the exclusion margin', () => {
    expect(probes.turretCount).toBe(3);
    expect(probes.turretApexY).toBeGreaterThan(probes.ridgeCrestTopY);
    expect(probes.turretApexY).toBeLessThan(probes.towerTopY);
    // Half-engaged on the corner: it stands `turretHalfWu` proud, which must stay well inside
    // namedBuildings.ts's 3 wu massing-exclusion margin (no claim or collider is owed).
    expect(probes.turretHalfWu).toBeLessThan(3);
    const maxX = Math.max(...verts.map((v) => v.x));
    const maxZ = Math.max(...verts.map((v) => v.z));
    expect(maxX - (dataBox.cx + dataBox.hx)).toBeLessThan(3);
    expect(maxZ - (dataBox.cz + dataBox.hz)).toBeLessThan(3);
  });
});

// -------------------------------------------------------------------------------------------------
// THE landmark feature: the off-centre clock tower
// -------------------------------------------------------------------------------------------------

describe('Old City Hall v2 — the OFF-CENTRE clock tower', () => {
  it('sits WEST of the block centre — the Bay Street view terminus, not a centred campanile', () => {
    // The researched identity ("off-centre clock tower... visual anchor for Bay Street"), and Bay
    // runs immediately WEST of this lot (namedBuildings.ts places the box at bay + 19). Both the
    // direction and the fact that it is off-centre at all are pinned; the magnitude is derived.
    expect(probes.towerCenterX).toBeLessThan(dataBox.cx);
    expect(dataBox.cx - probes.towerCenterX).toBeCloseTo(0.6 * dataBox.hx, 9);
    // Nearer the west facade than the east one, by a wide margin.
    const toWest = probes.towerCenterX - (dataBox.cx - dataBox.hx);
    const toEast = dataBox.cx + dataBox.hx - probes.towerCenterX;
    expect(toWest).toBeLessThan(toEast / 2);
  });

  it('stands entirely on its own footprint — the widest stage never overhangs the block', () => {
    expect(probes.towerCenterX - probes.towerStageHalf).toBeGreaterThan(dataBox.cx - dataBox.hx);
    expect(probes.towerCenterX + probes.towerStageHalf).toBeLessThan(dataBox.cx + dataBox.hx);
  });

  it('is ENGAGED with the south facade — proud of the wall, and inside the exclusion margin', () => {
    const zSouth = dataBox.cz + dataBox.hz;
    const shaftFaceZ = probes.towerCenterZ + probes.towerHalf;
    expect(shaftFaceZ).toBeGreaterThan(zSouth); // it breaks the facade line
    expect(shaftFaceZ - zSouth).toBeLessThan(3); // …but never leaves the 3 wu massing margin
    expect(probes.towerCenterZ - probes.towerHalf).toBeLessThan(zSouth); // its north half is buried
  });
});

describe('Old City Hall v2 — four clock faces (researched)', () => {
  const stageHalf = probes.towerStageHalf;

  it('carries a dial on all FOUR stage faces, not just the camera-visible pair', () => {
    expect(probes.clockFaceCount).toBe(4);
    // Measured, not asserted from the constant: each dial rides one rung proud of its own stage
    // wall (WALL_STACK.crownDecal), so exactly four such planes exist in the mesh.
    const off = WALL_STACK.crownDecal;
    const planes = [
      verts.filter((v) => Math.abs(v.z - (probes.towerCenterZ + stageHalf + off)) < 1e-3),
      verts.filter((v) => Math.abs(v.x - (probes.towerCenterX + stageHalf + off)) < 1e-3),
      verts.filter((v) => Math.abs(v.z - (probes.towerCenterZ - stageHalf - off)) < 1e-3),
      verts.filter((v) => Math.abs(v.x - (probes.towerCenterX - stageHalf - off)) < 1e-3),
    ];
    for (const plane of planes) expect(plane.length).toBeGreaterThan(0);
  });

  it('every dial fits INSIDE the stage it rides, vertically and horizontally', () => {
    expect(probes.clockRadius).toBeGreaterThan(0);
    expect(probes.clockRadius).toBeLessThan(stageHalf);
    expect(probes.clockFaceY - probes.clockRadius).toBeGreaterThan(probes.towerShaftTopY);
    expect(probes.clockFaceY + probes.clockRadius).toBeLessThan(probes.towerStageTopY);
  });

  it('the hands read the frozen evening time (a design literal, derived — never hand-typed angles)', () => {
    // 8:20 pm — CLOCK_TIME in oldCityHall.ts, chosen for the permanent blue hour and for hands that
    // do not collapse into one stripe.
    expect(probes.clockHourAngle).toBeCloseTo(((8 % 12) + 20 / 60) * (Math.PI / 6), 12);
    expect(probes.clockMinuteAngle).toBeCloseTo(20 * (Math.PI / 30), 12);
    expect(probes.clockHourAngle).not.toBeCloseTo(probes.clockMinuteAngle, 2);
  });

  it('the hands sit one ladder rung PROUD of the dial (never coplanar with it)', () => {
    expect(WALL_STACK.fasciaBand).toBeGreaterThan(WALL_STACK.crownDecal);
    const handPlane = verts.filter((v) => Math.abs(v.z - (probes.towerCenterZ + stageHalf + WALL_STACK.fasciaBand)) < 1e-3);
    expect(handPlane.length).toBeGreaterThan(0);
    // Every hand vertex stays inside the dial it is drawn on.
    for (const v of handPlane) {
      const du = v.x - probes.towerCenterX;
      const dv = v.y - probes.clockFaceY;
      expect(Math.hypot(du, dv)).toBeLessThanOrEqual(probes.clockRadius + 1e-3);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// the roof dormers
// -------------------------------------------------------------------------------------------------

describe('Old City Hall v2 — gable dormers on the camera-visible slopes', () => {
  it('carries a row on both camera-visible slopes, and skips the bays the tower occupies', () => {
    expect(probes.dormerCountSouth).toBeGreaterThan(0);
    expect(probes.dormerCountEast).toBeGreaterThan(0);
    // The south row is laid on `dormerBaysSouth` uniform bays and loses the ones inside the tower;
    // the east row is 15 wu away across the block and loses none.
    expect(probes.dormerCountSouth).toBeLessThan(probes.dormerBaysSouth);
    expect(probes.dormerCountEast).toBe(probes.dormerBaysEast);
  });

  it('every dormer clears the thin-geometry floor (a to-scale dormer would strobe)', () => {
    expect(2 * probes.dormerHalfWidthWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
    expect(probes.dormerProudWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });

  it('the row stands above the eave and stays inside the roof (never crosses the ridge)', () => {
    expect(probes.dormerRowY0).toBeGreaterThan(probes.roofBaseY);
    expect(probes.dormerRowY1).toBeGreaterThan(probes.dormerRowY0);
    expect(probes.dormerRowY1).toBeLessThan(probes.roofRidgeY);
  });

  it('south dormers really stand proud of the slope — one distinct cluster per dormer', () => {
    // At the dormer band's Y range, the only geometry between the slope surface and its own proud
    // depth is the dormers (the tower and the corner turrets stand further out and are excluded by
    // the upper bound).
    const xs = verts
      .filter(
        (v) =>
          v.y >= probes.dormerRowY0 - 1e-3 &&
          v.y <= probes.dormerRowY1 + 1e-3 &&
          v.z > probes.southRowZ + 1e-3 &&
          v.z <= probes.southRowZ + probes.dormerProudWu + 1e-3,
      )
      .map((v) => v.x);
    expect(clusters(xs, 2.1 * probes.dormerHalfWidthWu)).toHaveLength(probes.dormerCountSouth);
  });

  it('east dormers really stand proud of the slope — one distinct cluster per dormer', () => {
    const zs = verts
      .filter(
        (v) =>
          v.y >= probes.dormerRowY0 - 1e-3 &&
          v.y <= probes.dormerRowY1 + 1e-3 &&
          v.x > probes.eastRowX + 1e-3 &&
          v.x <= probes.eastRowX + probes.dormerProudWu + 1e-3,
      )
      .map((v) => v.z);
    expect(clusters(zs, 2.1 * probes.dormerHalfWidthWu)).toHaveLength(probes.dormerCountEast);
  });

  it('carries both the sandstone and the copper-patina colour families', () => {
    // Sandstone reads warm (R > B); oxidized copper reads the opposite (G is the dominant channel).
    // A crude but decisive channel split, robust to the baked directional shade (royalYork.test.ts's
    // idiom — a uniform per-vertex scalar cannot change which channel is largest).
    const colors = built.geometry.getAttribute('color').array as Float32Array;
    let warm = 0;
    let green = 0;
    for (let i = 0; i < colors.length; i += 3) {
      const r = colors[i];
      const g = colors[i + 1];
      const b = colors[i + 2];
      if (r > b) warm++;
      else if (g >= r && g >= b) green++;
    }
    expect(warm).toBeGreaterThan(0);
    expect(green).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------------
// the triple-arched entry
// -------------------------------------------------------------------------------------------------

describe('Old City Hall v2 — the triple-arched entry (researched)', () => {
  it('is a THREE-bay porch on the south facade, at the tower base', () => {
    expect(probes.archCount).toBe(3);
    const zSouth = dataBox.cz + dataBox.hz;
    expect(probes.porchFaceZ).toBeGreaterThan(zSouth); // proud of the wall…
    expect(probes.porchFaceZ - zSouth).toBeLessThan(3); // …and inside the exclusion margin
    expect(probes.porchFaceZ).toBeGreaterThan(probes.towerCenterZ + probes.towerHalf); // in front of the tower
    // Centred on the tower — on the real building the main entrance is at the tower's foot.
    expect((probes.porchMinX + probes.porchMaxX) / 2).toBeCloseTo(probes.towerCenterX, 9);
    expect(probes.porchMaxX - probes.porchMinX).toBeGreaterThan(2 * probes.towerHalf);
  });

  it('the porch is a ground-storey element — well below the cornice', () => {
    expect(probes.porchTopY).toBeGreaterThan(0);
    expect(probes.porchTopY).toBeLessThan(probes.bodyTopY / 2);
  });
});

// -------------------------------------------------------------------------------------------------
// claims / colliders / determinism
// -------------------------------------------------------------------------------------------------

describe('Old City Hall v2 — no extra claim, collider or wordmark', () => {
  it('everything stays on the DATA box, so the Phase-24 claim/collider machinery is unchanged', () => {
    expect(bespoke.extraClaims).toEqual([]);
    expect(bespoke.extraColliders).toEqual([]);
    // No atlas wordmark: the 32-px homage font cannot quote carved stone lettering honestly, and
    // namedGeometry.test.ts's camera-visible-wordmark law binds only where signQuads exist.
    expect(bespoke.signQuads).toEqual([]);
  });
});

describe('Old City Hall v2 — determinism', () => {
  it('rebuilds byte-identically', () => {
    const again = resolveNamedBespoke(named.placements).get('old-city-hall')!.buildGeometry();
    for (const name of ['position', 'normal', 'color']) {
      expect(Array.from(again.geometry.getAttribute(name).array as Float32Array)).toEqual(
        Array.from(built.geometry.getAttribute(name).array as Float32Array),
      );
    }
    expect(again.parts).toEqual(built.parts);
  });

  it('derives every dimension from the placement alone (no literal world coordinates)', () => {
    const viaFresh = resolveNamedBespoke(buildNamedBuildings().placements).get('old-city-hall')!;
    expect(viaFresh.meta.probes).toEqual(probes);
  });
});
