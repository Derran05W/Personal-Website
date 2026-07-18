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

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CuboidCollider, RigidBody, useAfterPhysicsStep } from '@react-three/rapier';
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  NearestFilter,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  type InstancedMesh,
  type PerspectiveCamera,
} from 'three';
import { BOUNDARY, interactionGroups } from '../../config';
import { CAMERA_CLAMP_PADDING_WU, clampToPolygon } from './polygon';
import { ROAD_CLASSES, ROAD_EDGE } from '../../config/torontoMap';
import { WINDOW_PATTERN } from '../../config/torontoMaterials';
import { buildStreets } from './streets';
import { buildRibbons, type Ribbon } from './roadGraph';
import { buildDistricts } from './districts';
import { buildMassing } from './massing';
import { buildNamedBuildings, type CrownDecal, type NamedBox, type NamedPlacement } from './namedBuildings';
import { getLogoAtlas, logoCellUv } from './logoAtlas';
import { createRng } from '../rng';
import { createFoldTrigger, type FoldTrigger } from './tunnel';
import { gameEvents } from '../../state/events';
import { getGameState, useGameStore } from '../../state/store';
import { playerVehicle } from '../../vehicles/playerRef';
import { spawnPoseRef } from '../spawn';
import { computeLookTarget, type Vec3 } from '../../fx/cameraRig';
import { BlueHourRig } from '../BlueHourRig';
import { RunLoopSystem } from '../../combat/runLoop';
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
const ROAD_Y = 0.02; // ribbons a hair above ground (§ plan) — no z-fight
const WATER_Y = 0.05; // lake plane above the ribbons
const GROUND_HALF_THICK = BOUNDARY.groundThicknessM / 2; // slab extends downward only; top at y=0
const POST_H = 6; // signpost pole height (m)
const BOARD_W = 14;
const BOARD_H = 3.5;

// Palette (component-local placeholders, same carve-out world/CityScape.tsx uses; Phase 23 owns
// the real Toronto palette). Muted district-neutral ground; lake matches the legacy WATER_COLOR.
// Matches the legacy CityScape ground exactly — the Phase 22 live pass proved the darker
// first cut (#3a4048) left roads indistinguishable from ground under blue-hour light.
const GROUND_COLOR = '#454b54';
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

/** Two-triangle +Y quad (world XZ) at height `y`, appended to positions/normals. Winding matches
 * world/CityScape.tsx's buildTileQuadGeometry (verified +Y face normal there). */
