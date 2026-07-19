// WGS84 → map world-units, for the Toronto "thermometer" map (TORONTO-MAP-SPEC-v2.md §1–§2).
//
// Map space: world-units (wu). y-DOWN is SOUTH (the §1 polygon convention), x-EAST. The
// projection is piecewise-linear in both axes, calibrated ONLY from researcher-verified
// anchors (data/toronto/anchors.json), transcribed once into TORONTO_CALIBRATION below.
//
//   N-S  f(lat): piecewise-linear through four control latitudes → fixed map y. North of Finch
//        extends the Finch–Sheppard slope; south of shore extends the Bloor–shore slope. This is
//        what folds ~9 km of midtown into a narrow fold corridor while keeping downtown near 1:1.
//        Part-8 (D1, "density/life flip"): the whole map compacts ~0.6× (config/torontoMap.ts's
//        DENSITY.scale) EXCEPT the fold segment, which is exempt (its span is preserved verbatim,
//        only its start shifts). BASE_NS_Y below records the original §1/§2 control-y constants
//        (Finch→170, Sheppard→1170, Bloor→1830, shore→3700); LIVE_*_Y are what f(lat) actually
//        resolves to post-compaction — re-derived below, never hand-tuned twice.
//   E-W  Yonge must read as a perfectly straight vertical at x=1500 (§2 — it is the spine
//        that makes the whole shape legible). Real Yonge tilts ~0.046° of lon over the map,
//        so the Yonge centreline longitude is itself a piecewise-linear function of latitude
//        (lonYonge, through every verified yonge_line anchor); x is the lon OFFSET from that
//        centreline, converted metres→wu at a single uniform E-W scale (also DENSITY-scaled).
//
// Determinism: pure arithmetic, no state, no Math.random — same input → same output on every
// machine (the whole world generator depends on this, see world/rng.ts).

import { DENSITY } from '../../config/torontoMap';

/** {lat, lon} in WGS84 degrees. */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** A point in map space (world-units). y-down = south. */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

/** The four map regions the N-S curve is carved into, by map-y band. */
export type Zone = 'north_york' | 'fold' | 'downtown' | 'water';

/** N-S metres-per-wu for each zone plus the single fixed E-W metres-per-wu. */
export interface ZoneScales {
  readonly northYork: number;
  readonly fold: number;
  readonly downtown: number;
  readonly water: number;
  readonly ewMPerWu: number;
}

/** A verified Yonge-centreline anchor (lat/lon transcribed from anchors.json). */
export interface CalibAnchor {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
}

/** An N-S control point: an anchor latitude pinned to a fixed map y (§1/§2 constant). */
export interface NsControl {
  readonly id: string;
  readonly lat: number;
  readonly y: number;
}

/** All calibration data behind a projection. Transcribed from anchors.json (verified rows only). */
export interface TorontoCalibration {
  /** Every verified yonge_line anchor, lat-descending Steeles→Queens Quay. Drives lonYonge(lat). */
  readonly yongeLine: readonly CalibAnchor[];
  /** The four N-S control points (lat → fixed map y). Drives f(lat). */
  readonly nsControls: readonly NsControl[];
}

/** A bound projection: forward/inverse transforms plus zone helpers and its calibration. */
export interface TorontoProjection {
  project(p: LatLon): MapPoint;
  unproject(p: MapPoint): LatLon;
  zoneAt(y: number): Zone;
  derivedZoneScales(): ZoneScales;
  readonly calib: TorontoCalibration;
}

// --- Part-8 (D1) compaction derivation --------------------------------------------------
// BASE = the §1/§2 spec's ORIGINAL (pre-compaction) control-y constants, kept as named constants
// (never re-literalized downstream — everything below re-derives from these + DENSITY.scale).
const BASE_NS_Y = {
  finch: 170,
  sheppard: 1170,
  bloor: 1830,
  shore: 3700,
  waterBottom: 4100,
} as const;

// Control-point-to-control-point spans (§1/§2 BASE geometry): top margin (map top → Finch),
// North York proper (Finch → Sheppard), the fold (Sheppard → Bloor, EXEMPT), downtown (Bloor →
// shore), and the water margin (shore → map bottom).
const BASE_SPANS = {
  topMargin: BASE_NS_Y.finch - 0,
  northYork: BASE_NS_Y.sheppard - BASE_NS_Y.finch,
  fold: BASE_NS_Y.bloor - BASE_NS_Y.sheppard, // exempt — carried through unscaled below
  downtown: BASE_NS_Y.shore - BASE_NS_Y.bloor,
  water: BASE_NS_Y.waterBottom - BASE_NS_Y.shore,
} as const;

// FOLD SEGMENT EXEMPT (D1): every span scales by DENSITY.scale EXCEPT the fold, which is carried
// through verbatim — only its START shifts (via the cumulative sum below) to sit right after the
// compacted North York zone.
const SCALED_SPANS = {
  topMargin: BASE_SPANS.topMargin * DENSITY.scale,
  northYork: BASE_SPANS.northYork * DENSITY.scale,
  fold: BASE_SPANS.fold,
  downtown: BASE_SPANS.downtown * DENSITY.scale,
  water: BASE_SPANS.water * DENSITY.scale,
} as const;

