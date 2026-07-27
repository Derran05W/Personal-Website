// Phase 36 — occlusion v2's two pure halves: WHO can be faded (the fade-target registry) and WHEN a
// key counts as occluded (the hysteresis hold clock). Both sit between the clip index's targeting
// query (cameraClipIndex.ts's segmentHitFadeKeys) and the fade state machine (occlusionFade.ts's
// OcclusionFader), and neither imports three — same discipline as OcclusionFader, for the same
// reason: this is the logic that has to be right frame after frame, so it is unit-tested at a
// 60-fps step instead of eyeballed in a screenshot.
//
// THE SHAPE OF THE PER-FRAME PASS (owned by TorontoScene, task T3):
//   1. cast the 5 boresight segments → union of hit fade keys into one reused Set;
//   2. gate.markHits(hitKeys, now)                    ← this file
//   3. gate.collectOccluded(occludedOut, now)         ← this file (adds the HOLD_MS tail)
//   4. fader.step(registeredKeys, occludedOut, dtMs)  ← occlusionFade.ts
//   5. forEachFadeTarget((key, apply) => apply(fader.opacity(key)))  ← this file
// The registry exists because step 5's writer differs per mesh class (a BatchedMesh colours-texture
// texel vs an InstancedBufferAttribute), and only the component that populated the mesh knows which
// instance slot a layout id landed in. So each renderer registers `key → (fade) => write`, and the
// scene pass stays class-agnostic.

/**
 * How long (ms) a key stays "occluded" after the last frame a boresight segment actually hit it.
 *
 * WHY A HOLD AT ALL: the segments graze corners. A wall that clips the frame for one frame in three
 * would otherwise start fading, start restoring, start fading — a strobe far more distracting than
 * the occlusion. Holding for ~150 ms (the part file's figure, and the same order as A.5's
 * fade-in deadline) means a key must be CONTINUOUSLY clear for that long before it is released,
 * after which occlusionFade.ts's own FADE_DURATION_MS ramp restores it. Grazing therefore reads as
 * one steady fade, not a flicker.
 *
 * Implementation constant, not a gameplay tunable — same carve-out as fx/cameraRig.ts's shake-noise
 * constants (it shapes a visual filter, not the game's feel or difficulty).
 */
export const HOLD_MS = 150 as const;

/** How a fade value ∈ [0,1] reaches its geometry. 1 = fully opaque, lower = more dithered away. */
export type FadeApply = (fade: number) => void;

// --- fade-target registry ----------------------------------------------------------------------

const targets = new Map<string, FadeApply>();

/**
 * Register (or replace) the writer for one fade key. LAST WRITE WINS — under StrictMode's
 * mount → cleanup → mount, the second mount's registration is the live one, and the first mount's
 * cleanup arrives *after* it (Phase 30's registration bug, in reverse). `unregisterFadeTarget`
 * below is therefore identity-checked so that late cleanup cannot delete the live writer.
 */
export function registerFadeTarget(key: string, apply: FadeApply): void {
  targets.set(key, apply);
}

/**
 * Remove a fade target. Pass the `apply` the caller registered (always do this from a React cleanup)
 * and the removal happens ONLY if that exact function is still the registered one — a stale cleanup
 * from a previous StrictMode mount is then a no-op instead of silently unregistering the live mesh.
 * Omitting `apply` removes unconditionally (world teardown).
 *
 * Returns whether anything was actually removed.
 */
export function unregisterFadeTarget(key: string, apply?: FadeApply): boolean {
  if (apply !== undefined && targets.get(key) !== apply) return false;
  return targets.delete(key);
}

/** Is a key currently registered? */
export function hasFadeTarget(key: string): boolean {
  return targets.has(key);
}

/** How many fade targets are registered (debug/stats). */
export function fadeTargetCount(): number {
  return targets.size;
}

/** Every registered key, for the fader's `step` (which needs the FULL key set, not just the
 * occluded subset, so cleared keys ramp back). Live view — do not mutate the registry while
 * iterating it. */
export function fadeTargetKeys(): Iterable<string> {
  return targets.keys();
}

