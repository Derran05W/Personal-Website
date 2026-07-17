// Procedural "Red Rocket" body — the absurd Toronto-joke garage unlock (TDD §5.9,
// PLAYER_CARS.redRocket, "streetcar, free-driving"). Same construction contract as
// vehicles/RustySedanMesh.tsx (read that file's header first): boxes + low-poly cylinders
// only, flat-shaded, no textures, rendered as a child of the physics chassis group, local
// origin = chassis center, +X = right, +Y = up, +Z = forward.
//
// AUTHORITATIVE DIMS: 2.4 m wide x 11.0 m long — a huge slab — now read directly from
// vehicles/definitions.ts's getCarDef('redRocket').controller (Phase 17 Task 1's landed
// per-car physics config), the SAME mechanism RustySedanMesh uses for the sedan
// (VEHICLE_TUNING.chassis/.wheels) so the paint job can never drift from the collider it's
// dressed over. Resolved ONCE at module scope — see StreetRacerMesh.tsx's header for why
// (CAR_OVERRIDES is structural geometry, not a leva-live knob). The landed chassis
// halfHeight (0.6) is lower than this file's original placeholder guess (0.8); every Y
// proportion below is factor-derived off CHASSIS.halfHeight, so it re-proportions
// automatically. Wheel radius landed at 0.36 (was a 0.4 guess) — still mostly moot, the
// side skirt hides it either way.
//
// LOOK: plain red/white streetcar slab — NO real transit-authority branding/wordmarks
// anywhere (CLAUDE.md hard rule: "the streetcar is plain red/white, NO TTC branding").
// Rounded-ish ends via a narrower stepped cap at each end (the same non-overlapping-slice
// trick StreetRacerMesh's nose and PickupMesh's cab/bed split use, applied at both ends
// this time — see world/geometry/helicopter.ts's header: "chunky but recognizable", not
// literal rounding). A white window band, a low dark side skirt that visually hides the
// wheels, and a simple bent-arm-triangle roof pantograph (three thin boxes: mast, beam,
// contact shoe) complete the read.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CylinderGeometry, MeshStandardMaterial, type Group, type Mesh } from 'three';
import { tintDamageColor } from '../../fx/damageStates';
import { getCarDef } from '../definitions';
import { playerVehicle } from '../playerRef';
import { readCarDamageTint } from './carDamageTint';

const PALETTE = {
  body: '#c1272d', // red
  cap: '#a01f24', // slightly darker red — the stepped end caps read as a distinct part
  band: '#f2efe9', // off-white window band
  skirt: '#1c1e22', // dark side skirt, hides the wheels
  pantograph: '#2c2f33',
  wheel: '#161616',
  hubcap: '#8a8f96',
} as const;

const CONTROLLER = getCarDef('redRocket').controller;
const CHASSIS = CONTROLLER.chassis;
const WHEELS = CONTROLLER.wheels;
const REST_LENGTH_FALLBACK = CONTROLLER.suspension.restLength;

const WHEEL_WIDTH = 0.3;
const WHEEL_SEGMENTS = 12;
const HUBCAP_RADIUS_FACTOR = 0.4;
const HUBCAP_THICKNESS = 0.02;

// End-cap split — non-overlapping slices tiling the footprint (see file header): the main
// body covers the middle at full width, narrower caps fill both ends.
const CAP_LENGTH_FACTOR = 0.08; // fraction of bodyLength EACH end cap covers
const CAP_WIDTH_FACTOR = 0.82; // narrower than the main body — the "rounded-ish" step

const BAND_Y_LOW_FACTOR = 0.1; // fraction of halfHeight, from body center
const BAND_Y_HIGH_FACTOR = 0.55;
const BAND_LENGTH_FACTOR = 0.95; // relative to the MAIN body slice, not full length
const DECAL_PROUD_M = 0.015; // mirrors SchoolBusMesh's proud-decal trick

const SKIRT_HALF_THICK = 0.08;
const SKIRT_HEIGHT = CHASSIS.halfHeight * 0.85; // proportional, not a fixed absolute — see
// file header: stays sized right against the real (now lower) chassis halfHeight.
const SKIRT_Y_FACTOR = -0.7; // fraction of halfHeight
const SKIRT_LENGTH_FACTOR = 0.85;

const PANTO_MAST_HEIGHT = 0.35;
const PANTO_THICK = 0.07;
const PANTO_BEAM_LENGTH = 0.9; // extends toward the rear (-Z) from the mast — the "bend"
const PANTO_SHOE_HEIGHT = 0.3;

/** Mirrors RustySedanMesh's WHEEL_SLOTS doc comment — same index order every
 * readState().wheels array uses regardless of which car is live. */
const WHEEL_SLOTS = [
  { label: 'frontLeft', xSign: -1, zKey: 'frontZ' },
  { label: 'frontRight', xSign: 1, zKey: 'frontZ' },
  { label: 'rearLeft', xSign: -1, zKey: 'rearZ' },
  { label: 'rearRight', xSign: 1, zKey: 'rearZ' },
] as const;

