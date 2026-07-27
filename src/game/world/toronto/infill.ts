// Toronto map v2 — Phase 28 "Infill" (D3-D7): back-lot second row, laneway clutter, parking
// lots, construction sites, lane closures. Companion to frontage.ts (which owns D1 corner-fill
// and D2 blank-tint variety directly, since those extend its own street-walk/candidate-lattice
// machinery). This module EXTENDS frontage.ts's reject-never-relocate rect-overlap family
// (overlaps/insidePolygon/thinToCap, all imported from there — never re-implemented) rather than
// inventing a parallel mechanism, per CLAUDE.md.
//
// PLACEMENT ORDER (builder brief, not the D-number order): construction sites reserve interior
// lots FIRST (first pick of the big interiors), then the back-lot second row, then parking lots,
// then laneway clutter, then lane closures — each later layer rejects against every earlier one's
// footprints, on top of the shared ribbon/exclusion/water/polygon gates every layer already uses.
// D11 (deep-interior scatter) runs LAST of all: a seeded, low-density scatter of tree clusters +
// rare greenhouse/pile garnish for the block interiors sitting well beyond every street-hugging
// layer's reach (CLAUDE.md user directive: "less open land") — see torontoDress.ts's DEEP_SCATTER
// doc comment for the full rationale.
//
// Pure TS: no three/react. A separate mounting layer (world/toronto/cityPack/CityDress.tsx) turns
// this into batched meshes + colliders, reusing the SAME per-model-batched + fixed-cuboid seam
// frontage.ts's FrontageSlot/PlacedBox already established (`FixedPackInstances`/`BackdropTowers`)
// plus a generic colliderless-decor renderer and the generalized dynamic-body renderer
// (ParkedVehicles.tsx, reused for lane-closure cones with a different mass/damping spec).

import { colliderHalfExtents, resolveCityPackScale } from '../../config/cityPackScale';
import { SURFACE_ANCHOR } from '../../config/layering';
import {
  BACKLOT,
  CONSTRUCTION,
  DEEP_SCATTER,
  LANE_CLOSURE,
  LANEWAY,
  LANEWAY_MODELS,
  PARKING_LOT,
  TORONTO_TIER_IDENTITY,
  TREE_ROW,
  type TorontoTierParams,
} from '../../config/torontoDress';
import { getCityPackModel } from '../../assets/cityPackManifest';
import { TORONTO_DISTRICTS, type DistrictDensity, type DistrictId, type TorontoDistrictDef } from '../../config/torontoDistricts';
import { SIDEWALK } from '../../config/torontoMap';
import { neutralVehicleModelId } from '../../config/carVariety';
import { createCarVarietySequencer } from '../../vehicles/carVariety';
import { createRng, type Rng } from '../rng';
import { aabbAround, footprintHalfExtents, overlaps, type Aabb, type ClaimKind, type ClaimQuery } from './claimIndex';
import { districtAt, type ResolvedDistrict } from './districts';
import { hGame } from './heightCurve';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { ZONE_BOUNDARIES, type MapPoint } from './projection';
import { type Intersection } from './roadGraph';
import { type Street } from './streets';
import {
  frontageRotationY,
  insidePolygon,
  pickModel,
  pickTint,
  thinToCap,
  worldHalfExtents,
  type BackdropBox,
} from './frontage';
import { BLOCKING_QUERY, EXCLUSION_ZONE_KINDS, type PlacementContext } from './worldContext';

const DISTRICT_ORDER: readonly DistrictId[] = TORONTO_DISTRICTS.map((d) => d.id);
const WATER_Z = ZONE_BOUNDARIES[3];

// --- output shapes -----------------------------------------------------------------------------

/** A fixed-collider pack placement (see PlacedBox in frontage.ts — this is a structural superset
 * carrying an id + districtId for counts/debug; CityDress.tsx's renderer only reads the
 * PlacedBox-shaped fields). */
export interface FixedInfillItem {
  readonly id: string;
  readonly modelId: string;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly tint: string;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly districtId: DistrictId;
}

/** A colliderless decorative placement (laneway clutter, construction cones/road-bits/floor-hole/
 * box/debris-papers, lane-closure road-bits plates). */
export interface DecorPlacement {
  readonly modelId: string;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly districtId: DistrictId;
}

/** A lane-closure cone — DYNAMIC sleeping body (knockable), rendered via the generalized
 * ParkedVehicles.tsx renderer with LANE_CLOSURE.coneBody instead of PARKED.body. */
export interface DynamicConeSpec {
  readonly modelId: 'cone';
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
}

export interface InfillLayout {
  /** Back-lot pack buildings + parking-lot cars + construction/parking fence+dumpster+billboard —
   * everything that gets a fixed BUILDING-group cuboid collider. */
  readonly fixed: readonly FixedInfillItem[];
  /** Back-lot extruded boxes (rendered via the same box path as frontage.ts's backdrop towers). */
  readonly boxes: readonly BackdropBox[];
  /** Laneway clutter + construction decor props + lane-closure road-bits plates. Colliderless. */
  readonly decor: readonly DecorPlacement[];
  /** Lane-closure cones — dynamic, knockable. */
  readonly cones: readonly DynamicConeSpec[];
  /** category -> count, for tests + the verification dump. */
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Phase 40 — the infill layer MINUS lane closures. The composition splits here because the two
 * halves sit on opposite sides of furniture in the pipeline: everything below reserves interior
 * lots and back rows that furniture must then avoid, while LANE CLOSURES must avoid furniture's
 * street-parked cars + manhole covers (the audit's gap 4 — `buildLaneClosures` was the one
 * gate-less signature in the module). The split is rng-neutral: every pass draws from its own
 * `base.fork(name)` stream, and `fork` is seeded by label, never by call order.
 */
export interface InfillMain {
  readonly fixed: readonly FixedInfillItem[];
  readonly boxes: readonly BackdropBox[];
  readonly decor: readonly DecorPlacement[];
  /** Reserved construction-site lot rects (their fixtures/decor legitimately sit inside them). */
  readonly constructionLots: readonly Aabb[];
  /** Reserved parking-lot rects (ditto for the fence run + the lot's cars). */
  readonly parkingLots: readonly Aabb[];
  /** The un-concatenated pass outputs, in the order they were produced. `fixed`/`decor` above are
   * exactly these concatenated; composeWorld reads the groups so it can register each family with
   * the right claim KIND and OWNER without re-parsing generator ids. */
  readonly groups: {
    readonly backlot: readonly FixedInfillItem[];
    readonly parking: readonly FixedInfillItem[];
    readonly construction: readonly FixedInfillItem[];
    readonly scatterFixed: readonly FixedInfillItem[];
    readonly laneway: readonly DecorPlacement[];
    readonly constructionDecor: readonly DecorPlacement[];
    readonly scatterDecor: readonly DecorPlacement[];
  };
  readonly counts: Readonly<Record<string, number>>;
}

/** Phase 40 — the lane-closure half, built AFTER furniture. */
export interface LaneClosureLayer {
  readonly cones: readonly DynamicConeSpec[];
  readonly decor: readonly DecorPlacement[];
  /** How many closure sites actually placed anything (≤ the rolled count). */
  readonly siteCount: number;
}

// --- shared geometry helpers ---------------------------------------------------------------------

function aabbFromCenterHalf(p: MapPoint, hx: number, hz: number): Aabb {
  return { minX: p.x - hx, maxX: p.x + hx, minZ: p.y - hz, maxZ: p.y + hz };
}

function rejectsAny(fp: Aabb, lists: readonly (readonly Aabb[])[]): boolean {
  return lists.some((list) => list.some((r) => overlaps(fp, r)));
}

/**
 * Phase 40 — the arbiter gate every pass in this module now carries alongside its own `gates`
 * lists. It answers "has ANY earlier layer already claimed this footprint?" through the claim
 * index's bucket grid: at infill time that is the named-building boxes, the whole world-edge
 * barrier ring, the frontage streetwall + corner fills + BACKDROP TOWERS, and the venue dressing
 * props. Three of those five families were previously unchecked here — infill only ever received a
 * hand-built list of frontage slots + corner fills.
 *
 * It is a PREDICATE rather than another `Aabb[]` on purpose: the ring alone contributes ~1.5k
 * rects and the streetwall ~1.4k, and these gates run inside the module's hottest loops.
 */
type BlockedFn = (fp: Aabb) => boolean;

function passesCommonGates(fp: Aabb): boolean {
  if (fp.maxZ >= WATER_Z) return false;
  if (!insidePolygon(fp)) return false;
  return true;
}

function polygonBBox(): Aabb {
  const xs = PLAYABLE_POLYGON.map((v) => v.x);
  const ys = PLAYABLE_POLYGON.map((v) => v.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...ys), maxZ: Math.max(...ys) };
}