/** Apply `fadeOf(key)` to every registered target. Zero allocation. */
export function applyAllFades(fadeOf: (key: string) => number): void {
  for (const [key, apply] of targets) apply(fadeOf(key));
}

/**
 * Apply `fadeOf(key)` to just the listed keys (unknown keys are skipped). Zero allocation.
 *
 * THE HOT-PATH VARIANT, and the one the scene pass actually uses. `applyAllFades` above is the
 * obvious shape, but the shipped map registers ~2,000 targets (the whole pack streetwall + back
 * lots + backdrop boxes) while the number ever FADING at once is a handful: walking all 2,000
 * every frame — a Map iteration, a closure call and a fader Map.get each — measured on the order
 * of the entire 0.2 ms budget the phase gives the whole occlusion pass, to write "1.0, unchanged"
 * 1,990 times. The scene therefore keeps an ACTIVE key set (occluded ∪ still-restoring) and calls
 * this, so per-frame cost scales with what is actually moving. `applyAllFades` stays for
 * whole-registry sweeps (teardown, tests, a debug "restore everything").
 */
export function applyFadesFor(keys: Iterable<string>, fadeOf: (key: string) => number): void {
  for (const key of keys) {
    const apply = targets.get(key);
    if (apply !== undefined) apply(fadeOf(key));
  }
}

/** Drop every registration (world unmount / test isolation). */
export function clearFadeTargets(): void {
  targets.clear();
}

// --- hysteresis hold clock ---------------------------------------------------------------------

/**
 * Per-key "last frame this key was hit" clock, turning the instantaneous per-frame hit set into a
 * held occluded set (see HOLD_MS). Pure: it holds only numbers and is driven entirely by the `nowMs`
 * the caller passes, so the tests step it at exact frame boundaries.
 */
export class HysteresisGate {
  private readonly lastHitMs = new Map<string, number>();

  /** Record that `key` is on a boresight segment as of `nowMs`. */
  markHit(key: string, nowMs: number): void {
    this.lastHitMs.set(key, nowMs);
  }

  /** markHit for a whole frame's hit set. */
  markHits(keys: Iterable<string>, nowMs: number): void {
    for (const key of keys) this.lastHitMs.set(key, nowMs);
  }

  /** Has `key` been hit within the last HOLD_MS? A key never seen (or long clear) is false. */
  isOccluded(key: string, nowMs: number): boolean {
    const last = this.lastHitMs.get(key);
    return last !== undefined && nowMs - last <= HOLD_MS;
  }

  /** Milliseconds since `key` was last hit, or Infinity if it was never hit / has been pruned. */
  msSinceHit(key: string, nowMs: number): number {
    const last = this.lastHitMs.get(key);
    return last === undefined ? Infinity : nowMs - last;
  }

  /**
   * Fill `out` with every key still held occluded at `nowMs`, and prune the ones that have aged out
   * in the same walk (their hold has expired, so their entry carries no further information — the
   * fader owns the restore ramp from here). Keeping prune fused to the read is what stops the map
   * growing without bound over a long session: nothing survives more than HOLD_MS past its last hit.
   *
   * `out` is cleared first and owned by the caller, so the per-frame pass reuses one Set.
   */
  collectOccluded(out: Set<string>, nowMs: number): void {
    out.clear();
    for (const [key, last] of this.lastHitMs) {
      if (nowMs - last <= HOLD_MS) out.add(key);
      else this.lastHitMs.delete(key);
    }
  }

  /** Prune aged-out keys without collecting (for callers that only ever ask `isOccluded`). */
  prune(nowMs: number): void {
    for (const [key, last] of this.lastHitMs) {
      if (nowMs - last > HOLD_MS) this.lastHitMs.delete(key);
    }
  }

  /** How many keys the clock is tracking (the memory-growth assertion's hook). */
  get size(): number {
    return this.lastHitMs.size;
  }

  /** Forget everything (world unmount / test isolation). */
  clear(): void {
    this.lastHitMs.clear();
  }
}

/** The scene-wide hold clock — one per world, so the scene pass and any debug read agree. */
export const occlusionGate = new HysteresisGate();
