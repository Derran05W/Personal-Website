// Toronto map v2 — occlusion fade (TORONTO-MAP-SPEC-v2.md Addendum A.5; phase-25-plan Task 3).
// The A.5 mandate: "car is never fully hidden — meshes on the camera→car ray fade to ≤ 0.4 alpha
// within 150 ms" and restore when the ray clears. This module owns the two halves that split
// cleanly along the test/live-verify line:
//
//   1. a PURE fade state machine (stepFadeOpacity + OcclusionFader) — no three, no canvas, so its
//      timing/threshold/restore/re-trigger behaviour is unit-tested at a 60-fps step (A.5 line 1);
//   2. a tiny THREE-mesh REGISTRY (named-building boxes + hero meshes register on mount) that
//      TorontoScene raycasts camera→car against each frame and applies the faded opacity to. The
//      raycast + material write is live-only (a headless canvas can't prove alpha visually), so it
//      lives in the scene and is verified by screenshot, not here.
//
// Instanced FILLER boxes are explicitly OUT of scope this phase (they share one material, so
// per-instance opacity needs a shader edit) — recorded debt. A.5's own mandatory cases (the
// financial-district named banks + the CN Tower) are all named/hero meshes, which this covers.

import type { Object3D } from 'three';

/** Faded alpha for an occluding surface (A.5: ≤ 0.4 — we settle at 0.35 for margin). */
export const FADE_MIN = 0.35 as const;
/** Fully-opaque alpha. */
export const FADE_MAX = 1 as const;
/** Time (ms) for a full FADE_MAX↔FADE_MIN traversal. 130 ms clears the ≤0.4-within-150 ms bar
 * with headroom (0.4 is reached at ~110 ms), while staying smooth enough to read as a fade. */
export const FADE_DURATION_MS = 130 as const;

/** Per-ms opacity rate for the full range. */
const RATE = (FADE_MAX - FADE_MIN) / FADE_DURATION_MS;

/**
 * Advance one surface's opacity toward its target (FADE_MIN when occluded, FADE_MAX when clear)
 * by `dtMs`, clamped to [FADE_MIN, FADE_MAX]. Pure — the whole controller is just this applied
 * per key, so the live scene and the unit tests exercise identical logic.
 */
export function stepFadeOpacity(current: number, occluded: boolean, dtMs: number): number {
  const target = occluded ? FADE_MIN : FADE_MAX;
  const maxStep = RATE * dtMs;
  if (current < target) return Math.min(target, current + maxStep);
  if (current > target) return Math.max(target, current - maxStep);
  return current;
}

/** Whether a material should carry `transparent = true` at this opacity — only WHILE fading, so a
 * fully-opaque surface stays in the cheap opaque (no-sort) pass. */
export function needsTransparent(opacity: number): boolean {
  return opacity < FADE_MAX - 1e-4;
}

/**
 * Keyed fade state for a set of occludable surfaces. `step` advances every listed key toward its
 * target given the currently-occluded subset; `opacity` reads a key's current alpha (default full
 * opacity for a never-seen key). Deliberately tiny + pure so it is unit-tested exactly as it runs.
 */
export class OcclusionFader<K> {
  private readonly opacities = new Map<K, number>();

  opacity(key: K): number {
    return this.opacities.get(key) ?? FADE_MAX;
  }

  /** Advance every key in `keys` toward FADE_MIN (if in `occluded`) or FADE_MAX (if not). */
  step(keys: Iterable<K>, occluded: ReadonlySet<K>, dtMs: number): void {
    for (const key of keys) {
      const current = this.opacities.get(key) ?? FADE_MAX;
      this.opacities.set(key, stepFadeOpacity(current, occluded.has(key), dtMs));
    }
  }

  /** Drop a key's tracked state (e.g. a mesh unregistered). */
  forget(key: K): void {
    this.opacities.delete(key);
  }

  /** Lowest opacity currently tracked (1 if nothing is fading) — a headless proof-of-life for the
   * scene raycast: a scripted check can read this to confirm a real occluder was faded, since the
   * §5.3 camera setback makes a dramatic "see-through tower" screenshot geometrically impossible. */
  minOpacity(): number {
    let min: number = FADE_MAX;
    for (const v of this.opacities.values()) if (v < min) min = v;
    return min;
  }
}

// --- live-side registry (three meshes; TorontoScene owns the raycast + material write) --------

/** The set of meshes the camera→car ray tests against — named-building boxes + hero meshes add
 * themselves on mount and remove on unmount. A module singleton so both layers and the scene's
 * per-frame pass share one list without prop-drilling through the R3F tree. */
export interface OcclusionRegistry {
  add(mesh: Object3D): void;
  remove(mesh: Object3D): void;
  /** Live snapshot of the currently-registered meshes (safe to iterate; not a copy per call). */
  readonly meshes: readonly Object3D[];
}

export function createOcclusionRegistry(): OcclusionRegistry {
  const set = new Set<Object3D>();
  let cache: Object3D[] = [];
  let dirty = false;
  return {
    add(mesh) {
      if (!set.has(mesh)) {
        set.add(mesh);
        dirty = true;
      }
    },
    remove(mesh) {
      if (set.delete(mesh)) dirty = true;
    },
    get meshes() {
      if (dirty) {
        cache = [...set];
        dirty = false;
      }
      return cache;
    },
  };
}

/** The scene-wide occludable registry (named boxes + heroes). */
export const occlusionRegistry = createOcclusionRegistry();

/** The scene-wide fade state (TorontoScene's per-frame raycast steps it; core/debugBridge.ts reads
 * its minOpacity() for the headless occlusion proof). One singleton so the scene + bridge share it. */
export const occlusionFader = new OcclusionFader<string>();
