// Phase 22 — the drivable Toronto "thermometer" map. Originally built behind the dev-only
// `torontoMap` leva toggle; Phase 32 (the flip, config/worldSource.ts) removed that toggle and
// made this the unconditionally-mounted shipped world — game/index.tsx no longer has a legacy
// branch to swap with. Everything the Finch→Union drive needs and nothing Phase 23 threw away:
//   • GROUND — the three §1 polygon rects (capsule / fold corridor / downtown) as one merged
//     flat mesh + three fixed GROUND-group cuboid colliders whose TOP face sits at y=0 (the
//     wheel-ray contract, same as world/CityScape.tsx's slab);
//   • WATER — a distinct lake plane + a WATER-group SENSOR wired exactly like the legacy water
//     sensor (onIntersectionEnter → gameEvents.emit('enteredWater')), so combat/runLoop.ts's
//     existing water-death path fires. RunLoopSystem is mounted here (it owns that path + the
//     run lifecycle) since the legacy tree that normally carries it isn't mounted in this branch;
//   • ROADS — buildRibbons() as ONE merged, per-class vertex-coloured BufferGeometry (single
//     draw call), a hair above the ground;
//   • SIGNPOSTS — the four §1 exits as instanced posts + CanvasTexture label boards, yawed 45°
//     to face the fixed §5.3 camera;
//   • TUNNEL EMISSION — a physics-step-aligned fold-crossing stepper (world/toronto/tunnel.ts's
//     createFoldTrigger) that emits `tunnelTransit` (hud/TunnelOverlay.tsx already listens);
//   • CAMERA CLAMP — the padded-polygon clamp that keeps the camera's frustum off the void,
//     registered into fx/cameraRig's position-constraint seam on mount (Phase 34 — it used to be
//     a late priority-2 pass with a second gl.render(); see clampCameraPos below);
//   • OCCLUSION v2 + ANTI-CLIP (Phase 36) — the per-frame A.5 pass (named/hero material fade PLUS
//     the batched/instanced screen-door fade, targeted by the now-production AABB clip index) and
//     the anti-clip guard registered into fx/cameraRig's second position seam.
// Lighting reuses world/BlueHourRig.tsx (its shadow frustum follows the player, so it is
// map-size-agnostic and self-restores scene state on unmount — clean when the toggle flips back).

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { CuboidCollider, RigidBody, useAfterPhysicsStep, type IntersectionEnterPayload } from '@react-three/rapier';
import {
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  NearestFilter,
  Object3D,
  PlaneGeometry,
  Raycaster,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
  type InstancedMesh,
  type PerspectiveCamera,
} from 'three';
import { BOUNDARY, QUALITY_TIERS, interactionGroups } from '../../config';
import { CAMERA_CLAMP_PADDING_WU, clampToPolygon } from './polygon';
import { WINDOW_PATTERN } from '../../config/torontoMaterials';
import { CORRIDOR_HALF_WIDTH_WU } from '../../config/tunnel';
import { TORONTO_BLACKOUT } from '../../config/torontoMap';
import { buildStreets } from './streets';
import { listIntersections } from './roadGraph';
import { buildDistricts, torontoDistrictIndex, torontoDistrictIndexAt } from './districts';
import { buildGroundTintRanges, darkenColorRange } from './groundTintBlackout';
import { RegisteredCuboidCollider, RegisteredCylinderCollider } from '../landmarks/registeredCollider';
import { torontoBuildingEntryAt } from './torontoColliders';
import { getEntity, type EntityEntry } from '../registry';
import { composeWorld } from './composeWorld';
import { buildRoadGeometry, buildSidewalkColliderBoxes } from './roadPaint';
import { type ParksLayout } from './parks';
import { GROUND_NOISE, buildNoiseField, sampleNoiseField } from './groundNoise';
import { BARRIER, SIDEWALK } from '../../config/torontoMap';
import { CityPackBatched } from './cityPack/CityPackBatched';
import { HERO_LOTS, type CrownDecal, type NamedBox, type NamedPlacement } from './namedBuildings';
import { buildCnTowerGeometry, buildRogersGeometry } from './heroes';
import { createCnNightMaterial, writeCnNightUniforms } from './cnNightMaterial';
import { resolveNightProgram } from './cnNightProgram';
import { createRogersNightMaterial, isHeroDistrictDark, writeRogersNightUniforms } from './rogersNightMaterial';
import { resolveRogersProgram } from './rogersProgram';
import { FADE_MAX, needsTransparent, occlusionFader, occlusionRegistry } from './occlusionFade';
import {
  clearClipIndex,
  eyeInsideAny,
  pointInsideAny,
  segmentHitCount,
  segmentHitFadeKeys,
  setClipIndex,
} from './cameraClipIndex';
import {
  cnBaseClipVolumes,
  cnShaftClipVolumes,
  heroCylinderClipVolume,
  rogersDomeClipVolumes,
} from './cnClipVolumes';
import { applyFadesFor, occlusionGate } from './occlusionTargets';
import { recordOcclusionPass } from './occlusionStats';
import { antiClipCameraPos, resetAntiClip } from './cameraAntiClip';
import { CAMERA } from '../../config/camera';
import { recordClampFired, recordOcclusionHits, sampleCameraClip } from './cameraClipStats';
import { liveCamera } from '../../fx/cameraRef';
import { getLogoAtlas, logoCellUv } from './logoAtlas';
import {
  type DiscSign,
  type PlaceBox,
  type PlacesLayer as PlacesLayerData,
  type SankofaProp,
} from './placesLayer';
import { createRng } from '../rng';
import { createFoldTrigger, type FoldTrigger } from './tunnel';
import { createOobTrigger, type OobTrigger } from './outOfBounds';
import { buildBarrierDressingGeometry, buildDeadEndColliders } from './worldEdgeGeometry';
import { gameEvents } from '../../state/events';
import { getGameState, useGameStore } from '../../state/store';
import { playerVehicle } from '../../vehicles/playerRef';
import { spawnPoseRef } from '../spawn';
import { setCameraAntiClip, setCameraPosConstraint, type Vec3 } from '../../fx/cameraRig';
import { BlueHourRig } from '../BlueHourRig';
import { RunLoopSystem } from '../../combat/runLoop';
import { LightPool } from '../../powergrid/LightPoolMount';
import { torontoStreetlightEmitters } from '../../powergrid/lightPool';
import { GROUND_STACK, WALL_STACK } from '../../config/layering';
import { resolveAnisotropy } from '../../config/surfaces';
import { useDevToggle } from '../../core/devToggles';
import { isWorldFrozen, simNowMs } from '../../core/simClock';
import { preloadCityPack } from '../../assets/cityPack';
import { CityPackPreview } from './cityPack/CityPackPreview';
import { CityDress } from './cityPack/CityDress';
import { RailLandsLayer } from './cityPack/RailLandsLayer';
import {
  GROUND_RECTS,
  SIGNPOSTS,
  TORONTO_SPAWN_POSE,
  WATER_RECT,
  rectWorldBox,
} from './torontoSceneHelpers';

// --- layout constants (visual-only y offsets; physics uses the collider slab below) ---------
// Every Y below is a RUNG of config/layering.ts's GROUND_STACK ladder (Phase 39 — LAW; see that
// module's header). The local names are kept for readability at the call sites; the VALUES live
// in one place. WATER_Y moved 0.05 → 0.06 as part of that migration: at 0.05 it was an exact tie
// with the helicopter searchlight's ground pool (SEARCHLIGHT.ground.yOffset), which strobed
// against the lake wherever the beam crossed the shore.
const GROUND_Y = GROUND_STACK.ground; // merged ground quads at the collider top face
const GROUND_TINT_Y = GROUND_STACK.districtTint; // district groundTint quads, above the base ground, below roads
const WATER_Y = GROUND_STACK.water; // lake plane above the ribbons and the decal layers
const GROUND_HALF_THICK = BOUNDARY.groundThicknessM / 2; // slab extends downward only; top at y=0
const POST_H = 6; // signpost pole height (m)
const BOARD_W = 14;
const BOARD_H = 3.5;
// Water sensor box centre (m): the collider spans y ∈ [−underlap, height − underlap], so it both
// underlaps the surface (catching an already-sinking chassis, as the old centred box did) and
// covers the full ballistic envelope above it — see BOUNDARY.waterColliderHeightM's Phase 37 note.
const WATER_SENSOR_CENTER_Y = BOUNDARY.waterColliderHeightM / 2 - BOUNDARY.waterColliderUnderlapM;
// Matches <Physics timeStep={1/60}> (game/index.tsx) — same convention as combat/runLoop.ts's and
// state/heatScoreSystem.tsx's FIXED_STEP_SEC. Feeds the out-of-bounds trigger's own sampling
// clock (useAfterPhysicsStep hands its callback no delta).
const PHYSICS_STEP_SEC = 1 / 60;

// Palette (component-local placeholders, same carve-out world/CityScape.tsx uses; Phase 23 owns
// the real Toronto palette). Muted district-neutral ground; lake matches the legacy WATER_COLOR.
// Matches the legacy CityScape ground exactly — the Phase 22 live pass proved the darker
// first cut (#3a4048) left roads indistinguishable from ground under blue-hour light.
// Phase 25.8 (D3 L3) ladder brighten: base ground #454b54 → #4d545e (+~11%). Stays above the
// asphalts, below the sidewalk. Only shows in fold notches / polygon slivers the district tints
// don't reach; the lift keeps those slivers reading as ground, not a dark void. Pre-brighten: #454b54.
const GROUND_COLOR = '#4d545e';
const WATER_COLOR = '#2f6f93';
const POST_COLOR = '#6b7280';

const GROUND_GROUPS = interactionGroups('GROUND');
const WATER_GROUPS = interactionGroups('WATER');
// Phase 23: filler massing colliders are indestructible fixed buildings (locked decision).
const BUILDING_GROUPS = interactionGroups('BUILDING');

// The lake band's world box, computed once (rectWorldBox is pure).
const WATER_BOX = rectWorldBox(WATER_RECT);

// Phase 37: every barrier-ring collider (the 11 land-edge walls AND the 19 dead-end "road closed"
// rows) registers this SAME entry — no districtId, no hp (an indestructible fixed wall segment;
// ramming one deals damage to the PLAYER like any other 'building' hit, combat/damage.ts's
// massFactorOf() default). One shared object so RegisteredCuboidCollider's registration effect
// (keyed on `entry`) never churns across renders.
const BARRIER_ENTRY: EntityEntry = { kind: 'barrier', districtId: -1 };

