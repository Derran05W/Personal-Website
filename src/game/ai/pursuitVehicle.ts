// Imperative pursuit chassis (Phase 9 Task 2). The physical body every pursuit unit drives.
//
// CONTROLLER-REUSE VERDICT: this REUSES vehicles/raycastVehicle.ts's RaycastVehicle verbatim —
// the same tuned 4-wheel raycast-suspension model the M1 fun gate signed off, so police get the
// exact "toy-car bouncy" feel the TDD §5.6 calls for (police are "bouncy"). RaycastVehicle only
// ever touches its deps' {world, rapier, body, object}: `body` is any RigidBody carrying exactly
// one collider (it needn't be React-owned — PlayerVehicle's is, but nothing in the class assumes
// so), and `object` is used ONLY by readState().pose to read an INTERPOLATED render transform.
// Pursuit units render from the slot pose (writePose below, raw body transform — exactly how
// TrafficMesh renders dynamic civilians), so we pass a throwaway Object3D that never enters the
// scene graph and simply never call readState().pose. Everything else (create/applyInputs/
// destroy, mass/COM/inertia, wheel rays, fall-through safety) is reused unchanged.
//
// The ONE thing the shared class hardcodes against reuse is top speed: applyInputs() governs
// engine force to zero at the module constant STARTER_TOP_SPEED. Police want 105% (ENEMY_UNITS.
// police.topSpeedPct). Rather than fork the class or edit a player-vehicle file (both off-limits
// / risky to the signed-off feel), the >100% cap is delivered by a small supplemental forward
// impulse applied HERE, only in the (STARTER_TOP_SPEED, topSpeed) band, tapering to zero at the
// cap so it can never run away (AI_STEERING.overdriveGain; set 0 to disable → exact 100%).
//
// Mass: police are massFactor 1.0 = 1200 kg = VEHICLE_TUNING.chassis.massKg, which RaycastVehicle
// applies verbatim in create() — so reuse yields the correct police mass with no override. A
// heavier Part 4 unit (armored/tank) will need a mass path (parameterize the controller or add a
// setAdditionalMassProperties override after create); documented for that phase, out of scope here.

import { Object3D, Quaternion, Vector3 } from 'three';
import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { RaycastVehicle } from '../vehicles/raycastVehicle';
import type { VehicleInputs } from '../vehicles/IVehicleModel';
import {
  AI_STEERING,
  CollisionGroup,
  interactionGroups,
  STARTER_TOP_SPEED,
  VEHICLE_TUNING,
} from '../config';
import type { AvoidHits } from './aiSteering';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

const PURSUIT_GROUPS = interactionGroups('PURSUIT');

// Avoidance rays hit ONLY BUILDING|PROP_STATIC (chasing through parks / dynamic debris is
// intentional — TDD §5.6). Rapier u32: membership PURSUIT (so both targets, whose own filters
// include VEHICLES, accept the ray), filter = exactly those two target memberships. Self is
// excluded per-cast via filterExcludeRigidBody. Same construction as traffic's BLOCK_RAY_GROUPS.
const AVOID_RAY_GROUPS =
  (CollisionGroup.PURSUIT << 16) | (CollisionGroup.BUILDING | CollisionGroup.PROP_STATIC);

// Spawn ride height (m): a hair above the ~0.837 m settle height so the wheel rays engage and
// the suspension takes over without a drop (mirrors PlayerVehicle's default [0,1,0]).
const SPAWN_Y = 1.0;
const DEG2RAD = Math.PI / 180;

export interface PursuitVehicleDeps {
  readonly world: RapierWorld;
  readonly rapier: RapierNamespace;
}

export interface PursuitPose {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

/** Slot pose target — the mutable fields writePose fills (a UnitSlot satisfies this). */
export interface PoseSink {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export class PursuitVehicle {
  private readonly world: RapierWorld;
  private readonly rapier: RapierNamespace;

  private body: RapierRigidBody | null = null;
  private model: RaycastVehicle | null = null;
  private colliderHandle = -1;
  private topSpeed = STARTER_TOP_SPEED;

  // Throwaway render object for RaycastVehicle's interpolation reads — never in the scene graph,
  // never read (we writePose from the raw body transform instead). One per chassis.
  private readonly renderObject = new Object3D();