function pushQuad(
  positions: number[],
  normals: number[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
): void {
  positions.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
  for (let i = 0; i < 6; i++) normals.push(0, 1, 0);
}

/** Merged flat geometry for the three ground rects (single draw call, one flat material). */
function buildGroundGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const rect of GROUND_RECTS) {
    // rect is map space; mapToWorld is the identity swap, so min/max X,Y ARE world x/z.
    pushQuad(positions, normals, rect.minX, rect.minY, rect.maxX, rect.maxY, GROUND_Y);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
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
  const c = new Color();
  for (const { def, rects } of buildDistricts()) {
    c.set(def.groundTint);
    for (const rect of rects) {
      // rect is map space; mapToWorld is the identity swap, so min/max X,Y ARE world x/z.
      pushQuad(positions, normals, rect.minX, rect.minY, rect.maxX, rect.maxY, GROUND_TINT_Y);
      for (let i = 0; i < 6; i++) colors.push(c.r, c.g, c.b);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  return g;
}

/** Merged road ribbons + curb strips, per-vertex coloured (single draw call, vertexColors).
 * Ribbons are already WORLD-space (buildRibbons applied mapToWorld). Curb strips run along
 * each ribbon's LONG edges a hair above the asphalt — the live pass proved that §3a's
 * oversized roads fill the camera's whole near footprint, so an unmarked ribbon reads as a
 * void, not a road (see ROAD_EDGE's doc). */
function buildRibbonGeometry(ribbons: readonly Ribbon[]): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const c = new Color();
  const pushColored = (hex: string, x0: number, z0: number, x1: number, z1: number, y: number): void => {
    pushQuad(positions, normals, x0, z0, x1, z1, y);
    c.set(hex);
    for (let i = 0; i < 6; i++) colors.push(c.r, c.g, c.b);
  };
  const e = ROAD_EDGE.widthWu;
  const d = ROAD_EDGE.dash;
  for (const r of ribbons) {
    pushColored(r.color, r.minX, r.minZ, r.maxX, r.maxZ, ROAD_Y);
    if (r.maxX - r.minX >= r.maxZ - r.minZ) {
      // long axis = X (east-west street): curbs along the north/south edges.
      pushColored(ROAD_EDGE.color, r.minX, r.minZ, r.maxX, r.minZ + e, ROAD_Y + 0.005);
      pushColored(ROAD_EDGE.color, r.minX, r.maxZ - e, r.maxX, r.maxZ, ROAD_Y + 0.005);
      // centre-line dashes (always inside the camera's near footprint while driving).
      const cz = (r.minZ + r.maxZ) / 2;
      for (let x = r.minX + d.gapWu; x + d.lengthWu < r.maxX; x += d.lengthWu + d.gapWu) {
        pushColored(d.color, x, cz - d.halfWidthWu, x + d.lengthWu, cz + d.halfWidthWu, ROAD_Y + 0.005);
      }
    } else {
      // long axis = Z (north-south street): curbs along the west/east edges.
      pushColored(ROAD_EDGE.color, r.minX, r.minZ, r.minX + e, r.maxZ, ROAD_Y + 0.005);
      pushColored(ROAD_EDGE.color, r.maxX - e, r.minZ, r.maxX, r.maxZ, ROAD_Y + 0.005);
      const cx = (r.minX + r.maxX) / 2;
      for (let z = r.minZ + d.gapWu; z + d.lengthWu < r.maxZ; z += d.lengthWu + d.gapWu) {
        pushColored(d.color, cx - d.halfWidthWu, z, cx + d.halfWidthWu, z + d.lengthWu, ROAD_Y + 0.005);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
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

/** A square plane for a CROWN decal, UV-sliced to the brand's atlas cell. The atlas is a single
 * row (v spans 0..1), so only u is remapped; flipY on the shared texture leaves v correct. */
function makeDecalGeometry(size: number, brandUv: { u0: number; u1: number }): PlaneGeometry {
  const geo = new PlaneGeometry(size, size);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i); // 0 or 1 across the plane
    uv.setX(i, brandUv.u0 + u * (brandUv.u1 - brandUv.u0));
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

  return (
    <>
      {/* Named building boxes — one mesh each (unique facade texture), UNLIT-literal like the
          filler massing, castShadow so P24's lit ground receives the skyline shadows later. */}
      {boxes.map(({ box, key }, i) => (
        <mesh key={key} position={[box.cx, box.hy, box.cz]} castShadow frustumCulled={false}>
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

      {/* Indestructible fixed BUILDING colliders — one per box (massing.ts's fixed-body pattern). */}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {boxes.map(({ box, key }) => (
          <CuboidCollider key={key} args={[box.hx, box.hy, box.hz]} position={[box.cx, box.hy, box.cz]} />
        ))}
      </RigidBody>
    </>
  );
}

export function TorontoScene() {
  // The store world seed (index.tsx keys this whole subtree on it, so "New city" in the garage
  // remounts + reseeds the massing). Read the same way index.tsx does.
  const seed = useGameStore((s) => s.seed);

  // Street table + ribbons: pure, deterministic, built once.
  const ribbons = useMemo(() => buildRibbons(buildStreets().streets), []);
  const groundGeometry = useMemo(() => buildGroundGeometry(), []);
  useEffect(() => () => groundGeometry.dispose(), [groundGeometry]);
  const tintGeometry = useMemo(() => buildGroundTintGeometry(), []);
  useEffect(() => () => tintGeometry.dispose(), [tintGeometry]);
  const roadGeometry = useMemo(() => buildRibbonGeometry(ribbons), [ribbons]);
  useEffect(() => () => roadGeometry.dispose(), [roadGeometry]);

  // Phase 23 filler massing: seeded extruded coloured boxes (§6 stock, §3c heights) — the
  // downtown-at-a-glance look. One InstancedMesh (per-instance matrix + colour) + one fixed
  // RigidBody of BUILDING colliders. Deterministic per seed, memoized so a re-render never
  // rebuilds the ~700 boxes.
  // Phase 24 named landmarks: street-referenced, seed-independent (pure function of the street
  // table). Built once; their footprints + the reserved hero lots feed buildMassing as exclusions
  // so filler never collides with a landmark or the P25 CN Tower / Rogers lots.
  const named = useMemo(() => buildNamedBuildings(), []);
  const massing = useMemo(() => buildMassing(seed, named.exclusions), [seed, named]);
  const buildingsRef = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = buildingsRef.current;
    if (!mesh) return;
    const dummy = new Object3D();
    const color = new Color();
    massing.instances.forEach((inst, i) => {
      dummy.position.set(inst.x, inst.hy, inst.z); // box floor at y=0, centre at half-height
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(inst.hx * 2, inst.hy * 2, inst.hz * 2);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.set(inst.color);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [massing]);

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
  if (foldTrigger.current === null) foldTrigger.current = createFoldTrigger(ROAD_CLASSES.spine / 2);
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
        <meshBasicMaterial color={GROUND_COLOR} toneMapped={false} />
      </mesh>
      {/* District ground tints (Phase 23, §6): one vertex-coloured quad per resolved district
          rect. A/B RESULT (this session's live pass): a LIT MeshLambertMaterial crushed the
          ground to near-black — not the P22 Standard anomaly but plain Lambert physics, a flat
          +Y plane catches the low blue-hour sun at a grazing angle (N·L ≈ 0). So the ground
          falls back to UNLIT-literal (meshBasicMaterial vertexColors toneMapped={false}), the
          same mitigation the roads/curbs/dashes (and, this session, the buildings) use — the
          authored §6 tint hex IS the on-screen colour. */}
      <mesh geometry={tintGeometry} frustumCulled={false}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>
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

      {/* Filler massing (Phase 23): the seeded box-city. ONE InstancedMesh (per-instance matrix
          + colour, single draw call). A/B RESULT (this session's live pass): a LIT
          MeshLambertMaterial — the plan's first choice — crushed the boxes to near-black in the
          headless renderer, the SAME way the P22 note reported for Standard materials (the legacy
          world only reads because its EMISSIVE windows carry it; our filler has none until Phase
          24). Swapping to UNLIT-literal (meshBasicMaterial + instanceColor, toneMapped={false})
          — the exact mitigation the roads/ground already use — makes the authored §6 stock colours
          the on-screen colours: the saturated/pale districts (North York glass-green, Yorkville
          limestone, Harbourfront blue, storefront greys) read clearly as buildings, while the
          near-black glass stock (Financial) stays an authored-dark silhouette. Phase 24 brings the
          real lit palette + emissive-window pipeline; a real-GPU check of lit Lambert is owed to
          the user (the standing P22 item). castShadow stays so Phase 24's lit ground receives the
          skyline's dusk shadows the moment the materials flip back. */}
      {massing.instances.length > 0 ? (
        <instancedMesh
          ref={buildingsRef}
          args={[undefined, undefined, massing.instances.length]}
          castShadow
          frustumCulled={false}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      ) : null}
      {/* Indestructible fixed BUILDING colliders — one CuboidCollider per box, grouped under a
          single fixed RigidBody exactly like world/CityColliders.tsx. No registry entries this
          slice (no combat on the Toronto branch yet — plan Task 2/3). */}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {massing.colliders.map((c, i) => (
          <CuboidCollider key={i} args={[c.hx, c.hy, c.hz]} position={[c.x, c.y, c.z]} />
        ))}
      </RigidBody>

      {/* Named landmarks (Phase 24): the §3c skyline (TD/RBC/Scotia/FCP/… towers, Royal York,
          Union, The Well, Eaton galleria, Aura, the Yonge×Sheppard twins, NY Civic Centre) as
          textured boxes + CROWN bank-logo decals + BUILDING colliders. */}
      <NamedBuildingsLayer placements={named.placements} />

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
    </>
  );
}
