// Pooled dynamic-light system (Phase 13 Task 3; TDD §5.8/§8.2). Real dynamic PointLights
// are precious (perf budget), so the whole city is lit by *emissive* attributes on the
// instanced streetlights/windows (Task 1) — but those don't cast any real light onto the
// road. This module trails a small pool of real PointLights (POWER_GRID.lightPoolSize = 6)
// around the player and snaps each one to the nearest *lit* streetlight head, so the blue-
// hour street reads as genuinely lit right around the car. Blacked-out districts never
// receive a pool light — that contrast is the whole point of the blackout feature.
//
// This file is the PURE, framework-free core (selection + fade state machine); the mount
// (LightPool.tsx) owns the <pointLight> elements and the per-frame drive. Everything here
// is deterministic and allocation-light enough for the ~5 Hz reassignment cadence — the
// per-frame hot path (stepFade + writing light transforms) is what the mount keeps
// allocation-free, matching fx/Explosions.tsx's pooled-PointLight discipline.
//
// DARK-DISTRICT READ SEAM: the authoritative lit/dark state is owned by Task 2's
// powergrid/grid.ts (parallel work), which is expected to export
// `isDistrictDark(districtId): boolean`. To stay build-safe while that module lands — and
// to keep this core testable in isolation — the pool reads dark state through an INJECTABLE
// predicate (setDistrictDarkSource / getDarkPredicate) that defaults to "all districts lit".
// Integration is a one-liner: `setDistrictDarkSource(isDistrictDark)` once grid.ts is
// present. If grid's API is absent at finish, the all-lit fallback is what ships (no light
// is ever wrongly *withheld*; the only consequence is that nothing is excluded until the
// grid is wired) — see the handoff note.

import { derivePlacements } from '../world/propPlacements';
import type { WorldData } from '../world/types';

/** A streetlight the pool can assign a real light to: world position + which district it
 * belongs to (for dark exclusion). Derived once per world from the deterministic prop
 * placements (streetlights only). */
export interface StreetlightEmitter {
  readonly x: number;
  readonly z: number;
  readonly districtId: number;
}

// derivePlacements is deterministic but not free (~3.4k placements). Cache the filtered
// streetlight list per WorldData reference (a new seed / regenerate yields a new object, so
// this never goes stale — matches worldRef.ts's "reassigned wholesale, never mutated"
// contract).
const emitterCache = new WeakMap<WorldData, StreetlightEmitter[]>();

/** Every streetlight in the city as a pool emitter (cached per world). */
export function streetlightEmitters(world: WorldData): StreetlightEmitter[] {
  const cached = emitterCache.get(world);
  if (cached) return cached;
  const out: StreetlightEmitter[] = [];
  for (const p of derivePlacements(world)) {
    if (p.archetype === 'streetlight') out.push({ x: p.x, z: p.z, districtId: p.districtId });
  }
  emitterCache.set(world, out);
  return out;
}

// --- Toronto adapter (Phase 30 T2 debt-2) ---------------------------------------------------
// Toronto has no `WorldData` (that shape is the legacy tile-world generator's own) and no
// standalone 'streetlight' archetype — the map's real street lighting comes from its
// traffic-light masts (world/toronto/furniture.ts's LampMast), which already carry a world
// position + districtId per mast. This adapter reshapes those into the SAME
// `StreetlightEmitter[]` LightPool (the mount below) already knows how to trail/assign —
// nothing downstream of `emitters()` needs to know its source was masts, not lampposts.

/** The minimal shape torontoStreetlightEmitters needs from a lamp source — LampMast
 * (world/toronto/furniture.ts) satisfies this structurally, but this module deliberately takes
 * no dependency on world/toronto/** (powergrid/ stays map-agnostic); the caller (TorontoScene)
 * resolves `districtId` to a plain numeric index (torontoDistrictIndex) before calling this. */
export interface TorontoLampSource {
  readonly position: readonly [number, number, number];
  readonly districtId: number;
}

/** Toronto's WorldData-shaped streetlight-emitter source (Phase 30 T2 debt-2): every
 * traffic-light mast becomes one pool emitter at its world (x, z), keyed to the SAME 15-district
 * grid powergrid/grid.ts already tracks for Toronto (initPowerGrid(15) — Phase 29). Pure
 * reshape, no caching needed (the caller memoizes on its own furniture layout, mirroring
 * world/toronto/frontage.ts's "TorontoScene owns the useMemo" convention). */
export function torontoStreetlightEmitters(masts: readonly TorontoLampSource[]): StreetlightEmitter[] {
  return masts.map((m) => ({ x: m.position[0], z: m.position[2], districtId: m.districtId }));
}

// --- Dark-district read seam ----------------------------------------------------------------

export type DarkPredicate = (districtId: number) => boolean;

