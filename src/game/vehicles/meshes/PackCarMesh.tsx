// Phase 31 T2 (D6) — the shared city-pack player-car mesh. Renders ONE of the 5 swapped
// PlayerCarIds (rustySedan/streetRacer/pickup/schoolBus/redRocket — monsterTruck stays in-house,
// vehicles/meshes/MonsterTruckMesh.tsx untouched) using its `-player` GLB variant instead of a
// procedural box body. Honors the EXACT SAME wheel-sync + damage-tint contract
// vehicles/RustySedanMesh.tsx's header documents (read that file first): rendered as a child of
// the physics chassis group, local origin = chassis center, +X = right, +Y = up, +Z = forward,
// wheel spin/steer driven by playerVehicle.readState(), damage tint via
// readCarDamageTint/tintDamageColor on cloned materials every frame.
//
// TWO SCALE FACTORS (config/playerCarPack.ts's header explains why): the BODY scales uniformly
// to match the car's own collider LENGTH (config/playerCarPack.ts's resolvePlayerCarBodyScale);
// each WHEEL scales independently to match the car's own physics wheel RADIUS (computed here,
// once per mount, from the loaded wheel geometry's own bounding box — targetWheelRadiusWu only
// exposes the physics-side TARGET, never the model's native geometry).
//
// WHEEL TOPOLOGY: the pack donor models have 3 wheel parts, not 4 — front-left and front-right
// are separate (independently steered + spun), but the two REAR wheels are ONE combined mesh in
// every donor model (scripts/lib/cityPackPlayerCar.mjs's file header — the source pack never
// separates them) — rendered ONCE, spun by the average of the rear-left/rear-right physics
// rotation angles, no steer (rear steerAngle is always 0 anyway, RustySedanMesh's WHEEL_SLOTS doc
// comment). 'bus' has NO separable wheel geometry at all (single joined source mesh) — the
// documented fallback: 4 small procedural "hubcap" discs spin at the physics wheel positions
// instead, sized directly off that car's own wheel radius (authored, not loaded — no scale-
// mismatch risk).

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CylinderGeometry, MeshStandardMaterial, type BufferGeometry, type Group, type Mesh } from 'three';
import {
  dequantizeGeometry,
  dequantizeWheelGeometry,
  usePlayerCarPackModel,
  type PlayerCarPackPart,
} from '../../assets/cityPack';
import {
  PLAYER_CAR_TINT,
  resolvePlayerCarBodyScale,
  resolvePlayerCarModelVariantId,
  targetWheelRadiusWu,
  type PlayerPackCarId,
} from '../../config/playerCarPack';
import { tintDamageColor } from '../../fx/damageStates';
import { getCarDef } from '../definitions';
import { playerVehicle } from '../playerRef';
import { readCarDamageTint } from './carDamageTint';

const WHEEL_SEGMENTS = 12;

// Fallback fake-hub disc (bus only — see file header). Small, dark, spins visibly without
// pretending to be a full tire (the bus body's own baked-in, non-spinning wheel silhouette stays
// as the visual tire underneath it).
const FAKE_HUB_RADIUS_FACTOR = 0.7;
const FAKE_HUB_WIDTH = 0.06;
const FAKE_HUB_COLOR = '#161616';

// Flat tire colour — mirrors every procedural mesh's PALETTE.wheel ('#161616'). MEASURED
// DEVIATION (this task): the pack donor models' body materials carry a baked texture `map`
// (pickup-truck/sports-car-b/bus are all texture-atlas-bodied, "Class B" — cityPackNeutralBody.
// mjs's header) that a plain `material.color` tint multiply relies on being close to neutral
// grey/white. For car-a/sports-car-a (untextured "Class A") that works perfectly — no map to
// fight. For the 3 textured donors, live-verified (headless proof screenshot, this task): the
// SHARED "Zombie_Atlas.png" texture (pickup-truck AND sports-car-b literally reference the SAME
// image resource — measured via gltf-transform) samples mostly-dark/unrelated texels under the
// body/wheel geometry's actual UVs, so tint × mostly-black-texel ≈ still black regardless of the
// tint colour — the Red Rocket rendered as a near-black blob instead of red until this was
// caught. FIX: player-car body/wheel materials never carry the pack's own `map` — flat
// PLAYER_CAR_TINT (body) / this constant (wheel) only, matching the retired procedural meshes'
// 100%-flat-colour visual language exactly (no texture anywhere in the player-car roster, by
// original TDD design) and sidestepping the shared-atlas risk entirely for every car uniformly,
// not just the 2 measured as broken.
const WHEEL_TIRE_COLOR = '#161616';

interface WheelPart {
  readonly geometry: BufferGeometry;
  readonly nativeRadius: number;
}

/** Dequantizes a wheel part (rotation+scale only, hub-centred — assets/cityPack.ts's
 * dequantizeWheelGeometry) and measures its own native radius from the result (average of the
 * Y/Z half-extents — the wheel's disc plane; X is the axle-thickness/track-width axis, never the
 * radius), for the caller to derive a target-radius-matched scale factor. Null input (a donor
 * model missing this part) passes through as null. */
