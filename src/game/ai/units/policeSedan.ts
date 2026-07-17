// ★1 police sedan (Phase 9 Task 2; TDD §5.6 "Police sedan": 40 HP, 1.0× mass, 105% top speed,
// pure pursuit + ram, "cheap, numerous, bouncy"). Owns WHAT a police unit IS: its pursuit
// chassis (ai/pursuitVehicle.ts — the reused raycast controller), its cached steering decision
// (ai/aiSteering.ts), its registry identity, its pose slot, and its wreck lifecycle. The
// spawn director (ai/spawnDirector.ts) owns WHEN one exists — it looks up this module's factory
// in its kind→factory registry and drives each unit's staggered 10 Hz think(). The visual mesh
// (ai/units/PoliceMesh.tsx) renders the slots and drives the per-step passes below.
//
// --- per-step tick list (the coordination mechanism) --------------------------------------
// The seam (ai/pursuitTypes.ts) puts a unit's cheap cached-force application in "its own
// physics-step hook, not [think]". A React component can't call useBeforePhysicsStep per unit,
// so live units self-register into this MODULE-SCOPE tick list on creation; ONE shared
// useBeforePhysicsStep + useAfterPhysicsStep (in PoliceMesh) iterate it — applyStep before the
// step (apply cached inputs), syncSlot after (copy the raw body pose into the slot + run wreck
// detection). The director does NOT drive forces; it only schedules think() and spawns/despawns.
// (Part 4 units share this list; when a second unit mesh lands, move the two hooks to one shared
// pursuit mount so the list is still driven exactly once — documented for that phase.)
//
// --- registry / wreck / damage contract ---------------------------------------------------
// Each unit registers its collider as kind 'pursuit' with hp (world/registry.ts). combat/
// damage.ts drains that hp on player rams (the PLAYER body's onContactForce resolves BOTH sides,
// so a ram hurts the unit too) but, with no archetype on the entry, emits NOTHING on its death —
// so THIS module is the sole emitter of unitWrecked (from hp≤0 OR a sustained flip), never
// double-firing against the resolver. Mirrors ai/traffic.ts's civilian/civWrecked ownership.

import type { RapierContext } from '@react-three/rapier';
import { AI_STEERING, ENEMY_UNITS, SPAWN } from '../../config';
import { gameEvents } from '../../state/events';
import { getEntity, registerEntity, unregisterEntity } from '../../world/registry';
import { playerVehicle } from '../../vehicles/playerRef';
import type { VehicleInputs } from '../../vehicles/IVehicleModel';
import { PursuitVehicle } from '../pursuitVehicle';
import { initialStuckState, pursueSteer, type StuckState } from '../aiSteering';
import { approachTargetFor } from '../roadNav';
import type { UnitFactory, UnitHandle, UnitSlot } from '../pursuitTypes';
import { nextPursuitSlotId } from './slotIds';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

// Matches <Physics timeStep={1/60}> — the constant per-step dt (both step hooks fire once per
// fixed step) and the 10 Hz decision dt the director staggers to.
const PHYSICS_STEP_SEC = 1 / 60;
const AI_TICK_DT = 1 / SPAWN.aiTickHz;

const POLICE = ENEMY_UNITS.police;
const POLICE_TOP_SPEED_SCALE = POLICE.topSpeedPct / 100;

const IDLE_INPUTS: VehicleInputs = { steer: 0, throttle: 0, brake: 0, handbrake: false };

// Stable, monotonic slot ids for debug overlay / traceability (the director slots a unit's own
// slot by pool index; the id here is purely identity, never an array index). Phase 10: minted
// from slotIds.ts's SHARED counter (not a private per-module one) — see that file's header for
// why a per-kind counter collides once armored/swat coexist with police in the same roster.

// ===========================================================================================
// Per-step tick list (module scope — survives across the mesh's hook lifetime)
// ===========================================================================================

interface PursuitStepUnit {
  applyStep(dt: number): void;
  syncSlot(): void;
}

const liveUnits = new Set<PursuitStepUnit>();

/** useBeforePhysicsStep driver (PoliceMesh): apply every live unit's cached inputs. */
export function stepPursuitBefore(dt: number): void {
  for (const u of liveUnits) u.applyStep(dt);
}

/** useAfterPhysicsStep driver (PoliceMesh): copy each live unit's body pose into its slot and
 * run wreck detection. */
export function stepPursuitAfter(): void {
  for (const u of liveUnits) u.syncSlot();
}

/** Test/debug: live pursuit-body count in the tick list. */
export function livePursuitCount(): number {
  return liveUnits.size;
}

// ===========================================================================================
// Police unit
// ===========================================================================================

