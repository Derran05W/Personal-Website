// ★2 armored police (Phase 10 Task 2; TDD §5.6 "Armored police": 90 HP, 1.6× mass, 90% top
// speed, pure pursuit + a bulldozer "shove"). Mirrors ai/units/policeSedan.ts's structure
// EXACTLY (unit class implementing UnitHandle, its own module-scope per-step tick list, a
// factory the mesh registers with the director) — read that file's header first; this one
// only documents what's DIFFERENT.
//
// --- real mass, not just a damage-formula factor ------------------------------------------
// Police's massFactor 1.0 needed no override (VEHICLE_TUNING.chassis.massKg IS the 1.0
// reference). Armored's 1.6× (=1920 kg) has to be a REAL Rapier mass — "bulldozes props"
// only reads if the chassis is actually heavier, not just scored heavier in the damage
// formula. ai/pursuitVehicle.ts / vehicles/raycastVehicle.ts are Task-1/shared-chassis files
// this task does not touch, so the override happens HERE, entirely from this module: right
// after PursuitVehicle.spawn() (which already ran RaycastVehicle.create()'s
// setAdditionalMassProperties once, at the 1200 kg default), we reach the live RigidBody via
// world.getCollider(handle).parent() and call setAdditionalMassProperties again with the
// scaled mass — replicating raycastVehicle.ts's exact mass/COM/inertia formula (same
// comYOffset, same inertia-from-half-extents shape) so this is a strict mass reweight, not a
// different physical model. setAdditionalMassProperties fully REPLACES the previous call
// (per the Rapier API doc), so calling it twice is safe and leaves no stale 1200 kg residue.
//
// --- the shove -------------------------------------------------------------------------------
// vehicles/playerRef.ts's IVehicleModel exposes only applyInputs/readState/reset — no impulse
// path — so a scripted "push the player" effect can't go through it. The contact spine
// (combat/contacts.ts) already resolves every player-involved impact to registry identities
// with both colliders' HANDLES attached (ImpactRecord.aHandle/bHandle), and
// world.getCollider(handle).parent() gives the live RigidBody straight from those handles —
// so the shove subscribes to onImpact once (module scope, not per-unit) and, for every
// impact whose pair is (armored unit, player), applies a fixed-magnitude horizontal impulse
// to the PLAYER's body directly. "Capped": the impulse is a flat scripted constant
// (ENEMY_UNITS.armored.shoveImpulse) that never scales with the (potentially huge) contact
// forceMag, AND each armored unit rate-limits itself to one shove pulse per
// SHOVE_COOLDOWN_SEC — without the cooldown, a sustained press-in would re-fire the shove
// every physics step (contact-force events persist while touching) and fling the player at
// an absurd, ever-compounding speed. The result reads as periodic "thump" pulses while
// armored leans on the player, not a smooth runaway thrust.

import type { RapierContext } from '@react-three/rapier';
import { AI_STEERING, ENEMY_UNITS, SPAWN, VEHICLE_TUNING } from '../../config';
import { gameEvents } from '../../state/events';
import { getEntity, registerEntity, unregisterEntity, type EntityEntry } from '../../world/registry';
import { playerVehicle } from '../../vehicles/playerRef';
import type { VehicleInputs } from '../../vehicles/IVehicleModel';
import { PursuitVehicle } from '../pursuitVehicle';
import { initialStuckState, pursueSteer, type StuckState } from '../aiSteering';
import { approachTargetFor } from '../roadNav';
import type { UnitFactory, UnitHandle, UnitSlot } from '../pursuitTypes';
import { onImpact } from '../../combat/contacts';
import type { ImpactRecord } from '../../combat/types';
import { nextPursuitSlotId } from './slotIds';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

// Matches <Physics timeStep={1/60}> — see policeSedan.ts's identical constants.
const PHYSICS_STEP_SEC = 1 / 60;
const AI_TICK_DT = 1 / SPAWN.aiTickHz;

const ARMORED = ENEMY_UNITS.armored;
const ARMORED_TOP_SPEED_SCALE = ARMORED.topSpeedPct / 100;

// Minimum time (s) between two shove pulses from the SAME armored unit — see file header.
// A feel/throttle constant, not a per-frame physics quantity, so it lives here rather than
// in config (mirrors this module family's existing local constants like PHYSICS_STEP_SEC).
const SHOVE_COOLDOWN_SEC = 0.4;

const IDLE_INPUTS: VehicleInputs = { steer: 0, throttle: 0, brake: 0, handbrake: false };

