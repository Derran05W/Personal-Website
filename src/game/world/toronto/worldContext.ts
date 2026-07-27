// Phase 40 — THE SHARED WORLD PREFIX + the pre-loaded placement context.
//
// Before this module, frontage.ts, furniture.ts, infill.ts and parks.ts each independently called
// `buildStreets()` / `listIntersections()` / `buildDistricts()` / `buildNamedBuildings()` /
// `buildPlacesLayer()` / `buildParks()` and then hand-assembled their own exclusion composition
// (frontage.ts:565-570, furniture.ts:565-570, infill.ts:852-858 as they stood). That is the exact
// mechanism the `.planning/part-10-placement-integrity.md` audit blamed for gap 3 — furniture's
// composition silently omitted `parks.exclusions`, so trees landed inside park tree rings.
//
// There is now ONE assembler. This module builds the seed-independent world skeleton once and
// pre-loads a claim index with every ZONE claim and every seed-independent BLOCKING claim, in the
// declared pipeline order:
//
//     named / hero lots → places → parks → worldEdge
//
// Everything seed-dependent (frontage → venueDress → infill → furniture → lane closures) is
// composed on top of that by `composeWorld.ts`, which is the only module that runs the full
// pipeline. `createPlacementContext()` exists separately from composeWorld precisely so
// `buildFrontage(seed, tierParams)` can keep its exact standalone signature (debugBridge.ts and
// devPanel.tsx call it that way for venue lookups) while building its prefix through the SAME
// helper — one code path, no second-source drift.
//
// Pure TS: no three, no react, no rng, no fs at runtime. Deterministic and seed-independent by
// construction — every input here is a pure function of the street table.

import { colliderHalfExtents } from '../../config/cityPackScale';
import { BARRIER, SIDEWALK } from '../../config/torontoMap';
import {
  createClaimIndex,
  type Aabb,
  type ClaimIndex,
  type ClaimIndexView,
  type ClaimKind,
  type ClaimQuery,
} from './claimIndex';
import { crosswalkBands } from './crosswalks';
import { buildDistricts, type ResolvedDistrict } from './districts';
import { buildNamedBuildings, type NamedBuildings } from './namedBuildings';
import { buildParks, type ParksLayout } from './parks';
import { buildPlacesLayer, type PlacesLayer } from './placesLayer';
import { PLAYABLE_POLYGON } from './polygon';
import { ZONE_BOUNDARIES } from './projection';
import { listIntersections, type Intersection } from './roadGraph';
import { buildStreets, type MapRect, type Street } from './streets';
import { buildWorldEdge, type BarrierDressingKind, type WorldEdgeLayout } from './worldEdge';

// --- shapes -------------------------------------------------------------------------------------

/** The seed-independent world skeleton every placer reads. Built ONCE per composition. */
export interface WorldPrefix {
  readonly streets: readonly Street[];
  readonly intersections: readonly Intersection[];
  readonly districts: readonly ResolvedDistrict[];
  readonly named: NamedBuildings;
  readonly places: PlacesLayer;
  readonly parks: ParksLayout;
  readonly worldEdge: WorldEdgeLayout;
}

/** What a placer receives: the skeleton plus a READ-ONLY view of the claim index. Builders never
 * write claims themselves — composeWorld registers each layer's accepted output between layers,
 * which keeps the builders pure producers and keeps the ordering in exactly one place. */
export interface PlacementContext extends WorldPrefix {
  readonly index: ClaimIndexView;
}

/** The writable form composeWorld (and this module's own pre-load) holds. */
export interface WritablePlacementContext extends WorldPrefix {
  readonly index: ClaimIndex;
}

// --- helpers --------------------------------------------------------------------------------------

/** MapRect (map x/y) → Aabb (world x/z). mapToWorld is the identity swap, so this is a rename. */
export function rectToAabb(r: MapRect): Aabb {
  return { minX: r.minX, maxX: r.maxX, minZ: r.minY, maxZ: r.maxY };
}

/** The exclusion ZONES every building-class placer must clear: named-building footprints (which
 * include the two reserved hero lots by namedBuildings' own contract), places-layer storefront /
 * vibe footprints, and park rects. THIS SET REPLACES the three hand-maintained compositions. */
export const EXCLUSION_ZONE_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>([
  'namedExclusion',
  'placesExclusion',
  'parkRect',
]);

/** The one query every placer's "is this footprint already taken?" gate uses. Blocking claims are
 * physical objects; zone claims are handled separately and directionally (an on-road prop over a
 * ribbon is legal, a building is not). Always ask the INDEX (`overlapsAny`) rather than
 * materializing `rects()` and scanning: by the time furniture runs there are ~8k blocking claims,
 * and a linear scan per candidate is the difference between a bucket lookup and 16M AABB tests. */
