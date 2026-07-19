// Phase 22 — the drivable Toronto "thermometer" dev slice (behind the `torontoMap` leva
// toggle; game/index.tsx swaps the whole 64×64 legacy world for this when it's on, and mounts
// nothing new when it's off). Everything the Finch→Union drive needs and nothing Phase 23 will
// throw away:
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
//   • CAMERA CLAMP — a late (priority-2) pass that, only when the camera would show the void,
//     clamps it back inside the padded polygon (see the clamp's own note for why it re-renders
//     rather than fight fx/cameraRig's atomic priority-1 position+render).
// Lighting reuses world/BlueHourRig.tsx (its shadow frustum follows the player, so it is
// map-size-agnostic and self-restores scene state on unmount — clean when the toggle flips back).

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { CuboidCollider, RigidBody, useAfterPhysicsStep } from '@react-three/rapier';
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
import { buildDistricts, torontoDistrictIndexAt } from './districts';
import { buildGroundTintRanges, darkenColorRange } from './groundTintBlackout';
import { RegisteredCuboidCollider, RegisteredCylinderCollider } from '../landmarks/registeredCollider';
import { torontoBuildingEntryAt } from './torontoColliders';
import { buildFrontage } from './frontage';
import { buildInfill } from './infill';
import { buildFurniture } from './furniture';
import { buildRoadGeometry, buildSidewalkColliderBoxes } from './roadPaint';
import { buildParks, type ParksLayout } from './parks';
import { GROUND_NOISE, buildNoiseField, sampleNoiseField } from './groundNoise';
import { SIDEWALK } from '../../config/torontoMap';
import { CityPackBatched } from './cityPack/CityPackBatched';
import { HERO_LOTS, buildNamedBuildings, type CrownDecal, type NamedBox, type NamedPlacement } from './namedBuildings';
import { buildCnTowerGeometry, buildRogersGeometry } from './heroes';
import { needsTransparent, occlusionFader, occlusionRegistry } from './occlusionFade';
import { getLogoAtlas, logoCellUv } from './logoAtlas';
import {
  buildPlacesLayer,
  type DiscSign,
  type PlaceBox,
  type PlacesLayer as PlacesLayerData,
  type SankofaProp,
} from './placesLayer';
import { buildVenueDress } from './venueDress';
import { createRng } from '../rng';
import { createFoldTrigger, type FoldTrigger } from './tunnel';
import { gameEvents } from '../../state/events';
import { getGameState, useGameStore } from '../../state/store';
import { playerVehicle } from '../../vehicles/playerRef';
import { spawnPoseRef } from '../spawn';
import { computeLookTarget, type Vec3 } from '../../fx/cameraRig';
import { BlueHourRig } from '../BlueHourRig';
import { RunLoopSystem } from '../../combat/runLoop';
import { useDevToggle } from '../../core/devToggles';
import { preloadCityPack } from '../../assets/cityPack';
import { CityPackPreview } from './cityPack/CityPackPreview';
import { CityDress } from './cityPack/CityDress';
import {
  GROUND_RECTS,
  SIGNPOSTS,
  TORONTO_SPAWN_POSE,
  WATER_RECT,
  rectWorldBox,
} from './torontoSceneHelpers';

// --- layout constants (visual-only y offsets; physics uses the collider slab below) ---------
const GROUND_Y = 0; // merged ground quads at the collider top face
const GROUND_TINT_Y = 0.008; // district groundTint quads, just above the base ground, below roads
const WATER_Y = 0.05; // lake plane above the ribbons
const GROUND_HALF_THICK = BOUNDARY.groundThicknessM / 2; // slab extends downward only; top at y=0
const POST_H = 6; // signpost pole height (m)
const BOARD_W = 14;
const BOARD_H = 3.5;

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

// Reused camera-clamp look-target scratch (hot path — no per-frame alloc, cameraRig discipline).
const lookScratch: Vec3 = { x: 0, y: 0, z: 0 };

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
 * Set as `map` on the unlit ground/tint/park materials → multiplies the vertex-colour ladder. */
