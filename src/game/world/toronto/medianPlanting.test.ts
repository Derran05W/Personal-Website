// PHASE 75 (T4) — THE MEDIAN PLANTING LAWS.
//
// The part file's median is "a raised planted strip: grass, low kerb visual, sparse trees/planters
// from the pack via the arbiter". T1 built the grass and the kerb; this file pins the four
// properties the planting on top of them has to keep, each of which is a real defect if it breaks:
//
//   1. GRASS UNDER EVERY TREE. A planting placed by a second derivation of "where is the median"
//      would drift the first time a setback moved and leave trees floating on bare asphalt at a
//      crossing. So the placer walks `roadStrips.medianBandRuns` — the same call roadPaint.ts
//      paints from — and every placement is asserted INSIDE an emitted grass segment, both axes.
//   2. NOTHING OVER A TRAVEL LANE. The pack tree's canopy is wider than the 2.2 wu strip; the
//      question is whether the overhang reaches a lane. Measured, not asserted by eye.
//   3. SPARSE, DERIVED. "Sparse" is pinned as a property of the FRAME (at most one tree in the
//      camera's visible ground band), not as a hand-picked pitch.
//   4. VISUAL-ONLY. The median carries no colliders by Phase 75's D2 drive-feel verdict, and a
//      solid trunk in the middle of Yonge would be strictly worse. Structurally, that is guaranteed
//      by the median planting being a DIFFERENT array from `trees` (which is the one CityDress
//      mounts trunk colliders from), so the disjointness is what gets asserted.

import { describe, expect, it } from 'vitest';
import { CAMERA, CAMERA_EYE_MIN_WU, CAMERA_GROUND_BAND_MAX_WU, cameraGroundBandWu } from '../../config/camera';
import { CAR_REF } from '../../config/cityPackScale';
import { MEDIAN_PLANTING, TREE_ROW } from '../../config/torontoDress';
import { LANE_OFFSET_WU, ROAD_MEDIAN } from '../../config/torontoMap';
import { composeWorld } from './composeWorld';
import { listIntersections } from './roadGraph';
import { medianBandRuns } from './roadStrips';
import { buildStreets, type Street } from './streets';

const SEEDS = [416, 7, 1337] as const;

const { streets } = buildStreets();
const intersections = listIntersections(streets);
const runs = medianBandRuns(streets, intersections);

/** map x/y of a world [x, y, z] placement (mapToWorld is the identity swap). */
function mapPointOf(position: readonly [number, number, number]): { x: number; y: number } {
  return { x: position[0], y: position[2] };
}

