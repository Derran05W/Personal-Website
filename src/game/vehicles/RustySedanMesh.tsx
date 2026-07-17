// Procedural "Rusty Sedan" body — the starter car's visual (TDD §5.9) and the reference
// construction Phase 17 reuses for the other five garage cars. Boxes + low-poly cylinders
// only, flat-shaded, no textures (TDD look). Rendered as a CHILD of the physics chassis
// group (raycastVehicle's RigidBody, owned elsewhere) — this component holds no physics,
// only geometry and the per-frame wheel visual state. Local origin = chassis center,
// +X = right, +Y = up, +Z = forward (matches VehiclePose / WheelState, IVehicleModel.ts).
//
// All chassis/wheel *dimensions and placements* come from VEHICLE_TUNING so the paint job
// never drifts from the physics collider it's dressed over — only pure-cosmetic
// proportions (cabin taper, bumper size, wheel width — none of which the physics config
// models) are local constants below.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CylinderGeometry, MeshStandardMaterial, type Group, type Mesh } from 'three';
import { VEHICLE_TUNING } from '../config';
import { tintDamageColor } from '../fx/damageStates';
import { playerVehicle } from './playerRef';
import { readCarDamageTint } from './meshes/carDamageTint';

// Flat low-poly palette — five swatches, named so Phase 17's other cars can restyle by
// swapping values here instead of hunting through the geometry below.
const PALETTE = {
  body: '#a9502f', // rusty oxide red-brown — main panels
  cabin: '#262a30', // near-black greenhouse; doubles as the "window band"
  bumper: '#6f6a60', // weathered grey-brown bumpers
  wheel: '#161616', // tire
  hubcap: '#9aa0a6', // hubcap disc
} as const;

// Cosmetic-only proportions — no physics counterpart in VEHICLE_TUNING, so no config key
// to derive these from. Fractions are relative to the chassis box computed in-component.
const CABIN_WIDTH_FACTOR = 0.8;
const CABIN_LENGTH_FACTOR = 0.5;
const CABIN_HEIGHT = 0.4; // m
const CABIN_Z_FACTOR = -0.08; // small aft shift off chassis center, sedan-ish greenhouse
const BUMPER_WIDTH_FACTOR = 0.96;
const BUMPER_HEIGHT = 0.22; // m
const BUMPER_DEPTH = 0.18; // m, along Z
const BUMPER_Y_FACTOR = -0.55; // low on the body, relative to chassis.halfHeight

// VEHICLE_TUNING.wheels has radius but no thickness field — wheel width is cosmetic only
// until/unless a future phase needs it in the physics model too.
const WHEEL_WIDTH = 0.26; // m
const WHEEL_SEGMENTS = 12; // low-poly radial resolution
const HUBCAP_RADIUS_FACTOR = 0.45;
const HUBCAP_THICKNESS = 0.02; // m, sits flush on the tire's outer face

/**
 * Single source of truth for wheel index <-> chassis corner. The physics task
 * (raycastVehicle.ts) must populate `readState().wheels` in this exact order:
 * [frontLeft, frontRight, rearLeft, rearRight]. "Left"/"right" follow the chassis-local
 * frame documented above (+Z forward, +Y up) — facing forward, +X is the car's right, so
 * `xSign` is negative for left, positive for right (matches VEHICLE_TUNING.wheels.halfTrack
 * being an unsigned half-extent). If the physics side lands on a different order, fixing
 * it here — reordering this array — is the only change needed; nothing else in this file
 * is index-order-sensitive.
 */
const WHEEL_SLOTS = [
  { label: 'frontLeft', xSign: -1, zKey: 'frontZ' },
  { label: 'frontRight', xSign: 1, zKey: 'frontZ' },
  { label: 'rearLeft', xSign: -1, zKey: 'rearZ' },
  { label: 'rearRight', xSign: 1, zKey: 'rearZ' },
] as const;

