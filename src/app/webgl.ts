// WebGL2 feature-detection gate (Phase 18 Task 3). TDD §9/§15: "if WebGL2 is unavailable:
// static skyline hero + header links (graceful degrade)" / "WebGL context loss / no WebGL2
// -> ... static hero fallback". The game must never be a hard requirement to see the
// portfolio, so this check runs in the shell, BEFORE the lazy game chunk is ever mounted
// (routes/Home.tsx is the only caller) — it has no import from src/game/ at all, keeping
// the app/game boundary intact regardless of the result.
//
// This is a real GL context probe, not a UA sniff: some browsers report a WebGL2-capable
// UA but sit behind a GPU blocklist that makes `getContext('webgl2')` return null (or, on
// some driver/browser combinations, throw) — either outcome means "can't run the game,"
// so both are treated as unsupported.
let cached: boolean | null = null;

/**
 * Probes for WebGL2 support via a throwaway `<canvas>`. Cached at module scope after the
 * first call — support can't change mid-session, and repeating the probe on every render
 * would be wasteful (context creation isn't free).
 */
export function detectWebGL2(): boolean {
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    cached = gl !== null;
  } catch {
    cached = false;
  }
  return cached;
}

/** Test-only: clears the module-scope cache so each test can probe fresh. Never called
 * from production code. */
export function __resetWebGL2CacheForTests(): void {
  cached = null;
}
