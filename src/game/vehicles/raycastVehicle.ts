// Primary vehicle model (TDD §7): Rapier's DynamicRayCastVehicleController, driven
// imperatively for a tuned toy-car-arcade feel. The chassis RigidBody + its collider are
// owned by React (PlayerVehicle.tsx renders them declaratively so @react-three/rapier's
// interpolation writes the render transform); this class only owns the *vehicle
// controller* + its wheels. See IVehicleModel for the isolation-seam rationale.
//
// Config split (what's set where, and why):
//   • Declarative JSX (PlayerVehicle): collider shape, collision groups, CCD, spawn pose.
//   • Structural, set once in create():  mass / center-of-mass / inertia (via additional
//     mass properties), wheel geometry (connection points, radius, rest length, axle,
//     suspension direction), and the up/forward axes. Changing any of these needs a
//     remount, NOT a live leva tweak — they define the rig, not its feel.
//   • Live, re-read fresh every physics step in applyInputs(): damping, suspension
//     stiffness/damping/travel, wheel friction, engine/brake/steer forces, downforce.
//     VEHICLE_TUNING is mutated in place by the dev panel, so these MUST be read fresh
//     each call (never cached at module/create scope) to stay leva-tunable.
//
// Drivetrain: REAR-WHEEL DRIVE. The whole handbrake mechanic is "drop rear friction to
// slide" (TDD §7); driving the rear wheels makes throttle-on and handbrake slides read as
// oversteer, which is the arcade feel we want. The strong self-stabilizers (high angular
// damping, dropped COM, speed-scaled downforce) tame RWD's spin-out tendency. If launches
// feel weak in the fun-gate session, switch to AWD by also driving the front wheels.

import { Object3D, Quaternion, Vector3 } from 'three';
import type { RapierContext, RapierCollider, RapierRigidBody } from '@react-three/rapier';
import type { IVehicleModel, VehicleInputs, VehiclePose, VehicleState } from './IVehicleModel';
import { CollisionGroup } from '../config/collision';
import { STARTER_TOP_SPEED, VEHICLE_TUNING } from '../config/vehicles';
import { nextSteerAngle, throttleGovernor } from './steering';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];
type VehicleController = ReturnType<RapierWorld['createVehicleController']>;

export interface RaycastVehicleDeps {
  readonly world: RapierWorld;
  /** RAPIER namespace from useRapier(). Part of the standard deps handshake; reserved for
   * Phase 6+ ray-based damage/query work — the vehicle model itself doesn't need it yet. */
  readonly rapier: RapierNamespace;
  /** Chassis RigidBody handle (React-owned). Must already carry exactly one collider. */
  readonly body: RapierRigidBody;
  /** three.js group inside the RigidBody — carries the interpolated render transform. */
  readonly object: Object3D;
}

// Wheel index layout. Front wheels steer; rear wheels are driven and take the handbrake.
const FRONT_LEFT = 0;
const FRONT_RIGHT = 1;
const REAR_LEFT = 2;
const REAR_RIGHT = 3;
const WHEEL_COUNT = 4;
const STEERED_WHEELS = [FRONT_LEFT, FRONT_RIGHT] as const;
const DRIVEN_WHEELS = [REAR_LEFT, REAR_RIGHT] as const;

// Chassis axes for the controller (0 = X, 1 = Y, 2 = Z). Y up, Z forward → the car's right
// is -X (three.js is right-handed: facing -Z puts +X on your right, so facing +Z flips it).
// A positive setWheelSteering() is a positive rotation about +Y, which points the wheels
// toward +X — the car's LEFT. DrivingInput.steer is +1 = right, so the angle is NEGATED at
// the setWheelSteering() call. Measured, not theorized: with the sign unflipped, W+D bends
// the path toward +X / CCW-from-above (position trace, 2026-07-16 gate-response session).
const UP_AXIS = 1;
const FORWARD_AXIS = 2;

// Suspension rays cast straight down; wheels spin about the -X axle. The axle SIGN only
// affects side-friction handedness (visual roll is integrated from forward speed below), so
// if lateral grip feels inverted in the fun-gate session, flip this to +X.
const SUSPENSION_DIR = { x: 0, y: -1, z: 0 } as const;
const WHEEL_AXLE = { x: -1, y: 0, z: 0 } as const;

const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 } as const;
const ZERO_VEC = { x: 0, y: 0, z: 0 } as const;

