// Phase 74 — the FEEL SPEC LAW test. Same job, and the same voice, as `config/layering.test.ts`
// and `config/camera.law.test.ts`: this is the one place the oracle's absolute numbers and its
// structural honesty rules are written down, so any change to them has to come here and argue.
//
// Two kinds of assertion live in this file and they are not interchangeable:
//
//   1. PINS. Every load-bearing literal of every row is pinned, so a changed target / baseline /
//      gate classification cannot land silently — it shows up as a diff here, in the same commit as
//      the change to feelSpec.ts and to `.planning/feel/FEEL-SPEC.md`. That three-file lockstep IS
//      the change protocol; this test failing is the intended tripwire, not an obstacle.
//
//      NOTE ON THE PIN SHAPE: layering.test.ts pins its whole object with one `toEqual`, which is
//      right for 17 scalars. This spec is 22 rows × ~19 fields, and a single mega-literal would be
//      an unreviewable wall nobody reads the diff of — which defeats the purpose of pinning. So the
//      pins are a compact id-keyed table of the fields that carry meaning (group, mode, baseline,
//      target, tolerance, gate, stability, source, owner, minRuns, comparison), plus separate pins
//      of the id list in declaration order, the observed ranges, the claimed caveats, the snapshot
//      paths, and the numeric route table. Prose fields are covered by the invariants below rather
//      than by transcription, because pinning a rationale's exact wording would punish improving it.
//
//   2. INVARIANTS. The structural rules that make the spec honest rather than merely present: a
//      GATE row cannot have a null target without a rationale naming the phase that will set it; a
//      `provisional` row must name the phase that re-derives it; a null baseline must say why;
//      every row must carry a real rationale; a row's baseline must be the adverse endpoint of the
//      span it summarises, never a mean. These are the rules that stop the next ten phases from
//      quietly filling the spec with invented numbers — the failure mode the whole "14 unverifiable
//      questions" framing exists to prevent.

import { describe, expect, it } from 'vitest';
import {
  FEEL_ROUTE_BASELINES,
  FEEL_SPEC,
  FEEL_SPEC_BASELINE_CONDITIONS,
  FEEL_SPEC_CAVEATS,
  FEEL_SPEC_SCHEMA,
  FEEL_STUCK_CAUSE_BASELINE,
  FEEL_VERDICT_RUNS,
  evaluateFeelMetric,
  feelGateRows,
  feelRowsOwnedBy,
  getFeelSpecRow,
  type FeelCaveatId,
  type FeelComparison,
  type FeelMeasurementMode,
  type FeelMetricGroup,
  type FeelMetricId,
  type FeelMetricSource,
  type FeelMetricStability,
  type FeelSpecRow,
} from './feelSpec';
import { createFeelAccumulator, summarizeFeel, type FeelCarParams } from './feelTelemetry';

/**
 * A WIDENED view of the spec. `FEEL_SPEC` is `as const`, so every field is a literal type
 * (`caveats: readonly []`, `gate: false`, …) — exactly what makes the pins meaningful, and exactly
 * what makes generic iteration awkward. Iterating this alias keeps both properties: the literals
 * stay pinned above, the invariants below read the rows as plain `FeelSpecRow`s.
 */
const ROWS: readonly FeelSpecRow[] = FEEL_SPEC;

const GROUPS: readonly FeelMetricGroup[] = ['response', 'cornering', 'contact', 'stability'];
const SOURCES: readonly FeelMetricSource[] = [
  'reference-verified',
  'measured-baseline',
  'design-target',
];
const STABILITIES: readonly FeelMetricStability[] = ['firm', 'provisional'];
const COMPARISONS: readonly FeelComparison[] = ['at-most', 'at-least', 'within'];
const MODES: readonly FeelMeasurementMode[] = ['probe', 'route'];

/** The phase window this spec governs (the feel overhaul, Parts 17–20). An owner outside it is a
 * typo, or a row that belongs in somebody else's document. 74 is admissible because a row could
 * legitimately be owned by the measuring phase itself. */
const OWNER_MIN = 74;
const OWNER_MAX = 94;

// =================================================================================================
// 1. PINS
// =================================================================================================