  // Hot-path scratch — no per-step / per-cast allocation.
  private readonly tmpQuat = new Quaternion();
  private readonly tmpForward = new Vector3();
  private readonly rayOrigin = { x: 0, y: 0, z: 0 };
  private readonly rayDir = { x: 0, y: 0, z: 0 };
  private readonly ray: InstanceType<RapierNamespace['Ray']>;

  constructor(deps: PursuitVehicleDeps) {
    this.world = deps.world;
    this.rapier = deps.rapier;
    this.ray = new deps.rapier.Ray(this.rayOrigin, this.rayDir);
  }

  /**
   * Create the dynamic chassis (one zero-density cuboid collider, PURSUIT groups, CCD) at the
   * spawn pose and wrap it in a RaycastVehicle. `topSpeedScale` (>1 = faster than the starter)
   * sets the overdrive cap. Returns the collider handle so the unit can register it. */
  spawn(pose: PursuitPose, topSpeedScale: number): number {
    const q = quatFromYaw(pose.yaw);
    const bodyDesc = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(pose.x, SPAWN_Y, pose.z)
      .setRotation(q)
      .setCcdEnabled(true)
      .setCanSleep(false);
    const body = this.world.createRigidBody(bodyDesc);

    const c = VEHICLE_TUNING.chassis;
    // Zero density: RaycastVehicle.create() sets the full mass / dropped COM / inertia via
    // additional mass properties (exactly as for the player), so all mass comes from there.
    // No CONTACT_FORCE_EVENTS flag: player↔unit rams are already captured by the PLAYER body's
    // onContactForce (combat/contacts.ts) — which resolves BOTH sides through the registry, so
    // the unit takes ram damage too — and unit↔prop/building/unit impacts aren't part of v1
    // damage, so the unit needs no event flag of its own.
    const colDesc = this.rapier.ColliderDesc.cuboid(c.halfWidth, c.halfHeight, c.halfLength)
      .setDensity(0)
      .setCollisionGroups(PURSUIT_GROUPS);
    const collider = this.world.createCollider(colDesc, body);

    this.body = body;
    this.colliderHandle = collider.handle;
    this.topSpeed = STARTER_TOP_SPEED * topSpeedScale;

    const model = new RaycastVehicle({
      world: this.world,
      rapier: this.rapier,
      body,
      object: this.renderObject,
    });
    model.create({ position: { x: pose.x, y: SPAWN_Y, z: pose.z }, rotation: q });
    this.model = model;

    return collider.handle;
  }

  /** Feed one physics step's cached inputs to the reused controller, then apply the top-speed
   * overdrive (see file header). Called every fixed step from the pursuit runtime's before-hook. */
  applyStep(inputs: VehicleInputs, dt: number): void {
    const model = this.model;
    const body = this.body;
    if (!model || !body) return;

    model.applyInputs(inputs, dt);

    // Extra anti-launch downforce (world −Y), applied as an impulse so it never accumulates on
    // the body's persistent-force channel (same discipline as the controller's own downforce).
    // Keeps pursuit units planted under the AI's flat-out cornering — pursuit-only, never the
    // player. Uses planar speed so it scales with how fast the unit is actually travelling.
    if (AI_STEERING.downforcePerSpeed > 0) {
      const v = body.linvel();
      const down = AI_STEERING.downforcePerSpeed * Math.hypot(v.x, v.z) * dt;
      if (down > 0) body.applyImpulse({ x: 0, y: -down, z: 0 }, true);
    }

    if (inputs.throttle > 0 && this.topSpeed > STARTER_TOP_SPEED && AI_STEERING.overdriveGain > 0) {
      const fwd = this.signedForwardSpeed();
      if (fwd > STARTER_TOP_SPEED && fwd < this.topSpeed) {
        const taper = (this.topSpeed - fwd) / (this.topSpeed - STARTER_TOP_SPEED); // 1 → 0
        const impulse =
          VEHICLE_TUNING.engine.maxForce * inputs.throttle * AI_STEERING.overdriveGain * taper * dt;
        this.forwardVector(this.tmpForward);
        body.applyImpulse(
          { x: this.tmpForward.x * impulse, y: 0, z: this.tmpForward.z * impulse },
          true,
        );
      }
    }
  }

