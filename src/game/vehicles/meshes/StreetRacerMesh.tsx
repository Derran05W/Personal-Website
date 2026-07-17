// Procedural "Street Racer" body — the low-slung glass-cannon garage unlock (TDD §5.9,
// PLAYER_CARS.streetRacer). Same construction contract as vehicles/RustySedanMesh.tsx
// (read that file's header first): boxes + low-poly cylinders only, flat-shaded, no
// textures, rendered as a child of the physics chassis group, local origin = chassis
// center, +X = right, +Y = up, +Z = forward.
//
// AUTHORITATIVE DIMS: 1.7 m wide x 3.9 m long, wheel radius 0.32, LOW slung — now read
// directly from vehicles/definitions.ts's getCarDef('streetRacer').controller (Phase 17
// Task 1's landed per-car physics config), the SAME mechanism RustySedanMesh uses for the
// sedan (VEHICLE_TUNING.chassis/.wheels) so the paint job can never drift from the
// collider it's dressed over. Resolved ONCE at module scope: CAR_OVERRIDES (the source
// getCarDef reads for every non-sedan car) is structural geometry, not a leva-live knob
// (config/carTuning.ts's header), so there is nothing to re-read per frame here — only the
// sedan's block stays live (it references the leva-mutable VEHICLE_TUNING by reference).
//
// LOOK: a stepped, lower/shorter hood panel in front of the cabin stands in for a wedge
// nose — true diagonal wedges aren't in this codebase's box-composition language (see
// world/geometry/helicopter.ts's header: "chunky but recognizable", not literal slopes) —
// plus a rear spoiler (two struts + a wing) for the "glass cannon" racer read.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CylinderGeometry, MeshStandardMaterial, type Group, type Mesh } from 'three';
import { tintDamageColor } from '../../fx/damageStates';
import { getCarDef } from '../definitions';
import { playerVehicle } from '../playerRef';
import { readCarDamageTint } from './carDamageTint';

const PALETTE = {
  body: '#1fb6c4', // teal/cyan — the racer's identity colour
  cabin: '#1b1f24',
  bumper: '#2a2f35',
  wing: '#141619',
  wheel: '#161616',
  hubcap: '#c7cbd1',
} as const;

const CONTROLLER = getCarDef('streetRacer').controller;
const CHASSIS = CONTROLLER.chassis;
const WHEELS = CONTROLLER.wheels;
// Parked-pose fallback (no live vehicle — GARAGE/menus), mirrors VEHICLE_TUNING.suspension
// .restLength's role in RustySedanMesh, sourced from the same controller block.
const REST_LENGTH_FALLBACK = CONTROLLER.suspension.restLength;

const WHEEL_WIDTH = 0.24;
const WHEEL_SEGMENTS = 12;
const HUBCAP_RADIUS_FACTOR = 0.45;
const HUBCAP_THICKNESS = 0.02;

// Cosmetic proportions — no physics counterpart, same convention as RustySedanMesh.
const CABIN_WIDTH_FACTOR = 0.72;
const CABIN_LENGTH_FACTOR = 0.42;
const CABIN_HEIGHT = 0.26;
const CABIN_Z_FACTOR = -0.02;

// Nose step: the FRONT slice of the body is shorter (recessed) than the rest — two
// adjacent, non-overlapping boxes tiling the footprint (mainBody covers the rear/cabin
// portion at full height, nose covers the front at reduced height), not a box floating
// inside another. NOSE_LENGTH_FACTOR is the fraction of bodyLength the nose slice covers.
const NOSE_LENGTH_FACTOR = 0.3;
const NOSE_HEIGHT_DROP = 0.16; // how much lower the nose's top face sits vs the main body's

const BUMPER_WIDTH_FACTOR = 0.96;
const BUMPER_HEIGHT = 0.16;
const BUMPER_DEPTH = 0.14;
const BUMPER_Y_FACTOR = -0.6;

const SPOILER_STRUT_SIZE = 0.06;
const SPOILER_STRUT_HEIGHT = 0.22;
const SPOILER_WING_HEIGHT = 0.06;
const SPOILER_WING_DEPTH = 0.32;
const SPOILER_WING_WIDTH_FACTOR = 0.9;
const SPOILER_STRUT_INSET_FACTOR = 0.6; // struts sit this far in from the body edges

/**
 * Single source of truth for wheel index <-> chassis corner (mirrors RustySedanMesh's
 * WHEEL_SLOTS doc comment exactly — same [frontLeft, frontRight, rearLeft, rearRight]
 * order every readState().wheels array uses regardless of which car is live).
 */
const WHEEL_SLOTS = [
  { label: 'frontLeft', xSign: -1, zKey: 'frontZ' },
  { label: 'frontRight', xSign: 1, zKey: 'frontZ' },
  { label: 'rearLeft', xSign: -1, zKey: 'rearZ' },
  { label: 'rearRight', xSign: 1, zKey: 'rearZ' },
] as const;

