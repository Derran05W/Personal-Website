// Helicopter searchlight — the ★2+ "drama package" (Phase 14 Task 3; TDD §5.7/§8.2). ONE
// real SpotLight (shadows OFF) hangs off the LEAD heli (ai/heliTypes.ts slot 0 — "owns the
// searchlight") and tracks the player with lag + slight overshoot; a FAKE volumetric cone
// (additive translucent mesh, heli → beam-ground intersection) plus a soft ground-spot
// ellipse carry the visible drama, because the fixed ~50° follow camera (TDD §5.3) rarely
// tilts up to the heli itself. All the load-bearing math (the aim spring, the analytic
// beam→ground intersection) is pure and unit-tested in fx/searchlightMath.ts; this file is
// the R3F wiring + allocation-free per-frame drive.
//
// SEAMS THIS READS (all module-scope refs, no props, no physics context needed):
//   • ai/heliTypes.ts `heliRef` — slot 0 is the lead heli; livery/presence/x/y/z. When the
//     ref is null (helicopter.ts / Task 1 not mounted, or no run) or slot 0 is empty or its
//     presence is below SEARCHLIGHT.presenceThreshold, the ENTIRE rig hides (spot intensity
//     0, cone + ground-spot invisible). Brightness fades with `presence` (the fly-in/out ramp).
//   • vehicles/playerRef.ts `playerVehicle` — the beam aims at the INTERPOLATED render pose
//     (readState().pose, TDD §7). Using the raw physics pose here would micro-jitter brutally
//     at the far end of a 35 m beam; the interpolated pose matches what the camera sees.
//
// GRID-INDEPENDENCE (requirement 5): nothing in this file consults powergrid/grid.ts or
// emitters.ts. It is aircraft light — it renders IDENTICALLY over a lit or a blacked-out
// district, and that dark-street contrast is the whole point of the effect.
//
// FLAT-GROUND ASSUMPTION: the beam→ground intersection is an analytic ray/plane(y=0) solve
// (searchlightMath.beamGroundIntersectionY0) — no raycasts. The city is a flat slab, so this
// is exact; sloped-terrain beam projection is explicitly out of scope (same stance as
// fx/SkidMarks.tsx's flat-ground guard).
//
// ONE REAL LIGHT: the JSX below renders exactly one <spotLight>. The <primitive> target is a
// plain Object3D (not a light); the cone and ground-spot are additive meshes. So mounting
// this adds exactly ONE light to the scene, with zero shadow cost.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  ConeGeometry,
  DoubleSide,
  Float32BufferAttribute,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  type SpotLight,
} from 'three';
import { SEARCHLIGHT } from '../config';
import { useGameStore } from '../state/store';
import { heliRef } from '../ai/heliTypes';
import { playerVehicle } from '../vehicles/playerRef';
import {
  beamGroundIntersectionY0,
  coneBaseRadius,
  createSpringVec3,
  snapSpringVec3,
  springConstants,
  stepSpringVec3,
} from './searchlightMath';

// --- module-scope scratch (no per-frame allocation) ----------------------------------------
const NEG_Y = new Vector3(0, -1, 0); // cone's local apex→base axis
const _coneDir = new Vector3();
// Park the whole rig far below the map when idle (mirrors fx/Explosions.tsx's parkY trick):
// intensity 0 already makes the spot dark, but parking keeps a stray frame from lighting the
// origin before the first present frame lands.
const PARK_Y = -1000;

/** Build the fake-cone geometry once: a unit, open-ended cone with its APEX at the origin
 * and its base ring one unit down the -Y axis (base radius 1). Baked per-vertex greyscale
 * brightness fades apex→base so, under additive blending, the shaft is bright at the heli
 * and dims toward the ground (fake attenuation). Scaled/oriented per frame by the component. */
