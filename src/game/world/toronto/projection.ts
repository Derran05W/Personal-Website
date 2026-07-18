// WGS84 → map world-units, for the Toronto "thermometer" map (TORONTO-MAP-SPEC-v2.md §1–§2).
//
// Map space: world-units (wu). y-DOWN is SOUTH (the §1 polygon convention), x-EAST. The
// projection is piecewise-linear in both axes, calibrated ONLY from researcher-verified
// anchors (data/toronto/anchors.json), transcribed once into TORONTO_CALIBRATION below.
//
//   N-S  f(lat): piecewise-linear through four control latitudes → fixed map y
//        (Finch→170, Sheppard→1170, Bloor→1830, shore→3700). North of Finch extends the
//        Finch–Sheppard slope; south of shore extends the Bloor–shore slope. This is what
//        folds ~9 km of midtown into a 660 wu corridor while keeping downtown near 1:1.
//   E-W  Yonge must read as a perfectly straight vertical at x=1500 (§2 — it is the spine
//        that makes the whole shape legible). Real Yonge tilts ~0.046° of lon over the map,
//        so the Yonge centreline longitude is itself a piecewise-linear function of latitude
//        (lonYonge, through every verified yonge_line anchor); x is the lon OFFSET from that
//        centreline, converted metres→wu at a single uniform E-W scale.
//
// Determinism: pure arithmetic, no state, no Math.random — same input → same output on every
// machine (the whole world generator depends on this, see world/rng.ts).

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

// CALIBRATION SINGLE SOURCE — every lat/lon here is transcribed verbatim from
// data/toronto/anchors.json (status:"verified" rows only). projection.test.ts fs-reads that
// file and fails on ANY drift in either direction. needs_agent rows never appear here.
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
    { id: 'yonge-finch', lat: 43.7814, y: 170 },
    { id: 'yonge-sheppard', lat: 43.7614, y: 1170 },
    { id: 'yonge-bloor', lat: 43.6708, y: 1830 },
    { id: 'shore-yonge', lat: 43.6404, y: 3700 },
  ],
} as const satisfies TorontoCalibration;

// Zone band edges in map y (§1/§2): [top, finch/sheppard fold, fold/downtown, shore, water bottom].
export const ZONE_BOUNDARIES = [0, 1170, 1830, 3700, 4100] as const;

// --- Metric constants ------------------------------------------------------------------
// One degree of latitude ≈ a fixed distance; one degree of longitude shrinks by cos(lat).
// 111320 m/° is the standard equatorial/meridian metric; REF_LAT is mid-map. These drive
// BOTH the E-W wu conversion and the reported N-S zone scales (metres per wu).
const M_PER_DEG_LAT = 111320;
const REF_LAT_DEG = 43.7;
const M_PER_DEG_LON = 111320 * Math.cos((REF_LAT_DEG * Math.PI) / 180);
const EW_M_PER_WU = 1.55; // §2: uniform E-W scale across every zone
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
