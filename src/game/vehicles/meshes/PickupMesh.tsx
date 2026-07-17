// Procedural "Pickup" body — the stable pusher garage unlock (TDD §5.9, PLAYER_CARS.
// pickup). Same construction contract as vehicles/RustySedanMesh.tsx (read that file's
// header first): boxes + low-poly cylinders only, flat-shaded, no textures, rendered as a
// child of the physics chassis group, local origin = chassis center, +X = right, +Y = up,
// +Z = forward.
//
// AUTHORITATIVE DIMS: 2.0 m wide x 4.6 m long, wheel radius 0.38 — now read directly from
// vehicles/definitions.ts's getCarDef('pickup').controller (Phase 17 Task 1's landed
// per-car physics config), the SAME mechanism RustySedanMesh uses for the sedan
// (VEHICLE_TUNING.chassis/.wheels) so the paint job can never drift from the collider it's
// dressed over. Resolved ONCE at module scope — see StreetRacerMesh.tsx's header for why
// (CAR_OVERRIDES is structural geometry, not a leva-live knob).
//
// LOOK: a tall cab up front (full chassis height) + a lower OPEN bed behind it — two
// adjacent, non-overlapping length slices (the same "step" trick StreetRacerMesh's nose
// uses) rather than one slab, so the bed genuinely reads as open (side rails + tailgate
// standing up from a lower floor) instead of a sedan trunk.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CylinderGeometry, MeshStandardMaterial, type Group, type Mesh } from 'three';
import { tintDamageColor } from '../../fx/damageStates';
import { getCarDef } from '../definitions';
import { playerVehicle } from '../playerRef';
import { readCarDamageTint } from './carDamageTint';

const PALETTE = {
  body: '#2f5233', // forest green
  cabin: '#1b1f24',
  bed: '#274a2b', // slightly darker green — the lower bed floor reads as a distinct part
  rail: '#3a3f36',
  bumper: '#2a2f35',
  wheel: '#161616',
  hubcap: '#9aa0a6',
} as const;

const CONTROLLER = getCarDef('pickup').controller;
const CHASSIS = CONTROLLER.chassis;
const WHEELS = CONTROLLER.wheels;
const REST_LENGTH_FALLBACK = CONTROLLER.suspension.restLength;

const WHEEL_WIDTH = 0.28;
const WHEEL_SEGMENTS = 12;
const HUBCAP_RADIUS_FACTOR = 0.42;
const HUBCAP_THICKNESS = 0.02;

// Cab / bed length split — non-overlapping slices tiling the footprint (see file header).
const CAB_LENGTH_FACTOR = 0.4; // fraction of bodyLength the cab (front) covers
const BED_HEIGHT_FACTOR = 0.55; // bed floor height as a fraction of full body height

const CABIN_WIDTH_FACTOR = 0.75;
const CABIN_LENGTH_FACTOR = 0.55; // fraction of the CAB slice's own length
const CABIN_HEIGHT = 0.28;

const RAIL_HEIGHT = 0.26;
const RAIL_THICKNESS = 0.07;
const TAILGATE_THICKNESS = 0.08;

const FRONT_BUMPER_WIDTH_FACTOR = 0.96;
const FRONT_BUMPER_HEIGHT = 0.2;
const FRONT_BUMPER_DEPTH = 0.16;
const REAR_BUMPER_WIDTH_FACTOR = 0.9;
const REAR_BUMPER_HEIGHT = 0.16;
const REAR_BUMPER_DEPTH = 0.14;

/** Mirrors RustySedanMesh's WHEEL_SLOTS doc comment — same index order every
 * readState().wheels array uses regardless of which car is live. */
const WHEEL_SLOTS = [
  { label: 'frontLeft', xSign: -1, zKey: 'frontZ' },
  { label: 'frontRight', xSign: 1, zKey: 'frontZ' },
  { label: 'rearLeft', xSign: -1, zKey: 'rearZ' },
  { label: 'rearRight', xSign: 1, zKey: 'rearZ' },
] as const;

