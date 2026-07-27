// Phase 45 (Part 11) — the rail-lands mount. Consumes the pure world/toronto/railLands.ts layout
// (the arbiter already holds its claims — see worldContext.ts step 3b) and renders it through the
// paths this project already has, adding no new renderer machinery:
//
//   1 · SOLIDS   — aquarium + roundhouse + locomotive + the patio string-lights, merged into ONE
//                  vertex-coloured unlit mesh (they all share the same material, so merging them
//                  costs nothing and saves three draw calls).
//   2 · PAINT    — ballast beds, tie bands, the turntable deck/bridge and the radial bay stubs as
//                  one flat mesh, every Y a rung of config/layering.ts's GROUND_STACK.
//   3 · SIGNS    — the "AQUARIUM" fascia + blade and the "STEAM WHISTLE" fascia on ONE small
//                  CanvasTexture. MIPMAPPED, unlike every other pixel atlas in this project: these
//                  wordmarks ARE minified in play (a ~1 wu band read from across the yard), which
//                  is exactly the Phase 41 route-board defect. The MAG filter stays Nearest, so the
//                  near-range pixel-art look is untouched.
//   4 · DECALS   — the Steam Whistle logo-atlas cell (nearest, mips OFF — the shared atlas's own
//                  `magnificationOnly` policy, config/surfaces.ts ATLAS_POLICY).
//   5 · PROPS    — the brewery patio's pack props through CityPackBatched, one BatchedMesh per
//                  model id (the VenueDressLayer idiom).
//   6 · COLLIDERS— one fixed BUILDING body holding every cuboid, each wrapped in
//                  RegisteredCuboidCollider so ramming the aquarium/roundhouse/locomotive resolves
//                  through the entity registry like every other Toronto building.
//
// UNLIT-LITERAL throughout (the P23/P24 material verdict). Every geometry and texture is memoized
// and disposed on unmount so a remount never leaks GPU memory.

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { CanvasTexture, DoubleSide, NearestFilter, NearestMipmapLinearFilter, SRGBColorSpace, type Mesh } from 'three';
import { RigidBody } from '@react-three/rapier';
import { interactionGroups } from '../../../config';
import { RegisteredCuboidCollider } from '../../landmarks/registeredCollider';
import { buildDistricts, torontoDistrictIndexAt } from '../districts';
import { getLogoAtlas } from '../logoAtlas';
import { occlusionRegistry } from '../occlusionFade';
import {
  SIGN_ATLAS,
  buildRailLandsDecalGeometry,
  buildRailLandsPaint,
  buildRailLandsSignGeometry,
  buildRailLandsSolids,
  type RailLandsLayout,
  type SignCellId,
} from '../railLands';
import { torontoBuildingEntryAt } from '../torontoColliders';
import { CityPackBatched } from './CityPackBatched';
import type { CityPackPlacement } from './CityPackInstances';

/** Backing plate + wordmark colours, matching the logo atlas's "lit sign box against the unlit
 * dusk slice" read (world/toronto/logoAtlas.ts's cell convention). */
const SIGN_PLATE = '#101418';
const SIGN_INK = '#eaf4ff';
const SIGN_ACCENT = '#2f6f4f'; // Steam Whistle's brand family is green-dominant (researcher round 7)

/** Same BUILDING interaction group every other Toronto building body uses. */
const BUILDING_GROUPS = interactionGroups('BUILDING');

// --- the 5×7 pixel font (the logoAtlas wordmark idiom, restricted to the letters these signs use) --
const GLYPH_W = 5;
const GLYPH_H = 7;
const FONT: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  W: ['10001', '10001', '10001', '10001', '10101', '11011', '10001'],
};
const BLANK: readonly string[] = ['00000', '00000', '00000', '00000', '00000', '00000', '00000'];

