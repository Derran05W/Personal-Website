// Street-prop geometry (TDD §8.3's "all six are simple enough to build procedurally from
// boxes" — extended here to every PROP_STATIC archetype, not just vehicles). Every builder
// is PARAMETERLESS: unlike buildings (which fan out into a handful of variants), each of
// these archetypes has exactly ONE InstancedMesh in the city (world/archetypes.ts), so
// there is exactly one canonical geometry to build per family; per-instance variety comes
// from position/rotation (world/propPlacements.ts) and instanceColor tint (Task 1), not
// from geometry variants.
//
// +Z-forward convention: streetlight/trafficLight/fenceSegment/transformerBox are built so
// their local +Z axis is the "faces this way" direction (streetlight/trafficLight arm+head
// point +Z toward whatever the placement rotates them to face; fenceSegment's front/back
// faces point ±Z with its length along local X — rotationY=0 runs it east-west).
// tree/bench/hydrant/mailbox are radially/bilaterally simple enough that orientation is
// cosmetic only.

import { BufferGeometry } from 'three';
import { PROP_DIMS } from '../../config';
import { PaletteCell } from '../archetypes';
import { addBox, addPrismFrustum, addQuad, createBuilder, toBufferGeometry } from './kit';

// --- Streetlight ---------------------------------------------------------------------------
// Pole + arm reaching +Z + head hanging off the arm's end, emissive on its underside (the
// TDD §5.8 blackout-participant read: lit from below at blue hour).
export function buildStreetlight(): BufferGeometry {
  const d = PROP_DIMS.streetlight;
  const b = createBuilder();

  addPrismFrustum(b, d.poleSides, 0, d.poleHeightM, d.poleRadiusM, d.poleRadiusM, PaletteCell.metal);

  const armY0 = d.poleHeightM - d.armThicknessM / 2;
  const armY1 = d.poleHeightM + d.armThicknessM / 2;
  addBox(
    b,
    { minX: -d.armThicknessM / 2, maxX: d.armThicknessM / 2, minY: armY0, maxY: armY1, minZ: 0, maxZ: d.armLengthM },
    {
      px: { albedo: PaletteCell.metal },
      nx: { albedo: PaletteCell.metal },
      py: { albedo: PaletteCell.metal },
      ny: { albedo: PaletteCell.metal },
      pz: { albedo: PaletteCell.metal },
      // nz omitted: flush against the pole, never seen.
    },
  );

  const headZ0 = d.armLengthM - d.headDepthM / 2;
  const headZ1 = d.armLengthM + d.headDepthM / 2;
  addBox(
    b,
    {
      minX: -d.headWidthM / 2,
      maxX: d.headWidthM / 2,
      minY: d.poleHeightM - d.headHeightM,
      maxY: d.poleHeightM,
      minZ: headZ0,
      maxZ: headZ1,
    },
    {
      // The WHOLE head is the emissive sodium-lamp read (uv2=streetlightWarm; the
      // per-instance gate decides whether it's actually lit — kit.ts's file header).
      // A physically-minded underside-only glow was invisible from the elevated §5.3
      // gameplay camera, which would have made Phase 13's blackouts unreadable — the
      // head must read as a glowing blob from above (Phase 5 integration finding).
      px: { albedo: PaletteCell.metalDark, emissive: PaletteCell.streetlightWarm },
      nx: { albedo: PaletteCell.metalDark, emissive: PaletteCell.streetlightWarm },
      pz: { albedo: PaletteCell.metalDark, emissive: PaletteCell.streetlightWarm },
      nz: { albedo: PaletteCell.metalDark, emissive: PaletteCell.streetlightWarm },
      py: { albedo: PaletteCell.metalDark, emissive: PaletteCell.streetlightWarm },
      ny: { albedo: PaletteCell.metalDark, emissive: PaletteCell.streetlightWarm },
    },
  );

  return toBufferGeometry(b);
}

