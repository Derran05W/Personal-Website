// ★5 tank (Phase 12 Task 2; TDD §5.6 "Tank": 400 HP, 6.0× mass, 55% top speed, slow siege
// chase, turret tracks the player at max 60°/s and lobs a shell every 5 s with a 0.8 s
// telegraph). Mirrors ai/units/gunTruck.ts's structure (unit class implementing UnitHandle, a
// module-scope per-step tick list, a factory the mesh registers) — read gunTruck.ts's header
// first; only what's DIFFERENT is documented here.
//
// --- chassis: raycast-heavy (verdict recorded in phase notes) --------------------------------
// The tank reuses the shared pursuit chassis (ai/pursuitVehicle.ts → vehicles/raycastVehicle.ts)
// exactly like armored/swat/gunTruck, with a REAL 6.0× Rapier mass override (overrideChassisMass,
// the verbatim armored/gunTruck formula) so 7200 kg actually plows. Two things keep the 6× chassis
// composed where a naive reuse would bounce/flip/jitter:
//   • a per-unit SOFT SPEED GOVERNOR (cappedInputs) that coasts throttle above the tank's 55%
//     top speed — the shared raycast governor only caps at STARTER_TOP_SPEED (100%), so without
//     this a heavy unit would still crawl toward 100%; capping at 55% both enforces the spec AND
//     removes the high-speed energy that launches the chassis into turns; and
//   • the shared pursuit downforce + corner-throttle-ease (AI_STEERING) already tuned for the
//     lighter units, which at the tank's low speed leave a wide stability margin.
// If a live 6× drive shows sustained bounce/flip/jitter, the fallback is an arcade-box drive
// (dynamic body + direct force/torque) behind this same class surface — see the phase notes for
// the empirical verdict that settled the choice.
//
// --- turret + fire cycle ---------------------------------------------------------------------
// The turret REUSES combat/turret.ts verbatim (world-space aim that damps toward the player each
// step, rate-limited by maxYawStep(TANK.turretYawDegPerSec=60°/s, dt) — the exact getGunTruckTurretYaw
// precedent, published per slot as getTankTurretYaw for TankMesh). Aim leads the player by a TINY
// TANK_UNIT.leadTimeSec (0.2 s) — the 60°/s cap is the real balancer. Firing is a pure, sim-time
// state machine (stepTankFire, unit-tested): idle → telegraph (TANK.telegraphSec) → fire, one shell
// every TANK.fireCooldown. Unlike the gun truck there is NO LOS gate (a shell hitting a building is
// fine/fun — TDD), only a max engagement range (TANK_UNIT.engagementRangeM). The live telegraph
// state is published per slot (getTankTelegraph) for Task 3's FX (barrel glow + laser dot); the
// shell itself is fired through Task 1's combat/projectiles API (see fireTankShell below).

import type { RapierContext } from '@react-three/rapier';
import { AI_STEERING, ENEMY_UNITS, SPAWN, STARTER_TOP_SPEED, TANK, TANK_UNIT, VEHICLE_TUNING } from '../../config';
import { gameEvents } from '../../state/events';
import { getEntity, registerEntity, unregisterEntity } from '../../world/registry';
import { playerVehicle } from '../../vehicles/playerRef';
import type { VehicleInputs } from '../../vehicles/IVehicleModel';
import { PursuitVehicle } from '../pursuitVehicle';
import { initialStuckState, pursueSteer, type StuckState } from '../aiSteering';
import { approachTargetFor } from '../roadNav';
import type { UnitFactory, UnitHandle, UnitSlot } from '../pursuitTypes';
import { nextPursuitSlotId } from './slotIds';
import { Turret, maxYawStep, turretMuzzle, type Vec3 } from '../../combat/turret';
import { projectilesRef } from '../../combat/projectiles';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

const PHYSICS_STEP_SEC = 1 / 60;
const AI_TICK_DT = 1 / SPAWN.aiTickHz;

