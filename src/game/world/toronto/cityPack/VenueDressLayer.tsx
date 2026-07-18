// Phase 25.7 Task 4 — the venue-dressing mount. Consumes the pure venueDress.ts output (fascia
// bands / awnings / dressing props / queues / plaque, all derived from frontage.ts venueClaims) and
// renders it through the EXISTING city-pack paths — zero new renderer machinery (the plan's
// StrictMode-safety rule): dressing props ride the proven CityPackBatched (one BatchedMesh per model
// id, per-instance culled), and everything else is one merged unlit mesh (bands / awnings) or a pair
// of instancedMeshes (queue posts/blobs), the same cheap unlit-literal pattern as PlacesLayer's vibe
// solids. The FASCIA band system is the P26 one re-targeted to the pack facades: one shared band
// atlas (logo cell + wordmark per venue) + one merged yaw-generalized band geometry. Gated by the
// `venueDress` devToggle inside CityDress; `cityPackUnlit` is the material arm for the batched props.

import { Suspense, useEffect, useMemo, useRef } from 'react';
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
} from 'three';
import { CityPackBatched } from './CityPackBatched';
import type { CityPackPlacement } from './CityPackInstances';
import {
  LOGO_ATLAS_LAYOUT,
  getLogoAtlas,
  logoCellIndex,
  logoCellUv,
} from '../logoAtlas';
import type {
  VenueAwning,
  VenueBandRow,
  VenueDress,
  VenueFasciaBand,
} from '../venueDress';

const BAND_ROW_H = 40; // band-atlas row height (px) — logo cell (left) + name text (right)
const BAND_W = 320;

/** The shared venue FASCIA band atlas: one row per fascia-bearing venue, its logo cell (drawn from
 * the shared logo atlas) on the left + a NearestFilter name wordmark on the right, on the venue's
 * backing colour (near-black default; karaoke magenta). Crunchy (§4 / A.5). */
function makeVenueBandAtlas(rows: readonly VenueBandRow[]): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = BAND_W;
  canvas.height = Math.max(1, rows.length) * BAND_ROW_H;
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
  const src = getLogoAtlas().texture.image as CanvasImageSource;
  const cell = LOGO_ATLAS_LAYOUT.cellSize;
  for (const r of rows) {
    const y = r.bandRow * BAND_ROW_H;
    ctx.fillStyle = r.backingColor;
    ctx.fillRect(0, y, BAND_W, BAND_ROW_H);
    const idx = logoCellIndex(r.brand);
    const col = idx % LOGO_ATLAS_LAYOUT.cols;
    const row = Math.floor(idx / LOGO_ATLAS_LAYOUT.cols);
    ctx.drawImage(src, col * cell, row * cell, cell, cell, 2, y + 2, BAND_ROW_H - 4, BAND_ROW_H - 4);
    ctx.fillStyle = '#f4ead2';
    ctx.font = 'bold 22px "Arial Narrow", Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(r.name, BAND_ROW_H + 6, y + BAND_ROW_H / 2 + 1);
  }
  tex.needsUpdate = true;
  return tex;
}

/** ONE merged geometry for every venue FASCIA band quad, UV-sliced to its atlas row. Yaw-generalized
 * (any cardinal rotationY): tangent-for-u = (cosθ, 0, −sinθ) reproduces the P26 south/east corner
 * winding exactly and extends to the west/north street faces + S/E side bands. DoubleSide → no
 * winding care. */