describe('FEEL_SPEC — the row set', () => {
  it('has the pinned schema tag', () => {
    expect(FEEL_SPEC_SCHEMA).toBe('feel-spec/1');
  });

  // Declaration order is the document's order (response → cornering → contact → stability). Adding
  // a row is a deliberate act: it lands here, in feelSpec.ts and in FEEL-SPEC.md together.
  it('is exactly these 22 metrics, in this order', () => {
    expect(ROWS.map((r) => r.id)).toEqual([
      't50Sec',
      't90Sec',
      'brakeDistM',
      'brakeEntrySpeedMps',
      'brakeSec',
      'steerToPeakYawSec',
      'peakYawRateRadS',
      'turnRadiusM@5',
      'turnRadiusM@10',
      'turnRadiusM@15',
      'turnRadiusM@20',
      'lateralSlipFrac',
      'steerClampFrac',
      'unrecoverableStuckEvents',
      'stuckEvents',
      'stuckCauseBreakdown',
      'contactsPerMin',
      'speedLossPerContact',
      'flipEvents',
      'airtimeFrac',
      'rollPeakRad',
      'pitchPeakRad',
    ]);
    expect(ROWS).toHaveLength(22);
  });

  it('has exactly seven GATE rows, and they are these', () => {
    expect(feelGateRows().map((r) => r.id)).toEqual([
      't90Sec',
      'brakeDistM',
      'steerToPeakYawSec',
      'turnRadiusM@10',
      'turnRadiusM@15',
      'unrecoverableStuckEvents',
      'flipEvents',
    ]);
  });

  // Only two rows in the whole spec carry an actual number to hit, and both are zero-tolerance
  // "this must never happen" gates. Everything else is honestly null. If this count grows, the
  // growth is the interesting part of the diff.
  it('has exactly two rows with a non-null target, both target 0 / tolerance 0', () => {
    const withTargets = ROWS.filter((r) => r.target !== null);
    expect(withTargets.map((r) => r.id)).toEqual(['unrecoverableStuckEvents', 'flipEvents']);
    for (const row of withTargets) {
      expect(row.target, row.id).toBe(0);
      expect(row.tolerance, row.id).toBe(0);
      expect(row.comparison, row.id).toBe('at-most');
    }
  });

  // No row cites the reference for a number, because the reference never stated one (14
  // unverifiable questions, no postmortem on record). A future phase that legitimately finds a
  // sourced value re-pins this count AND must put the citation in that row's rationale — the
  // invariant further down enforces the citation, this pin makes the addition deliberate.
  it('has zero `reference-verified` rows (the research returned direction, not values)', () => {
    expect(ROWS.filter((r) => r.source === 'reference-verified')).toHaveLength(0);
  });
});

/** One pinned row of the table below. */
interface RowPin {
  group: FeelMetricGroup;
  mode: FeelMeasurementMode;
  baseline: number | null;
  target: number | null;
  tolerance: number | null;
  gate: boolean;
  stability: FeelMetricStability;
  source: FeelMetricSource;
  owner: number;
  minRunsForVerdict: number;
  comparison: FeelComparison;
}

const M = 'measured-baseline' as const;
const D = 'design-target' as const;

/**
 * The load-bearing literals, one entry per row. Pinned exactly; a change to any cell is a spec
 * change and must be argued in FEEL-SPEC.md before it lands here.
 */