class PoliceUnit implements UnitHandle, PursuitStepUnit {
  readonly slot: UnitSlot;

  private readonly vehicle: PursuitVehicle;
  private readonly colliderHandle: number;

  private inputs: VehicleInputs = IDLE_INPUTS;
  private stuck: StuckState = initialStuckState;
  private flipSec = 0;
  private wrecked = false;
  private disposed = false;

  constructor(world: RapierWorld, rapier: RapierNamespace, pose: { x: number; z: number; yaw: number }) {
    this.vehicle = new PursuitVehicle({ world, rapier });
    this.colliderHandle = this.vehicle.spawn(pose, POLICE_TOP_SPEED_SCALE);
    registerEntity(this.colliderHandle, {
      kind: 'pursuit',
      districtId: -1,
      hp: POLICE.hp,
      unitKind: 'police',
    });

    this.slot = {
      id: nextPursuitSlotId(),
      kind: 'police',
      state: 'pursuing',
      x: pose.x,
      y: 0,
      z: pose.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      hp: POLICE.hp,
      behaviorLabel: 'pursue',
    };
    // Seed the slot pose from the actual (settled) body so the first render frame is correct
    // even before the first useAfterPhysicsStep syncSlot.
    this.vehicle.writePose(this.slot);

    liveUnits.add(this);
  }

  // --- 10 Hz decision (director-driven, staggered) ------------------------------------------

  think(): void {
    if (this.disposed || this.wrecked) {
      this.inputs = IDLE_INPUTS;
      return;
    }
    const player = playerVehicle.current?.readState();
    if (!player) {
      this.inputs = IDLE_INPUTS;
      this.slot.behaviorLabel = 'idle';
      return;
    }

    const pose = this.vehicle.readPlanarPose();
    const speed = this.vehicle.planarSpeed();
    const hits = this.vehicle.castAvoidHits(pose);
    const playerPos = { x: player.rawPose.position.x, z: player.rawPose.position.z };
    // Road-follow toward the player when far / building-blocked, else direct pursue (Phase 16
    // Task 5). Null inside pressDistM → the signed-off ram/press-in is unchanged.
    const approach = approachTargetFor(pose.x, pose.z, playerPos.x, playerPos.z, this.stuck);
    const result = pursueSteer(
      pose,
      speed,
      playerPos,
      { x: player.velocity.x, z: player.velocity.z },
      hits,
      this.stuck,
      AI_STEERING,
      AI_TICK_DT,
      'pursue',
      null,
      1,
      approach,
    );
    this.stuck = result.stuck;
    this.inputs = {
      steer: result.command.steer,
      throttle: result.command.throttle,
      brake: result.command.brake,
      handbrake: false,
    };
    this.slot.behaviorLabel = result.behavior;
  }

  // --- per physics step (tick-list driven) --------------------------------------------------

  applyStep(dt: number): void {
    if (this.disposed) return;
    // Wrecked units coast as debris (no engine/steer) until the director disposes them.
    this.vehicle.applyStep(this.wrecked ? IDLE_INPUTS : this.inputs, dt);
  }

  syncSlot(): void {
    if (this.disposed) return;
    this.vehicle.writePose(this.slot);

    const hp = getEntity(this.colliderHandle)?.hp ?? this.slot.hp;
    this.slot.hp = hp;
    if (this.wrecked) return;

    const upDot = this.vehicle.upDot();
    this.flipSec = upDot < AI_STEERING.wreckUpDot ? this.flipSec + PHYSICS_STEP_SEC : 0;
    if (hp <= 0 || this.flipSec >= AI_STEERING.wreckFlipSustainSec) {
      this.wrecked = true;
      this.slot.state = 'wrecked';
      this.slot.behaviorLabel = 'wrecked';
      this.inputs = IDLE_INPUTS;
      gameEvents.emit('unitWrecked', { unitKind: 'police' });
    }
  }

  // --- teardown -----------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    liveUnits.delete(this);
    unregisterEntity(this.colliderHandle);
    this.vehicle.dispose();
  }
}

export interface PoliceFactoryDeps {
  readonly world: RapierWorld;
  readonly rapier: RapierNamespace;
}

/** Build the police UnitFactory bound to a live Rapier context. Registered with the spawn
 * director (registerUnitFactory('police', …)) by PoliceMesh's mount effect, where useRapier()
 * makes the world/rapier deps available (they don't exist at import time). */
export function createPoliceFactory(deps: PoliceFactoryDeps): UnitFactory {
  return (pose) => {
    try {
      return new PoliceUnit(deps.world, deps.rapier, pose);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[policeSedan] failed to spawn police unit:', err);
      return null;
    }
  };
}