// Wheel-ray filter: hit ONLY colliders in the GROUND membership group. This is the known
// Rapier footgun (TDD §15) — without it the wheels ray-cast against their own chassis and
// the suspension explodes. Packed as Rapier InteractionGroups (membership << 16 | filter):
// a PLAYER-membership ray whose filter is GROUND is compatible only with GROUND colliders,
// so the chassis (PLAYER), buildings, and props are all excluded. Derived from the shared
// collision-group config — not a magic number.
const WHEEL_RAY_FILTER_GROUPS = (CollisionGroup.PLAYER << 16) | CollisionGroup.GROUND;

interface MutablePose {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
}

interface MutableWheelState {
  steerAngle: number;
  rotationAngle: number;
  suspensionLength: number;
  inContact: boolean;
}

interface MutableVehicleState {
  pose: MutablePose;
  rawPose: MutablePose;
  velocity: { x: number; y: number; z: number };
  speed: number;
  forwardSpeed: number;
  upright: boolean;
  wheels: MutableWheelState[];
}

function makeState(): MutableVehicleState {
  const wheels: MutableWheelState[] = [];
  for (let i = 0; i < WHEEL_COUNT; i++) {
    wheels.push({ steerAngle: 0, rotationAngle: 0, suspensionLength: 0, inContact: false });
  }
  return {
    pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    rawPose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    velocity: { x: 0, y: 0, z: 0 },
    speed: 0,
    forwardSpeed: 0,
    upright: true,
    wheels,
  };
}

export class RaycastVehicle implements IVehicleModel {
  private readonly world: RapierWorld;
  private readonly body: RapierRigidBody;
  private readonly object: Object3D;

  private controller: VehicleController | null = null;
  private chassisColliderHandle = -1;

  // Steering + wheel-spin bookkeeping (per-instance; reset by reset()).
  private steerAngle = 0;
  private readonly wheelSpin: number[] = new Array<number>(WHEEL_COUNT).fill(0);

  // Reused scratch + state — readState() returns a single mutated object (hot path).
  private readonly state = makeState();
  private readonly tmpVec = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly tmpForward = new Vector3();
  private readonly tmpUp = new Vector3();
  // Chassis-only predicate: belt-and-suspenders alongside the group filter above, so a
  // future world that mis-tags a collider can never make the wheels ray-hit the chassis.
  private readonly excludeChassis = (collider: RapierCollider): boolean =>
    collider.handle !== this.chassisColliderHandle;

  constructor(deps: RaycastVehicleDeps) {
    this.world = deps.world;
    this.body = deps.body;
    this.object = deps.object;
  }

  create(pose: VehiclePose): void {
    if (this.controller) this.destroy(); // idempotent re-create

    const { chassis, suspension, wheels } = VEHICLE_TUNING;

    // Place the (React-owned) body authoritatively at the spawn pose, at rest.
    this.body.setTranslation(pose.position, true);
    this.body.setRotation(pose.rotation, true);
    this.body.setLinvel(ZERO_VEC, true);
    this.body.setAngvel(ZERO_VEC, true);

    // Mass / COM / inertia. The collider is spawned zero-density (PlayerVehicle), so ALL of
    // the body's mass comes from these additional properties — giving us an exact mass and a
    // deliberately dropped center of mass (comYOffset < 0) as the arcade anti-flip.
    const { halfWidth: hw, halfHeight: hh, halfLength: hl, massKg: m, comYOffset } = chassis;
    const inertia = {
      x: (m / 3) * (hh * hh + hl * hl),
      y: (m / 3) * (hw * hw + hl * hl),
      z: (m / 3) * (hw * hw + hh * hh),
    };
    this.body.setAdditionalMassProperties(m, { x: 0, y: comYOffset, z: 0 }, inertia, IDENTITY_QUAT, true);

    const controller = this.world.createVehicleController(this.body);
    controller.indexUpAxis = UP_AXIS;
    // NOTE: the rapier3d-compat typing names the forward-axis setter `setIndexForwardAxis`
    // (a binding quirk — the getter is `indexForwardAxis`). Assigning to it sets the axis.
    controller.setIndexForwardAxis = FORWARD_AXIS;

    const connections = this.wheelConnections();
    for (let i = 0; i < WHEEL_COUNT; i++) {
      controller.addWheel(connections[i], SUSPENSION_DIR, WHEEL_AXLE, suspension.restLength, wheels.radius);
      // Structural per-wheel params set once; the live-tunable ones are re-applied each step.
      controller.setWheelMaxSuspensionTravel(i, suspension.maxTravel);
    }

    this.controller = controller;
    this.chassisColliderHandle = this.body.collider(0).handle;
    this.steerAngle = 0;
    this.wheelSpin.fill(0);

    // Seed live params so a paused GARAGE preview already sits on its suspension correctly.
    this.applyLiveWheelParams(false);
  }

