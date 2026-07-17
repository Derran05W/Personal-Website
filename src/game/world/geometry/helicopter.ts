// Ambient-helicopter geometry (Phase 14 Task 2; TDD §5.7). Mirrors world/geometry/kit.ts's
// established low-poly boxy language (TankMesh.tsx / streetProps.ts): every part is an addBox
// (or a pair of thin boxes for the rotor) sampling ONE flat palette cell per face, no curves,
// no rounding — "rounded-ish" is achieved the same way every other unit in this codebase reads
// as "chunky but recognizable" (a stepped canopy bump + tapered tail assembly), not literal
// geometric rounding.
//
// ONE CANONICAL GEOMETRY, THREE LIVERIES VIA INSTANCE TINT (the family's established trick —
// see parkedCar.ts's file header and ai/TrafficMesh.tsx's TRAFFIC_TINTS): buildHeliBody() bakes
// its hull/tail/canopy/trim faces onto a small set of palette cells chosen so that multiplying
// the WHOLE instance by one of the three HELI_LIVERY_TINT colours (ai/HeliMesh.tsx) reproduces
// a distinct, coherent livery without a second geometry:
//   - Hull + tail boom sample `liveryWhite` (near-white) — the tint IS the body colour.
//   - The tail-fin accent panel samples `policeBlue` directly (not liveryWhite) — under the
//     POLICE tint (chosen as pure white, i.e. the identity colour) it renders as an exact,
//     vivid policeBlue fin against a white hull: the "police blue/white" two-tone the brief
//     asks for, from ONE geometry. Under the SWAT tint (near-black) the same fin multiplies
//     down to near-invisible navy — reads as part of the unmarked blacked-out look (matches
//     ai/units/SwatMesh.tsx's "no lightbar, paint IS the tell" convention). Under the MILITARY
//     tint (drab olive) it multiplies to a muted grey-teal that blends into the drab body
//     instead of clashing — no livery needs a special-case in the geometry itself.
//   - Canopy samples `glassCool` (tinted window glass, matches parkedCar.ts / SwatMesh.tsx).
//   - Skids/engine block/mast sample `metalDark` (stays a dark trim shade under every tint,
//     matching every ground unit's wheel/bumper convention).
// This is the same "multiply-by-instanceColor" trick every InstancedMesh in the game already
// relies on (world/palette.ts's getCityMaterial sets USE_INSTANCING_COLOR); the only new idea
// here is deliberately picking the POLICE tint to be white so ONE non-white baked cell (the fin)
// becomes a true second colour for exactly that livery.
//
// TAIL ROTOR IS STATIC (not separately spun): a tiny stationary crossed-blade stub is baked
// into the body geometry at the tail fin. Documented deviation from "spin every rotor" — the
// tail rotor's disc is ~0.7 m across on a heli that only ever appears 35 m up (TDD §5.7's
// orbit altitude) with the camera rarely looking that way (phase-14-plan.md's searchlight
// decision: "cone carries the feature, camera rarely looks up"); animating a second spin axis
// through a second InstancedMesh buys triangles and a matrix-composition seam for a detail that
// reads as a blur either way. The MAIN rotor (the actually-legible silhouette element) gets the
// real per-frame spin — see buildHeliRotorBlade() below + ai/HeliMesh.tsx.
//
// +Z-forward, chassis-centered convention (matches TankMesh.tsx's HULL frame): origin sits at
// the fuselage's geometric center, y=0 there, so ai/heliTypes.ts's HeliSlot.{x,y,z} can be
// dropped straight in as the body's world position with no extra offset.

import { BufferGeometry } from 'three';
import { PaletteCell } from '../archetypes';
import { addBox, createBuilder, toBufferGeometry } from './kit';

/** Fuselage + tail + skids dimensions (m). Loosely car-scaled (the player chassis is ~4 m
 * long, TankMesh's hull ~4.8 m) — a light-heli-sized body, small enough to read as agile/
 * ambient rather than as another ground combat unit. */
export const HELI_BODY = {
  hull: { hw: 0.62, hh: 0.5, hl: 1.15 },
  canopy: { hw: 0.53, halfLenM: 0.55, riseM: 0.32, zCenterM: 0.4 },
  engine: { hw: 0.34, halfLenM: 0.32, riseM: 0.22, zCenterM: -0.63 },
  mast: { hw: 0.09 },
  // Rotor hub height above the hull center (m) — buildHeliRotorBlade's MAIN rotor instance is
  // positioned here (ai/HeliMesh.tsx). Kept in this file so the body's mast visually reaches
  // exactly the same point the separately-instanced rotor sits at.
  rotorHubY: 0.5 + 0.75,
  tailBoom: { halfW: 0.14, y0: -0.1, y1: 0.18, lengthM: 1.6 },
  fin: { halfW: 0.05, y0: -0.05, y1: 0.55, halfLenM: 0.22 },
  tailRotor: { armM: 0.32, halfThickM: 0.025, halfWidthM: 0.05 },
  skid: { halfThickM: 0.06, yCenterM: -(0.5 + 0.42), xOffsetM: 0.62 * 0.95, frontOvershootM: 0.15, rearInsetM: 0.9 },
} as const;

