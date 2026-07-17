// ★4 gun truck (Phase 11 Task 2; TDD §5.6 "Gun truck": 100 HP, 1.5× mass, 95% top speed,
// standoff behavior — orbits at ~20 m and rakes the player with 3-round turret bursts, closing
// to ram only when the player stops running). Mirrors ai/units/swatSuv.ts / armoredPolice.ts's
// structure EXACTLY (unit class implementing UnitHandle, its own module-scope per-step tick list,
// a factory the mesh registers) — read swatSuv.ts's header first; only what's DIFFERENT is here.
//
// --- what's new vs. the ram units ----------------------------------------------------------
// The gun truck is the first RANGED unit. It bolts three things onto the shared pursuit chassis:
//   • a STANDOFF BRAIN (ai/aiSteering.ts createStandoffBrain, Task 1) that picks orbit vs ram,
//     mapped to pursueSteer's 'orbit'/'pursue' modes with a per-unit seeded orbit handedness;
//   • a TURRET (combat/turret.ts) whose WORLD-space aim damps toward the player each physics step
//     (a fast crosser out-runs it — the counterplay); and
//   • a HITSCAN BURST (combat/hitscan.ts) scheduled in SIM time inside applyStep (not setTimeout):
//     3 rounds 100 ms apart, then a 2.5 s cooldown, each round a seeded-spread raycast that damages
//     the player / launches a static prop (world/propDynamics.ts) / damages other hp entities.
// The turret's live world yaw is published per slot id (getGunTruckTurretYaw) so GunTruckMesh can
// orient its SECOND (turret) InstancedMesh independently of the hull.
//
// --- real mass, same as armored/swat -------------------------------------------------------
// 1.5× (=1800 kg) is a REAL Rapier mass override (overrideChassisMass, the same verbatim copy of
// raycastVehicle.ts's mass/COM/inertia formula the other heavy units use) so a ram actually
// carries weight, not just a heavier damage-formula factor.

import type { RapierContext } from '@react-three/rapier';
import { AI_STEERING, ENEMY_UNITS, GUN_TRUCK, SPAWN, VEHICLE_TUNING } from '../../config';
import { gameEvents } from '../../state/events';
import { getEntity, registerEntity, unregisterEntity } from '../../world/registry';
import { createRng, type Rng } from '../../world/rng';
import { playerVehicle } from '../../vehicles/playerRef';
import type { VehicleInputs } from '../../vehicles/IVehicleModel';
import { PursuitVehicle } from '../pursuitVehicle';
import { createStandoffBrain, initialStuckState, pursueSteer, type StandoffBrain, type StuckState } from '../aiSteering';
import type { UnitFactory, UnitHandle, UnitSlot } from '../pursuitTypes';
import { nextPursuitSlotId } from './slotIds';
import {
  Turret,
  canFire,
  castBuildingClear,
  lateralSpeed,
  maxYawStep,
  turretMuzzle,
  type Vec3,
} from '../../combat/turret';
import {
  beginBurst,
  bulletDirection,
  canStartBurst,
  fireRound,
  initialBurstState,
  pitchToward,
  pumpBurst,
  spreadAngle,
  type BurstCfg,
  type BurstState,
} from '../../combat/hitscan';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

const PHYSICS_STEP_SEC = 1 / 60;
const AI_TICK_DT = 1 / SPAWN.aiTickHz;
const DEG2RAD = Math.PI / 180;

const GUN = ENEMY_UNITS.gunTruck;
const GUN_TOP_SPEED_SCALE = GUN.topSpeedPct / 100;

const TURRET = GUN_TRUCK.turret;
const SPREAD_RAD = TURRET.spreadDegMax * DEG2RAD;
const FIRE_GATE = { engagementRangeM: TURRET.engagementRangeM, slipGateMps: TURRET.slipGateMps };
const MUZZLE_CFG = { heightM: TURRET.heightM, muzzleForwardM: TURRET.muzzleForwardM };
const BURST_CFG: BurstCfg = {
  rounds: GUN_TRUCK.burst.rounds,
  spacingSec: GUN_TRUCK.burst.spacingMs / 1000,
  cooldownSec: GUN_TRUCK.burst.cooldownSec,
};

const IDLE_INPUTS: VehicleInputs = { steer: 0, throttle: 0, brake: 0, handbrake: false };

// ===========================================================================================
// Per-step tick list + turret-yaw publication (module scope — mirrors swatSuv.ts's own list).
// ===========================================================================================

interface PursuitStepUnit {
  applyStep(dt: number): void;
  syncSlot(): void;
}

const liveUnits = new Set<PursuitStepUnit>();

/** slot id → current world-space turret aim yaw (rad). GunTruckMesh reads this per frame to
 * orient the turret InstancedMesh; the unit writes it every physics step. */