/** Which median run (if any) this placement stands on, by its perpendicular coordinate. */
function runFor(position: readonly [number, number, number]) {
  const p = mapPointOf(position);
  for (const run of runs) {
    const across = run.street.axis === 'ns' ? p.x : p.y;
    if (Math.abs(across - run.centre) <= run.half) return run;
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// 1. grass under every tree
// -------------------------------------------------------------------------------------------------

describe('median planting — every tree stands on emitted median grass', () => {
  it('the four median-carrying streets are the only ones with a band run at all', () => {
    expect(runs.map((r) => r.street.id).sort()).toEqual(['bloor', 'spadina', 'university', 'yonge']);
    for (const run of runs) expect(run.street.medianWidth, run.street.id).toBeGreaterThan(0);
  });

  it.each(SEEDS)('seed %d: every placement lies inside a grass segment, in BOTH axes', (seed) => {
    const items = composeWorld(seed).furniture.medianPlanting.items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const p = mapPointOf(item.position);
      const run = runFor(item.position);
      expect(run, `no median under ${JSON.stringify(item.position)}`).not.toBeNull();
      const street = run!.street;

      // ACROSS the strip: the tree's own ground footprint (the trunk — the arbiter's "claim the
      // trunk, not the canopy" convention, which is also what physically stands on the grass) must
      // fit inside the median half-width.
      const across = street.axis === 'ns' ? p.x : p.y;
      expect(Math.abs(across - run!.centre) + TREE_ROW.trunkHalfWidthWu, street.id).toBeLessThanOrEqual(run!.half);

      // ALONG the strip: the CANOPY (not just the trunk) must fit inside one emitted segment, so no
      // foliage hangs over a crossing's zebra band or past a terminus inset onto bare asphalt.
      const along = street.axis === 'ns' ? p.y : p.x;
      const inSegment = run!.segments.some(
        ([a, b]) => along - MEDIAN_PLANTING.canopyHalfWu >= a - 1e-9 && along + MEDIAN_PLANTING.canopyHalfWu <= b + 1e-9,
      );
      expect(inSegment, `${street.id} @ ${along} is outside every grass segment`).toBe(true);
    }
  });

  it.each(SEEDS)('seed %d: no tree lands on a street that carries no median', (seed) => {
    const items = composeWorld(seed).furniture.medianPlanting.items;
    const medianless: readonly Street[] = streets.filter((s) => s.medianWidth <= 0);
    for (const item of items) {
      const p = mapPointOf(item.position);
      for (const s of medianless) {
        const r = s.ribbon;
        const insideCentreThird = p.x > r.minX && p.x < r.maxX && p.y > r.minY && p.y < r.maxY;
        if (!insideCentreThird) continue;
        // Being inside a medianless ribbon is only legal where a MEDIAN street's own strip crosses
        // it — i.e. the placement's own run must be a different, perpendicular street.
        const own = runFor(item.position);
        expect(own?.street.axis, `${s.id} vs ${JSON.stringify(item.position)}`).not.toBe(s.axis);
      }
    }
  });
});

// -------------------------------------------------------------------------------------------------
// 2. nothing over a travel lane (the measured canopy law)
// -------------------------------------------------------------------------------------------------

describe('median planting — the canopy never reaches a travel lane', () => {
  // The tree is a pack model with a fixed resolved size; the lane is a derived offset. Both sides
  // of this inequality move on their own, so it is pinned rather than eyeballed once.
  it('the resolved canopy is WIDER than the strip — the fact this law exists to bound', () => {
    expect(MEDIAN_PLANTING.canopyHalfWu).toBeGreaterThan(ROAD_MEDIAN.widthWu.spine / 2);
  });

  it.each(['spine', 'artery'] as const)(
    '%s: canopy half-extent clears the nearest travel-lane flank',
    (cls) => {
      // A car centred on its lane occupies [laneOffset − carHalf, laneOffset + carHalf]; the flank
      // nearest the median is the lower bound. The canopy is centred on the centreline.
      const nearestLaneFlank = LANE_OFFSET_WU[cls] - CAR_REF.widthWu / 2;
      expect(MEDIAN_PLANTING.canopyHalfWu, cls).toBeLessThan(nearestLaneFlank);
    },
  );

  it('records the measured numbers so a retune that erases the margin fails loudly', () => {
    // Resolved tree 4.907 × 5.151 × 8.100 wu ⇒ circumscribed canopy half 2.575 (seeded spin, so the
    // conservative circumscribed extent is the honest one). Median half-width 1.10 ⇒ the foliage
    // overhangs the kerb by 1.475 wu of ASPHALT each side. Nearest lane flank: 4.95 (spine) /
    // 4.40 (artery) ⇒ clearance 2.37 / 1.82 wu.
    expect(MEDIAN_PLANTING.canopyHalfWu).toBeCloseTo(2.5755, 3);
    expect(MEDIAN_PLANTING.canopyHalfWu - ROAD_MEDIAN.widthWu.artery / 2).toBeCloseTo(1.4755, 3);
    expect(LANE_OFFSET_WU.artery - CAR_REF.widthWu / 2 - MEDIAN_PLANTING.canopyHalfWu).toBeCloseTo(1.8245, 3);
  });

  it('the canopy stands well below the resting camera eye (never an occluder of the eye-line class)', () => {
    expect(MEDIAN_PLANTING.heightWu).toBeLessThan(CAMERA_EYE_MIN_WU);
  });
});

// -------------------------------------------------------------------------------------------------
// 3. sparse, and derived
// -------------------------------------------------------------------------------------------------

describe('median planting — the sparsity law is derived from the frame, not picked', () => {
  it('the pitch is the visible ground band projected onto an axis-aligned street', () => {
    expect(MEDIAN_PLANTING.pitchWu).toBeCloseTo(CAMERA_GROUND_BAND_MAX_WU / Math.cos((CAMERA.yawDeg * Math.PI) / 180), 9);
  });

  it('the visible ground band is the deeper of the two envelope ends (not assumed monotonic)', () => {
    const rest = cameraGroundBandWu(CAMERA_EYE_MIN_WU, CAMERA.pitchDeg);
    expect(rest).toBeCloseTo(22.138, 2);
    expect(CAMERA_GROUND_BAND_MAX_WU).toBeCloseTo(28.035, 2);
    expect(CAMERA_GROUND_BAND_MAX_WU).toBeGreaterThanOrEqual(rest);
  });

  it('one tree per frame at most: the pitch is never shorter than the band it must out-space', () => {
    expect(MEDIAN_PLANTING.pitchWu).toBeGreaterThanOrEqual(CAMERA_GROUND_BAND_MAX_WU);
  });

  it('is sparser than the sidewalk tree rows (a median must not read as a wall)', () => {
    expect(MEDIAN_PLANTING.pitchWu).toBeGreaterThan(TREE_ROW.spacingWu);
  });

  it.each(SEEDS)('seed %d: consecutive trees within one grass segment are never closer than the pitch', (seed) => {
    const items = composeWorld(seed).furniture.medianPlanting.items;
    // Group by (street, segment), then check the realised step. Trees on OPPOSITE sides of a
    // crossing cut-out are deliberately not compared: the crossing itself is the gap there.
    const bySegment = new Map<string, number[]>();
    for (const item of items) {
      const run = runFor(item.position)!;
      const p = mapPointOf(item.position);
      const along = run.street.axis === 'ns' ? p.y : p.x;
      const segIndex = run.segments.findIndex(([a, b]) => along >= a && along <= b);
      const key = `${run.street.id}:${segIndex}`;
      const list = bySegment.get(key) ?? [];
      list.push(along);
      bySegment.set(key, list);
    }
    for (const [key, alongs] of bySegment) {
      const sorted = [...alongs].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i] - sorted[i - 1], `${key} step`).toBeGreaterThanOrEqual(MEDIAN_PLANTING.pitchWu - 1e-9);
      }
    }
  });

  it.each(SEEDS)('seed %d: stays under its map-wide cap', (seed) => {
    expect(composeWorld(seed).furniture.medianPlanting.items.length).toBeLessThanOrEqual(MEDIAN_PLANTING.capMapWide);
  });
});

