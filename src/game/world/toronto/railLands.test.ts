/**
 * Phase 45 (Part 11) — the rail-lands block: tri budgets, determinism, the camera-face law, the
 * thin-geometry law, and the placement contract (lots + the reserved corridor strip).
 *
 * The strip claim is the load-bearing one. Before this phase the corridor south of Front between
 * Spadina and Bay was filled with generic backdrop towers, back-lot boxes, laneway clutter, a
 * construction site and ~16 deep-scatter trees; after it, a blocking-claim census of the strip must
 * return ONLY the rail lands' own placements. That census is a test here rather than a screenshot
 * because it is the difference between "the rail lands read as rail lands" and "the rail lands are
 * a generic block with a roundhouse in it".
 */
import { describe, expect, it } from 'vitest';
import { CAMERA_EYE_MIN_WU } from '../../config/camera';
import { GROUND_STACK } from '../../config/layering';
import { NAMED_HEIGHT_SCALE } from '../../config/torontoMap';
import type { BufferGeometry } from 'three';
import buildingSpecsJson from '../../../../data/toronto/building-specs.json';
import { overlaps, type Aabb } from './claimIndex';
import { composeWorld } from './composeWorld';
import { hGame } from './heightCurve';
import { logoCellUv } from './logoAtlas';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import {
  RAIL_LANDS_LOTS,
  RAIL_LANDS_MAX_TRIS,
  RAIL_LANDS_SPEC_IDS,
  RAIL_PAINT_MIN_WIDTH_WU,
  SIGN_ATLAS,
  buildAquariumGeometry,
  buildLocomotiveGeometry,
  buildRailLandsDecalGeometry,
  buildRailLandsLayout,
  buildRailLandsPaint,
  buildRailLandsSignGeometry,
  buildRailLandsSolids,
  buildRoundhouseGeometry,
  paintStripeWidths,
  railLandsLot,
  railLandsStrip,
  railLandsZones,
  resetRailLandsLayoutCache,
  signCellUv,
} from './railLands';
import { buildStreets } from './streets';

const layout = buildRailLandsLayout();

function attr(geometry: BufferGeometry, name: string): Float32Array {
  const a = geometry.getAttribute(name);
  expect(a, `geometry is missing the "${name}" attribute`).toBeTruthy();
  return a.array as Float32Array;
}

function rectToAabb(r: { minX: number; maxX: number; minY: number; maxY: number }): Aabb {
  return { minX: r.minX, maxX: r.maxX, minZ: r.minY, maxZ: r.maxY };
}

function corners(a: Aabb): { x: number; y: number }[] {
  return [
    { x: a.minX, y: a.minZ },
    { x: a.maxX, y: a.minZ },
    { x: a.maxX, y: a.maxZ },
    { x: a.minX, y: a.maxZ },
  ];
}

// -------------------------------------------------------------------------------------------------
// Tri budgets (Part 11 rule 2 — stated per model, pinned in the phase that introduces them)
// -------------------------------------------------------------------------------------------------

describe('rail lands — tri budgets', () => {
  it.each([
    ['aquarium', buildAquariumGeometry, RAIL_LANDS_MAX_TRIS.aquarium],
    ['roundhouse', buildRoundhouseGeometry, RAIL_LANDS_MAX_TRIS.roundhouse],
    ['locomotive', buildLocomotiveGeometry, RAIL_LANDS_MAX_TRIS.locomotive],
  ] as const)('%s stays within its budget and its meta agrees with the geometry', (_name, build, budget) => {
    const { geometry, meta } = build(layout);
    const tris = attr(geometry, 'position').length / 9;
    expect(tris).toBe(meta.triangles);
    expect(tris).toBeGreaterThan(0);
    expect(tris).toBeLessThanOrEqual(budget);
  });

  it('the merged solids mesh is exactly the three parts plus the patio string-lights', () => {
    const solids = buildRailLandsSolids(layout);
    const parts = solids.parts.reduce((n, p) => n + p.triangles, 0);
    expect(solids.triangles).toBeGreaterThan(parts); // the patio lights are the difference
    expect(solids.parts.map((p) => p.id)).toEqual(['aquarium-block', 'roundhouse', 'locomotive']);
    // One merged mesh = one draw call for all three landmarks; the whole layer costs 7 calls
    // (solids, ground paint, wordmark signs, logo decals, 3 pack-prop batches).
    expect(attr(solids.geometry, 'position').length / 9).toBe(solids.triangles);
  });
});