  /** Planar pose (x, z, yaw) from the raw body transform — steering input. */
  readPlanarPose(): PursuitPose {
    const body = this.body;
    if (!body) return { x: 0, z: 0, yaw: 0 };
    const t = body.translation();
    this.forwardVector(this.tmpForward);
    return { x: t.x, z: t.z, yaw: Math.atan2(this.tmpForward.x, this.tmpForward.z) };
  }

  /** Planar (XZ) speed magnitude, m/s — for stuck detection. */
  planarSpeed(): number {
    const body = this.body;
    if (!body) return 0;
    const v = body.linvel();
    return Math.hypot(v.x, v.z);
  }

  /** Chassis "uprightness": world +Y rotated by the body quaternion, dotted with world +Y
   * (1 level, 0 on its side, −1 inverted) — wreck-by-flip detection. */
  upDot(): number {
    const body = this.body;
    if (!body) return 1;
    const r = body.rotation();
    // 1 − 2(qx² + qz²) is (R·[0,1,0])·[0,1,0] for a unit quaternion.
    return 1 - 2 * (r.x * r.x + r.z * r.z);
  }

  /** Write the raw body transform into a slot-shaped sink (render + proximity reads). */
  writePose(out: PoseSink): void {
    const body = this.body;
    if (!body) return;
    const t = body.translation();
    const r = body.rotation();
    out.x = t.x;
    out.y = t.y;
    out.z = t.z;
    out.qx = r.x;
    out.qy = r.y;
    out.qz = r.z;
    out.qw = r.w;
  }

  /** Cast the three forward avoidance rays (center / ±avoidAngle) and return hit fractions
   * (1 = clear). Masked to BUILDING|PROP_STATIC; self excluded. Uses the current heading. */
  castAvoidHits(pose: PursuitPose): AvoidHits {
    const a = AI_STEERING.avoidAngleDeg * DEG2RAD;
    return {
      center: this.castRayFraction(pose, 0),
      left: this.castRayFraction(pose, -a),
      right: this.castRayFraction(pose, +a),
    };
  }

  get handle(): number {
    return this.colliderHandle;
  }

  /** Full teardown: drop the vehicle controller, then remove the body (its collider goes with
   * it). Idempotent. */
  dispose(): void {
    this.model?.destroy(); // removes the vehicle controller only
    this.model = null;
    if (this.body) this.world.removeRigidBody(this.body); // removes body + attached collider
    this.body = null;
    this.colliderHandle = -1;
  }

  // --- internals ----------------------------------------------------------------------------

  private castRayFraction(pose: PursuitPose, yawOffset: number): number {
    const body = this.body;
    if (!body) return 1;
    const yaw = pose.yaw + yawOffset;
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    const ahead = AI_STEERING.avoidRayOriginAheadM;
    this.rayOrigin.x = pose.x + dirX * ahead;
    this.rayOrigin.y = AI_STEERING.avoidRayHeightM;
    this.rayOrigin.z = pose.z + dirZ * ahead;
    this.rayDir.x = dirX;
    this.rayDir.y = 0;
    this.rayDir.z = dirZ;
    const len = AI_STEERING.avoidRayLenM;
    const hit = this.world.castRay(this.ray, len, true, undefined, AVOID_RAY_GROUPS, undefined, body);
    if (hit === null) return 1;
    const frac = hit.timeOfImpact / len;
    return frac < 0 ? 0 : frac > 1 ? 1 : frac;
  }

  private forwardVector(out: Vector3): Vector3 {
    const body = this.body;
    if (!body) return out.set(0, 0, 1);
    const r = body.rotation();
    this.tmpQuat.set(r.x, r.y, r.z, r.w);
    return out.set(0, 0, 1).applyQuaternion(this.tmpQuat);
  }

  private signedForwardSpeed(): number {
    const body = this.body;
    if (!body) return 0;
    const v = body.linvel();
    this.forwardVector(this.tmpForward);
    return v.x * this.tmpForward.x + v.y * this.tmpForward.y + v.z * this.tmpForward.z;
  }
}

/** Unit quaternion for a yaw rotation about +Y (matches ai/traffic.ts quatFromYaw). */
function quatFromYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  const h = yaw * 0.5;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}
