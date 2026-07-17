// Procedural "School Bus" body — the D/D/D wrecking-ball garage unlock (TDD §5.9,
// PLAYER_CARS.schoolBus). Same construction contract as vehicles/RustySedanMesh.tsx (read
// that file's header first): boxes + low-poly cylinders only, flat-shaded, no textures,
// rendered as a child of the physics chassis group, local origin = chassis center, +X =
// right, +Y = up, +Z = forward.
//
// AUTHORITATIVE DIMS: 2.4 m wide x 9.0 m long — a LONG slab — now read directly from
// vehicles/definitions.ts's getCarDef('schoolBus').controller (Phase 17 Task 1's landed
// per-car physics config), the SAME mechanism RustySedanMesh uses for the sedan
// (VEHICLE_TUNING.chassis/.wheels) so the paint job can never drift from the collider it's
// dressed over. Resolved ONCE at module scope — see StreetRacerMesh.tsx's header for why
// (CAR_OVERRIDES is structural geometry, not a leva-live knob). The landed chassis
// halfHeight (0.55) is noticeably lower/flatter than this file's original placeholder
// guess (0.75) — every Y proportion below is factor-derived off CHASSIS.halfHeight, so it
// re-proportions automatically rather than needing per-line fixes.
//
// LOOK: a single tall yellow slab (one box does most of the silhouette work at this
// length) + a black window-band wrapping the upper sides (generic — no route numbers, no
// district names, per CLAUDE.md's no-real-world-branding rule) + a black rocker-panel
// stripe low down + black front/rear bumpers. The window band and stripe are each ONE box
// slightly WIDER (X) than the body, so they read as a proud decal surface on the skin
// instead of being swallowed invisibly inside the larger body box's volume.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CylinderGeometry, MeshStandardMaterial, type Group, type Mesh } from 'three';
import { tintDamageColor } from '../../fx/damageStates';
import { getCarDef } from '../definitions';
import { playerVehicle } from '../playerRef';
import { readCarDamageTint } from './carDamageTint';

const PALETTE = {
  body: '#f4c430', // school-bus yellow
  trim: '#17181a', // window band + rocker stripe + bumpers
  wheel: '#161616',
  hubcap: '#8a8f96',
} as const;

const CONTROLLER = getCarDef('schoolBus').controller;
const CHASSIS = CONTROLLER.chassis;
const WHEELS = CONTROLLER.wheels;
const REST_LENGTH_FALLBACK = CONTROLLER.suspension.restLength;

const WHEEL_WIDTH = 0.3;
const WHEEL_SEGMENTS = 12;
const HUBCAP_RADIUS_FACTOR = 0.4;
const HUBCAP_THICKNESS = 0.02;

// Proud-decal epsilon: how far the window band / stripe boxes stick out past the body's
// own side faces on X, so they render as a visible surface instead of being fully enclosed
// inside the larger body box (which would make them invisible — see file header).
const DECAL_PROUD_M = 0.015;

const WINDOW_BAND_Y_LOW_FACTOR = 0.15; // fraction of halfHeight, from body center
const WINDOW_BAND_Y_HIGH_FACTOR = 0.75;
const WINDOW_BAND_LENGTH_FACTOR = 0.82; // leaves plain-yellow nose/tail caps, see header

const STRIPE_HEIGHT = 0.12;
const STRIPE_Y_FACTOR = -0.65;
const STRIPE_LENGTH_FACTOR = 0.95;

const BUMPER_WIDTH_FACTOR = 0.96;
const BUMPER_HEIGHT = 0.22;
const BUMPER_DEPTH = 0.2;
const BUMPER_Y_FACTOR = -0.75;

/** Mirrors RustySedanMesh's WHEEL_SLOTS doc comment — same index order every
 * readState().wheels array uses regardless of which car is live. */
const WHEEL_SLOTS = [
  { label: 'frontLeft', xSign: -1, zKey: 'frontZ' },
  { label: 'frontRight', xSign: 1, zKey: 'frontZ' },
  { label: 'rearLeft', xSign: -1, zKey: 'rearZ' },
  { label: 'rearRight', xSign: 1, zKey: 'rearZ' },
] as const;

export function SchoolBusMesh() {
  const bodyWidth = CHASSIS.halfWidth * 2;
  const bodyHeight = CHASSIS.halfHeight * 2;
  const bodyLength = CHASSIS.halfLength * 2;

  const bandWidth = bodyWidth + DECAL_PROUD_M * 2;
  const bandLow = CHASSIS.halfHeight * WINDOW_BAND_Y_LOW_FACTOR;
  const bandHigh = CHASSIS.halfHeight * WINDOW_BAND_Y_HIGH_FACTOR;
  const bandHeight = bandHigh - bandLow;
  const bandY = (bandLow + bandHigh) / 2;
  const bandLength = bodyLength * WINDOW_BAND_LENGTH_FACTOR;

  const stripeWidth = bandWidth;
  const stripeY = CHASSIS.halfHeight * STRIPE_Y_FACTOR;
  const stripeLength = bodyLength * STRIPE_LENGTH_FACTOR;

  const bumperWidth = bodyWidth * BUMPER_WIDTH_FACTOR;
  const bumperY = CHASSIS.halfHeight * BUMPER_Y_FACTOR;
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
  const trimMaterial = useMemo(() => new MeshStandardMaterial({ color: PALETTE.trim, flatShading: true }), []);

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

    const { lostFrac, wrecked } = readCarDamageTint('schoolBus');
    bodyMaterial.color.set(PALETTE.body);
    tintDamageColor(bodyMaterial.color, lostFrac, wrecked);
    trimMaterial.color.set(PALETTE.trim);
    tintDamageColor(trimMaterial.color, lostFrac, wrecked);
  });

  return (
    <group>
      {/* Main slab — the whole silhouette at this length. */}
      <mesh castShadow receiveShadow material={bodyMaterial}>
        <boxGeometry args={[bodyWidth, bodyHeight, bodyLength]} />
      </mesh>

      {/* Window band — proud decal surface (see file header), leaves plain-yellow caps at
          the very front/rear. "Many side windows" reads as one continuous dark strip at
          this poly budget — the same idiom every fleet mesh in this codebase uses for
          glass (e.g. ai/units/SwatMesh.tsx's full tinted band). */}
      <mesh castShadow position={[0, bandY, 0]} material={trimMaterial}>
        <boxGeometry args={[bandWidth, bandHeight, bandLength]} />
      </mesh>

      {/* Rocker-panel stripe, low down. */}
      <mesh castShadow position={[0, stripeY, 0]} material={trimMaterial}>
        <boxGeometry args={[stripeWidth, STRIPE_HEIGHT, stripeLength]} />
      </mesh>

      {/* Front + rear bumpers. */}
      <mesh castShadow position={[0, bumperY, bumperZ]} material={trimMaterial}>
        <boxGeometry args={[bumperWidth, BUMPER_HEIGHT, BUMPER_DEPTH]} />
      </mesh>
      <mesh castShadow position={[0, bumperY, -bumperZ]} material={trimMaterial}>
        <boxGeometry args={[bumperWidth, BUMPER_HEIGHT, BUMPER_DEPTH]} />
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