const PINS: Record<FeelMetricId, RowPin> = {
  // --- A. response — one high-tier probe suite, isolation on, no repeats -----------------------
  t50Sec: {
    group: 'response',
    mode: 'probe',
    baseline: 0.428,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 78,
    minRunsForVerdict: 1,
    comparison: 'at-most',
  },
  t90Sec: {
    group: 'response',
    mode: 'probe',
    baseline: 1.604,
    target: null,
    tolerance: null,
    gate: true,
    stability: 'provisional',
    source: D,
    owner: 78,
    minRunsForVerdict: 1,
    comparison: 'at-most',
  },
  brakeDistM: {
    group: 'response',
    mode: 'probe',
    baseline: 25.5,
    target: null,
    tolerance: null,
    gate: true,
    stability: 'provisional',
    source: D,
    owner: 78,
    minRunsForVerdict: 1,
    comparison: 'at-most',
  },
  brakeEntrySpeedMps: {
    group: 'response',
    mode: 'probe',
    baseline: 23.53,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'provisional',
    source: M,
    owner: 78,
    minRunsForVerdict: 1,
    comparison: 'at-least',
  },
  brakeSec: {
    group: 'response',
    mode: 'probe',
    baseline: 1.999,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 78,
    minRunsForVerdict: 1,
    comparison: 'at-most',
  },
  steerToPeakYawSec: {
    group: 'response',
    mode: 'probe',
    baseline: 0.574,
    target: null,
    tolerance: null,
    gate: true,
    stability: 'provisional',
    source: D,
    owner: 78,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },
  peakYawRateRadS: {
    group: 'response',
    mode: 'probe',
    baseline: 1.708,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 78,
    minRunsForVerdict: 3,
    comparison: 'at-least',
  },

  // --- B. cornering — the four radii are NOT MEASURABLE; the null IS the finding ----------------
  'turnRadiusM@5': {
    group: 'cornering',
    mode: 'probe',
    baseline: null,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'provisional',
    source: D,
    owner: 75,
    minRunsForVerdict: 1,
    comparison: 'at-most',
  },
  'turnRadiusM@10': {
    group: 'cornering',
    mode: 'probe',
    baseline: null,
    target: null,
    tolerance: null,
    gate: true,
    stability: 'provisional',
    source: D,
    owner: 75,
    minRunsForVerdict: 1,
    comparison: 'at-most',
  },
  'turnRadiusM@15': {
    group: 'cornering',
    mode: 'probe',
    baseline: null,
    target: null,
    tolerance: null,
    gate: true,
    stability: 'provisional',
    source: D,
    owner: 75,
    minRunsForVerdict: 1,
    comparison: 'at-most',
  },
  'turnRadiusM@20': {
    group: 'cornering',
    mode: 'probe',
    baseline: null,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'provisional',
    source: D,
    owner: 75,
    minRunsForVerdict: 1,
    comparison: 'at-most',
  },
  lateralSlipFrac: {
    group: 'cornering',
    mode: 'route',
    baseline: 0.0008,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 78,
    minRunsForVerdict: 3,
    comparison: 'at-least',
  },
  steerClampFrac: {
    group: 'cornering',
    mode: 'route',
    baseline: 0.913,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 78,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },

  // --- C. contact — 12 canonical route runs -----------------------------------------------------
  unrecoverableStuckEvents: {
    group: 'contact',
    mode: 'route',
    baseline: 12,
    target: 0,
    tolerance: 0,
    gate: true,
    stability: 'firm',
    source: D,
    owner: 77,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },
  stuckEvents: {
    group: 'contact',
    mode: 'route',
    baseline: 13,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 77,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },
  stuckCauseBreakdown: {
    group: 'contact',
    mode: 'route',
    baseline: null,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 77,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },
  contactsPerMin: {
    group: 'contact',
    mode: 'route',
    baseline: 48.22,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'provisional',
    source: M,
    owner: 79,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },
  speedLossPerContact: {
    group: 'contact',
    mode: 'route',
    baseline: 0.419,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 77,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },

  // --- D. stability -----------------------------------------------------------------------------
  flipEvents: {
    group: 'stability',
    mode: 'route',
    baseline: 3,
    target: 0,
    tolerance: 0,
    gate: true,
    stability: 'firm',
    source: D,
    owner: 78,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },
  airtimeFrac: {
    group: 'stability',
    mode: 'route',
    baseline: 0.30735,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 78,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },
  rollPeakRad: {
    group: 'stability',
    mode: 'route',
    baseline: 1.5705,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 78,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },
  pitchPeakRad: {
    group: 'stability',
    mode: 'route',
    baseline: 1.5612,
    target: null,
    tolerance: null,
    gate: false,
    stability: 'firm',
    source: M,
    owner: 78,
    minRunsForVerdict: 3,
    comparison: 'at-most',
  },
};