// ===========================================================================================
// Per-step tick list (module scope — mirrors policeSedan.ts's own, separate list; each unit
// kind currently drives its own pair of step hooks from its own mesh, per this task's file
// scope — consolidating every kind onto ONE shared pursuit mount, as policeSedan.ts's header
// flags, stays a documented follow-up rather than something this task's file list covers).
// ===========================================================================================

interface PursuitStepUnit {
  applyStep(dt: number): void;
  syncSlot(): void;
}

const liveUnits = new Set<PursuitStepUnit>();

/** useBeforePhysicsStep driver (ArmoredMesh): apply every live unit's cached inputs. */
export function stepArmoredBefore(dt: number): void {
  for (const u of liveUnits) u.applyStep(dt);
}

/** useAfterPhysicsStep driver (ArmoredMesh): copy pose + run wreck detection. */
export function stepArmoredAfter(): void {
  for (const u of liveUnits) u.syncSlot();
}

/** Test/debug: live armored-body count in the tick list. */
export function liveArmoredCount(): number {
  return liveUnits.size;
}

// ===========================================================================================
// Shove system (module scope — one onImpact subscription for every live armored unit)
// ===========================================================================================

/** Handle → live ArmoredUnit, so the shove handler can find the unit's cooldown clock from
 * the ImpactRecord's raw collider handle. Populated on construct, cleared on dispose. */
const armoredByHandle = new Map<number, ArmoredUnit>();

/** Pure pair-matcher (no Rapier import — directly unit-testable): true when `impact` is an
 * armored↔player contact, returning which handle is which. Returns null for every other
 * pairing (armored↔prop, police↔player, undefined sides, …). */
export function pickArmoredPlayerPair(
  impact: Pick<ImpactRecord, 'a' | 'b' | 'aHandle' | 'bHandle'>,
): { readonly armoredHandle: number; readonly playerHandle: number } | null {
  const isArmored = (e: EntityEntry | undefined): boolean =>
    e?.kind === 'pursuit' && e.unitKind === 'armored';
  const isPlayer = (e: EntityEntry | undefined): boolean => e?.kind === 'player';

  if (isArmored(impact.a) && isPlayer(impact.b)) {
    return { armoredHandle: impact.aHandle, playerHandle: impact.bHandle };
  }
  if (isArmored(impact.b) && isPlayer(impact.a)) {
    return { armoredHandle: impact.bHandle, playerHandle: impact.aHandle };
  }
  return null;
}

/** Subscribes the shove handler to the live contact spine. Returns the unsubscribe (call on
 * the owning mesh's unmount — mirrors combat/damage.ts's initDamageSystem pattern). Deps
 * carry the live Rapier world so the handler can resolve both colliders' world translations
 * and the player's RigidBody straight off the ImpactRecord's handles (see file header). */
export function initArmoredShoveSystem(deps: { readonly world: RapierWorld }): () => void {
  return onImpact((impact) => {
    if (ARMORED.shoveImpulse === undefined) return;
    const pair = pickArmoredPlayerPair(impact);
    if (!pair) return;
    const unit = armoredByHandle.get(pair.armoredHandle);
    if (!unit || !unit.tryConsumeShoveCooldown()) return;

    const armoredCollider = deps.world.getCollider(pair.armoredHandle);
    const playerCollider = deps.world.getCollider(pair.playerHandle);
    if (!armoredCollider || !playerCollider) return;
    const playerBody = playerCollider.parent();
    if (!playerBody) return;

    const at = armoredCollider.translation();
    const pt = playerCollider.translation();
    let dx = pt.x - at.x;
    let dz = pt.z - at.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) {
      // Degenerate (near-coincident centers): shove straight along armored's forward axis
      // instead of a divide-by-zero direction.
      const q = armoredCollider.rotation();
      dx = 2 * (q.x * q.z + q.w * q.y);
      dz = 1 - 2 * (q.x * q.x + q.y * q.y);
      const fl = Math.hypot(dx, dz) || 1;
      dx /= fl;
      dz /= fl;
    } else {
      dx /= len;
      dz /= len;
    }
    playerBody.applyImpulse({ x: dx * ARMORED.shoveImpulse, y: 0, z: dz * ARMORED.shoveImpulse }, true);
  });
}

// ===========================================================================================
// Armored unit
// ===========================================================================================

class ArmoredUnit implements UnitHandle, PursuitStepUnit {
  readonly slot: UnitSlot;

  private readonly vehicle: PursuitVehicle;
  private readonly colliderHandle: number;

  private inputs: VehicleInputs = IDLE_INPUTS;
  private stuck: StuckState = initialStuckState;
  private flipSec = 0;
  private wrecked = false;
  private disposed = false;
  private nextShoveAtMs = 0;

