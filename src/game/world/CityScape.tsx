// The generated city's scene root (Phase 4 Task 3). Replaces world/TestPlane.tsx as the
// thing rendered inside <Physics> — same lighting rig, same "cheap placeholder, Phase 5
// does it properly" spirit, but driving the real seeded WorldData instead of hand-placed
// literals. Kept to a small, fixed number of draw calls: one merged mesh per
// tile-category (ground, roads, park/lot overlay), one InstancedMesh per repeated-prop
// category (buildings, transformer boxes, boundary barriers), plus the water plane.
//
// Colliders (TDD §15 footgun, phase-03-notes.md): the player's wheel rays hit ONLY
// GROUND-membership colliders, so the single ground slab below carries that membership
// and is what actually holds the car up — roads/overlays are visual-only quads with no
// collider of their own (they sit a hair above the ground slab, which is continuous
// underneath the whole map). Buildings/transformer props get no collider yet (Phase 5/6);
// the map edge is diegetic (TDD §5.4): highway barriers (BUILDING group) on N/E/W, a
// WATER sensor (senses vehicles only, TDD §7) on the south lakefront.
//
// Not wired into game/index.tsx here — the phase orchestrator integrates it (keyed on
// seed for full-remount regeneration) in place of TestPlane.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  MeshStandardMaterial,
  Object3D,
  type InstancedMesh,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { BOUNDARY, QUALITY_TIERS, RENDERING, WORLD, interactionGroups } from '../config';
import { gameEvents } from '../state/events';
import { useGameStore } from '../state/store';
import { playerVehicle } from '../vehicles/playerRef';
import { applyKensingtonBoost } from '../powergrid/emitters';
import { BlueHourRig } from './BlueHourRig';
import { CityArchetypes } from './CityArchetypes';
import { WorldColliders } from './CityColliders';
import { buildCityInstanceSets } from './cityInstances';
import { DISTRICT_COUNT } from './instancing';
import { getSpawnPose, spawnPoseRef } from './spawn';
import { type Tile, type WorldData } from './types';
import { worldRef } from './worldRef';

export interface CityScapeProps {
  world: WorldData;
}

// --- Placeholder palette (Phase 5 owns the real one) --------------------------------------
// Plain hex literals, component-local per CLAUDE.md's "pure debug/placeholder visuals may
// stay local with a comment" carve-out — TestPlane.tsx set the same precedent. GROUND must
// stay byte-for-byte in sync with config/fx.ts's SKID.colors.ground (the skid-mark fade
// target); if you touch this value, update that one too.
const GROUND_COLOR = '#454b54';
const ROAD_COLOR = '#2b2f36';
const PARK_COLOR = new Color('#3f7a4e');
const PARKING_LOT_COLOR = new Color('#31353c');
const TRANSFORMER_LOT_COLOR = new Color('#8a7a3f');
const WATER_COLOR = '#2f6f93';
const BARRIER_COLOR = '#9aa0a8';

// --- Placeholder layout numbers (visual-only, no physics implication) ---------------------
const ROAD_Y = 0.01; // A hair above the ground slab (y=0 top face) — no z-fighting.
const OVERLAY_Y = 0.012; // Parks/lots: fractionally above roads (tile sets never overlap).
const WATER_VISUAL_Y = 0.05;
const HALF_MAP_M = (WORLD.tiles * WORLD.tileSize) / 2;
const GROUND_SIZE_M = WORLD.tiles * WORLD.tileSize + 2 * BOUNDARY.groundMarginM;
const GROUND_THICKNESS_M = BOUNDARY.groundThicknessM;
const GROUND_GROUPS = interactionGroups('GROUND');
const BUILDING_GROUPS = interactionGroups('BUILDING');
const WATER_GROUPS = interactionGroups('WATER');

