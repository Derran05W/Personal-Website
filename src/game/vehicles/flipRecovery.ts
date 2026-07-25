// Automatic player flip-recovery (Part 8 feel-tuning workstream C). A car resting
// upside-down or on its side for PLAYER_RECOVERY.sustainSec CONTINUOUS seconds gets
// auto-righted — lifted PLAYER_RECOVERY.liftY and reset to a yaw-only rotation, the exact
// move the dev "flip recover" button (core/devPanel.tsx) already does by hand.
//
// The pure timer core below mirrors ai/traffic.ts's tickWreck shape (accumulate a "bad
// state" timer while a condition holds, reset to 0 the instant it doesn't, fire once the
// timer crosses a threshold) with one deliberate difference: tickWreck is a one-shot latch
// (a wrecked civilian never un-wrecks), while this machine RE-ARMS on fire — a recovered
// car can flip again later and the timer starts fresh. No wall-clock, no Date.now: the
// caller (vehicles/PlayerVehicle.tsx's useAfterPhysicsStep) drives it with the fixed
// physics dt, one tick per step.

import { Euler, Quaternion, Vector3 } from 'three';
import type { VehiclePose } from './IVehicleModel';
import { PLAYER_RECOVERY } from '../config/vehicles';

export interface FlipRecoveryState {
  /** Seconds the chassis has been continuously below upDotThreshold. */
  readonly flipSec: number;
}

/** Fresh, never-flipped starting state — module consumers create one ref of this shape
 * per player-vehicle mount (see vehicles/PlayerVehicle.tsx). */
export const INITIAL_FLIP_RECOVERY_STATE: FlipRecoveryState = { flipSec: 0 };

export interface FlipRecoveryResult {
  readonly next: FlipRecoveryState;
  /** True on exactly the step the sustained-flip timer crosses sustainSec. */
  readonly fire: boolean;
}

/**
 * Advance the flip-recovery timer by one physics step.
 *
 * `upDot` is the chassis up-dot (see `chassisUpDot` below): 1 = perfectly upright, -1 =
 * perfectly upside-down. While `upDot < PLAYER_RECOVERY.upDotThreshold` the timer
 * accumulates `dt`; the instant a sample is AT OR ABOVE the threshold (the boundary counts
 * as upright — matches ai/traffic.ts's `upDot < cfg.wreckUpDot` convention) it resets to 0.
 * Once the accumulated time reaches PLAYER_RECOVERY.sustainSec, this returns `fire: true`
 * exactly once and re-arms (`next.flipSec` resets to 0) so a later flip can fire again.
 */
export function tickFlipRecovery(prev: FlipRecoveryState, upDot: number, dt: number): FlipRecoveryResult {
  const flipSec = upDot < PLAYER_RECOVERY.upDotThreshold ? prev.flipSec + dt : 0;
  if (flipSec >= PLAYER_RECOVERY.sustainSec) {
    return { next: { flipSec: 0 }, fire: true };
  }
  return { next: { flipSec }, fire: false };
}

/**
 * Raw chassis up-dot: the world-up (Y) component of the chassis's local up axis after
 * `rotation` is applied — 1 when upright, -1 when upside-down, 0 on its side. Computed
 * independently here (rather than reusing vehicles/raycastVehicle.ts's `upright` field,
 * which only exposes a fixed `> 0.5` boolean) so the flip-recovery timer can threshold on
 * its own PLAYER_RECOVERY.upDotThreshold.
 */
const UP = new Vector3(0, 1, 0);
export function chassisUpDot(rotation: VehiclePose['rotation']): number {
  const q = new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
  return UP.clone().applyQuaternion(q).y;
}

/**
 * Strips pitch/roll from a pose's rotation, keeping only yaw (rotation about world Y).
 * Moved here from core/devPanel.tsx (Part 8 flip-recovery workstream) so the debug "flip
 * recover" button and the automatic in-game recovery below share one implementation.
 */
export function yawOnlyRotation(rotation: VehiclePose['rotation']): VehiclePose['rotation'] {
  const euler = new Euler().setFromQuaternion(
    new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    'YXZ',
  );
  const yaw = new Quaternion().setFromEuler(new Euler(0, euler.y, 0, 'YXZ'));
  return { x: yaw.x, y: yaw.y, z: yaw.z, w: yaw.w };
}