const ALL_LIT: DarkPredicate = () => false;
let darkSource: DarkPredicate = ALL_LIT;

/** Wire the authoritative dark-district source (grid.ts's `isDistrictDark`). Passing a
 * non-function (null/undefined) resets to the all-lit fallback. */
export function setDistrictDarkSource(fn: DarkPredicate | null | undefined): void {
  darkSource = typeof fn === 'function' ? fn : ALL_LIT;
}

/** The currently-wired dark predicate (all-lit until setDistrictDarkSource wires grid.ts). */
export function getDarkPredicate(): DarkPredicate {
  return darkSource;
}

// --- Fade state machine ---------------------------------------------------------------------
//
// Each pool light is either parked (steady, invisible, current = -1) or showing streetlight
// `current` at some intensity. A reassignment doesn't snap: the light fades OUT at its old
// streetlight over fadeSec, then its position jumps and it fades IN at the new one over
// fadeSec. `desired` is the target it is committed to (== current except mid-fade-out); a
// light mid-fade (phase !== 'steady') is never reassigned again until it settles, so
// handoffs always complete cleanly — the ONE exception being a district going dark, which
// overrides the lock to release the light (see assign()).

export type FadePhase = 'steady' | 'out' | 'in';

export interface LightState {
  /** Emitter index whose position the light is at (-1 = parked). */
  current: number;
  /** Emitter index the light is committed to (-1 = park). Equals `current` except while
   * fading out toward a new target. */
  desired: number;
  phase: FadePhase;
  /** Seconds elapsed within the current fade leg. */
  t: number;
  /** 0..1 scalar (the mount multiplies by LIGHT_POOL.intensity). */
  intensity: number;
}