describe('FEEL_SPEC — every row pinned, field by field', () => {
  it('the pin table covers every row (no row escapes it, no stale pin survives a deletion)', () => {
    expect(Object.keys(PINS).sort()).toEqual(ROWS.map((r) => r.id).sort());
  });

  for (const row of ROWS) {
    it(`${row.id} matches its pinned literals`, () => {
      expect({
        group: row.group,
        mode: row.mode,
        baseline: row.baseline,
        target: row.target,
        tolerance: row.tolerance,
        gate: row.gate,
        stability: row.stability,
        source: row.source,
        owner: row.owner,
        minRunsForVerdict: row.minRunsForVerdict,
        comparison: row.comparison,
      }).toEqual(PINS[row.id as FeelMetricId]);
    });
  }

  // The spans are pinned separately from the scalars because they are what make the baselines
  // readable: `unrecoverableStuckEvents = 12` means nothing until you know the same route and the
  // same seed also produced 0.
  it('pins every observed range (null = a single-run measurement)', () => {
    expect(Object.fromEntries(ROWS.map((r) => [r.id, r.observedRange]))).toEqual({
      t50Sec: null,
      t90Sec: null,
      brakeDistM: null,
      brakeEntrySpeedMps: null,
      brakeSec: null,
      steerToPeakYawSec: null,
      peakYawRateRadS: null,
      'turnRadiusM@5': null,
      'turnRadiusM@10': null,
      'turnRadiusM@15': null,
      'turnRadiusM@20': null,
      lateralSlipFrac: [0.0008, 0.0194],
      steerClampFrac: [0.633, 0.913],
      unrecoverableStuckEvents: [0, 12],
      stuckEvents: [2, 13],
      stuckCauseBreakdown: null,
      contactsPerMin: [14.1, 48.22],
      speedLossPerContact: [0.0296, 0.419],
      flipEvents: [0, 3],
      airtimeFrac: [0, 0.30735],
      rollPeakRad: [0.0383, 1.5705],
      pitchPeakRad: [0.2483, 1.5612],
    });
  });

  it('pins which caveats each row claims', () => {
    expect(Object.fromEntries(ROWS.map((r) => [r.id, r.caveats]))).toEqual({
      t50Sec: [],
      t90Sec: [],
      brakeDistM: [],
      brakeEntrySpeedMps: [],
      brakeSec: [],
      steerToPeakYawSec: [],
      peakYawRateRadS: [],
      'turnRadiusM@5': [],
      'turnRadiusM@10': [],
      'turnRadiusM@15': [],
      'turnRadiusM@20': [],
      lateralSlipFrac: ['singleRunIsNotASignal', 'syntheticDriverConfound'],
      steerClampFrac: ['singleRunIsNotASignal', 'syntheticDriverConfound'],
      unrecoverableStuckEvents: [
        'singleRunIsNotASignal',
        'syntheticDriverConfound',
        'onVehicleUndersampled',
      ],
      stuckEvents: ['singleRunIsNotASignal', 'syntheticDriverConfound', 'onVehicleUndersampled'],
      stuckCauseBreakdown: ['syntheticDriverConfound', 'onVehicleUndersampled'],
      contactsPerMin: ['singleRunIsNotASignal', 'syntheticDriverConfound'],
      speedLossPerContact: ['singleRunIsNotASignal', 'syntheticDriverConfound'],
      flipEvents: ['singleRunIsNotASignal'],
      airtimeFrac: ['singleRunIsNotASignal'],
      rollPeakRad: ['singleRunIsNotASignal'],
      pitchPeakRad: ['singleRunIsNotASignal'],
    });
  });

  it('pins the snapshotPath of every row (this is how a battery finds the value)', () => {
    expect(Object.fromEntries(ROWS.map((r) => [r.id, r.snapshotPath]))).toEqual({
      t50Sec: 'response.t50Sec',
      t90Sec: 'response.t90Sec',
      brakeDistM: 'response.brakeDistM',
      brakeEntrySpeedMps: 'response.brakeStartSpeedMps',
      brakeSec: 'response.brakeSec',
      steerToPeakYawSec: 'response.steerToPeakYawSec',
      peakYawRateRadS: 'response.peakYawRateRadS',
      'turnRadiusM@5': 'cornering.buckets',
      'turnRadiusM@10': 'cornering.buckets',
      'turnRadiusM@15': 'cornering.buckets',
      'turnRadiusM@20': 'cornering.buckets',
      lateralSlipFrac: 'cornering.lateralSlipFrac',
      steerClampFrac: 'cornering.steerClampFrac',
      unrecoverableStuckEvents: 'stuck.unrecoverableCount',
      stuckEvents: 'stuck.count',
      stuckCauseBreakdown: 'stuck.byCause',
      contactsPerMin: 'contact.eventsPerMin',
      speedLossPerContact: 'contact.meanSpeedLossMps',
      flipEvents: 'stability.flipCount',
      airtimeFrac: 'stability.airtimeFrac',
      rollPeakRad: 'stability.rollPeakRad',
      pitchPeakRad: 'stability.pitchPeakRad',
    });
  });
});

describe('FEEL_VERDICT_RUNS — the variance law', () => {
  // 3 is not a round-number guess: it is the smallest count that would have exposed the measured
  // 0 / 2 / 12 chase3 spread. Two runs could have returned 0 and 2 and looked settled.
  it('pins the run minimums', () => {
    expect(FEEL_VERDICT_RUNS).toEqual({
      defaultMinRuns: 1,
      highVarianceMinRuns: 3,
      probeQuantizationMinRuns: 3,
      observedSampleIntervalSecRange: [0.038, 0.05],
    });
  });

  it('is honoured by every row that claims the variance caveat', () => {
    for (const row of ROWS) {
      if (!row.caveats.includes('singleRunIsNotASignal')) continue;
      expect(row.minRunsForVerdict, `${row.id} claims the variance caveat`).toBeGreaterThanOrEqual(
        FEEL_VERDICT_RUNS.highVarianceMinRuns,
      );
    }
  });

  // Every route-mode row shares one measurement population — the 12 canonical runs whose spread
  // produced the caveat — so none of them may take a single-run verdict, caveat claimed or not.
  it('binds EVERY route-mode row, not only the ones that name the caveat', () => {
    for (const row of ROWS.filter((r) => r.mode === 'route')) {
      expect(row.minRunsForVerdict, row.id).toBeGreaterThanOrEqual(
        FEEL_VERDICT_RUNS.highVarianceMinRuns,
      );
    }
  });
});

