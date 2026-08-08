// Phase 76 T3 — the camera-lab GENERIC METRIC READOUT, tested against the LIVE counter shape.
//
// scripts/camera-lab.mjs reports whatever `window.__smashy.cameraClipStats()` returns, by suffix,
// so that a counter added to cameraClipStats.ts flows through the battery and the contact sheet
// with no harness edit. That is a contract, and a contract exercised only by a 20-minute browser
// battery is one nobody checks — so it is checked here, in milliseconds, against the real
// `CameraClipStats` produced by the real accumulator.
//
// The test that matters most is `covers every field of the live CameraClipStats`: it fails the day
// somebody adds a counter the convention cannot classify, which is exactly when the harness would
// otherwise start dropping it in silence.
//
// (scripts/lib is where pure logic used by the `node`-run harnesses lives — the same .mjs + .d.mts
// pairing scripts/lib/cityPackNaming.mjs already uses, since the scripts cannot be TypeScript.)
import { describe, expect, it } from 'vitest';
import {
  collectMetrics,
  metricSpec,
  metricValues,
  ratio,
  SUM_DENOMINATORS,
} from '../../../../scripts/lib/cameraLabMetrics.mjs';
import {
  readCameraClipStats,
  recordClampFired,
  recordOcclusionHits,
  resetCameraClipStats,
  sampleCameraClip,
  sampleCameraReadability,
  type CameraClipStats,
} from './cameraClipStats';

/** A populated, REAL snapshot: driven through the shipped accumulator rather than hand-written, so
 * the test can never pass against a stats shape that no longer exists. */
function liveSnapshot(): CameraClipStats {
  resetCameraClipStats();
  sampleCameraClip(true, false, 2);
  sampleCameraClip(false, true, 0);
  sampleCameraClip(false, false, 1);
  recordOcclusionHits(3);
  recordClampFired();
  sampleCameraReadability(
    { onScreen: 2, sightings: 1, sightingDistanceSumM: 40, sightingDistanceMaxM: 40 },
    { coverage: 0.25, boxesInFrame: 12, boxesTested: 900 },
    18,
  );
  sampleCameraReadability(
    { onScreen: 4, sightings: 0, sightingDistanceSumM: 0, sightingDistanceMaxM: 0 },
    { coverage: 0.45, boxesInFrame: 20, boxesTested: 900 },
    22,
  );
  return readCameraClipStats();
}

/** Every numeric leaf of a stats object, as dotted paths — the population the convention must
 * account for. Mirrors collectMetrics' own traversal rules (objects recurse, non-numbers skip). */
function numericLeafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...numericLeafPaths(v, path));
    } else if (v === null || typeof v === 'number') {
      out.push(path);
    }
  }
  return out;
}