  applyInputs(inputs: VehicleInputs, dt: number): void {
    const controller = this.controller;
    if (!controller) return;

    const { engine, stability, wheels } = VEHICLE_TUNING;

    // Damping is re-applied every step so the fun-gate session can scrub the main arcade
    // stabilizer (angular damping) live.
    this.body.setLinearDamping(stability.linearDamping);
    this.body.setAngularDamping(stability.angularDamping);

    this.applyLiveWheelParams(inputs.handbrake);

    // Speeds from the raw (pre-step) velocity + orientation.
    const linvel = this.body.linvel();
    const speed = Math.hypot(linvel.x, linvel.y, linvel.z);
    const forwardSpeed = this.forwardSpeed(linvel);

    // Steering (front wheels only). While clearly reversing, the input sign flips so the
    // heading follows the pressed arrow (steering.invertInReverse — arcade convention;
    // see the config comment). The brakeToReverseSpeed deadband keeps the sign stable
    // around 0 so crawling/stopping never oscillates the steer target.
    const reversing =
      VEHICLE_TUNING.steering.invertInReverse && forwardSpeed < -engine.brakeToReverseSpeed;
    this.steerAngle = nextSteerAngle(
      this.steerAngle,
      reversing ? -inputs.steer : inputs.steer,
      speed,
      STARTER_TOP_SPEED,
      VEHICLE_TUNING.steering,
      dt,
    );
    // Negated: positive steer input means turn right, but positive wheel steering is a +Y
    // rotation toward the car's left (see the axes comment at the top of this file).
    for (const i of STEERED_WHEELS) controller.setWheelSteering(i, -this.steerAngle);

    // Throttle / brake / reverse.
    let engineForce = 0;
    let brake = 0;
    if (inputs.throttle > 0) {
      engineForce = engine.maxForce * inputs.throttle * throttleGovernor(forwardSpeed, STARTER_TOP_SPEED);
    }
    if (inputs.brake > 0) {
      if (forwardSpeed > engine.brakeToReverseSpeed) {
        // Still rolling forward → the brake pedal brakes.
        brake = engine.brakeForce * inputs.brake;
      } else if (-forwardSpeed < STARTER_TOP_SPEED * engine.reverseSpeedCapPct) {
        // Stopped / already reversing and below the reverse cap → drive backward.
        engineForce = -engine.reverseForce * inputs.brake;
      }
      // else: at the reverse-speed cap → coast (no force), so reverse never runs away.
    }

    for (let i = 0; i < WHEEL_COUNT; i++) controller.setWheelBrake(i, brake);
    for (const i of DRIVEN_WHEELS) controller.setWheelEngineForce(i, engineForce);
    if (inputs.handbrake) {
      for (const i of DRIVEN_WHEELS) controller.setWheelBrake(i, brake + engine.handbrakeForce);
    }

    // Mild speed-scaled downforce (world -Y), as an impulse so it never accumulates on the
    // body's persistent-force channel (Rapier's addForce would).
    const downforce = stability.downforcePerSpeed * speed * dt;
    if (downforce > 0) this.body.applyImpulse({ x: 0, y: -downforce, z: 0 }, true);

    controller.updateVehicle(dt, undefined, WHEEL_RAY_FILTER_GROUPS, this.excludeChassis);

    // Integrate visual wheel spin from forward speed (monotonic while rolling forward). Rear
    // wheels freeze while the handbrake locks them — a cheap, satisfying skid detail.
    const spinStep = (forwardSpeed / wheels.radius) * dt;
    for (let i = 0; i < WHEEL_COUNT; i++) {
      const locked = inputs.handbrake && (i === REAR_LEFT || i === REAR_RIGHT);
      if (!locked) this.wheelSpin[i] += spinStep;
    }
  }

