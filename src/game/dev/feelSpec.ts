// Phase 74 — THE FEEL SPEC, machine-readable. The acceptance ORACLE that Phases 76–94 are judged
// against. Its prose twin (rationale, the user-facing table, the change protocol) is
// `.planning/feel/FEEL-SPEC.md`; this file is the same content in a shape a later phase can
// interrogate programmatically — "did I hit the target for metric X, and am I even allowed to
// call it yet?"
//
// --- WHAT THIS FILE IS NOT ---------------------------------------------------------------------
// It is NOT a game tunable. Nothing in the shipped game reads it, nothing here changes how the car
// drives, and it deliberately lives in `dev/` rather than `config/` for exactly that reason:
// `config/` is the single source of truth for values the GAME consumes (CLAUDE.md's directory
// contract), and putting an acceptance oracle there would blur the one boundary that makes the
// Phase 74 byte-identity guarantee absolute. `dev/` never enters the production chunk.
//
// It is also NOT a claim about Smashy Road's internals. The Phase 74 reference research
// (`.planning/feel/smashy-road-research-raw.md`) returned **14 explicitly unverifiable questions**
// and almost no quantities: acceleration curves, camera geometry, traffic density and police
// intercept logic are all unpublished, and Bearbit Studios has no postmortem on record. Every row
// below therefore carries a `source` tag, and **no row cites the reference for a number the
// reference never stated**. Where a target cannot be honestly derived yet it is `null` with a
// rationale — an honest null beats an invented number, because an invented number would be laundered
// into "the measured target" by the third phase that reads it.
//
// --- THIS MODULE IS A LEAF ---------------------------------------------------------------------
// It imports nothing. That is deliberate (the `config/layering.ts` precedent): an oracle with zero
// imports can never drag a runtime dependency into dev-only code, can be read by a script, a test
// or a battery without booting the game, and is trivially JSON-serializable — which is a pinned
// invariant below, not an accident. The one place a compile-time link to the telemetry shape would
// help — `snapshotPath` — is instead validated at TEST time against a real
// `FeelTelemetrySnapshot`, keeping the leaf property while still failing loudly on drift.
//
// --- THE CHANGE PROTOCOL (this is law, same class as config/layering.ts) ------------------------
// 1. A target may be changed only by the phase chartered to move that metric (`owner`), or by the
//    user. A passing phase does not get to soften a gate it is failing.
// 2. Changing ANY value here = editing **three** things in ONE commit: `.planning/feel/FEEL-SPEC.md`
//    (the rationale), this file (the oracle), and `feelSpec.test.ts` (the pin). The test failing is
//    the intended tripwire, not an obstacle.
// 3. Promoting a row watch → GATE (or demoting) requires a recorded rationale in BOTH documents.
// 4. A `provisional` row that survives its trigger phase without being re-derived is a bug in that
//    phase's exit, not a licence to keep the old number.
//
// --- HOW TO READ A ROW --------------------------------------------------------------------------
// `baseline` is ALWAYS measured — it is what the shipped build did at Phase 74. `source` describes
// the provenance of the **target**, not of the baseline; a row with `target: null` and
// `source: 'design-target'` is saying "when a number is finally set here it will be reasoned from
// the game's own constraints, and it will not be smuggled in from the reference".
//
// `mode` is load-bearing and not decorative. The two harness modes are NOT interchangeable
// (FEEL-SPEC.md's measurement-conditions law): probes run on a cleared straight with traffic,
// transit and parked cars OFF — the only way a turn radius at 15 m/s is measurable at all — and
// routes run on the fully live city, the only way contact and stuck statistics mean anything. A
// response number harvested from a route run, or a contact number from a probe run, is invalid.
//
// Every metric here is a TIME INTEGRAL or a PHYSICAL QUANTITY (m, m/s, s, rad/s, or a ratio
// reported with its denominator). That is forced: this container renders under SwiftShader at
// roughly 4–18 fps, so a frame count would measure the container. The two ratio rows that ARE
// frame-based (`steerClampFrac`, `airtimeFrac`) say so in their `baselineNote` and carry the
// denominator with them. **Do not add a frame-count metric to this spec.**

// =================================================================================================
// Vocabulary
// =================================================================================================

/** Schema tag, mirroring `feelTelemetry.ts`'s FEEL_TELEMETRY_SCHEMA. Bump on a breaking reshape. */
export const FEEL_SPEC_SCHEMA = 'feel-spec/1' as const;

/** The four families the part file groups the feel complaints into. */
export type FeelMetricGroup = 'response' | 'cornering' | 'contact' | 'stability';

/** Which half of the lab produces the number. See the `mode` note in the header — mixing them is
 * an invalid measurement, not a minor inaccuracy. */
export type FeelMeasurementMode = 'probe' | 'route';

/**
 * Where a TARGET came from. (The baseline is always measured; this tag is about the target.)
 * - `reference-verified` — a sourced, citable fact about the reference game. Rare by construction:
 *   the research returned direction, essentially never a value. A row claiming this must cite.
 * - `measured-baseline` — our own Phase 74 measurement, moved by a stated factor in a stated
 *   direction by the owning phase.
 * - `design-target` — reasoned from the game's OWN constraints (road width, block length, the
 *   camera's visible band). The reasoning is written out in `rationale`; it is not taste asserted
 *   as fact.
 */
export type FeelMetricSource = 'reference-verified' | 'measured-baseline' | 'design-target';

/**
 * - `firm` — safe to gate on now; independent of the Phase 75 road widths and the Phase 76 camera.
 * - `provisional` — the METRIC is firm, the TARGET VALUE re-derives after a named later phase.
 *   Flagged so a later session re-pins it deliberately instead of discovering the drift.
 */
export type FeelMetricStability = 'firm' | 'provisional';

/**
 * How `value` is compared to `target`. Explicit rather than implied, because "lower is better" is
 * not universal here: `peakYawRateRadS` and `lateralSlipFrac` are rows the drive-model phase is
 * expected to RAISE. It also gives the baseline-selection rule below an unambiguous direction.
 */
export type FeelComparison = 'at-most' | 'at-least' | 'within';

// =================================================================================================
// The three standing caveats — the honesty metadata, referenced BY rows
// =================================================================================================

/**
 * Caveats that apply to whole classes of row. They live here, referenced by id from
 * `FeelSpecRow.caveats`, rather than being copy-pasted into twenty rationales: one text to keep
 * true, and a test can assert every caveat is actually claimed by somebody.
 */
