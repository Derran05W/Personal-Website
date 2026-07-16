// Handbrake skid marks (Phase 3 juice). A single pooled InstancedMesh of flat ground
// quads: while the handbrake is held and a rear wheel is sliding on the flat slab, each
// rear wheel drops fixed-length rubber segments behind it. Runs in a plain priority-0
// useFrame (before core/frameOrder.tsx's priority-1 camera pass that owns the render) —
// this system only writes instance buffers, it never touches rendering or priorities.
//
// THE NO-TRANSPARENCY FADE TRICK: marks age out by lerping their per-instance colour from
// fresh rubber toward the ground colour over SKID.fadeSeconds, then hide (scale 0). Because
// a fully-faded quad is exactly the ground colour it sits on, it visually vanishes with NO
// alpha channel — so the mesh is fully opaque and we pay zero blending or depth-sort cost
// for 512 overlapping decals. Colour rides three's built-in instanceColor buffer; the
// material is MeshStandardMaterial (roughness 1 / metalness 0, matching TestPlane's slab)
// so a mark takes the same lighting as the ground and the faded end truly disappears.
//
// HOT-PATH DISCIPLINE: all working vectors/quaternions/matrices/colours are module-scope
// scratch, reused every frame — the useFrame body allocates nothing. Ring-buffer + per-mark
// age live in a per-mount ref. instanceMatrix / instanceColor get needsUpdate=true only on
// the frames something actually changed.
//
// GROUND ASSUMPTION: quads are pinned to the y=0 plane (position y = SKID.yOffset, always
// flat, +Y normal). That's correct for this phase's flat test slab only; marks on the test
// ramp — and any real sloped/curved surface — are skipped by the flat-ground guard below.
// Proper surface-projected decals are a Phase 16 problem.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  DynamicDrawUsage,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import { SKID, VEHICLE_TUNING } from '../config';
import { getDrivingInput } from '../input';
import { playerVehicle } from '../vehicles/playerRef';
import { computeSkidSegment, skidFadeProgress } from './skidMath';

// The two REAR wheels, tracked independently. readState().wheels order is [FL, FR, RL, RR]
// (IVehicleModel.ts / RustySedanMesh WHEEL_SLOTS); indices 2/3 are the rear pair. xSign
// follows that same table: rear-left is -halfTrack (car's left), rear-right +halfTrack.
const REAR_WHEELS = [
  { index: 2, xSign: -1 }, // rearLeft
  { index: 3, xSign: 1 }, // rearRight
] as const;

// --- module-scope scratch (no per-frame allocation) --------------------------------------
const Y_AXIS = new Vector3(0, 1, 0);
const HIDDEN = new Matrix4().makeScale(0, 0, 0); // degenerate → renders nothing; never mutated
const RUBBER = new Color(SKID.colors.rubber); // fade start (t=0)
const GROUND = new Color(SKID.colors.ground); // fade target (t=1)

const _chassisPos = new Vector3();
const _chassisQuat = new Quaternion();
const _localOffset = new Vector3();
const _worldPoint = new Vector3();
const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3();
const _mat = new Matrix4();
const _color = new Color();

// Per-mount mutable state: the ring buffer + per-mark age + each rear wheel's last emit
// anchor. Lives in a ref (not module scope) so a StrictMode double-mount can't share fade
// state between two component instances.
interface SkidRuntime {
  readonly age: Float32Array; // seconds since emit, per pool slot
  readonly alive: Uint8Array; // 1 = slot currently showing a fading mark
  readonly lastX: Float32Array; // per rear wheel [RL, RR]: last emit anchor, world X
  readonly lastZ: Float32Array;
  readonly hasLast: [boolean, boolean]; // per rear wheel: is there a valid anchor to span from?
  aliveCount: number; // fast skip of the fade sweep when nothing is on screen
  writeCursor: number; // next slot to (over)write — oldest recycles first
}

function createRuntime(): SkidRuntime {
  return {
    age: new Float32Array(SKID.poolSize),
    alive: new Uint8Array(SKID.poolSize),
    lastX: new Float32Array(REAR_WHEELS.length),
    lastZ: new Float32Array(REAR_WHEELS.length),
    hasLast: [false, false],
    aliveCount: 0,
    writeCursor: 0,
  };
}

