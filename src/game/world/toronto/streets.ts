// The Toronto street table (TORONTO-MAP-SPEC-v2.md §3a, phase-22-plan Decisions). Every §3a
// street is ONE axis-aligned centreline segment in MAP space (wu, y-down = south) — a stylized
// schematic; real curvature (Queens Quay bend, Dundas jog) is Phase 23 OSM debt.
//
// POSITIONS COME FROM DATA, never literals:
//   • N-S street x = project(proxy anchor).x. Yonge alone is x=1500 by definition (§2 spine).
//   • E-W street y = project(anchor).y — its yonge_line anchor (Finch…QueensQuay, Eglinton) or
//     a street_ref anchor (Bremner, Park Home, Richmond/Adelaide).
// Span endpoints are RESOLVED REFERENCES (other street ids or zone-edge tokens), never magic
// numbers. Streets whose proxy anchor is missing / needs_agent are OMITTED (loud, listed).
//
// Pure TS: no three/react, no fs at runtime. Anchor coords are transcribed into STREET_ANCHORS
// (guarded against anchors.json drift by streets.test.ts, exactly like projection.ts's
// TORONTO_CALIBRATION); yonge_line anchors are read from the projection's own calibration so
// they are never transcribed twice.

import { EDGE_PAD_WU, ROAD_CLASSES, type RoadClass } from '../../config/torontoMap';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { type LatLon, type MapPoint, TORONTO_PROJECTION } from './projection';

export type StreetAxis = 'ns' | 'ew';

/** Axis-aligned rectangle in MAP space (min/max corners, wu). */
export interface MapRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** A built street: its (post-nudge) centreline, resolved span, and ribbon rectangle. */
export interface Street {
  readonly id: string;
  readonly name: string;
  readonly cls: RoadClass;
  readonly axis: StreetAxis;
  /** Proxy anchor id the position derives from; `null` for Yonge (x fixed at 1500). */
  readonly positionRef: string | null;
  readonly width: number;
  readonly halfWidth: number;
  /** x for an 'ns' street, y for an 'ew' street (post boundary-nudge). */
  readonly centerline: number;
  /** [min, max] along the perpendicular axis (y for 'ns', x for 'ew'). */
  readonly span: readonly [number, number];
  readonly ribbon: MapRect;
  /** Centreline endpoints in map space (the two ends of the drawn segment). */
  readonly start: MapPoint;
  readonly end: MapPoint;
}

export interface BuiltStreets {
  readonly streets: readonly Street[];
  /** §3a streets dropped this build because their proxy anchor is missing / needs_agent. */
  readonly omissions: readonly string[];
}

// --- span-endpoint token grammar --------------------------------------------------------
// A span end resolves (given the map of final centrelines) to a single coordinate on the
// street's perpendicular axis.
type SpanEnd =
  | { readonly t: 'lit'; readonly v: number } // literal coord (rail-lands / quay stylizations)
  | { readonly t: 'shore' } // the §2 shoreline y (street-grid floor)
  | { readonly t: 'shorePad' } // shore minus EDGE_PAD (Yonge's south end)
  | { readonly t: 'zone'; readonly zone: ZoneKey; readonly side: 'lo' | 'hi' } // zone x-edge ± EDGE_PAD
  | { readonly t: 'street'; readonly id: string }; // another street's centreline

type ZoneKey = 'capsule' | 'fold' | 'downtown';

// Zone x-extents (spec §1 polygon): capsule x 1100–1900, fold corridor x 1200–1800, downtown
// block x 0–2400. The shoreline is map y 3700 (projection.ts nsControls / ZONE_BOUNDARIES[3]).
const ZONE_X: Record<ZoneKey, readonly [number, number]> = {
  capsule: [1100, 1900],
  fold: [1200, 1800],
  downtown: [0, 2400],
};
const SHORE_Y = 3700;

const s = (id: string): SpanEnd => ({ t: 'street', id });
const lit = (v: number): SpanEnd => ({ t: 'lit', v });
const zone = (z: ZoneKey, side: 'lo' | 'hi'): SpanEnd => ({ t: 'zone', zone: z, side });
const SHORE: SpanEnd = { t: 'shore' };
const SHORE_PAD: SpanEnd = { t: 'shorePad' };