export const FEEL_SPEC_CAVEATS = {
  /**
   * THE VARIANCE CAVEAT. `chase3` returned **0, 2 and 12** unrecoverable stuck events on three
   * runs of the IDENTICAL route and seed — the only difference between them was the quality tier,
   * and physics is a fixed 60 Hz step that quality tiers do not touch, so that spread is
   * measurement noise, not a tier effect. A single run is therefore not a signal. This is the same
   * lesson the standing chaos bench taught at Phase 47, where one unchanged build measured 102,480
   * and 120,019 triangles on two runs of the same circuit. Rows carrying this caveat must clear
   * `FEEL_VERDICT_RUNS.highVarianceMinRuns` runs before anyone reads a verdict off them, and a
   * report must state the observed range rather than a single number.
   */
  singleRunIsNotASignal:
    'chase3 measured 0 / 2 / 12 unrecoverable stuck events on three runs of the identical route and seed (tier varied; physics is a tier-invariant fixed 60 Hz step). One run is not a signal — report the range, and take no verdict below FEEL_VERDICT_RUNS.highVarianceMinRuns runs.',

  /**
   * THE DRIVER CONFOUND. Route mode is driven by a synthetic pure-pursuit driver, and pure pursuit
   * cuts corners — into a streetwall that sits right at the ribbon edge on this map. It hits
   * buildings far more than a human would, which inflates every route-mode stuck and contact
   * count. The full derivation (including a circular-measurement artefact that was FOUND AND FIXED
   * this phase — the shipped 3.0 s driver-recovery timer sat above the detector's 2.5 s
   * unrecoverable budget, so every wedge scored "unrecoverable" by construction, 100 % cause-tagged
   * `building`, zero `onVehicle`) is in the `FEEL_STEERING` doc comment in `dev/feelDrives.ts`.
   * Consequence, and it is the reason this caveat is a first-class field: route-mode stuck counts
   * are WATCH evidence. The Phase 77 GATE rests on the purpose-built trap probes its part-file
   * section mandates, with these numbers as live-city corroboration.
   */
  syntheticDriverConfound:
    'Route mode is driven by a synthetic pure-pursuit driver that cuts corners into a streetwall sitting at the ribbon edge, so it strikes buildings far more than a human would. Route-mode stuck/contact counts are driver-influenced WATCH evidence; the Phase 77 gate rests on purpose-built trap probes. Derivation: FEEL_STEERING in dev/feelDrives.ts.',

  /**
   * THE COVERAGE GAP. Across all twelve canonical route runs the stuck-cause histogram produced
   * exactly **two** `onVehicle` events (chase3 at high tier, chase3 at med tier — one each) out of
   * 76 stuck events total. `onVehicle` is the ride-up-onto-another-car class that IS user issue #14
   * and Phase 77's actual target. Route drives barely sample it, so no amount of route running will
   * validate a fix for it. Phase 77 must build the trap probe.
   */
  onVehicleUndersampled:
    'Route drives barely sample the onVehicle stuck class: 2 events out of 76 across all 12 canonical runs, both on chase3. That class IS user issue #14 and Phase 77 target; it cannot be validated by route drives alone.',
} as const;

export type FeelCaveatId = keyof typeof FEEL_SPEC_CAVEATS;

/**
 * THE VARIANCE LAW, as a constant (Phase 74). How many runs of a metric must exist before anybody
 * is entitled to a verdict on it.
 *
 * `highVarianceMinRuns` is 3 and it is not a round-number guess: it is the smallest count that
 * would have exposed the 0 / 2 / 12 spread actually observed on `chase3`. Two runs could have
 * returned 0 and 2 and looked settled. This is the Phase 47 chaos-bench lesson expressed as a
 * number instead of a warning in a notes file — a warning in a notes file did not stop the same
 * mistake being available here.
 *
 * `probeQuantizationMinRuns` covers a different failure mode with the same remedy: probe timings
 * resolve no finer than one rAF interval (measured 0.038–0.050 s in this container), so a
 * sub-quantum difference between two single runs is noise wearing a decimal point.
 */
export const FEEL_VERDICT_RUNS = {
  /** Rows with no known variance problem: one run is admissible evidence. */
  defaultMinRuns: 1,
  /** Rows carrying `singleRunIsNotASignal`. Justified by the measured 0/2/12 chase3 spread. */
  highVarianceMinRuns: 3,
  /** Probe-timing rows whose resolution is one frame interval under SwiftShader. */
  probeQuantizationMinRuns: 3,
  /** The measured rAF sample interval band the quantization rule is derived from (seconds). */
  observedSampleIntervalSecRange: [0.038, 0.05],
} as const;

// =================================================================================================
// The row shape
// =================================================================================================

export interface FeelSpecRow {
  /** Stable, unique. Referenced by later phases in prose and in code — never renamed silently. */
  readonly id: string;
  readonly group: FeelMetricGroup;
  /** SI unit string (or an explicit ratio/count description). Never empty. */
  readonly unit: string;
  /** Which harness mode legitimately produces this number. See the header. */
  readonly mode: FeelMeasurementMode;

  /**
   * The Phase 74 measured value, or `null` where the metric could not be produced at all.
   *
   * BASELINE-SELECTION RULE for multi-run rows: the baseline is the **most adverse endpoint of
   * `observedRange`** under the row's own `comparison` (at-most ⇒ the maximum; at-least ⇒ the
   * minimum). Never a mean. A mean of twelve runs would have reported "1.3 unrecoverable stuck
   * events" and buried the run that scored 12 — which is the single most important number this
   * battery produced.
   */
  readonly baseline: number | null;
  /** REQUIRED whenever `baseline` is null (why it could not be measured, and what makes it
   * measurable). Also used to carry measurement conditions and frame denominators. */
  readonly baselineNote: string | null;
  /** [min, max] across the runs this baseline summarises; null for a single-run measurement. */
  readonly observedRange: readonly [number, number] | null;
  /** Runs required before a verdict. See FEEL_VERDICT_RUNS. */
  readonly minRunsForVerdict: number;

  /** The acceptance target, or `null` where no honest number exists yet (see `rationale`). */
  readonly target: number | null;
  /** Allowed deviation from `target`, in the row's own unit. Non-null exactly when target is. */
  readonly tolerance: number | null;
  readonly comparison: FeelComparison;

  /** GATE rows block their owning phase's exit. WATCH rows are recorded and reported, never fail. */
  readonly gate: boolean;

  readonly stability: FeelMetricStability;
  /** REQUIRED whenever `stability` is 'provisional': names the phase(s) that re-derive it. */
  readonly provisionalReason: string | null;

  readonly source: FeelMetricSource;
  /** The phase number chartered to take the next action on this row. */
  readonly owner: number;
  readonly caveats: readonly FeelCaveatId[];

