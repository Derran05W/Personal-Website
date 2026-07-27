/**
 * Phase 46 T2 (Part 11) — Fairmont Royal York v2, the second `namedGeometryBuilders` tenant.
 *
 * Same two kinds of assertion as unionStation.test.ts, and the second kind is the point:
 *   • BUDGETS — a ceiling AND a floor. A ceiling alone is passed just as happily by the old
 *     12-triangle flat-topped box, so the floor is what makes a silent revert fail.
 *   • VERTEX PROBES — the geometry is measured, not described. The roof really tops out at the
 *     DATA height (which is what makes the shrunk render box legal — heightLaw, the claims and
 *     the camera clip volumes all read the data box); dormers really stand proud on both
 *     camera-visible faces; the rooftop sign really rides the drum tier with real margin.
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { CAMERA_EYE_MIN_WU } from '../../config/camera';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { buildNamedBuildings } from './namedBuildings';
import { resolveNamedBespoke } from './namedGeometry';
import { namedSignCellAspect } from './namedSignage';
import { ROYAL_YORK_MAX_TRIS } from './royalYork';

const named = buildNamedBuildings();
const placement = named.placements.find((p) => p.id === 'fairmont-royal-york')!;
const dataBox = placement.boxes[0];
const bespoke = resolveNamedBespoke(named.placements).get('fairmont-royal-york')!;
const built = bespoke.buildGeometry();
const probes = bespoke.meta.probes;

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

// -------------------------------------------------------------------------------------------------
// budget
// -------------------------------------------------------------------------------------------------

describe('Royal York v2 — tri budget (Part 11 rule 2)', () => {
  it('stays inside its 600-tri budget, with a floor a plain box could never clear', () => {
    expect(ROYAL_YORK_MAX_TRIS).toBe(600);
    expect(built.parts.map((p) => p.id)).toEqual(['royal-york-roof']);
    expect(built.parts[0].triangles).toBe(built.triangles);
    expect(built.triangles).toBeLessThanOrEqual(ROYAL_YORK_MAX_TRIS);
    // THE FLOOR: v1 was a single 12-triangle flat-topped box. A regression that quietly reverted
    // the cornice, the tiers or the dormer rows would still pass every proportion pin below, so
    // the floor is a test too (unionStation.test.ts's idiom). Headroom above the measured count
    // is deliberate (a later phase can buy detail with it).
    expect(built.triangles).toBeGreaterThan(90);
    expect(built.triangles).toBe(positions(built.geometry).length / 9);
  });
});

// -------------------------------------------------------------------------------------------------
// the massing: data-height truth + the shortened render box + the tier stack
// -------------------------------------------------------------------------------------------------

describe('Royal York v2 — heights are the DATA row, not a new invention', () => {
  it('the roof tops out at EXACTLY the data height (hGame(124) × NAMED_HEIGHT_SCALE)', () => {
    const dataHeight = dataBox.hy * 2;
    expect(probes.dataHeight).toBeCloseTo(dataHeight, 12);
    expect(bespoke.meta.topY).toBeCloseTo(dataHeight, 12);
    // …and the mesh really reaches it: the tallest vertex IS the ridge top, to float precision.
    const maxY = Math.max(...verts.map((v) => v.y));
    expect(maxY).toBeCloseTo(dataHeight, 4);
  });

  it('crosses the eye line — which is WHY this mesh needs the generic occlusion registration', () => {
    // namedGeometry.ts's TorontoScene mount registers every bespoke mesh as an occludable
    // regardless of height; this just proves the number that makes it matter for THIS landmark
    // (heightLaw.test.ts's crosser list already pins fairmont-royal-york's data height at 22.18).
    expect(probes.dataHeight).toBeGreaterThan(CAMERA_EYE_MIN_WU);
  });

  it('the render box is the BODY height — 0.72 of the data height, same footprint', () => {
    expect(bespoke.renderBoxes).toHaveLength(1);
    const render = bespoke.renderBoxes[0];
    expect(render.hy * 2).toBeCloseTo(probes.bodyTopY, 12);
    expect(probes.bodyTopY / probes.dataHeight).toBeCloseTo(0.72, 6);
    expect([render.cx, render.cz, render.hx, render.hz]).toEqual([dataBox.cx, dataBox.cz, dataBox.hx, dataBox.hz]);
    expect(render.look).toEqual(dataBox.look);
  });

  it('the eave cornice + three tiers cover the whole span above the render box, in order', () => {
    expect(probes.roofBaseY).toBeGreaterThan(probes.bodyTopY); // the cornice
    expect(probes.tier1TopY).toBeGreaterThan(probes.roofBaseY); // tier 1
    expect(probes.tier2TopY).toBeGreaterThan(probes.tier1TopY); // tier 2
    expect(probes.dataHeight).toBeGreaterThan(probes.tier2TopY); // tier 3 spans the rest to the ridge
  });

  it('each tier is narrower than (or equal to) the one below it — a real setback silhouette', () => {
    expect(probes.tier1TopHalfX).toBeLessThan(dataBox.hx);
    expect(probes.tier1TopHalfZ).toBeLessThan(dataBox.hz);
    expect(probes.tier3TopHalfX).toBeLessThan(probes.tier1TopHalfX);
    expect(probes.tier3TopHalfZ).toBeLessThan(probes.tier1TopHalfZ);
    expect(probes.tier3TopHalfX).toBeGreaterThan(0); // a real flat ridge plaza, never a degenerate point
    expect(probes.tier3TopHalfZ).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------------
// the researched dormer rows
// -------------------------------------------------------------------------------------------------

describe('Royal York v2 — the researched dormer rows', () => {
  it('carries a dormer row on both camera-visible faces', () => {
    expect(probes.dormerCountSouth).toBeGreaterThan(0);
    expect(probes.dormerCountEast).toBeGreaterThan(0);
  });

  it('every dormer clears the thin-geometry floor (a to-scale dormer would strobe)', () => {
    expect(2 * probes.dormerHalfWidthWu).toBeGreaterThanOrEqual(THIN_GEOMETRY.minStripeWidthWu);
  });

  it('the dormer row stands above the eave cornice and stays inside tier 1 (never crosses into tier 2)', () => {
    expect(probes.dormerRowY0).toBeGreaterThan(probes.roofBaseY);
    expect(probes.dormerRowY1).toBeGreaterThan(probes.dormerRowY0);
    expect(probes.dormerRowY1).toBeLessThan(probes.tier1TopY);
  });

  it('south dormers really stand proud of the slope on the +Z face — one distinct cluster per dormer', () => {
    // Same clustering idiom as unionStation.test.ts's column probe: at the dormer band's Y range,
    // the only geometry OUTSIDE the tier-1 footprint at that height is the dormers themselves.
    const xs = [
      ...new Set(
        verts
          .filter((v) => v.y >= probes.dormerRowY0 - 1e-3 && v.y <= probes.dormerRowY1 + 1e-3 && v.z > probes.southRowZ + 1e-3)
          .map((v) => Math.round(v.x * 1000) / 1000),
      ),
    ].sort((a, b) => a - b);
    const clusters: number[][] = [];
    for (const x of xs) {
      const last = clusters[clusters.length - 1];
      if (last !== undefined && x - last[last.length - 1] <= 2 * probes.dormerHalfWidthWu) last.push(x);
      else clusters.push([x]);
    }
    expect(clusters).toHaveLength(probes.dormerCountSouth);
  });

  it('east dormers really stand proud of the slope on the +X face — one distinct cluster per dormer', () => {
    const zs = [
      ...new Set(
        verts
          .filter((v) => v.y >= probes.dormerRowY0 - 1e-3 && v.y <= probes.dormerRowY1 + 1e-3 && v.x > probes.eastRowX + 1e-3)
          .map((v) => Math.round(v.z * 1000) / 1000),
      ),
    ].sort((a, b) => a - b);
    const clusters: number[][] = [];
    for (const z of zs) {
      const last = clusters[clusters.length - 1];
      if (last !== undefined && z - last[last.length - 1] <= 2 * probes.dormerHalfWidthWu) last.push(z);
      else clusters.push([z]);
    }
    expect(clusters).toHaveLength(probes.dormerCountEast);
  });

  it('carries both the limestone (dormer) and copper-patina (roof) colour families', () => {
    const colors = built.geometry.getAttribute('color').array as Float32Array;
    // Limestone reads warmer (R > B); copper-green reads the opposite (G is the dominant/tied
    // channel). Both families must be present — a crude but decisive channel split, robust to the
    // baked directional shade (a uniform per-vertex scalar can't change which channel is largest).
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
// the rooftop neon wordmark
// -------------------------------------------------------------------------------------------------

describe('Royal York v2 — the rooftop neon wordmark', () => {
  it('carries exactly the south+east pair on the royal-york-neon cell (no north — no true-facade exception here)', () => {
    const faces = bespoke.signQuads.map((q) => q.face).sort();
    expect(faces).toEqual(['east', 'south']);
    for (const quad of bespoke.signQuads) expect(quad.cell).toBe('royal-york-neon');
  });

  it("every quad's height/width ratio matches the atlas cell aspect (never hand-typed)", () => {
    for (const quad of bespoke.signQuads) {
      expect(quad.heightWu / quad.widthWu).toBeCloseTo(namedSignCellAspect('royal-york-neon'), 9);
    }
  });

  it('sits inside the tier-2 drum band with real margin, and never pokes above the ridge (topY)', () => {
    for (const quad of bespoke.signQuads) {
      const top = quad.position[1] + quad.heightWu / 2;
      const bottom = quad.position[1] - quad.heightWu / 2;
      expect(bottom, quad.id).toBeGreaterThan(probes.tier1TopY);
      expect(top, quad.id).toBeLessThan(probes.tier2TopY);
      expect(top, quad.id).toBeLessThan(probes.dataHeight);
      // Real margin, not a hairline pass — at least 5% of the tier-2 band clear on the top side.
      expect(probes.tier2TopY - top).toBeGreaterThan(0.05 * probes.signHeightBudget);
    }
  });

  it('both bands stand PROUD of the drum wall they ride', () => {
    const south = bespoke.signQuads.find((q) => q.face === 'south')!;
    const east = bespoke.signQuads.find((q) => q.face === 'east')!;
    expect(south.position[2]).toBeGreaterThan(dataBox.cz + probes.tier1TopHalfZ);
    expect(east.position[0]).toBeGreaterThan(dataBox.cx + probes.tier1TopHalfX);
  });

  it('both bands are vertically centred on the same Y (the drum band centre)', () => {
    for (const quad of bespoke.signQuads) expect(quad.position[1]).toBeCloseTo(probes.signY, 9);
  });
});

// -------------------------------------------------------------------------------------------------
// claims / colliders / determinism
// -------------------------------------------------------------------------------------------------

describe('Royal York v2 — no extra claim or collider (the roof stays inside the data box)', () => {
  it('extraClaims and extraColliders are both empty', () => {
    expect(bespoke.extraClaims).toEqual([]);
    expect(bespoke.extraColliders).toEqual([]);
  });
});

describe('Royal York v2 — determinism', () => {
  it('rebuilds byte-identically', () => {
    const again = resolveNamedBespoke(named.placements).get('fairmont-royal-york')!.buildGeometry();
    for (const name of ['position', 'normal', 'color']) {
      expect(Array.from(again.geometry.getAttribute(name).array as Float32Array)).toEqual(
        Array.from(built.geometry.getAttribute(name).array as Float32Array),
      );
    }
    expect(again.parts).toEqual(built.parts);
  });

  it('derives every dimension from the placement alone (no literal world coordinates)', () => {
    // The tripwire for the P27 literal-drift class: resolved a second time from scratch, every
    // derived edge must land in the same place.
    const viaFresh = resolveNamedBespoke(buildNamedBuildings().placements).get('fairmont-royal-york')!;
    expect(viaFresh.meta.probes).toEqual(probes);
  });
});