interface StreetDef {
  readonly id: string;
  readonly name: string;
  readonly cls: RoadClass;
  readonly axis: StreetAxis;
  /** Proxy anchor id, or `null` for Yonge (spine, x=1500). */
  readonly positionRef: string | null;
  readonly span: readonly [SpanEnd, SpanEnd];
}

// The full §3a table + Eglinton (the fold flavour mini-node, §2 — not in the §3a class table;
// classed 'major' here to match real Eglinton's arterial tier). Order is stable and drives
// deterministic downstream ordering.
export const STREET_DEFS: readonly StreetDef[] = [
  // --- N-S (x from proxy; span along y) ---
  { id: 'yonge', name: 'Yonge St', cls: 'spine', axis: 'ns', positionRef: null, span: [lit(20), SHORE_PAD] },
  { id: 'university', name: 'University Ave', cls: 'artery', axis: 'ns', positionRef: 'street-university', span: [s('bloor'), s('front')] },
  { id: 'spadina', name: 'Spadina Ave', cls: 'artery', axis: 'ns', positionRef: 'street-spadina', span: [s('bloor'), SHORE] },
  { id: 'bathurst', name: 'Bathurst St', cls: 'major', axis: 'ns', positionRef: 'street-bathurst', span: [s('bloor'), SHORE] },
  { id: 'bay', name: 'Bay St', cls: 'major', axis: 'ns', positionRef: 'queen-bay', span: [s('bloor'), SHORE] },
  { id: 'church', name: 'Church St', cls: 'major', axis: 'ns', positionRef: 'queen-church', span: [s('bloor'), SHORE] },
  { id: 'jarvis', name: 'Jarvis St', cls: 'major', axis: 'ns', positionRef: 'queen-jarvis', span: [s('bloor'), SHORE] },
  { id: 'john', name: 'John St', cls: 'minor', axis: 'ns', positionRef: 'street-john', span: [s('queen'), s('front')] },
  { id: 'portland', name: 'Portland St', cls: 'minor', axis: 'ns', positionRef: 'street-portland', span: [s('queen'), s('front')] },
  { id: 'york', name: 'York St', cls: 'minor', axis: 'ns', positionRef: 'street-york', span: [s('king'), SHORE] },
  // --- E-W (y from anchor; span along x) ---
  { id: 'finch', name: 'Finch Ave', cls: 'major', axis: 'ew', positionRef: 'yonge-finch', span: [zone('capsule', 'lo'), zone('capsule', 'hi')] },
  { id: 'parkhome', name: 'Park Home Ave', cls: 'minor', axis: 'ew', positionRef: 'street-parkhome', span: [zone('capsule', 'lo'), zone('capsule', 'hi')] },
  { id: 'sheppard', name: 'Sheppard Ave', cls: 'major', axis: 'ew', positionRef: 'yonge-sheppard', span: [zone('capsule', 'lo'), zone('capsule', 'hi')] },
  { id: 'eglinton', name: 'Eglinton Ave', cls: 'major', axis: 'ew', positionRef: 'yonge-eglinton', span: [zone('fold', 'lo'), zone('fold', 'hi')] },
  { id: 'bloor', name: 'Bloor St', cls: 'artery', axis: 'ew', positionRef: 'yonge-bloor', span: [zone('downtown', 'lo'), zone('downtown', 'hi')] },
  { id: 'college', name: 'College St', cls: 'major', axis: 'ew', positionRef: 'yonge-college', span: [zone('downtown', 'lo'), zone('downtown', 'hi')] },
  { id: 'dundas', name: 'Dundas St', cls: 'major', axis: 'ew', positionRef: 'yonge-dundas', span: [zone('downtown', 'lo'), zone('downtown', 'hi')] },
  { id: 'richmond', name: 'Richmond St', cls: 'minor', axis: 'ew', positionRef: 'street-richmond', span: [s('university'), s('jarvis')] },
  { id: 'adelaide', name: 'Adelaide St', cls: 'minor', axis: 'ew', positionRef: 'street-adelaide', span: [s('university'), s('jarvis')] },
  { id: 'queen', name: 'Queen St', cls: 'major', axis: 'ew', positionRef: 'yonge-queen', span: [zone('downtown', 'lo'), zone('downtown', 'hi')] },
  { id: 'king', name: 'King St', cls: 'major', axis: 'ew', positionRef: 'yonge-king', span: [zone('downtown', 'lo'), zone('downtown', 'hi')] },
  { id: 'front', name: 'Front St', cls: 'major', axis: 'ew', positionRef: 'yonge-front', span: [s('bathurst'), lit(1900)] },
  { id: 'bremner', name: 'Bremner Blvd', cls: 'minor', axis: 'ew', positionRef: 'street-bremner', span: [s('spadina'), s('york')] },
  { id: 'queensquay', name: 'Queens Quay', cls: 'major', axis: 'ew', positionRef: 'yonge-queensquay', span: [lit(200), lit(2200)] },
];