/** Point at `along` a street's own axis, offset `perpWu` perpendicular to the centreline
 * (positive = the street's +x/+y side) — the same convention furniture.ts's pointAlong uses. */
function pointAlongStreet(street: Street, along: number, perpWu: number): MapPoint {
  if (street.axis === 'ns') return { x: street.centerline + perpWu, y: along };
  return { x: along, y: street.centerline + perpWu };
}

/** Deterministic full-turn spin for radially-symmetric decor props. */
function seededSpin(rng: Rng): number {
  return rng.next() * Math.PI * 2;
}

// --- D6: construction sites (reserved FIRST) -----------------------------------------------------

interface SiteCandidate {
  readonly rect: Aabb;
  readonly districtId: DistrictId;
}

interface ScanConfig {
  readonly scanStrideWu: number;
  readonly footprintHalfRangeWu: { readonly hx: readonly [number, number]; readonly hz: readonly [number, number] };
  readonly keepProbability: number;
  readonly capMapWide: number;
}

/**
 * Shared grid-scatter-then-reject engine for construction sites + parking lots (D5/D6): scans the
 * polygon's bounding box on a coarse deterministic grid (row-major, seeded per-cell jitter), rolls
 * a footprint size + keep probability, and rejects (never relocates) against every gate list
 * passed in (ribbons, exclusions, and whatever earlier layers' footprints the caller wants this
 * layer to avoid). No explicit "interior depth" measurement — the geometry gates are what keep a
 * candidate honest (a site that would straddle a ribbon or another reserved lot is simply
 * skipped), same posture as frontage.ts's backdrop towers / corner fill.
 */
function scanForSites(
  cfg: ScanConfig,
  districts: readonly ResolvedDistrict[],
  gates: readonly (readonly Aabb[])[],
  blocked: BlockedFn,
  base: Rng,
  densityScalar: number,
): readonly SiteCandidate[] {
  const bbox = polygonBBox();
  const kept: SiteCandidate[] = [];
  const keptFootprints: Aabb[] = [];
  // Phase 25.8-style tier seam (D8): a lower dressDensityScalar widens the scan stride (coarser
  // grid → fewer candidates → fewer lots), the same "divide the base spacing" idiom furniture.ts's
  // buildRow uses for its row-spacing categories.
  const stride = cfg.scanStrideWu / densityScalar;
  let row = 0;
  for (let z = bbox.minZ + stride / 2; z < bbox.maxZ; z += stride, row++) {
    let col = 0;
    for (let x = bbox.minX + stride / 2; x < bbox.maxX; x += stride, col++) {
      const rng = base.fork(`scan:${row}:${col}`);
      const jx = x + (rng.next() * 2 - 1) * stride * 0.3;
      const jz = z + (rng.next() * 2 - 1) * stride * 0.3;
      const [hxLo, hxHi] = cfg.footprintHalfRangeWu.hx;
      const [hzLo, hzHi] = cfg.footprintHalfRangeWu.hz;
      const hx = hxLo + rng.next() * (hxHi - hxLo);
      const hz = hzLo + rng.next() * (hzHi - hzLo);
      const p: MapPoint = { x: jx, y: jz };
      const fp = aabbFromCenterHalf(p, hx, hz);
      if (!passesCommonGates(fp)) continue;
      if (rejectsAny(fp, gates)) continue;
      if (blocked(fp)) continue;
      if (keptFootprints.some((r) => overlaps(fp, r))) continue;
      if (rng.next() >= cfg.keepProbability) continue;
      const def = districtAt(p, districts);
      if (!def) continue;
      keptFootprints.push(fp);
      kept.push({ rect: fp, districtId: def.id });
    }
  }
  return thinToCap(kept, cfg.capMapWide);
}

/** A sparse fence run along a rect's south edge only (the §5.3 camera's reliably-visible side —
 * the same "author the two visible faces" convention CROWN decals/venue fascia already use):
 * up to `segments` `fence` panels, PITCHED by their own resolved width + a fixed gap so adjacent
 * panels never touch (the panel count is clamped to whatever actually fits the rect's width, never
 * assumed). Fixed BUILDING-group collider per panel (D6/D5: "colliders only on the dumpster + fence
 * run"). No corner fence-end caps — a run of plain panels reads as "fenced off" without the
 * corner-clearance bookkeeping a mitred end-piece would need. */
function southFenceRun(rect: Aabb, districtId: DistrictId, idPrefix: string, segments: number): FixedInfillItem[] {
  const fenceHalf = colliderHalfExtents('fence');
  const cz = rect.maxZ;
  const panelW = fenceHalf.hx * 2;
  const gapWu = 0.3;
  const pitch = panelW + gapWu;
  const availableWidth = rect.maxX - rect.minX;
  const n = Math.max(1, Math.min(segments, Math.floor(availableWidth / pitch)));
  const totalRun = pitch * (n - 1) + panelW;
  const firstCenterX = rect.minX + (availableWidth - totalRun) / 2 + panelW / 2;
  const out: FixedInfillItem[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `${idPrefix}-fence-${i}`,
      modelId: 'fence',
      position: [firstCenterX + pitch * i, 0, cz],
      rotationY: 0,
      tint: '#ffffff',
      hx: fenceHalf.hx,
      hy: fenceHalf.hy,
      hz: fenceHalf.hz,
      districtId,
    });
  }
  return out;
}

function scatterInRect(rect: Aabb, rng: Rng, marginWu: number): MapPoint {
  const w = Math.max(0.01, rect.maxX - rect.minX - 2 * marginWu);
  const d = Math.max(0.01, rect.maxZ - rect.minZ - 2 * marginWu);
  return { x: rect.minX + marginWu + rng.next() * w, y: rect.minZ + marginWu + rng.next() * d };
}

