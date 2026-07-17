// Pure decision table for whether/when the lazy game chunk mounts (Phase 18 Task 3).
// Deliberately framework- and DOM-free so the whole gating matrix is unit-testable without
// touching jsdom — routes/Home.tsx (the only caller) supplies the three booleans from
// webgl.ts / deviceCapabilities.ts and renders off the result.
export type GameGate =
  // No WebGL2: the game must never mount, ever, regardless of device or motion prefs.
  // Static hero + shell only (TDD §9/§15).
  | 'unsupported'
  // Fine pointer, motion ok: today's behavior, unchanged — mount immediately on Home
  // mount.
  | 'auto-start'
  // Coarse pointer (touch) OR prefers-reduced-motion: never auto-mount. Show a Play
  // card; the game only mounts once the user explicitly taps it (part-6-ship.md P18
  // decision: mobile ALWAYS shows the Play card, no auto-start).
  | 'play-card';

export interface GameGateInputs {
  webgl2Available: boolean;
  coarsePointer: boolean;
  reducedMotion: boolean;
}

export function resolveGameGate({
  webgl2Available,
  coarsePointer,
  reducedMotion,
}: GameGateInputs): GameGate {
  if (!webgl2Available) return 'unsupported';
  if (coarsePointer || reducedMotion) return 'play-card';
  return 'auto-start';
}