export function StreetRacerMesh() {
  const bodyWidth = CHASSIS.halfWidth * 2;
  const bodyHeight = CHASSIS.halfHeight * 2;
  const bodyLength = CHASSIS.halfLength * 2;

  const noseLength = bodyLength * NOSE_LENGTH_FACTOR;
  const noseHeight = bodyHeight - NOSE_HEIGHT_DROP;
  const noseZ = CHASSIS.halfLength - noseLength / 2;
  const noseY = -NOSE_HEIGHT_DROP / 2; // bottom-flush with the main body, top recessed

  const mainLength = bodyLength - noseLength;
  const mainZ = -noseLength / 2;

  const cabinWidth = bodyWidth * CABIN_WIDTH_FACTOR;
  const cabinLength = bodyLength * CABIN_LENGTH_FACTOR;
  const cabinZ = CHASSIS.halfLength * CABIN_Z_FACTOR;
  const cabinY = CHASSIS.halfHeight + CABIN_HEIGHT / 2;

  const bumperWidth = bodyWidth * BUMPER_WIDTH_FACTOR;
  const bumperY = CHASSIS.halfHeight * BUMPER_Y_FACTOR;
  const bumperZ = CHASSIS.halfLength + BUMPER_DEPTH / 2;

  const spoilerStrutX = CHASSIS.halfWidth * SPOILER_STRUT_INSET_FACTOR;
  const spoilerZ = -CHASSIS.halfLength - SPOILER_WING_DEPTH / 2 + 0.05;
  const spoilerStrutY = CHASSIS.halfHeight + SPOILER_STRUT_HEIGHT / 2;
  const spoilerWingY = CHASSIS.halfHeight + SPOILER_STRUT_HEIGHT;
  const spoilerWingWidth = bodyWidth * SPOILER_WING_WIDTH_FACTOR;

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
  const bumperMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.bumper, flatShading: true }), []);
  const wingMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.wing, flatShading: true }), []);

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

    const { lostFrac, wrecked } = readCarDamageTint('streetRacer');
    bodyMaterial.color.set(PALETTE.body);
    tintDamageColor(bodyMaterial.color, lostFrac, wrecked);
    bumperMaterial.color.set(PALETTE.bumper);
    tintDamageColor(bumperMaterial.color, lostFrac, wrecked);
    wingMaterial.color.set(PALETTE.wing);
    tintDamageColor(wingMaterial.color, lostFrac, wrecked);
  });

  return (
    <group>
      {/* Main body: rear/cabin portion, full height. */}
      <mesh castShadow receiveShadow position={[0, 0, mainZ]} material={bodyMaterial}>
        <boxGeometry args={[bodyWidth, bodyHeight, mainLength]} />
      </mesh>

      {/* Lowered nose panel: front portion, recessed — the low-poly stand-in for a wedge. */}
      <mesh castShadow receiveShadow position={[0, noseY, noseZ]} material={bodyMaterial}>
        <boxGeometry args={[bodyWidth, noseHeight, noseLength]} />
      </mesh>

      <mesh castShadow position={[0, cabinY, cabinZ]}>
        <boxGeometry args={[cabinWidth, CABIN_HEIGHT, cabinLength]} />
        <meshStandardMaterial color={PALETTE.cabin} flatShading />
      </mesh>

      <mesh castShadow position={[0, bumperY, bumperZ]} material={bumperMaterial}>
        <boxGeometry args={[bumperWidth, BUMPER_HEIGHT, BUMPER_DEPTH]} />
      </mesh>
      <mesh castShadow position={[0, bumperY, -bumperZ]} material={bumperMaterial}>
        <boxGeometry args={[bumperWidth, BUMPER_HEIGHT, BUMPER_DEPTH]} />
      </mesh>

      {/* Rear spoiler: two struts + a wing. */}
      <mesh castShadow position={[-spoilerStrutX, spoilerStrutY, spoilerZ]} material={wingMaterial}>
        <boxGeometry args={[SPOILER_STRUT_SIZE, SPOILER_STRUT_HEIGHT, SPOILER_STRUT_SIZE]} />
      </mesh>
      <mesh castShadow position={[spoilerStrutX, spoilerStrutY, spoilerZ]} material={wingMaterial}>
        <boxGeometry args={[SPOILER_STRUT_SIZE, SPOILER_STRUT_HEIGHT, SPOILER_STRUT_SIZE]} />
      </mesh>
      <mesh castShadow position={[0, spoilerWingY, spoilerZ]} material={wingMaterial}>
        <boxGeometry args={[spoilerWingWidth, SPOILER_WING_HEIGHT, SPOILER_WING_DEPTH]} />
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