  /**
   * Dotted path into a `FeelTelemetrySnapshot` (dev/feelTelemetry.ts) where a run's value for this
   * row is found — this is what makes the oracle programmatically usable rather than a document.
   * Null only where the row is not a scalar field of the snapshot (a histogram, or a value that
   * must be selected out of a bucket array), in which case `rationale` says where to get it.
   * Validated against a real snapshot in feelSpec.test.ts.
   */
  readonly snapshotPath: string | null;

  /** Never empty. For a GATE row with a null target this MUST explain the null and name the owning
   * phase — enforced by feelSpec.test.ts. */
  readonly rationale: string;
}

// =================================================================================================
// Measurement provenance — what the baselines below were measured ON
// =================================================================================================

/**
 * The conditions every baseline in this file was recorded under. A later phase comparing against
 * these numbers must reproduce these conditions or say plainly that it did not.
 */
export const FEEL_SPEC_BASELINE_CONDITIONS = {
  phase: 74,
  measuredOn: '2026-08-04',
  worldSource: 'toronto',
  seed: 1,
  /** The default car since the Phase 31 pack swap. Phase 81 re-grades the whole roster. */
  carId: 'rustySedan',
  carTopSpeedMps: 25,
  /** Probes: one suite at high tier. Routes: 4 routes × 3 quality tiers = 12 runs, 60 s each. */
  routeRuns: 12,
  routeSeconds: 60,
  tiers: ['high', 'med', 'low'],
  /** Probe isolation (plan Decision 4). Invincibility is HP-only — verified this phase, its sole
   * consumer is an early return in `applyPlayerDamage` — so it cannot bias a kinematic
   * measurement; it exists so a 25 m/s brake probe does not end the run. Routes keep it ON too,
   * so a run always completes its window. */
  probeIsolation: { civTraffic: false, transit: false, packParked: false, invincible: true },
  routeIsolation: { civTraffic: true, transit: true, packParked: true, invincible: true },
  /** The straight the probes ran on: the Yonge spine, the WIDEST ribbon on the map. Its clear
   * half-width is the number the whole turn-radius finding turns on. */
  probeCorridor: { centreX: 1500, lengthM: 1010.1, ribbonHalfWidthM: 5.5, clearHalfWidthM: 8.5 },
  /** Renderer honesty: SwiftShader, ~4–18 fps. Hence the no-frame-count law in the header. */
  renderer: 'SwiftShader (headless container), 4-18 fps',
  artifacts: '.planning/screenshots/phase-74/{high-probes,high-routes-fixed,med-routes,low-routes}',
} as const;

// =================================================================================================
// Per-route baselines — the raw battery table, machine-readable
// =================================================================================================

export type FeelRouteBaselineId = 'downtownDense' | 'spineCruise' | 'minorWeave' | 'chase3';

/** [min, max] across the three quality tiers of one route (same route id, same seed). */
export type FeelRange = readonly [number, number];

export interface FeelRouteBaseline {
  readonly route: FeelRouteBaselineId;
  /** Mean of the driver's own 10 Hz speed samples (report.speed.meanMps), not distance/time. */
  readonly meanSpeedMps: FeelRange;
  /** Integrated path length over the measured window (timing.distanceM). */
  readonly distanceM: FeelRange;
  readonly stuckEvents: FeelRange;
  readonly unrecoverableStuckEvents: FeelRange;
  /** Total seconds spent stuck within the 60 s window. */
  readonly stuckSec: FeelRange;
  readonly contactsPerMin: FeelRange;
  readonly flipEvents: FeelRange;
  readonly airtimeFrac: FeelRange;
  readonly rollPeakRad: FeelRange;
  /** TOTAL onVehicle stuck events over all three tiers of this route — not a range. The coverage
   * gap (`onVehicleUndersampled`) is only visible as an absolute count. */
  readonly onVehicleStuckTotal: number;
}

/**
 * The Phase 74 route battery, one row per route, each cell the [min, max] over that route's three
 * tier runs. This is the evidence the route-mode spec rows summarise; keeping it here means a later
 * phase can compare like-for-like (same route) instead of against a whole-battery extreme, and
 * `feelSpec.test.ts` cross-checks the two tables against each other so a typo in either shows up.
 *
 * Read the spreads, not the midpoints. `chase3`'s unrecoverable column spanning [0, 12] on one
 * route and one seed is the reason `FEEL_VERDICT_RUNS.highVarianceMinRuns` exists.
 */
export const FEEL_ROUTE_BASELINES = [
  {
    route: 'downtownDense',
    meanSpeedMps: [1.59, 5.64],
    distanceM: [91.9, 329.2],
    stuckEvents: [4, 6],
    unrecoverableStuckEvents: [0, 2],
    stuckSec: [7.8, 10.55],
    contactsPerMin: [14.1, 25.18],
    flipEvents: [0, 0],
    airtimeFrac: [0, 0.00158],
    rollPeakRad: [0.0404, 0.0815],
    onVehicleStuckTotal: 0,
  },
  {
    route: 'spineCruise',
    meanSpeedMps: [7.69, 9.64],
    distanceM: [454.2, 581.0],
    stuckEvents: [2, 4],
    unrecoverableStuckEvents: [0, 0],
    stuckSec: [3.37, 7.08],
    contactsPerMin: [18.0, 19.99],
    flipEvents: [0, 0],
    airtimeFrac: [0.00076, 0.00152],
    rollPeakRad: [0.0391, 0.051],
    onVehicleStuckTotal: 0,
  },
  {
    route: 'minorWeave',
    meanSpeedMps: [3.36, 7.51],
    distanceM: [196.0, 437.7],
    stuckEvents: [4, 8],
    unrecoverableStuckEvents: [0, 2],
    stuckSec: [7.3, 15.3],
    contactsPerMin: [17.07, 48.22],
    flipEvents: [0, 3],
    airtimeFrac: [0.00162, 0.30735],
    rollPeakRad: [0.0438, 1.5705],
    onVehicleStuckTotal: 0,
  },
  {
    route: 'chase3',
    meanSpeedMps: [1.41, 5.06],
    distanceM: [77.5, 291.4],
    stuckEvents: [10, 13],
    unrecoverableStuckEvents: [0, 12],
    stuckSec: [18.38, 28.52],
    contactsPerMin: [21.01, 30.99],
    flipEvents: [0, 0],
    airtimeFrac: [0, 0.00698],
    rollPeakRad: [0.0383, 0.1735],
    onVehicleStuckTotal: 2,
  },
] as const satisfies readonly FeelRouteBaseline[];

