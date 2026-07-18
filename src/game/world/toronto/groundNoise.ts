// Phase 25.8 (D6) — a seeded, TILEABLE value-noise luminance field for the ground/tint/park
// surfaces (the "give the grass/ground more texture" ask). Pure TS (no three/canvas) so it is
// unit-testable; TorontoScene paints one sample of it into a 256² CanvasTexture, sets it as `map`
// on the EXISTING unlit ground/tint/park materials with RepeatWrapping + world-planar UVs (x/z ÷
// tileWu), and it MULTIPLIES over the vertex-colour ladder. +0 draw calls, +0 meshes.
//
// The field is a coarse random lattice (seeded, mulberry via world/rng) bilinearly interpolated
// with a smoothstep, WRAP-AWARE (lattice index i+1 wraps mod n) so the tile is seamless under
// RepeatWrapping — sampleNoiseField(u=0) === sampleNoiseField(u=1) (asserted in the test). Values
// stay in [lo, hi] with lo chosen ABOVE the palette ladder's tightest adjacent ratio so the ±grain
// can never invert the P22/P23 contrast ladder (road < ground < sidewalk); asserted in the test.

import { createRng } from '../rng';

export interface NoiseField {
  /** Lattice resolution (n×n cells). */
  readonly n: number;
  /** Row-major n×n lattice of luminance values in [lo, hi]. */
  readonly data: Float32Array;
  readonly lo: number;
  readonly hi: number;
}

/** Build an n×n seeded luminance lattice in [lo, hi]. Deterministic (mulberry fork). */
export function buildNoiseField(seed: number, n: number, lo: number, hi: number): NoiseField {
  const rng = createRng(seed).fork('toronto-ground-noise-v1');
  const data = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) data[i] = lo + rng.next() * (hi - lo);
  return { n, data, lo, hi };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Sample the field at (u, v), any real — wraps mod 1 (periodic, so a RepeatWrapping texture built
 * from px/size samples is seamless). Bilinear with a smoothstep on each axis. */
export function sampleNoiseField(field: NoiseField, u: number, v: number): number {
  const { n, data } = field;
  // Wrap to [0, n); fract of u*n picks the cell + interp weight.
  const fx = ((u % 1) + 1) % 1 * n;
  const fy = ((v % 1) + 1) % 1 * n;
  const ix = Math.floor(fx) % n;
  const iy = Math.floor(fy) % n;
  const ix1 = (ix + 1) % n;
  const iy1 = (iy + 1) % n;
  const tx = smoothstep(fx - Math.floor(fx));
  const ty = smoothstep(fy - Math.floor(fy));
  const a = data[iy * n + ix];
  const b = data[iy * n + ix1];
  const c = data[iy1 * n + ix];
  const d = data[iy1 * n + ix1];
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

/** D6 tuning (config-adjacent, kept here with the generator it parameterizes so a retune is one
 * obvious edit). `lo` sits above the palette ladder's tightest adjacent luminance ratio (road spine
 * ≈ 0.24 / ground ≈ 0.33 ≈ 0.73 in the pre-brighten worst case; post-L3 the ratio is looser), so the
 * grain can never invert the ladder — the noise DARKENS by up to (1-lo) and never lifts a darker
 * surface past a lighter one. tileWu is the world size one tile covers (x/z ÷ tileWu → UV). */
export const GROUND_NOISE = {
  lattice: 48,
  textureSize: 256,
  lo: 0.9,
  hi: 1.0,
  tileWu: 22,
} as const;