function useWheelPart(part: PlayerCarPackPart | null): WheelPart | null {
  return useMemo(() => {
    if (!part) return null;
    const g = dequantizeWheelGeometry(part);
    const bb = g.boundingBox!;
    const nativeRadius = (bb.max.y - bb.min.y + (bb.max.z - bb.min.z)) / 4;
    return { geometry: g, nativeRadius };
  }, [part]);
}

interface WheelSlotRefs {
  frontLeft: Group | null;
  frontRight: Group | null;
  rearCombined: Group | null;
  rearLeft: Group | null;
  rearRight: Group | null;
}
interface WheelSpinRefs {
  frontLeft: Mesh | null;
  frontRight: Mesh | null;
  rearCombined: Mesh | null;
  rearLeft: Mesh | null;
  rearRight: Mesh | null;
}

export interface PackCarMeshProps {
  readonly carId: PlayerPackCarId;
}

export function PackCarMesh({ carId }: PackCarMeshProps) {
  const modelId = useMemo(() => resolvePlayerCarModelVariantId(carId), [carId]);
  const model = usePlayerCarPackModel(modelId);
  const bodyScale = useMemo(() => resolvePlayerCarBodyScale(carId), [carId]);
  const tint = PLAYER_CAR_TINT[carId];
  const targetWheelRadius = targetWheelRadiusWu(carId);

  // --- body: dequantize once, recentre on its own bounding-box centre (chassis-origin-centred,
  // matching every procedural mesh's box-authored-at-origin convention); bodyScale applied via
  // the mesh's `scale` prop rather than baked in.
  const bodyGeometry = useMemo(() => {
    const g = dequantizeGeometry(model.body.geometry, model.body.baseMatrix);
    const bb = g.boundingBox!;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    g.translate(-cx, -cy, -cz);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }, [model.body]);
  useEffect(() => () => bodyGeometry.dispose(), [bodyGeometry]);

  // Flat tint only — no `map` (see WHEEL_TIRE_COLOR's doc comment above for why the pack's own
  // baked texture is deliberately never carried over for the player car).
  const bodyMaterial = useMemo(() => new MeshStandardMaterial({ flatShading: true, color: tint }), [tint]);
  useEffect(() => () => bodyMaterial.dispose(), [bodyMaterial]);

  // --- wheels: front-left/front-right independent, rear combined (see file header).
  const wheelFrontLeft = useWheelPart(model.wheelFrontLeft);
  const wheelFrontRight = useWheelPart(model.wheelFrontRight);
  const wheelRear = useWheelPart(model.wheelRear);
  useEffect(() => {
    return () => {
      wheelFrontLeft?.geometry.dispose();
      wheelFrontRight?.geometry.dispose();
      wheelRear?.geometry.dispose();
    };
  }, [wheelFrontLeft, wheelFrontRight, wheelRear]);

  const wheelMaterial = useMemo(() => {
    if (!model.wheelFrontLeft) return null;
    // Flat tire colour, all 3 wheel parts share it — see WHEEL_TIRE_COLOR's doc comment.
    return new MeshStandardMaterial({ flatShading: true, color: WHEEL_TIRE_COLOR });
  }, [model.wheelFrontLeft]);
  useEffect(() => () => wheelMaterial?.dispose(), [wheelMaterial]);

  const hasPackWheels = wheelFrontLeft !== null && wheelFrontRight !== null && wheelRear !== null && wheelMaterial !== null;
  const packWheels = useMemo(
    () =>
      wheelFrontLeft && wheelFrontRight && wheelRear && wheelMaterial
        ? { frontLeft: wheelFrontLeft, frontRight: wheelFrontRight, rear: wheelRear, material: wheelMaterial }
        : null,
    [wheelFrontLeft, wheelFrontRight, wheelRear, wheelMaterial],
  );

  // --- fallback fake hub discs (bus only): built regardless of hasPackWheels is wasteful but
  // harmless (cheap geometry); only actually rendered when packWheels is null.
  const fakeHubGeometry = useMemo(() => {
    if (hasPackWheels) return null;
    const radius = targetWheelRadius * FAKE_HUB_RADIUS_FACTOR;
    const g = new CylinderGeometry(radius, radius, FAKE_HUB_WIDTH, WHEEL_SEGMENTS);
    g.rotateZ(Math.PI / 2);
    return g;
  }, [hasPackWheels, targetWheelRadius]);
  useEffect(() => () => fakeHubGeometry?.dispose(), [fakeHubGeometry]);

  const fakeHubMaterial = useMemo(() => {
    if (hasPackWheels) return null;
    return new MeshStandardMaterial({ color: FAKE_HUB_COLOR, flatShading: true });
  }, [hasPackWheels]);
  useEffect(() => () => fakeHubMaterial?.dispose(), [fakeHubMaterial]);

  const groupRefs = useRef<WheelSlotRefs>({
    frontLeft: null,
    frontRight: null,
    rearCombined: null,
    rearLeft: null,
    rearRight: null,
  });
  const spinRefs = useRef<WheelSpinRefs>({
    frontLeft: null,
    frontRight: null,
    rearCombined: null,
    rearLeft: null,
    rearRight: null,
  });

  useFrame(() => {
    // Read fresh every call (not hoisted) — carId can be 'rustySedan', whose controller IS
    // VEHICLE_TUNING by reference (leva-live, RustySedanMesh's own discipline); for the other 4
    // this is a cheap repeated read of a static object.
    const controller = getCarDef(carId).controller;
    const wheels = controller.wheels;
    const restLength = controller.suspension.restLength;
    const state = playerVehicle.current?.readState() ?? null;

    const flState = state?.wheels[0];
    const frState = state?.wheels[1];
    const rlState = state?.wheels[2];
    const rrState = state?.wheels[3];

    const place = (
      groupKey: keyof WheelSlotRefs,
      spinKey: keyof WheelSpinRefs,
      x: number,
      z: number,
      steerAngle: number | null,
      rotationAngle: number,
      suspensionLength: number,
    ) => {
      const group = groupRefs.current[groupKey];
      if (group) {
        group.position.set(x, wheels.connectionY - suspensionLength, z);
        if (steerAngle !== null) group.rotation.y = steerAngle;
      }
      const spin = spinRefs.current[spinKey];
      if (spin) spin.rotation.x = rotationAngle;
    };

    place(
      'frontLeft',
      'frontLeft',
      -wheels.halfTrack,
      wheels.frontZ,
      flState?.steerAngle ?? 0,
      flState?.rotationAngle ?? 0,
      flState?.suspensionLength ?? restLength,
    );
    place(
      'frontRight',
      'frontRight',
      wheels.halfTrack,
      wheels.frontZ,
      frState?.steerAngle ?? 0,
      frState?.rotationAngle ?? 0,
      frState?.suspensionLength ?? restLength,
    );

    if (packWheels) {
      const rearRotation = ((rlState?.rotationAngle ?? 0) + (rrState?.rotationAngle ?? 0)) / 2;
      const rearSuspension = ((rlState?.suspensionLength ?? restLength) + (rrState?.suspensionLength ?? restLength)) / 2;
      place('rearCombined', 'rearCombined', 0, wheels.rearZ, null, rearRotation, rearSuspension);
    } else {
      place(
        'rearLeft',
        'rearLeft',
        -wheels.halfTrack,
        wheels.rearZ,
        null,
        rlState?.rotationAngle ?? 0,
        rlState?.suspensionLength ?? restLength,
      );
      place(
        'rearRight',
        'rearRight',
        wheels.halfTrack,
        wheels.rearZ,
        null,
        rrState?.rotationAngle ?? 0,
        rrState?.suspensionLength ?? restLength,
      );
    }

    // Phase 16/17 damage-tint contract (RustySedanMesh.tsx's useFrame doc comment): reset to the
    // base colour, then re-tint fresh every frame — never compounded.
    const { lostFrac, wrecked } = readCarDamageTint(carId);
    bodyMaterial.color.set(tint);
    tintDamageColor(bodyMaterial.color, lostFrac, wrecked);
  });

  return (
    <group>
      <mesh geometry={bodyGeometry} material={bodyMaterial} scale={bodyScale} castShadow receiveShadow />

      {packWheels ? (
        <>
          <group
            ref={(el) => {
              groupRefs.current.frontLeft = el;
            }}
          >
            <mesh
              ref={(el) => {
                spinRefs.current.frontLeft = el;
              }}
              geometry={packWheels.frontLeft.geometry}
              material={packWheels.material}
              scale={targetWheelRadius / packWheels.frontLeft.nativeRadius}
              castShadow
            />
          </group>
          <group
            ref={(el) => {
              groupRefs.current.frontRight = el;
            }}
          >
            <mesh
              ref={(el) => {
                spinRefs.current.frontRight = el;
              }}
              geometry={packWheels.frontRight.geometry}
              material={packWheels.material}
              scale={targetWheelRadius / packWheels.frontRight.nativeRadius}
              castShadow
            />
          </group>
          <group
            ref={(el) => {
              groupRefs.current.rearCombined = el;
            }}
          >
            <mesh
              ref={(el) => {
                spinRefs.current.rearCombined = el;
              }}
              geometry={packWheels.rear.geometry}
              material={packWheels.material}
              scale={targetWheelRadius / packWheels.rear.nativeRadius}
              castShadow
            />
          </group>
        </>
      ) : (
        (['frontLeft', 'frontRight', 'rearLeft', 'rearRight'] as const).map((key) => (
          <group
            key={key}
            ref={(el) => {
              groupRefs.current[key] = el;
            }}
          >
            <mesh
              ref={(el) => {
                spinRefs.current[key] = el;
              }}
              geometry={fakeHubGeometry!}
              material={fakeHubMaterial!}
              castShadow
            />
          </group>
        ))
      )}
    </group>
  );
}