// --- polygon camera clamp (Phase 34) ------------------------------------------------------
// The world's half of fx/cameraRig's PROD-ACTIVE position-constraint seam: keep the camera eye at
// least CAMERA_CLAMP_PADDING_WU inside the §1 playable polygon so the frustum never reaches past a
// map edge and paints sky where ground should be (spec §1). Registered on mount below; the rig
// applies it to its own smoothed follow position every frame, so the clamp is part of the rig's
// state (it converges to the clamped point) rather than a correction painted over the top.
//
// Replaces the Phase-22..33 architecture: a priority-2 useFrame that ran AFTER CameraFxSystem's
// priority-1 update+render, wrote camera.position, re-aimed, and then had to fire a SECOND full
// gl.render() to make the correction visible — while the rig, whose lerp state it could not reach,
// re-generated the unclamped position on the very next frame. One render per frame again, and the
// re-aim is gone too because the rig's own lookAt now runs after the clamp, not before it.
//
// Module scope, not a component closure: the identity must be stable across renders so the mount
// effect registers/clears exactly one function (and a StrictMode double-mount is a no-op re-register
// of the same fn). The map-space probe is reused for the same no-per-frame-alloc reason cameraRig
// keeps its own scratch — clampToPolygon only allocates on the frames it actually clamps.
const clampProbe = { x: 0, y: 0 };
const clampCameraPos = (pos: Vec3): void => {
  // world [x,z] → map {x,y}; clampToPolygon returns the point unchanged when ≥ padding inside.
  clampProbe.x = pos.x;
  clampProbe.y = pos.z;
  const clamped = clampToPolygon(clampProbe, CAMERA_CLAMP_PADDING_WU);
  if (clamped.x === clampProbe.x && clamped.y === clampProbe.y) return;
  // Phase 33 counter, re-pointed by Phase 34: the frames the clamp ACTED on (it no longer costs a
  // second render — see cameraClipStats.ts). DEV-folded.
  if (import.meta.env.DEV) recordClampFired();
  pos.x = clamped.x;
  pos.z = clamped.y; // y (height) is never clamped — the polygon is a 2D map footprint.
};

/** Apply the occlusion fade to one material: opacity + `transparent` only WHILE fading (a fully
 * opaque surface stays in the cheap no-sort opaque pass). Structural type — every three Material
 * carries opacity/transparent, so no Material import is needed. */
function applyFade(material: { opacity: number; transparent: boolean }, opacity: number, transparent: boolean): void {
  material.opacity = opacity;
  material.transparent = transparent;
}

// Occlusion-fade hot-path scratch (module-level, mutated in-place in useFrame — same no-per-frame-
// alloc discipline as lookScratch; the fader singleton lives in occlusionFade.ts so debugBridge can
// read its minOpacity()).
const occlusionRay = new Raycaster();
const occlusionDir = new Vector3();
const occlusionHitKeys = new Set<string>();
const occlusionKeyList: string[] = [];

// --- Phase 36: occlusion v2 (dither path) hot-path scratch ---------------------------------
// Same no-per-frame-alloc discipline as the raycast scratch above: every collection below is
// module-scope and cleared/reused, so a pass that touches a few hundred keys allocates nothing.

/** The five boresight target points (x,y,z triples), rewritten each frame from the car's pose:
 * index 0 = the car centre, 1..4 = the corners of config/camera.ts's yaw-invariant probe box.
 * A flat Float64Array rather than five Vector3s — this is only ever read back as raw numbers by
 * segmentHitFadeKeys, and a flat buffer keeps the write loop branch-free. */
const PROBE_POINTS = 5;
const probeTargets = new Float64Array(PROBE_POINTS * 3);

/** Corner sign pairs for the four non-centre probes, paired with which of the two probe heights
 * each uses. Alternating heights across the diagonals samples BOTH the sill line and the roofline
 * over the car's whole footprint with five segments instead of nine — the two corners a streetwall
 * can cross first under the 45° yaw are on opposite diagonals, so this ordering never leaves a
 * whole height unprobed on the side the wall is actually on. */
const PROBE_CORNERS: readonly (readonly [number, number, boolean])[] = [
  [+1, +1, true], // +x/+z, roofline
  [+1, -1, false], // +x/−z, sill
  [-1, +1, false], // −x/+z, sill
  [-1, -1, true], // −x/−z, roofline
];

/** This frame's raw boresight hits (union over the five segments) — cleared and refilled. */
const ditherHitKeys = new Set<string>();
/** The hysteresis gate's held-occluded set for this frame (occlusionTargets.ts owns the clock). */
const ditherOccluded = new Set<string>();
/**
 * The ACTIVE fade set: every key that is occluded now, or was recently and has not finished
 * ramping back to full opacity. This is the pass's cost governor — the registry holds ~2,000
 * targets, of which a handful are ever moving, so stepping/writing the active set instead of the
 * whole registry keeps the pass inside its 0.2 ms budget (see occlusionTargets.ts's applyFadesFor).
 * Keys leave the set only once they are BOTH clear and fully restored, so nothing can be stranded
 * mid-fade.
 */
const ditherActiveKeys = new Set<string>();

/** Fade lookup handed to applyFadesFor — module scope so the pass doesn't allocate a closure. */
const ditherFadeOf = (key: string): number => occlusionFader.opacity(key);

/** Drop every scrap of per-frame occlusion state (world unmount / test isolation). The fader's own
 * per-key entries go with the active set, so a remount starts from "everything opaque". */
function resetDitherPassState(): void {
  for (const key of ditherActiveKeys) occlusionFader.forget(key);
  ditherActiveKeys.clear();
  ditherHitKeys.clear();
  ditherOccluded.clear();
  occlusionGate.clear();
}

// Phase 33 camera-lab scratch: the near-plane corner point under test, reused across the four
// corners and across frames (same no-per-frame-alloc discipline as the occlusion scratch above).
const nearCornerScratch = new Vector3();

/** Two-triangle +Y quad (world XZ) at height `y`, appended to positions/normals. Winding matches
 * world/CityScape.tsx's buildTileQuadGeometry (verified +Y face normal there). */
function pushQuad(
  positions: number[],
  normals: number[],
  uvs: number[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
): void {
  positions.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
  for (let i = 0; i < 6; i++) normals.push(0, 1, 0);
  // D6 world-planar UVs (x/z ÷ tileWu) so the shared ground-noise texture tiles across the world.
  const t = GROUND_NOISE.tileWu;
  uvs.push(x0 / t, z0 / t, x0 / t, z1 / t, x1 / t, z1 / t, x0 / t, z0 / t, x1 / t, z1 / t, x1 / t, z0 / t);
}

/** Build the shared D6 ground-noise CanvasTexture: one sample of the seeded tileable field
 * (groundNoise.ts) painted into a 256² luminance map, RepeatWrapping so world-planar UVs tile it.
 * Set as `map` on the unlit ground/tint/park materials → multiplies the vertex-colour ladder.
 *
 * Phase 41: `anisotropy` is the resolved per-tier level (config/surfaces.ts's resolveAnisotropy,
 * already capped by the renderer's max). This is THE grazing-angle texture in the Toronto world —
 * world-planar UVs, a full trilinear mip chain, ~11.6 texels/wu, and the 58° rig lays it right out
 * to the frame's top band, where an aniso-1 fetch collapses the along-view axis into a single mip
 * level's worth of blur. Threaded in from the mount site (the caller owns tier capture) so this
 * stays a pure function of its arguments. */
function makeGroundNoiseTexture(seed: number, anisotropy: number): CanvasTexture {
  const field = buildNoiseField(seed, GROUND_NOISE.lattice, GROUND_NOISE.lo, GROUND_NOISE.hi);
  const size = GROUND_NOISE.textureSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = anisotropy;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(size, size);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const lum = sampleNoiseField(field, px / size, py / size);
        const b = Math.round(lum * 255);
        const idx = (py * size + px) * 4;
        img.data[idx] = b;
        img.data[idx + 1] = b;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  tex.needsUpdate = true;
  return tex;
}

/** Merged flat geometry for the three ground rects (single draw call, one flat material). */
function buildGroundGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const rect of GROUND_RECTS) {
    // rect is map space; mapToWorld is the identity swap, so min/max X,Y ARE world x/z.
    pushQuad(positions, normals, uvs, rect.minX, rect.minY, rect.maxX, rect.maxY, GROUND_Y);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.computeBoundingSphere();
  return g;
}

/** Merged district groundTint quads (Phase 23), one per resolved district rect, per-vertex
 * coloured (single draw call). Sits just above the base ground and below the road ribbons, so
 * each block gets its §6 tint while roads still paint on top. Rendered LIT (MeshLambertMaterial
 * vertexColors) so filler-building shadows land on it — the P22 anomaly was Standard-specific;
 * the legacy world lights Lambert fine (see the live-pass note on the mesh below). */
function buildGroundTintGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const c = new Color();
  for (const { def, rects } of buildDistricts()) {
    c.set(def.groundTint);
    for (const rect of rects) {
      // rect is map space; mapToWorld is the identity swap, so min/max X,Y ARE world x/z.
      pushQuad(positions, normals, uvs, rect.minX, rect.minY, rect.maxX, rect.maxY, GROUND_TINT_Y);
      for (let i = 0; i < 6; i++) colors.push(c.r, c.g, c.b);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.computeBoundingSphere();
  return g;
}

// --- D7 parks: merged grass mesh (noise-textured, one draw call) ------------------------------
const PARK_GROUND_Y = GROUND_STACK.parkGround; // above the base ground / district tint, below the road ribbon
const PARK_GRASS_COLOR = '#3f5236'; // muted blue-hour green (unlit-literal); lighter than tints so
// the noise reads stronger on the grass than on the darker street tints (D6 note).

/** One merged vertex-coloured grass mesh for every park rect (world-planar UVs for the shared
 * noise map). Sits above the ground/tint, below the roads — a park never covers a ribbon (parks.ts
 * rejects any rect overlapping a ribbon). */
function buildParksGeometry(parks: ParksLayout): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const c = new Color(PARK_GRASS_COLOR);
  for (const p of parks.parks) {
    pushQuad(positions, normals, uvs, p.minX, p.minY, p.maxX, p.maxY, PARK_GROUND_Y);
    for (let i = 0; i < 6; i++) colors.push(c.r, c.g, c.b);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.computeBoundingSphere();
  return g;
}

/** A crisp text label baked to a CanvasTexture (system font — no troika/font-load into the game
 * chunk, unlike drei's <Text>). Opaque blue-hour sign board; toneMapped=false on the material so
 * it stays legible under the dusk exposure. */
function makeLabelTexture(text: string): CanvasTexture {
  const w = 512;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#12233b';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#4a6a8a';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.fillStyle = '#eaf2ff';
    ctx.font = 'bold 56px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** One signpost label board — a plane textured with the baked label, yawed +45° about Y so its
 * front normal points toward the fixed §5.3 camera (yaw 45°, over the player's +X/+Z shoulder). */
function SignBoard({ label, x, z }: { label: string; x: number; z: number }) {
  const texture = useMemo(() => makeLabelTexture(label), [label]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={[x, POST_H, z]} rotation={[0, Math.PI / 4, 0]}>
      <planeGeometry args={[BOARD_W, BOARD_H]} />
      <meshBasicMaterial map={texture} side={DoubleSide} toneMapped={false} />
    </mesh>
  );
}

// --- named-building facade textures (§4 windows) ------------------------------------------
// One CanvasTexture per named box: the flat §4 fill colour with a window pattern painted in, and
// a seeded ~35% of the window cells painted BRIGHT warm — on this unlit-literal slice (the P23
// verdict) those bright texels ARE the lit windows. NearestFilter + no mipmaps keep it crunchy
// (Addendum A.5). Sized to the box's dominant face so the grid reads at roughly one cell per
// storey/column; mapped 0..1 on every box face by the shared basic material.

/** Clamp a canvas dimension to the window-pattern px budget. */
function clampPx(px: number): number {
  return Math.max(WINDOW_PATTERN.minCanvasPx, Math.min(WINDOW_PATTERN.maxCanvasPx, px));
}

/** Bake one facade texture for a box, seeded by `key` (deterministic, stable per building). */
function makeFacadeTexture(box: NamedBox, key: string): CanvasTexture {
  const P = WINDOW_PATTERN;
  const wWu = box.hx * 2;
  const hWu = box.hy * 2;
  const W = clampPx(Math.round(wWu * P.pxPerWu));
  const H = clampPx(Math.round(hWu * P.pxPerWu));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const tex = new CanvasTexture(canvas);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    tex.needsUpdate = true;
    return tex;
  }
  const fill = box.look.fill;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, W, H);

  const dark = new Color(fill).multiplyScalar(0.5).getStyle(); // recessed glass / mullion
  const lit = box.look.windowTint;
  const rng = createRng(1).fork(key);

  const floors = Math.max(1, Math.round(hWu / P.floorHeightWu));
  const cols = Math.max(1, Math.round(wWu / P.columnPitchWu));
  const rowH = H / floors;
  const colW = W / cols;
  const gx = (colW * (1 - P.glazingFrac)) / 2; // horizontal window inset
  const gy = (rowH * (1 - P.glazingFrac)) / 2; // vertical window inset
  const winW = colW * P.glazingFrac;
  const winH = rowH * P.glazingFrac;

  const kind = box.look.windowKind;
  const bandTop = kind === 'storefront' ? Math.round(H * (1 - P.storefrontBandFrac)) : H;

  if (kind === 'storefront') {
    // Big bright ground-floor glazing band with a few dark mullions.
    ctx.fillStyle = lit;
    ctx.fillRect(0, bandTop, W, H - bandTop);
    ctx.fillStyle = dark;
    for (let cc = 0; cc <= cols; cc++) ctx.fillRect(cc * colW - 1, bandTop, 2, H - bandTop);
  }

  for (let cc = 0; cc < cols; cc++) {
    const x0 = cc * colW;
    if (kind === 'glass') {
      // Continuous vertical glass column (dark), lit windows scattered up it.
      ctx.fillStyle = dark;
      ctx.fillRect(x0 + gx, 0, winW, H);
    }
    for (let f = 0; f < floors; f++) {
      const yTop = H - (f + 1) * rowH; // floor 0 at the ground
      if (kind === 'storefront' && yTop >= bandTop) continue; // covered by the band
      const isLit = rng.next() < P.litFraction;
      if (kind === 'glass') {
        if (isLit) {
          ctx.fillStyle = lit;
          ctx.fillRect(x0 + gx, yTop + gy, winW, winH);
        }
      } else {
        // grid / storefront-upper: a punched window on the fill wall.
        ctx.fillStyle = isLit ? lit : dark;
        ctx.fillRect(x0 + gx, yTop + gy, winW, winH);
      }
    }
  }

  tex.needsUpdate = true;
  return tex;
}

/** A square plane for a CROWN/FASCIA decal, UV-sliced to the brand's atlas cell. The atlas grew
 * to a 7×3 grid in Phase 26, so BOTH axes are remapped: u into [u0,u1] and v into [v0,v1] (the
 * flipY-corrected cell rect logoCellUv returns). Row 0 (the Phase-24 banks) collapses to v0=0,
 * v1=1 there, so this stays byte-identical to the old single-row behaviour for the bank crowns
 * while any cell in rows 1–2 (the retail brands) now samples its OWN cell height instead of the
 * whole 3-row canvas — the shipped-bank-crown regression the logoAtlas header flagged. */
function makeDecalGeometry(
  size: number,
  brandUv: { u0: number; u1: number; v0: number; v1: number },
): PlaneGeometry {
  const geo = new PlaneGeometry(size, size);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i); // 0 or 1 across the plane
    const v = uv.getY(i); // 0 (bottom) or 1 (top) across the plane
    uv.setX(i, brandUv.u0 + u * (brandUv.u1 - brandUv.u0));
    uv.setY(i, brandUv.v0 + v * (brandUv.v1 - brandUv.v0));
  }
  uv.needsUpdate = true;
  return geo;
}

/** World transform for a CROWN decal on a box face (south = +Z front; east = +X, yawed +90°). */
function decalTransform(box: NamedBox, decal: CrownDecal): {
  position: [number, number, number];
  rotation: [number, number, number];
} {
  const y = decal.bandCenterFrac * box.hy * 2;
  // Phase 39: this was a hand-copied duplicate of torontoMaterials.ts's CROWN_DECAL.offsetWu —
  // two independently-editable copies of the same crown offset. Both now read the ladder's
  // `crownDecal` rung (config/layering.ts), so they cannot drift apart.
  const off = WALL_STACK.crownDecal; // proud of the face, no z-fight
  if (decal.face === 'south') {
    return { position: [box.cx, y, box.cz + box.hz + off], rotation: [0, 0, 0] };
  }
  return { position: [box.cx + box.hx + off, y, box.cz], rotation: [0, Math.PI / 2, 0] };
}

/**
 * The Phase-24 named landmark layer: one basic-material mesh per box (its baked facade texture),
 * one UV-sliced quad per CROWN decal (shared bank-logo atlas), and one BUILDING CuboidCollider
 * per box (matching the filler massing's fixed-body pattern). Textures/geometries are built once
 * (memoized) and disposed on unmount so a toggle flip / remount never leaks GPU memory.
 */
function NamedBuildingsLayer({ placements }: { placements: readonly NamedPlacement[] }) {
  // Phase 29 (D1): named boxes carry no districtId field of their own (street-referenced, not
  // district-referenced) — resolved spatially, once, against the same district rects every
  // other Toronto layer derives from.
  const districts = useMemo(() => buildDistricts(), []);
  // Flat box list (with its owning placement id → stable texture seed key).
  const boxes = useMemo(
    () => placements.flatMap((p) => p.boxes.map((box, i) => ({ box, key: `${p.id}#${i}` }))),
    [placements],
  );
  const textures = useMemo(() => boxes.map(({ box, key }) => makeFacadeTexture(box, key)), [boxes]);
  useEffect(() => () => textures.forEach((t) => t.dispose()), [textures]);

  // CROWN decals: shared atlas texture + one UV-sliced geometry per decal.
  const atlas = useMemo(() => getLogoAtlas(), []);
  const decals = useMemo(
    () =>
      placements.flatMap((p) =>
        p.decals.map((decal) => {
          const box = p.boxes[decal.boxIndex];
          const uv = logoCellUv(decal.brand);
          return {
            geometry: makeDecalGeometry(decal.size, uv),
            ...decalTransform(box, decal),
            key: `${p.id}-${decal.brand}-${decal.face}`,
          };
        }),
      ),
    [placements],
  );
  useEffect(() => () => decals.forEach((d) => d.geometry.dispose()), [decals]);

  // Register every box mesh as an occludable (Phase 25, A.5): the camera→car ray fades any of
  // these that stands between the camera and the player so the car is never fully hidden.
  const boxMeshRefs = useRef<(Mesh | null)[]>([]);
  useEffect(() => {
    const meshes = boxMeshRefs.current.filter((m): m is Mesh => m !== null);
    meshes.forEach((m) => occlusionRegistry.add(m));
    return () => meshes.forEach((m) => occlusionRegistry.remove(m));
  }, [boxes]);

  return (
    <>
      {/* Named building boxes — one mesh each (unique facade texture), UNLIT-literal like the
          filler massing, castShadow so P24's lit ground receives the skyline shadows later. */}
      {boxes.map(({ box, key }, i) => (
        <mesh
          key={key}
          ref={(m) => {
            boxMeshRefs.current[i] = m;
          }}
          position={[box.cx, box.hy, box.cz]}
          castShadow
          frustumCulled={false}
        >
          <boxGeometry args={[box.hx * 2, box.hy * 2, box.hz * 2]} />
          <meshBasicMaterial map={textures[i]} toneMapped={false} />
        </mesh>
      ))}

      {/* CROWN logo decals on the two camera-visible faces (§4 CROWN / Addendum A.2). */}
      {decals.map((d) => (
        <mesh key={d.key} geometry={d.geometry} position={d.position} rotation={d.rotation}>
          <meshBasicMaterial map={atlas.texture} transparent={false} toneMapped={false} side={DoubleSide} />
        </mesh>
      ))}

      {/* Indestructible fixed BUILDING colliders — one per box (massing.ts's fixed-body pattern).
          Phase 29 (D1): registered so ramming a named tower deals damage to the player instead of
          silently no-op'ing (combat/damage.ts requires both impact sides registered). */}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {boxes.map(({ box, key }) => (
          <RegisteredCuboidCollider
            key={key}
            entry={torontoBuildingEntryAt(torontoDistrictIndexAt(box.cx, box.cz, districts))}
            halfExtents={[box.hx, box.hy, box.hz]}
            position={[box.cx, box.hy, box.cz]}
          />
        ))}
      </RigidBody>
    </>
  );
}

/** Centre of a hero lot (map space = world XZ; mapToWorld is the identity swap). */
function lotCenter(lot: (typeof HERO_LOTS)[number]): { x: number; z: number } {
  return { x: (lot.minX + lot.maxX) / 2, z: (lot.minY + lot.maxY) / 2 };
}

/**
 * The Phase-25 hero layer: the CN Tower + Rogers Centre primitive meshes (world/toronto/heroes.ts)
 * dropped on the reserved rail-lands lots. Each is ONE vertex-coloured unlit mesh (single draw
 * call; the baked directional shade + emissive pod ring do the dimensional read — same UNLIT-
 * literal slice as every other Toronto surface). Colliders per §5: CN = one base cylinder over the
 * leg zone (~10.5 wu radius), Rogers = a ring-base cylinder (~33 wu radius), both BUILDING group.
 * Both meshes register as occludables so the camera→car fade (A.5) can see through them.
 */
