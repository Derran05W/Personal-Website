// The Phase 16 particle SEAM — the decoupling layer between everything that WANTS
// particles (combat resolvers, decal systems, damage-state wiring, event subscribers)
// and the ONE instanced particle system that renders them (fx/particles.ts). Same
// producer/consumer discipline as combat/tracerFeed.ts and combat/explosionFeed.ts:
// producers push plain records with no three.js imports, the render-side system drains
// per frame. Two shapes live here because particles come in two temporal flavors:
//
//   1. BURSTS  — one-shot fire-and-forget (impact sparks, debris chips, explosion
//                embers, transformer spark showers). Ring buffer, drained exactly once
//                per frame by fx/particles.ts. If nothing drains (system unmounted),
//                old bursts are silently overwritten — FX are droppable by design.
//   2. EMITTERS — persistent attached sources (tire smoke while drifting, damage smoke
//                ≥50% HP lost, fire ≥75%, shell smoke trails). A Set of live records
//                whose owner mutates position/velocity/intensity in place each frame
//                and calls release() when done. fx/particles.ts iterates the set each
//                frame and decides — under its per-source budgets and farthest-first
//                starvation — how many particles each emitter actually gets. Emitter
//                OWNERS never think about budgets; the sink owns all rationing.
//
// Neither side imports the other: producers import only this module, and the sink polls
// it. Registration order therefore doesn't matter (an emitter attached before the
// system mounts just starts rendering when the system arrives).
export type ParticlePreset =
  | 'impactSparks' // hard contact: brief warm spark spray at the impact point
  | 'debrisChips' // prop destruction: chunky matte chips tumbling under gravity
  | 'tireSmoke' // drift smoke behind the rear wheels (emitter)
  | 'damageSmoke' // grey column off a ≥50%-damaged vehicle (emitter)
  | 'fire' // flickering flame lick off a ≥75%-damaged vehicle (emitter)
  | 'explosion' // ember burst + smoke ring augmenting fx/Explosions.tsx's flash/light
  | 'transformerSparks' // electrical arc shower on transformerDestroyed
  | 'shellTrail'; // smoke trail behind a live tank shell (emitter)

/** One-shot burst request. Plain data — safe to push from physics-step callbacks. */
export interface FxBurst {
  preset: ParticlePreset;
  /** World-space origin. */
  x: number;
  y: number;
  z: number;
  /** Inherited velocity (m/s) added to every particle's preset spread. Default 0. */
  vx: number;
  vy: number;
  vz: number;
  /** Preset-relative scale (1 = nominal): multiplies burst count and size. */
  intensity: number;
  /** Monotonic id so the drain can skip records it has already consumed. */
  seq: number;
}

/** Persistent emitter record. The OWNER mutates position/velocity/intensity in place
 * (no per-frame allocation); the sink reads them each frame. intensity 0 pauses the
 * emitter without detaching it; release() removes it from the live set for good. */
export interface FxEmitter {
  readonly preset: ParticlePreset;
  readonly position: { x: number; y: number; z: number };
  readonly velocity: { x: number; y: number; z: number };
  /** 0 = paused, 1 = nominal, >1 pushes the preset's rate up (sink may clamp). */
  intensity: number;
  /** Detach permanently. Idempotent. */
  release(): void;
}

const BURST_CAPACITY = 64;
const bursts: FxBurst[] = [];
let burstSeq = 0;
let burstWrite = 0;

/** Push a one-shot burst. Overwrites the oldest slot when the ring is full — bursts are
 * cosmetic and droppable, never a queue that back-pressures gameplay code. */
export function pushFxBurst(
  preset: ParticlePreset,
  x: number,
  y: number,
  z: number,
  opts?: { vx?: number; vy?: number; vz?: number; intensity?: number },
): void {
  const record: FxBurst = {
    preset,
    x,
    y,
    z,
    vx: opts?.vx ?? 0,
    vy: opts?.vy ?? 0,
    vz: opts?.vz ?? 0,
    intensity: opts?.intensity ?? 1,
    seq: burstSeq++,
  };
  if (bursts.length < BURST_CAPACITY) {
    bursts.push(record);
  } else {
    bursts[burstWrite] = record;
    burstWrite = (burstWrite + 1) % BURST_CAPACITY;
  }
}

/** Drain every burst pushed since `afterSeq`, oldest-first. Returns the highest seq
 * seen (pass it back next frame). Exactly one consumer: fx/particles.ts. */
export function drainFxBursts(afterSeq: number, consume: (burst: FxBurst) => void): number {
  let maxSeq = afterSeq;
  // The ring is small; a filtered sort-free two-pass scan keeps order without allocation
  // pressure (seq is monotonic, so "oldest-first" = ascending seq among unseen records).
  for (let pass = 0; pass < bursts.length; pass++) {
    let best: FxBurst | null = null;
    for (const b of bursts) {
      if (b.seq > maxSeq && (best === null || b.seq < best.seq)) best = b;
    }
    if (best === null) break;
    consume(best);
    maxSeq = best.seq;
  }
  return maxSeq;
}

const emitters = new Set<FxEmitter>();

/** Attach a persistent emitter at a position. Mutate the returned record's fields each
 * frame; call release() when the source dies. Never renders anything by itself — the
 * particle system polls getFxEmitters() and rations particles across the live set. */
export function attachFxEmitter(
  preset: ParticlePreset,
  x: number,
  y: number,
  z: number,
): FxEmitter {
  const emitter: FxEmitter = {
    preset,
    position: { x, y, z },
    velocity: { x: 0, y: 0, z: 0 },
    intensity: 1,
    release() {
      emitters.delete(emitter);
    },
  };
  emitters.add(emitter);
  return emitter;
}

/** The live emitter set, polled per frame by fx/particles.ts. Read-only to consumers. */
export function getFxEmitters(): ReadonlySet<FxEmitter> {
  return emitters;
}

/** Test/remount hygiene: drop all live emitters and pending bursts. */
export function resetFxFeed(): void {
  emitters.clear();
  bursts.length = 0;
  burstWrite = 0;
}