const turretYawById = new Map<number, number>();

/** GunTruckMesh: current turret aim yaw for a live gun-truck slot, or undefined if none. */
export function getGunTruckTurretYaw(slotId: number): number | undefined {
  return turretYawById.get(slotId);
}

/** useBeforePhysicsStep driver (GunTruckMesh): apply inputs + tick turret/burst for each unit. */
export function stepGunTruckBefore(dt: number): void {
  for (const u of liveUnits) u.applyStep(dt);
}

/** useAfterPhysicsStep driver (GunTruckMesh): copy pose + run wreck detection. */
export function stepGunTruckAfter(): void {
  for (const u of liveUnits) u.syncSlot();
}

/** Test/debug: live gun-truck count in the tick list. */
export function liveGunTruckCount(): number {
  return liveUnits.size;
}

// ===========================================================================================
// Gun-truck unit
// ===========================================================================================

class GunTruckUnit implements UnitHandle, PursuitStepUnit {
  readonly slot: UnitSlot;

  private readonly world: RapierWorld;
  private readonly vehicle: PursuitVehicle;
  private readonly colliderHandle: number;

  private inputs: VehicleInputs = IDLE_INPUTS;
  private stuck: StuckState = initialStuckState;
  private flipSec = 0;
  private wrecked = false;
  private disposed = false;

  // Ranged systems.
  private readonly turret: Turret;
  private readonly brain: StandoffBrain;
  private readonly baseRng: Rng;
  private readonly orbitDir: number; // +1 / −1, seeded per unit → opposite-circling crossfire
  private readonly ray: InstanceType<RapierNamespace['Ray']>;
  private burst: BurstState = initialBurstState;
  private burstRng: Rng | null = null;
  private simTime = 0;
  // Previous raw planar position → finite-difference velocity for the lateral-slip fire gate
  // (PursuitVehicle exposes speed magnitude but not the velocity vector, and this task doesn't
  // touch that shared file — a two-sample difference at the fixed step is exact enough).
  private prevX: number;
  private prevZ: number;

  constructor(world: RapierWorld, rapier: RapierNamespace, pose: { x: number; z: number; yaw: number }) {
    this.world = world;
    this.vehicle = new PursuitVehicle({ world, rapier });
    this.colliderHandle = this.vehicle.spawn(pose, GUN_TOP_SPEED_SCALE);
    overrideChassisMass(world, this.colliderHandle, GUN.massFactor);

    registerEntity(this.colliderHandle, {
      kind: 'pursuit',
      districtId: -1,
      hp: GUN.hp,
      unitKind: 'gunTruck',
    });

    this.slot = {
      id: nextPursuitSlotId(),
      kind: 'gunTruck',
      state: 'pursuing',
      x: pose.x,
      y: 0,
      z: pose.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      hp: GUN.hp,
      behaviorLabel: 'orbit',
    };
    this.vehicle.writePose(this.slot);

    // Deterministic per-unit streams: handedness once, a fresh spread fork per burst.
    this.baseRng = createRng((this.slot.id + 1) >>> 0);
    this.orbitDir = this.baseRng.fork('orbit').next() < 0.5 ? -1 : 1;
    this.turret = new Turret(pose.yaw); // spawns facing the player (director aims the pose at it)
    this.brain = createStandoffBrain(AI_STEERING);
    this.ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this.prevX = pose.x;
    this.prevZ = pose.z;

    liveUnits.add(this);
  }

  // --- 10 Hz decision: standoff brain → orbit/pursue steering --------------------------------

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
    const playerVel = { x: player.velocity.x, z: player.velocity.z };
    const playerSpeed = Math.hypot(playerVel.x, playerVel.z);
    const dist = Math.hypot(playerPos.x - pose.x, playerPos.z - pose.z);

    // Standoff brain (Task 1): 'orbit' → circle the ring; 'ram' → pursueSteer's ram-commit.
    const mode = this.brain.update(playerSpeed, dist, AI_TICK_DT);
    const steerMode = mode === 'ram' ? 'pursue' : 'orbit';

