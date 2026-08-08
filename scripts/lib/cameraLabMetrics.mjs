// THE CAMERA-LAB GENERIC METRIC READOUT (Phase 76 T3).
//
// scripts/camera-lab.mjs used to name every counter it reported — five hardcoded rate names taken
// off a known field list. That makes a counter added to world/toronto/cameraClipStats.ts INVISIBLE
// in the battery until somebody edits the harness, and a silently-dropped counter is
// indistinguishable from one that read zero. This module is the name-AGNOSTIC replacement: give it
// whatever object `window.__smashy.cameraClipStats()` returned and it derives a reported metric
// from every numeric leaf, by suffix.
//
// Lives in scripts/lib (plain executable ESM, paired with a hand-written .d.mts) for the same
// reason cityPackNaming.mjs does: the harness is run by `node` and cannot be TypeScript, but the
// logic is pure and belongs under test. src/game/world/toronto/cameraLabMetrics.test.ts drives it
// against the REAL, live `CameraClipStats` shape, so "the convention covers the current counters"
// is a fact the test suite checks rather than a claim this comment makes.
//
// ─── THE CONVENTION ───────────────────────────────────────────────────────────────────────────
//
// Applied per OBJECT LEVEL (a nested block may carry its own `frames`; cameraClipStats().
// readability does, and it is legitimately smaller than the top-level one — that pass only samples
// frames where a player vehicle exists):
//
//   frames              → RAW. It is the denominator for its own level.
//   <base>Frames        → RATE  `<base>Rate`      = value / that level's frames.
//   <base>Sum[<Unit>]   → MEAN  `<base>Mean[Unit]`= value / denominator, where the denominator is
//                         (1) a SUM_DENOMINATORS entry, else (2) a sibling `<base>Frames`, else
//                         (3) that level's frames.
//   anything else       → RAW — which is what makes an UNFAMILIAR field VISIBLE rather than
//                         dropped, including a `null` the bridge already derived.
//
// THERE IS DELIBERATELY NO `<base>Count` FALLBACK, and the reason is a bug this module's own test
// caught before any of it ran in a browser: `readability.onScreenPursuerCount` is not a count at
// all — it is the bridge's DERIVED MEAN. Treating a `*Count` sibling as a denominator divided
// `onScreenPursuerSum` by a mean and produced a silently wrong number that still looked plausible
// (2.0 instead of 3.0). The `*Count` suffix is therefore not a reliable denominator marker in this
// codebase, and a sum needing a denominator other than a sibling `*Frames` gets an explicit
// SUM_DENOMINATORS entry — which is reviewable, whereas an inference is not.
//
// Nested blocks are prefixed with their key (`readability.cityInFrameFraction`), because `frames`
// legitimately exists at more than one level and a flat namespace would collide.
//
// NULL IS NOT ZERO, ANYWHERE. An empty denominator yields `null`, never 0 and never NaN. "No
// pursuer ever entered the frame" and "a pursuer entered the frame at 0 m" are different findings,
// and the whole readability block leans on that distinction.
//
// REDUNDANCY IS DELIBERATE. Where the bridge already publishes a derived mean of its own
// (`readability.cityInFrameFraction`), this ALSO derives one from the matching `*Sum`
// (`readability.cityCoverageMean`). They must agree, so the pair is a free cross-check on both
// halves; a disagreement is a real bug in one of them, not a rounding artefact.

/**
 * `*Sum` fields whose documented denominator is a sibling the suffix rule cannot infer. This is the
 * EXCEPTION LIST, not the mechanism — a new counter that follows the convention needs no entry, and
 * that is the property the whole module exists to provide.
 */
export const SUM_DENOMINATORS = Object.freeze({
  // "÷ boresightBlockedFrames = mean depth of cover" — cameraClipStats.ts's own doc comment.
  boresightHitSum: 'boresightBlockedFrames',
  // Warning distances are averaged over SIGHTINGS (off→on transitions), not over frames.
  sightingDistanceSumM: 'sightings',
});

/** Division that yields null (never 0, never NaN, never Infinity) on an empty/absent denominator. */
export function ratio(n, denom) {
  if (typeof n !== 'number' || typeof denom !== 'number') return null;
  return denom > 0 ? n / denom : null;
}

/**
 * Walk a stats object into an ordered list of `{ key, kind, value, source, denomKey }`.
 * Order is the object's own key order, depth-first — stable across runs, so two summaries list
 * their metrics identically and a column that VANISHED is visible as a missing key rather than a
 * silently shifted table.
 */
export function collectMetrics(stats, prefix = '', inheritedFrames = null, out = []) {
  if (stats === null || typeof stats !== 'object') return out;
  const levelFrames = typeof stats.frames === 'number' ? stats.frames : inheritedFrames;
  const p = prefix ? `${prefix}.` : '';
  for (const [key, value] of Object.entries(stats)) {
    const qualified = `${p}${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      collectMetrics(value, qualified, levelFrames, out);
      continue;
    }
    // Strings/booleans/arrays are metadata, not measurements. A `null` NUMBER survives (the bridge
    // uses null for "denominator was zero") and must never be coerced to 0 on its way through.
    if (value !== null && typeof value !== 'number') continue;
    if (key === 'frames') {
      out.push({ key: qualified, kind: 'raw', value, source: qualified, denomKey: null });
      continue;
    }
    const asFrames = /^(.*)Frames$/.exec(key);
    if (asFrames) {
      out.push({
        key: `${p}${asFrames[1]}Rate`,
        kind: 'rate',
        value: ratio(value, levelFrames),
        source: qualified,
        denomKey: `${p}frames`,
      });
      continue;
    }
    const asSum = /^(.*)Sum([A-Za-z]*)$/.exec(key);
    if (asSum) {
      const [, base, unit] = asSum;
      const denomKey =
        SUM_DENOMINATORS[key] ?? (typeof stats[`${base}Frames`] === 'number' ? `${base}Frames` : 'frames');
      out.push({
        key: `${p}${base}Mean${unit}`,
        kind: 'mean',
        value: ratio(value, denomKey === 'frames' ? levelFrames : stats[denomKey]),
        source: qualified,
        denomKey: `${p}${denomKey}`,
      });
      continue;
    }
    out.push({ key: qualified, kind: 'raw', value, source: qualified, denomKey: null });
  }
  return out;
}

/** `{ key: value }` for the JSON rows and the tables. */
export function metricValues(stats) {
  return Object.fromEntries(collectMetrics(stats).map((m) => [m.key, m.value]));
}

/**
 * The metric SPEC — key/kind/source/denominator with the values stripped. Written ONCE per summary
 * so scripts/camera-lab-sheet.mjs can order and explain its columns without the metadata being
 * repeated in every one of ~100 cells.
 */
export function metricSpec(stats) {
  return collectMetrics(stats).map(({ key, kind, source, denomKey }) => ({ key, kind, source, denomKey }));
}
