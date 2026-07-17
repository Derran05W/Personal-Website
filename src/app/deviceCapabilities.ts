// Device-capability probes that decide whether the game auto-mounts or waits for an
// explicit tap (Phase 18 Task 3). TDD §9: "prefers-reduced-motion -> don't auto-start;
// show a 'Play' card"; part-6-ship.md's Phase 18 plan additionally locks mobile to ALWAYS
// showing the Play card (no auto-start), desktop keeps the existing auto-flow. Shell-side,
// zero imports from src/game/ — same lazy-seam rule as webgl.ts.
export interface DeviceCapabilities {
  /** True for touch-primary devices (phones/tablets) — CSS `(pointer: coarse)`. A
   * touch-capable laptop with a mouse as primary pointer reads `fine` here, which is the
   * correct "desktop" read for this gate. */
  coarsePointer: boolean;
  /** True when the OS/browser asks for reduced motion — CSS `(prefers-reduced-motion:
   * reduce)`. */
  reducedMotion: boolean;
}

const COARSE_POINTER_QUERY = '(pointer: coarse)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function mediaMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    // A handful of embedded/test environments implement matchMedia but throw on certain
    // query strings — treat "can't tell" as the safer default (fine pointer, motion ok),
    // which resolves to the existing desktop auto-start behavior rather than stranding a
    // real desktop user behind an unnecessary Play card.
    return false;
  }
}

/** One-shot read. Callers snapshot this once (at Home mount) to decide the game's
 * initial gate — a capability changing mid-session (e.g. rotating a tablet) deliberately
 * does not retroactively mount or unmount an already-decided game; see gameGate.ts. */
export function readDeviceCapabilities(): DeviceCapabilities {
  return {
    coarsePointer: mediaMatches(COARSE_POINTER_QUERY),
    reducedMotion: mediaMatches(REDUCED_MOTION_QUERY),
  };
}