function buildConstructionSite(site: SiteCandidate, idPrefix: string, base: Rng, propScale: number): { fixed: FixedInfillItem[]; decor: DecorPlacement[] } {
  const rng = base.fork(idPrefix);
  const { rect, districtId } = site;
  const fixed: FixedInfillItem[] = [...southFenceRun(rect, districtId, idPrefix, 4)];
  const decor: DecorPlacement[] = [];
  // Phase 25.8-style tier seam (D8): low tier halves props-per-site (propScale=0.5) — the fence
  // run + dumpster (structural, "this site is closed off") stay at every tier; only the loose
  // decor count thins.
  const clusterCount = Math.max(1, Math.round(2 * propScale));
  const scatterCount = Math.max(1, Math.round(3 * propScale));

  // Dumpster (fixed collider) — deterministically near the SE interior corner (a small seeded
  // jitter for variety, never the whole rect) so it stays well clear of the billboard's NW corner.
  const dumpsterHalf = colliderHalfExtents('dumpster');
  const dumpsterRng = rng.fork('dumpster-pos');
  const dp: MapPoint = {
    x: rect.maxX - dumpsterHalf.hx - 0.5 - dumpsterRng.next() * 1.5,
    y: rect.maxZ - dumpsterHalf.hz - 0.5 - dumpsterRng.next() * 1.5,
  };
  const dumpsterFp = aabbFromCenterHalf(dp, dumpsterHalf.hx, dumpsterHalf.hz);
  fixed.push({
    id: `${idPrefix}-dumpster`,
    modelId: 'dumpster',
    position: [dp.x, 0, dp.y],
    rotationY: seededSpin(rng),
    tint: '#ffffff',
    hx: dumpsterHalf.hx,
    hy: dumpsterHalf.hy,
    hz: dumpsterHalf.hz,
    districtId,
  });

  // Seeded-subset billboard (fixed collider) near the NW interior corner — skipped (defense in
  // depth) on the rare small site where it would still reach the dumpster's corner.
  if (rng.next() < CONSTRUCTION.billboardFraction) {
    const bbHalf = colliderHalfExtents('billboard');
    const bp: MapPoint = { x: rect.minX + bbHalf.hx + 1, y: rect.minZ + bbHalf.hz + 1 };
    const bbFp = aabbFromCenterHalf(bp, bbHalf.hx, bbHalf.hz);
    if (!overlaps(bbFp, dumpsterFp)) {
      fixed.push({
        id: `${idPrefix}-billboard`,
        modelId: 'billboard',
        position: [bp.x, 0, bp.y],
        rotationY: 0,
        tint: '#ffffff',
        hx: bbHalf.hx,
        hy: bbHalf.hy,
        hz: bbHalf.hz,
        districtId,
      });
    }
  }

  // Cone clusters (decor, no collider).
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const clusterRng = rng.fork(`cones:${cluster}`);
    const center = scatterInRect(rect, clusterRng, 2);
    for (let i = 0; i < CONSTRUCTION.coneClusterSize; i++) {
      const jitterRng = clusterRng.fork(`cone:${i}`);
      const jx = center.x + (jitterRng.next() * 2 - 1) * 1.2;
      const jz = center.y + (jitterRng.next() * 2 - 1) * 1.2;
      decor.push({ modelId: 'cone', position: [jx, 0, jz], rotationY: 0, districtId });
    }
  }

  // Road-bits plate + floor-hole + a few boxes/debris-papers (decor, no collider).
  //
  // Phase 39 surface anchoring (config/layering.ts): this cluster sits on bare laneway ground,
  // and the two FLAT members of it (the road-bits plate, the debris-papers sheet at 0.003 wu
  // tall) were authored at y=0 — exactly coplanar with the merged ground quads, i.e. one of the
  // four audited z-fights. They now floor at SURFACE_ANCHOR.ground. The `box` scatter is a real
  // 3D prop with an invisible bottom face and stays at 0.
  const rb = scatterInRect(rect, rng.fork('road-bits'), 4);
  decor.push({
    modelId: 'road-bits',
    position: [rb.x, SURFACE_ANCHOR.ground, rb.y],
    rotationY: rng.next() < 0.5 ? 0 : Math.PI / 2,
    districtId,
  });
  // floor-hole DROPPED (Phase 39 keep-vs-drop screenshot call): proud, the 0.2 wu slab read
  // as a defect (the original audit item); sunk flush to SURFACE_ANCHOR.ground its top face
  // read as nothing at all — an aperture-less "hole" can't work on an opaque ground mesh.
  // Removal is seed-neutral: its scatter came from an independent rng.fork('floor-hole')
  // stream and its rotation was a constant, so no other placement shifts.
  for (let i = 0; i < scatterCount; i++) {
    const bp = scatterInRect(rect, rng.fork(`box:${i}`), 1.5);
    decor.push({ modelId: 'box', position: [bp.x, 0, bp.y], rotationY: seededSpin(rng.fork(`box-r:${i}`)), districtId });
  }
  for (let i = 0; i < scatterCount; i++) {
    const pp = scatterInRect(rect, rng.fork(`papers:${i}`), 1.5);
    decor.push({
      modelId: 'debris-papers',
      position: [pp.x, SURFACE_ANCHOR.ground, pp.y],
      rotationY: seededSpin(rng.fork(`papers-r:${i}`)),
      districtId,
    });
  }

  return { fixed, decor };
}

function buildConstructionSites(
  districts: readonly ResolvedDistrict[],
  gates: readonly (readonly Aabb[])[],
  blocked: BlockedFn,
  base: Rng,
  densityScalar: number,
  propScale: number,
): { sites: readonly SiteCandidate[]; fixed: FixedInfillItem[]; decor: DecorPlacement[] } {
  const sites = scanForSites(
    {
      scanStrideWu: CONSTRUCTION.scanStrideWu,
      footprintHalfRangeWu: CONSTRUCTION.footprintHalfRangeWu,
      keepProbability: CONSTRUCTION.keepProbability,
      capMapWide: CONSTRUCTION.capMapWide,
    },
    districts,
    gates,
    blocked,
    base.fork('construction-scan'),
    densityScalar,
  );
  const fixed: FixedInfillItem[] = [];
  const decor: DecorPlacement[] = [];
  sites.forEach((site, i) => {
    const one = buildConstructionSite(site, `construction:${i}`, base.fork(`construction-detail:${i}`), propScale);
    fixed.push(...one.fixed);
    decor.push(...one.decor);
  });
  return { sites, fixed, decor };
}

// --- D5: parking lots (reserved after construction, before laneway) -----------------------------