export function RedRocketMesh() {
  const bodyWidth = CHASSIS.halfWidth * 2;
  const bodyHeight = CHASSIS.halfHeight * 2;
  const bodyLength = CHASSIS.halfLength * 2;

  const capLength = bodyLength * CAP_LENGTH_FACTOR;
  const capWidth = bodyWidth * CAP_WIDTH_FACTOR;
  const mainLength = bodyLength - capLength * 2;
  const frontCapZ = CHASSIS.halfLength - capLength / 2;
  const rearCapZ = -frontCapZ;

  const bandWidth = bodyWidth + DECAL_PROUD_M * 2;
  const bandLow = CHASSIS.halfHeight * BAND_Y_LOW_FACTOR;
  const bandHigh = CHASSIS.halfHeight * BAND_Y_HIGH_FACTOR;
  const bandHeight = bandHigh - bandLow;
  const bandY = (bandLow + bandHigh) / 2;
  const bandLength = mainLength * BAND_LENGTH_FACTOR;

  const skirtX = CHASSIS.halfWidth + SKIRT_HALF_THICK - 0.02; // slight overlap, seamless join
  const skirtY = CHASSIS.halfHeight * SKIRT_Y_FACTOR;
  const skirtLength = bodyLength * SKIRT_LENGTH_FACTOR;

  const roofY = CHASSIS.halfHeight;
  const mastY = roofY + PANTO_MAST_HEIGHT / 2;
  const beamY = roofY + PANTO_MAST_HEIGHT;
  const beamZ = -PANTO_BEAM_LENGTH / 2;
  const shoeZ = -PANTO_BEAM_LENGTH;
  const shoeY = beamY - PANTO_SHOE_HEIGHT / 2;

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
  const capMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.cap, flatShading: true }), []);
  const bandMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.band, flatShading: true }), []);
  const skirtMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.skirt, flatShading: true }), []);
  const pantoMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.pantograph, flatShading: true }), []);

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

    const { lostFrac, wrecked } = readCarDamageTint('redRocket');
    bodyMaterial.color.set(PALETTE.body);
    tintDamageColor(bodyMaterial.color, lostFrac, wrecked);
    capMaterial.color.set(PALETTE.cap);
    tintDamageColor(capMaterial.color, lostFrac, wrecked);
    skirtMaterial.color.set(PALETTE.skirt);
    tintDamageColor(skirtMaterial.color, lostFrac, wrecked);
  });

  return (
    <group>
      {/* Main body — the middle slice, full width. */}
      <mesh castShadow receiveShadow material={bodyMaterial}>
        <boxGeometry args={[bodyWidth, bodyHeight, mainLength]} />
      </mesh>

      {/* Rounded-ish end caps — narrower stepped slices at both ends. */}
      <mesh castShadow receiveShadow position={[0, 0, frontCapZ]} material={capMaterial}>
        <boxGeometry args={[capWidth, bodyHeight, capLength]} />
      </mesh>
      <mesh castShadow receiveShadow position={[0, 0, rearCapZ]} material={capMaterial}>
        <boxGeometry args={[capWidth, bodyHeight, capLength]} />
      </mesh>

      {/* Window band — proud decal surface (see SchoolBusMesh.tsx's version of this
          trick), off-white against the red body. */}
      <mesh castShadow position={[0, bandY, 0]} material={bandMaterial}>
        <boxGeometry args={[bandWidth, bandHeight, bandLength]} />
      </mesh>

      {/* Side skirts, low down — visually hide the wheels (TDD "side skirt hiding
          wheels"). */}
      <mesh castShadow position={[-skirtX, skirtY, 0]} material={skirtMaterial}>
        <boxGeometry args={[SKIRT_HALF_THICK * 2, SKIRT_HEIGHT, skirtLength]} />
      </mesh>
      <mesh castShadow position={[skirtX, skirtY, 0]} material={skirtMaterial}>
        <boxGeometry args={[SKIRT_HALF_THICK * 2, SKIRT_HEIGHT, skirtLength]} />
      </mesh>

      {/* Roof pantograph — mast up, beam bent toward the rear, contact shoe down. A
          simple bent-arm triangle from three thin boxes, per the brief. */}
      <mesh castShadow position={[0, mastY, 0]} material={pantoMaterial}>
        <boxGeometry args={[PANTO_THICK, PANTO_MAST_HEIGHT, PANTO_THICK]} />
      </mesh>
      <mesh castShadow position={[0, beamY, beamZ]} material={pantoMaterial}>
        <boxGeometry args={[PANTO_THICK, PANTO_THICK, PANTO_BEAM_LENGTH]} />
      </mesh>
      <mesh castShadow position={[0, shoeY, shoeZ]} material={pantoMaterial}>
        <boxGeometry args={[PANTO_THICK, PANTO_SHOE_HEIGHT, PANTO_THICK]} />
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