    const result = pursueSteer(
      pose,
      speed,
      playerPos,
      playerVel,
      hits,
      this.stuck,
      AI_STEERING,
      AI_TICK_DT,
      steerMode,
      null,
      this.orbitDir,
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

  // --- per physics step: chassis + turret tracking + burst scheduling ------------------------

  applyStep(dt: number): void {
    if (this.disposed) return;
    this.vehicle.applyStep(this.wrecked ? IDLE_INPUTS : this.inputs, dt);
    this.simTime += dt;
    if (this.wrecked) return;

    const player = playerVehicle.current?.readState();
    if (!player) return;

    const pose = this.vehicle.readPlanarPose();
    // Finite-difference planar velocity for the slip gate, then advance the sample.
    const vx = (pose.x - this.prevX) / dt;
    const vz = (pose.z - this.prevZ) / dt;
    this.prevX = pose.x;
    this.prevZ = pose.z;

    const chassisCenter: Vec3 = { x: pose.x, y: this.slot.y, z: pose.z };
    const playerCenter: Vec3 = {
      x: player.rawPose.position.x,
      y: player.rawPose.position.y,
      z: player.rawPose.position.z,
    };

    // Damp the WORLD aim toward the player and publish it for the mesh.
    const aimYaw = this.turret.track(
      { x: pose.x, z: pose.z },
      { x: playerCenter.x, z: playerCenter.z },
      maxYawStep(TURRET.yawRateDegPerSec, dt),
    );
    turretYawById.set(this.slot.id, aimYaw);

    const muzzle = turretMuzzle(chassisCenter, aimYaw, MUZZLE_CFG);
    const distM = Math.hypot(playerCenter.x - pose.x, playerCenter.z - pose.z);
    const losClear = castBuildingClear(this.world, this.ray, muzzle, playerCenter);
    const gateOpen = canFire({
      distM,
      lateralSpeedMps: lateralSpeed(vx, vz, pose.yaw),
      losClear,
      cfg: FIRE_GATE,
    });

    // Start a burst only when idle, past cooldown, and the gate is open; then fire whatever
    // rounds are DUE this sim step (round 0 fires immediately on the starting step). A burst,
    // once started, commits its 3 rounds even if the gate momentarily closes — a round that
    // no longer has a clean shot simply raycasts into the building/ground (no player hit).
    if (canStartBurst(this.burst, this.simTime) && gateOpen) {
      this.burst = beginBurst(this.burst, this.simTime);
      this.burstRng = this.baseRng.fork(`burst:${this.burst.burstIndex}`);
    }
    if (this.burst.phase === 'firing') {
      const { fired, state } = pumpBurst(this.burst, this.simTime, BURST_CFG);
      for (let i = 0; i < fired.length; i++) this.fireOneRound(muzzle, aimYaw, playerCenter);
      this.burst = state;
    }
  }

  /** Fire one hitscan round along the current aim + a seeded cone spread + a pitch onto the
   * player's chassis. Pulls two spread samples (yaw, pitch) from the burst's fork so the whole
   * burst's dispersion is reproducible. */
  private fireOneRound(muzzle: Vec3, aimYaw: number, playerCenter: Vec3): void {
    const rng = this.burstRng ?? this.baseRng;
    const pitch = pitchToward(muzzle, playerCenter);
    const dir = bulletDirection(aimYaw, pitch, spreadAngle(rng, SPREAD_RAD), spreadAngle(rng, SPREAD_RAD));
    fireRound(
      { world: this.world, ray: this.ray },
      {
        muzzle,
        dir,
        rangeM: GUN_TRUCK.burst.rangeM,
        dmgPerHit: GUN_TRUCK.burst.dmgPerHit,
        impulsePerHit: GUN_TRUCK.burst.impulsePerHit,
        propForceProxyN: GUN_TRUCK.burst.propForceProxyN,
        nowMs: performance.now(),
      },
    );
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
      gameEvents.emit('unitWrecked', { unitKind: 'gunTruck' });
    }
  }

  // --- teardown -----------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    liveUnits.delete(this);
    turretYawById.delete(this.slot.id);
    unregisterEntity(this.colliderHandle);
    this.vehicle.dispose();
  }
}

/** Real Rapier mass override at `massFactor` × the reference chassis mass — verbatim copy of
 * armoredPolice.ts/swatSuv.ts's overrideChassisMass (an intentional small duplicate so this
 * module stays independently spawnable, matching that family's convention). */
function overrideChassisMass(world: RapierWorld, colliderHandle: number, massFactor: number): void {
  const body = world.getCollider(colliderHandle)?.parent();
  if (!body) {
    if (import.meta.env.DEV) console.error('[gunTruck] mass override: no body for collider');
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

export interface GunTruckFactoryDeps {
  readonly world: RapierWorld;
  readonly rapier: RapierNamespace;
}

/** Build the gun-truck UnitFactory bound to a live Rapier context — registered with the spawn
 * director (registerUnitFactory('gunTruck', …)) by GunTruckMesh's mount effect, mirroring
 * createSwatFactory. */
export function createGunTruckFactory(deps: GunTruckFactoryDeps): UnitFactory {
  return (pose) => {
    try {
      return new GunTruckUnit(deps.world, deps.rapier, pose);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[gunTruck] failed to spawn gun-truck unit:', err);
      return null;
    }
  };
}