// Transcribed VERBATIM from data/toronto/anchors.json — only the non-yonge_line proxies (the
// street_ref rows + the three cross_lon proxies Bay/Church/Jarvis borrow). yonge_line anchors
// are NOT duplicated here; they are read from TORONTO_PROJECTION.calib (single source, already
// guarded by projection.test.ts). streets.test.ts fs-reads anchors.json and fails on ANY drift.
// If a proxy row flips back to needs_agent, DELETE it here → its street auto-omits.
export const STREET_ANCHORS: Readonly<Record<string, LatLon>> = {
  'street-university': { lat: 43.6528, lon: -79.3878 },
  'street-spadina': { lat: 43.6597, lon: -79.4008 },
  'street-bathurst': { lat: 43.6661, lon: -79.4111 },
  'queen-bay': { lat: 43.6525, lon: -79.3839 },
  'queen-church': { lat: 43.6532, lon: -79.3765 },
  'queen-jarvis': { lat: 43.6546, lon: -79.3729 },
  'street-john': { lat: 43.6477, lon: -79.3903 },
  'street-portland': { lat: 43.6425, lon: -79.4003 },
  'street-york': { lat: 43.6455, lon: -79.3816 },
  'street-parkhome': { lat: 43.7697, lon: -79.4147 },
  'street-bremner': { lat: 43.6425, lon: -79.386 },
  'street-richmond': { lat: 43.6519, lon: -79.3786 },
  'street-adelaide': { lat: 43.6505, lon: -79.3778 },
};

/** Lat/lon for a proxy anchor, or `null` if it is not available (needs_agent / missing) — the
 * single point where an omitted street is detected. yonge_line anchors come from the
 * projection calibration; everything else from the transcribed STREET_ANCHORS. */
function anchorLatLon(id: string): LatLon | null {
  const cal = TORONTO_PROJECTION.calib.yongeLine.find((a) => a.id === id);
  if (cal) return { lat: cal.lat, lon: cal.lon };
  return STREET_ANCHORS[id] ?? null;
}

/** Raw centreline coord for a def (x for 'ns', y for 'ew'), before any boundary-nudge. */
function rawCenterline(def: StreetDef): number {
  if (def.positionRef === null) return 1500; // Yonge — the spine, pinned (§2)
  const ll = anchorLatLon(def.positionRef);
  if (ll === null) throw new Error(`streets: ${def.id} proxy ${def.positionRef} not available`);
  const p = TORONTO_PROJECTION.project(ll);
  return def.axis === 'ns' ? p.x : p.y;
}

function resolveEnd(end: SpanEnd, centerlines: ReadonlyMap<string, number>): number {
  switch (end.t) {
    case 'lit':
      return end.v;
    case 'shore':
      return SHORE_Y;
    case 'shorePad':
      return SHORE_Y - EDGE_PAD_WU;
    case 'zone': {
      const [lo, hi] = ZONE_X[end.zone];
      return end.side === 'lo' ? lo + EDGE_PAD_WU : hi - EDGE_PAD_WU;
    }
    case 'street': {
      const c = centerlines.get(end.id);
      if (c === undefined) throw new Error(`streets: ${end.id} span reference not resolvable`);
      return c;
    }
  }
}

function resolveSpan(def: StreetDef, centerlines: ReadonlyMap<string, number>): [number, number] {
  const a = resolveEnd(def.span[0], centerlines);
  const b = resolveEnd(def.span[1], centerlines);
  return [Math.min(a, b), Math.max(a, b)];
}

