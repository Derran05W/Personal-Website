// SWAT-squad runtime coordinator (Phase 10 Task 1). The impure glue around the pure ai/squad.ts:
// it reads the live player pose + SWAT roster off the module refs, runs the pure slot/claim/
// release pipeline once per 10 Hz tick, and PUBLISHES the result as module-scope state so any unit
// module can consume it without touching the R3F tree.
//
// Framework-free (no three/rapier/React) — mirrors spawnDirector.ts's controller-vs-mount split:
// ai/SquadMount.tsx is the tiny R3F mount that calls updateSquad() on the physics step cadence
// and resetSquad() on teardown; this file holds the logic + published state. There is exactly one
// live run at a time (game/index.tsx mounts one world), so a plain module singleton is correct;
// resetSquad() clears it on regenerate/retry.
//
// CONSUMERS:
//   • SWAT units (Phase 10 Task 2, built in parallel) call getSquadTargetForUnit(theirSlotId) in
//     think(); a non-null target → steer in aiSteering 'flank' mode toward it, null → ram (pursue).
//     Police never call it (they're never a swat candidate, so they never hold a claim). The claims
//     only ever bind units whose kind === 'swat'.
//   • The dev visualizer (ai/SquadViz.tsx) reads getFlankTargets() + getSquadClaims().
//
// The coordinator computes + publishes the two flank targets whenever a run is live (cheap: two
// trig evals + two tile-clamps), even with zero SWAT present, so the dev viz is meaningful before
// SWAT exist and the moment they spawn there's a target waiting. Claim assignment only runs over
// swat candidates, so it's an empty map until SWAT are on the field.

import { SPAWN, SQUAD } from '../config';
import type { WorldData } from '../world/types';
import { playerVehicle } from '../vehicles/playerRef';
import { unitsRef } from './pursuitTypes';
import {
  assignFlankSlots,
  clampToDrivable,
  computeFlankSlots,
  reconcileTimers,
  releaseStuckClaims,
  slotClaimedBy,
  type ClaimMap,
  type ClaimTimers,
  type FlankSlot,
  type SquadCandidate,
} from './squad';

/** Physics steps between squad updates — the same 10 Hz cadence the pursuit units think at. */
export const SQUAD_STEPS_PER_UPDATE = Math.max(1, Math.round(60 / SPAWN.aiTickHz));
/** The wall-clock dt one squad update represents (used by releaseStuckClaims' timers). */
const SQUAD_UPDATE_DT = SQUAD_STEPS_PER_UPDATE / 60;

/** A published claim (for the visualizer): which unit owns which flank slot. */
export interface SquadClaimView {
  readonly slotId: number;
  readonly unitId: number;
}

// --- module-scope published state (single live run) ------------------------------------------
let targets: readonly FlankSlot[] = [];
let claims: ClaimMap = new Map();
let timers: ClaimTimers = new Map();

/** Player forward-heading yaw (about +Y) from a chassis quaternion — +Z-forward convention
 * (matches ai/aiSteering.ts's yawToward): forward = q·(0,0,1), yaw = atan2(fwd.x, fwd.z). */
function yawFromQuat(x: number, y: number, z: number, w: number): number {
  const fwdX = 2 * (x * z + w * y);
  const fwdZ = 1 - 2 * (x * x + y * y);
  if (fwdX === 0 && fwdZ === 0) return 0;
  return Math.atan2(fwdX, fwdZ);
}

/** Collect the SWAT units eligible to hold a flank slot: live (non-wrecked) units of kind 'swat'.
 * Police/armored/etc. are excluded, so they never receive a claim. */
function collectSwatCandidates(): SquadCandidate[] {
  const slots = unitsRef.current?.slots;
  if (!slots) return [];
  const out: SquadCandidate[] = [];
  for (const s of slots) {
    if (s.kind !== 'swat' || s.state === 'wrecked') continue;
    out.push({ unitId: s.id, x: s.x, z: s.z, yaw: yawFromQuat(s.qx, s.qy, s.qz, s.qw) });
  }
  return out;
}

/**
 * One 10 Hz squad update: recompute the two flank slots ahead of the player, clamp them onto
 * drivable ground, release stuck claims, (re)assign the slots to SWAT candidates with incumbency
 * hysteresis, and publish. No-op that clears state when no run is live. Driven by SquadMount at
 * the SQUAD_STEPS_PER_UPDATE cadence. `dt` defaults to the 10 Hz update dt.
 */
export function updateSquad(world: WorldData, dt: number = SQUAD_UPDATE_DT): void {
  const player = playerVehicle.current?.readState();
  if (!player) {
    resetSquad();
    return;
  }

  const pos = player.rawPose.position;
  const rot = player.rawPose.rotation;
  const playerPos = { x: pos.x, z: pos.z };
  const playerVel = { x: player.velocity.x, z: player.velocity.z };
  const playerYaw = yawFromQuat(rot.x, rot.y, rot.z, rot.w);

  // Slots ahead of the player, snapped out of any building/fenced tile they'd land in.
  const raw = computeFlankSlots(playerPos, playerVel, playerYaw, SQUAD);
  const nextTargets: FlankSlot[] = raw.map((s) => {
    const c = clampToDrivable({ x: s.x, z: s.z }, world, SQUAD);
    return { id: s.id, x: c.x, z: c.z };
  });

  const candidates = collectSwatCandidates();

  // Release stuck/orphaned claims first, then (re)assign the free/held slots.
  const released = releaseStuckClaims(claims, nextTargets, candidates, timers, dt, SQUAD);
  const nextClaims = assignFlankSlots(nextTargets, candidates, released.claims, SQUAD);
  const nextTimers = reconcileTimers(nextClaims, released.claims, released.timers);

  targets = nextTargets;
  claims = nextClaims;
  timers = nextTimers;
}

/** Clear all published squad state (run end / regenerate / retry / mount teardown). */
export function resetSquad(): void {
  targets = [];
  claims = new Map();
  timers = new Map();
}

// --- read API (consumers: SWAT units + the dev visualizer) -----------------------------------

/** The flank-slot target a given unit currently claims, or null if it holds no slot. SWAT units
 * call this with their own slot id: non-null → steer in 'flank' mode toward it, null → ram. */
export function getSquadTargetForUnit(unitId: number): { x: number; z: number } | null {
  const slotId = slotClaimedBy(claims, unitId);
  if (slotId === null) return null;
  const slot = targets.find((t) => t.id === slotId);
  return slot ? { x: slot.x, z: slot.z } : null;
}

/** The current flank-slot targets (0..2). Dev visualizer marker positions. */
export function getFlankTargets(): readonly FlankSlot[] {
  return targets;
}

/** The current slot→unit claims. Dev visualizer claim lines. */
export function getSquadClaims(): readonly SquadClaimView[] {
  const out: SquadClaimView[] = [];
  for (const [slotId, unitId] of claims) out.push({ slotId, unitId });
  return out;
}
