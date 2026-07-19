// Midtown fold "Line 1" transition — pure crossing detection (TORONTO-MAP-SPEC-v2.md §2
// "The fold, made honest"). No react, no three — this module only decides WHEN a
// tunnelTransit event should fire; the presentation (hud/TunnelOverlay.tsx, driven by
// state/events.ts's tunnelTransit) and the emission call site (the Toronto driving scene,
// a separate task) both live elsewhere. The fold band never moves the player: crossing it
// only ever plays a canvas overlay while the car keeps driving under it — see this file's
// tests for the "teleport-free" guarantee (these functions only ever READ x/y, never
// return or mutate a position).
//
// Map convention: y is DOWN=south (CLAUDE.md / TDD). Northbound driving = y DECREASING;
// southbound = y INCREASING. The fold band is the closed interval y ∈ [FOLD_START_Y,
// FOLD_END_Y] (spec §1/§2 — FOLD_START_Y is the Sheppard/North-York-capsule edge, FOLD_END_Y
// is the Bloor/downtown edge; both are projection.ts's live ZONE_BOUNDARIES, Part-8 (D1)
// compaction-derived — e.g. 702/1362 at the current DENSITY.scale, was 1170/1830 pre-compaction;
// the fold's own SPAN between them is exempt from scaling and always stays 660 wu). "Entering"
// the fold means crossing INTO that closed band from outside it:
//   - northbound (from downtown, y decreasing): crosses INTO the band at FOLD_END_Y (Bloor).
//   - southbound (from North York, y increasing): crosses INTO the band at FOLD_START_Y (Sheppard).
// Exiting the band (driving on through, or reversing back out) never fires anything on its
// own — only the two entering crossings above do.
//
import { YONGE_X, ZONE_BOUNDARIES } from './projection';

// Single-source (MAP PROJECT contract: no duplicated boundary numbers): the fold band IS
// the projection's fold zone, and the corridor is centred on the Yonge spine.
const FOLD_START_Y = ZONE_BOUNDARIES[1];
const FOLD_END_Y = ZONE_BOUNDARIES[2];

export type FoldDirection = 'northbound' | 'southbound';

function insideFoldBand(y: number): boolean {
  return y >= FOLD_START_Y && y <= FOLD_END_Y;
}

/**
 * Pure per-sample crossing test — does NOT know about "already fired this entry" state
 * (that's createFoldTrigger's job below). Given the previous and current map-y sample (plus
 * the current map-x and the caller's corridor half-width), returns which direction's
 * fold-ENTRY crossing just happened, or null if none did.
 *
 * Boundary convention (deliberately chosen + tested, see tunnel.test.ts): the fold band is
 * treated as the CLOSED interval [FOLD_START_Y, FOLD_END_Y] (live-derived, Part-8 D1: 702/1362
 * at the current DENSITY.scale) — a sample landing EXACTLY on a boundary counts as already
 * inside the band. Concretely:
 *   - northbound (y decreasing, entering at Bloor/FOLD_END_Y): fires when `prevY > FOLD_END_Y
 *     && y <= FOLD_END_Y` — the previous sample was strictly south of the boundary
 *     (outside/downtown) and the new sample has reached or passed it. A previous sample already
 *     AT FOLD_END_Y does NOT re-fire on the next step inward — it was already "inside" per this
 *     convention, so there is exactly one firing sample per entry, not two.
 *   - southbound (y increasing, entering at Sheppard/FOLD_START_Y): symmetric — fires when
 *     `prevY < FOLD_START_Y && y >= FOLD_START_Y`.
 * These two conditions are mutually exclusive (prevY can't be both > FOLD_END_Y and <
 * FOLD_START_Y), so at most one direction ever fires per call, even for a same-step jump that
 * clears both boundaries at once (see the "fast crossing" test — it fires the northbound entry
 * once and never a southbound one too, because only the first condition's prevY/y pair is
 * satisfied).
 *
 * The corridor x-gate is boundary-inclusive too: fires only while `|x - YONGE_X| <= halfWidth`.
 */
export function foldCrossing(
  prevY: number,
  y: number,
  x: number,
  halfWidth: number,
): FoldDirection | null {
  if (Math.abs(x - YONGE_X) > halfWidth) return null; // off the Yonge corridor — never fires.
  if (prevY > FOLD_END_Y && y <= FOLD_END_Y) return 'northbound';
  if (prevY < FOLD_START_Y && y >= FOLD_START_Y) return 'southbound';
  return null;
}

export interface FoldTrigger {
  /** Feed one (x, y) map-position sample. Returns the direction that JUST entered the fold
   * on this step, or null. Never mutates or returns a position — detection only. */
  step(x: number, y: number): FoldDirection | null;
}

/**
 * Stateful stepper built on `foldCrossing` above. Owns two pieces of state a pure per-sample
 * function can't: the previous sample (crossings are inherently a two-sample comparison) and
 * the re-arm latch (spec requirement: once fired, must not fire again until the player has
 * FULLY LEFT the fold band — y strictly outside [FOLD_START_Y, FOLD_END_Y] — so oscillating deep
 * inside the band, e.g. looping around the Yonge & Eglinton mini-node, never re-fires).
 *
 * `halfWidth` is the Yonge-corridor x-gate half-width (map units) — the caller's number
 * (world/toronto's road-class corridor width), fixed for this trigger's lifetime.
 */
export function createFoldTrigger(halfWidth: number): FoldTrigger {
  let prevY: number | null = null;
  // Whether the NEXT entering crossing is allowed to fire. Starts true (a fresh trigger is
  // always ready to fire on its first real crossing); an entering fire sets it false; fully
  // leaving the band sets it back to true. A first sample that happens to already be inside
  // the band leaves this at its default `true`, but foldCrossing can never fire from a
  // single sample anyway (it needs a `prevY` to compare against), so that can't cause a
  // spurious immediate fire.
  let armed = true;

  return {
    step(x: number, y: number): FoldDirection | null {
      const prev = prevY;
      prevY = y;

      let result: FoldDirection | null = null;
      if (prev !== null && armed) {
        result = foldCrossing(prev, y, x, halfWidth);
        if (result) armed = false; // consumed — no re-fire until the band is fully left.
      }

      // Re-arm rule: the current sample being strictly outside the closed band means the
      // player has fully left it (either they drove on through the far side, or reversed
      // back out the way they came) — ready to fire again on the next entry. Deliberately
      // checked every step (not just when a result just fired) so a trigger that was
      // created while the player happened to already be inside the band still re-arms
      // correctly the first time they leave it.
      if (!insideFoldBand(y)) armed = true;

      return result;
    },
  };
}