const TANK_STATS = ENEMY_UNITS.tank;
const TANK_TOP_SPEED_SCALE = TANK_STATS.topSpeedPct / 100;
// Soft governor target (m/s): the tank's 55% of the starter top speed. See the file header for
// why a per-unit cap is needed on top of the shared raycast governor (which only caps at 100%).
const TANK_TOP_SPEED_MPS = STARTER_TOP_SPEED * TANK_TOP_SPEED_SCALE;

// Muzzle geometry for combat/turret.ts turretMuzzle (must match TankMesh's barrel — TANK_UNIT doc).
const MUZZLE_CFG = { heightM: TANK_UNIT.turret.heightM, muzzleForwardM: TANK_UNIT.turret.muzzleForwardM };

const IDLE_INPUTS: VehicleInputs = { steer: 0, throttle: 0, brake: 0, handbrake: false };

// ===========================================================================================
// Pure fire-cycle state machine (unit-tested; no Rapier/three). idle → telegraph → fire, one
// shell every fireCooldownSec with the final telegraphSec of each period spent telegraphing.
// ===========================================================================================

export type TankFirePhase = 'idle' | 'telegraph';

export interface TankFireState {
  readonly phase: TankFirePhase;
  /** Sim time (s) the current telegraph began (only meaningful while phase === 'telegraph'). */
  readonly telegraphStartSec: number;
  /** No new telegraph may begin before this sim time — enforces the fireCooldownSec period. */
  readonly nextReadySec: number;
  /** Total shells fired since spawn (telemetry + a "fired this step" change-detector). */
  readonly shotsFired: number;
}

export interface TankFireCfg {
  /** Shot-to-shot period (s). TANK.fireCooldown. */
  readonly fireCooldownSec: number;
  /** Telegraph window before each shot (s). TANK.telegraphSec. */
  readonly telegraphSec: number;
}

/** Initial state: the FIRST shell lands one full period (fireCooldownSec) after spawn — the idle
 * part of the period is (fireCooldownSec − telegraphSec), then a telegraph completes at
 * fireCooldownSec. So a freshly-spawned tank never fires instantly, even if it spawns in range. */
export function initialTankFireState(cfg: TankFireCfg): TankFireState {
  return {
    phase: 'idle',
    telegraphStartSec: 0,
    nextReadySec: Math.max(0, cfg.fireCooldownSec - cfg.telegraphSec),
    shotsFired: 0,
  };
}

export interface TankFireStep {
  readonly state: TankFireState;
  /** True on exactly the step the shell fires (the telegraph window elapsed this step). */
  readonly fired: boolean;
}

/**
 * Advance the fire cycle one physics step. Pure — the caller supplies the running sim time, whether
 * the player is currently in engagement range, and the cadence config.
 *   • idle: begin a telegraph once the period has elapsed (simTime ≥ nextReadySec) AND the player
 *     is in range. A tank that has been out of range past its ready time simply telegraphs the
 *     instant the player enters range — one telegraphed shot, never a "backlog" (this is a phase
 *     machine: at most one telegraph → one shot, so a long wait can't queue multiple shells).
 *   • telegraph: COMMITS — once the telegraphSec window elapses the shell fires (even if the player
 *     slipped out of range mid-telegraph; a committed shot is the whole point of a telegraph), the
 *     cycle returns to idle, and nextReadySec is set a full period out from this shot.
 */
export function stepTankFire(
  prev: TankFireState,
  simTimeSec: number,
  inRange: boolean,
  cfg: TankFireCfg,
): TankFireStep {
  const idleSec = Math.max(0, cfg.fireCooldownSec - cfg.telegraphSec);
  if (prev.phase === 'idle') {
    if (simTimeSec >= prev.nextReadySec && inRange) {
      return { state: { ...prev, phase: 'telegraph', telegraphStartSec: simTimeSec }, fired: false };
    }
    return { state: prev, fired: false };
  }
  // phase === 'telegraph'
  const fireAt = prev.telegraphStartSec + cfg.telegraphSec;
  if (simTimeSec + 1e-9 >= fireAt) {
    return {
      state: {
        phase: 'idle',
        telegraphStartSec: prev.telegraphStartSec,
        nextReadySec: fireAt + idleSec,
        shotsFired: prev.shotsFired + 1,
      },
      fired: true,
    };
  }
  return { state: prev, fired: false };
}

