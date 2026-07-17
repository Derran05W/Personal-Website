// Helicopter flight model + per-tier lifecycle (Phase 14 Task 1). Pure atmosphere — no
// colliders, no registry entries, zero physics cost (TDD §5.7 v1). This module owns the
// MATH (testable pure functions) and the LIFECYCLE state machine (HeliController); the R3F
// mount (ai/HeliMount.tsx) drives it once per frame from a priority-0 useFrame and feeds it
// the player's interpolated pose. The controller writes the sealed HeliSlot seam
// (ai/heliTypes.ts) that HeliMesh (Task 2) and the searchlight (Task 3) read.
//
// Flight model, per active heli:
//  • Orbit the player at HELI.orbitRadius / HELI.altitude, phase advancing at
//    HELI.orbitAngularSpeed (CCW). The lead heli (slot 0) and the ★5 second heli (slot 1)
//    share one global orbit phase offset by HELI.dualPhaseOffset (π) — always antipodal, so
//    the pair can never share a bearing.
//  • Nose points along the orbit tangent (tangentYaw); banked lean into the turn is
//    proportional to the signed orbit angular velocity, clamped (bankAngle).
//  • Gentle altitude bob (seeded-phase sine) so the two ★5 helis never bob in lockstep.
//  • presence ∈ [0,1] fades a heli in/out. It ALSO drives the orbit radius: at presence 0 the
//    heli sits at HELI.edgeRadiusM (toward the map edge), at presence 1 it sits at
//    orbitRadius. So a departing heli spirals OUT to the edge as it fades, and an arriving one
//    spirals IN from the edge as it appears — no teleports.
//
// Lifecycle (per tier, driven by tierChanged / a debug override): ★0–1 none, ★2 police,
// ★3 SWAT, ★4 military, ★5 TWO military (perTier/liveryByTier). A tier change that swaps the
// livery makes the current heli fly OUT (presence→0), THEN the new livery flies IN
// (presence 0→1) — strictly sequential, so the swap is smooth.

import { HELI } from '../config/spawn';
import type { HeliApi, HeliLivery, HeliSlot } from './heliTypes';

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const TWO_PI = Math.PI * 2;
// Orbit direction: +1 = counter-clockwise (viewed from above). Runtime uses one direction;
// the pure math below is parameterised by it so tests can assert the tangent/bank signs flip.
const CCW = 1;
// Deterministic per-slot bob phase seed (rad) — an irrational-ish constant times the slot
// index so the two ★5 helis bob out of phase without any rng plumbing.
const BOB_PHASE_SEED = 2.399963;
// Largest per-frame dt the controller integrates, so a long tab-away stall can't make a heli
// jump a huge orbit arc / snap its presence on the resume frame.
const MAX_DT = 0.1;

// --- pure flight math (exported for tests) -------------------------------------------------

/** Livery flown at wanted `tier`, or null if that tier has no helicopter (★0/★1). */
export function liveryForTier(tier: number): HeliLivery | null {
  return HELI.liveryByTier[tier] ?? null;
}

/** How many helicopters orbit at wanted `tier` (0, 1, or 2 — ★5 is the only dual). */
export function countForTier(tier: number): number {
  return HELI.perTier[tier] ?? 0;
}

/** Local orbit offset from the player (XZ plane) at orbit phase `theta`, radius `r`. */
export function orbitOffset(r: number, theta: number): { x: number; z: number } {
  return { x: r * Math.cos(theta), z: r * Math.sin(theta) };
}

/**
 * Heading yaw (rad) so the nose points along the orbit tangent. `dir` = +1 CCW / −1 CW.
 * Yaw follows the project convention `facing = (sin yaw, cos yaw)` (matches the Y-axis yaw
 * every other vehicle mesh applies), so yaw = atan2(tangentX, tangentZ).
 */
export function tangentYaw(theta: number, dir: number): number {
  // Tangent to (cos θ, sin θ) is (−sin θ, cos θ); travel direction folds in `dir`.
  const tx = -dir * Math.sin(theta);
  const tz = dir * Math.cos(theta);
  return Math.atan2(tx, tz);
}

/**
 * Banked lean into the turn (rad): proportional to the signed orbit angular velocity,
 * clamped to ±`maxRad`. Positive = bank into a CCW (left) turn.
 */
