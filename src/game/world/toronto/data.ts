// Toronto map data schema — pure runtime validators for the four `data/toronto/*.json`
// files (docs/map/TORONTO-MAP-SPEC-v2.md, companion data files per its header). This
// module deliberately does NOT `import … from '../../../../data/toronto/*.json'` — the
// map-researcher agent (.claude/agents/map-researcher.md) and tools/research/
// run_researchers.py patch those files on disk independently of the game build, and a
// static JSON import would pull that data (and any future growth of it) straight into the
// game chunk even for callers who only want the *types*. Callers that need the actual data
// read the file themselves (fs at build/tool time, or a future fetch at runtime) and pass
// the parsed `unknown` through the matching `validate*` function here — the single gate
// that turns "whatever is on disk right now" into a typed, checked shape. Every validator
// throws a plain `Error` with a `$.path.to.field`-style message pinpointing exactly what
// violated the contract, so a bad hand-edit or a malformed agent patch fails loud in CI
// (src/game/world/toronto/data.test.ts) instead of silently corrupting the map.
//
// `unknown` + narrowing only — no `any` anywhere (CLAUDE.md hard requirement).

// --- generic unknown-narrowing helpers -------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path}: expected an array, got ${describe(value)}`);
  }
  return value;
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path}: expected a string, got ${describe(value)}`);
  }
  return value;
}

function assertNonEmptyString(value: unknown, path: string): string {
  const s = assertString(value, path);
  if (s.length === 0) throw new Error(`${path}: expected a non-empty string`);
  return s;
}

function assertStringArray(value: unknown, path: string): string[] {
  return assertArray(value, path).map((item, i) => assertString(item, `${path}[${i}]`));
}

function assertFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path}: expected a finite number, got ${describe(value)}`);
  }
  return value;
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const s = assertString(value, path);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new Error(`${path}: expected one of [${allowed.join(', ')}], got "${s}"`);
  }
  return s as T;
}

// === anchors.json ========================================================================
// Calibration anchors for the piecewise map projection (spec §2). A researcher (the
// map-researcher agent) fills these in over multiple concurrent rounds, so this validator
// checks STRUCTURE only — never entry counts, ordering, or specific coordinate values (see
// data.test.ts's header note for why).

export const ANCHOR_KINDS = ['yonge_line', 'cross_lon', 'shore'] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export const ANCHOR_STATUSES = ['verified', 'needs_agent'] as const;
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

// Shared with building-specs.json's per-building confidence — same three-level scale.
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Lat/lon bounding box a "verified" anchor's coordinates must fall inside — generously
 * covers the whole GTA, just enough to catch a swapped lat/lon or a fat-fingered digit. */
const TORONTO_LAT_RANGE = [43.5, 43.9] as const;
const TORONTO_LON_RANGE = [-79.7, -79.1] as const;

export interface Anchor {
  readonly id: string;
  readonly name: string;
  readonly kind: AnchorKind;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly src: string;
  readonly status: AnchorStatus;
  /** Optional fields — present on some entries (in-progress research), absent on others. */
  readonly confidence?: ConfidenceLevel;
  readonly notes?: string;
  /** A nearby real-world proxy used when the exact intersection has no direct source. */
  readonly proxy?: string;
  /** A secondary corroborating source, when one was found. */
  readonly src2?: string;
}

export interface AnchorsFile {
  readonly _meta: Record<string, unknown>;
  readonly anchors: readonly Anchor[];
}

function validateAnchor(value: unknown, path: string): Anchor {
  const o = assertRecord(value, path);
  const id = assertNonEmptyString(o.id, `${path}.id`);
  const name = assertNonEmptyString(o.name, `${path}.name`);
  const kind = assertOneOf(o.kind, ANCHOR_KINDS, `${path}.kind`);
  const status = assertOneOf(o.status, ANCHOR_STATUSES, `${path}.status`);
  const src = assertString(o.src, `${path}.src`); // '' is valid for a needs_agent stub

  const lat = o.lat === null ? null : assertFiniteNumber(o.lat, `${path}.lat`);
  const lon = o.lon === null ? null : assertFiniteNumber(o.lon, `${path}.lon`);

  if (status === 'verified') {
    if (lat === null || lon === null) {
      throw new Error(`${path}: status "verified" requires non-null lat and lon`);
    }
    if (lat < TORONTO_LAT_RANGE[0] || lat > TORONTO_LAT_RANGE[1]) {
      throw new Error(`${path}.lat: ${lat} outside verified range [${TORONTO_LAT_RANGE.join(', ')}]`);
    }
    if (lon < TORONTO_LON_RANGE[0] || lon > TORONTO_LON_RANGE[1]) {
      throw new Error(`${path}.lon: ${lon} outside verified range [${TORONTO_LON_RANGE.join(', ')}]`);
    }
    if (src.length === 0) {
      throw new Error(`${path}.src: status "verified" requires a non-empty src`);
    }
  } else {
    if (lat !== null || lon !== null) {
      throw new Error(`${path}: status "needs_agent" requires null lat and null lon`);
    }
  }

  const confidence =
    o.confidence === undefined ? undefined : assertOneOf(o.confidence, CONFIDENCE_LEVELS, `${path}.confidence`);
  const notes = o.notes === undefined ? undefined : assertString(o.notes, `${path}.notes`);
  const proxy = o.proxy === undefined ? undefined : assertString(o.proxy, `${path}.proxy`);
  const src2 = o.src2 === undefined ? undefined : assertString(o.src2, `${path}.src2`);

  return { id, name, kind, lat, lon, src, status, confidence, notes, proxy, src2 };
}