function drawGlyph(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, scale: number): void {
  const glyph = FONT[ch] ?? BLANK;
  for (let row = 0; row < GLYPH_H; row++) {
    const bits = glyph[row];
    for (let col = 0; col < GLYPH_W; col++) {
      if (bits[col] === '1') ctx.fillRect(x + col * scale, y + row * scale, scale, scale);
    }
  }
}

/** Horizontal wordmark, centred in the cell and auto-scaled to fit its width. */
function drawRow(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, maxH: number): void {
  const letters = [...text];
  const scaleW = Math.floor(maxW / (letters.length * (GLYPH_W + 1)));
  const scale = Math.max(1, Math.min(scaleW, Math.floor(maxH / GLYPH_H)));
  const totalW = letters.length * GLYPH_W * scale + (letters.length - 1) * scale;
  let penX = cx - totalW / 2;
  const y = cy - (GLYPH_H * scale) / 2;
  for (const ch of letters) {
    if (ch !== ' ') drawGlyph(ctx, ch, penX, y, scale);
    penX += (GLYPH_W + 1) * scale;
  }
}

/** Vertical (blade/marquee) wordmark: letters stacked top → bottom, the way a real blade sign reads. */
function drawColumn(ctx: CanvasRenderingContext2D, text: string, cx: number, y0: number, h: number, maxW: number): void {
  const letters = [...text];
  const cell = h / letters.length;
  const scale = Math.max(1, Math.min(Math.floor(maxW / GLYPH_W), Math.floor(cell / (GLYPH_H + 1))));
  letters.forEach((ch, i) => {
    if (ch === ' ') return;
    drawGlyph(ctx, ch, cx - (GLYPH_W * scale) / 2, y0 + cell * i + (cell - GLYPH_H * scale) / 2, scale);
  });
}

/**
 * The rail-lands sign texture: three cells on one small canvas. Mipmaps ON + NearestMipmapLinear
 * minification — the Phase 41 route-board lesson, applied up front (an unmipped minified pixel
 * wordmark strobes). Mag filter stays Nearest so the near-range look is pure pixel art.
 */
function makeSignTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIGN_ATLAS.width;
  canvas.height = SIGN_ATLAS.height;
  const tex = new CanvasTexture(canvas);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = SRGBColorSpace;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    tex.needsUpdate = true;
    return tex;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = SIGN_PLATE;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cell = (id: SignCellId) => SIGN_ATLAS.cells[id];
  const aq = cell('aquariumFascia');
  ctx.fillStyle = SIGN_INK;
  drawRow(ctx, aq.text, aq.x + aq.w / 2, aq.y + aq.h / 2, aq.w - 8, aq.h - 6);

  const sw = cell('steamWhistleFascia');
  ctx.fillStyle = SIGN_ACCENT;
  ctx.fillRect(sw.x, sw.y, sw.w, sw.h);
  ctx.fillStyle = SIGN_INK;
  drawRow(ctx, sw.text, sw.x + sw.w / 2, sw.y + sw.h / 2, sw.w - 8, sw.h - 6);

  const blade = cell('aquariumBlade');
  ctx.fillStyle = SIGN_PLATE;
  ctx.fillRect(blade.x, blade.y, blade.w, blade.h);
  ctx.fillStyle = SIGN_INK;
  drawColumn(ctx, blade.text, blade.x + blade.w / 2, blade.y + 4, blade.h - 8, blade.w - 6);

  tex.needsUpdate = true;
  return tex;
}

export interface RailLandsLayerProps {
  readonly layout: RailLandsLayout;
  /** A/B material arm for the batched patio props (the shared `cityPackUnlit` toggle). */
  readonly unlit: boolean;
}