function buildConeGeometry(): ConeGeometry {
  const g = new ConeGeometry(1, 1, SEARCHLIGHT.cone.radialSegments, 1, true);
  // ConeGeometry: apex at +0.5, base ring at -0.5. Shift so the apex sits at the origin and
  // the base ring at y=-1 (local -Y is then the apex→base axis, matching NEG_Y above).
  g.translate(0, -0.5, 0);
  const pos = g.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const { apexBrightness, baseBrightness } = SEARCHLIGHT.cone;
  for (let i = 0; i < pos.count; i += 1) {
    // local y ∈ [-1, 0]: 0 = apex, -1 = base. tBase ∈ [0,1] grows toward the ground.
    const tBase = -pos.getY(i);
    const b = apexBrightness + (baseBrightness - apexBrightness) * tBase;
    colors[i * 3 + 0] = b;
    colors[i * 3 + 1] = b;
    colors[i * 3 + 2] = b;
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

/** Radial-gradient CanvasTexture: opaque warm-white center fading to transparent at the rim,
 * so the additive ground-spot plane reads as a soft-edged glow ellipse (no hard quad edge). */
function buildGroundTexture(): CanvasTexture {
  const size = SEARCHLIGHT.ground.textureSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function Searchlight() {
  const spotRef = useRef<SpotLight>(null);
  const coneRef = useRef<Mesh>(null);
  const groundRef = useRef<Mesh>(null);

  // The spot's aim target (an Object3D placed in the scene so the SpotLight can read its
  // world position as the beam direction). Its position is the spring-smoothed aim point.
  const target = useMemo(() => new Object3D(), []);

  // Per-frame spring state (lag + overshoot). Lazy-ref-init (SkidMarks/Explosions idiom):
  // plain mutable state, not reachable through useMemo's frozen-value rule.
  const aimRef = useRef(createSpringVec3());
  // True while the rig is currently shown — lets us hard-snap the spring the frame the heli
  // (re)appears instead of lerping the beam in from a stale origin.
  const shownRef = useRef(false);

  // Quality tier drives the cone opacity (low tier is dim; P18 may set it to 0 = off).
  // Reactive read — quality changes are rare, so re-render cost is a non-issue.
  const quality = useGameStore((s) => s.settings.quality);

  const coneGeometry = useMemo(() => buildConeGeometry(), []);
  const coneMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color(SEARCHLIGHT.cone.color),
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide, // both walls add → the grazing silhouette rim brightens (fake volume)
        toneMapped: false,
      }),
    [],
  );

  // Ground quad: PlaneGeometry(2,2) rotated flat in XZ (extent -1..1 → radius 1 at scale 1),
  // same flat-ground setup as fx/SkidMarks.tsx's decal quads.
  const groundTexture = useMemo(() => buildGroundTexture(), []);
  const groundGeometry = useMemo(() => {
    const g = new PlaneGeometry(2, 2);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const groundMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        map: groundTexture,
        color: new Color(SEARCHLIGHT.ground.color),
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [groundTexture],
  );

  useEffect(() => {
    return () => {
      coneGeometry.dispose();
      coneMaterial.dispose();
      groundGeometry.dispose();
      groundMaterial.dispose();
      groundTexture.dispose();
    };
  }, [coneGeometry, coneMaterial, groundGeometry, groundMaterial, groundTexture]);

  useFrame((state, dt) => {
    const spot = spotRef.current;
    const cone = coneRef.current;
    const ground = groundRef.current;
    if (!spot || !cone || !ground) return;

    const lead = heliRef.current?.slots[0];
    const model = playerVehicle.current;
    const present =
      !!lead && lead.livery !== null && lead.presence > SEARCHLIGHT.presenceThreshold && !!model;

    if (!present) {
      if (shownRef.current) {
        spot.intensity = 0;
        spot.position.set(0, PARK_Y, 0);
        cone.visible = false;
        ground.visible = false;
        shownRef.current = false;
      }
      return;
    }

    // Player aim target = interpolated render pose (TDD §7), lifted to the beam-aim height.
    const pose = model.readState().pose;
    const px = pose.position.x;
    const pz = pose.position.z;
    const aimY = SEARCHLIGHT.aim.height;

    const aim = aimRef.current;
    if (!shownRef.current) {
      // First frame shown: snap onto the player so the beam doesn't sweep in from nowhere.
      snapSpringVec3(aim, px, aimY, pz);
      cone.visible = true;
      ground.visible = true;
      shownRef.current = true;
    }

    // Advance the lag/overshoot spring toward the player (k/c re-derived each frame so the
    // leva SEARCHLIGHT.aim sliders tune feel live).
    const { k, c } = springConstants(SEARCHLIGHT.aim.freqHz, SEARCHLIGHT.aim.dampingRatio);
    stepSpringVec3(aim, px, aimY, pz, dt, k, c, SEARCHLIGHT.aim.maxSubDt);

    const hx = lead.x;
    const hy = lead.y;
    const hz = lead.z;
    const presence = lead.presence < 1 ? lead.presence : 1;

    // --- the one real SpotLight ---------------------------------------------------------
    const L = SEARCHLIGHT.light;
    spot.position.set(hx, hy, hz);
    spot.color.set(L.color);
    spot.angle = L.halfAngleRad;
    spot.penumbra = L.penumbra;
    spot.distance = L.distance;
    spot.decay = L.decay;
    spot.intensity = L.intensity * presence;
    target.position.set(aim.x, aim.y, aim.z);

    // --- beam → ground intersection (analytic, flat ground) -----------------------------
    const hit = beamGroundIntersectionY0(hx, hy, hz, aim.x, aim.y, aim.z);
    if (!hit) {
      // Degenerate geometry (shouldn't happen with a heli above an on-ground player) —
      // keep the real light, hide the fake volume for this frame.
      cone.visible = false;
      ground.visible = false;
      return;
    }
    cone.visible = true;

    const baseR = coneBaseRadius(hit.dist, L.halfAngleRad) * SEARCHLIGHT.cone.radiusScale;

    // --- fake volumetric cone: apex at the heli, base ring at the ground hit -------------
    _coneDir.set(hit.x - hx, -hy, hit.z - hz).normalize(); // heli → ground, y-drop is exactly hy
    cone.position.set(hx, hy, hz);
    cone.quaternion.setFromUnitVectors(NEG_Y, _coneDir);
    cone.scale.set(baseR, hit.dist, baseR); // x/z = base radius, y = beam length

    const coneOpacity = SEARCHLIGHT.cone.opacity[quality] ?? SEARCHLIGHT.cone.opacity.high;
    if (coneOpacity <= 0) {
      cone.visible = false; // P18 low-tier trim: cone off entirely
    } else {
      // Subtle searchlight shimmer on top of the tier opacity + presence fade. Mutate the
      // material through the mesh ref (cone.material === coneMaterial): the useMemo'd handle
      // itself is frozen to the react-hooks immutability rule, the mesh's copy of it is not.
      const flicker =
        1 + SEARCHLIGHT.cone.flickerAmp * Math.sin(state.clock.elapsedTime * SEARCHLIGHT.cone.flickerHz * Math.PI * 2);
      (cone.material as MeshBasicMaterial).opacity = coneOpacity * presence * flicker;
    }

    // --- soft ground-spot ellipse at the beam foot --------------------------------------
    const gR = baseR * SEARCHLIGHT.ground.radiusScale;
    ground.visible = true;
    ground.position.set(hit.x, SEARCHLIGHT.ground.yOffset, hit.z);
    ground.scale.set(gR, 1, gR);
    (ground.material as MeshBasicMaterial).opacity = SEARCHLIGHT.ground.opacity * presence;
  });

  // frustumCulled off on both meshes: the cone/ground-spot ride far from their own
  // near-origin computed bounds as the heli orbits the map (same reasoning as the other FX
  // meshes). No shadows anywhere — the spot is castShadow={false}, the meshes are additive.
  return (
    <>
      <spotLight
        ref={spotRef}
        castShadow={false}
        intensity={0}
        color={SEARCHLIGHT.light.color}
        angle={SEARCHLIGHT.light.halfAngleRad}
        penumbra={SEARCHLIGHT.light.penumbra}
        distance={SEARCHLIGHT.light.distance}
        decay={SEARCHLIGHT.light.decay}
        position={[0, PARK_Y, 0]}
        target={target}
      />
      <primitive object={target} />
      <mesh ref={coneRef} geometry={coneGeometry} material={coneMaterial} frustumCulled={false} visible={false} />
      <mesh ref={groundRef} geometry={groundGeometry} material={groundMaterial} frustumCulled={false} visible={false} />
    </>
  );
}
