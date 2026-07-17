// ★3 SWAT SUV (Phase 10 Task 2; TDD §5.6 "SWAT SUV": 120 HP, 1.8× mass, 100% top speed,
// flanking box-in + the roster's hardest ram). Mirrors ai/units/policeSedan.ts's structure
// (unit class implementing UnitHandle, module-scope tick list, factory the mesh registers) —
// see that file's header for the shared mechanism. Only what's different is documented here.
//
// --- steering: live flank wiring (Task 1 dependency, landed) -------------------------------
// TDD §5.6 gives SWAT `behavior: 'flank'` (ENEMY_UNITS.swat) — claimed units box the player in
// at ±30° offsets while unclaimed units ram. That coordination is ai/squad.ts's job (Phase 10
// Task 1, run in parallel with this task and explicitly out of this task's file scope: "Do NOT
// touch: squad/aiSteering (T1)"). ai/squad.ts did not exist when this module's first draft was
// written; it has since landed with exactly the consumer API its own header calls out for this
// module — ai/squadCoordinator.ts's `getSquadTargetForUnit(unitId)` ("SWAT units (Phase 10 Task
// 2, built in parallel) call getSquadTargetForUnit(theirSlotId) in think(); a non-null target →
// steer in aiSteering 'flank' mode toward it, null → ram (pursue)") and aiSteering.pursueSteer's
// new `mode`/`flankTarget` params — so this module now consumes both (read-only; no edits to
// either Task-1 file) instead of the pursue-only placeholder its first draft shipped with.

import type { RapierContext } from '@react-three/rapier';
import { AI_STEERING, ENEMY_UNITS, SPAWN, VEHICLE_TUNING } from '../../config';
import { gameEvents } from '../../state/events';
import { getEntity, registerEntity, unregisterEntity } from '../../world/registry';
import { playerVehicle } from '../../vehicles/playerRef';
import type { VehicleInputs } from '../../vehicles/IVehicleModel';
import { PursuitVehicle } from '../pursuitVehicle';
import { initialStuckState, pursueSteer, type StuckState } from '../aiSteering';
import { getSquadTargetForUnit } from '../squadCoordinator';
import type { UnitFactory, UnitHandle, UnitSlot } from '../pursuitTypes';
import { nextPursuitSlotId } from './slotIds';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

const PHYSICS_STEP_SEC = 1 / 60;
const AI_TICK_DT = 1 / SPAWN.aiTickHz;

const SWAT = ENEMY_UNITS.swat;
const SWAT_TOP_SPEED_SCALE = SWAT.topSpeedPct / 100;

const IDLE_INPUTS: VehicleInputs = { steer: 0, throttle: 0, brake: 0, handbrake: false };

// ===========================================================================================
// Per-step tick list (module scope — mirrors policeSedan.ts's own, separate list; see
// armoredPolice.ts's header for why each kind currently drives its own step hooks).
// ===========================================================================================

interface PursuitStepUnit {
  applyStep(dt: number): void;
  syncSlot(): void;
}

const liveUnits = new Set<PursuitStepUnit>();

/** useBeforePhysicsStep driver (SwatMesh): apply every live unit's cached inputs. */
export function stepSwatBefore(dt: number): void {
  for (const u of liveUnits) u.applyStep(dt);
}

/** useAfterPhysicsStep driver (SwatMesh): copy pose + run wreck detection. */
export function stepSwatAfter(): void {
  for (const u of liveUnits) u.syncSlot();
}

/** Test/debug: live SWAT-body count in the tick list. */
export function liveSwatCount(): number {
  return liveUnits.size;
}

// ===========================================================================================
// SWAT unit
// ===========================================================================================

class SwatUnit implements UnitHandle, PursuitStepUnit {
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
    this.colliderHandle = this.vehicle.spawn(pose, SWAT_TOP_SPEED_SCALE);
    // 1.8× mass (=2160 kg) is a REAL Rapier mass override, mirroring armoredPolice.ts's
    // overrideChassisMass — SWAT should out-muscle a police sedan on contact too, not just
    // score heavier in the damage formula. Kept as a tiny local copy rather than importing
    // armoredPolice.ts (this module must stay independently spawnable/disposable; the two
    // units share no runtime state) — same formula as raycastVehicle.ts's create().
    overrideChassisMass(world, this.colliderHandle, SWAT.massFactor);

    registerEntity(this.colliderHandle, {
      kind: 'pursuit',
      districtId: -1,
      hp: SWAT.hp,
      unitKind: 'swat',
    });

    this.slot = {
      // Shared, globally-unique counter (slotIds.ts) — see that file's header for why a
      // per-module counter collides once multiple kinds are live together.
      id: nextPursuitSlotId(),
      kind: 'swat',
      state: 'pursuing',
      x: pose.x,
      y: 0,
      z: pose.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      hp: SWAT.hp,
      behaviorLabel: 'pursue',
    };
    this.vehicle.writePose(this.slot);

    liveUnits.add(this);
  }

  // --- 10 Hz decision (director-driven, staggered) -------------------------------------------

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
    // Live squad claim (ai/squadCoordinator.ts, Task 1): a non-null target means this unit
    // (by its own stable slot id — the same id the coordinator's collectSwatCandidates()
    // reads off unitsRef) currently holds a flank slot, so it steers in 'flank' mode toward
    // that world point instead of the player. An unclaimed unit gets null back and pursueSteer
    // defaults to plain 'pursue' (ram-capable) — exactly the file header's claimed→flank /
    // unclaimed→ram contract.
    const flankTarget = getSquadTargetForUnit(this.slot.id);
    const result = pursueSteer(
      pose,
      speed,
      { x: player.rawPose.position.x, z: player.rawPose.position.z },
      { x: player.velocity.x, z: player.velocity.z },
      hits,
      this.stuck,
      AI_STEERING,
      AI_TICK_DT,
      flankTarget !== null ? 'flank' : 'pursue',
      flankTarget,
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
      gameEvents.emit('unitWrecked', { unitKind: 'swat' });
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

/** Real Rapier mass override at `massFactor` × the reference chassis mass — see
 * armoredPolice.ts's overrideChassisMass (this is an intentional small duplicate, not a
 * shared import; see this file's constructor comment). */
function overrideChassisMass(world: RapierWorld, colliderHandle: number, massFactor: number): void {
  const body = world.getCollider(colliderHandle)?.parent();
  if (!body) {
    if (import.meta.env.DEV) console.error('[swatSuv] mass override: no body for collider');
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

export interface SwatFactoryDeps {
  readonly world: RapierWorld;
  readonly rapier: RapierNamespace;
}

/** Build the SWAT UnitFactory bound to a live Rapier context — registered with the spawn
 * director (registerUnitFactory('swat', …)) by SwatMesh's mount effect, mirroring
 * policeSedan.ts's createPoliceFactory. */
export function createSwatFactory(deps: SwatFactoryDeps): UnitFactory {
  return (pose) => {
    try {
      return new SwatUnit(deps.world, deps.rapier, pose);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[swatSuv] failed to spawn swat unit:', err);
      return null;
    }
  };
}