export function RailLandsLayer({ layout, unlit }: RailLandsLayerProps) {
  const solids = useMemo(() => buildRailLandsSolids(layout), [layout]);
  const paint = useMemo(() => buildRailLandsPaint(layout), [layout]);
  const signGeometry = useMemo(() => buildRailLandsSignGeometry(layout), [layout]);
  const decalGeometry = useMemo(() => buildRailLandsDecalGeometry(layout), [layout]);
  const signTexture = useMemo(() => makeSignTexture(), []);
  const atlas = useMemo(() => getLogoAtlas(), []);
  // Same spatial district lookup NamedBuildingsLayer/HeroesLayer use — these placements are
  // street-referenced, not district-referenced, so the districtId is resolved from the position.
  const districts = useMemo(() => buildDistricts(), []);

  useEffect(
    () => () => {
      solids.geometry.dispose();
      paint.geometry.dispose();
      signGeometry.geometry.dispose();
      decalGeometry.geometry.dispose();
      signTexture.dispose();
    },
    [solids, paint, signGeometry, decalGeometry, signTexture],
  );

  // A.5 occlusion: the merged solids mesh joins the material-opacity fade path, like the named
  // boxes and the two heroes. These buildings are far under the eye line, so they can only ever
  // block the boresight in the last few metres of a drive-by — which is precisely the transient
  // case the fader exists for.
  const solidsRef = useRef<Mesh>(null);
  useEffect(() => {
    const mesh = solidsRef.current;
    if (!mesh) return;
    occlusionRegistry.add(mesh);
    return () => occlusionRegistry.remove(mesh);
  }, []);

  // Patio props, grouped by model id → one CityPackBatched each (the VenueDressLayer idiom).
  const byModel = useMemo(() => {
    const groups = new Map<string, CityPackPlacement[]>();
    for (const p of layout.props) {
      const list = groups.get(p.modelId) ?? [];
      list.push({ position: p.position, rotationY: p.rotationY });
      groups.set(p.modelId, list);
    }
    return [...groups.entries()].map(([id, placements]) => ({ id, placements }));
  }, [layout.props]);

  return (
    <>
      {/* Ground dressing — ballast beds, tie bands, the turntable deck + bridge, the bay stubs. */}
      <mesh geometry={paint.geometry} frustumCulled={false}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>

      {/* The three bespoke solids + the patio string-lights, merged into one unlit mesh. */}
      <mesh ref={solidsRef} geometry={solids.geometry} castShadow frustumCulled={false}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>

      {/* Wordmark signs — the mipmapped rail-lands sign texture. */}
      {signGeometry.count > 0 ? (
        <mesh geometry={signGeometry.geometry} frustumCulled={false}>
          <meshBasicMaterial map={signTexture} toneMapped={false} side={DoubleSide} />
        </mesh>
      ) : null}

      {/* Steam Whistle logo decals — the shared 32×32 homage atlas (nearest, mips off). */}
      {decalGeometry.count > 0 ? (
        <mesh geometry={decalGeometry.geometry} frustumCulled={false}>
          <meshBasicMaterial map={atlas.texture} transparent={false} toneMapped={false} side={DoubleSide} />
        </mesh>
      ) : null}

      {/* Brewery-patio pack props — cosmetic, colliderless (the venue-prop precedent). ONLY these
          suspend (the pack GLBs stream from public/), so the Suspense boundary is scoped to them:
          the bespoke landmarks and their colliders must not wait on an asset fetch to exist. */}
      <Suspense fallback={null}>
        {byModel.map(({ id, placements }) => (
          <CityPackBatched key={id} id={id} placements={placements} unlit={unlit} />
        ))}
      </Suspense>

      {/* Indestructible fixed BUILDING colliders. Convex cuboids only (the locked collider law);
          the roundhouse arc is four DEEP chords rather than many shallow plates so the car meets a
          flat wall per bay group and can never wedge into a sliver seam. */}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {layout.colliders.map((c) => (
          <RegisteredCuboidCollider
            key={c.id}
            entry={torontoBuildingEntryAt(torontoDistrictIndexAt(c.cx, c.cz, districts))}
            halfExtents={[c.hx, c.hy, c.hz]}
            position={[c.cx, c.hy, c.cz]}
            rotationY={c.yawRad}
          />
        ))}
      </RigidBody>
    </>
  );
}