export const BLOCKING_QUERY: ClaimQuery = { blocking: true };

/** Build the seed-independent skeleton. Each sub-builder is itself pure + deterministic (parks and
 * worldEdge are additionally memoized in their own modules), so this is cheap to call more than
 * once — but the whole point is that a composition calls it exactly once. */
export function buildWorldPrefix(): WorldPrefix {
  const { streets } = buildStreets();
  const intersections = listIntersections(streets);
  const districts = buildDistricts();
  const named = buildNamedBuildings();
  const places = buildPlacesLayer(named);
  const parks = buildParks();
  const worldEdge = buildWorldEdge();
  return { streets, intersections, districts, named, places, parks, worldEdge };
}

// --- world-edge dressing footprints ---------------------------------------------------------------

/**
 * Half-extents of one world-edge dressing piece, resolved through its yaw. Every ring yaw is
 * axis-aligned (`atan2(inwardX, inwardZ)` of an axis-aligned inward normal), and the yaw
 * convention puts the piece's LONG axis (local ±X) ALONG the edge — so a yaw whose local +X
 * points down world X gives (along, thick) and one that points down world Z gives (thick, along).
 */
function dressingHalfExtents(kind: BarrierDressingKind, yawRad: number): { hx: number; hz: number } {
  let along: number;
  let thick: number;
  switch (kind) {
    case 'fencePiece': {
      const half = colliderHalfExtents(BARRIER.packModelIds.fencePiece);
      along = half.hx;
      thick = half.hz;
      break;
    }
    case 'cone': {
      const half = colliderHalfExtents(BARRIER.packModelIds.cone);
      along = half.hx;
      thick = half.hz;
      break;
    }
    case 'hoardingPanel':
      along = BARRIER.hoarding.panelWidthWu / 2;
      thick = BARRIER.hoarding.panelThicknessWu / 2;
      break;
    case 'railPost':
      along = BARRIER.rail.postWidthWu / 2;
      thick = BARRIER.rail.postWidthWu / 2;
      break;
    case 'jerseyBarrier':
      along = BARRIER.jersey.lengthWu / 2;
      thick = BARRIER.jersey.widthWu / 2;
      break;
  }
  // local +X in world = (cos yaw, −sin yaw). |cos| ≈ 1 ⇒ the run is along world X.
  const alongIsX = Math.abs(Math.cos(yawRad)) > 0.5;
  return alongIsX ? { hx: along, hz: thick } : { hx: thick, hz: along };
}

// --- the pre-loaded context ------------------------------------------------------------------------

/**
 * Build the world prefix AND a claim index pre-loaded with the whole seed-independent layer, in
 * pipeline order. This is the shared entry point: `composeWorld()` calls it and then threads the
 * seed-dependent builders through the same index; `buildFrontage(seed, tierParams)` calls it to
 * synthesize the identical prefix when invoked standalone.
 *
 * Registration order (= claim ordinal order, which is what makes every query deterministic):
 *   1. street ribbons + sidewalk bands + crosswalk bands + the water band   (ZONE)
 *   2. named-building exclusion rects (hero lots included)                  (ZONE)
 *   3. named-building boxes                                                 (BLOCKING, building)
 *   4. places-layer exclusion rects                                         (ZONE)
 *   5. park rects                                                           (ZONE)
 *   6. world-edge barrier boxes + dressing + notch cones                    (BLOCKING)
 */