/** Telegraph progress in [0,1] (0 while idle) — Task 3's FX ramps barrel glow + laser intensity. */
export function telegraphProgress01(state: TankFireState, simTimeSec: number, cfg: TankFireCfg): number {
  if (state.phase !== 'telegraph') return 0;
  const p = (simTimeSec - state.telegraphStartSec) / Math.max(1e-6, cfg.telegraphSec);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Aim point = target position + leadSec × target velocity. TINY lead (TANK_UNIT.leadTimeSec) —
 * see TANK_UNIT's doc for why the shell stays dodgeable despite the lead. Pure/testable. */
export function leadAimPoint(
  pos: Vec3,
  vel: { readonly x: number; readonly y: number; readonly z: number },
  leadSec: number,
): Vec3 {
  return { x: pos.x + vel.x * leadSec, y: pos.y + vel.y * leadSec, z: pos.z + vel.z * leadSec };
}

/** Unit direction from `from` to `to`; falls back to +Z for a degenerate near-zero span. */
export function unitDir(from: Vec3, to: Vec3): Vec3 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return { x: 0, y: 0, z: 1 };
  return { x: dx / len, y: dy / len, z: dz / len };
}

const FIRE_CFG: TankFireCfg = { fireCooldownSec: TANK.fireCooldown, telegraphSec: TANK.telegraphSec };

// ===========================================================================================
// Per-step tick list + turret-yaw / telegraph publication (module scope — mirrors gunTruck.ts).
// ===========================================================================================

interface PursuitStepUnit {
  applyStep(dt: number): void;
  syncSlot(): void;
}

const liveUnits = new Set<PursuitStepUnit>();

/** slot id → current world-space turret aim yaw (rad). TankMesh reads this per frame to orient
 * the turret+barrel InstancedMesh; the unit writes it every physics step. */
const turretYawById = new Map<number, number>();

/** Live telegraph state per slot id — Task 3's FX (barrel glow + laser dot) consumes it. */
export interface TankTelegraph {
  readonly phase: TankFirePhase;
  /** 0..1 through the telegraph window (0 while idle). */
  readonly progress01: number;
  /** World point the barrel is aiming at (the laser dot target), at player height. */
  readonly aimPoint: Vec3;
  /** World barrel-tip position — the shell spawn + barrel-glow + laser-ray origin. */
  readonly barrelTip: Vec3;
}
const telegraphById = new Map<number, TankTelegraph>();

const IDLE_TELEGRAPH_AT = (barrelTip: Vec3, aimPoint: Vec3): TankTelegraph => ({
  phase: 'idle',
  progress01: 0,
  aimPoint,
  barrelTip,
});

/** TankMesh: current turret aim yaw for a live tank slot, or undefined if none. */
export function getTankTurretYaw(slotId: number): number | undefined {
  return turretYawById.get(slotId);
}

/** Task 3 FX: current telegraph state for a live tank slot, or undefined if none. */
export function getTankTelegraph(slotId: number): TankTelegraph | undefined {
  return telegraphById.get(slotId);
}

/** DEV/debug snapshot of every live tank's fire + turret state (debugBridge → Playwright). */
export interface TankDebugState {
  id: number;
  phase: TankFirePhase;
  progress01: number;
  shotsFired: number;
  /** Current world-space turret aim yaw (rad) — proves the turret is tracking (yaw changes). */
  turretYaw: number;
}
export function tankDebugSnapshot(): TankDebugState[] {
  const out: TankDebugState[] = [];
  for (const u of liveUnits) {
    if (u instanceof TankUnit) out.push(u.debugFireState());
  }
  return out;
}

/** useBeforePhysicsStep driver (TankMesh): apply inputs + tick turret/fire cycle for each unit. */
export function stepTankBefore(dt: number): void {
  for (const u of liveUnits) u.applyStep(dt);
}