// -------------------------------------------------------------------------------------------------
// 4. visual-only (no colliders) + the arbiter contract
// -------------------------------------------------------------------------------------------------

describe('median planting — visual-only, and sanctioned through the arbiter', () => {
  it.each(SEEDS)(
    'seed %d: shares no placement with `trees` — the collidered array CityDress mounts trunks from',
    (seed) => {
      const { furniture } = composeWorld(seed);
      const treeKeys = new Set(furniture.trees.items.map((t) => `${t.position[0]},${t.position[2]}`));
      expect(treeKeys.size).toBeGreaterThan(0);
      for (const m of furniture.medianPlanting.items) {
        expect(treeKeys.has(`${m.position[0]},${m.position[2]}`), JSON.stringify(m.position)).toBe(false);
      }
    },
  );

  it('renders through the same pack model as the street trees — the zero-draw-call condition', () => {
    // The layer is free in draw calls ONLY because cityPack/CityDress.tsx appends these placements
    // to the EXISTING `tree` BatchedMesh. If this id ever diverges, that stops being true and the
    // budget has to be re-measured, so the coupling is pinned rather than left as a comment.
    expect(MEDIAN_PLANTING.modelId).toBe('tree');
  });

  it.each(SEEDS)('seed %d: every placement is registered as exactly one `medianPlanting` claim', (seed) => {
    const world = composeWorld(seed);
    const claims = world.index.allClaims().filter((c) => c.kind === 'medianPlanting');
    expect(claims.length).toBe(world.furniture.medianPlanting.items.length);
    for (const c of claims) {
      expect(c.source).toBe('furniture');
      expect(c.blocking).toBe(true);
      // The claim is the TRUNK box, never the canopy.
      expect(c.aabb.maxX - c.aabb.minX).toBeCloseTo(2 * TREE_ROW.trunkHalfWidthWu, 9);
      expect(c.aabb.maxZ - c.aabb.minZ).toBeCloseTo(2 * TREE_ROW.trunkHalfWidthWu, 9);
    }
  });

  it.each(SEEDS)('seed %d: every claim really does sit inside a street ribbon (the sanction is exercised)', (seed) => {
    const world = composeWorld(seed);
    const claims = world.index.allClaims().filter((c) => c.kind === 'medianPlanting');
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) {
      const ribbons = world.index.queryRect(c.aabb, { kinds: new Set(['streetRibbon' as const]) });
      expect(ribbons.length, c.id).toBeGreaterThan(0);
    }
  });
});