export function createLightState(): LightState {
  return { current: -1, desired: -1, phase: 'steady', t: 0, intensity: 0 };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Begin fading a light OUT toward `target` (which then fades in), preserving current
 * intensity so an interrupted fade-in continues smoothly downward instead of popping to
 * full. `target === -1` means "fade out to parked". */
function beginFadeOut(s: LightState, target: number, fadeSec: number): void {
  s.desired = target;
  s.phase = 'out';
  // Seed t so that 1 - t/fadeSec == current intensity: a steady light (intensity 1) starts
  // the fade at t=0; a light caught mid-fade-in (intensity 0.4) continues 0.4 -> 0.
  s.t = fadeSec > 0 ? (1 - s.intensity) * fadeSec : 0;
}

/**
 * Retarget a light to streetlight `target` (or -1 to park). No-op if already committed
 * there. A parked light skips the (invisible) fade-out and fades straight in; a light
 * currently showing something fades out its old position first. Callers must respect the
 * mid-fade lock themselves (assign() only calls this on steady slots, plus the dark-release
 * exception).
 */
export function beginAssign(s: LightState, target: number, fadeSec: number): void {
  if (target === s.desired) return;
  if (s.current === -1) {
    // Parked: nothing to fade out from.
    if (target === -1) {
      s.desired = -1;
      s.phase = 'steady';
      s.intensity = 0;
      s.t = 0;
      return;
    }
    s.current = target;
    s.desired = target;
    s.phase = 'in';
    s.t = 0;
    s.intensity = 0;
    return;
  }
  beginFadeOut(s, target, fadeSec);
}

/** Advance one light's fade by `dt` seconds, updating position ownership (`current`),
 * `phase`, and `intensity`. Pure state transition — the mount reads `current`/`intensity`
 * out afterward to drive the real <pointLight>. */
export function stepFade(s: LightState, dt: number, fadeSec: number): void {
  if (s.phase === 'steady') {
    s.intensity = s.current === -1 ? 0 : 1;
    return;
  }
  const dur = fadeSec > 0 ? fadeSec : 1e-6;
  s.t += dt;
  const frac = clamp01(s.t / dur);
  if (s.phase === 'out') {
    s.intensity = 1 - frac;
    if (s.t >= dur) {
      // Fade-out done: switch to the new target (or settle parked).
      s.current = s.desired;
      s.t = 0;
      if (s.desired === -1) {
        s.phase = 'steady';
        s.intensity = 0;
      } else {
        s.phase = 'in';
        s.intensity = 0;
      }
    }
  } else {
    // 'in'
    s.intensity = frac;
    if (s.t >= dur) {
      s.phase = 'steady';
      s.intensity = 1;
      s.t = 0;
    }
  }
}

// --- Nearest-lit selection (with hysteresis) ------------------------------------------------

/**
 * The set of streetlight indices the pool WANTS lit right now: the `count` nearest LIT
 * streetlights to (px,pz), with hysteresis so it doesn't thrash between two near-equal
 * candidates. An incumbent (a currently-committed target) is retained even if it's no longer
 * strictly in the top-`count`, as long as its distance stays within `hysteresisPct` of the
 * Nth-nearest cutoff; the remaining slots are filled by the nearest lit streetlights. Dark
 * districts are excluded entirely, so a returned index is never in a dark district.
 *
 * Pure and allocation-y (Maps/Sets) — called at the reassignment cadence (~5 Hz), never per
 * frame.
 */
export function computeDesiredSet(
  emitters: readonly StreetlightEmitter[],
  px: number,
  pz: number,
  count: number,
  isDark: DarkPredicate,
  incumbents: readonly number[],
  hysteresisPct: number,
): number[] {
  const lit: { idx: number; d2: number }[] = [];
  for (let i = 0; i < emitters.length; i += 1) {
    const e = emitters[i];
    if (isDark(e.districtId)) continue;
    const dx = e.x - px;
    const dz = e.z - pz;
    lit.push({ idx: i, d2: dx * dx + dz * dz });
  }
  lit.sort((a, b) => a.d2 - b.d2);

  if (lit.length <= count) return lit.map((l) => l.idx);

  const cutoff2 = lit[count - 1].d2;
  // Hysteresis band, in squared-distance space: incumbent kept if d2 <= cutoff2 * (1+p)^2
  // (equivalent to distance <= cutoff * (1+p) without a sqrt).
  const k = 1 + hysteresisPct;
  const band = cutoff2 * k * k;

  const d2ByIdx = new Map<number, number>();
  for (const l of lit) d2ByIdx.set(l.idx, l.d2);

  const result: number[] = [];
  const used = new Set<number>();

  // 1. Retain incumbents that are still lit and within the band, nearest first.
  const retained = incumbents
    .filter((i) => {
      const d = d2ByIdx.get(i);
      return d !== undefined && d <= band;
    })
    .sort((a, b) => (d2ByIdx.get(a) as number) - (d2ByIdx.get(b) as number));
  for (const i of retained) {
    if (result.length >= count) break;
    if (used.has(i)) continue;
    result.push(i);
    used.add(i);
  }

  // 2. Fill the rest with the nearest lit streetlights not already chosen.
  for (const l of lit) {
    if (result.length >= count) break;
    if (used.has(l.idx)) continue;
    result.push(l.idx);
    used.add(l.idx);
  }

  return result;
}

/**
 * Reassign the pool (mutates `states`) toward the nearest-lit set around (px,pz). Runs at
 * the ~5 Hz reassignment cadence, not per frame. Guarantees:
 *  - No light is ever committed to a dark district. A committed target that just went dark
 *    is released (fade out to parked) even mid-fade — the district going dark overrides the
 *    mid-fade lock. (A light already there fades out; it never *enters* a dark district,
 *    because dark streetlights are excluded from the desired set below.)
 *  - Lights mid-fade toward a still-valid target are left untouched (the lock), so handoffs
 *    complete without re-triggering.
 *  - Stable: if the nearest-lit set is unchanged, no light changes (hysteresis + the
 *    "keep useful slots" check below).
 */
export function assign(
  states: LightState[],
  emitters: readonly StreetlightEmitter[],
  px: number,
  pz: number,
  isDark: DarkPredicate,
  count: number,
  hysteresisPct: number,
  fadeSec: number,
): void {
  // 1. Dark-release: any slot committed to a now-dark district must leave. Allowed even
  //    mid-fade (dark overrides the lock); beginAssign(-1) preserves intensity continuity.
  for (const s of states) {
    if (s.desired !== -1 && isDark(emitters[s.desired].districtId)) {
      beginAssign(s, -1, fadeSec);
    }
  }

  // 2. Desired set = nearest lit with hysteresis vs the current committed (lit) targets.
  const incumbents: number[] = [];
  for (const s of states) if (s.desired !== -1) incumbents.push(s.desired);
  const desiredSet = computeDesiredSet(emitters, px, pz, count, isDark, incumbents, hysteresisPct);
  const wanted = new Set(desiredSet);

  // 3. Which wanted targets are already covered by some slot's committed target?
  const covered = new Set<number>();
  for (const s of states) {
    if (s.desired !== -1 && wanted.has(s.desired)) covered.add(s.desired);
  }
  const uncovered = desiredSet.filter((t) => !covered.has(t)); // nearest-first-ish; fine at 5 Hz

  // 4. Distribute uncovered targets to FREE steady slots (mid-fade slots are locked). A
  //    steady slot doing useful work (its committed target is still wanted) is kept as-is.
  let u = 0;
  for (const s of states) {
    if (s.phase !== 'steady') continue;
    const stale = s.desired === -1 || !wanted.has(s.desired);
    if (!stale) continue;
    if (u < uncovered.length) {
      beginAssign(s, uncovered[u], fadeSec);
      u += 1;
    } else if (s.desired !== -1) {
      // Its assignment is stale and nothing needs covering — park it.
      beginAssign(s, -1, fadeSec);
    }
  }
}