function HeroesLayer() {
  const cn = useMemo(() => buildCnTowerGeometry(), []);
  const rogers = useMemo(() => buildRogersGeometry(), []);

  // Phase 44 — the night program. The CN mesh keeps its ONE unlit vertex-coloured material; the
  // patch (cnNightMaterial.ts) adds the LED ring / crest wash / floodwash / beacon strobe on top of
  // the baked colours, so the whole show is +0 draw calls.
  // Phase 45 — Rogers gets the SAME treatment through its own patched material (jumbotron colour
  // blocks / gate lintels / hotel windows): separate cache key, separate uniforms, separate slice
  // of the shared program alphabet, so three can never confuse the two and neither hero's shader
  // can light the other's geometry.
  const cnNight = useMemo(() => createCnNightMaterial(cn.meta.ringCells), [cn]);
  const rogersNight = useMemo(() => createRogersNightMaterial(rogers.meta.jumboCells), [rogers]);
  // Tonight's mode + palette (CN) and colour-block scheme (Rogers) are pure functions of the RUN
  // SEED (the same seed that keys the world), so a retry replays the same show. Memoized because
  // resolving allocates an rng.
  const seed = useGameStore((s) => s.seed);
  const nightProgram = useMemo(() => resolveNightProgram(seed), [seed]);
  const rogersProgram = useMemo(() => resolveRogersProgram(seed), [seed]);

  useEffect(
    () => () => {
      cn.geometry.dispose();
      rogers.geometry.dispose();
      cnNight.material.dispose();
      rogersNight.material.dispose();
    },
    [cn, rogers, cnNight, rogersNight],
  );

  // Phase 29 (D1): only two lots, spatial lookup is cheap — same district-resolution idiom as
  // NamedBuildingsLayer above. Resolved BEFORE the frame loop because the Rogers program needs its
  // district id every frame (the blackout read) and a per-frame rect walk would be waste.
  const districts = useMemo(() => buildDistricts(), []);

  const cnAt = lotCenter(HERO_LOTS[0]); // CN Tower (Part-8: BASE ≈ (950, 3390), compacted live)
  const rgAt = lotCenter(HERO_LOTS[1]); // Rogers Centre (Part-8: BASE ≈ (860, 3450), compacted live)
  const rogersDistrictId = useMemo(
    () => torontoDistrictIndexAt(rgAt.x, rgAt.z, districts),
    [rgAt.x, rgAt.z, districts],
  );

  // The one live seam: sim time in, uniforms out. `simNowMs()` (never wall clock, never useFrame's
  // own delta) is what makes the programs stop dead when the Phase 42 flicker harness freezes the
  // world — an animated hero that ignored the freeze would (correctly) trip the detector. BOTH
  // heroes read the SAME timestamp, so the two shows can never drift apart by a frame.
  // The stadium also takes its district's power state: unlike the tower — which is structurally
  // forbidden from knowing the grid exists, because a lit CN over a dark city IS the money shot —
  // Rogers DIMS with harbourfront, on a config-driven fade stepped by this same sim clock.
  useFrame(() => {
    const tMs = simNowMs();
    writeCnNightUniforms(cnNight.uniforms, nightProgram, tMs);
    writeRogersNightUniforms(rogersNight.uniforms, rogersProgram, tMs, isHeroDistrictDark(rogersDistrictId));
  });

  const cnRef = useRef<Mesh>(null);
  const rgRef = useRef<Mesh>(null);
  useEffect(() => {
    const meshes = [cnRef.current, rgRef.current].filter((m): m is Mesh => m !== null);
    meshes.forEach((m) => occlusionRegistry.add(m));
    return () => meshes.forEach((m) => occlusionRegistry.remove(m));
  }, []);

  return (
    <>
      <mesh
        ref={cnRef}
        geometry={cn.geometry}
        material={cnNight.material}
        position={[cnAt.x, 0, cnAt.z]}
        castShadow
        frustumCulled={false}
      />
      <mesh
        ref={rgRef}
        geometry={rogers.geometry}
        material={rogersNight.material}
        position={[rgAt.x, 0, rgAt.z]}
        castShadow
        frustumCulled={false}
      />
      {/* Base-cylinder colliders (§5 precedent from the P19 legacy tower): CN over the leg zone,
          Rogers a ring-base wall the car crashes into. Indestructible fixed BUILDING bodies.
          Phase 29 (D1): registered (spatial districtId lookup — both lots sit in harbourfront). */}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        <RegisteredCylinderCollider
          entry={torontoBuildingEntryAt(torontoDistrictIndexAt(cnAt.x, cnAt.z, districts))}
          halfHeight={cn.meta.collider.halfHeight}
          radius={cn.meta.collider.radius}
          position={[cnAt.x, cn.meta.collider.centerY, cnAt.z]}
        />
        <RegisteredCylinderCollider
          entry={torontoBuildingEntryAt(torontoDistrictIndexAt(rgAt.x, rgAt.z, districts))}
          halfHeight={rogers.meta.collider.halfHeight}
          radius={rogers.meta.collider.radius}
          position={[rgAt.x, rogers.meta.collider.centerY, rgAt.z]}
        />
      </RigidBody>
    </>
  );
}

// --- Phase 26/25.7 places / nostalgia layer (world/toronto/placesLayer.ts) ------------------
// Phase 25.7 shrank this: the 18 business venues moved onto claimed frontage facades (dressed by
// world/toronto/cityPack/VenueDressLayer.tsx). What renders here now is Sam the Record Man's
// spinning discs, the Apple-on-Eaton tag, the Sankofa screen, and the §6 vibe props. Perf
// discipline stays: the Sam-host + Sankofa boxes are ONE instancedMesh; every solid vibe prop
// (gate/umbrellas/patio/crosswalk) merges into ONE vertex-coloured mesh. UNLIT-literal
// (toneMapped=false) like every other Toronto surface (the P23/P24 verdict).

/** A circle UV-sliced to a brand's atlas cell — Sam the Record Man's neon disc face. */
function makeDiscGeometry(radius: number, brandUv: { u0: number; u1: number; v0: number; v1: number }): CircleGeometry {
  const g = new CircleGeometry(radius, 40);
  const a = g.attributes.uv;
  for (let i = 0; i < a.count; i++) {
    const u = a.getX(i);
    const v = a.getY(i);
    a.setX(i, brandUv.u0 + u * (brandUv.u1 - brandUv.u0));
    a.setY(i, brandUv.v0 + v * (brandUv.v1 - brandUv.v0));
  }
  a.needsUpdate = true;
  return g;
}

/** One spinning neon disc (Sam the Record Man). Spins about its own face normal (+Z) in useFrame —
 * the physical spin the two live screenshots catch at different phases. */
function SamDisc({ disc, texture }: { disc: DiscSign['discs'][number]; texture: CanvasTexture }) {
  const ref = useRef<Mesh>(null);
  const geo = useMemo(() => makeDiscGeometry(disc.radius, logoCellUv(disc.brand)), [disc]);
  useEffect(() => () => geo.dispose(), [geo]);
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.z -= Math.min(delta, 0.05) * 1.6;
  });
  return (
    <mesh ref={ref} geometry={geo} position={[disc.x, disc.y, disc.z]}>
      <meshBasicMaterial map={texture} toneMapped={false} side={DoubleSide} />
    </mesh>
  );
}

/** Sankofa screen colour-block frames (§6). Module-level (like every make*Texture fn) so the draw
 * mutates only the texture it's handed, never a render-captured value. */
const SANKOFA_PALETTES: readonly (readonly string[])[] = [
  ['#ff2d6f', '#ffd23f', '#1fd1a5'],
  ['#3ea6ff', '#ff7b3f', '#c14bff'],
  ['#ffe14d', '#ff3f6e', '#3fe0ff'],
];
function drawSankofaFrame(texture: CanvasTexture, frame: number): void {
  const img = texture.image as HTMLCanvasElement;
  const ctx = img.getContext('2d');
  if (!ctx) return;
  const p = SANKOFA_PALETTES[frame % SANKOFA_PALETTES.length];
  ctx.fillStyle = '#0a0d12';
  ctx.fillRect(0, 0, 64, 48);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = p[(i + frame) % p.length];
    ctx.fillRect((i % 3) * 21 + 2, Math.floor(i / 3) * 23 + 2, 18, 20);
  }
  texture.needsUpdate = true;
}
function makeSankofaTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 48;
  const t = new CanvasTexture(c);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = SRGBColorSpace;
  drawSankofaFrame(t, 0);
  return t;
}

/** Sankofa Square screen billboard — an animated colour-block face (§6), 3 frames swapped ~1 Hz. */
function SankofaScreen({ screen }: { screen: SankofaProp['screen'] }) {
  const acc = useRef(0);
  const frame = useRef(0);
  const texture = useMemo(() => makeSankofaTexture(), []);
  useEffect(() => () => texture.dispose(), [texture]);
  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current >= 1) {
      acc.current = 0;
      frame.current = (frame.current + 1) % 3;
      drawSankofaFrame(texture, frame.current);
    }
  });
  return (
    <mesh position={[screen.cx, screen.cy, screen.cz]} rotation={[0, screen.rotationY, 0]}>
      <planeGeometry args={[screen.width, screen.height]} />
      <meshBasicMaterial map={texture} toneMapped={false} side={DoubleSide} />
    </mesh>
  );
}

/** Seeded noisy multicolour graffiti texture (Queen West / Rush Lane). Deterministic per seed. */
function makeGraffitiTexture(seed: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 24;
  const tex = new CanvasTexture(canvas);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const rng = createRng(1).fork(seed);
    ctx.fillStyle = '#22222c';
    ctx.fillRect(0, 0, 96, 24);
    const palette = ['#e0245e', '#ffad1f', '#17bf63', '#1da1f2', '#794bc4', '#f45d22', '#f5f5f5'];
    for (let i = 0; i < 140; i++) {
      ctx.fillStyle = palette[Math.floor(rng.next() * palette.length)];
      ctx.fillRect(Math.floor(rng.next() * 96), Math.floor(rng.next() * 24), 1 + Math.floor(rng.next() * 6), 1 + Math.floor(rng.next() * 8));
    }
  }
  tex.needsUpdate = true;
  return tex;
}

/** ONE merged vertex-coloured geometry for every SOLID vibe prop: the Chinatown gate (posts +
 * lintel), Sugar Beach umbrellas (posts + pink canopy quads), King West patio (posts + warm light
 * strip), and the rainbow crosswalk stripes. Colliderless — cosmetic only. */
function buildVibeSolidsGeometry(layer: PlacesLayerData): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const c = new Color();
  const rgb = (hex: string): [number, number, number] => {
    c.set(hex);
    return [c.r, c.g, c.b];
  };
  const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, hex: string): void => {
    const [r, g, b] = rgb(hex);
    const faces: [number, number, number][][] = [
      [[cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]], // +Z
      [[cx + hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz - hz], [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz]], // -Z
      [[cx + hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz]], // +X
      [[cx - hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz - hz]], // -X
      [[cx - hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz]], // +Y
    ];
    const tri = [0, 1, 2, 0, 2, 3];
    for (const f of faces) {
      for (const k of tri) {
        pos.push(f[k][0], f[k][1], f[k][2]);
        nrm.push(0, 1, 0);
        col.push(r, g, b);
      }
    }
  };
  const flat = (minX: number, maxX: number, minZ: number, maxZ: number, y: number, hex: string): void => {
    const [r, g, b] = rgb(hex);
    const verts: [number, number, number][] = [
      [minX, y, minZ],
      [minX, y, maxZ],
      [maxX, y, maxZ],
      [maxX, y, minZ],
    ];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(verts[k][0], verts[k][1], verts[k][2]);
      nrm.push(0, 1, 0);
      col.push(r, g, b);
    }
  };

  const g = layer.gate;
  for (const p of g.posts) box(p.x, g.postTopY / 2, p.z, g.postThick / 2, g.postTopY / 2, g.postThick / 2, '#8f2f2f');
  box((g.lintel.minX + g.lintel.maxX) / 2, (g.lintel.y0 + g.lintel.y1) / 2, g.lintel.z, (g.lintel.maxX - g.lintel.minX) / 2, (g.lintel.y1 - g.lintel.y0) / 2, g.postThick / 2 + 0.2, '#c0392b');

  const u = layer.umbrellas;
  for (const un of u.units) {
    box(un.x, u.postTopY / 2, un.z, 0.2, u.postTopY / 2, 0.2, '#7a7a82');
    flat(un.x - u.discR, un.x + u.discR, un.z - u.discR, un.z + u.discR, u.discY, '#ff5fa2');
  }

  const pt = layer.patio;
  for (const p of pt.posts) box(p.x, pt.postTopY / 2, p.z, 0.2, pt.postTopY / 2, 0.2, '#5a4632');
  flat(pt.strip.minX, pt.strip.maxX, pt.strip.z - 0.15, pt.strip.z + 0.15, pt.strip.y, '#ffd98a');

  for (const s of layer.crosswalk.stripes) flat(s.minX, s.maxX, s.minZ, s.maxZ, layer.crosswalk.y, s.color);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The Phase-26/25.7 places / nostalgia layer scene component. Consumes the SHRUNK placesLayer.ts
 * data (the 18 business venues moved to VenueDressLayer) and emits: the Sam-host + Sankofa boxes as
 * one instancedMesh (+ BUILDING colliders), the Apple-on-Eaton logo decal, Sam's two spinning discs,
 * the animated Sankofa screen, the seeded graffiti wall, and one merged vibe-solids mesh.
 */