describe('FEEL_ROUTE_BASELINES — the raw battery table', () => {
  it('pins all four routes, cell by cell', () => {
    expect(FEEL_ROUTE_BASELINES).toEqual([
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
    ]);
  });

  it('every range is well-ordered [min, max]', () => {
    for (const route of FEEL_ROUTE_BASELINES) {
      for (const [key, cell] of Object.entries(route)) {
        if (!Array.isArray(cell)) continue;
        const [lo, hi] = cell as unknown as readonly [number, number];
        expect(hi, `${route.route}.${key}`).toBeGreaterThanOrEqual(lo);
      }
    }
  });

  // The cross-check that catches a typo in EITHER table: a spec row's observed range must be the
  // union of the per-route ranges for the same metric. Edit one table and not the other and this
  // fails, instead of the two quietly disagreeing forever.
  const CROSS_CHECKED = [
    'stuckEvents',
    'unrecoverableStuckEvents',
    'contactsPerMin',
    'flipEvents',
    'airtimeFrac',
    'rollPeakRad',
  ] as const;

  for (const key of CROSS_CHECKED) {
    it(`${key}: the spec row's span is the union of the per-route spans`, () => {
      const lo = Math.min(...FEEL_ROUTE_BASELINES.map((r) => r[key][0]));
      const hi = Math.max(...FEEL_ROUTE_BASELINES.map((r) => r[key][1]));
      expect(getFeelSpecRow(key).observedRange).toEqual([lo, hi]);
    });
  }

  // THE COVERAGE GAP, pinned as a number: two events out of 76, both on chase3.
  it('pins the stuck-cause histogram, and the onVehicle undersampling it documents', () => {
    expect(FEEL_STUCK_CAUSE_BASELINE).toEqual({
      building: 54,
      scenery: 15,
      vehicleWedge: 5,
      onVehicle: 2,
      unknown: 0,
    });
    const total = Object.values(FEEL_STUCK_CAUSE_BASELINE).reduce<number>((a, b) => a + b, 0);
    expect(total, 'the histogram must account for every stuck event in the battery').toBe(76);
    expect(
      FEEL_ROUTE_BASELINES.reduce((sum, r) => sum + r.onVehicleStuckTotal, 0),
      'per-route onVehicle totals must reconcile with the histogram',
    ).toBe(FEEL_STUCK_CAUSE_BASELINE.onVehicle);
    // The class that IS user issue #14 is under 3 % of the sample. That is the finding, not a nit.
    expect(FEEL_STUCK_CAUSE_BASELINE.onVehicle / total).toBeLessThan(0.03);
  });
});

describe('FEEL_SPEC_BASELINE_CONDITIONS — what the numbers were measured on', () => {
  it('pins the measurement provenance', () => {
    expect(FEEL_SPEC_BASELINE_CONDITIONS).toEqual({
      phase: 74,
      measuredOn: '2026-08-04',
      worldSource: 'toronto',
      seed: 1,
      carId: 'rustySedan',
      carTopSpeedMps: 25,
      routeRuns: 12,
      routeSeconds: 60,
      tiers: ['high', 'med', 'low'],
      probeIsolation: { civTraffic: false, transit: false, packParked: false, invincible: true },
      routeIsolation: { civTraffic: true, transit: true, packParked: true, invincible: true },
      probeCorridor: { centreX: 1500, lengthM: 1010.1, ribbonHalfWidthM: 5.5, clearHalfWidthM: 8.5 },
      renderer: 'SwiftShader (headless container), 4-18 fps',
      artifacts:
        '.planning/screenshots/phase-74/{high-probes,high-routes-fixed,med-routes,low-routes}',
    });
  });

  // The route table's cells are min/max over 3 tiers × 4 routes; the declared run count must agree.
  it('routeRuns equals routes × tiers', () => {
    expect(FEEL_SPEC_BASELINE_CONDITIONS.routeRuns).toBe(
      FEEL_ROUTE_BASELINES.length * FEEL_SPEC_BASELINE_CONDITIONS.tiers.length,
    );
  });

  // THE ARITHMETIC BEHIND THE UNMEASURABLE ROWS, re-derived here rather than asserted in prose: a
  // full-lock circle's radius is v / ω, and at the measured peak yaw rate that exceeds the widest
  // clear half-width in the city from 15 m/s upward. This is WHY four rows carry `baseline: null`,
  // and checking it here means a future road-width change makes the test tell the truth about it.
  it('the turn-radius rows are unmeasurable BY GEOMETRY on the probe corridor', () => {
    const peakYaw = getFeelSpecRow('peakYawRateRadS').baseline;
    expect(peakYaw).not.toBeNull();
    const clear = FEEL_SPEC_BASELINE_CONDITIONS.probeCorridor.clearHalfWidthM;
    const radiusAt = (v: number) => v / (peakYaw as number);

    expect(radiusAt(15)).toBeCloseTo(8.78, 2);
    expect(radiusAt(20)).toBeCloseTo(11.71, 2);
    expect(radiusAt(15), 'a 15 m/s full-lock circle does not fit the widest ribbon').toBeGreaterThan(
      clear,
    );
    expect(radiusAt(20), 'nor does a 20 m/s one').toBeGreaterThan(clear);
    expect(getFeelSpecRow('turnRadiusM@15').baseline).toBeNull();
    expect(getFeelSpecRow('turnRadiusM@20').baseline).toBeNull();
  });
});

// =================================================================================================
// 2. INVARIANTS — the rules that keep the spec honest
// =================================================================================================