export function PickupMesh() {
  const bodyWidth = CHASSIS.halfWidth * 2;
  const bodyHeight = CHASSIS.halfHeight * 2;
  const bodyLength = CHASSIS.halfLength * 2;

  const cabLength = bodyLength * CAB_LENGTH_FACTOR;
  const cabZ = CHASSIS.halfLength - cabLength / 2;

  const bedLength = bodyLength - cabLength;
  const bedZ = -cabLength / 2;
  const bedHeight = bodyHeight * BED_HEIGHT_FACTOR;
  const bedY = -CHASSIS.halfHeight + bedHeight / 2;
  const bedTop = -CHASSIS.halfHeight + bedHeight;

  const cabinWidth = bodyWidth * CABIN_WIDTH_FACTOR;
  const cabinLength = cabLength * CABIN_LENGTH_FACTOR;
  const cabinY = CHASSIS.halfHeight + CABIN_HEIGHT / 2;

  const railY = bedTop + RAIL_HEIGHT / 2;
  const railX = CHASSIS.halfWidth - RAIL_THICKNESS / 2;
  const railLength = bedLength - TAILGATE_THICKNESS * 1.5;

  const tailgateZ = -CHASSIS.halfLength + TAILGATE_THICKNESS / 2;

  const frontBumperWidth = bodyWidth * FRONT_BUMPER_WIDTH_FACTOR;
  const frontBumperY = -CHASSIS.halfHeight * 0.7;
  const frontBumperZ = CHASSIS.halfLength + FRONT_BUMPER_DEPTH / 2;

  const rearBumperWidth = bodyWidth * REAR_BUMPER_WIDTH_FACTOR;
  const rearBumperZ = -CHASSIS.halfLength - REAR_BUMPER_DEPTH / 2;

  const tireGeometry = useMemo(() => {
    const geometry = new CylinderGeometry(WHEELS.radius, WHEELS.radius, WHEEL_WIDTH, WHEEL_SEGMENTS);
    geometry.rotateZ(Math.PI / 2);
    return geometry;
  }, []);
  const hubcapGeometry = useMemo(() => {
    const radius = WHEELS.radius * HUBCAP_RADIUS_FACTOR;
    const geometry = new CylinderGeometry(radius, radius, HUBCAP_THICKNESS, WHEEL_SEGMENTS);
    geometry.rotateZ(Math.PI / 2);
    return geometry;
  }, []);

  const tireMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.wheel, flatShading: true }), []);
  const hubcapMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.hubcap, flatShading: true }), []);
  const bodyMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.body, flatShading: true }), []);
  const bedMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.bed, flatShading: true }), []);
  const railMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.rail, flatShading: true }), []);
  const bumperMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.bumper, flatShading: true }), []);

  const wheelGroups = useRef<(Group | null)[]>([null, null, null, null]);
  const wheelTires = useRef<(Mesh | null)[]>([null, null, null, null]);

  useFrame(() => {
    const state = playerVehicle.current?.readState() ?? null;

    for (let i = 0; i < WHEEL_SLOTS.length; i += 1) {
      const group = wheelGroups.current[i];
      if (!group) continue;
      const slot = WHEEL_SLOTS[i];
      const wheelState = state?.wheels[i];
      const suspensionLength = wheelState?.suspensionLength ?? REST_LENGTH_FALLBACK;
      group.position.set(
        WHEELS.halfTrack * slot.xSign,
        WHEELS.connectionY - suspensionLength,
        WHEELS[slot.zKey],
      );
      group.rotation.y = wheelState?.steerAngle ?? 0;
      const tire = wheelTires.current[i];
      if (tire) tire.rotation.x = wheelState?.rotationAngle ?? 0;
    }

    const { lostFrac, wrecked } = readCarDamageTint('pickup');
    bodyMaterial.color.set(PALETTE.body);
    tintDamageColor(bodyMaterial.color, lostFrac, wrecked);
    bedMaterial.color.set(PALETTE.bed);
    tintDamageColor(bedMaterial.color, lostFrac, wrecked);
    railMaterial.color.set(PALETTE.rail);
    tintDamageColor(railMaterial.color, lostFrac, wrecked);
    bumperMaterial.color.set(PALETTE.bumper);
    tintDamageColor(bumperMaterial.color, lostFrac, wrecked);
  });

  return (
    <group>
      {/* Cab — front slice, full chassis height. */}
      <mesh castShadow receiveShadow position={[0, 0, cabZ]} material={bodyMaterial}>
        <boxGeometry args={[bodyWidth, bodyHeight, cabLength]} />
      </mesh>

      {/* Bed floor — rear slice, lower (open-bed read). */}
      <mesh castShadow receiveShadow position={[0, bedY, bedZ]} material={bedMaterial}>
        <boxGeometry args={[bodyWidth, bedHeight, bedLength]} />
      </mesh>

      {/* Cab window band — proud on the cab roof, mirrors RustySedanMesh's cabin trick. */}
      <mesh castShadow position={[0, cabinY, cabZ]}>
        <boxGeometry args={[cabinWidth, CABIN_HEIGHT, cabinLength]} />
        <meshStandardMaterial color={PALETTE.cabin} flatShading />
      </mesh>

      {/* Bed side rails, standing up from the bed floor. */}
      <mesh castShadow position={[-railX, railY, bedZ]} material={railMaterial}>
        <boxGeometry args={[RAIL_THICKNESS, RAIL_HEIGHT, railLength]} />
      </mesh>
      <mesh castShadow position={[railX, railY, bedZ]} material={railMaterial}>
        <boxGeometry args={[RAIL_THICKNESS, RAIL_HEIGHT, railLength]} />
      </mesh>

      {/* Tailgate, closing the bed at the rear. */}
      <mesh castShadow position={[0, railY, tailgateZ]} material={railMaterial}>
        <boxGeometry args={[bodyWidth, RAIL_HEIGHT, TAILGATE_THICKNESS]} />
      </mesh>

      {/* Front + rear bumpers. */}
      <mesh castShadow position={[0, frontBumperY, frontBumperZ]} material={bumperMaterial}>
        <boxGeometry args={[frontBumperWidth, FRONT_BUMPER_HEIGHT, FRONT_BUMPER_DEPTH]} />
      </mesh>
      <mesh castShadow position={[0, bedY, rearBumperZ]} material={bumperMaterial}>
        <boxGeometry args={[rearBumperWidth, REAR_BUMPER_HEIGHT, REAR_BUMPER_DEPTH]} />
      </mesh>

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
