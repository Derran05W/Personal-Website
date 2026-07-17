// Tracer/hit FX feed (Phase 11 seam, orchestrator-authored). combat/hitscan.ts PUSHES one
// record per fired round; the FX layer (fx/Tracers.tsx, Task 3) drains and renders them as
// short-lived additive lines + sparks. A plain ring buffer + version counter — no events,
// no React: the FX component polls per frame (cheap; bursts are rare).

export interface TracerShot {
  /** Muzzle world position. */
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  /** Hit (or max-range) world position. */
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
  /** True when the round struck something (spark at x1), false = flew to max range. */
  readonly hit: boolean;
  /** performance.now() at fire time — FX fades by age. */
  readonly t: number;
}

const CAP = 64;
const shots: TracerShot[] = [];
let version = 0;

export function pushTracer(shot: TracerShot): void {
  if (shots.length >= CAP) shots.shift();
  shots.push(shot);
  version++;
}

export function readTracers(): { readonly shots: readonly TracerShot[]; readonly version: number } {
  return { shots, version };
}

export function clearTracers(): void {
  shots.length = 0;
  version++;
}