/** The four ribbon corners for a centreline `c` and span `[lo,hi]`. */
function ribbonCorners(axis: StreetAxis, c: number, halfWidth: number, span: readonly [number, number]): MapPoint[] {
  const [lo, hi] = span;
  if (axis === 'ew') {
    return [
      { x: lo, y: c - halfWidth },
      { x: hi, y: c - halfWidth },
      { x: lo, y: c + halfWidth },
      { x: hi, y: c + halfWidth },
    ];
  }
  return [
    { x: c - halfWidth, y: lo },
    { x: c + halfWidth, y: lo },
    { x: c - halfWidth, y: hi },
    { x: c + halfWidth, y: hi },
  ];
}

function cornersInside(corners: readonly MapPoint[]): boolean {
  return corners.every((p) => pointInPolygon(p, PLAYABLE_POLYGON));
}

/**
 * BOUNDARY-NUDGE (general, geometric): if a street's raw ribbon pokes out of the polygon —
 * which happens exactly when its centreline sits ON a polygon/zone boundary (Bloor at the
 * downtown top y=1830, Sheppard at the capsule bottom y=1170) — shift the centreline inward by
 * exactly half a ribbon width so the boundary-side ribbon edge lands back on the boundary
 * (boundary-inclusive = inside). Tries the raw position first (nudge is minimal, never
 * arbitrary), then ±halfWidth, and keeps the first fully-contained candidate.
 */
function nudgedCenterline(def: StreetDef, raw: number, halfWidth: number, span: readonly [number, number]): number {
  if (cornersInside(ribbonCorners(def.axis, raw, halfWidth, span))) return raw;
  for (const cand of [raw + halfWidth, raw - halfWidth]) {
    if (cornersInside(ribbonCorners(def.axis, cand, halfWidth, span))) return cand;
  }
  return raw; // unreachable for the current polygon; keep raw rather than invent a position
}

function ribbonOf(axis: StreetAxis, c: number, halfWidth: number, span: readonly [number, number]): MapRect {
  const [lo, hi] = span;
  if (axis === 'ew') return { minX: lo, minY: c - halfWidth, maxX: hi, maxY: c + halfWidth };
  return { minX: c - halfWidth, minY: lo, maxX: c + halfWidth, maxY: hi };
}

/**
 * Build the whole street table. Three phases so cross-street span references and the
 * boundary-nudge resolve cleanly:
 *   1. raw centrelines for every available street (drop the rest → omissions);
 *   2. boundary-nudge each — only Bloor & Sheppard actually move, and neither references
 *      another street in its span, so raw centrelines suffice to decide the nudge;
 *   3. final spans + ribbons using the NUDGED centrelines.
 */
export function buildStreets(): BuiltStreets {
  const omissions: string[] = [];
  const active = STREET_DEFS.filter((def) => {
    if (def.positionRef === null) return true;
    if (anchorLatLon(def.positionRef) !== null) return true;
    omissions.push(def.id);
    return false;
  });

  // Phase 1 + 2: centreline (raw, then nudged).
  const centerlines = new Map<string, number>();
  for (const def of active) centerlines.set(def.id, rawCenterline(def));
  for (const def of active) {
    const halfWidth = ROAD_CLASSES[def.cls] / 2;
    const rawSpan = resolveSpan(def, centerlines); // raw refs; exact for the two nudged (zone spans)
    const nudged = nudgedCenterline(def, centerlines.get(def.id)!, halfWidth, rawSpan);
    centerlines.set(def.id, nudged);
  }

  // Phase 3: final spans + ribbons against the nudged centrelines.
  const streets: Street[] = active.map((def) => {
    const centerline = centerlines.get(def.id)!;
    const width = ROAD_CLASSES[def.cls];
    const halfWidth = width / 2;
    const span = resolveSpan(def, centerlines);
    const ribbon = ribbonOf(def.axis, centerline, halfWidth, span);
    const start: MapPoint = def.axis === 'ns' ? { x: centerline, y: span[0] } : { x: span[0], y: centerline };
    const end: MapPoint = def.axis === 'ns' ? { x: centerline, y: span[1] } : { x: span[1], y: centerline };
    return {
      id: def.id,
      name: def.name,
      cls: def.cls,
      axis: def.axis,
      positionRef: def.positionRef,
      width,
      halfWidth,
      centerline,
      span,
      ribbon,
      start,
      end,
    };
  });

  return { streets, omissions };
}