/** useAfterPhysicsStep driver (TankMesh): copy pose + run wreck detection. */
export function stepTankAfter(): void {
  for (const u of liveUnits) u.syncSlot();
}

/** Test/debug: live tank count in the tick list. */
export function liveTankCount(): number {
  return liveUnits.size;
}

// ===========================================================================================
// Shell fire seam — Task 1's combat/projectiles.ts (ProjectilesApi.spawn(firerBodyHandle, origin,
// dir), published on projectilesRef by combat/ProjectilesMount while a run is live). Read-only
// import of the seam ref (never edits combat/*), exactly how the gun truck reaches combat/hitscan.
// A no-op if the pool isn't mounted (projectilesRef.current === null), same discipline as the
// other module-scope live handles (unitsRef / propDynamics).
// ===========================================================================================

function fireTankShell(firerBodyHandle: number, origin: Vec3, dir: Vec3): void {
  projectilesRef.current?.spawn(firerBodyHandle, origin, dir);
}

// ===========================================================================================
// Tank unit
// ===========================================================================================

class TankUnit implements UnitHandle, PursuitStepUnit {
  readonly slot: UnitSlot;

  private readonly vehicle: PursuitVehicle;
  private readonly colliderHandle: number;
  private readonly bodyHandle: number;

  private inputs: VehicleInputs = IDLE_INPUTS;
  private stuck: StuckState = initialStuckState;
  private flipSec = 0;
  private wrecked = false;
  private disposed = false;

  private readonly turret: Turret;
  private fireState: TankFireState = initialTankFireState(FIRE_CFG);
  private simTime = 0;

  constructor(world: RapierWorld, rapier: RapierNamespace, pose: { x: number; z: number; yaw: number }) {
    this.vehicle = new PursuitVehicle({ world, rapier });
    this.colliderHandle = this.vehicle.spawn(pose, TANK_TOP_SPEED_SCALE);
    // REAL 6× Rapier mass (= 7200 kg) — the shared armored/gunTruck override formula.
    overrideChassisMass(world, this.colliderHandle, TANK_STATS.massFactor);
    // Firer body handle for the shell's ignore-firer (resolved off the collider's parent body).
    this.bodyHandle = world.getCollider(this.colliderHandle)?.parent()?.handle ?? -1;

    registerEntity(this.colliderHandle, {
      kind: 'pursuit',
      districtId: -1,
      hp: TANK_STATS.hp,
      unitKind: 'tank',
    });

    this.slot = {
      id: nextPursuitSlotId(),
      kind: 'tank',
      state: 'pursuing',
      x: pose.x,
      y: 0,
      z: pose.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      hp: TANK_STATS.hp,
      behaviorLabel: 'pursue',
    };
    this.vehicle.writePose(this.slot);

    this.turret = new Turret(pose.yaw); // spawns facing the player (director aims the pose at it)

    liveUnits.add(this);
  }

  // --- 10 Hz decision: plain slow pursuit (siege). Wide avoidance comes from the shared rays. ---

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
    // Road-follow toward the player when far / building-blocked (Phase 16 Task 5): the 6× siege
    // chassis is the worst wedger, so the road-graph hint matters most here.
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

  // --- per physics step: chassis (governed) + turret tracking + fire cycle -------------------