export function validateAnchors(u: unknown): AnchorsFile {
  const root = assertRecord(u, '$');
  const _meta = assertRecord(root._meta, '$._meta');
  const anchors = assertArray(root.anchors, '$.anchors').map((item, i) =>
    validateAnchor(item, `$.anchors[${i}]`),
  );
  return { _meta, anchors };
}

// === building-specs.json =================================================================
// The §3c height-curve table. `expected_game_h_wu` is the spec's own precomputed value —
// stored and validated verbatim; a separate rendering-side module recomputes h_game from
// the curve and is expected to match it, not the other way around.

// Spec §4's material enum — the single source every skyline building's material must match
// (spec §3c's own test list: "every skyline building's material matches building-specs.json").
export const BUILDING_MATERIALS = [
  'glass_black',
  'glass_blue',
  'glass_gold',
  'glass_green',
  'marble_white',
  'granite_red',
  'brick_red',
  'brick_yellow',
  'limestone',
  'precast_grey',
  'storefront',
] as const;
export type BuildingMaterial = (typeof BUILDING_MATERIALS)[number];

export interface BuildingSpec {
  readonly id: string;
  readonly name: string;
  readonly real_h_m: number;
  readonly floors: number | null;
  readonly expected_game_h_wu: number;
  readonly footprint_wu: number;
  readonly material: BuildingMaterial;
  readonly confidence: ConfidenceLevel;
  readonly notes: string;
  /** Rogers Centre only: dome diameter in world units (footprint_wu doubles as this too). */
  readonly dome_diameter_wu?: number;
  /** Eaton Centre galleria / Union Station: a human "N long" qualifier on footprint_wu. */
  readonly footprint_note?: string;
}

export interface BuildingSpecsFile {
  readonly _meta: Record<string, unknown>;
  readonly buildings: readonly BuildingSpec[];
}

function validateBuildingSpec(value: unknown, path: string): BuildingSpec {
  const o = assertRecord(value, path);
  const id = assertNonEmptyString(o.id, `${path}.id`);
  const name = assertNonEmptyString(o.name, `${path}.name`);

  const real_h_m = assertFiniteNumber(o.real_h_m, `${path}.real_h_m`);
  if (real_h_m <= 0) throw new Error(`${path}.real_h_m: must be > 0, got ${real_h_m}`);

  const floors = o.floors === null ? null : assertFiniteNumber(o.floors, `${path}.floors`);

  const expected_game_h_wu = assertFiniteNumber(o.expected_game_h_wu, `${path}.expected_game_h_wu`);
  if (expected_game_h_wu <= 0) {
    throw new Error(`${path}.expected_game_h_wu: must be > 0, got ${expected_game_h_wu}`);
  }

  const footprint_wu = assertFiniteNumber(o.footprint_wu, `${path}.footprint_wu`);
  if (footprint_wu <= 0) throw new Error(`${path}.footprint_wu: must be > 0, got ${footprint_wu}`);

  const material = assertOneOf(o.material, BUILDING_MATERIALS, `${path}.material`);
  const confidence = assertOneOf(o.confidence, CONFIDENCE_LEVELS, `${path}.confidence`);
  const notes = assertString(o.notes, `${path}.notes`);

  const dome_diameter_wu =
    o.dome_diameter_wu === undefined ? undefined : assertFiniteNumber(o.dome_diameter_wu, `${path}.dome_diameter_wu`);
  const footprint_note =
    o.footprint_note === undefined ? undefined : assertString(o.footprint_note, `${path}.footprint_note`);

  return {
    id,
    name,
    real_h_m,
    floors,
    expected_game_h_wu,
    footprint_wu,
    material,
    confidence,
    notes,
    dome_diameter_wu,
    footprint_note,
  };
}

export function validateBuildingSpecs(u: unknown): BuildingSpecsFile {
  const root = assertRecord(u, '$');
  const _meta = assertRecord(root._meta, '$._meta');
  const seenIds = new Set<string>();
  const buildings = assertArray(root.buildings, '$.buildings').map((item, i) => {
    const path = `$.buildings[${i}]`;
    const spec = validateBuildingSpec(item, path);
    if (seenIds.has(spec.id)) {
      throw new Error(`${path}.id: duplicate id "${spec.id}"`);
    }
    seenIds.add(spec.id);
    return spec;
  });
  return { _meta, buildings };
}