function buildParkingLot(site: SiteCandidate, idPrefix: string, base: Rng): { fixed: FixedInfillItem[] } {
  const rng = base.fork(idPrefix);
  const { rect, districtId } = site;
  const fixed: FixedInfillItem[] = [...southFenceRun(rect, districtId, idPrefix, 3)];

  const [loCount, hiCount] = PARKING_LOT.carsCountRange;
  const carCount = loCount + Math.floor(rng.next() * (hiCount - loCount + 1));
  // Phase 29 (D4): carVariety per lot car (own rng fork). Each car gets a weighted {model, colour};
  // the neutral-body variant renders the tint (via CityPackBatched's per-instance setColorAt) as a
  // true body colour, exactly like the street-parked cars.
  const variety = createCarVarietySequencer(rng.fork('carVariety'));
  // Two interior rows facing opposite directions, evenly spaced along X — a simple, readable
  // "parked in rows" read without needing real painted-stall geometry this phase.
  const usableW = Math.max(1, rect.maxX - rect.minX - 4);
  for (let i = 0; i < carCount; i++) {
    const v = variety.next();
    const modelId = neutralVehicleModelId(v.modelId);
    const half = colliderHalfExtents(modelId);
    const row = i % 2;
    const cx = rect.minX + 2 + (usableW * (i + 0.5)) / carCount;
    const cz = row === 0 ? rect.minZ + half.hz + 1.5 : rect.maxZ - half.hz - 4;
    const rotationY = row === 0 ? 0 : Math.PI;
    fixed.push({
      id: `${idPrefix}-car-${i}`,
      modelId,
      position: [cx, 0, cz],
      rotationY,
      tint: v.colorHex,
      hx: half.hx,
      hy: half.hy,
      hz: half.hz,
      districtId,
    });
  }
  return { fixed };
}

function weightedPick(rng: Rng, entries: readonly { readonly id: string; readonly weight: number }[]): string {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  let r = rng.next() * total;
  for (const e of entries) {
    r -= e.weight;
    if (r <= 0) return e.id;
  }
  return entries[entries.length - 1].id;
}

function buildParkingLots(
  districts: readonly ResolvedDistrict[],
  gates: readonly (readonly Aabb[])[],
  blocked: BlockedFn,
  base: Rng,
  densityScalar: number,
): { lots: readonly SiteCandidate[]; fixed: FixedInfillItem[] } {
  const lots = scanForSites(
    {
      scanStrideWu: PARKING_LOT.scanStrideWu,
      footprintHalfRangeWu: PARKING_LOT.footprintHalfRangeWu,
      keepProbability: PARKING_LOT.keepProbability,
      capMapWide: PARKING_LOT.capMapWide,
    },
    districts,
    gates,
    blocked,
    base.fork('parking-scan'),
    densityScalar,
  );
  const fixed: FixedInfillItem[] = [];
  lots.forEach((lot, i) => {
    const one = buildParkingLot(lot, `parking:${i}`, base.fork(`parking-detail:${i}`));
    fixed.push(...one.fixed);
  });
  return { lots, fixed };
}

// --- D3: back-lot second row --------------------------------------------------------------------

function buildBacklotRow(
  streets: readonly Street[],
  districts: readonly ResolvedDistrict[],
  gates: readonly (readonly Aabb[])[],
  blocked: BlockedFn,
  base: Rng,
  densityScalar: number,
): { packItems: readonly FixedInfillItem[]; boxes: readonly BackdropBox[] } {
  const packItems: FixedInfillItem[] = [];
  const boxes: BackdropBox[] = [];
  // ONE shared kept-footprint list for BOTH pack buildings and boxes — they must reject against
  // each other too (a pack building and a box rolled at nearby along-positions, or on two
  // perpendicular streets meeting near a corner, can otherwise land on top of one another).
  const kept: Aabb[] = [];
  let counter = 0;
  const pitch = BACKLOT.pitchWu / densityScalar;

  for (const street of streets) {
    for (const side of [1, -1] as const) {
      const rowRng = base.fork(`${street.id}:${side}`);
      const [lo, hi] = street.span;
      for (let along = lo + pitch / 2; along < hi; along += pitch) {
        const cellRng = rowRng.fork(along.toFixed(1));
        const refPerp = (street.halfWidth + SIDEWALK.widthWu + BACKLOT.assumedFrontageDepthWu + BACKLOT.setbackFromFrontageRearWu + 3) * side;
        const refPoint = pointAlongStreet(street, along, refPerp);
        const def = districtAt(refPoint, districts);
        if (!def) continue;
        const isPack = cellRng.next() < BACKLOT.packFraction;

        if (isPack) {
          const modelId = pickModel(cellRng, def, false);
          const tint = pickTint(cellRng, def, modelId);
          const half = colliderHalfExtents(modelId);
          const world = worldHalfExtents(half, street.axis);
          const depthHalf = street.axis === 'ns' ? world.hx : world.hz;
          const perp = (street.halfWidth + SIDEWALK.widthWu + BACKLOT.assumedFrontageDepthWu + BACKLOT.setbackFromFrontageRearWu + depthHalf) * side;
          const p = pointAlongStreet(street, along, perp);
          const fp = aabbFromCenterHalf(p, world.hx, world.hz);
          if (!passesCommonGates(fp)) continue;
          if (rejectsAny(fp, gates)) continue;
          if (blocked(fp)) continue;
          if (kept.some((r) => overlaps(fp, r))) continue;
          kept.push(fp);
          packItems.push({
            id: `backlot:${street.id}:${side}:${counter++}`,
            modelId,
            position: [p.x, 0, p.y],
            rotationY: frontageRotationY(street.axis, side),
            tint,
            hx: world.hx,
            hy: world.hy,
            hz: world.hz,
            districtId: def.id,
          });
        } else {
          const [hxLo, hxHi] = BACKLOT.boxHalfSideRangeWu;
          const hx = hxLo + cellRng.next() * (hxHi - hxLo);
          const hz = hxLo + cellRng.next() * (hxHi - hxLo);
          const depthHalf = street.axis === 'ns' ? hx : hz;
          const perp = (street.halfWidth + SIDEWALK.widthWu + BACKLOT.assumedFrontageDepthWu + BACKLOT.setbackFromFrontageRearWu + depthHalf) * side;
          const p = pointAlongStreet(street, along, perp);
          const fp = aabbFromCenterHalf(p, hx, hz);
          if (!passesCommonGates(fp)) continue;
          if (rejectsAny(fp, gates)) continue;
          if (blocked(fp)) continue;
          if (kept.some((r) => overlaps(fp, r))) continue;
          kept.push(fp);
          const realM = def.heightRangeM[0] + cellRng.next() * (def.heightRangeM[1] - def.heightRangeM[0]);
          const hy = hGame(realM) / 2;
          const color = def.fillerColors[Math.floor(cellRng.next() * def.fillerColors.length) % def.fillerColors.length];
          boxes.push({ x: p.x, z: p.y, hx, hy, hz, color, districtId: def.id });
        }
      }
    }
  }
  return { packItems: thinToCap(packItems, BACKLOT.capMapWide), boxes: thinToCap(boxes, BACKLOT.capMapWide) };
}

// --- D4: laneway clutter -------------------------------------------------------------------------