/**
 * The stuck-cause histogram, totalled over all twelve canonical runs (76 events). Not a spec row —
 * it is not a scalar — but pinned here because it is the evidence behind two caveats at once: the
 * `building` column's dominance is the synthetic-driver confound, and the `onVehicle` column IS the
 * coverage gap.
 */
export const FEEL_STUCK_CAUSE_BASELINE = {
  building: 54,
  scenery: 15,
  vehicleWedge: 5,
  onVehicle: 2,
  unknown: 0,
} as const;

// =================================================================================================
// THE SPEC
// =================================================================================================

/**
 * Every metric the feel overhaul is judged on. Grouped as FEEL-SPEC.md groups them; declaration
 * order is the document's order so the two read side by side.
 *
 * SEVEN rows are GATEs. A metric earns GATE status only if it is BOTH (a) chartered — some phase in
 * 74–94 is explicitly responsible for moving it — and (b) stable under measurement, i.e. it does
 * not swing on something a later phase changes deliberately. `contactsPerMin` is the clearest
 * failure of (b): Phase 79 is chartered to CUT traffic density, so a contacts/min gate would fire
 * on an intended improvement. It is WATCH, and that is a structural fact rather than a preference.
 */
export const FEEL_SPEC = [
  // -----------------------------------------------------------------------------------------
  // A. RESPONSE — how fast the car answers the player (probe mode)
  // -----------------------------------------------------------------------------------------
  {
    id: 't50Sec',
    group: 'response',
    unit: 's',
    mode: 'probe',
    baseline: 0.428,
    baselineNote:
      'Single high-tier launch probe, rustySedan (topSpeed 25 m/s), traffic/transit/parked OFF, invincible ON, on the 1,010 m Yonge straight. Probe sample interval 0.050 s — the quantization band on this number.',
    observedRange: null,
    minRunsForVerdict: 1,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 78,
    caveats: [],
    snapshotPath: 'response.t50Sec',
    rationale:
      'WATCH, not GATE: t90Sec already gates the acceleration curve and gating both halves would double-count a single tuning change. Recorded because WHERE in the curve Phase 78 buys its time matters to feel — a car that snaps to half speed and then crawls to top reads completely differently from one that ramps evenly, and only the pair of numbers distinguishes them.',
  },
  {
    id: 't90Sec',
    group: 'response',
    unit: 's',
    mode: 'probe',
    baseline: 1.604,
    baselineNote:
      'Same launch probe as t50Sec (0.050 s quantization). Note the measured trace plateaus at ~22.8 m/s, so 90 % of top speed (22.5 m/s) is reached only just below the governor ceiling — see brakeEntrySpeedMps for why that ceiling exists.',
    observedRange: null,
    minRunsForVerdict: 1,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: true,
    stability: 'provisional',
    provisionalReason:
      'Phase 78 (drive model v2) retunes the throttle governor and the chassis linear damping that jointly produce this curve, and Phase 75 changes the corridors the car accelerates down. The target is derived at Phase 78 against the then-current baseline.',
    source: 'design-target',
    owner: 78,
    caveats: [],
    snapshotPath: 'response.t90Sec',
    rationale:
      'GATE because "the car answers the throttle" is the most load-bearing response number in the feel overhaul (overview diagnosis D1) and Phase 78 is explicitly chartered to move it. The target is deliberately null: the reference research returned no acceleration figure for Smashy Road — 14 unverifiable questions and no published curve — so any number written here today would be an invention laundered into a measurement by the next phase that reads it. Phase 78 sets it from this measured baseline plus a stated direction and factor.',
  },
  {
    id: 'brakeDistM',
    group: 'response',
    unit: 'm',
    mode: 'probe',
    baseline: 25.5,
    baselineNote:
      'Measured from the ACHIEVED plateau of 23.53 m/s (94 % of the 25 m/s top speed) to a full stop, NOT from the originally-specified >=95 %: the throttle governor and chassis linear damping reach equilibrium at ~93-94 %, so the probe reports entryTargetMet=false BY DESIGN rather than by failure. Because massFactor cancels, that plateau sits at the same FRACTION for every car in the roster. Two brake numbers are comparable only at like entry speeds — always read this row together with brakeEntrySpeedMps.',
    observedRange: null,
    minRunsForVerdict: 1,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: true,
    stability: 'provisional',
    provisionalReason:
      'Phase 78 retunes the governor and the damping, which moves the plateau this distance is measured FROM; Phase 75 changes the straights it is measured ON. Phase 78 must re-record the entry speed rather than compare across a moved baseline.',
    source: 'design-target',
    owner: 78,
    caveats: [],
    snapshotPath: 'response.brakeDistM',
    rationale:
      'GATE because stopping authority is half of what "responsive" means and Phase 78 owns the brake model; a car that will not stop is unnavigable in the dense routes regardless of how fast it turns. Target null on purpose: a stopping distance is only meaningful relative to a speed envelope Phase 78 is about to change, so Phase 78 sets both together. Setting a distance now would silently encode today\'s top speed as a requirement.',
  },
  {
    id: 'brakeEntrySpeedMps',
    group: 'response',
    unit: 'm/s',
    mode: 'probe',
    baseline: 23.53,
    baselineNote:
      'The governor x damping equilibrium the car actually reaches under full throttle: 23.53 m/s = 94.1 % of top speed. The probe wanted 23.75 (95 %) and could not get there; `entryTargetMet: false` is the honest record of a physically unreachable condition, not a failed run.',
    observedRange: null,
    minRunsForVerdict: 1,
    target: null,
    tolerance: null,
    comparison: 'at-least',
    gate: false,
    stability: 'provisional',
    provisionalReason:
      'Phase 78 moves the governor and the damping that set this equilibrium, so the plateau moves with them.',
    source: 'measured-baseline',
    owner: 78,
    caveats: [],
    snapshotPath: 'response.brakeStartSpeedMps',
    rationale:
      'Not a quality metric — it is the CONDITION brakeDistM was measured under, promoted to a row so the "compare only at like entry speeds" rule is machine-checkable instead of living in prose that a later phase can skim past. It is also the row that documents a real spec correction: the original ">= 95 % of top speed" entry was permanently unreachable, and keeping it would have produced a gate that could never pass.',
  },
  {
    id: 'brakeSec',
    group: 'response',
    unit: 's',
    mode: 'probe',
    baseline: 1.999,
    baselineNote:
      'Same brake probe as brakeDistM: 23.53 m/s to planar speed < 0.5 m/s. Probe sample interval 0.042 s.',
    observedRange: null,
    minRunsForVerdict: 1,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 78,
    caveats: [],
    snapshotPath: 'response.brakeSec',
    rationale:
      'WATCH: it is the same event as brakeDistM seen in the other unit, and gating both would let one tuning change fail a phase twice. Kept because time-to-stop is what the player actually experiences (distance is what the geometry cares about), so Phase 78 needs both to judge whether a shorter stop reads as authority or as a wall.',
  },
  {
    id: 'steerToPeakYawSec',
    group: 'response',
    unit: 's',
    mode: 'probe',
    baseline: 0.574,
    baselineNote:
      'Step-steer probe, 15.6 m/s entry, high tier. Quantization +/-0.039 s (one sample interval under SwiftShader) — do NOT read a difference smaller than that as a change; run three and take the median. The probe run was INTERRUPTED by a building strike at 15.4 s, AFTER this measurement window had closed: the number is intact, the run is not.',
    observedRange: null,
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: true,
    stability: 'provisional',
    provisionalReason:
      'Phase 78 rebuilds the steering response this measures, and Phase 76 re-picks the camera at a USER GATE, which changes how much of a turn-in delay is even perceptible. The target is derived at Phase 78.',
    source: 'design-target',
    owner: 78,
    caveats: [],
    snapshotPath: 'response.steerToPeakYawSec',
    rationale:
      'GATE because turn-in latency is the difference between "the car obeys" and "the car negotiates" — the qualitative gap the user reports against the reference — and Phase 78 is chartered to close it. Target null: no reference value exists to aim at and today\'s number is measured on ribbons Phase 75 is about to widen, so Phase 78 sets it. minRunsForVerdict is 3 for a quantization reason rather than a variance one: the metric resolves no finer than one frame interval in this container.',
  },
  {
    id: 'peakYawRateRadS',
    group: 'response',
    unit: 'rad/s',
    mode: 'probe',
    baseline: 1.708,
    baselineNote:
      'Peak |yaw rate| in the same step-steer probe, at 15.6 m/s. This is the number the whole turn-radius finding rests on: r = v / omega gives 8.8 m at 15 m/s and 11.7 m at 20 m/s.',
    observedRange: null,
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-least',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 78,
    caveats: [],
    snapshotPath: 'response.peakYawRateRadS',
    rationale:
      'WATCH: peak yaw rate is the AUTHORITY the steering has, while steerToPeakYawSec (the gated row) is how quickly it arrives — one tuning knob, two readings, so only one of them gates. Its real job here is arithmetic: combined with the corridor clear half-width it is what proves the turn-radius rows are unmeasurable rather than merely unmeasured. Comparison is at-least because a more responsive car turns HARDER, not less.',
  },

  // -----------------------------------------------------------------------------------------
  // B. CORNERING — whether the car goes where it is pointed
  //
  // All four turn-radius rows are NOT MEASURABLE at Phase 74, and the reason is the finding:
  // at the measured peak yaw rate a full-lock circle needs a lateral radius of ~8.8 m at
  // 15 m/s and ~11.7 m at 20 m/s, against 8.5 m of clear half-width on the Yonge spine — the
  // WIDEST ribbon in the city. The road is narrower than the car's own turning circle.
  // -----------------------------------------------------------------------------------------
  {
    id: 'turnRadiusM@5',
    group: 'cornering',
    unit: 'm',
    mode: 'probe',
    baseline: null,
    baselineNote:
      'NOT MEASURABLE at Phase 74. Status "inconclusive": no settled full-lock window ever formed — yaw rate and speed never held steady for 0.4 s after the 0.45 s transient. This is the one point of the four that was not ended by a strike, and at 5 m/s the geometry is not the obstacle (r ~ 2.9 m); the transient simply never settles inside the room available. THE METRIC BECOMING MEASURABLE IS ITSELF A PHASE 75 ACCEPTANCE TEST.',
    observedRange: null,
    minRunsForVerdict: 1,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'provisional',
    provisionalReason:
      'Phase 75 widens the ribbons (which is what makes the measurement possible at all) and Phase 78 retunes the steering (which moves the value). The target is derived at Phase 78 against the first baseline that actually exists.',
    source: 'design-target',
    owner: 75,
    caveats: [],
    snapshotPath: 'cornering.buckets',
    rationale:
      'WATCH rather than GATE: 5 m/s is below the speed at which cornering feel is the complaint, and it is the point most sensitive to the settling heuristic. Kept in the spec so the low end of the yaw-rate-vs-speed curve has a home and Phase 78 can see the whole curve rather than two points from it. Read it out of cornering.buckets at the 2.5 m/s bucket containing 5 m/s.',
  },
  {
    id: 'turnRadiusM@10',
    group: 'cornering',
    unit: 'm',
    mode: 'probe',
    baseline: null,
    baselineNote:
      'NOT MEASURABLE at Phase 74. The run was cut at 18.6 s by the probe\'s own collision heuristic (an unexplained 5.7 m/s speed drop in a single frame) before a settled window formed. THE METRIC BECOMING MEASURABLE IS ITSELF A PHASE 75 ACCEPTANCE TEST.',
    observedRange: null,
    minRunsForVerdict: 1,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: true,
    stability: 'provisional',
    provisionalReason:
      'Phase 75 widens the ribbons, which is the precondition for measuring this at all; Phase 78 then retunes the steering that sets the value. Both must land before a target is honest.',
    source: 'design-target',
    owner: 75,
    caveats: [],
    snapshotPath: 'cornering.buckets',
    rationale:
      'GATE because 10 m/s is ordinary street pace and "the car goes where it is pointed" at ordinary pace is the cornering half of the drive model. The target is null and must STAY null until Phase 75 widens the ribbons: today the metric cannot be produced at all on the widest street in the city, and fitting a radius target to a road that is about to change width would encode the current road diet as a requirement. Phase 75 owns the next action on this row, and its acceptance test is that a full-lock circle at 10 m/s completes without a strike.',
  },
  {
    id: 'turnRadiusM@15',
    group: 'cornering',
    unit: 'm',
    mode: 'probe',
    baseline: null,
    baselineNote:
      'NOT MEASURABLE at Phase 74. The run hit a building (contact force 1.04e6) at 36.0 s. The arithmetic says why: at the measured peak yaw rate of 1.708 rad/s a full-lock circle at 15 m/s has radius 15 / 1.708 = 8.8 m, against 8.5 m of clear half-width on the Yonge spine — the map\'s WIDEST ribbon. The road is narrower than the car\'s own turning circle, so no probe tuning can rescue this point. THE METRIC BECOMING MEASURABLE IS ITSELF A PHASE 75 ACCEPTANCE TEST.',
    observedRange: null,
    minRunsForVerdict: 1,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: true,
    stability: 'provisional',
    provisionalReason:
      'Phase 75 widens the ribbons (the measurement precondition) and Phase 78 retunes the steering (the value). The target is derived at Phase 78 against the first real baseline.',
    source: 'design-target',
    owner: 75,
    caveats: [],
    snapshotPath: 'cornering.buckets',
    rationale:
      'GATE, and the single most diagnostic row in the cornering group: it is the speed at which the user\'s "roads too narrow" complaint and the "car does not go where it is pointed" complaint turn out to be the SAME complaint, expressed in metres. Target null until the road exists to measure on — Phase 75 owns that, and this row is the numeric form of its acceptance test.',
  },
  {
    id: 'turnRadiusM@20',
    group: 'cornering',
    unit: 'm',
    mode: 'probe',
    baseline: null,
    baselineNote:
      'NOT MEASURABLE at Phase 74, and refused UP FRONT rather than crashed: the probe computed a needed lateral extent of 8.6 m against 8.5 m of clear half-width and declined the point. Full-lock radius at 20 m/s is 20 / 1.708 = 11.7 m. THE METRIC BECOMING MEASURABLE IS ITSELF A PHASE 75 ACCEPTANCE TEST.',
    observedRange: null,
    minRunsForVerdict: 1,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'provisional',
    provisionalReason:
      'Phase 75 widens the ribbons; Phase 78 retunes the steering and, separately, may move the speed envelope such that 20 m/s is no longer near the top of it.',
    source: 'design-target',
    owner: 75,
    caveats: [],
    snapshotPath: 'cornering.buckets',
    rationale:
      'WATCH rather than GATE: 20 m/s is near the governed plateau, so this point measures the extreme of the envelope rather than ordinary driving, and it may not be reachable in a widened-but-still-urban corridor either. Kept because its refusal message is the cleanest single piece of evidence in the battery — the harness itself stated the road was too narrow before the car ever moved.',
  },
  {
    id: 'lateralSlipFrac',
    group: 'cornering',
    unit: 'ratio (fraction of measured time)',
    mode: 'route',
    baseline: 0.0008,
    baselineNote:
      'Route mode, not probe mode: the cornering probes were all interrupted before a settled window formed, and slip is only meaningful on real corners anyway. Span across the 12 canonical runs is 0.08 %-1.94 % of measured TIME past the shipped skid threshold — i.e. the car essentially never slides today, at either end of the range. Baseline is the minimum because the adverse direction here is TOO LITTLE slide.',
    observedRange: [0.0008, 0.0194],
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-least',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 78,
    caveats: ['singleRunIsNotASignal', 'syntheticDriverConfound'],
    snapshotPath: 'cornering.lateralSlipFrac',
    rationale:
      'WATCH and diagnostic: slip is a texture Phase 78 may deliberately INCREASE (an arcade car that never breaks traction reads as being on rails), so a gate here could fire on an intended improvement — the same disqualification that makes contactsPerMin a watch row. Comparison is at-least to record that intended direction; the target stays null because how much slide is "arcade" and how much is "loose" is a feel judgement Phase 78 makes with the user, not one this file can assert.',
  },
  {
    id: 'steerClampFrac',
    group: 'cornering',
    unit: 'ratio (frames, reported with denominator)',
    mode: 'route',
    baseline: 0.913,
    baselineNote:
      'FRAME ratio — one of the spec\'s two deliberate frame-count exceptions — so it is ALWAYS reported with its denominator: 1,075-1,352 sampled frames per 60 s run in this container. Span across the 12 canonical runs is 0.633-0.913. Heavily driver-influenced: the synthetic pure-pursuit driver commands full lock far more than a human would, so read this as a property of the LAB until a human-input capture exists.',
    observedRange: [0.633, 0.913],
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 78,
    caveats: ['singleRunIsNotASignal', 'syntheticDriverConfound'],
    snapshotPath: 'cornering.steerClampFrac',
    rationale:
      'WATCH: a high clamp fraction means the steering limiter is doing the driving, which is exactly the "car negotiates instead of obeying" complaint — but measured through a synthetic driver that saturates steering by construction, so the absolute value is not trustworthy as a gate. Kept because the CHANGE across a Phase 78 retune, measured with the same driver, is meaningful even when the level is not.',
  },

  // -----------------------------------------------------------------------------------------
  // C. CONTACT — what happens when you hit things (route mode)
  // -----------------------------------------------------------------------------------------
  {
    id: 'unrecoverableStuckEvents',
    group: 'contact',
    unit: 'count/route',
    mode: 'route',
    baseline: 12,
    baselineNote:
      'Span across the 12 canonical runs (4 routes x 3 tiers); baseline is the worst. THE VARIANCE IS ITSELF THE FINDING: chase3 returned 0 / 2 / 12 on three runs of the IDENTICAL route and seed. "Unrecoverable" means still immobile 1.0 s AFTER the 1.5 s dwell that declared the event (feelTelemetry.ts isUnrecoverableStuck), not "> 0 s" — a car briefly hung on a kerb is real physics; an unrecoverable one is the bug.',
    observedRange: [0, 12],
    minRunsForVerdict: 3,
    target: 0,
    tolerance: 0,
    comparison: 'at-most',
    gate: true,
    stability: 'firm',
    provisionalReason: null,
    source: 'design-target',
    owner: 77,
    caveats: ['singleRunIsNotASignal', 'syntheticDriverConfound', 'onVehicleUndersampled'],
    snapshotPath: 'stuck.unrecoverableCount',
    rationale:
      'THE headline row of the Feel Spec. Target 0 / tolerance 0 because Phase 77\'s entire charter is "the player is never trapped by another vehicle" — the numeric form of user issues #1 and #14 — and because no other phase moves it as a side effect, which is the second half of what earns GATE status. Firm despite Phase 75 and 76 landing first: a trap is a trap at any road width or camera angle. IMPORTANT SCOPE NOTE: the route-mode MEASUREMENT of this metric is driver-influenced corroboration, not the gate evidence; Phase 77 must gate on the purpose-built trap probes its part-file section mandates, which measure this same metric under controlled conditions.',
  },
  {
    id: 'stuckEvents',
    group: 'contact',
    unit: 'count/route',
    mode: 'route',
    baseline: 13,
    baselineNote:
      'All stuck events (>= 1.5 s dwell below 0.5 m/s with throttle held), recoverable or not. Span across the 12 canonical runs; 76 events in total. Total time stuck ran 3.4-28.5 s out of each 60 s window — on the worst chase3 run the car spent nearly half the run immobile.',
    observedRange: [2, 13],
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 77,
    caveats: ['singleRunIsNotASignal', 'syntheticDriverConfound', 'onVehicleUndersampled'],
    snapshotPath: 'stuck.count',
    rationale:
      'WATCH deliberately: a car momentarily hung on a kerb is real, readable physics and the bug is the UNRECOVERABLE subset, which has its own gated row. This is also the row most contaminated by the synthetic driver — pure pursuit cuts corners into a streetwall at the ribbon edge, and 54 of the 76 baseline events are cause-tagged `building`. Kept because the RATIO unrecoverable/total is the real health signal for Phase 77: driving the total down by making the city emptier would be a false win, driving the ratio to zero is the actual fix.',
  },
  {
    id: 'stuckCauseBreakdown',
    group: 'contact',
    unit: 'count by cause tag',
    mode: 'route',
    baseline: null,
    baselineNote:
      'Not a scalar — a histogram — so `baseline` is null by construction; the pinned totals are FEEL_STUCK_CAUSE_BASELINE (building 54, scenery 15, vehicleWedge 5, onVehicle 2, unknown 0, over 76 events). THE COVERAGE GAP: `onVehicle`, the ride-up-onto-another-car class that IS user issue #14 and Phase 77\'s actual target, fired exactly TWICE in twelve runs, both on chase3. Route drives barely sample it.',
    observedRange: null,
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 77,
    caveats: ['syntheticDriverConfound', 'onVehicleUndersampled'],
    snapshotPath: 'stuck.byCause',
    rationale:
      'WATCH, and it is the row that tells Phase 77 its route evidence is insufficient before it wastes a session collecting more of it. The cause tagging is an explicit heuristic (impact points are unavailable on the live contact path), so the histogram is directional, not forensic. The single most important thing it says is a NEGATIVE: two onVehicle events in twelve runs means Phase 77 cannot validate its fix here and must build the trap probe.',
  },
  {
    id: 'contactsPerMin',
    group: 'contact',
    unit: '1/min',
    mode: 'route',
    baseline: 48.22,
    baselineNote:
      'Coalesced contact EVENTS per minute, not raw records — the telemetry collapses a contact burst into one event (chase3/high: 1,861 records became 31 events). Span across the 12 canonical runs; the 48.22 maximum is minorWeave at high tier, the narrow-ribbon route. Per-counterpart breakdown lives in contact.byKind.',
    observedRange: [14.1, 48.22],
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'provisional',
    provisionalReason:
      'Phase 79 (traffic v3 density) deliberately changes how many things there are to hit, so any target set before it lands is describing a different city.',
    source: 'measured-baseline',
    owner: 79,
    caveats: ['singleRunIsNotASignal', 'syntheticDriverConfound'],
    snapshotPath: 'contact.eventsPerMin',
    rationale:
      'The textbook WATCH row, and worth stating plainly because it is the clearest illustration of the gate rule: Phase 79 is chartered to CUT traffic density, so a contacts/min GATE would fire on an intended improvement. It fails requirement (b) of gate status — stable under measurement — and no amount of it being an important number changes that.',
  },
  {
    id: 'speedLossPerContact',
    group: 'contact',
    unit: 'm/s',
    mode: 'route',
    baseline: 0.419,
    baselineNote:
      'MEAN planar-speed delta across the frames carrying a contact, spanned over the 12 canonical runs. The mean is small because most contacts are grazes; the per-run MAXIMA ran 11.2-16.5 m/s, i.e. a full stop from cruise. Phase 77 and Phase 93 should read both numbers — the mean describes the texture, the maximum describes the moments the player remembers.',
    observedRange: [0.0296, 0.419],
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 77,
    caveats: ['singleRunIsNotASignal', 'syntheticDriverConfound'],
    snapshotPath: 'contact.meanSpeedLossMps',
    rationale:
      'WATCH: how much speed a contact costs is the quantity Phase 77 (collision response) and Phase 93 (impact juice) trade against each other — 77 wants glancing hits to cost less so the player is never stopped dead, 93 wants deliberate hits to LAND. A gate would force one of those against the other before either has been designed.',
  },

  // -----------------------------------------------------------------------------------------
  // D. STABILITY — the car stays a car (route mode)
  // -----------------------------------------------------------------------------------------
  {
    id: 'flipEvents',
    group: 'stability',
    unit: 'count/route',
    mode: 'route',
    baseline: 3,
    baselineNote:
      'Eleven of the twelve canonical runs flipped ZERO times. One run — minorWeave at high tier — flipped three times, and it is the same run that recorded 30.7 % airtime and a 1.5705 rad (90 degree) roll peak. That single run is the whole finding: the narrowest ribbons can launch and roll the car off curb-adjacent geometry.',
    observedRange: [0, 3],
    minRunsForVerdict: 3,
    target: 0,
    tolerance: 0,
    comparison: 'at-most',
    gate: true,
    stability: 'firm',
    provisionalReason: null,
    source: 'design-target',
    owner: 78,
    caveats: ['singleRunIsNotASignal'],
    snapshotPath: 'stability.flipCount',
    rationale:
      'A road car ending up on its roof during ordinary driving is never the intended read, so target 0 / tolerance 0. Chartered to Phase 78, which owns the suspension, grip and speed envelope that put the car in the air; Phase 81\'s per-car re-grade must not regress it, and the monster truck is the one deliberate exception Phase 81 owns separately. Firm, not provisional: "the car should not flip on a normal street" survives any road width Phase 75 chooses.',
  },
  {
    id: 'airtimeFrac',
    group: 'stability',
    unit: 'ratio (frames, reported with denominator)',
    mode: 'route',
    baseline: 0.30735,
    baselineNote:
      'FRAME ratio — the second of the spec\'s two deliberate frame-count exceptions — always reported with its denominator: 1,075-1,352 sampled frames per 60 s run. Span across the 12 canonical runs is [0, 0.30735], and the distribution is bimodal rather than spread: ten runs sat under 0.7 %, while minorWeave at high tier hit 30.7 % and at low tier 22.8 %. A road car airborne for a third of a run is a defect, not a tuning preference.',
    observedRange: [0, 0.30735],
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 78,
    caveats: ['singleRunIsNotASignal'],
    snapshotPath: 'stability.airtimeFrac',
    rationale:
      'WATCH rather than GATE only because flipEvents already gates the consequence and airtime is the mechanism — gating both would fail a phase twice for one cause. Kept prominently because the two minorWeave runs are the strongest quantitative evidence in the whole battery for the user\'s "roads too narrow" and "getting launched" complaints, and because Phase 75 could plausibly remove the geometry that causes it without anyone touching the drive model.',
  },
  {
    id: 'rollPeakRad',
    group: 'stability',
    unit: 'rad',
    mode: 'route',
    baseline: 1.5705,
    baselineNote:
      'Peak |roll| from the chassis quaternion. Span across the 12 canonical runs: eleven sat in 0.038-0.173 rad (2-10 degrees, ordinary body roll), and minorWeave/high reached 1.5705 rad — 90.0 degrees, i.e. literally on its side. The distribution is the story: this is not a car that rolls a bit too much, it is a car that is fine until it is upside down.',
    observedRange: [0.0383, 1.5705],
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 78,
    caveats: ['singleRunIsNotASignal'],
    snapshotPath: 'stability.rollPeakRad',
    rationale:
      'WATCH: body roll is a feel texture Phase 78 will tune in either direction (a little lean sells weight; none reads as a brick), so a level target would be premature. Its diagnostic value is in the SHAPE of the distribution rather than the peak, which is why the note pins both the ordinary band and the outlier.',
  },
  {
    id: 'pitchPeakRad',
    group: 'stability',
    unit: 'rad',
    mode: 'route',
    baseline: 1.5612,
    baselineNote:
      'Peak |pitch| from the chassis quaternion. Span across the 12 canonical runs is 0.2483-1.5612 rad (14-89 degrees). Unlike roll, the ORDINARY end of this range is already large: a 14 degree minimum peak across a whole 60 s run means every route nosed over or reared up hard at least once, so this row is worth a look from Phase 78 even though it never gates.',
    observedRange: [0.2483, 1.5612],
    minRunsForVerdict: 3,
    target: null,
    tolerance: null,
    comparison: 'at-most',
    gate: false,
    stability: 'firm',
    provisionalReason: null,
    source: 'measured-baseline',
    owner: 78,
    caveats: ['singleRunIsNotASignal'],
    snapshotPath: 'stability.pitchPeakRad',
    rationale:
      'WATCH, same reasoning as rollPeakRad: pitch under brake and throttle is deliberate feel that Phase 78 owns in both directions. Recorded separately from roll because the two have different causes here — roll comes from curb geometry, pitch from the brake and throttle transients the response rows measure.',
  },
] as const satisfies readonly FeelSpecRow[];