// === places.json ==========================================================================
// The §8 places layer: named real-world spots (restaurants, shops, one rooftop-sign prop)
// that get FASCIA decals. `_meta` is deliberately passthrough here — unlike the other three
// files it carries free-form bookkeeping (status_key, already_mapped_do_not_duplicate) with
// no fixed shape, so this validator carries it through unexamined rather than constraining it.

export const PLACE_STATUSES = ['verified', 'knowledge', 'needs_agent'] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

export const PLACE_ZONES = ['downtown', 'north_york'] as const;
export type PlaceZone = (typeof PLACE_ZONES)[number];

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export interface Place {
  readonly name: string;
  readonly address: string;
  readonly zone: PlaceZone;
  readonly category: string;
  readonly status: PlaceStatus;
  readonly brand_color: string;
  readonly building_look: string;
  readonly logo_hint: string;
  readonly recognizability: 1 | 2 | 3;
}

export interface PlacesFile {
  /** Passthrough — no shape enforced (see module header). */
  readonly _meta: unknown;
  readonly places: readonly Place[];
}

function validatePlace(value: unknown, path: string): Place {
  const o = assertRecord(value, path);
  const name = assertNonEmptyString(o.name, `${path}.name`);
  const address = assertNonEmptyString(o.address, `${path}.address`);
  const zone = assertOneOf(o.zone, PLACE_ZONES, `${path}.zone`);
  const category = assertNonEmptyString(o.category, `${path}.category`);
  const status = assertOneOf(o.status, PLACE_STATUSES, `${path}.status`);

  const brand_color = assertString(o.brand_color, `${path}.brand_color`);
  if (!HEX_COLOR_RE.test(brand_color)) {
    throw new Error(`${path}.brand_color: expected /^#[0-9a-f]{6}$/i, got "${brand_color}"`);
  }

  const building_look = assertNonEmptyString(o.building_look, `${path}.building_look`);
  const logo_hint = assertNonEmptyString(o.logo_hint, `${path}.logo_hint`);

  const recognizability = assertFiniteNumber(o.recognizability, `${path}.recognizability`);
  if (recognizability !== 1 && recognizability !== 2 && recognizability !== 3) {
    throw new Error(`${path}.recognizability: expected 1, 2, or 3, got ${recognizability}`);
  }

  return { name, address, zone, category, status, brand_color, building_look, logo_hint, recognizability };
}

export function validatePlaces(u: unknown): PlacesFile {
  const root = assertRecord(u, '$');
  const _meta = root._meta; // passthrough — intentionally unvalidated
  const places = assertArray(root.places, '$.places').map((item, i) => validatePlace(item, `$.places[${i}]`));
  return { _meta, places };
}

// === model-sources.json ===================================================================
// The §7 free-geometry-sourcing summary (4 entries). Loose by design: only `license` and
// `decision` are spec-mandated non-empty fields — everything else here is descriptive
// research bookkeeping, not gameplay-critical data, so this validator checks presence/type
// but doesn't lock down enums that the spec itself never defined (e.g. `status`).

export interface ModelSource {
  readonly id: string;
  readonly name: string;
  /** As given in the spec — never invented. `null` when the spec named the source but gave
   * no literal URL (true for all 4 current entries). */
  readonly url_hint: string | null;
  readonly formats: readonly string[];
  readonly license: string;
  readonly decision: string;
  readonly status: string;
  readonly src: string;
  readonly notes?: string;
}

export interface ModelSourcesFile {
  readonly _meta: Record<string, unknown>;
  readonly sources: readonly ModelSource[];
}

function validateModelSource(value: unknown, path: string): ModelSource {
  const o = assertRecord(value, path);
  const id = assertNonEmptyString(o.id, `${path}.id`);
  const name = assertNonEmptyString(o.name, `${path}.name`);
  const url_hint = o.url_hint === null ? null : assertNonEmptyString(o.url_hint, `${path}.url_hint`);
  const formats = assertStringArray(o.formats, `${path}.formats`);
  const license = assertNonEmptyString(o.license, `${path}.license`);
  const decision = assertNonEmptyString(o.decision, `${path}.decision`);
  const status = assertNonEmptyString(o.status, `${path}.status`);
  const src = assertNonEmptyString(o.src, `${path}.src`);
  const notes = o.notes === undefined ? undefined : assertString(o.notes, `${path}.notes`);

  return { id, name, url_hint, formats, license, decision, status, src, notes };
}

export function validateModelSources(u: unknown): ModelSourcesFile {
  const root = assertRecord(u, '$');
  const _meta = assertRecord(root._meta, '$._meta');
  const sources = assertArray(root.sources, '$.sources').map((item, i) =>
    validateModelSource(item, `$.sources[${i}]`),
  );
  return { _meta, sources };
}