function buildVenueBandGeometry(bands: readonly VenueFasciaBand[], rowCount: number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const R = Math.max(1, rowCount);
  const tri = [0, 1, 2, 0, 2, 3];
  for (const b of bands) {
    const v0 = 1 - (b.bandRow + 1) / R;
    const v1 = 1 - b.bandRow / R;
    const w = b.width / 2;
    const h = b.height / 2;
    const s = Math.sin(b.rotationY);
    const co = Math.cos(b.rotationY);
    const n: [number, number, number] = [s, 0, co]; // outward face normal
    const tx = co; // tangent-for-u (world XZ), = normal rotated −90°
    const tz = -s;
    // BL, BR, TR, TL — uv (0,v0),(1,v0),(1,v1),(0,v1).
    const corners: [number, number, number][] = [
      [b.cx - tx * w, b.cy - h, b.cz - tz * w],
      [b.cx + tx * w, b.cy - h, b.cz + tz * w],
      [b.cx + tx * w, b.cy + h, b.cz + tz * w],
      [b.cx - tx * w, b.cy + h, b.cz - tz * w],
    ];
    const uvs: [number, number][] = [
      [0, v0],
      [1, v0],
      [1, v1],
      [0, v1],
    ];
    for (const k of tri) {
      pos.push(corners[k][0], corners[k][1], corners[k][2]);
      nrm.push(n[0], n[1], n[2]);
      uv.push(uvs[k][0], uvs[k][1]);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}

/** ONE merged vertex-coloured geometry for every awning map-wide (D6): a sloped canopy quad + a
 * front valance + two side triangles per venue, each in its saturated brand colour. Same cheap
 * unlit pattern as PlacesLayer's buildVibeSolidsGeometry. */
function buildAwningGeometry(awnings: readonly VenueAwning[]): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const c = new Color();
  const push = (p: [number, number, number], rgb: [number, number, number]): void => {
    pos.push(p[0], p[1], p[2]);
    nrm.push(0, 1, 0);
    col.push(rgb[0], rgb[1], rgb[2]);
  };
  const quad = (a: [number, number, number], b: [number, number, number], d: [number, number, number], e: [number, number, number], rgb: [number, number, number]): void => {
    for (const p of [a, b, d, a, d, e]) push(p, rgb);
  };
  const triangle = (a: [number, number, number], b: [number, number, number], d: [number, number, number], rgb: [number, number, number]): void => {
    for (const p of [a, b, d]) push(p, rgb);
  };
  for (const aw of awnings) {
    c.set(aw.color);
    const rgb: [number, number, number] = [c.r, c.g, c.b];
    const wallY = aw.bottomY + aw.drop + aw.rise;
    const outerTopY = aw.bottomY + aw.drop;
    const lx = -aw.alongX * aw.halfWidth;
    const lz = -aw.alongZ * aw.halfWidth;
    const rx = aw.alongX * aw.halfWidth;
    const rz = aw.alongZ * aw.halfWidth;
    const dx = aw.outX * aw.canopyDepth;
    const dz = aw.outZ * aw.canopyDepth;
    const WL: [number, number, number] = [aw.anchorX + lx, wallY, aw.anchorZ + lz];
    const WR: [number, number, number] = [aw.anchorX + rx, wallY, aw.anchorZ + rz];
    const OL: [number, number, number] = [aw.anchorX + lx + dx, outerTopY, aw.anchorZ + lz + dz];
    const OR: [number, number, number] = [aw.anchorX + rx + dx, outerTopY, aw.anchorZ + rz + dz];
    const VL: [number, number, number] = [aw.anchorX + lx + dx, aw.bottomY, aw.anchorZ + lz + dz];
    const VR: [number, number, number] = [aw.anchorX + rx + dx, aw.bottomY, aw.anchorZ + rz + dz];
    quad(WL, WR, OR, OL, rgb); // sloped canopy
    quad(OL, OR, VR, VL, rgb); // front valance
    triangle(WL, OL, VL, rgb); // left gusset
    triangle(WR, VR, OR, rgb); // right gusset
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/** A square plane UV-sliced to a brand's atlas cell (both axes remapped — the P26 makeDecalGeometry,
 * a local copy so this file never imports back into TorontoScene.tsx and cycles through CityDress). */
function makeDecalGeometry(size: number, brandUv: { u0: number; u1: number; v0: number; v1: number }): PlaneGeometry {
  const geo = new PlaneGeometry(size, size);
  const a = geo.attributes.uv;
  for (let i = 0; i < a.count; i++) {
    a.setX(i, brandUv.u0 + a.getX(i) * (brandUv.u1 - brandUv.u0));
    a.setY(i, brandUv.v0 + a.getY(i) * (brandUv.v1 - brandUv.v0));
  }
  a.needsUpdate = true;
  return geo;
}

export interface VenueDressLayerProps {
  readonly dress: VenueDress;
  /** A/B material arm for the batched dressing props (shared `cityPackUnlit`). */
  readonly unlit: boolean;
}

/** The whole venue-dressing layer: bands + awnings + kit props + queues + plaque. */
export function VenueDressLayer({ dress, unlit }: VenueDressLayerProps) {
  const atlas = useMemo(() => getLogoAtlas(), []);

  // FASCIA bands — one atlas texture + one merged geometry.
  const bandTexture = useMemo(() => makeVenueBandAtlas(dress.bandRows), [dress.bandRows]);
  useEffect(() => () => bandTexture.dispose(), [bandTexture]);
  const bandGeometry = useMemo(() => buildVenueBandGeometry(dress.bands, dress.bandRows.length), [dress.bands, dress.bandRows.length]);
  useEffect(() => () => bandGeometry.dispose(), [bandGeometry]);

  // Awnings — one merged vertex-coloured mesh.
  const awningGeometry = useMemo(() => buildAwningGeometry(dress.awnings), [dress.awnings]);
  useEffect(() => () => awningGeometry.dispose(), [awningGeometry]);

  // Dressing props — grouped by model id → one CityPackBatched each.
  const byModel = useMemo(() => {
    const groups = new Map<string, CityPackPlacement[]>();
    for (const p of dress.props) {
      const list = groups.get(p.modelId) ?? [];
      list.push({ position: p.position, rotationY: p.rotationY });
      groups.set(p.modelId, list);
    }
    return [...groups.entries()].map(([id, placements]) => ({ id, placements }));
  }, [dress.props]);

  // Queue posts + person-blobs → two instancedMeshes, NO colliders (cosmetic; Pedestrians: none).
  const posts = useMemo(() => dress.queues.flatMap((q) => q.posts), [dress.queues]);
  const blobs = useMemo(() => dress.queues.flatMap((q) => q.blobs), [dress.queues]);
  const postsRef = useRef<InstancedMesh>(null);
  const blobsRef = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = postsRef.current;
    if (!mesh || posts.length === 0) return;
    const dummy = new Object3D();
    posts.forEach((p, i) => {
      dummy.position.set(p.x, 0.6, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [posts]);
  useEffect(() => {
    const mesh = blobsRef.current;
    if (!mesh || blobs.length === 0) return;
    const dummy = new Object3D();
    const color = new Color();
    const shades = ['#3a3f4a', '#4a4038', '#42484f', '#524a42', '#3f4550'];
    blobs.forEach((b, i) => {
      dummy.position.set(b.x, 0.45, b.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.set(shades[i % shades.length]);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [blobs]);

  // Alo plaque decals (shared logo atlas).
  const plaqueDecals = useMemo(
    () =>
      dress.plaques.map((p) => ({
        geometry: makeDecalGeometry(p.size, logoCellUv(p.brand)),
        position: p.position as [number, number, number],
        rotation: [0, p.rotationY, 0] as [number, number, number],
        key: p.venueId,
      })),
    [dress.plaques],
  );
  useEffect(() => () => plaqueDecals.forEach((d) => d.geometry.dispose()), [plaqueDecals]);

  return (
    <Suspense fallback={null}>
      {/* Dressing props — reuse CityPackBatched exactly (one BatchedMesh per model id). */}
      {byModel.map(({ id, placements }) => (
        <CityPackBatched key={id} id={id} placements={placements} unlit={unlit} />
      ))}

      {/* FASCIA sign-bands — one shared band-atlas texture + one merged geometry. */}
      {dress.bands.length > 0 ? (
        <mesh geometry={bandGeometry} frustumCulled={false}>
          <meshBasicMaterial map={bandTexture} toneMapped={false} side={DoubleSide} />
        </mesh>
      ) : null}

      {/* Awnings — one merged vertex-coloured mesh (saturated brand accents). */}
      {dress.awnings.length > 0 ? (
        <mesh geometry={awningGeometry} frustumCulled={false}>
          <meshBasicMaterial vertexColors toneMapped={false} side={DoubleSide} />
        </mesh>
      ) : null}

      {/* Queue lineups — cosmetic props, NO colliders. */}
      {posts.length > 0 ? (
        <instancedMesh ref={postsRef} args={[undefined, undefined, posts.length]} frustumCulled={false}>
          <boxGeometry args={[0.16, 1.2, 0.16]} />
          <meshBasicMaterial color="#c8b06a" toneMapped={false} />
        </instancedMesh>
      ) : null}
      {blobs.length > 0 ? (
        <instancedMesh ref={blobsRef} args={[undefined, undefined, blobs.length]} castShadow frustumCulled={false}>
          <boxGeometry args={[0.62, 0.9, 0.42]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      ) : null}

      {/* Alo plaque logo decals. */}
      {plaqueDecals.map((d) => (
        <mesh key={d.key} geometry={d.geometry} position={d.position} rotation={d.rotation}>
          <meshBasicMaterial map={atlas.texture} toneMapped={false} side={DoubleSide} />
        </mesh>
      ))}
    </Suspense>
  );
}
