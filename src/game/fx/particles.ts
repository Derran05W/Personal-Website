// The ONE instanced CPU particle system's SIMULATION CORE (Phase 16 Task 1). This module
// owns a single fixed pool of PARTICLES.poolSize slots shared by BOTH render materials and
// does everything EXCEPT touch three.js: spawn from the fx/particleFeed.ts seam, integrate
// motion, recycle dead slots, and — the interesting part — ration a scarce pool across many
// competing sources by FARTHEST-FIRST starvation. fx/ParticlesMount.tsx is the thin R3F
// skin that reads this pool each frame and uploads it to two InstancedMeshes.
//
// WHY A THREE-FREE CORE: everything here is plain numbers on typed arrays (the codebase's
// SoA discipline — see fx/SkidMarks.tsx's runtime, fx/Explosions.tsx's scorch pool), so the
// whole simulation — pool recycling, exactly-once burst drain, starvation victim selection,
// quality budget — unit-tests in node with no WebGL (fx/particles.test.ts). The renderer's
// billboard/matrix math is the only part that needs three, and it lives in the mount.
//
// TWO INPUTS, drained once per frame by updateParticles() (fx/particleFeed.ts's contract):
//   1. BURSTS   — one-shot, drained exactly once via drainFxBursts (monotonic seq cursor).
//                 Processed FIRST and with priority: a fresh impact/explosion should always
//                 spark even when the pool is already full of smoke from distant wrecks.
//   2. EMITTERS — persistent sources iterated from getFxEmitters(). Each accumulates a
//                 fractional spawn rate across frames (a 26/s emitter at 60 fps averages
//                 ~0.43 particles/frame); the whole-number remainder spawns, the fraction
//                 carries. When demand exceeds the free slots left after bursts, emitters
//                 are served NEAREST-camera first — the farthest simply get nothing this
//                 frame (the part-file worst case: a city full of burning wrecks, only the
//                 ones near the player should cost fragments).
//
// ZERO PER-FRAME ALLOCATION: the pool arrays, the free-list, the emitter-ration scratch, and
// the per-emitter accumulator map are all module-scope and reused. updateParticles() and its
// helpers allocate nothing in the steady state (Math.random is alloc-free; the WeakMap's
// get/set are not allocations). Matches the hot-path discipline of every other fx/* system.

import { PARTICLES, type ParticlePartConfig } from '../config/particles';
import {
  drainFxBursts,
  getFxEmitters,
  type FxBurst,
  type FxEmitter,
  type ParticlePreset,
} from './particleFeed';

// --- material routing -----------------------------------------------------------------------
// A particle's material decides which InstancedMesh renders it (fx/ParticlesMount.tsx). Kept
// as 0/1 numbers on the hot path (a per-slot string would be a boxed pointer, not a value).
export const MATERIAL_ADDITIVE = 0;
export const MATERIAL_ALPHA = 1;

const CAP = PARTICLES.poolSize;

/** Total slots the pool allocates (both InstancedMeshes size to this). Fixed at module load;
 * fx/ParticlesMount.tsx reads it to size its instance buffers. */
export const PARTICLE_POOL_CAPACITY = CAP;

// --- flattened spec table -------------------------------------------------------------------
// Every preset PART (impactSparks.main, explosion.embers, explosion.ring, …) is flattened to
// one FlatSpec with a stable global index. A particle stores only that index (specId); all of
// its behaviour is read back through the spec. `cfg` is a LIVE REFERENCE into the config
// object (NOT a copy) so leva edits to counts/life/motion/fade apply immediately — only the
// colours are pre-parsed to RGB here, once, because hex parsing per spawn would allocate.

interface FlatSpec {
  readonly preset: ParticlePreset;
  readonly partKey: string;
  /** Live config reference — read cfg.count/life/size/speed/gravity/drag/fade/flicker fresh
   * each spawn/frame so dev-panel tuning is immediate (only colours are frozen below). */
  readonly cfg: ParticlePartConfig;
  /** 0 = additive, 1 = alpha (frozen: `material` is a leva-skipped string, never live-edited). */
  readonly material: number;
  /** Pre-parsed palette: r,g,b triples in [0,1], length 3·colorCount. */
  readonly rgb: Float32Array;
  readonly colorCount: number;
}

