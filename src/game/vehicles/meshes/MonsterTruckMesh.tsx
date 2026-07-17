// Procedural "Monster Truck" body — the civilian-crushing garage unlock (TDD §5.9,
// PLAYER_CARS.monsterTruck). Same construction contract as vehicles/RustySedanMesh.tsx
// (read that file's header first): boxes + low-poly cylinders only, flat-shaded, no
// textures, rendered as a child of the physics chassis group, local origin = chassis
// center, +X = right, +Y = up, +Z = forward.
//
// AUTHORITATIVE DIMS: 2.2 m wide x 4.6 m long BODY, wheel radius 0.62 — huge relative to
// the body, with HIGH clearance. Now read directly from vehicles/definitions.ts's
// getCarDef('monsterTruck').controller (Phase 17 Task 1's landed per-car physics config),
// the SAME mechanism RustySedanMesh uses for the sedan (VEHICLE_TUNING.chassis/.wheels) so
// the paint job can never drift from the collider it's dressed over. Resolved ONCE at
// module scope — see StreetRacerMesh.tsx's header for why (CAR_OVERRIDES is structural
// geometry, not a leva-live knob). The landed chassis is TALLER than this file's original
// placeholder guess (halfHeight 0.45 vs. a 0.2 "low flat frame" guess) — the CHASSIS box
// below IS that real collider (matches every other mesh's convention: the main body mesh
// wraps the exact collider), with the small cab still perched proud on top of it, just
// riding higher than originally sketched. connectionY also landed shallower (-0.45 vs. a
// -0.55 guess) but is paired with a much longer restLength (0.85, see REST_LENGTH_FALLBACK
// below) — the "high clearance" read (wheel mount far below body) still holds.
//
// LOOK: a small cab perched on the chassis body — "high clearance" is mostly a WHEEL-SYNC
// property, not a body-height one (see connectionY above: the mount point sits below the
// chassis so the big wheels hang further down, lifting the body high in world space once
// physics settles it). Flared fenders over all four wheels + a chunky front bumper
// complete the off-road read. Purple body, black wheels (the PLAYER_CARS.monsterTruck
// identity colours from the Phase 17 brief).

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CylinderGeometry, MeshStandardMaterial, type Group, type Mesh } from 'three';
import { tintDamageColor } from '../../fx/damageStates';
import { getCarDef } from '../definitions';
import { playerVehicle } from '../playerRef';
import { readCarDamageTint } from './carDamageTint';

const PALETTE = {
  body: '#7b2fbe', // purple
  window: '#1b1f24',
  fender: '#5a2490', // darker purple — flared arches read as a distinct part
  bumper: '#141619',
  wheel: '#0f0f0f', // black, per the brief
  hubcap: '#6f7379',
} as const;

const CONTROLLER = getCarDef('monsterTruck').controller;
const CHASSIS = CONTROLLER.chassis;
const WHEELS = CONTROLLER.wheels;
const REST_LENGTH_FALLBACK = CONTROLLER.suspension.restLength;

const WHEEL_WIDTH = 0.4;
const WHEEL_SEGMENTS = 12;
const HUBCAP_RADIUS_FACTOR = 0.4;
const HUBCAP_THICKNESS = 0.03;

const CAB_WIDTH = 1.5;
const CAB_HEIGHT = 0.6;
const CAB_LENGTH = 1.3;
const CAB_Z = 0.5; // toward the front, leaving frame/"hood" space ahead of it

const WINDOW_WIDTH = CAB_WIDTH + 0.02; // proud-decal epsilon, mirrors SchoolBusMesh's trick
const WINDOW_HEIGHT = CAB_HEIGHT * 0.5;
const WINDOW_LENGTH = CAB_LENGTH * 0.7;
const WINDOW_Y_OFFSET = CAB_HEIGHT * 0.15; // shifted up within the cab, toward the roof