function buildLanewayClutter(
  streets: readonly Street[],
  districts: readonly ResolvedDistrict[],
  gates: readonly (readonly Aabb[])[],
  blocked: BlockedFn,
  base: Rng,
  densityScalar: number,
): DecorPlacement[] {
  const out: DecorPlacement[] = [];
  const spacing = LANEWAY.spacingWu / densityScalar;
  for (const street of streets) {
    for (const side of [1, -1] as const) {
      const rowRng = base.fork(`${street.id}:${side}`);
      const [lo, hi] = street.span;
      const n = Math.max(1, Math.round((hi - lo) / spacing));
      const step = (hi - lo) / n;
      for (let i = 0; i <= n; i++) {
        const along = lo + i * step;
        const cellRng = rowRng.fork(`${i}`);
        const perp = (street.halfWidth + SIDEWALK.widthWu + LANEWAY.offsetFromFacadeWu) * side;
        const p = pointAlongStreet(street, along, perp);
        if (!pointInPolygon(p, PLAYABLE_POLYGON)) continue;
        const def = districtAt(p, districts);
        if (!def) continue;
        // Phase 40: the model + spin are drawn FIRST (cellRng is per-candidate, so drawing before
        // the gate is rng-neutral for every other candidate, and this candidate's pick→spin order
        // is unchanged) because the gate must test the REAL rotated model footprint. The old
        // 0.6 wu stand-in let a dumpster's true box reach into ground — streetwall backs, the
        // edge ring — the check never saw as taken (the invariant sweep's decor×frontageSlot
        // finding); the claim composeWorld registers is exactly this footprint, so gate and claim
        // can no longer disagree. Clutter still never gets a collider.
        const includeWashingLine = (LANEWAY.washingLineDensities as readonly DistrictDensity[]).includes(def.density);
        const pool = includeWashingLine ? [...LANEWAY_MODELS, { id: 'washing-line', weight: 0.15 }] : LANEWAY_MODELS;
        const modelId = weightedPick(cellRng, pool);
        const rotationY = seededSpin(cellRng);
        const modelHalf = colliderHalfExtents(modelId);
        const rotated = footprintHalfExtents(modelHalf.hx, modelHalf.hz, rotationY);
        const fp = aabbFromCenterHalf(p, rotated.hx, rotated.hz);
        if (fp.maxZ >= WATER_Z) continue;
        if (rejectsAny(fp, gates)) continue;
        if (blocked(fp)) continue;
        out.push({ modelId, position: [p.x, 0, p.y], rotationY, districtId: def.id });
      }
    }
  }
  return thinToCap(out, LANEWAY.capMapWide) as DecorPlacement[];
}

// --- D7: lane closures ----------------------------------------------------------------------------

function eligibleClosureStreets(streets: readonly Street[]): readonly Street[] {
  const set = new Set(LANE_CLOSURE.eligibleClasses);
  return streets.filter((s) => set.has(s.cls));
}

function crossingAlongs(street: Street, intersections: readonly Intersection[]): readonly number[] {
  return intersections
    .filter((c) => (street.axis === 'ns' ? c.nsId === street.id : c.ewId === street.id))
    .map((c) => (street.axis === 'ns' ? c.y : c.x));
}

interface ClosureCandidate {
  readonly street: Street;
  readonly along: number;
}

function collectClosureCandidates(streets: readonly Street[], intersections: readonly Intersection[]): readonly ClosureCandidate[] {
  const out: ClosureCandidate[] = [];
  const stride = 60;
  for (const street of eligibleClosureStreets(streets)) {
    const alongs = crossingAlongs(street, intersections);
    const [lo, hi] = street.span;
    for (let along = lo + stride / 2; along < hi; along += stride) {
      if (alongs.some((c) => Math.abs(c - along) < LANE_CLOSURE.minDistFromIntersectionWu)) continue;
      out.push({ street, along });
    }
  }
  return out;
}

/**
 * Phase 40 (gap 4) — the ON-ROAD gate a lane closure must clear. Lane closures were the module's
 * one GATE-LESS signature: cones went down at `side · halfWidth · taperFrac` and a road-bits plate
 * on the exact centreline, with no check against the street-parked cars in the same outer lane, the
 * manhole covers on the same centreline, or the painted crosswalk bands. All three now gate, which
 * is why this pass moved to the END of the composition (composeWorld's deviation ②): the parked
 * cars and manholes it must avoid are furniture's output.
 */
const CLOSURE_BLOCKER_QUERY: ClaimQuery = {
  kinds: new Set<ClaimKind>(['parkedCar', 'manhole', 'crosswalkBand']),
};

function buildLaneClosures(
  streets: readonly Street[],
  intersections: readonly Intersection[],
  districts: readonly ResolvedDistrict[],
  blocked: BlockedFn,
  base: Rng,
  dropAll: boolean,
): { cones: DynamicConeSpec[]; decor: DecorPlacement[]; siteCount: number } {
  // D8/D7: low tier drops lane closures entirely (existing tier-param seam, like lampOverlay).
  if (dropAll) return { cones: [], decor: [], siteCount: 0 };
  const candidates = collectClosureCandidates(streets, intersections);
  const rng = base.fork('lane-closures');
  const [loCount, hiCount] = LANE_CLOSURE.countRange;
  const count = Math.min(candidates.length, loCount + Math.floor(rng.next() * (hiCount - loCount + 1)));
  const picked = thinToCap(candidates, count);

  const cones: DynamicConeSpec[] = [];
  const decor: DecorPlacement[] = [];
  let siteCount = 0;
  const coneHalf = colliderHalfExtents('cone');
  const plateHalf = colliderHalfExtents('road-bits');
  picked.forEach((c, i) => {
    const detailRng = base.fork(`closure-detail:${i}`);
    const side: 1 | -1 = detailRng.next() < 0.5 ? 1 : -1;
    const [loCones, hiCones] = LANE_CLOSURE.coneCountRange;
    const coneCount = loCones + Math.floor(detailRng.next() * (hiCones - loCones + 1));
    let placedHere = 0;
    for (let k = 0; k < coneCount; k++) {
      const stepAlong = c.along + (k - coneCount / 2) * LANE_CLOSURE.coneSpacingWu;
      const taperFrac = 0.25 + (0.5 * k) / Math.max(1, coneCount - 1);
      const perp = side * c.street.halfWidth * taperFrac;
      const p = pointAlongStreet(c.street, stepAlong, perp);
      // REJECT, never relocate — a cone that would stand in a parked car, on a manhole cover or
      // across a painted crosswalk band is simply skipped; the taper reads fine with a gap.
      if (blocked(aabbFromCenterHalf(p, coneHalf.hx, coneHalf.hz))) continue;
      cones.push({ modelId: 'cone', position: [p.x, 0, p.y], rotationY: 0 });
      placedHere++;
    }
    const rbP: MapPoint = { x: c.street.axis === 'ns' ? c.street.centerline : c.along, y: c.street.axis === 'ns' ? c.along : c.street.centerline };
    const plateRot = c.street.axis === 'ns' ? Math.PI / 2 : 0;
    const plateFp = footprintHalfExtents(plateHalf.hx, plateHalf.hz, plateRot);
    if (!blocked(aabbAround(rbP.x, rbP.y, plateFp.hx, plateFp.hz))) {
      const def = districtAt(rbP, districts);
      decor.push({
        modelId: 'road-bits',
        // Phase 39: this plate lies ON the asphalt (lane closures sit in the roadway), so it takes
        // the road anchor rather than the laneway one — a flat plate at y=0 sat below the ribbon.
        position: [rbP.x, SURFACE_ANCHOR.road, rbP.y],
        rotationY: plateRot,
        districtId: def?.id ?? DISTRICT_ORDER[DISTRICT_ORDER.length - 1],
      });
      placedHere++;
    }
    if (placedHere > 0) siteCount++;
  });
  return { cones, decor, siteCount };
}

// --- D11: deep-interior scatter -------------------------------------------------------------------

type DeepScatterKind = 'tree' | 'greenhouse' | 'pile';

/** Point-to-rect CLEARANCE (not the footprint-vs-footprint `overlaps` test above) — how far `p`
 * sits from a street's ribbon, regardless of which side or how far outside it the point is. The
 * D11 eligibility gate (task-specified "> 35 wu from every street ribbon edge") needs exactly
 * this: a candidate scores against every street, not just the nearest one it happens to overlap. */