/** Every id in the spec, as a union. Later phases index by this so a renamed row is a type error. */
export type FeelMetricId = (typeof FEEL_SPEC)[number]['id'];

// =================================================================================================
// Access + evaluation — the "did I hit the target for metric X?" API
// =================================================================================================

const BY_ID: ReadonlyMap<string, FeelSpecRow> = new Map(FEEL_SPEC.map((row) => [row.id, row]));

/** Look a row up by id. Throws on an unknown id rather than returning undefined: every caller is
 * a battery or a test that would otherwise silently skip the metric it meant to check. */
export function getFeelSpecRow(id: FeelMetricId): FeelSpecRow {
  const row = BY_ID.get(id);
  if (!row) throw new Error(`[feelSpec] unknown metric id "${id}"`);
  return row;
}

/** The GATE subset — the rows that can fail a phase's exit.
 *
 * Returns the literal row union rather than the widened `FeelSpecRow`, so `row.id` stays a
 * `FeelMetricId` and can be handed straight to `evaluateFeelMetric` without a cast. A caller
 * iterating the gates to check them is the whole point of this helper; widening `id` to `string`
 * would have made that the one thing it could not do. */
export function feelGateRows(): readonly (typeof FEEL_SPEC)[number][] {
  return FEEL_SPEC.filter((row) => row.gate);
}