export function SkidMarks() {
  const meshRef = useRef<InstancedMesh>(null);
  const runtimeRef = useRef<SkidRuntime | null>(null);
  if (runtimeRef.current === null) runtimeRef.current = createRuntime();

  // Base quad: PlaneGeometry is XY (+Z normal); rotateX(-90°) lays it flat in XZ with a +Y
  // normal so its local X is the mark width axis and local Z the length axis — the per-
  // instance matrix then only needs scale (width, 1, length) + yaw + position. Rotating the
  // geometry (not the mesh) keeps instance positions in world space. Built once; disposed
  // on unmount. White base colour so instanceColor fully drives each mark's colour.
  const geometry = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const material = useMemo(
    () => new MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 }),
    [],
  );
  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  // Initialise every slot hidden + seed the instanceColor buffer, before first paint. Marks
  // the buffers dynamic (they change most frames a slide is active). useLayoutEffect so no
  // frame renders default (identity/zero) matrices. Idempotent under StrictMode remount.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < SKID.poolSize; i += 1) {
      mesh.setMatrixAt(i, HIDDEN);
      mesh.setColorAt(i, GROUND); // creates the instanceColor attribute; value irrelevant while hidden
    }
    mesh.instanceColor?.setUsage(DynamicDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    const rt = runtimeRef.current;
    if (rt) {
      rt.age.fill(0);
      rt.alive.fill(0);
      rt.aliveCount = 0;
      rt.writeCursor = 0;
      rt.hasLast[0] = false;
      rt.hasLast[1] = false;
    }
  }, []);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    const rt = runtimeRef.current;
    if (!mesh || !rt) return;

    let matrixDirty = false;
    let colorDirty = false;

    // 1) Age existing marks (runs regardless of vehicle presence, so a run's marks keep
    //    fading after it ends). Skip entirely when nothing is on screen.
    if (rt.aliveCount > 0) {
      for (let i = 0; i < SKID.poolSize; i += 1) {
        if (rt.alive[i] === 0) continue;
        rt.age[i] += dt;
        const t = skidFadeProgress(rt.age[i], SKID.fadeSeconds);
        if (t >= 1) {
          mesh.setMatrixAt(i, HIDDEN);
          rt.alive[i] = 0;
          rt.aliveCount -= 1;
          matrixDirty = true;
        } else {
          _color.copy(RUBBER).lerp(GROUND, t);
          mesh.setColorAt(i, _color);
          colorDirty = true;
        }
      }
    }

    // 2) Emit new segments behind each sliding rear wheel.
    const model = playerVehicle.current;
    if (!model) {
      // Vehicle gone (GARAGE/menus/teardown): break both stripes so the next run starts fresh.
      rt.hasLast[0] = false;
      rt.hasLast[1] = false;
    } else {
      const state = model.readState();
      const pose = state.pose; // interpolated pose (TDD §7) — matches the camera, no jitter
      _chassisPos.set(pose.position.x, pose.position.y, pose.position.z);
      _chassisQuat.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);

      const handbrake = getDrivingInput().handbrake;
      const wheels = VEHICLE_TUNING.wheels;

      for (let w = 0; w < REAR_WHEELS.length; w += 1) {
        const { index, xSign } = REAR_WHEELS[w];
        const wheel = state.wheels[index];

        // World point of the wheel: chassis pose × local (±halfTrack, connectionY −
        // suspensionLength, rearZ). Its y ≈ wheel radius while the chassis sits level on
        // the y=0 slab (suspension length tracks the compression), and departs from that
        // on the ramp / mid-jump — the cheap flat-ground guard.
        _localOffset.set(
          wheels.halfTrack * xSign,
          wheels.connectionY - wheel.suspensionLength,
          wheels.rearZ,
        );
        _worldPoint.copy(_localOffset).applyQuaternion(_chassisQuat).add(_chassisPos);

        const onFlatGround =
          Math.abs(_worldPoint.y - wheels.radius) < SKID.flatGroundYTolerance;
        const emitting =
          handbrake && wheel.inContact && state.speed > SKID.minSpeed && onFlatGround;

        if (!emitting) {
          rt.hasLast[w] = false; // conditions lapsed → break the stripe
          continue;
        }

        const px = _worldPoint.x;
        const pz = _worldPoint.z;

        if (!rt.hasLast[w]) {
          // First qualifying frame: just anchor — a segment needs a previous point to span.
          rt.lastX[w] = px;
          rt.lastZ[w] = pz;
          rt.hasLast[w] = true;
          continue;
        }

        const traveled = Math.hypot(px - rt.lastX[w], pz - rt.lastZ[w]);

        if (traveled > SKID.teleportBreakDistance) {
          // Teleport / respawn jump: re-anchor without laying a stripe across the gap.
          rt.lastX[w] = px;
          rt.lastZ[w] = pz;
          continue;
        }
        if (traveled < SKID.maxSegmentLength) continue; // not enough travel to emit yet

        // Emit: recycle the oldest slot (writeCursor), span last-anchor → current point.
        const seg = computeSkidSegment(rt.lastX[w], rt.lastZ[w], px, pz, SKID.maxSegmentLength);
        const slot = rt.writeCursor;
        rt.writeCursor = (rt.writeCursor + 1) % SKID.poolSize;
        if (rt.alive[slot] === 0) rt.aliveCount += 1;
        rt.alive[slot] = 1;
        rt.age[slot] = 0;

        _pos.set(seg.midX, SKID.yOffset, seg.midZ);
        _quat.setFromAxisAngle(Y_AXIS, seg.yaw);
        _scale.set(SKID.markWidth, 1, seg.length);
        _mat.compose(_pos, _quat, _scale);
        mesh.setMatrixAt(slot, _mat);
        mesh.setColorAt(slot, RUBBER);
        matrixDirty = true;
        colorDirty = true;

        rt.lastX[w] = px;
        rt.lastZ[w] = pz;
      }
    }

    if (matrixDirty) mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  // frustumCulled off: the pool's bounding sphere is computed once (small, near origin) but
  // marks spread far across the map, so per-frame culling would wrongly drop them. No
  // shadows — flat opaque decals shouldn't cast or catch them.
  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, SKID.poolSize]}
      frustumCulled={false}
      castShadow={false}
      receiveShadow={false}
    />
  );
}
