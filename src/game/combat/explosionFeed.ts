// Explosion FX feed (Phase 12 seam, orchestrator-authored; mirrors combat/tracerFeed.ts).
// combat/explosion.ts pushes one record per detonation; the FX layer polls and renders
// flash/light/smoke/scorch/shake from it.

export interface ExplosionRecord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radiusM: number;
  /** core/simClock.ts's simNowMs() at detonation — FX fades by age. Phase 42: that clock (wall
   * clock minus frozen spans) rather than performance.now(), so a blast holds mid-fade while a dev
   * freezes the world; fx/Explosions.tsx reads ages off the same clock. */
  readonly t: number;
}

const CAP = 16;
const blasts: ExplosionRecord[] = [];
let version = 0;

export function pushExplosion(rec: ExplosionRecord): void {
  if (blasts.length >= CAP) blasts.shift();
  blasts.push(rec);
  version++;
}

export function readExplosions(): { readonly blasts: readonly ExplosionRecord[]; readonly version: number } {
  return { blasts, version };
}

export function clearExplosions(): void {
  blasts.length = 0;
  version++;
}