// --- Traffic light ---------------------------------------------------------------------------
// Pole + a head bracketed to its +Z side with a 3-cell face (red/housing/green — the palette
// has no dedicated amber cell, so the middle cell stays a plain non-emissive housing tone;
// documented deviation from a literal red/amber/green signal).
export function buildTrafficLight(): BufferGeometry {
  const d = PROP_DIMS.trafficLight;
  const b = createBuilder();

  addPrismFrustum(b, d.poleSides, 0, d.poleHeightM, d.poleRadiusM, d.poleRadiusM, PaletteCell.metal);

  const headZ0 = d.poleRadiusM;
  const headZ1 = d.poleRadiusM + d.headDepthM;
  const headY0 = d.poleHeightM - d.headHeightM;
  const headY1 = d.poleHeightM;
  addBox(
    b,
    { minX: -d.headWidthM / 2, maxX: d.headWidthM / 2, minY: headY0, maxY: headY1, minZ: headZ0, maxZ: headZ1 },
    {
      px: { albedo: PaletteCell.metalDark },
      nx: { albedo: PaletteCell.metalDark },
      py: { albedo: PaletteCell.metalDark },
      pz: { albedo: PaletteCell.metalDark },
      // nz omitted: flush against the pole.
    },
  );

  const cellHalf = d.cellSizeM / 2;
  const centerY = (headY0 + headY1) / 2;
  const step = d.cellSizeM + d.cellGapM;
  const cellZ = headZ1 + d.cellInsetM;
  const cells: readonly [number, number][] = [
    [centerY + step, PaletteCell.signalRed],
    [centerY, PaletteCell.metalDark], // no amber cell in the palette — plain housing tone
    [centerY - step, PaletteCell.signalGreen],
  ];
  for (const [y, cell] of cells) {
    const emissive = cell === PaletteCell.metalDark ? undefined : cell;
    addQuad(
      b,
      [
        [-cellHalf, y - cellHalf, cellZ],
        [cellHalf, y - cellHalf, cellZ],
        [cellHalf, y + cellHalf, cellZ],
        [-cellHalf, y + cellHalf, cellZ],
      ],
      [0, 0, 1],
      cell,
      emissive,
    );
  }

  return toBufferGeometry(b);
}

// --- Tree ------------------------------------------------------------------------------------
// Trunk + stacked cones (each its own full base-to-apex taper, overlapping the one below for
// fullness) — the classic low-poly "stacked pine" silhouette.
export function buildTree(): BufferGeometry {
  const d = PROP_DIMS.tree;
  const b = createBuilder();

  addPrismFrustum(b, d.trunkSides, 0, d.trunkHeightM, d.trunkRadiusM, d.trunkRadiusM, PaletteCell.trunk);

  let radius = d.foliageBaseRadiusM;
  let y0 = d.trunkHeightM - d.foliageOverlapM;
  for (let tier = 0; tier < d.foliageTiers; tier++) {
    const y1 = y0 + d.foliageTierHeightM;
    const cell = tier % 2 === 0 ? PaletteCell.foliage : PaletteCell.foliageDark;
    addPrismFrustum(b, d.foliageSides, y0, y1, radius, 0, cell);
    radius *= d.foliageShrink;
    y0 = y1 - d.foliageOverlapM;
  }

  return toBufferGeometry(b);
}