/** Parse '#rgb' / '#rrggbb' to [r,g,b] in [0,1] — a tiny three-free hex reader so the sim
 * stays testable in node. Unknown formats fall back to white (never throws on FX data). */
function hexToRgb(hex: string, out: Float32Array, offset: number): void {
  let h = hex.charCodeAt(0) === 35 /* '#' */ ? hex.slice(1) : hex;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) {
    out[offset] = out[offset + 1] = out[offset + 2] = 1;
    return;
  }
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) {
    out[offset] = out[offset + 1] = out[offset + 2] = 1;
    return;
  }
  out[offset] = ((n >> 16) & 0xff) / 255;
  out[offset + 1] = ((n >> 8) & 0xff) / 255;
  out[offset + 2] = (n & 0xff) / 255;
}

// Build the flat spec table + the preset→spec-index map + the emitter's single spec index.
const FLAT_SPECS: FlatSpec[] = [];
const PRESET_SPEC_IDS: Record<string, number[]> = {};
for (const [preset, def] of Object.entries(PARTICLES.presets)) {
  const ids: number[] = [];
  for (const [partKey, part] of Object.entries(def.parts)) {
    const colorCount = part.colors.length;
    const rgb = new Float32Array(colorCount * 3);
    for (let c = 0; c < colorCount; c += 1) hexToRgb(part.colors[c], rgb, c * 3);
    ids.push(FLAT_SPECS.length);
    FLAT_SPECS.push({
      preset: preset as ParticlePreset,
      partKey,
      cfg: part,
      material: part.material === 'additive' ? MATERIAL_ADDITIVE : MATERIAL_ALPHA,
      rgb,
      colorCount,
    });
  }
  PRESET_SPEC_IDS[preset] = ids;
}

/** The flat spec table, indexed by a particle's specId. Exposed (read-only intent) so
 * fx/ParticlesMount.tsx can read a live particle's material/fade/flicker without re-deriving
 * them — the sim stores only the index. */
export function getParticleSpecs(): readonly FlatSpec[] {
  return FLAT_SPECS;
}
export type { FlatSpec };

// --- pool state (Structure-of-Arrays; module-scope, reused) ---------------------------------
// A slot is FREE iff life[i] === 0. Everything else is only meaningful while alive.
const px = new Float32Array(CAP);
const py = new Float32Array(CAP);
const pz = new Float32Array(CAP);
const vx = new Float32Array(CAP);
const vy = new Float32Array(CAP);
const vz = new Float32Array(CAP);
const age = new Float32Array(CAP); // seconds since spawn
const life = new Float32Array(CAP); // total lifetime (s); 0 ⇒ free slot
const size0 = new Float32Array(CAP); // billboard size at t=0 (m), jitter already applied
const size1 = new Float32Array(CAP); // billboard size at t=1 (m), jitter already applied
const cr = new Float32Array(CAP); // base colour, chosen once at spawn
const cg = new Float32Array(CAP);
const cb = new Float32Array(CAP);
const specId = new Uint8Array(CAP); // index into FLAT_SPECS

/** Read-only-intent view of the pool buffers for the renderer/tests. Positions + fade inputs
 * only (velocity/drag stay internal to the sim). fx/ParticlesMount.tsx iterates [0,CAP) and
 * treats life[i] > 0 as "alive". */
export interface ParticleBuffers {
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size0: Float32Array;
  readonly size1: Float32Array;
  readonly cr: Float32Array;
  readonly cg: Float32Array;
  readonly cb: Float32Array;
  readonly specId: Uint8Array;
  readonly capacity: number;
}
const buffers: ParticleBuffers = {
  px, py, pz, age, life, size0, size1, cr, cg, cb, specId, capacity: CAP,
};
export function getParticleBuffers(): ParticleBuffers {
  return buffers;
}

// --- free-list (O(1) alloc/free) + live accounting ------------------------------------------
// freeStack[0..freeTop) holds the indices of free slots. liveCount = CAP − freeTop.
const freeStack = new Int32Array(CAP);
// `: number` — CAP carries the literal type 500 (config is `as const`); without the
// annotation `let freeTop = CAP` would infer the narrow literal type, not a mutable number.
let freeTop: number = CAP;
for (let i = 0; i < CAP; i += 1) freeStack[i] = i;