function PlacesLayer({ layer }: { layer: PlacesLayerData }) {
  const atlas = useMemo(() => getLogoAtlas(), []);
  // Phase 29 (D1): places boxes carry no districtId either — same spatial-lookup idiom.
  const districts = useMemo(() => buildDistricts(), []);

  // Sam-host + Sankofa boxes → one instancedMesh (per-instance colour) + colliders.
  const boxes = useMemo<PlaceBox[]>(
    () => [...layer.placements.filter((p) => p.box !== null).map((p) => p.box as PlaceBox), layer.sankofa.box],
    [layer],
  );
  const boxesRef = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = boxesRef.current;
    if (!mesh) return;
    const dummy = new Object3D();
    const color = new Color();
    boxes.forEach((b, i) => {
      dummy.position.set(b.cx, b.hy, b.cz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(b.hx * 2, b.hy * 2, b.hz * 2);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.set(b.color);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [boxes]);

  // Apple-on-Eaton: small logo-atlas decal (like a CROWN quad).
  const logoDecals = useMemo(
    () =>
      layer.logoDecals.map((d) => ({
        geometry: makeDecalGeometry(d.size, logoCellUv(d.brand)),
        position: [d.cx, d.cy, d.cz] as [number, number, number],
        rotation: [0, d.rotationY, 0] as [number, number, number],
        key: d.placeId,
      })),
    [layer],
  );
  useEffect(() => () => logoDecals.forEach((d) => d.geometry.dispose()), [logoDecals]);

  // Vibe props: merged solids + seeded graffiti wall.
  const vibeGeometry = useMemo(() => buildVibeSolidsGeometry(layer), [layer]);
  useEffect(() => () => vibeGeometry.dispose(), [vibeGeometry]);
  const graffitiTexture = useMemo(() => makeGraffitiTexture(layer.graffiti.seed), [layer.graffiti.seed]);
  useEffect(() => () => graffitiTexture.dispose(), [graffitiTexture]);

  return (
    <>
      {/* Sam-host / Sankofa boxes — one instancedMesh + fixed BUILDING colliders. */}
      {boxes.length > 0 ? (
        <instancedMesh ref={boxesRef} args={[undefined, undefined, boxes.length]} castShadow frustumCulled={false}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      ) : null}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {boxes.map((b, i) => (
          <RegisteredCuboidCollider
            key={i}
            entry={torontoBuildingEntryAt(torontoDistrictIndexAt(b.cx, b.cz, districts))}
            halfExtents={[b.hx, b.hy, b.hz]}
            position={[b.cx, b.hy, b.cz]}
          />
        ))}
      </RigidBody>

      {/* Apple-on-Eaton logo decal (shared logo atlas). */}
      {logoDecals.map((d) => (
        <mesh key={d.key} geometry={d.geometry} position={d.position} rotation={d.rotation}>
          <meshBasicMaterial map={atlas.texture} toneMapped={false} side={DoubleSide} />
        </mesh>
      ))}

      {/* Sam the Record Man — two spinning neon discs over Dundas Square. */}
      {layer.discs.discs.map((disc, i) => (
        <SamDisc key={i} disc={disc} texture={atlas.texture} />
      ))}

      {/* Sankofa Square animated screen + Queen West graffiti wall. */}
      <SankofaScreen screen={layer.sankofa.screen} />
      <mesh position={[layer.graffiti.cx, layer.graffiti.cy, layer.graffiti.cz]} rotation={[0, layer.graffiti.rotationY, 0]}>
        <planeGeometry args={[layer.graffiti.width, layer.graffiti.height]} />
        <meshBasicMaterial map={graffitiTexture} toneMapped={false} side={DoubleSide} />
      </mesh>

      {/* Merged solid vibe props: Chinatown gate, Sugar Beach umbrellas, King West patio, rainbow
          crosswalk (all colliderless, vertex-coloured, unlit-literal). */}
      <mesh geometry={vibeGeometry} frustumCulled={false}>
        <meshBasicMaterial vertexColors toneMapped={false} side={DoubleSide} />
      </mesh>
    </>
  );
}

export function TorontoScene() {
  // The store world seed (index.tsx keys this whole subtree on it, so "New city" in the garage
  // remounts + reseeds the massing). Read the same way index.tsx does.
  const seed = useGameStore((s) => s.seed);

  // Phase 25.5: city-pack proof-of-render cluster (dev-only, default off → this subtree renders
  // nothing and TorontoScene is byte-identical to before). `cityPackUnlit` is the D8 material A/B
  // arm. Reactive reads so a live toggle flip mounts the cluster / swaps its materials.
  const cityPackPreview = useDevToggle('cityPackPreview');
  const cityPackUnlit = useDevToggle('cityPackUnlit');

  // Street table + intersections: pure, deterministic, built once. The road geometry now folds the
  // ribbons + curbs + sidewalk bands + crosswalks + dash-skip into ONE merged mesh (roadPaint.ts).
  const streets = useMemo(() => buildStreets().streets, []);
  const intersections = useMemo(() => listIntersections(streets), [streets]);
  const groundGeometry = useMemo(() => buildGroundGeometry(), []);
  useEffect(() => () => groundGeometry.dispose(), [groundGeometry]);
  const tintGeometry = useMemo(() => buildGroundTintGeometry(), []);
  useEffect(() => () => tintGeometry.dispose(), [tintGeometry]);
  const roadGeometry = useMemo(() => buildRoadGeometry(streets, intersections), [streets, intersections]);
  useEffect(() => () => roadGeometry.dispose(), [roadGeometry]);

  // Phase 29 (D2): district-blackout VISUAL. Toronto has no per-archetype emissive instance
  // buffer to flip on transformerDestroyed (see groundTintBlackout.ts's header for why) — the
  // ground-tint mesh's own per-district vertex range is the substitute "district blackouts must
  // read" signal: darken that district's tint slice, once, the instant its power box dies.
  // Districts tracked in a Set for idempotency (a district's power can only fail once in a real
  // run, but this guards defensively the same way powergrid/grid.ts's own handler does).
  const groundTintRanges = useMemo(() => buildGroundTintRanges(buildDistricts()), []);
  useEffect(() => {
    const darkened = new Set<number>();
    const colorAttr = tintGeometry.getAttribute('color');
    if (!colorAttr) return;
    const colors = colorAttr.array as Float32Array;
    const off = gameEvents.on('transformerDestroyed', ({ districtId }) => {
      if (darkened.has(districtId)) return;
      const range = groundTintRanges.find((r) => r.districtIndex === districtId);
      if (!range) return;
      darkened.add(districtId);
      darkenColorRange(colors, range, TORONTO_BLACKOUT.groundTintDarkenFactor);
      colorAttr.needsUpdate = true;
    });
    return off;
  }, [tintGeometry, groundTintRanges]);

  // Phase 25.8 (D5): raised-sidewalk curb colliders (top at SIDEWALK.curbHeightWu), from the same
  // segment set the visual band uses. Gated by SIDEWALK.colliders (drive-feel kill-switch).
  const curbBoxes = useMemo(() => buildSidewalkColliderBoxes(streets, intersections), [streets, intersections]);

  // Phase 41: the ground-noise map's anisotropy — the tier's level (config/quality.ts) capped by
  // this renderer's real maximum. Captured once at mount, exactly like tierParams below: texture
  // parameters are only pushed at upload time, so a mid-run quality change lands on the next mount
  // regardless of how reactively we read it.
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());
  const [groundNoiseAnisotropy] = useState(() =>
    resolveAnisotropy(useGameStore.getState().settings.quality, maxAnisotropy),
  );

  // Phase 25.8 (D6): one shared ground-noise texture keyed on the seed (deterministic).
  const groundNoiseTex = useMemo(
    () => makeGroundNoiseTexture(seed, groundNoiseAnisotropy),
    [seed, groundNoiseAnisotropy],
  );
  useEffect(() => () => groundNoiseTex.dispose(), [groundNoiseTex]);

  // Phase 25.8 (D8): the quality-tier dress scaling, captured ONCE at mount via a lazy useState
  // initializer — NOT a reactive subscription, matching world/CityScape.tsx's
  // parkedCarKeepFraction/sceneryKeepFraction precedent exactly (see that file's doc comment). A
  // mid-run quality change must not thin buildings/furniture/colliders out from under a live run;
  // the new tier applies on the next mount (new seed or new run — Phase 32: this scene is now
  // always mounted, there is no toggle remount to also key off of).
  const [tierParams] = useState(() => {
    const tier = QUALITY_TIERS[useGameStore.getState().settings.quality];
    return {
      dressDensityScalar: tier.dressDensityScalar,
      frontageOccupancyScalar: tier.frontageOccupancyScalar,
      parkedCarKeepFraction: tier.parkedCarKeepFraction,
      lampOverlay: tier.lampOverlay,
    };
  });

  // PHASE 40 — THE ONE WORLD BUILD. `composeWorld` replaces the seven independent placement memos
  // this component used to hold (parks / named / places / worldEdge / frontage / furniture /
  // infill / venueDress): it builds the street skeleton once, threads ONE claim index through
  // every layer in the declared order, and hands back the finished city plus the camera clip
  // volumes projected straight off the claims it placed. Every consumer below reads from this.
  //
  // Dependencies are (seed, tierParams) exactly as before — tierParams is mount-captured and
  // stable, so a re-render never rebuilds the city and a run restart reproduces it exactly.
  const world = useMemo(() => composeWorld(seed, tierParams), [seed, tierParams]);
  const { parks, named, places, worldEdge, frontage, furniture, infill, dress, railLands } = world;

  // Phase 25.8 (D7): parks — the grass mesh + tree ring. The same rects gate the streetwall via
  // the arbiter's `parkRect` zone claims, so the streetwall gaps exactly where the mesh fills.
  const parksGeometry = useMemo(() => buildParksGeometry(parks), [parks]);
  useEffect(() => () => parksGeometry.dispose(), [parksGeometry]);
  const parkTreePlacements = useMemo(
    () => parks.trees.map((t) => ({ position: t.position, rotationY: t.rotationY })),
    [parks],
  );

  // Phase 37: the diegetic world-edge barrier ring (from the composed world — worldEdge.ts is
  // itself module-memoized). Colliders + dead-end rows mount below (BARRIER_ENTRY); dressing
  // renders as pack fence/cone runs (CityPackBatched) plus one merged procedural mesh
  // (worldEdgeGeometry.ts's hoarding/jersey/rail-post boxes).
  const deadEndColliders = useMemo(() => buildDeadEndColliders(), []);
  const barrierDressingGeometry = useMemo(() => buildBarrierDressingGeometry(), []);
  useEffect(() => () => barrierDressingGeometry.dispose(), [barrierDressingGeometry]);
  const fencePlacements = useMemo(
    () =>
      worldEdge.dressing
        .filter((d) => d.kind === 'fencePiece')
        .map((d) => ({ position: [d.x, 0, d.z] as const, rotationY: d.yawRad })),
    [worldEdge],
  );
  const conePlacements = useMemo(
    () =>
      worldEdge.dressing
        .filter((d) => d.kind === 'cone')
        .map((d) => ({ position: [d.x, 0, d.z] as const, rotationY: d.yawRad })),
    [worldEdge],
  );

  // Phase 30 (T2 debt-2): the LightPool adapter — Toronto has no 'streetlight' archetype, so
  // its traffic-light masts stand in as the pool's emitter source (powergrid/lightPool.ts's
  // torontoStreetlightEmitters), keyed to the SAME 15-district grid powergrid/grid.ts already
  // tracks for Toronto (torontoDistrictIndex — the mast's own DistrictId resolved once here).
  const torontoLightEmitters = useMemo(
    () =>
      torontoStreetlightEmitters(
        furniture.trafficLights.map((m) => ({ position: m.position, districtId: torontoDistrictIndex(m.districtId) })),
      ),
    [furniture],
  );

  // Preload every used pack GLB once the scene mounts (an effect, not module scope, so a build
  // that never mounts this component — e.g. a unit test importing the module in isolation —
  // fetches nothing). Covers frontage buildings, furniture props, parked cars, traffic lights,
  // the venue-dressing kit props, and the Phase 28 infill layer's fixed/decor/cone model ids.
  useEffect(() => {
    const ids = new Set<string>(frontage.modelIds);
    ids.add('traffic-light');
    ids.add('tree');
    ids.add('fire-hydrant');
    ids.add('bench');
    ids.add('trash-can');
    ids.add('bus-stop');
    ids.add('power-box');
    ids.add('stop-sign');
    ids.add('manhole-cover');
    ids.add(BARRIER.packModelIds.fencePiece); // Phase 37 world-edge ring dressing
    ids.add(BARRIER.packModelIds.cone);
    for (const car of furniture.parked.items) ids.add(car.modelId);
    for (const prop of dress.props) ids.add(prop.modelId);
    for (const s of frontage.cornerFills) ids.add(s.modelId);
    for (const f of infill.fixed) ids.add(f.modelId);
    for (const d of infill.decor) ids.add(d.modelId);
    for (const c of infill.cones) ids.add(c.modelId);
    preloadCityPack([...ids]);
  }, [frontage, furniture, dress, infill]);

  // Publish this slice's spawn pose so devPanel's "teleport reset" (and core/debugBridge.ts's
  // `reset()`) send the car back to spawn, not the legacy map centre — the Toronto equivalent of
  // world/CityScape.tsx setting spawnPoseRef from getSpawnPose(world). world/CityScape.tsx
  // re-sets it from the legacy pose whenever the toggle flips back off (it remounts then).
  useEffect(() => {
    spawnPoseRef.current = TORONTO_SPAWN_POSE;
  }, []);

  // --- signpost posts: one InstancedMesh (single draw call) --------------------------------
  const postsRef = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = postsRef.current;
    if (!mesh) return;
    const dummy = new Object3D();
    SIGNPOSTS.forEach((s, i) => {
      dummy.position.set(s.x, POST_H / 2, s.y); // world x = s.x, world z = s.y (identity map)
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, []);

  // --- tunnel fold-crossing emission (physics-step aligned) --------------------------------
  // Lazily built once (a fresh trigger per mount = correct re-arm state on retry). Fed the
  // player's MAP position each step (world [x,z] → map {x,y}, the inverse identity swap);
  // fires only inside the Yonge corridor and only on ENTERING the fold band (tunnel.ts).
  const foldTrigger = useRef<FoldTrigger | null>(null);
  if (foldTrigger.current === null) foldTrigger.current = createFoldTrigger(CORRIDOR_HALF_WIDTH_WU);
  useAfterPhysicsStep(() => {
    if (getGameState().machine !== 'PLAYING') return;
    const model = playerVehicle.current;
    if (!model) return;
    const p = model.readState().rawPose.position;
    const dir = foldTrigger.current?.step(p.x, p.z);
    if (dir) gameEvents.emit('tunnelTransit', { direction: dir });
  });

  // --- out-of-bounds backstop (Phase 37) ---------------------------------------------------
  // Replaces the old fell-out-of-world net, which silently teleported a falling chassis back to
  // spawn (BOUNDARY.fellOutResetY) — a pose jump mid-run that hid the failure instead of
  // resolving it. The map edge is now a diegetic barrier ring (worldEdge.ts) plus this
  // guaranteed backstop: leaving the polygon past the ring, or dropping below the slab, ends the
  // run as WRECKED like any other death.
  //
  // Same shape as the fold trigger above: lazily built once per mount (a fresh trigger per run,
  // so the latch state is always correct on retry), fed the player's PHYSICS-truth position
  // (rawPose — the interpolated render pose can lag a fast excursion), stepped on the physics
  // step. outOfBounds.ts owns the semantics: 10 Hz sampling, 0.5 s of CONSECUTIVE out-of-bounds
  // samples, fires exactly once. The lake is inside the polygon and stays the WATER sensor's
  // (enteredWater) — this never competes with it.
  const oobTrigger = useRef<OobTrigger | null>(null);
  if (oobTrigger.current === null) oobTrigger.current = createOobTrigger();
  useAfterPhysicsStep(() => {
    if (getGameState().machine !== 'PLAYING') return;
    const model = playerVehicle.current;
    if (!model) return;
    const p = model.readState().rawPose.position;
    if (oobTrigger.current?.step(p.x, p.y, p.z, PHYSICS_STEP_SEC)) {
      gameEvents.emit('leftWorld', {});
    }
  });

  // --- occlusion fade (A.5): the car is never fully hidden -----------------------------------
  // A.5: "any mesh between the lens and the car fades to ≤ 0.4 alpha within 150 ms" and restores
  // when the view clears. Phase 36 (occlusion v2) makes that promise cover the whole city instead
  // of the ~18 meshes that happen to own a material each. TWO paths run here, in one pass:
  //
  //   (1) NAMED/HERO — the original material-opacity path (occlusionFade.ts's registry + a
  //       camera→car raycast over ~18 static meshes). Kept as-is because it is tested, it carries
  //       A.5's mandatory cases (the financial-district banks, the CN Tower), and the
  //       occlusionMinOpacity probe rides it. Phase 36 paid its one recorded debt: the restore used
  //       to drive every material's opacity to 1, stomping any authored sub-1 opacity the first
  //       time the camera passed behind it (a one-way trip — nothing remembered the original). The
  //       base is now captured on first sight and the fade is applied as fade × base.
  //   (2) BATCHED/INSTANCED — everything else (the pack streetwall, back lots, backdrop towers):
  //       per-instance SCREEN-DOOR fade (cityPack/occlusionDither.ts), targeted by the AABB clip
  //       index rather than a raycast (a BatchedMesh raycast would walk every instance's BVH per
  //       frame; the bucket grid answers a segment query in about a cell). Path (2) can only ever
  //       touch volumes the index gave a fade key, and named/hero volumes carry `fadeKey: null`
  //       precisely so the two paths can never fight over one mesh.
  //
  // The v2 shape, per frame: 5 boresight segments (car centre + the four corners of the
  // config/camera.ts probe box — one centre ray misses the corner-grazing wall that P35's census
  // found on 187/1268 frames) → union of hit fade keys → 150 ms hysteresis hold (kills the
  // graze-strobe in BOTH directions) → the fade state machine → per-instance writes.
  //
  // Runs at the default priority so every opacity/fade is set BEFORE fx/cameraRig's priority-1
  // render. Cost: budgeted at ≤ 0.2 ms/frame and measured (dev) into occlusionStats.ts — see
  // ditherActiveKeys above for the reason it stays there. Zero extra draw calls by construction.
  useFrame((state, delta) => {
    const model = playerVehicle.current;
    if (!model) return;
    // Phase 42 (core/simClock.ts): while the world is frozen this pass HOLDS — the faded key set,
    // every fade level and the 150 ms hysteresis timers stay exactly where the freeze caught them.
    // Skipping is the latch: nothing here mutates unless it runs. Two reasons it must not run: the
    // detector's camera jitter would re-run the boresight segments and could flip a grazing key's
    // occluded state mid-capture (a fade transition reads as flicker, and it isn't one), and the
    // hysteresis clock is wall-clock (`nowMs` below), so it would keep counting down through a
    // multi-second freeze even though no frame in between was ever painted.
    if (isWorldFrozen()) return;
    const nowMs = performance.now();
    const car = model.readState().pose.position;
    const cam = state.camera;
    const dtMs = Math.min(delta * 1000, 100); // clamp big gaps (tab refocus) so a fade never jumps

    // (1) named/hero meshes — raycast + material opacity.
    const meshes = occlusionRegistry.meshes;
    if (meshes.length > 0) {
      occlusionDir.set(car.x - cam.position.x, car.y - cam.position.y, car.z - cam.position.z);
      const dist = occlusionDir.length();
      if (dist >= 1e-3) {
        occlusionDir.multiplyScalar(1 / dist);
        occlusionRay.set(cam.position, occlusionDir);
        occlusionRay.near = 0;
        occlusionRay.far = dist; // only occluders BETWEEN camera and car
        const hits = occlusionRay.intersectObjects(meshes as Object3D[], false);
        // Phase 33 clip instrumentation: the boresight occluder count is already computed right
        // here, so the stat piggybacks the existing ray rather than casting a second one. DEV-folded.
        if (import.meta.env.DEV) recordOcclusionHits(hits.length);
        occlusionHitKeys.clear();
        for (const h of hits) occlusionHitKeys.add(h.object.uuid);
        occlusionKeyList.length = 0;
        for (const m of meshes) occlusionKeyList.push(m.uuid);
        occlusionFader.step(occlusionKeyList, occlusionHitKeys, dtMs);
        for (const m of meshes) {
          const mat = (m as Mesh).material;
          // Capture the AUTHORED opacity before this pass has ever written to the material — the
          // loop below is the only writer, and captureBaseOpacity is first-sight-only, so reading
          // it here is always reading the original. Array materials capture from the first slot:
          // the fade is a per-MESH decision, and no registered occluder ships a multi-material
          // mesh with differing authored opacities (heroes' pod ring is its own mesh).
          const first = Array.isArray(mat) ? mat[0] : mat;
          if (first) occlusionFader.captureBaseOpacity(m.uuid, first.opacity);
          const opacity = occlusionFader.appliedOpacity(m.uuid);
          const transparent = needsTransparent(opacity);
          if (Array.isArray(mat)) {
            for (const mm of mat) applyFade(mm, opacity, transparent);
          } else {
            applyFade(mat, opacity, transparent);
          }
        }
      }
    }

    // (2) batched/instanced — 5 boresight segments against the clip index, then the dither writes.
    const probe = CAMERA.occlusionProbe;
    probeTargets[0] = car.x;
    probeTargets[1] = car.y;
    probeTargets[2] = car.z;
    for (let i = 0; i < PROBE_CORNERS.length; i++) {
      const [sx, sz, high] = PROBE_CORNERS[i]!;
      const o = (i + 1) * 3;
      probeTargets[o] = car.x + sx * probe.xzM;
      probeTargets[o + 1] = car.y + (high ? probe.highM : probe.lowM);
      probeTargets[o + 2] = car.z + sz * probe.xzM;
    }
    ditherHitKeys.clear();
    for (let i = 0; i < PROBE_POINTS; i++) {
      const o = i * 3;
      segmentHitFadeKeys(
        cam.position.x,
        cam.position.y,
        cam.position.z,
        probeTargets[o]!,
        probeTargets[o + 1]!,
        probeTargets[o + 2]!,
        ditherHitKeys,
      );
    }
    occlusionGate.markHits(ditherHitKeys, nowMs);
    occlusionGate.collectOccluded(ditherOccluded, nowMs);
    for (const key of ditherOccluded) ditherActiveKeys.add(key);
    if (ditherActiveKeys.size > 0) {
      occlusionFader.step(ditherActiveKeys, ditherOccluded, dtMs);
      applyFadesFor(ditherActiveKeys, ditherFadeOf);
      // Retire keys that are BOTH clear and fully restored. The write above already pushed their
      // final 1.0 through, so dropping them here (and forgetting their fader state) bounds both
      // sets by "what is currently moving" rather than by session length.
      for (const key of ditherActiveKeys) {
        if (!ditherOccluded.has(key) && occlusionFader.opacity(key) >= FADE_MAX) {
          ditherActiveKeys.delete(key);
          occlusionFader.forget(key);
        }
      }
    }

    if (import.meta.env.DEV) {
      let min: number = FADE_MAX;
      let faded = 0;
      for (const key of ditherActiveKeys) {
        const f = occlusionFader.opacity(key);
        if (f < FADE_MAX) faded++;
        if (f < min) min = f;
      }
      recordOcclusionPass(faded, min, performance.now() - nowMs);
    }
  });

  // --- camera clamp registration (Phase 34) ------------------------------------------------
  // Hand the polygon clamp (module scope above) to fx/cameraRig's position-constraint seam for as
  // long as this world is mounted, and take it back on unmount so a world swap / run remount can
  // never leave a stale clamp shaping a camera over a different map. Empty deps + a module-scope
  // fn = one register per mount; under StrictMode's mount → cleanup → mount the last write wins
  // and the constraint ends up registered (Phase 30's StrictMode registration bug was exactly the
  // opposite shape — a registration that survived its own cleanup).
  useEffect(() => {
    setCameraPosConstraint(clampCameraPos);
    return () => setCameraPosConstraint(null);
  }, []);

  // --- camera anti-clip registration (Phase 36) --------------------------------------------
  // The second prod-active rig seam, applied right after the clamp (fx/cameraRig.ts documents why
  // that order is the safe one): if the eye ends up inside building volume — the death beat's
  // measured excursions, a respawn beside a tower — pull it along the boresight to the first clear
  // point. Same module-scope-fn + empty-deps discipline as the clamp above; the state reset on
  // mount/unmount keeps a run restart from inheriting the previous run's ramp.
  useEffect(() => {
    resetAntiClip();
    setCameraAntiClip(antiClipCameraPos);
    return () => {
      setCameraAntiClip(null);
      resetAntiClip();
    };
  }, []);

  // --- static building AABB index (Phase 33; PROD-ACTIVE since Phase 36; SOURCED FROM THE
  // PLACEMENT ARBITER since Phase 40) -------------------------------------------------------
  // The volumes are `world.clipVolumes` — a projection of the very claims composeWorld placed
  // (claimIndex.buildingClipVolumes), not a second hand-assembled walk over the layout arrays.
  // That closes the drift risk the old `ClipIndexSources` shape carried: a new building-ish layer
  // used to have to be remembered in TWO places, and forgetting the second one silently made the
  // camera blind to it.
  //
  // PHASE 36 PROMOTED THIS OUT OF `import.meta.env.DEV`. It was Phase 33 instrumentation; it is
  // now load-bearing production machinery, feeding two shipped systems: the occlusion pass's
  // fade targeting (segmentHitFadeKeys, above) and the camera anti-clip guard (pointInsideAny).
  // The cost it was DEV-gated for is a one-off ~few ms at world mount — the two hero geometries
  // below plus the bucket-grid build — which is inside the same Suspense window the pack GLBs
  // already spend far longer in. The DEV-only half (the clip STATISTICS sampler) is a separate
  // pass below and stays gated.
  //
  // Toggle-blind ON PURPOSE: it indexes the full frontage/infill layout regardless of the dev
  // toggles that can hide layers from CityDress. A key the index knows but no renderer registered
  // is simply skipped by applyFadesFor, whereas a toggle-shaped index would make the anti-clip
  // guard's view of the world disagree with the colliders the car is actually hitting.
  useEffect(() => {
    // heroes.ts publishes its base-collider hint only through a built model's `meta`, so build
    // both geometries, read the hints and dispose immediately (HeroesLayer keeps its own memoized
    // copies for rendering).
    const cn = buildCnTowerGeometry();
    const rogers = buildRogersGeometry();
    const cnAt = lotCenter(HERO_LOTS[0]);
    const rgAt = lotCenter(HERO_LOTS[1]);
    const heroVolumes = [
      // Phase 44 (T3): CN's base is SHAPED, not blocked out. It used to enter the index as one
      // 21×21×20 wu box — the leg splay's bounding box, which also swallowed the arch void and the
      // empty diagonal corners out to a 14.85 wu half-diagonal. The anti-clip guard's boresight
      // could not clear that within its 25 m cap, so a car parked NW of the tower left the eye
      // stuck inside back-face-culled concrete with pull 0 (the Phase 43 filed defect).
      // world/toronto/cnClipVolumes.ts derives tight boxes from the tower's own triangle soup.
      ...cnBaseClipVolumes(cn.geometry.getAttribute('position').array, cn.meta, cnAt),
      // Phase 36: CN's taper-shaft bands join the index (heroes.ts's shaftColliders block explains
      // the see-through hole they close — the eye could rest INSIDE the shaft, back-face-culled).
      // Phase 44 re-expresses each band as the same two-box plus, for the same diagonal reason.
      ...cnShaftClipVolumes(cn.meta.shaftColliders, cnAt),
      // Rogers: the ring base as one cylinder box (it sits entirely below the eye line — it exists
      // for boresight blocking, not for eye-inside), plus — NEW at Phase 45 — the DOME.
      // The dome was the one hero volume left out since Phase 36, because a square AABB around a
      // 33-wu-radius shell false-flags the whole rail-lands approach. cnClipVolumes.ts's
      // `rogersDomeClipVolumes` solves that properly off the rebuilt dome's own per-band ENCLOSURE
      // hints: boxes INSCRIBED in each band (corners on the circle, so nothing ever reaches past
      // it), sized to what the shell encloses rather than to its skin, and only for the bands the
      // rig's eye can physically reach. The open approach stays untouched; an eye
      // that climbs inside the roof is now seen (and the anti-clip guard can pull it out).
      heroCylinderClipVolume(rogers.meta.collider, rgAt),
      ...rogersDomeClipVolumes(rogers.meta.domeBands, rgAt),
    ];
    cn.geometry.dispose();
    rogers.geometry.dispose();
    // The arbiter's building-class claims (frontage slots + corner fills + backdrop/back-lot boxes
    // + back-lot pack buildings + named boxes), each already carrying the fade key minted at
    // REGISTRATION by the same frontageFadeKey/infillFadeKey/backdropFadeKey functions the
    // CityDress renderers call — so both sides key by the item's own identity, never by an array
    // position. The hero volumes are geometry-derived (three-dependent, so they cannot live in the
    // pure layer) and are appended here exactly as before.
    setClipIndex([...world.clipVolumes, ...heroVolumes]);
    return () => {
      clearClipIndex();
      // The occlusion pass's per-frame state is keyed to THIS index's keys — drop it with the
      // index so a remount (run restart, StrictMode) can't leave a key faded forever with no
      // segment able to re-hit it.
      resetDitherPassState();
    };
  }, [world]);

  // --- Phase 33 camera lab: clip sampling (DEV-only, priority 2 = after the render) ---------
  // Priority 2 runs after CameraFxSystem's priority-1 update + render, so it observes the camera
  // exactly as it was painted this frame — including the polygon clamp, which since Phase 34 is
  // folded into the rig's own position solve (the module-scope clampCameraPos above) and is
  // therefore already applied by the time anything is drawn. The sample always describes a frame
  // the player actually saw, not a speculative one.
  // Also the (dev-only) publisher of fx/cameraRef's live-camera handle — the preset apply path
  // needs the real PerspectiveCamera to write `fov` on, and this is the one pass that holds it
  // every frame in every machine state.
  useFrame((state) => {
    if (!import.meta.env.DEV) return;
    const camera = state.camera as PerspectiveCamera;
    liveCamera.current = camera;
    camera.updateMatrixWorld();
    const eye = camera.position;
    const eyeInside = eyeInsideAny(eye.x, eye.y, eye.z);
    // The four near-plane corners in world space (camera-local ±halfW/±halfH at −near, through
    // the camera's world matrix): the lens can be clipping through a facade well before the eye
    // POINT is inside it, and that is what the player sees as "phasing".
    const halfH = Math.tan((camera.fov * Math.PI) / 360) * camera.near;
    const halfW = halfH * camera.aspect;
    let nearPlaneInside = false;
    for (let corner = 0; corner < 4 && !nearPlaneInside; corner++) {
      nearCornerScratch.set(corner & 1 ? halfW : -halfW, corner & 2 ? halfH : -halfH, -camera.near);
      nearCornerScratch.applyMatrix4(camera.matrixWorld);
      nearPlaneInside = pointInsideAny(nearCornerScratch.x, nearCornerScratch.y, nearCornerScratch.z);
    }
    // Boresight cover vs the FULL index (the occlusion-fade pass above only sees the ~18
    // registered named/hero meshes): how many indexed buildings sit between eye and car. This is
    // the counter that catches "eye outside a wall, car invisible behind it" — the first tuning
    // round produced exactly such frames at the fold corridor with eyeInside reading 0.
    const model = playerVehicle.current;
    let boresightHits: number | null = null;
    if (model) {
      const car = model.readState().pose.position;
      boresightHits = segmentHitCount(eye.x, eye.y, eye.z, car.x, car.y, car.z);
    }
    sampleCameraClip(eyeInside, nearPlaneInside, boresightHits);
  }, 2);

  const handleWaterEnter = (payload: IntersectionEnterPayload): void => {
    // PLAYER-only (Phase 37): the sensor's WATER group senses every vehicle class, and
    // combat/runLoop.ts turns `enteredWater` into the PLAYER's death — so a pursuit unit or
    // civilian splashing into the lake must not read as the player drowning. Latent since P22
    // at ground level; the Phase 37 sensor raise (ballistic envelope, 30 m) widened the
    // exposure to airborne units launched over the lake band, so the filter is now mandatory.
    if (getEntity(payload.other.collider.handle)?.kind !== 'player') return;
    gameEvents.emit('enteredWater', {});
  };

  return (
    <>
      {/* Blue-hour lighting (player-follow shadow frustum, map-size-agnostic, self-restoring). */}
      <BlueHourRig />
      {/* Run lifecycle + WATER→WRECKED death path (the legacy tree that normally carries this is
          not mounted in this branch). */}
      <RunLoopSystem />
      {/* Phase 30 (T2 debt-2): the trailing dynamic-light pool, Toronto-adapted — same pool/
          budget/hysteresis as the legacy mount, fed traffic-light-mast emitters instead of a
          WorldData's streetlights. Dark-district exclusion reads the SAME canonical combined
          source (grid.ts + emitters.ts) the legacy mount wires, via LightPool's own effect. */}
      <LightPool emitters={torontoLightEmitters} />

      {/* Base ground: merged flat mesh (uncovered fallback under the district tints) + fixed
          GROUND colliders (top face at y=0). Kept UNLIT (like the ribbons) — the district
          tints above cover ~95% of the drivable area; this only shows in the fold notches /
          polygon slivers the tint quads don't reach, where a neutral dark reads as shadow. */}
      <mesh geometry={groundGeometry} frustumCulled={false}>
        <meshBasicMaterial color={GROUND_COLOR} map={groundNoiseTex} toneMapped={false} />
      </mesh>
      {/* District ground tints (Phase 23, §6): one vertex-coloured quad per resolved district
          rect. A/B RESULT (this session's live pass): a LIT MeshLambertMaterial crushed the
          ground to near-black — not the P22 Standard anomaly but plain Lambert physics, a flat
          +Y plane catches the low blue-hour sun at a grazing angle (N·L ≈ 0). So the ground
          falls back to UNLIT-literal (meshBasicMaterial vertexColors toneMapped={false}), the
          same mitigation the roads/curbs/dashes (and, this session, the buildings) use — the
          authored §6 tint hex IS the on-screen colour. */}
      <mesh geometry={tintGeometry} frustumCulled={false}>
        <meshBasicMaterial vertexColors map={groundNoiseTex} toneMapped={false} />
      </mesh>
      {/* Phase 25.8 (D7): park grass rects (noise-textured, unlit vertex-coloured). Above the tint,
          below the roads; parks.ts guarantees no rect overlaps a ribbon. */}
      <mesh geometry={parksGeometry} frustumCulled={false}>
        <meshBasicMaterial vertexColors map={groundNoiseTex} toneMapped={false} />
      </mesh>
      {/* Park trees — merge visually into the pack tree read via their own BatchedMesh (id 'tree',
          per-instance culled). +1 draw call; deliberately kept out of CityDress to avoid touching the
          concurrent tier-wiring there. */}
      {parkTreePlacements.length > 0 ? (
        <Suspense fallback={null}>
          <CityPackBatched id="tree" placements={parkTreePlacements} unlit={cityPackUnlit} />
        </Suspense>
      ) : null}
      <RigidBody type="fixed" colliders={false} collisionGroups={GROUND_GROUPS}>
        {GROUND_RECTS.map((rect, i) => {
          const b = rectWorldBox(rect);
          return (
            <CuboidCollider
              key={i}
              args={[b.hx, GROUND_HALF_THICK, b.hz]}
              position={[b.cx, -GROUND_HALF_THICK, b.cz]}
            />
          );
        })}
      </RigidBody>
      {/* Phase 25.8 (D5): raised-curb GROUND colliders under each raised-sidewalk segment (top at
          curbHeightWu). Kill-switch SIDEWALK.colliders (drive-feel gated). */}
      {SIDEWALK.colliders ? (
        <RigidBody type="fixed" colliders={false} collisionGroups={GROUND_GROUPS}>
          {curbBoxes.map((b, i) => (
            <CuboidCollider
              key={i}
              args={[b.hx, SIDEWALK.curbHeightWu / 2, b.hz]}
              position={[b.cx, SIDEWALK.curbHeightWu / 2, b.cz]}
            />
          ))}
        </RigidBody>
      ) : null}

      {/* Phase 25.6 re-dress + Phase 28 infill: the pack-building frontage (retires the box-lattice
          massing) + street furniture + parked cars + traffic-light lamp overlay + corner fill/
          back-lot/laneway/parking-lots/construction/lane-closures. Frontage/corner-fill/back-lot
          buildings + all furniture/decor render through per-model-type BatchedMeshes with
          per-instance frustum culling (world/toronto/cityPack) — one draw call per model at any
          count (shared model ids across layers collapse to ONE mesh), only in-frustum instances
          submit triangles. Parked cars + lane-closure cones are sleeping dynamic bodies that shove
          when rammed. Every layer gates on its own devToggle; `cityPackUnlit` is the material A/B
          arm. Fixed BUILDING colliders (frontage/corner-fill/back-lot buildings, tree trunks,
          bus-stops, backdrop/back-lot towers, parking-lot cars, construction fixtures) mount inside
          CityDress. */}
      <CityDress frontage={frontage} furniture={furniture} infill={infill} dress={dress} lampOverlay={tierParams.lampOverlay} />

      {/* Named landmarks (Phase 24): the §3c skyline (TD/RBC/Scotia/FCP/… towers, Royal York,
          Union, The Well, Eaton galleria, Aura, the Yonge×Sheppard twins, NY Civic Centre) as
          textured boxes + CROWN bank-logo decals + BUILDING colliders. */}
      <NamedBuildingsLayer placements={named.placements} />

      {/* Hero landmarks (Phase 25): the CN Tower + Rogers Centre primitive meshes on the reserved
          rail-lands lots, south of the named financial cluster (§5 adjacency rule). */}
      <HeroesLayer />

      {/* Rail lands (Phase 45): the aquarium + roundhouse + turntable + museum locomotive on their
          reserved lots, the ballast/tie ground dressing across the claimed corridor strip, the
          brewery patio, and the AQUARIUM / STEAM WHISTLE signs. */}
      <RailLandsLayer layout={railLands} unlit={cityPackUnlit} />

      {/* Places / nostalgia layer (Phase 26): places.json storefronts + §4 FASCIA sign-bands, the
          Uncle Tetsu / Konjiki-Elm lineups, Sam the Record Man's spinning discs, and §6 vibe props
          (Chinatown gate, rainbow crosswalk, Sugar Beach umbrellas, King West patio, Sankofa
          screen, Queen West graffiti). The FINAL Part-7 content pass. */}
      <PlacesLayer layer={places} />

      {/* Roads: one merged per-class vertex-coloured ribbon mesh. UNLIT (basic material):
          the §3a class colours must read exactly as authored regardless of dusk light —
          flat ribbons gain nothing from shading, and the live pass proved lit asphalt
          becomes indistinguishable from shadowed ground. */}
      <mesh geometry={roadGeometry} frustumCulled={false}>
        {/* toneMapped=false (same trick as the signpost labels): ACES at dusk crushes
            these low-luminance asphalts to black; unmapped, the authored §3a class hex IS
            the rendered colour (see ROAD_COLORS' contrast-ladder doc). */}
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>

      {/* Lakefront: visual plane + WATER sensor (senses vehicles → enteredWater → WRECKED).
          Phase 37: the sensor box is 30 m tall and sits with its floor 2 m UNDER the surface
          (WATER_SENSOR_CENTER_Y) so it covers the whole ballistic envelope of a car leaving the
          shore — a ramp-assisted arc used to sail clean over the old 6 m band and land in the
          void south of it with nothing to report. XZ extents are unchanged (WATER_BOX), so the
          shore road stays outside the sensor. */}
      <mesh
        position={[WATER_BOX.cx, WATER_Y, WATER_BOX.cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        frustumCulled={false}
        receiveShadow
      >
        <planeGeometry args={[WATER_BOX.hx * 2, WATER_BOX.hz * 2]} />
        <meshBasicMaterial color={WATER_COLOR} toneMapped={false} />
      </mesh>
      <RigidBody
        type="fixed"
        colliders={false}
        sensor
        collisionGroups={WATER_GROUPS}
        position={[WATER_BOX.cx, WATER_SENSOR_CENTER_Y, WATER_BOX.cz]}
      >
        <CuboidCollider
          args={[WATER_BOX.hx, BOUNDARY.waterColliderHeightM / 2, WATER_BOX.hz]}
          sensor
          onIntersectionEnter={handleWaterEnter}
        />
      </RigidBody>

      {/* Phase 37 — the diegetic world-edge barrier ring (worldEdge.ts). Colliders: 11 long fixed
          cuboids (one per LAND polygon edge, corner-overlap sealed — the south water edge has no
          wall, locked) PLUS 19 dead-end "road closed" rows (orchestrator addendum: without these,
          a car driving a dead-end street phases through the visual jersey-barrier dressing and
          only stops ~7-8 wu later at the ring line itself, since BARRIER.edgeInsetWu(6) sits
          closer to the polygon edge than a dead-end street's EDGE_PAD_WU(14)-deep cut). Arcing
          OVER 3 wu of wall is the out-of-bounds backstop's job by design, not this collider's. */}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {worldEdge.colliders.map((c) => (
          <RegisteredCuboidCollider
            key={`edge-${c.edgeIndex}`}
            entry={BARRIER_ENTRY}
            halfExtents={[c.hx, BARRIER.colliderHeightWu / 2, c.hz]}
            position={[c.cx, BARRIER.colliderHeightWu / 2, c.cz]}
          />
        ))}
        {deadEndColliders.map((c, i) => (
          <RegisteredCuboidCollider
            key={`dead-${i}-${c.streetId}`}
            entry={BARRIER_ENTRY}
            // Ring-height wall, NOT the jersey's 0.9 visual height: a 0.9 thin box is a speed
            // bump to the raycast vehicle (suspension rays ramp the chassis over it) — see
            // BARRIER.jersey.heightWu's doc for the Phase 37 battery proof.
            halfExtents={[c.hx, BARRIER.colliderHeightWu / 2, c.hz]}
            position={[c.cx, BARRIER.colliderHeightWu / 2, c.cz]}
          />
        ))}
      </RigidBody>
      {/* Dressing: pack fence/cone runs (CityPackBatched — per-object frustum culling is load-
          bearing here, the pack `fence` model alone is 1,040 tris x up to 1,460 instances) plus
          one merged procedural mesh for the three kinds with no pack equivalent (hoarding panels,
          jersey barriers, rail posts). +3 draw calls total over the pre-Phase-37 scene. */}
      {fencePlacements.length > 0 || conePlacements.length > 0 ? (
        <Suspense fallback={null}>
          {fencePlacements.length > 0 ? (
            <CityPackBatched
              id={BARRIER.packModelIds.fencePiece}
              placements={fencePlacements}
              unlit={cityPackUnlit}
            />
          ) : null}
          {conePlacements.length > 0 ? (
            <CityPackBatched id={BARRIER.packModelIds.cone} placements={conePlacements} unlit={cityPackUnlit} />
          ) : null}
        </Suspense>
      ) : null}
      <mesh geometry={barrierDressingGeometry} frustumCulled={false}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>

      {/* §1 exit signposts: instanced posts + per-label CanvasTexture boards (yawed to camera). */}
      <instancedMesh ref={postsRef} args={[undefined, undefined, SIGNPOSTS.length]} castShadow>
        <boxGeometry args={[0.5, POST_H, 0.5]} />
        <meshStandardMaterial color={POST_COLOR} />
      </instancedMesh>
      {SIGNPOSTS.map((s) => (
        <SignBoard key={s.id} label={s.label} x={s.x} z={s.y} />
      ))}

      {/* Phase 25.5 city-pack proof-of-render (dev-only; default off = nothing rendered). Streams
          optimized GLBs through the real loader (assets/cityPack.ts), instances them (1 draw call
          per model type), and judges the D8 lit/unlit material A/B under the BlueHourRig above. */}
      {cityPackPreview ? <CityPackPreview unlit={cityPackUnlit} /> : null}
    </>
  );
}