export function createPlacementContext(): WritablePlacementContext {
  const prefix = buildWorldPrefix();
  const index = createClaimIndex();

  // 1) Street zones. The sidewalk band is the ribbon inflated by SIDEWALK.widthWu — the same
  // "buildings clear the road AND the walk" band infill.ts computed for itself.
  for (const street of prefix.streets) {
    index.register({
      id: `ribbon:${street.id}`,
      kind: 'streetRibbon',
      source: 'streets',
      aabb: rectToAabb(street.ribbon),
    });
  }
  for (const street of prefix.streets) {
    const r = street.ribbon;
    index.register({
      id: `sidewalk:${street.id}`,
      kind: 'sidewalkBand',
      source: 'streets',
      aabb: {
        minX: r.minX - SIDEWALK.widthWu,
        maxX: r.maxX + SIDEWALK.widthWu,
        minZ: r.minY - SIDEWALK.widthWu,
        maxZ: r.maxY + SIDEWALK.widthWu,
      },
    });
  }
  for (const band of crosswalkBands(prefix.intersections)) {
    index.register({
      id: `crosswalk:${band.intersectionIndex}:${band.side}`,
      kind: 'crosswalkBand',
      source: 'streets',
      aabb: { minX: band.minX, maxX: band.maxX, minZ: band.minZ, maxZ: band.maxZ },
    });
  }
  // The lake band: the polygon's full X range south of the shore line. Nothing land-based may
  // reach it (every placer's own `fp.maxZ >= WATER_Z` gate says so); registered so the arbiter
  // carries the whole gating picture rather than half of it.
  const polyXs = PLAYABLE_POLYGON.map((v) => v.x);
  index.register({
    id: 'water-band',
    kind: 'waterBand',
    source: 'world',
    aabb: {
      minX: Math.min(...polyXs),
      maxX: Math.max(...polyXs),
      minZ: ZONE_BOUNDARIES[3],
      maxZ: ZONE_BOUNDARIES[4],
    },
  });

  // 2/3) Named landmarks: their exclusion rects gate placement (hero lots arrive inside this set
  // — see namedBuildings.ts's `exclusions` contract), their BOXES are real building volumes the
  // camera clips against. Named boxes carry `fadeKey: null`: they fade through occlusionFade.ts's
  // material-opacity path, and the dither pass must skip them or the two would fight (Phase 36).
  prefix.named.exclusions.forEach((rect, i) => {
    index.register({
      id: `named-exclusion:${i}`,
      kind: 'namedExclusion',
      source: 'named',
      aabb: rectToAabb(rect),
    });
  });
  for (const placement of prefix.named.placements) {
    placement.boxes.forEach((box, i) => {
      index.register({
        id: `named:${placement.id}:${i}`,
        kind: 'namedBuilding',
        source: 'named',
        owner: `named:${placement.id}`,
        aabb: { minX: box.cx - box.hx, maxX: box.cx + box.hx, minZ: box.cz - box.hz, maxZ: box.cz + box.hz },
        yRange: [0, 2 * box.hy],
        fadeKey: null,
      });
    });
  }

  // 4) Places layer.
  prefix.places.exclusions.forEach((rect, i) => {
    index.register({
      id: `places-exclusion:${i}`,
      kind: 'placesExclusion',
      source: 'places',
      aabb: rectToAabb(rect),
    });
  });

  // 5) Parks.
  // NOTE the ordinal in the claim id: parks.ts's own `park-${districtId}-${attempt}` ids are NOT
  // unique (two rects of one district can both land on attempt 0 — seed 416 has a duplicate
  // `park-genericDowntown-0`). Renaming them would churn the parks layout for no gameplay benefit,
  // so the arbiter namespaces by position in the layout instead and keeps the park id as the OWNER.
  prefix.parks.parks.forEach((park, i) => {
    index.register({
      id: `park:${i}:${park.id}`,
      kind: 'parkRect',
      source: 'parks',
      owner: `park:${park.id}`,
      aabb: rectToAabb(park),
    });
  });

  // 6) The world-edge ring (Phase 37). Its long barrier boxes, its visual dressing and its notch
  // cones are all real objects standing on the map, so every seed-dependent layer below gates on
  // them. Ring pieces are mutually SANCTIONED to overlap (claimIndex.isSanctionedOverlap's
  // worldEdge rule) — the dressing stands on the wall it dresses, by construction.
  for (const collider of prefix.worldEdge.colliders) {
    index.register({
      id: `barrier:${collider.edgeIndex}`,
      kind: 'barrier',
      source: 'worldEdge',
      owner: 'worldEdge:ring',
      aabb: { minX: collider.cx - collider.hx, maxX: collider.cx + collider.hx, minZ: collider.cz - collider.hz, maxZ: collider.cz + collider.hz },
      yRange: [0, BARRIER.colliderHeightWu],
    });
  }
  prefix.worldEdge.dressing.forEach((piece, i) => {
    const { hx, hz } = dressingHalfExtents(piece.kind, piece.yawRad);
    index.register({
      id: `edge-dressing:${i}`,
      // Cones are knockable spawn-pose props, not wall structure — they claim as 'cone', the same
      // kind lane-closure cones use, so one rule covers both populations.
      kind: piece.kind === 'cone' ? 'cone' : 'barrierDressing',
      source: 'worldEdge',
      owner: 'worldEdge:ring',
      aabb: { minX: piece.x - hx, maxX: piece.x + hx, minZ: piece.z - hz, maxZ: piece.z + hz },
    });
  });

  return { ...prefix, index };
}