function minDistToRibbons(p: MapPoint, streets: readonly Street[]): number {
  let best = Infinity;
  for (const s of streets) {
    const r = s.ribbon;
    const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
    const dz = Math.max(r.minY - p.y, 0, p.y - r.maxY);
    const d = Math.hypot(dx, dz);
    if (d < best) best = d;
  }
  return best;
}

interface DeepScatterCandidate {
  readonly p: MapPoint;
  readonly def: TorontoDistrictDef;
  readonly distFromRibbon: number;
}

/** The coarse deterministic scan (same grid-then-jitter idiom as scanForSites) — yields bare
 * eligible points only; the eventual content's footprint size depends on which D11 kind gets
 * rolled for a given point, so it can't be sized up front the way a construction/parking-lot site
 * is. Cheap point-level polygon/water/ribbon-distance checks here; the real reject-never-relocate
 * footprint gates run per placed item below (kind-dependent size). */
function scanDeepInteriorCandidates(
  districts: readonly ResolvedDistrict[],
  streets: readonly Street[],
  base: Rng,
  densityScalar: number,
): readonly DeepScatterCandidate[] {
  const bbox = polygonBBox();
  const out: DeepScatterCandidate[] = [];
  const stride = DEEP_SCATTER.scanStrideWu / densityScalar;
  let row = 0;
  for (let z = bbox.minZ + stride / 2; z < bbox.maxZ; z += stride, row++) {
    let col = 0;
    for (let x = bbox.minX + stride / 2; x < bbox.maxX; x += stride, col++) {
      const rng = base.fork(`scan:${row}:${col}`);
      const jx = x + (rng.next() * 2 - 1) * stride * 0.3;
      const jz = z + (rng.next() * 2 - 1) * stride * 0.3;
      const p: MapPoint = { x: jx, y: jz };
      if (p.y >= WATER_Z) continue;
      if (!pointInPolygon(p, PLAYABLE_POLYGON)) continue;
      const distFromRibbon = minDistToRibbons(p, streets);
      if (distFromRibbon <= DEEP_SCATTER.minDistFromRibbonWu) continue;
      if (rng.next() >= DEEP_SCATTER.keepProbability) continue;
      const def = districtAt(p, districts);
      if (!def) continue;
      out.push({ p, def, distFromRibbon });
    }
  }
  return out;
}

/** Which D11 kind a candidate resolves to: greenhouse/pile only ever enter the weighted pool where
 * their own gate passes (district density / distance-from-ribbon band) — a candidate that
 * qualifies for neither always resolves to a tree cluster (the sole remaining pool entry). */
function pickDeepScatterKind(rng: Rng, candidate: DeepScatterCandidate): DeepScatterKind {
  const greenhouseDensities = DEEP_SCATTER.greenhouseDensities as readonly DistrictDensity[];
  const pool: { readonly id: DeepScatterKind; readonly weight: number }[] = [
    { id: 'tree', weight: DEEP_SCATTER.contentWeights.tree },
  ];
  if (greenhouseDensities.includes(candidate.def.density)) {
    pool.push({ id: 'greenhouse', weight: DEEP_SCATTER.contentWeights.greenhouse });
  }
  if (candidate.distFromRibbon <= DEEP_SCATTER.pileMaxDistFromRibbonWu) {
    pool.push({ id: 'pile', weight: DEEP_SCATTER.contentWeights.pile });
  }
  return weightedPick(rng, pool) as DeepScatterKind;
}

/** Rare junk-pile props (task: "dumpster/box piles") — colliderless decor, same convention as
 * LANEWAY_MODELS' own dumpster/box entries (junk clutter never gets a collider in this layer). */
const PILE_MODELS: readonly { readonly id: string; readonly weight: number }[] = [
  { id: 'dumpster', weight: 0.4 },
  { id: 'box', weight: 0.6 },
];

/**
 * D11: builds the deep-interior scatter (tree clusters + rare greenhouse/pile garnish) for every
 * candidate `scanDeepInteriorCandidates` yields, rejecting against `gates` (every D3-D7 footprint
 * family the orchestrator assembled, PLUS a shared `kept` list every D11 placement — tree trunk,
 * greenhouse, or pile prop — pushes into, so D11 content also rejects against itself/each other).
 * Trees get a REAL trunk collider (the same D12 convention furniture.ts's TREE_ROW uses: a fixed
 * ~0.25 x h x 0.25 wu cuboid, never the canopy's full colliderHalfExtents('tree') box) so a tree
 * reads as a solid obstacle, not a driveable ghost. Greenhouse sheds get a real fixed cuboid
 * collider via the same colliderHalfExtents seam every other pack building uses. Pile props are
 * colliderless (LANEWAY's own convention for the same dumpster/box ids).
 */