  readState(): Readonly<VehicleState> {
    const controller = this.controller;
    const s = this.state;
    if (!controller) return s;

    // Render pose: interpolated world transform off the R3F group (TDD §7 — the camera and
    // any pose-reading visual MUST use this, not the raw physics pose, or it jitters).
    this.object.getWorldPosition(this.tmpVec);
    this.object.getWorldQuaternion(this.tmpQuat);
    s.pose.position.x = this.tmpVec.x;
    s.pose.position.y = this.tmpVec.y;
    s.pose.position.z = this.tmpVec.z;
    s.pose.rotation.x = this.tmpQuat.x;
    s.pose.rotation.y = this.tmpQuat.y;
    s.pose.rotation.z = this.tmpQuat.z;
    s.pose.rotation.w = this.tmpQuat.w;

    // Raw physics pose (teleport math / soak checks).
    const t = this.body.translation();
    const r = this.body.rotation();
    s.rawPose.position.x = t.x;
    s.rawPose.position.y = t.y;
    s.rawPose.position.z = t.z;
    s.rawPose.rotation.x = r.x;
    s.rawPose.rotation.y = r.y;
    s.rawPose.rotation.z = r.z;
    s.rawPose.rotation.w = r.w;

    const v = this.body.linvel();
    s.velocity.x = v.x;
    s.velocity.y = v.y;
    s.velocity.z = v.z;
    s.speed = Math.hypot(v.x, v.y, v.z);
    s.forwardSpeed = this.forwardSpeed(v);

    // upright: chassis up · world up > 0.5 (within ~60° of vertical).
    this.tmpQuat.set(r.x, r.y, r.z, r.w);
    this.tmpUp.set(0, 1, 0).applyQuaternion(this.tmpQuat);
    s.upright = this.tmpUp.y > 0.5;

    for (let i = 0; i < WHEEL_COUNT; i++) {
      const w = s.wheels[i];
      w.steerAngle = controller.wheelSteering(i) ?? 0;
      w.rotationAngle = this.wheelSpin[i];
      w.suspensionLength = controller.wheelSuspensionLength(i) ?? VEHICLE_TUNING.suspension.restLength;
      w.inContact = controller.wheelIsInContact(i);
    }

    return s;
  }

  reset(pose: VehiclePose): void {
    this.body.setTranslation(pose.position, true);
    this.body.setRotation(pose.rotation, true);
    this.body.setLinvel(ZERO_VEC, true);
    this.body.setAngvel(ZERO_VEC, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);

    this.steerAngle = 0;
    this.wheelSpin.fill(0);
    const controller = this.controller;
    if (controller) {
      for (let i = 0; i < WHEEL_COUNT; i++) {
        controller.setWheelSteering(i, 0);
        controller.setWheelEngineForce(i, 0);
        controller.setWheelBrake(i, 0);
      }
    }
  }

  destroy(): void {
    if (!this.controller) return; // idempotent
    this.world.removeVehicleController(this.controller);
    this.controller = null;
    // The chassis body + collider are React-owned — never removed here.
  }

  /** Chassis-local wheel connection points, ordered [FL, FR, RL, RR]. +X = right. */
  private wheelConnections(): { x: number; y: number; z: number }[] {
    const { halfTrack, frontZ, rearZ, connectionY } = VEHICLE_TUNING.wheels;
    return [
      { x: -halfTrack, y: connectionY, z: frontZ }, // front-left
      { x: halfTrack, y: connectionY, z: frontZ }, // front-right
      { x: -halfTrack, y: connectionY, z: rearZ }, // rear-left
      { x: halfTrack, y: connectionY, z: rearZ }, // rear-right
    ];
  }

  /** Re-apply the leva-live suspension + friction params (read fresh each step). */
  private applyLiveWheelParams(handbrake: boolean): void {
    const controller = this.controller;
    if (!controller) return;
    const { suspension, wheels, engine } = VEHICLE_TUNING;
    for (let i = 0; i < WHEEL_COUNT; i++) {
      controller.setWheelSuspensionStiffness(i, suspension.stiffness);
      controller.setWheelSuspensionCompression(i, suspension.compressionDamping);
      controller.setWheelSuspensionRelaxation(i, suspension.relaxationDamping);
      controller.setWheelMaxSuspensionForce(i, suspension.maxForce);
      controller.setWheelMaxSuspensionTravel(i, suspension.maxTravel);
      controller.setWheelSideFrictionStiffness(i, wheels.sideFrictionStiffness);
      // Handbrake drops REAR friction (the slide). Recomputed from config each step, so it
      // restores exactly on release with no drift.
      const rear = i === REAR_LEFT || i === REAR_RIGHT;
      const frictionMul = rear && handbrake ? engine.handbrakeRearFrictionMul : 1;
      controller.setWheelFrictionSlip(i, wheels.frictionSlip * frictionMul);
    }
  }

  /** Signed speed along the chassis forward (+Z) axis. */
  private forwardSpeed(linvel: { x: number; y: number; z: number }): number {
    const r = this.body.rotation();
    this.tmpQuat.set(r.x, r.y, r.z, r.w);
    this.tmpForward.set(0, 0, 1).applyQuaternion(this.tmpQuat);
    return linvel.x * this.tmpForward.x + linvel.y * this.tmpForward.y + linvel.z * this.tmpForward.z;
  }
}

/** Factory mirroring the `arcadeBoxVehicle` fallback's shape (TDD §7 decision gate). */
export function createRaycastVehicle(deps: RaycastVehicleDeps): IVehicleModel {
  return new RaycastVehicle(deps);
}