/** Rows a given phase is chartered to move. */
export function feelRowsOwnedBy(phase: number): readonly FeelSpecRow[] {
  return FEEL_SPEC.filter((row) => row.owner === phase);
}

/**
 * The verdict vocabulary. Note what is NOT here: there is no "warn". A row either has enough
 * evidence and a target (pass/fail), or it does not (no-target/insufficient-runs), and the
 * difference is never blurred — that is the whole point of an oracle.
 */
export type FeelVerdict = 'pass' | 'fail' | 'no-target' | 'insufficient-runs';

export interface FeelEvaluation {
  readonly id: FeelMetricId;
  readonly verdict: FeelVerdict;
  readonly gate: boolean;
  readonly value: number;
  readonly target: number | null;
  readonly tolerance: number | null;
  readonly runs: number;
  readonly minRunsForVerdict: number;
  /** Human-readable one-liner for a battery log or a contact sheet. */
  readonly message: string;
}

/**
 * Ask the oracle whether a measured value meets its target.
 *
 * The `runs` argument is not optional decoration: a row carrying the variance caveat REFUSES a
 * verdict below `minRunsForVerdict` and returns `insufficient-runs` instead of a pass or a fail.
 * That is deliberate and it is the mechanism by which the 0/2/12 lesson is enforced rather than
 * merely documented — a phase cannot accidentally declare victory on one lucky chase3 run.
 *
 * Pass `value` as the run aggregate the row's `comparison` implies: for an `at-most` row that is
 * the WORST (maximum) observed across the runs, not their mean, matching how `baseline` was chosen.
 */