interface BarrierSpec {
  readonly position: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

// Three stretched boxes just outside the ring road on the N/E/W (non-lakefront) edges —
// the south edge is the water sensor instead (TDD §5.4: the map edge must be diegetic,
// never an invisible wall). Computed once at module scope: purely a function of the
// (structural, not leva-live) WORLD/BOUNDARY config.
const BARRIER_SPECS: readonly BarrierSpec[] = (() => {
  const edge = HALF_MAP_M + BOUNDARY.barrierOffsetM;
  const span = WORLD.tiles * WORLD.tileSize + 2 * BOUNDARY.barrierOffsetM;
  const h = BOUNDARY.barrierHeightM;
  const t = BOUNDARY.barrierThicknessM;
  return [
    { position: [0, h / 2, -edge], size: [span, h, t] }, // North
    { position: [edge, h / 2, 0], size: [t, h, span] }, // East
    { position: [-edge, h / 2, 0], size: [t, h, span] }, // West
  ];
})();

function overlayColorOf(tile: Tile): Color {
  if (tile.type === 'parkingLot') return PARKING_LOT_COLOR;
  if (tile.type === 'transformerLot') return TRANSFORMER_LOT_COLOR;
  return PARK_COLOR; // only 'park' left, given the include predicate below
}

/**
 * One merged, upward-facing (+Y normal) quad per tile matching `include`, at height `y`.
 * `colorOf` is optional — road tiles share a single flat material and skip the per-vertex
 * `color` attribute entirely (one flat colour, no interpolation cost); the park/lot
 * overlay supplies one to paint several tile types in a single draw call.
 */
function buildTileQuadGeometry(
  tiles: readonly Tile[],
  include: (tile: Tile) => boolean,
  y: number,
  colorOf?: (tile: Tile) => Color,
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  for (const tile of tiles) {
    if (!include(tile)) continue;
    const x0 = tile.col * WORLD.tileSize - HALF_MAP_M;
    const x1 = x0 + WORLD.tileSize;
    const z0 = tile.row * WORLD.tileSize - HALF_MAP_M;
    const z1 = z0 + WORLD.tileSize;
    // Two triangles (v0,v1,v2) + (v0,v2,v3) with v0=(x0,z0) v1=(x0,z1) v2=(x1,z1)
    // v3=(x1,z0) — this winding yields a +Y face normal (verified via the cross product;
    // three.js front faces are CCW as seen from the direction the normal points).
    positions.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
    for (let i = 0; i < 6; i++) normals.push(0, 1, 0);
    if (colorOf) {
      const c = colorOf(tile);
      for (let i = 0; i < 6; i++) colors.push(c.r, c.g, c.b);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  if (colorOf) geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  // Computed explicitly rather than relying on the renderer to lazily compute it on first
  // frustum test — these meshes are also marked frustumCulled=false below, but an explicit,
  // correct bounding sphere is cheap insurance (e.g. for future raycasts/debug tooling).
  geometry.computeBoundingSphere();
  return geometry;
}

// --- Lake shimmer material (Phase 19, TDD §8/§13) -----------------------------------------
// The south lakefront plane gets a cheap onBeforeCompile pass on a MeshStandardMaterial: a
// slow sinusoidal shimmer + a warm specular streak toward the south horizon glow (echoing the
// sky's lake afterglow). No reflections, no render targets, no extra draw call — one plane,
// one material. All tunables are RENDERING.water (leva-live, re-read each frame). The streak
// runs toward the FAR (south, +Z) edge — the same direction the sky glow sits.
const LAKE_CENTER_Z = HALF_MAP_M + BOUNDARY.waterLengthM / 2;
const LAKE_HALF_LEN = BOUNDARY.waterLengthM / 2;

interface WaterUniforms {
  uTime: { value: number };
  uShimmerAmp: { value: number };
  uShimmerScale: { value: number };
  uStreakIntensity: { value: number };
  uStreakFalloff: { value: number };
  uStreakColor: { value: Color };
  uCenterZ: { value: number };
  uHalfLen: { value: number };
}

function LakeWater() {
  // Shared uniform objects held in a ref (the mutable escape hatch): assigned into the
  // compiled shader in onBeforeCompile and mutated live by the useFrame below (three reads
  // uniform.value at upload each frame). Lazily built once — the ref is stable across renders.
  const uniformsRef = useRef<WaterUniforms | null>(null);
  if (uniformsRef.current === null) {
    uniformsRef.current = {
      uTime: { value: 0 },
      uShimmerAmp: { value: RENDERING.water.shimmerAmplitude },
      uShimmerScale: { value: RENDERING.water.shimmerScale },
      uStreakIntensity: { value: RENDERING.water.streakIntensity },
      uStreakFalloff: { value: RENDERING.water.streakFalloff },
      uStreakColor: { value: new Color(RENDERING.water.streakColor) },
      uCenterZ: { value: LAKE_CENTER_Z },
      uHalfLen: { value: LAKE_HALF_LEN },
    };
  }

  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ color: WATER_COLOR });
    m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
      if (uniformsRef.current) Object.assign(shader.uniforms, uniformsRef.current);
      // Carry world position to the fragment stage (MeshStandard doesn't expose one by default).
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n        varying vec3 vWorldPosW;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n        vWorldPosW = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
        uniform float uTime;
        uniform float uShimmerAmp;
        uniform float uShimmerScale;
        uniform float uStreakIntensity;
        uniform float uStreakFalloff;
        uniform vec3 uStreakColor;
        uniform float uCenterZ;
        uniform float uHalfLen;
        varying vec3 vWorldPosW;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
        float wave = sin(vWorldPosW.x * uShimmerScale + uTime)
                   * sin(vWorldPosW.z * uShimmerScale * 1.3 - uTime * 0.7);
        float glint = uShimmerAmp * wave;
        float southness = clamp((vWorldPosW.z - uCenterZ) / uHalfLen * 0.5 + 0.5, 0.0, 1.0);
        float streak = pow(southness, uStreakFalloff) * uStreakIntensity;
        totalEmissiveRadiance += uStreakColor * (streak + glint);`,
        );
    };
    m.customProgramCacheKey = (): string => 'lake-shimmer-v1';
    return m;
  }, []);

  useEffect(() => () => material.dispose(), [material]);

  // Advance the shimmer clock + re-read the leva-live tunables (cheap; keeps sliders honest).
  useFrame((_, dt) => {
    const u = uniformsRef.current;
    if (!u) return;
    u.uTime.value += dt * RENDERING.water.shimmerSpeed;
    u.uShimmerAmp.value = RENDERING.water.shimmerAmplitude;
    u.uShimmerScale.value = RENDERING.water.shimmerScale;
    u.uStreakIntensity.value = RENDERING.water.streakIntensity;
    u.uStreakFalloff.value = RENDERING.water.streakFalloff;
  });

  return (
    <mesh
      position={[0, WATER_VISUAL_Y, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      frustumCulled={false}
      material={material}
    >
      <planeGeometry args={[BOUNDARY.waterWidthM, BOUNDARY.waterLengthM]} />
    </mesh>
  );
}

/** Defensive read of the (Phase 19 Task 1) Kensington district id from WorldData. That seam
 * isn't typed on WorldData yet (Task 1 adds `world.landmarks`), so read it structurally and
 * validate — returns undefined until the generator publishes it, so the boost is a safe no-op
 * pre-landmarks. */
function readKensingtonDistrictId(world: WorldData): number | undefined {
  const landmarks = (world as { landmarks?: { kensingtonDistrictId?: unknown } }).landmarks;
  const id = landmarks?.kensingtonDistrictId;
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < DISTRICT_COUNT
    ? id
    : undefined;
}

export function CityScape({ world }: CityScapeProps) {
  // City root: publishes the live WorldData + this run's spawn pose to the module-scope
  // refs debug tooling (hud/Minimap.tsx, world/GraphViz.tsx) and the orchestrator's
  // spawn/reset wiring read outside React's props tree (worldRef.ts / spawn.ts doc
  // comments). Reassigned wholesale — never mutated in place — so identity checks upstream
  // (e.g. GraphViz's useMemo) stay correct.
  useEffect(() => {
    worldRef.current = world;
    spawnPoseRef.current = getSpawnPose(world);
  }, [world]);

  // Kensington market-block emissive boost (Phase 19, TDD §13): once the generator publishes a
  // Kensington district (Task 1's world.landmarks.kensingtonDistrictId), brighten its lit
  // windows/props so the market block reads denser/warmer — the "money clip" a Kensington
  // blackout then snuffs out. Runs AFTER CityArchetypes' child effect has registered the
  // archetype handles (React fires child effects before parent effects), so the boost lands on
  // built meshes. A market-prop mount that lands later re-invokes applyKensingtonBoost itself
  // (idempotent) to cover its own string-light archetype. No-op until landmarks land.
  useEffect(() => {
    const kensington = readKensingtonDistrictId(world);
    if (kensington !== undefined) applyKensingtonBoost(kensington);
  }, [world]);

  // Fell-out-of-world safety net (see BOUNDARY.fellOutResetY's comment for the two ways a
  // chassis can legitimately end up in free fall today). A per-frame y check against the
  // raw pose is enough — no physics hooks needed, and a frame of latency is irrelevant at
  // a -30 m trigger depth.
  useFrame(() => {
    const model = playerVehicle.current;
    if (model && model.readState().rawPose.position.y < BOUNDARY.fellOutResetY) {
      model.reset(spawnPoseRef.current);
    }
  });

  const roadGeometry = useMemo(
    () => buildTileQuadGeometry(world.tiles, (t) => t.type === 'road', ROAD_Y),
    [world],
  );
  useEffect(() => () => roadGeometry.dispose(), [roadGeometry]);

  const overlayGeometry = useMemo(
    () =>
      buildTileQuadGeometry(
        world.tiles,
        (t) => t.type === 'park' || t.type === 'parkingLot' || t.type === 'transformerLot',
        OVERLAY_Y,
        overlayColorOf,
      ),
    [world],
  );
  useEffect(() => () => overlayGeometry.dispose(), [overlayGeometry]);

  // Phase 18 tri-trim: the parked-car + scenery keep-fractions for the CURRENT quality tier,
  // captured ONCE at mount via a lazy useState initializer (NOT a reactive subscription — a
  // mid-run quality change must not rebuild the whole city + colliders; density applies on
  // the next keyed remount, per core/quality.ts). Stable across renders, so the memo below
  // stays honest.
  const [{ parkedCarKeepFraction, sceneryKeepFraction }] = useState(() => {
    const tier = QUALITY_TIERS[useGameStore.getState().settings.quality];
    return {
      parkedCarKeepFraction: tier.parkedCarKeepFraction,
      sceneryKeepFraction: tier.sceneryKeepFraction,
    };
  });

  // Instanced archetypes (Phase 5): buildings + street props via the palette/instancing
  // layer. Assembled ONCE per world — the sorted sets feed both the renderer below and
  // (once mounted) the collider layer, keeping instanceId agreement (see CityArchetypes'
  // header invariant).
  const instanceSets = useMemo(
    () => buildCityInstanceSets(world, { parkedCarKeepFraction, sceneryKeepFraction }),
    [world, parkedCarKeepFraction, sceneryKeepFraction],
  );

  // Boundary barriers: visual-only InstancedMesh (3 instances); physics colliders are
  // separate fixed RigidBodies below, decoupled from the visual mesh (draw-call budget
  // doesn't apply to physics bodies).
  const barriersRef = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = barriersRef.current;
    if (!mesh) return;
    const dummy = new Object3D();
    BARRIER_SPECS.forEach((spec, i) => {
      dummy.position.set(...spec.position);
      dummy.scale.set(...spec.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, []);

  // WATER sensor intersection (senses vehicles only — collision.ts's WATER filter). Only
  // the player exists as of Phase 4, so any intersection IS the player; Phase 7/9 (civilian/
  // pursuit vehicles) can keep this as-is since the event itself carries no payload yet.
  const handleWaterEnter = useCallback(() => {
    gameEvents.emit('enteredWater', {});
    if (import.meta.env.DEV) console.info('[world] enteredWater');
  }, []);

  const waterCenterZ = HALF_MAP_M + BOUNDARY.waterLengthM / 2;

  return (
    <>
      {/* Blue-hour lighting rig (Phase 5, TDD §8.1-8.2): dusk key with a player-following,
          texel-quantized shadow frustum + hemisphere ambient + gradient sky/fog + ACES
          tone mapping. Owns all scene/renderer lighting state; see world/lighting.ts. */}
      <BlueHourRig />

      {/* Ground: the ONE thing wheel rays are allowed to hit (GROUND membership) — see the
          file header. Spans the whole 640x640 map plus a margin under the boundary ring. The
          slab's TOP face stays at y=0 (the wheel-ray contract); its thickness only extends
          downward (BOUNDARY.groundThicknessM), so a chassis can never exit a thin underside
          during a stall — defense-in-depth behind the vehicle's fall-through catch. */}
      <RigidBody type="fixed" colliders="cuboid" collisionGroups={GROUND_GROUPS}>
        <mesh position={[0, -GROUND_THICKNESS_M / 2, 0]} receiveShadow>
          <boxGeometry args={[GROUND_SIZE_M, GROUND_THICKNESS_M, GROUND_SIZE_M]} />
          <meshStandardMaterial color={GROUND_COLOR} />
        </mesh>
      </RigidBody>

      {/* Roads: one merged draw call, single darker material, no collider (the ground
          slab underneath already holds the car up). */}
      <mesh geometry={roadGeometry} frustumCulled={false} receiveShadow>
        <meshStandardMaterial color={ROAD_COLOR} />
      </mesh>

      {/* Parks / parking lots / transformer lots: one merged, vertex-coloured overlay. */}
      <mesh geometry={overlayGeometry} frustumCulled={false} receiveShadow>
        <meshStandardMaterial vertexColors />
      </mesh>

      {/* Buildings + street props: real instanced archetypes (palette material, district-
          grouped buffers, emissive plumbing) + their fixed colliders, both fed the SAME
          sorted sets so registry instanceIds and mesh instances agree (cityInstances.ts). */}
      <CityArchetypes sets={instanceSets} />
      <WorldColliders sets={instanceSets} />

      {/* Boundary barriers: one visual InstancedMesh (3 instances)... */}
      <instancedMesh ref={barriersRef} args={[undefined, undefined, BARRIER_SPECS.length]} frustumCulled={false} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={BARRIER_COLOR} />
      </instancedMesh>
      {/* ...and separate fixed BUILDING-membership colliders, one per edge (decoupled from
          the visual mesh above — physics bodies aren't draw calls). */}
      {BARRIER_SPECS.map((spec, i) => (
        <RigidBody key={i} type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
          <CuboidCollider
            args={[spec.size[0] / 2, spec.size[1] / 2, spec.size[2] / 2]}
            position={spec.position}
          />
        </RigidBody>
      ))}

      {/* Lakefront: south-edge water plane + WATER sensor (senses vehicles only). Collider
          is decoupled from — and taller than — the thin visual plane so it reliably catches
          a vehicle driving off the edge near y=0 regardless of suspension bounce. */}
      <RigidBody
        type="fixed"
        colliders={false}
        sensor
        collisionGroups={WATER_GROUPS}
        position={[0, 0, waterCenterZ]}
      >
        <CuboidCollider
          args={[BOUNDARY.waterWidthM / 2, BOUNDARY.waterColliderHeightM / 2, BOUNDARY.waterLengthM / 2]}
          sensor
          onIntersectionEnter={handleWaterEnter}
        />
        {/* Lakefront shimmer plane (Phase 19): slow shimmer + warm streak toward the horizon
            glow, sharing this RigidBody's transform (world position feeds the streak). */}
        <LakeWater />
      </RigidBody>
    </>
  );
}