  constructor(world: RapierWorld, rapier: RapierNamespace, pose: { x: number; z: number; yaw: number }) {
    this.vehicle = new PursuitVehicle({ world, rapier });
    this.colliderHandle = this.vehicle.spawn(pose, ARMORED_TOP_SPEED_SCALE);
    overrideChassisMass(world, this.colliderHandle, ARMORED.massFactor);

    registerEntity(this.colliderHandle, {
      kind: 'pursuit',
      districtId: -1,
      hp: ARMORED.hp,
      unitKind: 'armored',
    });
    armoredByHandle.set(this.colliderHandle, this);

    this.slot = {
      // Shared, globally-unique counter (slotIds.ts) — see that file's header for why a
      // per-module counter collides once multiple kinds are live together.
      id: nextPursuitSlotId(),
      kind: 'armored',
      state: 'pursuing',
      x: pose.x,
      y: 0,
      z: pose.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      hp: ARMORED.hp,
      behaviorLabel: 'pursue',
    };
    this.vehicle.writePose(this.slot);

    liveUnits.add(this);
  }

  // --- 10 Hz decision (director-driven, staggered) -------------------------------------------
  // Same pure pursue/ram/avoid/stuck steering as police (armored never flanks — TDD §5.6
  // gives it plain `pursuit` behavior, unlike swat's `flank`). No squad coordination import.

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
    // Task 5) — armored bulldozes the same as before once inside pressDistM (approach = null).
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
      gameEvents.emit('unitWrecked', { unitKind: 'armored' });
    }
  }

  /** Rate-limit gate for the shove system: true (and starts the next cooldown window) at
   * most once per SHOVE_COOLDOWN_SEC — see file header. Wall-clock based (performance.now()),
   * matching this unit family's other runtime-only timing (e.g. PoliceMesh's strobe phase). */
  tryConsumeShoveCooldown(): boolean {
    const now = performance.now();
    if (now < this.nextShoveAtMs) return false;
    this.nextShoveAtMs = now + SHOVE_COOLDOWN_SEC * 1000;
    return true;
  }

  // --- teardown -----------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    liveUnits.delete(this);
    armoredByHandle.delete(this.colliderHandle);
    unregisterEntity(this.colliderHandle);
    this.vehicle.dispose();
  }
}

/**
 * Re-applies the chassis's mass/COM/inertia at `massFactor` × VEHICLE_TUNING.chassis.massKg,
 * replicating vehicles/raycastVehicle.ts's create() formula verbatim (same comYOffset, same
 * inertia-from-half-extents shape) so this is a pure mass reweight of the SAME physical
 * model, not a divergent one. Called once, right after PursuitVehicle.spawn() (which already
 * set the 1200 kg default via that same code path) — setAdditionalMassProperties fully
 * replaces the previous call, so there is no stale residue. No-op (logged in DEV) if the
 * collider's body can't be resolved. See file header for why this lives here instead of a
 * shared-chassis file this task doesn't touch.
 */
function overrideChassisMass(world: RapierWorld, colliderHandle: number, massFactor: number): void {
  const body = world.getCollider(colliderHandle)?.parent();
  if (!body) {
    if (import.meta.env.DEV) console.error('[armoredPolice] mass override: no body for collider');
    return;
  }
  const { chassis } = VEHICLE_TUNING;
  const m = chassis.massKg * massFactor;
  const inertia = {
    x: (m / 3) * (chassis.halfHeight * chassis.halfHeight + chassis.halfLength * chassis.halfLength),
    y: (m / 3) * (chassis.halfWidth * chassis.halfWidth + chassis.halfLength * chassis.halfLength),
    z: (m / 3) * (chassis.halfWidth * chassis.halfWidth + chassis.halfHeight * chassis.halfHeight),
  };
  body.setAdditionalMassProperties(
    m,
    { x: 0, y: chassis.comYOffset, z: 0 },
    inertia,
    { x: 0, y: 0, z: 0, w: 1 },
    true,
  );
}

export interface ArmoredFactoryDeps {
  readonly world: RapierWorld;
  readonly rapier: RapierNamespace;
}

/** Build the armored UnitFactory bound to a live Rapier context — registered with the spawn
 * director (registerUnitFactory('armored', …)) by ArmoredMesh's mount effect, mirroring
 * policeSedan.ts's createPoliceFactory. */
export function createArmoredFactory(deps: ArmoredFactoryDeps): UnitFactory {
  return (pose) => {
    try {
      return new ArmoredUnit(deps.world, deps.rapier, pose);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[armoredPolice] failed to spawn armored unit:', err);
      return null;
    }
  };
}