function buildDeepScatter(
  streets: readonly Street[],
  districts: readonly ResolvedDistrict[],
  gates: readonly (readonly Aabb[])[],
  blocked: BlockedFn,
  base: Rng,
  densityScalar: number,
): { fixed: FixedInfillItem[]; decor: DecorPlacement[] } {
  const treeTrunkHy = (getCityPackModel('tree').nativeDims.h * resolveCityPackScale('tree')) / 2;
  const trunkHalf = TREE_ROW.trunkHalfWidthWu;

  const trees: FixedInfillItem[] = [];
  const greenhouses: FixedInfillItem[] = [];
  const piles: DecorPlacement[] = [];
  const kept: Aabb[] = [];
  let counter = 0;

  const candidates = scanDeepInteriorCandidates(districts, streets, base.fork('scan'), densityScalar);

  for (const candidate of candidates) {
    const cellRng = base.fork(`cell:${candidate.p.x.toFixed(1)}:${candidate.p.y.toFixed(1)}`);
    const kind = pickDeepScatterKind(cellRng, candidate);

    if (kind === 'greenhouse') {
      const half = colliderHalfExtents('greenhouse');
      const fp = aabbFromCenterHalf(candidate.p, half.hx, half.hz);
      if (!passesCommonGates(fp) || rejectsAny(fp, gates) || blocked(fp) || kept.some((r) => overlaps(fp, r))) continue;
      kept.push(fp);
      greenhouses.push({
        id: `deep-scatter:greenhouse:${counter++}`,
        modelId: 'greenhouse',
        position: [candidate.p.x, 0, candidate.p.y],
        rotationY: seededSpin(cellRng),
        tint: pickTint(cellRng, candidate.def, 'greenhouse'),
        hx: half.hx,
        hy: half.hy,
        hz: half.hz,
        districtId: candidate.def.id,
      });
      continue;
    }

    if (kind === 'pile') {
      const [lo, hi] = DEEP_SCATTER.pileClusterCountRange;
      const n = lo + Math.floor(cellRng.next() * (hi - lo + 1));
      for (let i = 0; i < n; i++) {
        const itemRng = cellRng.fork(`pile:${i}`);
        const pt: MapPoint = {
          x: candidate.p.x + (itemRng.next() * 2 - 1) * DEEP_SCATTER.pileSpreadWu,
          y: candidate.p.y + (itemRng.next() * 2 - 1) * DEEP_SCATTER.pileSpreadWu,
        };
        // Phase 40: real rotated footprint at the gate, pick+spin drawn first — itemRng is
        // per-item, so the early draws are rng-neutral and the in-fork order (jitter→pick→spin)
        // is unchanged. Same stand-in-vs-claim fix as laneway clutter's, same rationale; piles
        // stay colliderless.
        const modelId = weightedPick(itemRng, PILE_MODELS);
        const rotationY = seededSpin(itemRng);
        const modelHalf = colliderHalfExtents(modelId);
        const rotated = footprintHalfExtents(modelHalf.hx, modelHalf.hz, rotationY);
        const fp = aabbFromCenterHalf(pt, rotated.hx, rotated.hz);
        if (!passesCommonGates(fp) || rejectsAny(fp, gates) || blocked(fp) || kept.some((r) => overlaps(fp, r))) continue;
        kept.push(fp);
        piles.push({
          modelId,
          position: [pt.x, 0, pt.y],
          rotationY,
          districtId: candidate.def.id,
        });
      }
      continue;
    }

    // 'tree' — a cluster of 2-5 (task-specified), each trunk rejected INDIVIDUALLY (never the
    // whole cluster at once) since a cluster can straddle a gate boundary the candidate's own
    // centre point cleared.
    const [loC, hiC] = DEEP_SCATTER.clusterCountRange;
    const n = loC + Math.floor(cellRng.next() * (hiC - loC + 1));
    for (let i = 0; i < n; i++) {
      const treeRng = cellRng.fork(`tree:${i}`);
      const pt: MapPoint = {
        x: candidate.p.x + (treeRng.next() * 2 - 1) * DEEP_SCATTER.clusterSpreadWu,
        y: candidate.p.y + (treeRng.next() * 2 - 1) * DEEP_SCATTER.clusterSpreadWu,
      };
      const fp = aabbFromCenterHalf(pt, trunkHalf, trunkHalf);
      if (!passesCommonGates(fp) || rejectsAny(fp, gates) || blocked(fp) || kept.some((r) => overlaps(fp, r))) continue;
      kept.push(fp);
      trees.push({
        id: `deep-scatter:tree:${counter++}`,
        modelId: 'tree',
        position: [pt.x, 0, pt.y],
        rotationY: seededSpin(treeRng),
        tint: '#ffffff',
        hx: trunkHalf,
        hy: treeTrunkHy,
        hz: trunkHalf,
        districtId: candidate.def.id,
      });
    }
  }

  // Task-specified map-wide caps, each additionally thinned by densityScalar ("all thinned by
  // dressDensityScalar") — a lower tier gets both a coarser scan (fewer raw candidates) AND a
  // lower cap, same double-lever tier seam every other D11 number uses.
  const treeCap = Math.max(0, Math.round(DEEP_SCATTER.treeCapMapWide * densityScalar));
  const greenhouseCap = Math.max(0, Math.round(DEEP_SCATTER.greenhouseCapMapWide * densityScalar));
  const pileCap = Math.max(0, Math.round(DEEP_SCATTER.pileCapMapWide * densityScalar));

  return {
    fixed: [...thinToCap(trees, treeCap), ...thinToCap(greenhouses, greenhouseCap)],
    decor: thinToCap(piles, pileCap) as DecorPlacement[],
  };
}

// --- top-level orchestrator ------------------------------------------------------------------

/**
 * Builds the whole Phase-28 infill layer for `seed`. Pure, deterministic (mulberry32 forks) — same
 * contract as frontage.ts/furniture.ts.
 *
 * Phase 40: the frontage layout is no longer a parameter. Everything this layer must avoid reaches
 * it through `ctx.index` — composeWorld registers frontage (and venue dressing, and the world-edge
 * ring) BEFORE calling this, and the ordering lives there instead of in a threaded argument list.
 *
 * `tierParams` (D8) defaults to TORONTO_TIER_IDENTITY (dressDensityScalar=1) — every call site
 * that omits it gets the identity (highest-density) output, matching frontage.ts/furniture.ts's
 * existing tier seam. `dressDensityScalar` widens the back-lot pitch, laneway spacing, and the
 * construction/parking-lot scan stride (fewer candidates ⇒ fewer lots/items, the same "divide the
 * base spacing" idiom furniture.ts's buildRow already uses). Below a low-tier threshold, lane
 * closures are dropped entirely and construction sites get half their loose decor props — both
 * read directly off `dressDensityScalar` (the "master density dial") rather than a new field on
 * the shared TorontoTierParams interface, so the identity default (=1) is trivially "not low tier"
 * without touching frontage.ts/furniture.ts's existing byte-identity goldens. D11's own tree/
 * greenhouse/pile caps are ALSO scaled by `dressDensityScalar` directly (see buildDeepScatter).
 */
