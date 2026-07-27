// Phase 36 — occlusion v2's evidence source. The dither fade is, by construction, impossible to
// prove from a screenshot alone: a surface at FADE_MIN still keeps 6 of every 16 pixels, and the
// §5.3 camera setback means the "dramatic see-through tower" shot the eye wants doesn't exist on
// this map (P25 learned that the hard way and answered it with the occlusionMinOpacity probe).
// So the phase's acceptance runs on numbers instead, and these are them.
//
// Fed ONLY from `import.meta.env.DEV` branches in world/toronto/TorontoScene.tsx's occlusion pass
// and read through core/debugBridge.ts's occlusionV2Stats(). Pure module state — no three, no
// React — so the accumulation rules are unit-tested exactly as they run, same shape as the Phase
// 33 sibling cameraClipStats.ts.

/** How many recent frames the pass-cost average covers. 120 ≈ 2 s at 60 fps: long enough that one
 * unlucky GC-adjacent frame can't dominate the reading, short enough that the number still tracks
 * the vantage a scripted battery has just parked at. Implementation constant. */
const COST_WINDOW_FRAMES = 120;

export interface OcclusionPassStats {
  /** Registered fade targets whose fade is currently below full opacity — i.e. how many pieces of
   * batched/instanced geometry the dither pass is fading RIGHT NOW. The headline "it works"
   * number: 0 in the open, a handful when the boresight crosses the streetwall. */
  readonly fadedTargets: number;
  /** The lowest fade any registered target currently holds (1 = nothing fading). Reaching
   * occlusionFade.ts's FADE_MIN means a surface is fully faded, which is A.5's ≤ 0.4 bar
   * (expressed as dither COVERAGE — see cityPack/occlusionDither.ts's ditherCoverage). */
  readonly minFade: number;
  /** Rolling mean cost (ms) of the WHOLE per-frame occlusion pass — the 5 boresight segment
   * queries, the hysteresis gate, the fade step and every per-instance write, plus the legacy
   * named/hero raycast that shares the same useFrame. The phase's budget is ≤ 0.2 ms. Measured
   * with performance.now() around the pass; 0 before the first sample. NOT the anti-clip guard,
   * which runs inside the camera rig (a different call site, reported separately as
   * `antiClipPullM`). */
  readonly passMsAvg: number;
  /** Worst single-frame pass cost (ms) since the last reset — the number that catches a spike an
   * average would smooth away. */
  readonly passMsMax: number;
  /** How many frames the average currently covers (≤ COST_WINDOW_FRAMES). A battery MUST check
   * this is non-zero before trusting `passMsAvg`: an unmounted world reads exactly like a free
   * one. */
  readonly passSamples: number;
}

const costs = new Float64Array(COST_WINDOW_FRAMES);
let costCount = 0;
let costCursor = 0;
let costSum = 0;
let passMsMax = 0;
let fadedTargets = 0;
let minFade = 1;

/**
 * Record one frame of the occlusion pass. Called exactly once per rendered frame from the scene's
 * pass (dev only). `fadedTargets`/`minFade` are a SNAPSHOT (they describe this frame, not a
 * running total) while the cost feeds the rolling window.
 */
export function recordOcclusionPass(faded: number, min: number, passMs: number): void {
  fadedTargets = faded;
  minFade = min;
  if (costCount < COST_WINDOW_FRAMES) costCount++;
  else costSum -= costs[costCursor]!;
  costs[costCursor] = passMs;
  costSum += passMs;
  costCursor = (costCursor + 1) % COST_WINDOW_FRAMES;
  if (passMs > passMsMax) passMsMax = passMs;
}

/** Zero every counter (start of a measured window). */
export function resetOcclusionStats(): void {
  costs.fill(0);
  costCount = 0;
  costCursor = 0;
  costSum = 0;
  passMsMax = 0;
  fadedTargets = 0;
  minFade = 1;
}

/** Plain snapshot (no functions — safe to serialize across page.evaluate). */
export function readOcclusionPassStats(): OcclusionPassStats {
  return {
    fadedTargets,
    minFade,
    passMsAvg: costCount === 0 ? 0 : costSum / costCount,
    passMsMax,
    passSamples: costCount,
  };
}

/** What core/debugBridge.ts's `occlusionV2Stats()` hands back: the pass stats plus the anti-clip
 * guard's live pull (world/toronto/cameraAntiClip.ts), which is measured at a different call site
 * (inside the camera rig) but belongs to the same acceptance story. */
export interface OcclusionV2Stats extends OcclusionPassStats {
  /** Metres the anti-clip guard pulled the eye toward the car on the most recent frame. 0 is the
   * healthy reading — the eye-line law and the corridor margin are supposed to make this guard
   * inert in normal play; non-zero means it just saved a frame (expected during a BUSTED beat). */
  readonly antiClipPullM: number;
  /** How many fade targets are registered at all — the denominator, and the sanity gate: a run of
   * zeroes with 0 registered targets means the city never mounted, not that nothing occludes. */
  readonly registeredTargets: number;
}