function makeGroundNoiseTexture(seed: number): CanvasTexture {
  const field = buildNoiseField(seed, GROUND_NOISE.lattice, GROUND_NOISE.lo, GROUND_NOISE.hi);
  const size = GROUND_NOISE.textureSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
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
const PARK_GROUND_Y = 0.01; // just above the base ground / district tint, below the road ribbon
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
  const off = 0.05; // proud of the face, no z-fight
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
  useEffect(
    () => () => {
      cn.geometry.dispose();
      rogers.geometry.dispose();
    },
    [cn, rogers],
  );
  // Phase 29 (D1): only two lots, spatial lookup is cheap — same district-resolution idiom as
  // NamedBuildingsLayer above.
  const districts = useMemo(() => buildDistricts(), []);

  const cnAt = lotCenter(HERO_LOTS[0]); // CN Tower (Part-8: BASE ≈ (950, 3390), compacted live)
  const rgAt = lotCenter(HERO_LOTS[1]); // Rogers Centre (Part-8: BASE ≈ (860, 3450), compacted live)

  const cnRef = useRef<Mesh>(null);
  const rgRef = useRef<Mesh>(null);
  useEffect(() => {
    const meshes = [cnRef.current, rgRef.current].filter((m): m is Mesh => m !== null);
    meshes.forEach((m) => occlusionRegistry.add(m));
    return () => meshes.forEach((m) => occlusionRegistry.remove(m));
  }, []);

  return (
    <>
      <mesh ref={cnRef} geometry={cn.geometry} position={[cnAt.x, 0, cnAt.z]} castShadow frustumCulled={false}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>
      <mesh ref={rgRef} geometry={rogers.geometry} position={[rgAt.x, 0, rgAt.z]} castShadow frustumCulled={false}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>
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

  // Phase 25.8 (D6): one shared ground-noise texture keyed on the seed (deterministic).
  const groundNoiseTex = useMemo(() => makeGroundNoiseTexture(seed), [seed]);
  useEffect(() => () => groundNoiseTex.dispose(), [groundNoiseTex]);

  // Phase 25.8 (D7): parks — the grass mesh + tree ring; the rects also gate the streetwall via the
  // frontage exclusion set (buildFrontage calls buildParks() internally, so the same rects gap the
  // frontage that the mesh fills — deterministic, seed-independent, no drift).
  const parks = useMemo(() => buildParks(), []);
  const parksGeometry = useMemo(() => buildParksGeometry(parks), [parks]);
  useEffect(() => () => parksGeometry.dispose(), [parksGeometry]);
  const parkTreePlacements = useMemo(
    () => parks.trees.map((t) => ({ position: t.position, rotationY: t.rotationY })),
    [parks],
  );

  // Phase 24 named landmarks: street-referenced, seed-independent (pure function of the street
  // table). Their footprints + the reserved hero lots feed the frontage engine as exclusions so
  // pack filler never collides with a landmark or the P25 CN Tower / Rogers lots.
  const named = useMemo(() => buildNamedBuildings(), []);
  // Phase 26 places / nostalgia layer: street-referenced, seed-independent. Its storefront/Sam/
  // Sankofa footprints join the named exclusions (frontage.ts + furniture.ts consume both).
  const places = useMemo(() => buildPlacesLayer(named), [named]);

  // Phase 25.8 (D8): the quality-tier dress scaling, captured ONCE at mount via a lazy useState
  // initializer — NOT a reactive subscription, matching world/CityScape.tsx's
  // parkedCarKeepFraction/sceneryKeepFraction precedent exactly (see that file's doc comment). A
  // mid-run quality change must not thin buildings/furniture/colliders out from under a live run;
  // the new tier applies on the next mount (new seed, new run, or the torontoMap toggle).
  const [tierParams] = useState(() => {
    const tier = QUALITY_TIERS[useGameStore.getState().settings.quality];
    return {
      dressDensityScalar: tier.dressDensityScalar,
      frontageOccupancyScalar: tier.frontageOccupancyScalar,
      parkedCarKeepFraction: tier.parkedCarKeepFraction,
      lampOverlay: tier.lampOverlay,
    };
  });

  // Phase 25.6 re-dress: pack-building frontage (retires the box-lattice massing) + street
  // furniture + parked cars. Both are pure/deterministic and read the SAME named+places exclusions
  // internally, so a re-render never rebuilds them and the same seed reproduces the exact city.
  // Phase 25.8 (D8): threaded with the mount-captured tierParams above (tierParams is stable
  // across the component's lifetime, so this dependency never re-triggers a rebuild mid-run).
  const frontage = useMemo(() => buildFrontage(seed, tierParams), [seed, tierParams]);
  const furniture = useMemo(() => buildFurniture(seed, tierParams), [seed, tierParams]);
  // Phase 28 infill: corner fill (frontage.cornerFills, built above) + back-lot/laneway/parking-
  // lot/construction/lane-closure (world/toronto/infill.ts). Pure/deterministic, derived off the
  // already-built frontage layout (its slots + cornerFills are the avoid-set every new layer
  // respects) — same "rebuild only when seed/tier changes" contract as frontage/furniture above.
  const infill = useMemo(() => buildInfill(seed, frontage, tierParams), [seed, frontage, tierParams]);
  // Phase 25.7 venue dressing: pure, derived off the frontage's resolved venue claims (seed-
  // independent claims, so this only rebuilds when the frontage object changes). Passed into
  // CityDress → VenueDressLayer; its dressing-prop model ids join the preload set below.
  const dress = useMemo(() => buildVenueDress(frontage.venueClaims), [frontage]);

  // Preload every used pack GLB once the slice mounts (never at module scope — a `torontoMap`-off
  // load fetches nothing). Covers frontage buildings, furniture props, parked cars, traffic lights,
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
    for (const car of furniture.parked.items) ids.add(car.modelId);
    for (const prop of dress.props) ids.add(prop.modelId);
    for (const s of frontage.cornerFills) ids.add(s.modelId);
    for (const f of infill.fixed) ids.add(f.modelId);
    for (const d of infill.decor) ids.add(d.modelId);
    for (const c of infill.cones) ids.add(c.modelId);
    preloadCityPack([...ids]);
  }, [frontage, furniture, dress, infill]);

  // Publish this slice's spawn pose so devPanel's "teleport reset" (and the fell-out net below)
  // send the car back to Finch, not the legacy map centre — the Toronto equivalent of
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

  // --- fell-out-of-world safety net -------------------------------------------------------
  // No legacy CityScape here to carry its net, and this map's rects don't fully tile the
  // polygon (the capsule/corridor/downtown step-ins leave void slivers a car can leave), so a
  // chassis that drops below the slab gets reset to spawn — mirrors world/CityScape.tsx's net.
  useFrame(() => {
    const model = playerVehicle.current;
    if (model && model.readState().rawPose.position.y < BOUNDARY.fellOutResetY) {
      model.reset(spawnPoseRef.current);
    }
  });

  // --- occlusion fade (A.5): the car is never fully hidden -----------------------------------
  // Each frame, cast one ray from the camera to the player and fade any registered occludable
  // (named-building box or hero mesh) it passes through to ≤ 0.35 alpha within ~130 ms, restoring
  // when the ray clears (occlusionFade.ts owns the pure timing; this is the raycast + material
  // write). Runs at the default priority so opacities are set BEFORE fx/cameraRig's priority-1
  // render. Cost is negligible: ~18 static meshes, one ray, no per-frame allocation in the hot
  // path beyond the (tiny) hit list. Instanced filler is excluded this phase (shared material →
  // needs a shader edit; recorded debt) — A.5's mandatory cases are all named/hero meshes.
  useFrame((state, delta) => {
    const model = playerVehicle.current;
    const meshes = occlusionRegistry.meshes;
    if (!model || meshes.length === 0) return;
    const car = model.readState().pose.position;
    const cam = state.camera;
    occlusionDir.set(car.x - cam.position.x, car.y - cam.position.y, car.z - cam.position.z);
    const dist = occlusionDir.length();
    if (dist < 1e-3) return;
    occlusionDir.multiplyScalar(1 / dist);
    occlusionRay.set(cam.position, occlusionDir);
    occlusionRay.near = 0;
    occlusionRay.far = dist; // only occluders BETWEEN camera and car
    const hits = occlusionRay.intersectObjects(meshes as Object3D[], false);
    occlusionHitKeys.clear();
    for (const h of hits) occlusionHitKeys.add(h.object.uuid);
    occlusionKeyList.length = 0;
    for (const m of meshes) occlusionKeyList.push(m.uuid);
    const dtMs = Math.min(delta * 1000, 100); // clamp big gaps (tab refocus) so a fade never jumps
    occlusionFader.step(occlusionKeyList, occlusionHitKeys, dtMs);
    for (const m of meshes) {
      const opacity = occlusionFader.opacity(m.uuid);
      const mat = (m as Mesh).material;
      const transparent = needsTransparent(opacity);
      if (Array.isArray(mat)) {
        for (const mm of mat) applyFade(mm, opacity, transparent);
      } else {
        applyFade(mat, opacity, transparent);
      }
    }
  });

  // --- camera clamp (priority 2, AFTER fx/cameraRig's priority-1 pass) ---------------------
  // fx/cameraRig's CameraFxSystem sets the camera position from its OWN internal smoothed state
  // AND renders, atomically, at priority 1 — a later pass that merely writes camera.position is
  // both overwritten next frame and applied after the render, i.e. it never reaches a pixel.
  // So this pass only ACTS when the camera would actually show the void: it clamps, re-aims at
  // the (unclamped) look target, and issues one corrective render on top of CameraFxSystem's.
  // When the camera is already inside the padded polygon (the common case) it early-returns and
  // CameraFxSystem's own render stands unchallenged — no render-owner takeover, no fighting the
  // rig's damping, and the scene can never go black (CameraFxSystem always paints).
  useFrame((state) => {
    const camera = state.camera as PerspectiveCamera;
    // world [x,z] → map {x,y}; clampToPolygon returns the point unchanged when ≥ padding inside.
    const clamped = clampToPolygon(
      { x: camera.position.x, y: camera.position.z },
      CAMERA_CLAMP_PADDING_WU,
    );
    if (clamped.x === camera.position.x && clamped.y === camera.position.z) return;
    camera.position.x = clamped.x;
    camera.position.z = clamped.y;
    const model = playerVehicle.current;
    if (model) {
      const s = model.readState();
      computeLookTarget(lookScratch, s.pose.position, s.velocity, s.speed);
      camera.lookAt(lookScratch.x, lookScratch.y, lookScratch.z);
    }
    state.gl.render(state.scene, state.camera);
  }, 2);

  const handleWaterEnter = (): void => {
    gameEvents.emit('enteredWater', {});
  };

  return (
    <>
      {/* Blue-hour lighting (player-follow shadow frustum, map-size-agnostic, self-restoring). */}
      <BlueHourRig />
      {/* Run lifecycle + WATER→WRECKED death path (the legacy tree that normally carries this is
          not mounted in this branch). */}
      <RunLoopSystem />

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

      {/* Lakefront: visual plane + WATER sensor (senses vehicles → enteredWater → WRECKED). */}
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
        position={[WATER_BOX.cx, 0, WATER_BOX.cz]}
      >
        <CuboidCollider
          args={[WATER_BOX.hx, BOUNDARY.waterColliderHeightM / 2, WATER_BOX.hz]}
          sensor
          onIntersectionEnter={handleWaterEnter}
        />
      </RigidBody>

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
