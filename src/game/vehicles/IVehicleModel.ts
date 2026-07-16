// The physics-bet isolation seam (TDD §7, part-1 Phase 3). Two implementations exist
// behind this interface: `raycastVehicle.ts` (primary — Rapier's
// DynamicRayCastVehicleController driven imperatively) and `arcadeBoxVehicle.ts`
// (fallback — dynamic cuboid + direct force/torque steering, built out only if the M1
// fun gate fails). Everything else (camera rig, car mesh, debug tools, future AI
// drivers in Phases 7/9+) talks ONLY to this interface so the M1 decision gate can swap
// models without touching consumers.

/** Matches game/input's DrivingInput shape — vehicle models must not import the input
 * system (AI drivers feed synthetic inputs through the same signature). */
export interface VehicleInputs {
  /** -1 (full left) .. 1 (full right) */
  readonly steer: number;
  /** 0..1 */
  readonly throttle: number;
  /** 0..1 */
  readonly brake: number;
  readonly handbrake: boolean;
}

export interface VehiclePose {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** Quaternion. */
  readonly rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
}

/** Per-wheel visual state. Wheel visuals are children of the chassis group, placed at
 * the VEHICLE_TUNING connection points and offset along -Y by suspensionLength. */
export interface WheelState {
  /** Radians. Steered wheels only; rear wheels stay 0. */
  steerAngle: number;
  /** Accumulated spin around the axle, radians (monotonic while rolling forward). */
  rotationAngle: number;
  /** Current suspension length in meters (rest length ± travel). */
  suspensionLength: number;
  inContact: boolean;
}

export interface VehicleState {
  /** Render pose: interpolated between physics steps (TDD §7) — what the camera and
   * any pose-reading visual MUST use, or they micro-jitter at speed. */
  pose: VehiclePose;
  /** Raw (non-interpolated) physics-step pose — for soak checks / teleport math. */
  rawPose: VehiclePose;
  /** Linear velocity, m/s (raw physics value). */
  velocity: { x: number; y: number; z: number };
  /** |velocity| convenience, m/s. */
  speed: number;
  /** Signed speed along the chassis forward axis (+ = driving forward), m/s. */
  forwardSpeed: number;
  /** True when the chassis up axis points within ~60° of world up. */
  upright: boolean;
  wheels: readonly WheelState[];
}

export interface IVehicleModel {
  /** Spawn the physics bodies at `pose`. Must be called before any other method. */
  create(pose: VehiclePose): void;
  /** Remove every physics resource this model created. Safe to call twice. */
  destroy(): void;
  /**
   * Feed one physics step's driving intent. Called from `useBeforePhysicsStep`
   * (TDD §6 frame order) with the fixed timestep dt (1/60).
   */
  applyInputs(inputs: VehicleInputs, dt: number): void;
  /**
   * Current vehicle state for visuals/camera/debug. Returns a reused, mutated-in-place
   * object (per-frame hot path — callers must copy anything they retain).
   */
  readState(): Readonly<VehicleState>;
  /** Teleport + zero velocities (dev reset keys, flip recovery, future run restarts). */
  reset(pose: VehiclePose): void;
}