/** Main-rotor blade span (m) — a full-diameter crossed pair, so RADIUS is the distance from
 * the hub to a blade tip (overall rotor diameter = 2 * RADIUS). Sized big enough to read as
 * "helicopter" in silhouette from below at TDD §5.7's 35 m orbit altitude. */
export const HELI_ROTOR = {
  radiusM: 4.4,
  halfWidthM: 0.14,
  halfThickM: 0.025,
} as const;

/**
 * Canonical helicopter body: hull, stepped canopy bump, engine block, mast stub, tail boom,
 * tail fin (the tintable accent panel — see file header), and a static tail-rotor stub. Two
 * long skids complete the silhouette. No emissive faces (ambient unit — no strobe in v1,
 * matching ai/units/SwatMesh.tsx's "paint is the only tell" precedent); callers still need an
 * `aEmissiveOn` instance attribute because the shared palette material samples it
 * unconditionally (world/palette.ts) — allocate it all-zero, same as ai/TrafficMesh.tsx.
 */
export function buildHeliBody(): BufferGeometry {
  const white = PaletteCell.liveryWhite;
  const glass = PaletteCell.glassCool;
  const dark = PaletteCell.metalDark;
  const accent = PaletteCell.policeBlue; // tintable-to-near-invisible accent — see file header
  const b = createBuilder();
  const { hull, canopy, engine, mast, tailBoom, fin, tailRotor, skid } = HELI_BODY;

  // Hull — the main tintable mass. All 6 faces: the heli is seen from every angle while
  // orbiting/flying, unlike a ground vehicle's permanently-hidden underside.
  addBox(
    b,
    { minX: -hull.hw, maxX: hull.hw, minY: -hull.hh, maxY: hull.hh, minZ: -hull.hl, maxZ: hull.hl },
    {
      px: { albedo: white },
      nx: { albedo: white },
      py: { albedo: white },
      ny: { albedo: white },
      pz: { albedo: white },
      nz: { albedo: white },
    },
  );

  // Canopy — a stepped glassCool bump toward the nose (+Z), the "rounded-ish" cockpit read.
  // Underside flush on the hull roof, never seen — omitted.
  addBox(
    b,
    {
      minX: -canopy.hw,
      maxX: canopy.hw,
      minY: hull.hh,
      maxY: hull.hh + canopy.riseM,
      minZ: canopy.zCenterM - canopy.halfLenM,
      maxZ: canopy.zCenterM + canopy.halfLenM,
    },
    {
      px: { albedo: glass },
      nx: { albedo: glass },
      py: { albedo: glass },
      pz: { albedo: glass },
      nz: { albedo: glass },
    },
  );

  // Engine block — a smaller metalDark bump toward the tail-top, above the mast base.
  // Underside flush on the hull roof — omitted.
  addBox(
    b,
    {
      minX: -engine.hw,
      maxX: engine.hw,
      minY: hull.hh,
      maxY: hull.hh + engine.riseM,
      minZ: engine.zCenterM - engine.halfLenM,
      maxZ: engine.zCenterM + engine.halfLenM,
    },
    {
      px: { albedo: dark },
      nx: { albedo: dark },
      py: { albedo: dark },
      pz: { albedo: dark },
      nz: { albedo: dark },
    },
  );

  // Mast — thin metalDark stub reaching from the hull roof up to the rotor hub height, so the
  // separately-instanced main rotor (ai/HeliMesh.tsx) doesn't look like it's floating detached.
  // Top/bottom omitted (flush against the hull below, hidden by the rotor hub above).
  addBox(
    b,
    { minX: -mast.hw, maxX: mast.hw, minY: hull.hh, maxY: HELI_BODY.rotorHubY, minZ: -mast.hw, maxZ: mast.hw },
    { px: { albedo: dark }, nx: { albedo: dark }, pz: { albedo: dark }, nz: { albedo: dark } },
  );

  // Tail boom — liveryWhite (continues the tintable hull colour rearward), running from the
  // hull's rear face out to the fin. The face flush against the hull (+Z end) is hidden and
  // omitted; the far (-Z) end gets a cap since the fin (below) is narrower and doesn't fully
  // cover it.
  const boomZ0 = -hull.hl - tailBoom.lengthM;
  const boomZ1 = -hull.hl;
  addBox(
    b,
    { minX: -tailBoom.halfW, maxX: tailBoom.halfW, minY: tailBoom.y0, maxY: tailBoom.y1, minZ: boomZ0, maxZ: boomZ1 },
    {
      px: { albedo: white },
      nx: { albedo: white },
      py: { albedo: white },
      ny: { albedo: white },
      nz: { albedo: white },
      // pz omitted: flush against the hull rear, never seen.
    },
  );

  // Tail fin — the ACCENT panel (see file header): baked as policeBlue regardless of livery,
  // so instance tint alone decides whether it reads as a vivid blue stripe (police, tint =
  // white) or fades into the body (swat/military, dark tints). Bottom flush with the boom,
  // omitted.
  const finZ0 = boomZ0 - fin.halfLenM + 0.05;
  const finZ1 = boomZ0 + fin.halfLenM + 0.05;
  addBox(
    b,
    { minX: -fin.halfW, maxX: fin.halfW, minY: fin.y0, maxY: fin.y1, minZ: finZ0, maxZ: finZ1 },
    {
      px: { albedo: accent },
      nx: { albedo: accent },
      py: { albedo: accent },
      pz: { albedo: accent },
      nz: { albedo: accent },
    },
  );

  // Static tail-rotor stub — a tiny crossed-blade cross mounted on the fin's +X side (see file
  // header: not separately spun). Two thin metalDark boxes, top/bottom faces only (the same
  // "thin plate, skip the edges" trick as buildHeliRotorBlade below).
  const hubX = fin.halfW + 0.06;
  const hubY = (fin.y0 + fin.y1) / 2;
  const hubZ = (finZ0 + finZ1) / 2;
  addBox(
    b,
    {
      minX: hubX - tailRotor.halfThickM,
      maxX: hubX + tailRotor.halfThickM,
      minY: hubY - tailRotor.armM,
      maxY: hubY + tailRotor.armM,
      minZ: hubZ - tailRotor.halfWidthM,
      maxZ: hubZ + tailRotor.halfWidthM,
    },
    { px: { albedo: dark }, nx: { albedo: dark } },
  );
  addBox(
    b,
    {
      minX: hubX - tailRotor.halfThickM,
      maxX: hubX + tailRotor.halfThickM,
      minY: hubY - tailRotor.halfWidthM,
      maxY: hubY + tailRotor.halfWidthM,
      minZ: hubZ - tailRotor.armM,
      maxZ: hubZ + tailRotor.armM,
    },
    { px: { albedo: dark }, nx: { albedo: dark } },
  );

  // Skids — two long metalDark rails below the hull, overshooting the nose slightly (the
  // classic light-heli silhouette). Bottom (bearing on nothing — the heli never lands in v1)
  // omitted for a cheap triangle save; every other face stays since the skids read from both
  // side and above/below during the orbit.
  const skidZ0 = -hull.hl + skid.rearInsetM;
  const skidZ1 = hull.hl + skid.frontOvershootM;
  for (const sign of [-1, 1] as const) {
    const cx = sign * skid.xOffsetM;
    addBox(
      b,
      {
        minX: cx - skid.halfThickM,
        maxX: cx + skid.halfThickM,
        minY: skid.yCenterM - skid.halfThickM,
        maxY: skid.yCenterM + skid.halfThickM,
        minZ: skidZ0,
        maxZ: skidZ1,
      },
      {
        px: { albedo: dark },
        nx: { albedo: dark },
        py: { albedo: dark },
        pz: { albedo: dark },
        nz: { albedo: dark },
      },
    );
  }

  return toBufferGeometry(b);
}