// -------------------------------------------------------------------------------------------------
// Determinism
// -------------------------------------------------------------------------------------------------

describe('rail lands — determinism', () => {
  it('every builder produces byte-identical geometry on a rebuild', () => {
    const builders = [buildAquariumGeometry, buildRoundhouseGeometry, buildLocomotiveGeometry];
    for (const build of builders) {
      const a = build(layout).geometry;
      const b = build(layout).geometry;
      for (const name of ['position', 'normal', 'color']) {
        expect(Array.from(attr(a, name))).toEqual(Array.from(attr(b, name)));
      }
    }
    const p1 = buildRailLandsPaint(layout).geometry;
    const p2 = buildRailLandsPaint(layout).geometry;
    expect(Array.from(attr(p1, 'position'))).toEqual(Array.from(attr(p2, 'position')));
  });

  it('the layout itself is deterministic across a cache reset', () => {
    const first = JSON.stringify(buildRailLandsLayout());
    resetRailLandsLayoutCache();
    const second = JSON.stringify(buildRailLandsLayout());
    expect(second).toEqual(first);
  });

  it('passing the street table explicitly produces the same strip as the memoized path', () => {
    const streets = buildStreets().streets;
    expect(railLandsStrip(streets)).toEqual(layout.strip);
  });
});

// -------------------------------------------------------------------------------------------------
// Data-first: heights and footprints come from the spec rows, never from a code literal
// -------------------------------------------------------------------------------------------------

describe('rail lands — data-first dimensions', () => {
  const specs = buildingSpecsJson.buildings as readonly { id: string; real_h_m: number; footprint_wu: number; material: string }[];
  const spec = (id: string) => specs.find((s) => s.id === id)!;

  it('both spec rows exist and are the ids this module owns', () => {
    expect([...RAIL_LANDS_SPEC_IDS].sort()).toEqual(['aquarium-block', 'roundhouse']);
    for (const id of RAIL_LANDS_SPEC_IDS) expect(spec(id), id).toBeTruthy();
  });

  it('the aquarium is NAMED-class: hGame(real_h_m) × NAMED_HEIGHT_SCALE, footprint from the row', () => {
    const s = spec('aquarium-block');
    expect(layout.aquarium.height).toBeCloseTo(hGame(s.real_h_m) * NAMED_HEIGHT_SCALE, 9);
    expect(layout.aquarium.span.hx * 2).toBeCloseTo(s.footprint_wu, 9);
  });

  it('the roundhouse is NAMED-class and its arc diameter IS the spec footprint', () => {
    const s = spec('roundhouse');
    expect(layout.roundhouse.height).toBeCloseTo(hGame(s.real_h_m) * NAMED_HEIGHT_SCALE, 9);
    expect(layout.roundhouse.outerR * 2).toBeCloseTo(s.footprint_wu, 9);
    // "10–14 visible bays" — the reduced-arc homage of the real 32 (spec row footprint_note).
    expect(layout.roundhouse.bays).toBeGreaterThanOrEqual(10);
    expect(layout.roundhouse.bays).toBeLessThanOrEqual(14);
  });
});

// -------------------------------------------------------------------------------------------------
// THE EYE-LINE TRIPWIRE (Part 11 rule 4)
// -------------------------------------------------------------------------------------------------