export function buildInfillMain(
  seed: number,
  ctx: PlacementContext,
  tierParams: TorontoTierParams = TORONTO_TIER_IDENTITY,
): InfillMain {
  const densityScalar = tierParams.dressDensityScalar;
  // QUALITY_TIERS.low.dressDensityScalar = 0.55; med/high are 0.85/1 — this threshold cleanly
  // separates low from every other tier without importing config/quality.ts here.
  const isLowTier = densityScalar <= 0.6;
  const propScale = isLowTier ? 0.5 : 1;
  const base = createRng(seed).fork('toronto-infill-v1');
  const { streets, districts } = ctx;
  // Phase 40: named ∪ places ∪ parks now comes from the arbiter's zone claims instead of a third
  // hand-maintained composition (the audit's gap 7).
  const exclusions: readonly Aabb[] = ctx.index.rects({ kinds: EXCLUSION_ZONE_KINDS });
  // D10: every new layer must clear not just the ribbon but the SIDEWALK band beyond it too
  // (buildings only — laneway clutter is exempt from the sidewalk part by design, but this module
  // applies it uniformly since every layer's nominal placement already clears both by construction;
  // this is the safety-net rejection gate, not the placement bias). Strictly wider than a plain
  // ribbons+0.5 margin, so it subsumes that check.
  const sidewalkBands: Aabb[] = streets.map((s) => ({
    minX: s.ribbon.minX - SIDEWALK.widthWu,
    maxX: s.ribbon.maxX + SIDEWALK.widthWu,
    minZ: s.ribbon.minY - SIDEWALK.widthWu,
    maxZ: s.ribbon.maxY + SIDEWALK.widthWu,
  }));
  // Phase 40: the hand-built `frontageFootprints` list this module used to assemble is GONE. Every
  // earlier layer's footprints — frontage slots AND corner fills AND the backdrop-tower row (never
  // checked before) AND venue dressing props AND the world-edge ring AND the named boxes — now come
  // through the arbiter, which is also what makes the ordering explicit rather than implied by a
  // parameter list.
  const blocked: BlockedFn = (fp) => ctx.index.overlapsAny(fp, BLOCKING_QUERY);

  // 1) Construction sites FIRST — first pick of the big interiors.
  const construction = buildConstructionSites(districts, [sidewalkBands, exclusions], blocked, base.fork('construction'), densityScalar, propScale);
  const constructionLotRects = construction.sites.map((s) => s.rect);
  // Phase 40: the GATE list carries the rects + the sites' real fixture footprints — a perimeter
  // fence run straddles its rect edge, so a later claim standing just OUTSIDE the rect can still
  // overlap a fence piece (the sweep's seed-7 tree×fence catch, on the parking twin below). The
  // returned `constructionLots`/`parkingLots` stay PURE rects (composeWorld registers those as
  // the zone claims and counts them).
  const constructionFootprints = [
    ...constructionLotRects,
    ...construction.fixed.map((f) => aabbFromCenterHalf({ x: f.position[0], y: f.position[2] }, f.hx, f.hz)),
  ];

  // 2) Back-lot second row — avoids frontage + construction.
  const backlot = buildBacklotRow(streets, districts, [sidewalkBands, exclusions, constructionFootprints], blocked, base.fork('backlot'), densityScalar);
  const backlotFootprints = [...backlot.packItems.map((p) => aabbFromCenterHalf({ x: p.position[0], y: p.position[2] }, p.hx, p.hz)), ...backlot.boxes.map((b) => aabbFromCenterHalf({ x: b.x, y: b.z }, b.hx, b.hz))];

  // 3) Parking lots — avoids frontage + construction + backlot.
  const parking = buildParkingLots(districts, [sidewalkBands, exclusions, constructionFootprints, backlotFootprints], blocked, base.fork('parking'), densityScalar);
  const parkingLotRects = parking.lots.map((l) => l.rect);
  // Same rect-vs-fixture closure as constructionFootprints above (this is where seed 7's
  // tree×fence pair actually lived).
  const parkingFootprints = [
    ...parkingLotRects,
    ...parking.fixed.map((f) => aabbFromCenterHalf({ x: f.position[0], y: f.position[2] }, f.hx, f.hz)),
  ];

  // 4) Laneway clutter — fits leftover gaps; may sit in interiors freely (D10), never on a ribbon
  //    (still checked) or inside any reserved footprint above.
  const laneway = buildLanewayClutter(
    streets,
    districts,
    [sidewalkBands, exclusions, constructionFootprints, backlotFootprints, parkingFootprints],
    blocked,
    base.fork('laneway'),
    densityScalar,
  );

  // 5) Deep-interior scatter (D11) — runs LAST of all, avoiding every layer above (+ laneway's own
  //    small decor footprints, added here since laneway is built just above) plus itself.
  // Phase 40: deep scatter avoids laneway clutter at its REAL claimed footprints (the 0.6 wu
  // stand-in under-reported a dumpster by ~2 wu — the same gate-vs-claim mismatch fixed inside
  // both passes above, closed here for the cross-pass gate list too).
  const lanewayFootprints: Aabb[] = laneway.map((d) => {
    const half = colliderHalfExtents(d.modelId);
    const rotated = footprintHalfExtents(half.hx, half.hz, d.rotationY);
    return aabbFromCenterHalf({ x: d.position[0], y: d.position[2] }, rotated.hx, rotated.hz);
  });
  const deepScatter = buildDeepScatter(
    streets,
    districts,
    [sidewalkBands, exclusions, constructionFootprints, backlotFootprints, parkingFootprints, lanewayFootprints],
    blocked,
    base.fork('deep-scatter'),
    densityScalar,
  );

  const fixed: FixedInfillItem[] = [...backlot.packItems, ...parking.fixed, ...construction.fixed, ...deepScatter.fixed];
  const decor: DecorPlacement[] = [...laneway, ...construction.decor, ...deepScatter.decor];

  return {
    fixed,
    boxes: backlot.boxes,
    decor,
    constructionLots: constructionLotRects,
    parkingLots: parkingLotRects,
    groups: {
      backlot: backlot.packItems,
      parking: parking.fixed,
      construction: construction.fixed,
      scatterFixed: deepScatter.fixed,
      laneway,
      constructionDecor: construction.decor,
      scatterDecor: deepScatter.decor,
    },
    counts: {
      backlotPack: backlot.packItems.length,
      backlotBox: backlot.boxes.length,
      laneway: laneway.length,
      parkingLots: parking.lots.length,
      parkingCars: parking.fixed.filter((f) => f.id.includes('-car-')).length,
      constructionSites: construction.sites.length,
      constructionFixed: construction.fixed.length,
      constructionDecor: construction.decor.length,
      deepScatterTrees: deepScatter.fixed.filter((f) => f.modelId === 'tree').length,
      deepScatterGreenhouses: deepScatter.fixed.filter((f) => f.modelId === 'greenhouse').length,
      deepScatterPiles: deepScatter.decor.length,
    },
  };
}

/**
 * Phase 40 — the lane-closure pass, split out of `buildInfill` and moved AFTER furniture in the
 * composition so it can gate on the street-parked cars, manhole covers and painted crosswalk bands
 * that furniture + the road paint put on the same asphalt (the audit's gap 4).
 *
 * Its rng is `base.fork('lane-closures')` / `base.fork('closure-detail:N')` off the SAME
 * `toronto-infill-v1` base, exactly as before — mulberry forks are seeded by label, not by call
 * order, so moving this call changes no other layer's rolls by construction.
 */
export function buildLaneClosuresLayer(
  seed: number,
  ctx: PlacementContext,
  tierParams: TorontoTierParams = TORONTO_TIER_IDENTITY,
): LaneClosureLayer {
  const densityScalar = tierParams.dressDensityScalar;
  const isLowTier = densityScalar <= 0.6;
  const base = createRng(seed).fork('toronto-infill-v1');
  const blocked: BlockedFn = (fp) => ctx.index.overlapsAny(fp, CLOSURE_BLOCKER_QUERY);
  const closures = buildLaneClosures(ctx.streets, ctx.intersections, ctx.districts, blocked, base.fork('lane-closures'), isLowTier);
  return { cones: closures.cones, decor: closures.decor, siteCount: closures.siteCount };
}

/**
 * Merge the two halves back into the single `InfillLayout` the scene + colliders consume. Array
 * order is preserved verbatim from the pre-split builder (`decor` = laneway, construction,
 * lane-closure plates, deep-scatter piles) so nothing downstream — renderer batching, collider
 * mounting, the golden suites — sees a reordering.
 */
export function mergeInfill(main: InfillMain, closures: LaneClosureLayer): InfillLayout {
  // Re-inserting the lane-closure plates at their original position in `decor`: laneway +
  // construction first, then closures, then the deep-scatter piles.
  const pileStart = main.decor.length - main.counts.deepScatterPiles;
  const decor: DecorPlacement[] = [
    ...main.decor.slice(0, pileStart),
    ...closures.decor,
    ...main.decor.slice(pileStart),
  ];
  const fixed = main.fixed;
  return {
    fixed,
    boxes: main.boxes,
    decor,
    cones: closures.cones,
    counts: {
      backlotPack: main.counts.backlotPack,
      backlotBox: main.counts.backlotBox,
      laneway: main.counts.laneway,
      parkingLots: main.counts.parkingLots,
      parkingCars: main.counts.parkingCars,
      constructionSites: main.counts.constructionSites,
      constructionFixed: main.counts.constructionFixed,
      constructionDecor: main.counts.constructionDecor,
      // One road-bits plate per placed closure site.
      laneClosures: closures.siteCount,
      laneClosureCones: closures.cones.length,
      deepScatterTrees: main.counts.deepScatterTrees,
      deepScatterGreenhouses: main.counts.deepScatterGreenhouses,
      deepScatterPiles: main.counts.deepScatterPiles,
      fixedTotal: fixed.length,
      decorTotal: decor.length,
    },
  };
}