// Live counts per material, maintained incrementally (O(1)) so getParticleStats() need not
// scan the pool: [additive, alpha].
const liveByMaterial = [0, 0];

// Effective budget: never keep more than this many particles alive (quality scaling). Clamped
// to [0, CAP]. Default = full pool; fx/ParticlesMount.tsx lowers it per quality tier.
// `: number` for the same literal-widening reason as freeTop above.
let budget: number = CAP;

/** Set the effective pool budget (config/quality.ts's particleCap). Clamped to [0, CAP].
 * Shrinking below the current live count doesn't kill anyone — existing particles age out
 * naturally and new spawns are simply refused until liveCount drops under the new budget. */
export function setParticleBudget(cap: number): void {
  budget = cap < 0 ? 0 : cap > CAP ? CAP : Math.floor(cap);
}

function liveCount(): number {
  return CAP - freeTop;
}

/** Allocate one slot, or -1 when the pool is full OR the effective budget is reached. */
function alloc(material: number): number {
  if (freeTop === 0) return -1;
  if (liveCount() >= budget) return -1;
  const i = freeStack[--freeTop];
  liveByMaterial[material] += 1;
  return i;
}

function free(i: number): void {
  liveByMaterial[FLAT_SPECS[specId[i]].material] -= 1;
  life[i] = 0;
  freeStack[freeTop++] = i;
}

// --- spawn ----------------------------------------------------------------------------------
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Initialise one slot from FLAT_SPECS[id] at (ox,oy,oz) with inherited velocity (ivx..) and a
 * size multiplier (bursts pass their intensity so a bigger blast throws bigger embers, per
 * fx/particleFeed.ts; emitters pass 1). Returns false if the pool/budget refused a slot.
 */
function spawnParticle(
  id: number,
  ox: number,
  oy: number,
  oz: number,
  ivx: number,
  ivy: number,
  ivz: number,
  sizeScale: number,
): boolean {
  const spec = FLAT_SPECS[id];
  const i = alloc(spec.material);
  if (i < 0) return false;
  const cfg = spec.cfg;

  const angle = Math.random() * Math.PI * 2;
  const radial = lerp(cfg.speed.radialMin, cfg.speed.radialMax, Math.random());
  const up = lerp(cfg.speed.upMin, cfg.speed.upMax, Math.random());
  vx[i] = ivx + Math.cos(angle) * radial;
  vz[i] = ivz + Math.sin(angle) * radial;
  vy[i] = ivy + up;

  px[i] = ox;
  py[i] = oy < PARTICLES.groundY ? PARTICLES.groundY : oy;
  pz[i] = oz;

  age[i] = 0;
  life[i] = lerp(cfg.life.min, cfg.life.max, Math.random());

  const jitter = 1 + (Math.random() * 2 - 1) * cfg.size.jitter;
  const s = jitter * sizeScale;
  size0[i] = cfg.size.start * s;
  size1[i] = cfg.size.end * s;

  const ci = (Math.random() * spec.colorCount) | 0;
  const co = ci * 3;
  cr[i] = spec.rgb[co];
  cg[i] = spec.rgb[co + 1];
  cb[i] = spec.rgb[co + 2];

  specId[i] = id;
  return true;
}

// --- burst intake (exactly-once) ------------------------------------------------------------
// drainFxBursts hands us every FxBurst pushed since lastBurstSeq, oldest-first, and returns
// the new high-water seq (fx/particleFeed.ts). Storing it here is what makes the drain
// exactly-once: a burst consumed this frame is never re-seen next frame.
let lastBurstSeq = -1;

function consumeBurst(burst: FxBurst): void {
  const ids = PRESET_SPEC_IDS[burst.preset];
  if (ids === undefined) return; // unknown preset name — ignore (never throws on FX data)
  const cap = PARTICLES.presets[burst.preset].perSourceCap;
  const intensity = burst.intensity;
  for (let k = 0; k < ids.length; k += 1) {
    const spec = FLAT_SPECS[ids[k]];
    let n = Math.round(spec.cfg.count * intensity);
    if (n > cap) n = cap; // per-source anti-spike clamp
    for (let s = 0; s < n; s += 1) {
      // Stop this part early if the pool/budget is exhausted — bursts are droppable.
      if (!spawnParticle(ids[k], burst.x, burst.y, burst.z, burst.vx, burst.vy, burst.vz, intensity)) break;
    }
  }
}