const FENDER_WIDTH = 0.3; // thickness along X
const FENDER_HEIGHT = 0.4;
const FENDER_LENGTH = 1.0; // extent along Z
// Fender Y, derived from the (now real, taller) CHASSIS — overlaps the frame's own bottom
// face slightly for a seamless join, then hangs down toward the wheel gap. A fixed
// absolute here would have looked wrong once CHASSIS.halfHeight grew from the 0.2
// placeholder to the real 0.45.
const FENDER_Y = -CHASSIS.halfHeight - FENDER_HEIGHT / 2 + 0.1;

const BUMPER_WIDTH_FACTOR = 0.9;
const BUMPER_HEIGHT = 0.3;
const BUMPER_DEPTH = 0.25;
// Bumper Y, likewise derived from CHASSIS rather than a fixed absolute — sits a bit below
// center on the (real, taller) chassis body.
const BUMPER_Y = -CHASSIS.halfHeight * 0.3;

/** Mirrors RustySedanMesh's WHEEL_SLOTS doc comment — same index order every
 * readState().wheels array uses regardless of which car is live. */
const WHEEL_SLOTS = [
  { label: 'frontLeft', xSign: -1, zKey: 'frontZ' },
  { label: 'frontRight', xSign: 1, zKey: 'frontZ' },
  { label: 'rearLeft', xSign: -1, zKey: 'rearZ' },
  { label: 'rearRight', xSign: 1, zKey: 'rearZ' },
] as const;

export function MonsterTruckMesh() {
  const frameWidth = CHASSIS.halfWidth * 2;
  const frameHeight = CHASSIS.halfHeight * 2;
  const frameLength = CHASSIS.halfLength * 2;

  const cabY = CHASSIS.halfHeight + CAB_HEIGHT / 2;
  const windowY = cabY + WINDOW_Y_OFFSET;

  const bumperWidth = frameWidth * BUMPER_WIDTH_FACTOR;
  const bumperZ = CHASSIS.halfLength + BUMPER_DEPTH / 2;

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
  const fenderMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.fender, flatShading: true }), []);
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

    const { lostFrac, wrecked } = readCarDamageTint('monsterTruck');
    bodyMaterial.color.set(PALETTE.body);
    tintDamageColor(bodyMaterial.color, lostFrac, wrecked);
    fenderMaterial.color.set(PALETTE.fender);
    tintDamageColor(fenderMaterial.color, lostFrac, wrecked);
    bumperMaterial.color.set(PALETTE.bumper);
    tintDamageColor(bumperMaterial.color, lostFrac, wrecked);
  });

  return (
    <group>
      {/* Frame — the exact chassis collider box; the cab perches on top of it. */}
      <mesh castShadow receiveShadow material={bodyMaterial}>
        <boxGeometry args={[frameWidth, frameHeight, frameLength]} />
      </mesh>

      {/* Small cab, perched toward the front. */}
      <mesh castShadow position={[0, cabY, CAB_Z]} material={bodyMaterial}>
        <boxGeometry args={[CAB_WIDTH, CAB_HEIGHT, CAB_LENGTH]} />
      </mesh>

      {/* Cab window band — proud decal surface (see SchoolBusMesh.tsx's version of this
          trick), reads as the cab's glass at this poly budget. */}
      <mesh castShadow position={[0, windowY, CAB_Z]}>
        <boxGeometry args={[WINDOW_WIDTH, WINDOW_HEIGHT, WINDOW_LENGTH]} />
        <meshStandardMaterial color={PALETTE.window} flatShading />
      </mesh>

      {/* Chunky front bumper. */}
      <mesh castShadow position={[0, BUMPER_Y, bumperZ]} material={bumperMaterial}>
        <boxGeometry args={[bumperWidth, BUMPER_HEIGHT, BUMPER_DEPTH]} />
      </mesh>

      {/* Flared fenders over each wheel — the "huge wheels tucked under arches" read. */}
      {WHEEL_SLOTS.map((slot) => (
        <mesh
          key={`fender-${slot.label}`}
          castShadow
          position={[WHEELS.halfTrack * slot.xSign, FENDER_Y, WHEELS[slot.zKey]]}
          material={fenderMaterial}
        >
          <boxGeometry args={[FENDER_WIDTH, FENDER_HEIGHT, FENDER_LENGTH]} />
        </mesh>
      ))}

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