describe('FEEL_SPEC invariants — structure', () => {
  it('ids are unique, non-empty and whitespace-free', () => {
    const ids = ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id, `"${id}" must not contain whitespace`).not.toMatch(/\s/);
    }
  });

  for (const row of ROWS) {
    it(`${row.id} has valid enums, a unit and an owner in range`, () => {
      expect(GROUPS).toContain(row.group);
      expect(MODES).toContain(row.mode);
      expect(SOURCES).toContain(row.source);
      expect(STABILITIES).toContain(row.stability);
      expect(COMPARISONS).toContain(row.comparison);
      expect(row.unit.trim().length, 'must declare a unit').toBeGreaterThan(0);
      expect(Number.isInteger(row.owner), 'owner must be a phase number').toBe(true);
      expect(row.owner).toBeGreaterThanOrEqual(OWNER_MIN);
      expect(row.owner).toBeLessThanOrEqual(OWNER_MAX);
      expect(Number.isInteger(row.minRunsForVerdict)).toBe(true);
      expect(row.minRunsForVerdict).toBeGreaterThanOrEqual(FEEL_VERDICT_RUNS.defaultMinRuns);
    });
  }

  it('is JSON-serializable with no loss (the oracle has to survive a results.json round trip)', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(FEEL_SPEC));
    expect(roundTripped).toEqual(FEEL_SPEC);
  });

  it('declaration order groups the rows (response → cornering → contact → stability)', () => {
    const order = ROWS.map((r) => GROUPS.indexOf(r.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('FEEL_SPEC invariants — honesty', () => {
  // The rule this whole file exists for. A GATE with no target is legitimate (five of ours are) but
  // ONLY if it says who will set the number and why it cannot be set now. Without this guard,
  // "GATE, target null" is indistinguishable from an unfinished row.
  it('every GATE row with a null target names its owning phase in the rationale', () => {
    for (const row of ROWS) {
      if (!row.gate || row.target !== null) continue;
      expect(
        row.rationale,
        `${row.id} is a GATE with no target and must explain the null by naming Phase ${row.owner}`,
      ).toMatch(new RegExp(`Phase\\s+${row.owner}\\b`));
    }
  });

  it('every row has a real rationale, not a placeholder', () => {
    for (const row of ROWS) {
      expect(row.rationale.trim().length, `${row.id} rationale`).toBeGreaterThan(40);
      expect(row.rationale, `${row.id} rationale`).not.toMatch(/^\s*(TODO|TBD|N\/A)/i);
    }
  });

  it('a null baseline is always explained (why it could not be measured)', () => {
    for (const row of ROWS) {
      if (row.baseline !== null) continue;
      expect(row.baselineNote, `${row.id} has no baseline and must say why`).not.toBeNull();
      expect((row.baselineNote ?? '').trim().length, row.id).toBeGreaterThan(40);
    }
  });

  // The four turn-radius rows are the only NOT-MEASURED ones (stuckCauseBreakdown is not a scalar,
  // which is a different thing), and each must state the Phase 75 acceptance condition: "the metric
  // becoming measurable is itself a Phase 75 acceptance test" is the actual deliverable that
  // unblocks them, so it cannot be left to a reader's memory.
  it('every unmeasured row states that becoming measurable is a Phase 75 acceptance test', () => {
    const unmeasured = ROWS.filter((r) => r.baseline === null && r.group === 'cornering');
    expect(unmeasured.map((r) => r.id)).toEqual([
      'turnRadiusM@5',
      'turnRadiusM@10',
      'turnRadiusM@15',
      'turnRadiusM@20',
    ]);
    for (const row of unmeasured) {
      expect(row.baselineNote ?? '', row.id).toMatch(/PHASE 75 ACCEPTANCE TEST/);
      expect(row.owner, `${row.id} — Phase 75 owns the next action on an unmeasurable row`).toBe(75);
    }
  });

  it('every provisional row names the phase that re-derives it', () => {
    for (const row of ROWS) {
      if (row.stability !== 'provisional') continue;
      expect(row.provisionalReason, `${row.id} is provisional`).not.toBeNull();
      expect(row.provisionalReason ?? '', `${row.id} provisionalReason`).toMatch(/Phase\s+\d+/);
    }
  });

  it('a firm row never carries a provisional reason, and a provisional one always does', () => {
    for (const row of ROWS) {
      if (row.stability === 'firm') expect(row.provisionalReason, row.id).toBeNull();
      else expect(row.provisionalReason, row.id).not.toBeNull();
    }
  });

  it('target and tolerance are declared together, and a tolerance is never negative', () => {
    for (const row of ROWS) {
      expect(row.target === null, `${row.id}: target/tolerance must both be set or both null`).toBe(
        row.tolerance === null,
      );
      if (row.tolerance !== null) expect(row.tolerance, row.id).toBeGreaterThanOrEqual(0);
    }
  });

  // A `reference-verified` target would be the one claim in this file checkable against the outside
  // world, so it must carry its citation inline. Currently vacuous (zero such rows) and kept armed
  // for the first phase that adds one.
  it('any reference-verified row cites its source in the rationale', () => {
    for (const row of ROWS.filter((r) => r.source === 'reference-verified')) {
      expect(row.rationale, `${row.id} claims a sourced reference fact`).toMatch(
        /(https?:\/\/|source:|cited)/i,
      );
    }
  });

  it('baseline sits inside its observed range, at the adverse endpoint', () => {
    for (const row of ROWS) {
      if (row.observedRange === null) continue;
      const [lo, hi] = row.observedRange;
      expect(hi, `${row.id} range must be [min, max]`).toBeGreaterThanOrEqual(lo);
      expect(row.baseline, `${row.id} has a range so it must have a baseline`).not.toBeNull();
      // at-most rows are worst at the top of the span, at-least rows at the bottom. Never a mean:
      // a mean of twelve runs would have reported "1.3 unrecoverable stuck events" and buried the
      // run that scored 12.
      expect(row.baseline, `${row.id} baseline must be the adverse endpoint of its span`).toBe(
        row.comparison === 'at-least' ? lo : hi,
      );
    }
  });

  it('caveat ids are all real, and every documented caveat is claimed by at least one row', () => {
    const known = Object.keys(FEEL_SPEC_CAVEATS) as FeelCaveatId[];
    const claimed = new Set<string>();
    for (const row of ROWS) {
      for (const c of row.caveats) {
        expect(known, `${row.id} claims unknown caveat "${c}"`).toContain(c);
        claimed.add(c);
      }
    }
    for (const c of known) {
      expect([...claimed], `caveat "${c}" is documented but unused`).toContain(c);
    }
  });

  // The three Phase 74 honesty requirements, asserted as CONTENT and not just as keys — a caveat
  // whose text has been hollowed out is worse than a missing one, because rows still claim it.
  it('the three standing caveats still say the things they exist to say', () => {
    expect(FEEL_SPEC_CAVEATS.singleRunIsNotASignal).toMatch(/0 \/ 2 \/ 12/);
    expect(FEEL_SPEC_CAVEATS.singleRunIsNotASignal).toMatch(/identical route and seed/);
    expect(FEEL_SPEC_CAVEATS.syntheticDriverConfound).toMatch(/pure-pursuit/);
    expect(FEEL_SPEC_CAVEATS.syntheticDriverConfound).toMatch(/feelDrives\.ts/);
    expect(FEEL_SPEC_CAVEATS.syntheticDriverConfound).toMatch(/Phase 77/);
    expect(FEEL_SPEC_CAVEATS.onVehicleUndersampled).toMatch(/2 events out of 76/);
    expect(FEEL_SPEC_CAVEATS.onVehicleUndersampled).toMatch(/#14/);
  });

  // Route-mode stuck evidence is driver-influenced and barely samples the class Phase 77 targets.
  // Every stuck row must carry both caveats so nobody reads a count as a clean measurement.
  it('every stuck row carries the driver confound AND the onVehicle coverage gap', () => {
    for (const id of ['unrecoverableStuckEvents', 'stuckEvents', 'stuckCauseBreakdown'] as const) {
      const row = getFeelSpecRow(id);
      expect(row.caveats, id).toContain('syntheticDriverConfound');
      expect(row.caveats, id).toContain('onVehicleUndersampled');
    }
  });

  // Frame-based ratios are the spec's only two exceptions to "no frame counts", and the exception
  // is tolerable only while the denominator travels with the number.
  it('the two frame-ratio rows report their denominator', () => {
    for (const id of ['steerClampFrac', 'airtimeFrac'] as const) {
      const row = getFeelSpecRow(id);
      expect(row.unit, id).toMatch(/denominator/);
      expect(row.baselineNote ?? '', id).toMatch(/frames/);
    }
  });
});

describe('FEEL_SPEC invariants — snapshotPath actually resolves', () => {
  /** A never-sampled telemetry snapshot: enough to prove every path EXISTS on the real shape.
   * Values are null / 0 / [] on a fresh accumulator, which is exactly right — this test is about
   * the path, not the value. */
  function emptySnapshot(): Record<string, unknown> {
    const car: FeelCarParams = {
      id: 'rustySedan',
      name: 'Rusty Sedan',
      topSpeedMps: 25,
      steering: { maxAngleDeg: 42, highSpeedAngleDeg: 22 },
      massFactor: 1,
      hp: 200,
    };
    return summarizeFeel(createFeelAccumulator(car)) as unknown as Record<string, unknown>;
  }

  it('every snapshotPath names a real field of FeelTelemetrySnapshot', () => {
    const snap = emptySnapshot();
    for (const row of ROWS) {
      if (row.snapshotPath === null) continue;
      let cursor: unknown = snap;
      for (const part of row.snapshotPath.split('.')) {
        const isObject = typeof cursor === 'object' && cursor !== null;
        expect(
          isObject && part in (cursor as Record<string, unknown>),
          `${row.id}: snapshotPath "${row.snapshotPath}" breaks at ".${part}"`,
        ).toBe(true);
        cursor = (cursor as Record<string, unknown>)[part];
      }
    }
  });

  // Every row is reachable from a results.json today. The field is nullable so a future non-scalar
  // row can be honest about it, but nothing currently needs that escape hatch.
  it('no row currently needs the null-path escape hatch', () => {
    expect(ROWS.filter((r) => r.snapshotPath === null).map((r) => r.id)).toEqual([]);
  });
});

// =================================================================================================
// 3. THE API — "did I hit the target for metric X?"
// =================================================================================================

describe('the oracle API', () => {
  it('getFeelSpecRow returns the row and throws on an unknown id', () => {
    expect(getFeelSpecRow('flipEvents').group).toBe('stability');
    // The cast is the point: the type system already forbids this, the throw is for JS callers
    // (a battery script reading ids out of a results.json).
    expect(() => getFeelSpecRow('nope' as FeelMetricId)).toThrow(/unknown metric id/);
  });

  it('feelRowsOwnedBy partitions the spec by charter', () => {
    expect(feelRowsOwnedBy(75).map((r) => r.id)).toEqual([
      'turnRadiusM@5',
      'turnRadiusM@10',
      'turnRadiusM@15',
      'turnRadiusM@20',
    ]);
    expect(feelRowsOwnedBy(77).map((r) => r.id)).toEqual([
      'unrecoverableStuckEvents',
      'stuckEvents',
      'stuckCauseBreakdown',
      'speedLossPerContact',
    ]);
    expect(feelRowsOwnedBy(79).map((r) => r.id)).toEqual(['contactsPerMin']);
    // Every row belongs to somebody; nothing is orphaned.
    const owners = new Set(ROWS.map((r) => r.owner));
    expect([...owners].every((p) => feelRowsOwnedBy(p).length > 0)).toBe(true);
  });

  it('passes a zero-target gate only at exactly zero', () => {
    expect(evaluateFeelMetric('unrecoverableStuckEvents', 0, 3).verdict).toBe('pass');
    expect(evaluateFeelMetric('unrecoverableStuckEvents', 1, 3).verdict).toBe('fail');
    expect(evaluateFeelMetric('flipEvents', 0, 3).verdict).toBe('pass');
    expect(evaluateFeelMetric('flipEvents', 3, 3).verdict).toBe('fail');
  });

  // THE VARIANCE LAW, enforced rather than merely documented: one clean chase3 run cannot declare
  // Phase 77 finished, because that is precisely the run the battery showed can come back 0 when
  // the same route and seed also produces 12.
  it('refuses a verdict below the row minimum instead of passing it', () => {
    const one = evaluateFeelMetric('unrecoverableStuckEvents', 0, 1);
    expect(one.verdict).toBe('insufficient-runs');
    expect(one.message).toMatch(/not a verdict/);
    expect(evaluateFeelMetric('unrecoverableStuckEvents', 0, 2).verdict).toBe('insufficient-runs');
    expect(evaluateFeelMetric('unrecoverableStuckEvents', 0, 3).verdict).toBe('pass');
  });

  it('reports a targetless row as recorded-only, never as a pass', () => {
    const e = evaluateFeelMetric('t90Sec', 1.2, 5);
    expect(e.verdict).toBe('no-target');
    expect(e.gate).toBe(true);
    expect(e.message).toMatch(/no target/);
    // ...and it says so even when the value is absurd, because there is nothing to compare against.
    expect(evaluateFeelMetric('t90Sec', 999, 5).verdict).toBe('no-target');
  });

  it('a no-target verdict outranks insufficient runs (nothing to be short of evidence FOR)', () => {
    expect(evaluateFeelMetric('rollPeakRad', 0.1, 1).verdict).toBe('no-target');
  });

  it('records the at-least direction for the rows Phase 78 is expected to RAISE', () => {
    // No row carries an at-least TARGET today, so the direction is recorded rather than exercised.
    // Until Phase 78 sets one, the oracle must still refuse to invent a verdict.
    expect(getFeelSpecRow('peakYawRateRadS').comparison).toBe('at-least');
    expect(getFeelSpecRow('lateralSlipFrac').comparison).toBe('at-least');
    expect(evaluateFeelMetric('peakYawRateRadS', 0.1, 3).verdict).toBe('no-target');
  });

  it('every GATE row today is either zero-target or explicitly targetless', () => {
    for (const row of feelGateRows()) {
      const verdict = evaluateFeelMetric(row.id as FeelMetricId, 0, row.minRunsForVerdict).verdict;
      expect(['pass', 'no-target'], row.id).toContain(verdict);
    }
  });
});