// --- emitter intake (farthest-first ration) -------------------------------------------------
// Per-emitter fractional spawn accumulator. WeakMap so a released emitter's entry is GC'd
// with the emitter (no manual cleanup, no leak). get/set are allocation-free.
let accByEmitter = new WeakMap<FxEmitter, number>();

// Reused ration scratch (no per-frame allocation). Filled up to `n` each frame:
//   scratchEm[k]     = the k-th candidate emitter
//   scratchDemand[k] = whole particles it would like to spawn this frame (post-accumulator)
//   scratchDist[k]   = squared distance to the camera (starvation key)
//   scratchOrder[k]  = index permutation, insertion-sorted nearest→farthest when rationing
const MAX_EM = PARTICLES.maxTrackedEmitters;
const scratchEm: (FxEmitter | null)[] = new Array<FxEmitter | null>(MAX_EM).fill(null);
const scratchDemand = new Int32Array(MAX_EM);
const scratchDist = new Float32Array(MAX_EM);
const scratchOrder = new Int32Array(MAX_EM);

function spawnFromEmitter(em: FxEmitter, want: number): void {
  const ids = PRESET_SPEC_IDS[em.preset];
  if (ids === undefined || ids.length === 0) return;
  // Emitter presets are single-part by construction (config/particles.ts) — spawn part 0.
  const id = ids[0];
  const p = em.position;
  const v = em.velocity;
  for (let s = 0; s < want; s += 1) {
    if (!spawnParticle(id, p.x, p.y, p.z, v.x, v.y, v.z, 1)) break;
  }
}

function processEmitters(dt: number, camX: number, camY: number, camZ: number): void {
  const emitters = getFxEmitters();

  // Pass 1: advance each emitter's accumulator and record its integer demand + distance.
  let n = 0;
  let totalDemand = 0;
  for (const em of emitters) {
    if (n >= MAX_EM) break; // scratch is full — extra emitters skipped this frame (droppable)
    const preset = PARTICLES.presets[em.preset];
    const ids = PRESET_SPEC_IDS[em.preset];
    if (preset === undefined || ids === undefined || ids.length === 0) continue;

    // Accumulate rate·intensity·dt; the whole part spawns, the fraction carries to next frame.
    const rate = FLAT_SPECS[ids[0]].cfg.count;
    let acc = (accByEmitter.get(em) ?? 0) + rate * em.intensity * dt;
    let demand = Math.floor(acc);
    acc -= demand; // keep only the sub-1 remainder → no unbounded catch-up backlog
    accByEmitter.set(em, acc);
    if (demand > preset.perSourceCap) demand = preset.perSourceCap; // anti-spike clamp
    if (demand <= 0) continue;

    const dx = em.position.x - camX;
    const dy = em.position.y - camY;
    const dz = em.position.z - camZ;
    scratchEm[n] = em;
    scratchDemand[n] = demand;
    scratchDist[n] = dx * dx + dy * dy + dz * dz;
    totalDemand += demand;
    n += 1;
  }

  if (n === 0) return;

  const remainingFree = budget - liveCount();
  if (remainingFree <= 0) {
    releaseScratch(n);
    return;
  }

  if (totalDemand <= remainingFree) {
    // Everyone fits — no starvation, order irrelevant.
    for (let k = 0; k < n; k += 1) spawnFromEmitter(scratchEm[k]!, scratchDemand[k]);
    releaseScratch(n);
    return;
  }

  // Starvation: serve NEAREST first. Insertion-sort the index permutation by ascending
  // squared distance (n ≤ MAX_EM = 64, so O(n²) is trivial and, unlike Array.sort on a
  // sub-range, allocation-free). Farthest emitters run out of budget and spawn nothing.
  for (let k = 0; k < n; k += 1) scratchOrder[k] = k;
  for (let k = 1; k < n; k += 1) {
    const idx = scratchOrder[k];
    const d = scratchDist[idx];
    let j = k - 1;
    while (j >= 0 && scratchDist[scratchOrder[j]] > d) {
      scratchOrder[j + 1] = scratchOrder[j];
      j -= 1;
    }
    scratchOrder[j + 1] = idx;
  }

  let remaining = remainingFree;
  for (let o = 0; o < n && remaining > 0; o += 1) {
    const k = scratchOrder[o];
    const give = scratchDemand[k] < remaining ? scratchDemand[k] : remaining;
    spawnFromEmitter(scratchEm[k]!, give);
    remaining -= give;
  }
  releaseScratch(n);
}

