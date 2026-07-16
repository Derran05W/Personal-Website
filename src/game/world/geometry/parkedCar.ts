// Parked-car geometry (Phase 6 Task 4; TDD §7's parking-lot props, made destructible). Echoes
// vehicles/RustySedanMesh.tsx's proportions and part breakdown (body box + cabin "window
// band" box + bumpers + wheels) but is built ground-up (origin y=0, matching every other
// world/geometry/streetProps.ts builder's convention) instead of chassis-centered, since this
// is a static instanced world prop, not a physics-driven mesh with live suspension state.
//
// ONE canonical geometry (this file's family header, streetProps.ts): the body always samples
// liveryRed. Per-instance colour variety (a lot full of different-looking cars from one
// geometry) comes from InstanceSource.color tinting, wired in world/cityInstances.ts — not
// from a second geometry variant here.
//
// +Z-forward convention (streetProps.ts file header): front bumper/headlights sit at +Z, rear
// bumper/taillights at -Z, matching propPlacements.ts's yawToward() so a placement's
// rotationY always turns the car's actual front to face the direction it was rolled to face.

import { BufferGeometry } from 'three';
import { PROP_DIMS } from '../../config';
import { PaletteCell } from '../archetypes';
import { addBox, addQuad, createBuilder, toBufferGeometry } from './kit';

export function buildParkedCar(): BufferGeometry {
  const d = PROP_DIMS.parkedCar;
  const b = createBuilder();
  const halfW = d.bodyWidthM / 2;
  const halfL = d.bodyLengthM / 2;
  const bodyTop = d.bodyBottomM + d.bodyHeightM;

  // Body: the canonical liveryRed shell. Underside touches the ground and is never seen —
  // omitted (free triangle savings, same trick every other streetProps.ts builder uses).
  addBox(
    b,
    { minX: -halfW, maxX: halfW, minY: d.bodyBottomM, maxY: bodyTop, minZ: -halfL, maxZ: halfL },
    {
      px: { albedo: PaletteCell.liveryRed },
      nx: { albedo: PaletteCell.liveryRed },
      py: { albedo: PaletteCell.liveryRed },
      pz: { albedo: PaletteCell.liveryRed },
      nz: { albedo: PaletteCell.liveryRed },
    },
  );

  // Cabin/greenhouse: one glassCool box standing proud of the roof, aft-shifted for a
  // sedan-ish silhouette (RustySedanMesh's CABIN_Z_FACTOR trick) — doubles as the window
  // band, no separate glass mesh needed. Underside sits flush on the roof, never seen.
  const cabinHalfW = d.cabinWidthM / 2;
  const cabinHalfL = d.cabinLengthM / 2;
  addBox(
    b,
    {
      minX: -cabinHalfW,
      maxX: cabinHalfW,
      minY: bodyTop,
      maxY: bodyTop + d.cabinHeightM,
      minZ: d.cabinZOffsetM - cabinHalfL,
      maxZ: d.cabinZOffsetM + cabinHalfL,
    },
    {
      px: { albedo: PaletteCell.glassCool },
      nx: { albedo: PaletteCell.glassCool },
      py: { albedo: PaletteCell.glassCool },
      pz: { albedo: PaletteCell.glassCool },
      nz: { albedo: PaletteCell.glassCool },
    },
  );

  // Front/rear bumpers: metalDark boxes standing proud of the body ends. The face flush
  // against the body and the underside (never seen) are both omitted.
  const bumperHalfW = d.bumperWidthM / 2;
  const bumperY0 = d.bumperCenterYM - d.bumperHeightM / 2;
  const bumperY1 = d.bumperCenterYM + d.bumperHeightM / 2;
  addBox(
    b,
    {
      minX: -bumperHalfW,
      maxX: bumperHalfW,
      minY: bumperY0,
      maxY: bumperY1,
      minZ: halfL,
      maxZ: halfL + d.bumperDepthM,
    },
    {
      px: { albedo: PaletteCell.metalDark },
      nx: { albedo: PaletteCell.metalDark },
      py: { albedo: PaletteCell.metalDark },
      pz: { albedo: PaletteCell.metalDark },
    },
  );
  addBox(
    b,
    {
      minX: -bumperHalfW,
      maxX: bumperHalfW,
      minY: bumperY0,
      maxY: bumperY1,
      minZ: -halfL - d.bumperDepthM,
      maxZ: -halfL,
    },
    {
      px: { albedo: PaletteCell.metalDark },
      nx: { albedo: PaletteCell.metalDark },
      py: { albedo: PaletteCell.metalDark },
      nz: { albedo: PaletteCell.metalDark },
    },
  );

  // Head/tail light accents: small quads inset proud of the body's front/rear faces, one
  // pair per end. uv2 stays the kit's DEFAULT_EMISSIVE_CELL (asphalt, never lit) — these are
  // cosmetic albedo accents only, deliberately NOT wired to aEmissiveOn (parked cars aren't a
  // blackout participant, and lit vehicle lights are Phase 16 territory — mirrors
  // buildTrafficLight's documented no-amber-cell deviation).
  const lightHalf = d.lightWidthM / 2;
  const lightY0 = d.bumperCenterYM - d.lightHeightM / 2;
  const lightY1 = d.bumperCenterYM + d.lightHeightM / 2;
  const lightSpread = halfW - lightHalf - 0.05;
  for (const sign of [-1, 1] as const) {
    const cx = sign * lightSpread;
    addQuad(
      b,
      [
        [cx - lightHalf, lightY0, halfL + d.lightInsetM],
        [cx + lightHalf, lightY0, halfL + d.lightInsetM],
        [cx + lightHalf, lightY1, halfL + d.lightInsetM],
        [cx - lightHalf, lightY1, halfL + d.lightInsetM],
      ],
      [0, 0, 1],
      PaletteCell.headWarm,
    );
    addQuad(
      b,
      [
        [cx + lightHalf, lightY0, -halfL - d.lightInsetM],
        [cx - lightHalf, lightY0, -halfL - d.lightInsetM],
        [cx - lightHalf, lightY1, -halfL - d.lightInsetM],
        [cx + lightHalf, lightY1, -halfL - d.lightInsetM],
      ],
      [0, 0, -1],
      PaletteCell.tailRed,
    );
  }

  // Wheel stubs: boxy low-poly prisms, one per corner (task brief's "boxes or 6-sided
  // prisms" — boxes chosen to match this whole builder's blocky aesthetic and keep the tri
  // budget low; kit.ts's addPrismFrustum is Y-axis-only and wheels spin about X, so a real
  // cylinder would need bespoke geometry this simple prop doesn't warrant). Top (hidden
  // under the fender) and bottom (touching the ground) faces are both omitted.
  const wheelHalfWidth = d.wheelWidthM / 2;
  const corners: readonly [number, number][] = [
    [-d.halfTrackM, d.frontZM],
    [d.halfTrackM, d.frontZM],
    [-d.halfTrackM, d.rearZM],
    [d.halfTrackM, d.rearZM],
  ];
  for (const [cx, cz] of corners) {
    addBox(
      b,
      {
        minX: cx - wheelHalfWidth,
        maxX: cx + wheelHalfWidth,
        minY: 0,
        maxY: d.wheelRadiusM * 2,
        minZ: cz - d.wheelRadiusM,
        maxZ: cz + d.wheelRadiusM,
      },
      {
        px: { albedo: PaletteCell.metalDark },
        nx: { albedo: PaletteCell.metalDark },
        pz: { albedo: PaletteCell.metalDark },
        nz: { albedo: PaletteCell.metalDark },
      },
    );
  }

  return toBufferGeometry(b);
}
