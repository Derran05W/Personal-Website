// Player car special behaviours (Phase 17 Task 3; TDD §5.9): the monster-truck civilian crush
// and the heavy-vehicle prop plow. Both are ARCADE momentum rules that DRIVE the existing
// systems rather than reimplementing them —
//   • the crush routes a player↔live-civilian contact into ai/traffic.ts's crush() (the normal
//     conversion → wreck path, so civHit/civWrecked each fire exactly once), then clamps the
//     truck's velocity loss so it "rides through" instead of getting hung up;
//   • the plow watches world/propDynamics.ts's own swap gate (resolveSwapTarget) and, for a
//     heavy-enough car knocking an HP-LESS prop loose, clamps the same velocity loss so a bus /
//     streetcar smashes a prop row without slowing.
// It never bypasses those systems: it converts nothing itself and swaps nothing itself.
//
// Mechanism: a single onImpact subscriber + a per-step cache of the player's PRE-contact planar
// velocity (captured in useBeforePhysicsStep, before the collision the impact reports resolves)
// so retention restores "at least X% of the speed the car had going in". The player body is
// reached the sanctioned way — resolve the player collider handle (carried on the ImpactRecord)
// through the Rapier world — so this file touches neither PlayerVehicle.tsx nor raycastVehicle.ts.
//
// The monster-truck / heavy-car DECISION lives here (reads the store's selectedCarId); ai/traffic
// stays car-agnostic and only exposes a generic crush() + a "crush is active" yield predicate this
// module supplies. The pure helpers are exported and unit-tested with no Rapier/three.

import { useEffect } from 'react';
import { useBeforePhysicsStep, useRapier, type RapierContext } from '@react-three/rapier';
import { PLAYER_CARS } from '../config/vehicles';
import { SPECIALS } from '../config/specials';
import { getGameState } from '../state/store';
import { playerVehicle } from '../vehicles/playerRef';
import { trafficRef } from '../ai/trafficTypes';
import { resolveSwapTarget } from '../world/propDynamics';
import { onImpact } from './contacts';
import type { ImpactRecord } from './types';

type RapierWorld = RapierContext['world'];

// ===========================================================================================
// Pure selection + geometry helpers (unit-tested; no Rapier/three side effects)
// ===========================================================================================

/** True while the selected car is the monster truck (its civilian crush is active). */
export function isMonsterTruckSelected(): boolean {
  return getGameState().selectedCarId === 'monsterTruck';
}

/** The selected car's authored massFactor (config/vehicles.ts PLAYER_CARS). Mirrors
 * combat/damage.ts's playerMassFactor(); kept here too so the plow gate has no reason to import
 * the damage resolver just for one field. */
export function selectedCarMassFactor(): number {
  return PLAYER_CARS[getGameState().selectedCarId].massFactor;
}

/** The player side's collider handle on an impact record (kind 'player'), or −1 if neither side
 * is the player. Every impact the contact spine dispatches has the player on one side (only the
 * player body carries onContactForce — combat/contacts.ts), but this stays defensive. */
export function playerSideHandle(record: ImpactRecord): number {
  if (record.a?.kind === 'player') return record.aHandle;
  if (record.b?.kind === 'player') return record.bHandle;
  return -1;
}

/** The live-civilian collider handle of a player↔civilian crush contact at/above `minForceN`,
 * or −1 when the impact isn't a qualifying crush (below force, or not a player↔civ pair). */
export function crushContactCivHandle(record: ImpactRecord, minForceN: number): number {
  if (!(record.forceMag >= minForceN)) return -1;
  if (record.a?.kind === 'player' && record.b?.kind === 'civilian') return record.bHandle;
  if (record.b?.kind === 'player' && record.a?.kind === 'civilian') return record.aHandle;
  return -1;
}

export interface PlanarVel {
  readonly x: number;
  readonly z: number;
}

/**
 * Momentum-retention clamp: if the post-contact planar speed dropped below `retention` × the
 * pre-contact planar speed, return the velocity to restore — the PRE-contact direction at the
 * retained speed — else null (never adds speed; a contact that barely slowed the car is left
 * alone). A pre-contact speed of ~0 (car essentially stopped) returns null: there is no momentum
 * to preserve. Vertical velocity is the caller's to keep (ride-over physics stays untouched).
 */