/**
 * Main-rotor blade primitive: two perpendicular thin metalDark plates crossing at the local
 * origin (the hub), each spanning the full rotor diameter. Only top/bottom faces are baked
 * (the "thin plate" trick buildHeliBody's tail-rotor stub also uses) — the blade edges are a
 * few centimetres thick and never worth a triangle. ai/HeliMesh.tsx positions this at each
 * live heli's hub (HELI_BODY.rotorHubY above the body) and spins it in-place every frame from
 * `slot.rotor`; the SAME geometry serves both live heli instances (InstancedMesh, capacity 2).
 * A tiny Y offset between the two blades (see the second addBox's minY/maxY) avoids the two
 * coplanar quads z-fighting where they cross at the hub.
 */
export function buildHeliRotorBlade(): BufferGeometry {
  const dark = PaletteCell.metalDark;
  const { radiusM, halfWidthM, halfThickM } = HELI_ROTOR;
  const b = createBuilder();

  // Blade A — long axis along local X.
  addBox(
    b,
    { minX: -radiusM, maxX: radiusM, minY: -halfThickM, maxY: halfThickM, minZ: -halfWidthM, maxZ: halfWidthM },
    { py: { albedo: dark }, ny: { albedo: dark } },
  );
  // Blade B — long axis along local Z, nudged up a hair so it doesn't share exact Y with
  // blade A at the crossing square (z-fight guard, see doc comment above).
  const eps = halfThickM * 0.6;
  addBox(
    b,
    {
      minX: -halfWidthM,
      maxX: halfWidthM,
      minY: -halfThickM + eps,
      maxY: halfThickM + eps,
      minZ: -radiusM,
      maxZ: radiusM,
    },
    { py: { albedo: dark }, ny: { albedo: dark } },
  );

  return toBufferGeometry(b);
}