/** Drop the transient emitter references held in scratch so a released emitter isn't pinned
 * alive by a stale slot between frames. */
function releaseScratch(n: number): void {
  for (let k = 0; k < n; k += 1) scratchEm[k] = null;
}

// --- per-frame update -----------------------------------------------------------------------
/**
 * Advance the whole system one frame: integrate + recycle existing particles, then intake new
 * ones (bursts first, emitters rationed farthest-first against the leftover budget). `dt` is
 * seconds; the camera position drives starvation. Allocates nothing in the steady state.
 */
export function updateParticles(dt: number, camX: number, camY: number, camZ: number): void {
  // 1) integrate + free expired. life[i] === 0 marks a free slot (skip).
  const groundY = PARTICLES.groundY;
  for (let i = 0; i < CAP; i += 1) {
    if (life[i] === 0) continue;
    const a = age[i] + dt;
    if (a >= life[i]) {
      free(i);
      continue;
    }
    age[i] = a;
    const cfg = FLAT_SPECS[specId[i]].cfg;
    vy[i] += cfg.gravity * dt;
    let d = 1 - cfg.drag * dt;
    if (d < 0) d = 0;
    vx[i] *= d;
    vy[i] *= d;
    vz[i] *= d;
    px[i] += vx[i] * dt;
    pz[i] += vz[i] * dt;
    let ny = py[i] + vy[i] * dt;
    if (ny < groundY) {
      ny = groundY;
      vy[i] = 0; // rest on the ground (no bounce) — cheap, reads fine at low-poly scale
    }
    py[i] = ny;
  }

  // 2) bursts — drained exactly once, spawned with priority (see file header).
  lastBurstSeq = drainFxBursts(lastBurstSeq, consumeBurst);

  // 3) emitters — rationed farthest-first against whatever budget the bursts left.
  processEmitters(dt, camX, camY, camZ);
}

// --- stats + reset --------------------------------------------------------------------------
export interface ParticleStats {
  /** Particles currently alive across both materials. */
  readonly live: number;
  /** Fixed pool capacity (PARTICLE_POOL_CAPACITY) — the denominator for a utilization readout. */
  readonly poolSize: number;
  /** Live draw calls: one per material that has ≥1 live particle (0, 1, or 2). */
  readonly drawCalls: number;
}

/** Cheap O(1) snapshot for the dev panel monitor and the __smashy bridge (orchestrator wires
 * it). Live counts are maintained incrementally, so this never scans the pool. */
export function getParticleStats(): ParticleStats {
  const drawCalls = (liveByMaterial[MATERIAL_ADDITIVE] > 0 ? 1 : 0) + (liveByMaterial[MATERIAL_ALPHA] > 0 ? 1 : 0);
  return { live: liveByMaterial[MATERIAL_ADDITIVE] + liveByMaterial[MATERIAL_ALPHA], poolSize: CAP, drawCalls };
}

/**
 * Clear the whole pool (run restart / remount / test isolation). Frees every slot, zeroes the
 * live accounting, drops all per-emitter accumulators, and advances the burst cursor PAST any
 * bursts still pending in the feed so a fresh mount doesn't replay the previous run's tail
 * (the emitter Set itself is owned by fx/particleFeed.ts — resetFxFeed() clears that). Does
 * NOT touch the budget (that's a quality setting, not run state).
 */
export function resetParticles(): void {
  for (let i = 0; i < CAP; i += 1) {
    life[i] = 0;
    freeStack[i] = i;
  }
  freeTop = CAP;
  liveByMaterial[MATERIAL_ADDITIVE] = 0;
  liveByMaterial[MATERIAL_ALPHA] = 0;
  accByEmitter = new WeakMap<FxEmitter, number>();
  for (let k = 0; k < MAX_EM; k += 1) scratchEm[k] = null;
  // Swallow any pending bursts so they don't spawn on the next update after a reset.
  lastBurstSeq = drainFxBursts(lastBurstSeq, noop);
}

function noop(): void {
  /* discard */
}