export function retainPlanarVelocity(
  pre: PlanarVel,
  cur: PlanarVel,
  retention: number,
): PlanarVel | null {
  const preSpeed = Math.hypot(pre.x, pre.z);
  if (!(preSpeed > 1e-3)) return null;
  const target = retention * preSpeed;
  const curSpeed = Math.hypot(cur.x, cur.z);
  if (curSpeed >= target) return null;
  const scale = target / preSpeed;
  return { x: pre.x * scale, z: pre.z * scale };
}

// ===========================================================================================
// Live system (onImpact subscriber + pre-step velocity cache)
// ===========================================================================================

// Player's PRE-contact planar velocity, refreshed every physics step before the world integrates
// (so an impact drained just after the step compares against the speed the car had going in).
// Module-scope singleton — one PlayerSpecialsSystem is ever live (rendered by TrafficMount).
const cachedPlanar = { x: 0, z: 0 };

/** Refresh the pre-contact velocity cache from the live player state (before-step hook). */
function cachePlayerPlanarVelocity(): void {
  const v = playerVehicle.current?.readState().velocity;
  cachedPlanar.x = v?.x ?? 0;
  cachedPlanar.z = v?.z ?? 0;
}

/** Restore the player's planar speed toward `retention` of its cached pre-contact speed. Reaches
 * the player body through the world (its collider handle came in on the impact record) and keeps
 * the current vertical velocity so a ride-over is unaffected. No-op if there's nothing to restore. */
function restorePlayerMomentum(world: RapierWorld, playerHandle: number, retention: number): void {
  const body = world.getCollider(playerHandle)?.parent();
  if (!body) return;
  const cur = body.linvel();
  const restored = retainPlanarVelocity(cachedPlanar, { x: cur.x, z: cur.z }, retention);
  if (restored === null) return;
  body.setLinvel({ x: restored.x, y: cur.y, z: restored.z }, true);
}

/** One impact's special-behaviour resolution (exported for direct testing — takes the world so
 * it needs no live React tree). Monster-truck crush first (a player↔civ contact is a crush, not
 * a plow); otherwise the heavy-vehicle prop plow. */
export function handleSpecialImpact(record: ImpactRecord, world: RapierWorld): void {
  const playerHandle = playerSideHandle(record);
  if (playerHandle < 0) return;

  // Monster-truck civilian crush.
  if (isMonsterTruckSelected()) {
    const civHandle = crushContactCivHandle(record, SPECIALS.monsterCrush.minForceN);
    if (civHandle >= 0 && (trafficRef.current?.crush(civHandle) ?? false)) {
      restorePlayerMomentum(world, playerHandle, SPECIALS.monsterCrush.speedRetention);
      return; // this contact was a civ crush — not also a prop plow
    }
  }

  // Heavy-vehicle prop plow (hp-less props only — parked cars are hp-bearing and meant to slow
  // you). resolveSwapTarget non-null ⇒ propDynamics.ts will swap this prop loose this same drain,
  // so retention just compensates for the collision impulse that swap leaves behind.
  if (selectedCarMassFactor() >= SPECIALS.propPlow.massFactorThreshold) {
    const target = resolveSwapTarget(record);
    if (target !== null && target.hp === undefined) {
      restorePlayerMomentum(world, playerHandle, SPECIALS.propPlow.speedRetention);
    }
  }
}

/** Subscribes the special-behaviour resolver to the contact spine + returns the unsubscribe.
 * Directly testable (like combat/damage.ts's initDamageSystem) without mounting a component. */
export function initPlayerSpecials(world: RapierWorld): () => void {
  return onImpact((record) => handleSpecialImpact(record, world));
}

/**
 * Null-rendering system (combat/damage.ts's DamageSystem style): caches the player's pre-contact
 * planar velocity each fixed step and routes crush/plow reactions off the contact spine. MUST
 * live inside <Physics> — its hooks read the Rapier context. TrafficMount renders it (so it
 * shares the civilian system's lifetime and can drive its crush() the frame contacts land); the
 * integrator may relocate it into game/index.tsx alongside DamageSystem instead — it needs no
 * props either way.
 */
export function PlayerSpecialsSystem(): null {
  const { world } = useRapier();
  useBeforePhysicsStep(cachePlayerPlanarVelocity);
  useEffect(() => initPlayerSpecials(world), [world]);
  return null;
}

/** Test hygiene: reset the pre-contact velocity cache between cases. */
export function __resetPlayerSpecialsForTest(): void {
  cachedPlanar.x = 0;
  cachedPlanar.z = 0;
}