describe('rail lands — the eye-line law', () => {
  it('every part stays UNDER CAMERA_EYE_MIN_WU (else it MUST join the Phase 36 dither path)', () => {
    for (const part of buildRailLandsSolids(layout).parts) {
      expect(part.heightWu, `${part.id}`).toBeLessThan(CAMERA_EYE_MIN_WU);
    }
    for (const c of layout.colliders) {
      expect(2 * c.hy, `${c.id}`).toBeLessThan(CAMERA_EYE_MIN_WU);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// CAMERA FACE LAW (Phase 34's re-derived pin): south (+Z) and east (+X) only
// -------------------------------------------------------------------------------------------------

describe('rail lands — signs sit on the two camera-visible faces and nowhere else', () => {
  it('every sign declares a south/east face with the matching CROWN-decal rotation', () => {
    expect(layout.signs.length).toBeGreaterThan(0);
    for (const s of layout.signs) {
      expect(['south', 'east']).toContain(s.face);
      expect(s.rotationY).toBeCloseTo(s.face === 'south' ? 0 : Math.PI / 2, 9);
      // Exactly one texture source per sign — a wordmark cell or a logo-atlas brand, never both.
      expect(s.cell === null).not.toBe(s.brand === null);
    }
  });

  it('the EMITTED quad normals are exactly +Z or +X (the structural form of the same law)', () => {
    for (const geometry of [buildRailLandsSignGeometry(layout).geometry, buildRailLandsDecalGeometry(layout).geometry]) {
      const normals = attr(geometry, 'normal');
      expect(normals.length).toBeGreaterThan(0);
      for (let i = 0; i < normals.length; i += 3) {
        const n: [number, number, number] = [normals[i], normals[i + 1], normals[i + 2]];
        const isSouth = Math.abs(n[0]) < 1e-6 && Math.abs(n[1]) < 1e-6 && Math.abs(n[2] - 1) < 1e-6;
        const isEast = Math.abs(n[0] - 1) < 1e-6 && Math.abs(n[1]) < 1e-6 && Math.abs(n[2]) < 1e-6;
        expect(isSouth || isEast, `sign normal ${JSON.stringify(n)} faces neither south nor east`).toBe(true);
      }
    }
  });

  it('both sign geometries are non-empty and split the sign list between them', () => {
    const text = buildRailLandsSignGeometry(layout);
    const decals = buildRailLandsDecalGeometry(layout);
    expect(text.count).toBeGreaterThan(0);
    expect(decals.count).toBeGreaterThan(0);
    expect(text.count + decals.count).toBe(layout.signs.length);
  });

  it('the Steam Whistle decals sample the shared logo atlas cell, not the sign texture', () => {
    const brands = layout.signs.filter((s) => s.brand !== null).map((s) => s.brand);
    expect(new Set(brands)).toEqual(new Set(['steamwhistle']));
    const uv = logoCellUv('steamwhistle');
    const emitted = attr(buildRailLandsDecalGeometry(layout).geometry, 'uv');
    for (let i = 0; i < emitted.length; i += 2) {
      expect(emitted[i]).toBeGreaterThanOrEqual(uv.u0 - 1e-6);
      expect(emitted[i]).toBeLessThanOrEqual(uv.u1 + 1e-6);
      expect(emitted[i + 1]).toBeGreaterThanOrEqual(uv.v0 - 1e-6);
      expect(emitted[i + 1]).toBeLessThanOrEqual(uv.v1 + 1e-6);
    }
  });

  it('sign cell UVs follow the logoAtlas flipY convention and stay inside the canvas', () => {
    for (const id of Object.keys(SIGN_ATLAS.cells) as (keyof typeof SIGN_ATLAS.cells)[]) {
      const uv = signCellUv(id);
      expect(uv.u0).toBeGreaterThanOrEqual(0);
      expect(uv.u1).toBeLessThanOrEqual(1);
      expect(uv.v0).toBeGreaterThanOrEqual(0);
      expect(uv.v1).toBeLessThanOrEqual(1);
      expect(uv.u1).toBeGreaterThan(uv.u0);
      expect(uv.v1).toBeGreaterThan(uv.v0);
    }
    // Row 0 sits at the TOP of the canvas, hence the TOP of v-space (v1 === 1).
    expect(signCellUv('aquariumFascia').v1).toBeCloseTo(1, 9);
  });

  it('no fascia band or decal pokes above the building it is mounted on', () => {
    const hostTop = new Map<string, number>([
      ['aquarium-fascia-south', layout.aquarium.height],
      ['steamwhistle-fascia-south', layout.roundhouse.annex.h],
      ['steamwhistle-fascia-east', layout.roundhouse.annex.h],
      ['steamwhistle-decal-south', layout.roundhouse.annex.h],
      ['steamwhistle-decal-east', layout.roundhouse.annex.h],
      ['aquarium-blade-south', layout.aquarium.bladePylon.top],
      ['aquarium-blade-east', layout.aquarium.bladePylon.top],
    ]);
    for (const s of layout.signs) {
      const top = hostTop.get(s.id);
      expect(top, `sign "${s.id}" has no pinned host — add it to this table`).toBeDefined();
      expect(s.position[1] + s.height / 2, s.id).toBeLessThanOrEqual(top! + 1e-9);
      expect(s.position[1] - s.height / 2, s.id).toBeGreaterThan(0);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// THE THIN-GEOMETRY LAW (config/surfaces.ts) + the ground-stack ladder (config/layering.ts)
// -------------------------------------------------------------------------------------------------

describe('rail lands — ground dressing obeys the surface + layering laws', () => {
  it('no painted band is narrower than the thin-geometry floor (rails cannot ship literal)', () => {
    const widths = paintStripeWidths(layout);
    expect(widths.length).toBeGreaterThan(0);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(RAIL_PAINT_MIN_WIDTH_WU);
  });

  it('every painted Y is one of the two rail rungs — no ad-hoc epsilon', () => {
    const allowed = new Set<number>([GROUND_STACK.railBallast, GROUND_STACK.railTrack]);
    for (const r of layout.paint) expect(allowed.has(r.y), `paint rect at y=${r.y}`).toBe(true);
    expect(layout.turntable.deckY).toBe(GROUND_STACK.railBallast);
  });

  it('the ballast bed and the marks painted on it are on DIFFERENT rungs (the coplanar rule)', () => {
    expect(GROUND_STACK.railTrack).toBeGreaterThan(GROUND_STACK.railBallast);
    const beds = layout.paint.filter((r) => r.y === GROUND_STACK.railBallast);
    const marks = layout.paint.filter((r) => r.y === GROUND_STACK.railTrack);
    expect(beds.length).toBeGreaterThan(0);
    expect(marks.length).toBeGreaterThan(0);
    // …and every mark really does sit inside a bed (that overlap is WHY they need two rungs).
    const insideABed = marks.filter((m) =>
      beds.some((b) => overlaps({ minX: m.minX, maxX: m.maxX, minZ: m.minZ, maxZ: m.maxZ }, { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ })),
    );
    expect(insideABed.length).toBeGreaterThan(0);
  });

  it('no two ballast-rung rects interior-overlap each other (nor two track-rung rects)', () => {
    for (const rung of [GROUND_STACK.railBallast, GROUND_STACK.railTrack]) {
      const rects = layout.paint.filter((r) => r.y === rung).map((r) => ({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(
            overlaps(rects[i], rects[j]),
            `two rects on rung ${rung} interior-overlap: ${JSON.stringify(rects[i])} vs ${JSON.stringify(rects[j])}`,
          ).toBe(false);
        }
      }
    }
  });

  it('the whole ground dressing stays inside the reserved strip', () => {
    const strip = rectToAabb(layout.strip);
    for (const r of layout.paint) {
      expect(r.minX, 'paint minX').toBeGreaterThanOrEqual(strip.minX - 1e-6);
      expect(r.maxX, 'paint maxX').toBeLessThanOrEqual(strip.maxX + 1e-6);
      expect(r.minZ, 'paint minZ').toBeGreaterThanOrEqual(strip.minZ - 1e-6);
      expect(r.maxZ, 'paint maxZ').toBeLessThanOrEqual(strip.maxZ + 1e-6);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// PLACEMENT CONTRACT: lots, the strip, and what the arbiter ends up holding
// -------------------------------------------------------------------------------------------------

describe('rail lands — lots and the reserved strip', () => {
  it('both lots sit wholly inside the §1 polygon', () => {
    expect(RAIL_LANDS_LOTS.length).toBe(2);
    for (const lot of RAIL_LANDS_LOTS) {
      expect(corners(rectToAabb(lot)).every((c) => pointInPolygon(c, PLAYABLE_POLYGON))).toBe(true);
    }
  });

  it('the strip sits inside the polygon and contains both lots', () => {
    const strip = rectToAabb(layout.strip);
    expect(corners(strip).every((c) => pointInPolygon(c, PLAYABLE_POLYGON))).toBe(true);
    for (const lot of RAIL_LANDS_LOTS) {
      const a = rectToAabb(lot);
      expect(a.minX).toBeGreaterThanOrEqual(strip.minX);
      expect(a.maxX).toBeLessThanOrEqual(strip.maxX);
      expect(a.minZ).toBeGreaterThanOrEqual(strip.minZ);
      expect(a.maxZ).toBeLessThanOrEqual(strip.maxZ);
    }
  });

  it('the strip clears every bounding street ribbon AND its sidewalk band (the streetwall survives)', () => {
    const streets = buildStreets().streets;
    const strip = rectToAabb(layout.strip);
    for (const id of ['front', 'bremner', 'spadina', 'bay', 'york']) {
      const st = streets.find((s) => s.id === id)!;
      expect(overlaps(strip, rectToAabb(st.ribbon)), `strip overlaps the ${id} ribbon`).toBe(false);
    }
  });

  it('the two lots do not overlap each other, nor the two hero lots', () => {
    const world = composeWorld(416);
    const heroes = world.named.heroLots.map(rectToAabb);
    const lots = RAIL_LANDS_LOTS.map(rectToAabb);
    expect(overlaps(lots[0], lots[1])).toBe(false);
    for (const lot of lots) for (const hero of heroes) expect(overlaps(lot, hero)).toBe(false);
  });

  it('railLandsZones() is exactly the two lots plus the strip', () => {
    const zones = railLandsZones();
    expect(zones.length).toBe(3);
    expect(zones.slice(0, 2)).toEqual([...RAIL_LANDS_LOTS]);
    expect(zones[2]).toEqual(layout.strip);
  });

  it('each building is anchored on its OWN lot (no drifting off the reservation)', () => {
    for (const [id, center] of [
      ['aquarium-block', layout.aquarium.center],
      ['roundhouse', layout.roundhouse.center],
    ] as const) {
      const lot = railLandsLot(id);
      expect(center.x).toBeCloseTo((lot.minX + lot.maxX) / 2, 9);
      expect(center.z).toBeCloseTo((lot.minY + lot.maxY) / 2, 9);
    }
  });
});

describe('rail lands — the arbiter holds the whole block', () => {
  const world = composeWorld(416);
  const claims = world.index.allClaims().filter((c) => c.source === 'railLands');

  it('registers one blocking claim per collider plus one per patio prop', () => {
    const volumes = claims.filter((c) => c.kind === 'namedBuilding');
    const props = claims.filter((c) => c.kind === 'decor');
    expect(volumes.length).toBe(layout.colliders.length);
    expect(props.length).toBe(layout.props.length);
    expect(volumes.length + props.length).toBe(claims.length);
    // Every building volume carries a per-building owner (which is what sanctions a building's own
    // multi-box collider set against itself) and the material fade path's null key.
    for (const v of volumes) {
      expect(v.owner).toMatch(/^railLands:(aquarium-block|roundhouse|locomotive)$/);
      expect(v.fadeKey).toBeNull();
      expect(v.yRange).toBeDefined();
    }
    for (const p of props) expect(p.owner).toBe('railLands:patio');
  });

  it('the three ZONES arrive through namedBuildings.exclusions as namedExclusion claims', () => {
    const zones = railLandsZones().map(rectToAabb);
    const registered = world.index
      .allClaims()
      .filter((c) => c.kind === 'namedExclusion')
      .map((c) => c.aabb);
    for (const zone of zones) {
      expect(
        registered.some(
          (r) =>
            Math.abs(r.minX - zone.minX) < 1e-9 &&
            Math.abs(r.maxX - zone.maxX) < 1e-9 &&
            Math.abs(r.minZ - zone.minZ) < 1e-9 &&
            Math.abs(r.maxZ - zone.maxZ) < 1e-9,
        ),
        `rail-lands zone ${JSON.stringify(zone)} is not registered as a namedExclusion`,
      ).toBe(true);
    }
  });

  // PHASE 46: the strip was reserved as ROOM, not as a void — its whole point is that authored
  // landmark geometry can take it while generic placers cannot. Union Station's GO train shed is
  // the first authorized tenant (world/toronto/unionStation.ts: it stands behind the headhouse,
  // over the ballast beds this layer paints, which is exactly where the real one stands). It is
  // therefore exempted BY NAME rather than by widening the filter to a whole source or kind — a
  // generic `named`-sourced intrusion still fails this census.
  const AUTHORIZED_STRIP_TENANT_IDS: ReadonlySet<string> = new Set(['named-bespoke:union-station:go-shed']);

  it('THE ACCEPTANCE CENSUS: nothing but the rail lands + its authorized tenants stands inside the strip', () => {
    const strip = rectToAabb(layout.strip);
    const inside = world.index.allClaims().filter((c) => c.blocking && c.source !== 'railLands' && overlaps(strip, c.aabb));
    const intruders = inside
      .filter((c) => !AUTHORIZED_STRIP_TENANT_IDS.has(c.id))
      .map((c) => ({ id: c.id, kind: c.kind, source: c.source }));
    expect(
      intruders,
      intruders.length === 0 ? undefined : `${intruders.length} generic placement(s) survive inside the reserved rail-lands strip: ${JSON.stringify(intruders.slice(0, 10))}`,
    ).toEqual([]);
    // …and the exemption list stays EXACT: a stale entry fails as loudly as a new intrusion.
    expect(inside.map((c) => c.id).sort()).toEqual([...AUTHORIZED_STRIP_TENANT_IDS].sort());
  });

  it('every rail-lands claim volume is inside the strip and inside the polygon', () => {
    const strip = rectToAabb(layout.strip);
    for (const c of claims) {
      expect(overlaps(strip, c.aabb), `${c.id} is outside the strip`).toBe(true);
      expect(corners(c.aabb).every((p) => pointInPolygon(p, PLAYABLE_POLYGON)), c.id).toBe(true);
    }
  });
});

describe('rail lands — colliders', () => {
  it('the roundhouse arc is FOUR deep chords, not many shallow plates (the drive-feel rule)', () => {
    const chords = layout.colliders.filter((c) => c.id.startsWith('roundhouse-chord-'));
    expect(chords.length).toBe(4);
    for (const c of chords) {
      // Radial depth = the shed's whole wall band, so the car meets one flat wall per bay group.
      expect(c.hz * 2).toBeCloseTo(layout.roundhouse.outerR - layout.roundhouse.innerR, 9);
      expect(c.yawRad).not.toBe(0);
    }
    // Neighbouring chords OVERLAP along the arc, so there is no sliver gap to wedge into.
    for (let i = 0; i + 1 < chords.length; i++) {
      const step = Math.abs(chords[i + 1].yawRad - chords[i].yawRad);
      const rMid = (layout.roundhouse.innerR + layout.roundhouse.outerR) / 2;
      expect(chords[i].hx).toBeGreaterThan(rMid * Math.sin(step / 2));
    }
  });

  it('every collider is a convex cuboid with positive extents, floored at y = 0', () => {
    for (const c of layout.colliders) {
      for (const h of [c.hx, c.hy, c.hz]) expect(h, c.id).toBeGreaterThan(0);
    }
    expect(layout.colliders.map((c) => c.owner).filter((o, i, a) => a.indexOf(o) === i).sort()).toEqual([
      'aquarium-block',
      'locomotive',
      'roundhouse',
    ]);
  });

  it('the locomotive stands ON the lead track, clear of the turntable deck', () => {
    const t = layout.turntable;
    expect(layout.locomotive.center.x).toBeCloseTo(t.cx, 9);
    expect(layout.locomotive.noseZ).toBeGreaterThan(t.cz + t.radius);
  });
});