export function bankAngle(angularVel: number, dir: number, gain: number, maxRad: number): number {
  const raw = gain * dir * angularVel;
  return Math.max(-maxRad, Math.min(maxRad, raw));
}

/** Gentle altitude-bob offset (m): a seeded-phase sine. */
export function altitudeBob(t: number, phase: number, amp: number, freq: number): number {
  return amp * Math.sin(freq * t + phase);
}

/** Smoothstep on [0,1] (clamped) — eases the presence→radius map at both endpoints. */
export function smoothstep01(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Orbit radius for a given `presence`: `edgeRadius` at presence 0 (toward the map edge),
 * `orbitRadius` at presence 1, smoothstepped between. This is what turns a presence fade into
 * a fly-out / fly-in.
 */
export function radiusForPresence(presence: number, orbitRadius: number, edgeRadius: number): number {
  return edgeRadius + (orbitRadius - edgeRadius) * smoothstep01(presence);
}

/**
 * Ease `presence` toward `target` (0 or 1) by `rate`/s over `dt`, clamped to [0,1] with no
 * overshoot past the target.
 */
export function stepPresence(presence: number, target: number, rate: number, dt: number): number {
  const step = rate * dt;
  if (presence < target) return Math.min(target, presence + step);
  if (presence > target) return Math.max(target, presence - step);
  return presence;
}

// --- lifecycle controller ------------------------------------------------------------------

/** Per-slot flight/lifecycle phase. */
export type HeliSlotPhase = 'absent' | 'arriving' | 'orbiting' | 'departing';

/** Debug seam (ai/HeliMount.tsx publishes it): drive the lifecycle by tier directly, without
 * touching heat, and read the live slots. Consumed by core/debugBridge.ts + devPanel. */
export interface HeliDebugApi {
  /** Force the lifecycle to a wanted tier (0..5), or null to release back to the live tier. */
  setForcedTier(tier: number | null): void;
  getForcedTier(): number | null;
  /** The live (real, event-driven) tier the controller last saw. */
  getLiveTier(): number;
  /** The tier actually driving the lifecycle right now (forced ?? live). */
  getEffectiveTier(): number;
  /** The sealed HeliSlot seam (same references HeliMesh reads). */
  slots(): readonly HeliSlot[];
}

/**
 * Debug handle to the live controller, published by ai/HeliMount.tsx (null before it mounts).
 * Separate from ai/heliTypes.ts's sealed `heliRef` (which exposes only the read-only slots the
 * mesh/searchlight consume) — the force-tier + richer readouts are dev tooling, so they live
 * here rather than widening the seam. Consumers (core/debugBridge.ts, devPanel) null-check it.
 */
export const heliDebugRef: { current: HeliDebugApi | null } = { current: null };

interface InternalSlot {
  readonly index: number;
  /** Constant bearing offset from the global orbit phase (0 for the lead, π for the ★5 pair). */
  readonly phaseOffset: number;
  /** Seeded bob phase (rad). */
  readonly bobPhase: number;
  phase: HeliSlotPhase;
  /** Livery currently FLYING in this slot (null only while absent). During a departure it
   * stays the OUTGOING livery until presence hits 0 — that's what makes the swap out-then-in. */
  livery: HeliLivery | null;
  presence: number;
  /** The mutated-in-place seam object exposed via api.slots (stable reference). */
  readonly out: HeliSlot;
}

function makeSlot(index: number, phaseOffset: number): InternalSlot {
  return {
    index,
    phaseOffset,
    bobPhase: index * BOB_PHASE_SEED,
    phase: 'absent',
    livery: null,
    presence: 0,
    out: { livery: null, x: 0, y: HELI.altitude, z: 0, yaw: 0, bank: 0, rotor: 0, presence: 0 },
  };
}

/**
 * Owns the two heli slots and the per-tier lifecycle. Event-free and R3F-free so it's unit
 * testable: the mount feeds it `setTier` (from tierChanged) and `update(dt, center)` (from a
 * priority-0 useFrame with the player's interpolated position).
 */
export class HeliController {
  private liveTier = 0;
  private forcedTier: number | null = null;
  /** Accumulated time (s) for the bob sine. */
  private t = 0;
  /** Global orbit phase (rad); each slot's bearing is this + its phaseOffset. */
  private orbitPhase = 0;
  private center: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly internal: readonly InternalSlot[];

  readonly api: HeliApi;
  readonly debug: HeliDebugApi;

  constructor() {
    this.internal = [makeSlot(0, 0), makeSlot(1, HELI.dualPhaseOffset)];
    const slots = this.internal.map((s) => s.out);
    this.api = { slots };
    this.debug = {
      setForcedTier: (tier) => {
        this.forcedTier = tier;
      },
      getForcedTier: () => this.forcedTier,
      getLiveTier: () => this.liveTier,
      getEffectiveTier: () => this.effectiveTier(),
      slots: () => this.api.slots,
    };
  }

  /** Real tier update — the mount wires this to the tierChanged event (and seeds it once). */
  setTier(tier: number): void {
    this.liveTier = tier;
  }

  private effectiveTier(): number {
    return this.forcedTier ?? this.liveTier;
  }

  /**
   * Advance one frame. `dt` is the render delta (clamped to MAX_DT); `center` is the player's
   * interpolated world position (orbit center). Rewrites every slot's HeliSlot seam.
   */
  update(dt: number, center: Vec3): void {
    const step = Math.min(Math.max(dt, 0), MAX_DT);
    this.t += step;
    this.orbitPhase = (this.orbitPhase + HELI.orbitAngularSpeed * step) % TWO_PI;
    this.center = center;

    const tier = this.effectiveTier();
    const desiredLivery = liveryForTier(tier);
    const desiredCount = countForTier(tier);

    for (const slot of this.internal) {
      // Slot 0 always takes the tier livery; slot 1 only when the tier fields two helis (★5).
      const desired = slot.index < desiredCount ? desiredLivery : null;
      this.advancePhase(slot, desired, step);
      this.writeOut(slot, step);
    }
  }

  /** One frame of the per-slot lifecycle state machine (fly-out-then-in on any livery swap). */
  private advancePhase(slot: InternalSlot, desired: HeliLivery | null, dt: number): void {
    switch (slot.phase) {
      case 'absent':
        // Nothing flying; adopt a newly-desired livery by arriving from the edge.
        if (desired !== null) {
          slot.phase = 'arriving';
          slot.livery = desired;
        }
        break;
      case 'arriving':
        // A change to a DIFFERENT livery (or to none) means abort the arrival and fly back out
        // first — the outgoing livery keeps flying until presence hits 0.
        if (desired !== slot.livery) {
          slot.phase = 'departing';
          break;
        }
        slot.presence = stepPresence(slot.presence, 1, HELI.fadeRate, dt);
        if (slot.presence >= 1) slot.phase = 'orbiting';
        break;
      case 'orbiting':
        if (desired !== slot.livery) {
          slot.phase = 'departing';
          break;
        }
        slot.presence = 1;
        break;
      case 'departing':
        // If the tier bounced back to exactly the outgoing livery mid-exit, cancel the exit
        // and fly back in (heat is monotonic in real play, but the debug force-tier can bounce).
        if (desired !== null && desired === slot.livery) {
          slot.phase = 'arriving';
          break;
        }
        slot.presence = stepPresence(slot.presence, 0, HELI.fadeRate, dt);
        if (slot.presence <= 0) {
          slot.presence = 0;
          if (desired !== null) {
            // Old heli has cleared out at the edge — bring the new livery IN from there.
            slot.phase = 'arriving';
            slot.livery = desired;
          } else {
            slot.phase = 'absent';
            slot.livery = null;
          }
        }
        break;
    }
  }

  /** Rewrite the slot's exposed HeliSlot seam from its current flight state. */
  private writeOut(slot: InternalSlot, dt: number): void {
    const theta = this.orbitPhase + slot.phaseOffset;
    const r = radiusForPresence(slot.presence, HELI.orbitRadius, HELI.edgeRadiusM);
    const off = orbitOffset(r, theta);
    const out = slot.out;
    out.livery = slot.livery;
    out.x = this.center.x + off.x;
    out.y = HELI.altitude + altitudeBob(this.t, slot.bobPhase, HELI.bobAmpM, HELI.bobFreq);
    out.z = this.center.z + off.z;
    out.yaw = tangentYaw(theta, CCW);
    out.bank = bankAngle(HELI.orbitAngularSpeed, CCW, HELI.bankGain, HELI.bankMaxRad);
    out.presence = slot.presence;
    // Rotor only spins while a heli is present (absent slots hold their last angle).
    if (slot.livery !== null) out.rotor = (out.rotor + HELI.rotorSpeed * dt) % TWO_PI;
  }
}