export function evaluateFeelMetric(id: FeelMetricId, value: number, runs = 1): FeelEvaluation {
  const row = getFeelSpecRow(id);
  const base = {
    id,
    gate: row.gate,
    value,
    target: row.target,
    tolerance: row.tolerance,
    runs,
    minRunsForVerdict: row.minRunsForVerdict,
  };

  if (row.target === null || row.tolerance === null) {
    return {
      ...base,
      verdict: 'no-target',
      message: `${id}: ${value} ${row.unit} recorded (no target — ${row.gate ? 'GATE' : 'watch'}, owner Phase ${row.owner})`,
    };
  }
  if (runs < row.minRunsForVerdict) {
    return {
      ...base,
      verdict: 'insufficient-runs',
      message: `${id}: ${runs} run(s) is not a verdict — this row needs ${row.minRunsForVerdict} (see FEEL_VERDICT_RUNS)`,
    };
  }

  const { target, tolerance } = row;
  const ok =
    row.comparison === 'at-most'
      ? value <= target + tolerance
      : row.comparison === 'at-least'
        ? value >= target - tolerance
        : Math.abs(value - target) <= tolerance;

  return {
    ...base,
    verdict: ok ? 'pass' : 'fail',
    message: `${id}: ${value} vs ${row.comparison} ${target} +/-${tolerance} ${row.unit} over ${runs} run(s) — ${ok ? 'PASS' : 'FAIL'}${row.gate ? ' (GATE)' : ''}`,
  };
}
