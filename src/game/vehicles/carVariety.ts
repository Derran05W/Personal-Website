// Phase 29 (D4) — the civilian-car variety algorithm: a seeded, deterministic weighted pick of
// {model, colour} for every civilian car in the Toronto world (moving traffic, street-parked cars,
// parking-lot cars), with small HSV jitter and an anti-repeat window so the street never reads as a
// row of identical cars. PURE: no three/Rapier/React — it takes an Rng (world/rng.ts) and the
// config tables (config/carVariety.ts) and returns plain data, so it unit-tests in a bare vitest
// env (distribution, determinism, anti-repeat) and drops into any consumer's own rng loop.
//
// Consumers all render the NEUTRAL-BODY variant (config/carVariety.ts neutralVehicleModelId) tinted
// by `colorHex`; this module returns the BASE model id + the target colour (the semantic pick), and
// each consumer maps to the neutral variant at its render/data boundary.

import {
  CAR_COLOR_JITTER,
  CAR_VARIETY_ANTI_REPEAT_WINDOW,
  CAR_VARIETY_MAX_REROLLS,
  CIVILIAN_CAR_MODELS,
  SPORTS_MODEL_IDS,
  SPORTS_SATURATED_BIAS,
  TORONTO_CAR_PALETTE,
  type CarColorEntry,
  type CarColorFamily,
} from '../config/carVariety';
import { createRng, type Rng } from '../world/rng';

/** One resolved civilian-car look. `modelId` is the BASE pack id (map to the neutral variant at the
 * render boundary); `colorHex` is the jittered body colour; `colorFamily` drives anti-repeat. */
export interface CarVariety {
  readonly modelId: string;
  readonly colorHex: string;
  readonly colorFamily: CarColorFamily;
}

/** Live sequencer state: an rng stream + the rolling anti-repeat history. */
export interface CarVarietySequencer {
  next(): CarVariety;
}

// --- pure colour helpers (no three; keeps the module unit-testable in bare node) ----------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** sRGB hex (`#rrggbb`) → [r,g,b] each in [0,1]. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** [r,g,b] in [0,1] → sRGB hex. */
export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number): number => Math.round(clamp01(v) * 255);
  const packed = (to(r) << 16) | (to(g) << 8) | to(b);
  return `#${(packed >>> 0).toString(16).padStart(6, '0')}`;
}

/** RGB [0,1] → HSV (h in [0,360), s/v in [0,1]). */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

/** HSV (h in [0,360), s/v in [0,1]) → RGB [0,1]. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let rgb: [number, number, number];
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = v - c;
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/** Apply a small seeded HSV jitter (config CAR_COLOR_JITTER) to a base hex → a new hex. */
export function jitterColor(rng: Rng, hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, v] = rgbToHsv(r, g, b);
  const jh = h + (rng.next() * 2 - 1) * CAR_COLOR_JITTER.hueDeg;
  const js = clamp01(s + (rng.next() * 2 - 1) * CAR_COLOR_JITTER.sat);
  const jv = clamp01(v + (rng.next() * 2 - 1) * CAR_COLOR_JITTER.val);
  const [nr, ng, nb] = hsvToRgb(jh, js, jv);
  return rgbToHex(nr, ng, nb);
}

// --- weighted picks -----------------------------------------------------------------------------

function weightedPick<T>(rng: Rng, items: readonly T[], weightOf: (item: T) => number): T {
  let total = 0;
  for (const it of items) total += weightOf(it);
  let r = rng.next() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function pickModelId(rng: Rng): string {
  return weightedPick(rng, CIVILIAN_CAR_MODELS, (m) => m.weight).id;
}

function pickColorEntry(rng: Rng, sports: boolean): CarColorEntry {
  return weightedPick(rng, TORONTO_CAR_PALETTE, (c) =>
    sports && c.saturated ? c.weight * SPORTS_SATURATED_BIAS : c.weight,
  );
}

// --- the sequencer ------------------------------------------------------------------------------

interface HistItem {
  readonly modelId: string;
  readonly family: CarColorFamily;
}

function collides(history: readonly HistItem[], modelId: string, family: CarColorFamily): boolean {
  const from = Math.max(0, history.length - CAR_VARIETY_ANTI_REPEAT_WINDOW);
  for (let i = from; i < history.length; i++) {
    if (history[i].modelId === modelId && history[i].family === family) return true;
  }
  return false;
}

/**
 * A stateful variety sequencer over `rng`. Each `next()` picks a weighted model, then a weighted
 * (sports-biased) colour, re-rolling ONLY the colour up to CAR_VARIETY_MAX_REROLLS times to escape
 * the anti-repeat window (keeps the model distribution intact), then applies HSV jitter. Pure and
 * deterministic in `rng` — same rng seed/sequence ⇒ identical output.
 */
export function createCarVarietySequencer(rng: Rng): CarVarietySequencer {
  const history: HistItem[] = [];
  return {
    next(): CarVariety {
      const modelId = pickModelId(rng);
      const sports = SPORTS_MODEL_IDS.includes(modelId);
      let entry = pickColorEntry(rng, sports);
      for (let a = 0; a < CAR_VARIETY_MAX_REROLLS && collides(history, modelId, entry.family); a++) {
        entry = pickColorEntry(rng, sports);
      }
      const colorHex = jitterColor(rng, entry.hex);
      history.push({ modelId, family: entry.family });
      if (history.length > CAR_VARIETY_ANTI_REPEAT_WINDOW) history.shift();
      return { modelId, colorHex, colorFamily: entry.family };
    },
  };
}

/** Convenience: a deterministic sequence of `n` picks from a numeric seed (+ optional fork salt),
 * for consumers that want a fixed roster up front (e.g. the traffic mesh's per-slot assignment). */
export function buildCarVarietySequence(seed: number, n: number, salt = 'carVariety'): CarVariety[] {
  const seq = createCarVarietySequencer(createRng(seed).fork(salt));
  return Array.from({ length: n }, () => seq.next());
}