// Live control ys: cumulative sum of the scaled spans (never hand-written literals).
const LIVE_FINCH_Y = SCALED_SPANS.topMargin;
const LIVE_SHEPPARD_Y = LIVE_FINCH_Y + SCALED_SPANS.northYork;
const LIVE_BLOOR_Y = LIVE_SHEPPARD_Y + SCALED_SPANS.fold;
const LIVE_SHORE_Y = LIVE_BLOOR_Y + SCALED_SPANS.downtown;
const LIVE_WATER_BOTTOM_Y = LIVE_SHORE_Y + SCALED_SPANS.water;

// CALIBRATION SINGLE SOURCE — every lat/lon here is transcribed verbatim from
// data/toronto/anchors.json (status:"verified" rows only). projection.test.ts fs-reads that
// file and fails on ANY drift in either direction. needs_agent rows never appear here. The `y`
// values are the LIVE (compacted) control-ys derived above — BASE_NS_Y above is the spec-original
// record those derive from.
export const TORONTO_CALIBRATION = {
  yongeLine: [
    { id: 'yonge-steeles', lat: 43.796, lon: -79.422 }, // off-map centreline extension (see below)
    { id: 'yonge-finch', lat: 43.7814, lon: -79.4158 },
    { id: 'yonge-northyorkcentre', lat: 43.7686, lon: -79.4125 },
    { id: 'yonge-sheppard', lat: 43.7614, lon: -79.4108 },
    { id: 'yonge-eglinton', lat: 43.7061, lon: -79.3983 },
    { id: 'yonge-stclair', lat: 43.6878, lon: -79.3936 },
    { id: 'yonge-bloor', lat: 43.6708, lon: -79.3856 },
    { id: 'yonge-college', lat: 43.6606, lon: -79.3828 },
    { id: 'yonge-dundas', lat: 43.6564, lon: -79.3808 },
    { id: 'yonge-queen', lat: 43.6528, lon: -79.3794 },
    { id: 'yonge-king', lat: 43.6489, lon: -79.3778 },
    { id: 'yonge-front', lat: 43.647, lon: -79.3773 },
    { id: 'yonge-queensquay', lat: 43.6415, lon: -79.377 },
  ],
  nsControls: [
    { id: 'yonge-finch', lat: 43.7814, y: LIVE_FINCH_Y },
    { id: 'yonge-sheppard', lat: 43.7614, y: LIVE_SHEPPARD_Y },
    { id: 'yonge-bloor', lat: 43.6708, y: LIVE_BLOOR_Y },
    { id: 'shore-yonge', lat: 43.6404, y: LIVE_SHORE_Y },
  ],
} as const satisfies TorontoCalibration;

// Zone band edges in LIVE map y (§1/§2, compacted): [top, finch/sheppard fold, fold/downtown,
// shore, water bottom].
export const ZONE_BOUNDARIES = [0, LIVE_SHEPPARD_Y, LIVE_BLOOR_Y, LIVE_SHORE_Y, LIVE_WATER_BOTTOM_Y] as const;

/**
 * Part-8 (D1/D2): re-derives an OLD (pre-compaction, BASE) map-y literal into its LIVE
 * (compacted) position — the y-axis analogue of `scaleAboutYonge` (polygon.ts). Applies the same
 * per-zone affine transform ZONE_BOUNDARIES itself was derived from: a uniform ×DENSITY.scale in
 * north_york (from the shared origin 0), a pure SHIFT in the fold (exempt from scaling), and an
 * affine scale+offset in downtown/water (anchored at Bloor / shore respectively). Every hand-
 * authored BASE y literal migrating from a pre-Part-8 module (signposts, vibe-prop anchors, …)
 * goes through this ONE function rather than being re-derived ad hoc.
 */
export function scaleBaseY(oldY: number): number {
  if (oldY <= BASE_NS_Y.sheppard) return oldY * DENSITY.scale; // north_york (incl. top margin)
  if (oldY <= BASE_NS_Y.bloor) return LIVE_SHEPPARD_Y + (oldY - BASE_NS_Y.sheppard); // fold — exempt, shift only
  if (oldY <= BASE_NS_Y.shore) return LIVE_BLOOR_Y + (oldY - BASE_NS_Y.bloor) * DENSITY.scale; // downtown
  return LIVE_SHORE_Y + (oldY - BASE_NS_Y.shore) * DENSITY.scale; // water
}