describe('camera-lab generic metric readout', () => {
  const stats = liveSnapshot();

  it('reports EVERY numeric field of the live CameraClipStats exactly once', () => {
    // THE DECOUPLING CONTRACT. A new counter must appear in the readout on its first run; this
    // fails loudly the day one does not, which is the only moment the omission is cheap to fix.
    const sources = collectMetrics(stats).map((m) => m.source);
    expect([...sources].sort()).toEqual([...numericLeafPaths(stats)].sort());
    expect(new Set(sources).size, 'a source counted twice').toBe(sources.length);
  });

  it('classifies by suffix: frames raw, *Frames a rate, *Sum a mean, everything else raw', () => {
    const byKey = new Map(collectMetrics(stats).map((m) => [m.key, m]));
    // Frame counts → rates against their own level's denominator.
    expect(byKey.get('eyeInsideRate')).toMatchObject({ kind: 'rate', source: 'eyeInsideFrames', denomKey: 'frames' });
    expect(byKey.get('eyeInsideRate')?.value).toBeCloseTo(1 / 3, 10);
    expect(byKey.get('boresightBlockedRate')?.value).toBeCloseTo(2 / 3, 10);
    // Sums → means. occlusionHitSum has no sibling *Frames, so it falls through to `frames`.
    expect(byKey.get('occlusionHitMean')).toMatchObject({ kind: 'mean', denomKey: 'frames' });
    expect(byKey.get('occlusionHitMean')?.value).toBeCloseTo(3 / 3, 10);
    // A max, and an already-derived scalar, pass through raw rather than being re-divided.
    expect(byKey.get('occlusionHitMax')).toMatchObject({ kind: 'raw', value: 3 });
    expect(byKey.get('frames')).toMatchObject({ kind: 'raw', value: 3 });
  });

  it('honours the SUM_DENOMINATORS exceptions the suffix rule cannot infer', () => {
    const byKey = new Map(collectMetrics(stats).map((m) => [m.key, m]));
    // boresightHitSum's documented denominator is boresightBlockedFrames, not frames.
    expect(SUM_DENOMINATORS.boresightHitSum).toBe('boresightBlockedFrames');
    expect(byKey.get('boresightHitMean')).toMatchObject({ denomKey: 'boresightBlockedFrames' });
    expect(byKey.get('boresightHitMean')?.value).toBeCloseTo(3 / 2, 10);
    // Warning distances average over sightings, not over frames.
    expect(byKey.get('readability.sightingDistanceMeanM')).toMatchObject({
      denomKey: 'readability.sightings',
    });
    expect(byKey.get('readability.sightingDistanceMeanM')?.value).toBeCloseTo(40, 10);
  });

  it('prefixes a nested block and divides it by ITS OWN frames, not the outer one', () => {
    // readability samples only frames a player vehicle exists on, so its denominator is genuinely
    // different (2 here vs 3 clip frames). Using the outer one would understate every mean.
    const values = metricValues(stats);
    expect(stats.readability.frames).not.toBe(stats.frames);
    expect(values['readability.frames']).toBe(2);
    expect(values['readability.onScreenPursuerMean']).toBeCloseTo((2 + 4) / 2, 10);
    expect(values['readability.groundBandMeanWu']).toBeCloseTo((18 + 22) / 2, 10);
  });

  it('agrees with the derived means the bridge publishes itself (the free cross-check)', () => {
    // The redundancy is deliberate: the harness re-derives a mean from the raw *Sum while the
    // bridge publishes its own. They must agree — a mismatch is a real bug in one of the two.
    const values = metricValues(stats);
    expect(values['readability.cityCoverageMean']).toBeCloseTo(stats.readability.cityInFrameFraction ?? NaN, 12);
    expect(values['readability.onScreenPursuerMean']).toBeCloseTo(stats.readability.onScreenPursuerCount ?? NaN, 12);
    expect(values['readability.groundBandMeanWu']).toBeCloseTo(stats.readability.groundBandWu ?? NaN, 12);
    expect(values['readability.sightingDistanceMeanM']).toBeCloseTo(
      stats.readability.pursuerWarningDistanceM ?? NaN,
      12,
    );
  });

  it('never turns an empty denominator into a zero', () => {
    resetCameraClipStats();
    const empty = readCameraClipStats();
    const values = metricValues(empty);
    expect(values.eyeInsideRate).toBeNull();
    expect(values['readability.cityCoverageMean']).toBeNull();
    // The bridge's own derived nulls survive the walk as nulls, not as 0.
    expect(values['readability.cityInFrameFraction']).toBeNull();
    expect(ratio(1, 0)).toBeNull();
    // …while a real zero stays a zero: a counter that was sampled and read 0 is a measurement.
    expect(values.frames).toBe(0);
  });

  it('surfaces an UNKNOWN field rather than dropping it', () => {
    // The whole point: a counter this harness has never heard of must still be reported. Four
    // shapes — a plain scalar, a frame count, a bare sum, and a sum with its own *Frames sibling
    // and a unit suffix.
    const future = {
      frames: 10,
      wobbleFrames: 4,
      wobbleAmplitudeSum: 20,
      wobbleMagnitudeSumWu: 30,
      wobbleMagnitudeFrames: 6,
      someBrandNewScalar: 7.5,
      label: 'not a metric',
    };
    const values = metricValues(future);
    expect(values.wobbleRate).toBeCloseTo(0.4, 10);
    expect(values.wobbleAmplitudeMean).toBeCloseTo(2, 10); // no sibling *Frames ⇒ ÷ frames
    expect(values.wobbleMagnitudeMeanWu).toBeCloseTo(5, 10); // sibling *Frames wins, unit preserved
    expect(values.someBrandNewScalar).toBe(7.5);
    expect('label' in values, 'a string is metadata, not a metric').toBe(false);
  });

  it('does NOT treat a sibling *Count as a denominator (onScreenPursuerCount is a MEAN)', () => {
    // Regression for the bug this suite caught during Phase 76: an earlier draft fell back to a
    // `<base>Count` sibling, which divided onScreenPursuerSum by the bridge's own derived mean and
    // produced a plausible-looking wrong number. `*Count` is not a denominator marker here.
    const byKey = new Map(collectMetrics(stats).map((m) => [m.key, m]));
    expect(byKey.get('readability.onScreenPursuerMean')).toMatchObject({ denomKey: 'readability.frames' });
    expect(byKey.get('readability.onScreenPursuerCount')).toMatchObject({ kind: 'raw' });
    expect(SUM_DENOMINATORS.onScreenPursuerSum).toBeUndefined();
  });

  it('metricSpec is metricValues without the values, in the same stable order', () => {
    const spec = metricSpec(stats);
    expect(spec.map((m) => m.key)).toEqual(collectMetrics(stats).map((m) => m.key));
    expect(spec.every((m) => !('value' in m))).toBe(true);
    // Deterministic across calls — the contact sheet's column order depends on it.
    expect(metricSpec(stats)).toEqual(spec);
  });
});