export function RustySedanMesh() {
  const { chassis, wheels: wheelCfg } = VEHICLE_TUNING;

  const bodyWidth = chassis.halfWidth * 2;
  const bodyHeight = chassis.halfHeight * 2;
  const bodyLength = chassis.halfLength * 2;

  const cabinWidth = bodyWidth * CABIN_WIDTH_FACTOR;
  const cabinLength = bodyLength * CABIN_LENGTH_FACTOR;
  const cabinZ = chassis.halfLength * CABIN_Z_FACTOR;
  const cabinY = chassis.halfHeight + CABIN_HEIGHT / 2;

  const bumperWidth = bodyWidth * BUMPER_WIDTH_FACTOR;
  const bumperY = chassis.halfHeight * BUMPER_Y_FACTOR;
  const bumperZ = chassis.halfLength + BUMPER_DEPTH / 2;

  // Tire/hubcap geometry built once per radius and shared across all four wheels — one
  // buffer each instead of four. Cylinders default to a Y-axis length; rotateZ bakes the
  // axle orientation (length along X, the car's left/right axis) into the vertex data
  // itself, so the per-frame spin below can be a plain rotation.x with no Euler-order
  // interaction against any other rotation on the same node.
  const tireGeometry = useMemo(() => {
    const geometry = new CylinderGeometry(
      wheelCfg.radius,
      wheelCfg.radius,
      WHEEL_WIDTH,
      WHEEL_SEGMENTS,
    );
    geometry.rotateZ(Math.PI / 2);
    return geometry;
  }, [wheelCfg.radius]);

  const hubcapGeometry = useMemo(() => {
    const radius = wheelCfg.radius * HUBCAP_RADIUS_FACTOR;
    const geometry = new CylinderGeometry(radius, radius, HUBCAP_THICKNESS, WHEEL_SEGMENTS);
    geometry.rotateZ(Math.PI / 2);
    return geometry;
  }, [wheelCfg.radius]);

  const tireMaterial = useMemo(
    () => new MeshStandardMaterial({ color: PALETTE.wheel, flatShading: true }),
    [],
  );
  const hubcapMaterial = useMemo(
    () => new MeshStandardMaterial({ color: PALETTE.hubcap, flatShading: true }),
    [],
  );
  // Body + bumper materials: pulled out of inline JSX (unlike cabin/wheel/hubcap, which stay
  // JSX-declared — this car is the only live instance, so R3F privately owning a material per
  // JSX node was always fine) so Phase 16's damage tint (below) has a stable ref to mutate
  // in-place every frame, matching tireMaterial/hubcapMaterial's existing useMemo pattern.
  // The two bumpers share ONE material (identical colour, identical tint) rather than one
  // each — cheaper and there's no reason for them to ever diverge.
  const bodyMaterial = useMemo(
    () => new MeshStandardMaterial({ color: PALETTE.body, flatShading: true }),
    [],
  );
  const bumperMaterial = useMemo(
    () => new MeshStandardMaterial({ color: PALETTE.bumper, flatShading: true }),
    [],
  );

  // Per-wheel refs, index-aligned with WHEEL_SLOTS/readState().wheels. Arrays are
  // allocated once (useRef initial value); useFrame below only ever mutates entries in
  // place, never reallocates — no per-frame garbage.
  const wheelGroups = useRef<(Group | null)[]>([null, null, null, null]);
  const wheelTires = useRef<(Mesh | null)[]>([null, null, null, null]);

  useFrame(() => {
    // Read wheel/suspension config fresh every call rather than hoisting to a
    // render-scope const: these are leva-live-tunable (CLAUDE.md), and placement must
    // track edits made mid-run, not just whatever was current the last time this
    // component happened to re-render.
    const wheels = VEHICLE_TUNING.wheels;
    const restLength = VEHICLE_TUNING.suspension.restLength;
    const state = playerVehicle.current?.readState() ?? null;

    for (let i = 0; i < WHEEL_SLOTS.length; i += 1) {
      const group = wheelGroups.current[i];
      if (!group) continue;

      const slot = WHEEL_SLOTS[i];
      const wheelState = state?.wheels[i];
      // No live vehicle (GARAGE/menus) or state not yet populated: park at rest length.
      const suspensionLength = wheelState?.suspensionLength ?? restLength;

      // Wheel center = connection point + (0,-1,0) * suspensionLength (IVehicleModel.ts
      // WheelState doc).
      group.position.set(
        wheels.halfTrack * slot.xSign,
        wheels.connectionY - suspensionLength,
        wheels[slot.zKey],
      );
      // Rear wheels' steerAngle is always 0 from the physics side, so this is safe
      // unconditionally — no front/rear branch needed here.
      group.rotation.y = wheelState?.steerAngle ?? 0;

      const tire = wheelTires.current[i];
      if (tire) tire.rotation.x = wheelState?.rotationAngle ?? 0;
    }

    // Phase 16: graduated damage tint (25/50/75% HP lost), full charred once hp hits 0
    // (WRECKED — combat/runLoop.ts's wreckedLockSec keeps this car rendering for ~1.2s
    // before the GAMEOVER transition, so the tint is visible during that beat). Reset to the
    // base colour every frame before re-tinting — never compound across frames — the same
    // "recompute fresh from current hp" discipline fx/damageStates.ts's tintDamageColor()
    // documents for the fleet meshes, just applied to a real Material instead of an
    // InstancedMesh colour. Smoke/fire emitters for the player are NOT this component's job
    // (fx/damageStates.ts's DamageStatesMount polls the store directly for those).
    // Phase 17: hp fraction now reads against THIS car's own max hp (readCarDamageTint,
    // vehicles/meshes/carDamageTint.ts) rather than a hardcoded rustySedan.hp — the fix
    // needed once five more cars with different hp pools exist.
    const { lostFrac, wrecked } = readCarDamageTint('rustySedan');
    bodyMaterial.color.set(PALETTE.body);
    tintDamageColor(bodyMaterial.color, lostFrac, wrecked);
    bumperMaterial.color.set(PALETTE.bumper);
    tintDamageColor(bumperMaterial.color, lostFrac, wrecked);
  });

  return (
    <group>
      {/* Main body: exact chassis box so the paint job reads as wrapped around the
          collider rather than floating loose inside it. */}
      <mesh castShadow receiveShadow material={bodyMaterial}>
        <boxGeometry args={[bodyWidth, bodyHeight, bodyLength]} />
      </mesh>

      {/* Cabin/greenhouse: a narrower, dark box standing proud of the roof — doubles as
          the window band at this poly budget, no separate glass mesh needed. */}
      <mesh castShadow position={[0, cabinY, cabinZ]}>
        <boxGeometry args={[cabinWidth, CABIN_HEIGHT, cabinLength]} />
        <meshStandardMaterial color={PALETTE.cabin} flatShading />
      </mesh>

      {/* Front/rear bumpers. */}
      <mesh castShadow position={[0, bumperY, bumperZ]} material={bumperMaterial}>
        <boxGeometry args={[bumperWidth, BUMPER_HEIGHT, BUMPER_DEPTH]} />
      </mesh>
      <mesh castShadow position={[0, bumperY, -bumperZ]} material={bumperMaterial}>
        <boxGeometry args={[bumperWidth, BUMPER_HEIGHT, BUMPER_DEPTH]} />
      </mesh>

      {/* Wheels — see WHEEL_SLOTS doc comment for the assumed index order. Position and
          steer live on the outer group (useFrame above); only the inner tire mesh spins,
          so steering and rolling compose without fighting over the same transform. */}
      {WHEEL_SLOTS.map((slot, i) => (
        <group
          key={slot.label}
          ref={(el) => {
            wheelGroups.current[i] = el;
          }}
        >
          <mesh
            ref={(el) => {
              wheelTires.current[i] = el;
            }}
            geometry={tireGeometry}
            material={tireMaterial}
            castShadow
          />
          <mesh
            position={[slot.xSign * (WHEEL_WIDTH / 2 + HUBCAP_THICKNESS / 2), 0, 0]}
            geometry={hubcapGeometry}
            material={hubcapMaterial}
            castShadow
          />
        </group>
      ))}
    </group>
  );
}