// --- Metric constants ------------------------------------------------------------------
// One degree of latitude ≈ a fixed distance; one degree of longitude shrinks by cos(lat).
// 111320 m/° is the standard equatorial/meridian metric; REF_LAT is mid-map. These drive
// BOTH the E-W wu conversion and the reported N-S zone scales (metres per wu).
const M_PER_DEG_LAT = 111320;
const REF_LAT_DEG = 43.7;
const M_PER_DEG_LON = 111320 * Math.cos((REF_LAT_DEG * Math.PI) / 180);
/** BASE §2 uniform E-W scale (pre-compaction); the LIVE scale below is derived from it. */
const BASE_EW_M_PER_WU = 1.55;
// Part-8 (D1): compaction shrinks metres-per-wu (the map now packs more real metres into fewer
// wu) — the exact expression, never a re-literalized decimal.
const EW_M_PER_WU = BASE_EW_M_PER_WU / DENSITY.scale;
// lon-offset (degrees) → wu: metres = Δlon · M_PER_DEG_LON, then wu = metres / EW_M_PER_WU.
const WU_PER_DEG_LON = M_PER_DEG_LON / EW_M_PER_WU;
/** §2: the Yonge spine is pinned at this map-x everywhere (exported — tunnel corridor and
 * the road grid centre themselves on it; never restate 1500 elsewhere). */
export const YONGE_X = 1500;

interface Node2 {
  readonly k: number;
  readonly v: number;
}

/** Piecewise-linear interpolation through `nodes` sorted DESCENDING in k; end segments are
 * extended for out-of-range k (that is how north-of-Finch / south-of-shore extrapolate). */
function lerpDesc(nodes: readonly Node2[], k: number): number {
  let i = nodes.length - 2; // default = last segment (k below every node)
  for (let j = 0; j < nodes.length - 1; j++) {
    if (k >= nodes[j + 1].k) {
      i = j;
      break;
    }
  }
  const a = nodes[i];
  const b = nodes[i + 1];
  return a.v + ((k - a.k) / (b.k - a.k)) * (b.v - a.v);
}

/** As lerpDesc but for `nodes` sorted ASCENDING in k — used to invert f (map y → lat). */
function lerpAsc(nodes: readonly Node2[], k: number): number {
  let i = nodes.length - 2; // default = last segment (k above every node)
  for (let j = 0; j < nodes.length - 1; j++) {
    if (k <= nodes[j + 1].k) {
      i = j;
      break;
    }
  }
  const a = nodes[i];
  const b = nodes[i + 1];
  return a.v + ((k - a.k) / (b.k - a.k)) * (b.v - a.v);
}

/**
 * Build a projection from a calibration. The default `TORONTO_PROJECTION` is bound to
 * `TORONTO_CALIBRATION`; the factory exists so tests (and future recalibration) can rebind.
 */
export function buildProjection(calib: TorontoCalibration): TorontoProjection {
  const lonNodes: Node2[] = calib.yongeLine.map((a) => ({ k: a.lat, v: a.lon })); // lat desc
  const fNodes: Node2[] = calib.nsControls.map((c) => ({ k: c.lat, v: c.y })); // lat desc
  const invNodes: Node2[] = calib.nsControls.map((c) => ({ k: c.y, v: c.lat })); // y asc

  const lonYonge = (lat: number): number => lerpDesc(lonNodes, lat);
  const f = (lat: number): number => lerpDesc(fNodes, lat);

  const c = calib.nsControls;
  const nsScale = (a: NsControl, b: NsControl): number =>
    (M_PER_DEG_LAT * Math.abs(a.lat - b.lat)) / Math.abs(a.y - b.y);

  return {
    calib,
    project({ lat, lon }: LatLon): MapPoint {
      return { x: YONGE_X + (lon - lonYonge(lat)) * WU_PER_DEG_LON, y: f(lat) };
    },
    unproject({ x, y }: MapPoint): LatLon {
      const lat = lerpAsc(invNodes, y);
      const lon = lonYonge(lat) + (x - YONGE_X) / WU_PER_DEG_LON;
      return { lat, lon };
    },
    zoneAt(y: number): Zone {
      if (y < ZONE_BOUNDARIES[1]) return 'north_york';
      if (y < ZONE_BOUNDARIES[2]) return 'fold';
      if (y < ZONE_BOUNDARIES[3]) return 'downtown';
      return 'water';
    },
    derivedZoneScales(): ZoneScales {
      // Each zone maps to exactly one N-S control segment; water shares the Bloor→shore slope.
      return {
        northYork: nsScale(c[0], c[1]),
        fold: nsScale(c[1], c[2]),
        downtown: nsScale(c[2], c[3]),
        water: nsScale(c[2], c[3]),
        ewMPerWu: EW_M_PER_WU,
      };
    },
  };
}

/** The default projection — bound to the verified TORONTO_CALIBRATION. */
export const TORONTO_PROJECTION = buildProjection(TORONTO_CALIBRATION);

/**
 * THE map→three.js axis seam that Phase 22+ builds on: map (x, y) → world [x, z] with
 * map-y (SOUTH) mapped straight to +Z, so **map north = −Z** and map east = +X. Camera-visible
 * decal faces are pinned against this convention — do not change it without updating them.
 */
export function mapToWorld({ x, y }: MapPoint): [number, number] {
  return [x, y];
}