  applyStep(dt: number): void {
    if (this.disposed) return;
    this.vehicle.applyStep(this.wrecked ? IDLE_INPUTS : this.cappedInputs(), dt);
    this.simTime += dt;
    if (this.wrecked) return;

    const player = playerVehicle.current?.readState();
    if (!player) return;

    const pose = this.vehicle.readPlanarPose();
    const playerCenter: Vec3 = {
      x: player.rawPose.position.x,
      y: player.rawPose.position.y,
      z: player.rawPose.position.z,
    };
    const aimPoint = leadAimPoint(playerCenter, player.velocity, TANK_UNIT.leadTimeSec);
    // Keep the shell aim at the player's height so the flat shot descends onto the chassis rather
    // than sailing over it at barrel height (the turret only yaws; pitch comes from the aim point).
    const aimPoint3D: Vec3 = { x: aimPoint.x, y: playerCenter.y, z: aimPoint.z };

    // World-aim slew toward the lead point, rate-limited to TANK.turretYawDegPerSec — publish it.
    const aimYaw = this.turret.track(
      { x: pose.x, z: pose.z },
      { x: aimPoint3D.x, z: aimPoint3D.z },
      maxYawStep(TANK.turretYawDegPerSec, dt),
    );
    turretYawById.set(this.slot.id, aimYaw);

    const chassisCenter: Vec3 = { x: pose.x, y: this.slot.y, z: pose.z };
    const barrelTip = turretMuzzle(chassisCenter, aimYaw, MUZZLE_CFG);
    const distM = Math.hypot(playerCenter.x - pose.x, playerCenter.z - pose.z);
    const inRange = distM <= TANK_UNIT.engagementRangeM;

    const { state, fired } = stepTankFire(this.fireState, this.simTime, inRange, FIRE_CFG);
    this.fireState = state;

    telegraphById.set(this.slot.id, {
      phase: state.phase,
      progress01: telegraphProgress01(state, this.simTime, FIRE_CFG),
      aimPoint: aimPoint3D,
      barrelTip,
    });

    if (fired) {
      fireTankShell(this.bodyHandle, barrelTip, unitDir(barrelTip, aimPoint3D));
    }
  }

  /** Soft speed governor: coast the throttle once the tank is at its 55% top speed. See header. */
  private cappedInputs(): VehicleInputs {
    if (this.inputs.throttle <= 0) return this.inputs;
    if (this.vehicle.planarSpeed() < TANK_TOP_SPEED_MPS) return this.inputs;
    return { steer: this.inputs.steer, throttle: 0, brake: this.inputs.brake, handbrake: false };
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
      // Freeze the fire cycle where the barrel is; FX reads idle so the laser drops immediately.
      const tel = telegraphById.get(this.slot.id);
      if (tel) telegraphById.set(this.slot.id, IDLE_TELEGRAPH_AT(tel.barrelTip, tel.aimPoint));
      gameEvents.emit('unitWrecked', { unitKind: 'tank' });
    }
  }

  /** DEV/debug: this tank's fire-cycle + turret snapshot for the bridge readout. */
  debugFireState(): TankDebugState {
    return {
      id: this.slot.id,
      phase: this.fireState.phase,
      progress01: telegraphProgress01(this.fireState, this.simTime, FIRE_CFG),
      shotsFired: this.fireState.shotsFired,
      turretYaw: this.turret.yaw,
    };
  }

  // --- teardown -----------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    liveUnits.delete(this);
    turretYawById.delete(this.slot.id);
    telegraphById.delete(this.slot.id);
    unregisterEntity(this.colliderHandle);
    this.vehicle.dispose();
  }
}

/** Real Rapier mass override at `massFactor` × the reference chassis mass — verbatim copy of
 * armoredPolice.ts/gunTruck.ts's overrideChassisMass (the intentional small duplicate this unit
 * family keeps so each module stays independently spawnable). */
function overrideChassisMass(world: RapierWorld, colliderHandle: number, massFactor: number): void {
  const body = world.getCollider(colliderHandle)?.parent();
  if (!body) {
    if (import.meta.env.DEV) console.error('[tank] mass override: no body for collider');
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

export interface TankFactoryDeps {
  readonly world: RapierWorld;
  readonly rapier: RapierNamespace;
}

/** Build the tank UnitFactory bound to a live Rapier context — registered with the spawn director
 * (registerUnitFactory('tank', …)) by TankMesh's mount effect, mirroring createGunTruckFactory. */
export function createTankFactory(deps: TankFactoryDeps): UnitFactory {
  return (pose) => {
    try {
      return new TankUnit(deps.world, deps.rapier, pose);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[tank] failed to spawn tank unit:', err);
      return null;
    }
  };
}