// --- Bench -----------------------------------------------------------------------------------
// Seat + backrest + 2 blocky end supports (a full slab per end reads as chunkier/cheaper than
// 4 thin legs, and is fewer triangles).
export function buildBench(): BufferGeometry {
  const d = PROP_DIMS.bench;
  const b = createBuilder();
  const halfW = d.seatWidthM / 2;
  const halfDp = d.seatDepthM / 2;

  addBox(
    b,
    { minX: -halfW, maxX: halfW, minY: d.seatHeightM, maxY: d.seatHeightM + d.seatThicknessM, minZ: -halfDp, maxZ: halfDp },
    {
      px: { albedo: PaletteCell.wallD },
      nx: { albedo: PaletteCell.wallD },
      py: { albedo: PaletteCell.wallD },
      pz: { albedo: PaletteCell.wallD },
      nz: { albedo: PaletteCell.wallD },
    },
  );

  addBox(
    b,
    {
      minX: -halfW,
      maxX: halfW,
      minY: d.seatHeightM,
      maxY: d.seatHeightM + d.backHeightM,
      minZ: -halfDp - d.backThicknessM,
      maxZ: -halfDp,
    },
    {
      px: { albedo: PaletteCell.wallD },
      nx: { albedo: PaletteCell.wallD },
      py: { albedo: PaletteCell.wallD },
      pz: { albedo: PaletteCell.wallD },
      nz: { albedo: PaletteCell.wallD },
    },
  );

  for (const sign of [-1, 1] as const) {
    const cx = sign * (halfW - d.legThicknessM / 2);
    addBox(
      b,
      {
        minX: cx - d.legThicknessM / 2,
        maxX: cx + d.legThicknessM / 2,
        minY: 0,
        maxY: d.seatHeightM,
        minZ: -halfDp,
        maxZ: halfDp,
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

// --- Hydrant ---------------------------------------------------------------------------------
// Tapered body + domed cap + 2 stub nozzles. `liveryRed` is reused here (a generic red flat
// tone, not a vehicle) — no dedicated hydrant-red cell exists and adding one would touch the
// sealed archetypes.ts palette table.
export function buildHydrant(): BufferGeometry {
  const d = PROP_DIMS.hydrant;
  const b = createBuilder();

  addPrismFrustum(b, d.bodySides, 0, d.bodyHeightM, d.bodyRadiusM, d.bodyRadiusM * 0.85, PaletteCell.liveryRed);
  addPrismFrustum(
    b,
    d.bodySides,
    d.bodyHeightM,
    d.bodyHeightM + d.capHeightM,
    d.capRadiusM,
    d.capRadiusM * 0.3,
    PaletteCell.metal,
    { capTop: true },
  );

  const nozzleY = d.bodyHeightM * 0.5;
  for (const axis of ['x', 'z'] as const) {
    const half = d.nozzleRadiusM;
    const len = d.nozzleLengthM;
    const base = d.bodyRadiusM * 0.9;
    if (axis === 'x') {
      addBox(
        b,
        { minX: base, maxX: base + len, minY: nozzleY - half, maxY: nozzleY + half, minZ: -half, maxZ: half },
        {
          px: { albedo: PaletteCell.metal },
          py: { albedo: PaletteCell.metal },
          ny: { albedo: PaletteCell.metal },
          pz: { albedo: PaletteCell.metal },
          nz: { albedo: PaletteCell.metal },
        },
      );
    } else {
      addBox(
        b,
        { minX: -half, maxX: half, minY: nozzleY - half, maxY: nozzleY + half, minZ: base, maxZ: base + len },
        {
          px: { albedo: PaletteCell.metal },
          nx: { albedo: PaletteCell.metal },
          py: { albedo: PaletteCell.metal },
          ny: { albedo: PaletteCell.metal },
          pz: { albedo: PaletteCell.metal },
        },
      );
    }
  }

  return toBufferGeometry(b);
}

// --- Mailbox ---------------------------------------------------------------------------------
// Post + a body box mounted on top. `wallE` (deep red) stands in for a generic municipal
// mailbox tone — a plain shape, no real-world livery/logo (CLAUDE.md's no-real-marks rule).
export function buildMailbox(): BufferGeometry {
  const d = PROP_DIMS.mailbox;
  const b = createBuilder();

  addPrismFrustum(b, d.postSides, 0, d.postHeightM, d.postRadiusM, d.postRadiusM, PaletteCell.metalDark);

  const bodyY0 = d.postHeightM - 0.05;
  addBox(
    b,
    {
      minX: -d.bodyWidthM / 2,
      maxX: d.bodyWidthM / 2,
      minY: bodyY0,
      maxY: bodyY0 + d.bodyHeightM,
      minZ: -d.bodyDepthM / 2,
      maxZ: d.bodyDepthM / 2,
    },
    {
      px: { albedo: PaletteCell.wallE },
      nx: { albedo: PaletteCell.wallE },
      py: { albedo: PaletteCell.wallE },
      ny: { albedo: PaletteCell.wallE },
      pz: { albedo: PaletteCell.wallE },
      nz: { albedo: PaletteCell.wallE },
    },
  );

  return toBufferGeometry(b);
}

// --- Fence segment -----------------------------------------------------------------------------
// One 2.5 m chain-link-suggestion panel: a post at each end, top + bottom rails, and a single
// mid-height crossbar (a literal diagonal weave isn't worth the extra triangles at this
// scale — "frame + crossbar" per the phase-05 brief reads fine as a simple ladder panel).
// Local X = length (rotationY=0 runs the panel east-west), local Z = thickness.
export function buildFenceSegment(): BufferGeometry {
  const d = PROP_DIMS.fenceSegment;
  const b = createBuilder();
  const halfLen = d.lengthM / 2;
  const cell = PaletteCell.metal;
  const railFaces = {
    px: { albedo: cell },
    nx: { albedo: cell },
    py: { albedo: cell },
    ny: { albedo: cell },
    pz: { albedo: cell },
    nz: { albedo: cell },
  } as const;

  for (const sign of [-1, 1] as const) {
    const cx = sign * (halfLen - d.postThicknessM / 2);
    addBox(
      b,
      {
        minX: cx - d.postThicknessM / 2,
        maxX: cx + d.postThicknessM / 2,
        minY: 0,
        maxY: d.heightM,
        minZ: -d.postThicknessM / 2,
        maxZ: d.postThicknessM / 2,
      },
      railFaces,
    );
  }

  const railExtent = { minX: -halfLen, maxX: halfLen, minZ: -d.railThicknessM / 2, maxZ: d.railThicknessM / 2 };
  addBox(b, { ...railExtent, minY: d.heightM - d.railThicknessM, maxY: d.heightM }, railFaces);
  addBox(b, { ...railExtent, minY: 0, maxY: d.railThicknessM }, railFaces);

  const crossY = d.heightM / 2;
  addBox(
    b,
    {
      minX: -halfLen,
      maxX: halfLen,
      minY: crossY - d.crossbarThicknessM / 2,
      maxY: crossY + d.crossbarThicknessM / 2,
      minZ: -d.crossbarThicknessM / 2,
      maxZ: d.crossbarThicknessM / 2,
    },
    railFaces,
  );

  return toBufferGeometry(b);
}

// --- Transformer box ---------------------------------------------------------------------------
// Chunky cabinet on a plinth + 3 insulator knobs on top — the fenced lot's destructible prop
// (TDD §5.8, hp assigned via POWER_GRID.transformerHp elsewhere).
export function buildTransformerBox(): BufferGeometry {
  const d = PROP_DIMS.transformerBox;
  const b = createBuilder();
  const halfW = d.widthM / 2;
  const halfDp = d.depthM / 2;

  addBox(
    b,
    {
      minX: -halfW - d.plinthOutsetM,
      maxX: halfW + d.plinthOutsetM,
      minY: 0,
      maxY: d.plinthHeightM,
      minZ: -halfDp - d.plinthOutsetM,
      maxZ: halfDp + d.plinthOutsetM,
    },
    {
      px: { albedo: PaletteCell.metalDark },
      nx: { albedo: PaletteCell.metalDark },
      pz: { albedo: PaletteCell.metalDark },
      nz: { albedo: PaletteCell.metalDark },
    },
  );

  const cabTop = d.plinthHeightM + d.heightM;
  addBox(
    b,
    { minX: -halfW, maxX: halfW, minY: d.plinthHeightM, maxY: cabTop, minZ: -halfDp, maxZ: halfDp },
    {
      px: { albedo: PaletteCell.metal },
      nx: { albedo: PaletteCell.metal },
      py: { albedo: PaletteCell.metal },
      pz: { albedo: PaletteCell.metal },
      nz: { albedo: PaletteCell.metal },
    },
  );

  const spread = halfW * 0.5;
  const knobCount: number = d.knobCount;
  for (let i = 0; i < knobCount; i++) {
    const t = knobCount === 1 ? 0 : i / (knobCount - 1) - 0.5;
    const kx = t * 2 * spread;
    addPrismFrustum(b, d.knobSides, cabTop, cabTop + d.knobHeightM, d.knobRadiusM, d.knobRadiusM * 0.6, PaletteCell.metalDark, {
      capTop: true,
      offsetX: kx,
    });
  }

  return toBufferGeometry(b);
}
