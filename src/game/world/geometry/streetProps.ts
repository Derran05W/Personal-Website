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
import {
  addBox,
  addPrismFrustum,
  addQuad,
  addQuadAuto,
  addTri,
  createBuilder,
  toBufferGeometry,
  type GeometryBuilder,
  type Vec3,
} from './kit';

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

// ============================================================================================
// Phase 19 Task 2: market + alley props (Kensington-only market stalls; sparse map-wide alley
// critters). Same "one canonical geometry, parameterless" contract as every builder above —
// per-instance variety comes from world/propPlacements.ts's position/rotation, not geometry
// variants. All new archetypes are wired into PROP_DIMS/PROPS.masses/PROPS.forceThresholds
// (config/world.ts) and world/archetypes.ts's ARCHETYPES list.
// ============================================================================================

// --- Awning (market stall canopy) -----------------------------------------------------------
// Two front support poles + a two-band, three-stripe canopy — a STEPPED droop (back band
// higher, front band lower) rather than a tilted quad, staying axis-aligned like every other
// builder in this file. Local +Z is "faces the sidewalk" (the low/front edge); rotationY at
// placement aims it at the road, matching edgePropPlacements' free-rotation convention.
export function buildAwning(): BufferGeometry {
  const d = PROP_DIMS.awning;
  const b = createBuilder();
  const dark = PaletteCell.metalDark;
  const stripeCells: readonly number[] = [PaletteCell.liveryRed, PaletteCell.liveryWhite];

  const poleX = d.canopyWidthM / 2 - 0.15;
  const poleZ = d.canopyDepthM / 2 - 0.1;
  const frontY = d.poleHeightM - d.canopyDropM;
  for (const sign of [-1, 1] as const) {
    addPrismFrustum(b, d.poleSides, 0, frontY, d.poleRadiusM, d.poleRadiusM, dark, {
      offsetX: sign * poleX,
      offsetZ: poleZ,
    });
  }

  const halfW = d.canopyWidthM / 2;
  const stripeW = d.canopyWidthM / d.stripeCount;
  const addBand = (y0: number, y1: number, z0: number, z1: number): void => {
    for (let i = 0; i < d.stripeCount; i++) {
      const x0 = -halfW + i * stripeW;
      const cell = stripeCells[i % stripeCells.length];
      addBox(
        b,
        { minX: x0, maxX: x0 + stripeW, minY: y0, maxY: y1, minZ: z0, maxZ: z1 },
        {
          px: { albedo: cell },
          nx: { albedo: cell },
          py: { albedo: cell },
          pz: { albedo: cell },
          nz: { albedo: cell },
        },
      );
    }
  };
  const backZ0 = -d.canopyDepthM / 2;
  const midZ = 0;
  addBand(d.poleHeightM - d.canopyThicknessM, d.poleHeightM, backZ0, midZ); // back band (higher)
  addBand(frontY - d.canopyThicknessM, frontY, midZ, d.canopyDepthM / 2); // front band (lower)

  return toBufferGeometry(b);
}

// --- Crate (market stall) -------------------------------------------------------------------
// A plain crate + two strap bands — reuses buildFenceSegment's "frame reads fine" spirit.
export function buildCrate(): BufferGeometry {
  const d = PROP_DIMS.crate;
  const b = createBuilder();
  const wood = PaletteCell.wallD;
  const strap = PaletteCell.metalDark;
  const halfW = d.widthM / 2;
  const halfD = d.depthM / 2;

  addBox(
    b,
    { minX: -halfW, maxX: halfW, minY: 0, maxY: d.heightM, minZ: -halfD, maxZ: halfD },
    {
      px: { albedo: wood },
      nx: { albedo: wood },
      py: { albedo: wood },
      pz: { albedo: wood },
      nz: { albedo: wood },
    },
  );

  for (const t of [0.3, 0.7]) {
    const y = d.heightM * t;
    addBox(
      b,
      {
        minX: -halfW - 0.01,
        maxX: halfW + 0.01,
        minY: y - d.strapThicknessM / 2,
        maxY: y + d.strapThicknessM / 2,
        minZ: -halfD - 0.01,
        maxZ: halfD + 0.01,
      },
      { px: { albedo: strap }, nx: { albedo: strap }, pz: { albedo: strap }, nz: { albedo: strap } },
    );
  }

  return toBufferGeometry(b);
}

// --- Produce stand (market stall) -----------------------------------------------------------
// A table (4 legs + top) with a small deterministic scatter of colour-coded produce boxes on
// top — no rng (one canonical geometry, TDD §8.3 spirit; per-instance variety is position/
// rotation only, same as every other street prop).
const PRODUCE_CELLS: readonly number[] = [
  PaletteCell.wallE,
  PaletteCell.foliage,
  PaletteCell.wallD,
  PaletteCell.wallC,
];

export function buildProduceStand(): BufferGeometry {
  const d = PROP_DIMS.produceStand;
  const b = createBuilder();
  const wood = PaletteCell.wallD;
  const halfW = d.tableWidthM / 2;
  const halfD = d.tableDepthM / 2;
  const topY0 = d.tableHeightM - d.tableThicknessM;

  addBox(
    b,
    { minX: -halfW, maxX: halfW, minY: topY0, maxY: d.tableHeightM, minZ: -halfD, maxZ: halfD },
    {
      px: { albedo: wood },
      nx: { albedo: wood },
      py: { albedo: wood },
      pz: { albedo: wood },
      nz: { albedo: wood },
    },
  );

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const cx = sx * (halfW - d.legThicknessM / 2);
      const cz = sz * (halfD - d.legThicknessM / 2);
      addBox(
        b,
        {
          minX: cx - d.legThicknessM / 2,
          maxX: cx + d.legThicknessM / 2,
          minY: 0,
          maxY: topY0,
          minZ: cz - d.legThicknessM / 2,
          maxZ: cz + d.legThicknessM / 2,
        },
        { px: { albedo: wood }, nx: { albedo: wood }, pz: { albedo: wood }, nz: { albedo: wood } },
      );
    }
  }

  const s = d.produceSizeM;
  const produceCount: number = d.produceCount; // widen from PROP_DIMS's literal type (as const)
  for (let i = 0; i < produceCount; i++) {
    const t = produceCount === 1 ? 0 : i / (produceCount - 1) - 0.5;
    const cx = t * (d.tableWidthM - s) * 0.8;
    const cz = (i % 2 === 0 ? -1 : 1) * d.tableDepthM * 0.15;
    const cell = PRODUCE_CELLS[i % PRODUCE_CELLS.length];
    addBox(
      b,
      { minX: cx - s / 2, maxX: cx + s / 2, minY: d.tableHeightM, maxY: d.tableHeightM + s, minZ: cz - s / 2, maxZ: cz + s / 2 },
      {
        px: { albedo: cell },
        nx: { albedo: cell },
        py: { albedo: cell },
        pz: { albedo: cell },
        nz: { albedo: cell },
      },
    );
  }

  return toBufferGeometry(b);
}

// --- Tipped garbage can (alley prop) ---------------------------------------------------------
// A knocked-over can LYING ON ITS SIDE, baked directly into the geometry — world/cityInstances.
// ts's composeMatrix only ever applies a Y-axis yaw (every prop's placement is yaw-only), so
// "tipped over" has to be authored in local space, not achieved via instance rotation. Local
// +X is the tube's axis; the lid + spill sit past the +X ("open mouth") end. rotationY at
// placement is free (the tipped-can silhouette reads fine from any yaw).
function addHorizontalTube(
  b: GeometryBuilder,
  sides: number,
  x0: number,
  x1: number,
  radius: number,
  yCenter: number,
  cell: number,
): void {
  const step = (Math.PI * 2) / sides;
  const ringAt = (x: number, i: number): Vec3 => {
    const a = i * step;
    return [x, yCenter + radius * Math.sin(a), radius * Math.cos(a)];
  };
  for (let i = 0; i < sides; i++) {
    addQuadAuto(b, [ringAt(x0, i), ringAt(x1, i), ringAt(x1, i + 1), ringAt(x0, i + 1)], cell);
  }
  // End caps (winding hand-derived via kit.ts's own cross-product convention — see the
  // sibling geometry test for the outward-normal proof): x0's cap points -X, x1's points +X.
  const c0: Vec3 = [x0, yCenter, 0];
  const c1: Vec3 = [x1, yCenter, 0];
  for (let i = 0; i < sides; i++) {
    addTri(b, c0, ringAt(x0, i), ringAt(x0, i + 1), [-1, 0, 0], cell);
    addTri(b, c1, ringAt(x1, i + 1), ringAt(x1, i), [1, 0, 0], cell);
  }
}

export function buildGarbageCanTipped(): BufferGeometry {
  const d = PROP_DIMS.garbageCanTipped;
  const b = createBuilder();
  const metal = PaletteCell.metal;
  const dark = PaletteCell.metalDark;

  addHorizontalTube(b, d.bodySides, 0, d.bodyLengthM, d.bodyRadiusM, d.bodyRadiusM, metal);

  // Lid: fallen flat just past the open end, off to one side (never overlapping the body,
  // which spans |z| <= bodyRadiusM).
  addPrismFrustum(b, 8, 0, d.lidThicknessM, d.lidRadiusM, d.lidRadiusM, dark, {
    capTop: true,
    offsetX: d.bodyLengthM + d.lidRadiusM * 0.6,
    offsetZ: d.bodyRadiusM * 1.4,
  });

  // Spill: a few small tumbled debris boxes fanning out past the open end.
  for (let i = 0; i < d.spillBlobCount; i++) {
    const s = d.spillBlobSizeM * (1 - i * 0.15);
    const cx = d.bodyLengthM + s + i * s * 1.6;
    const cz = (i % 2 === 0 ? -1 : 1) * s * (1 + i * 0.4);
    addBox(
      b,
      { minX: cx - s / 2, maxX: cx + s / 2, minY: 0, maxY: s, minZ: cz - s / 2, maxZ: cz + s / 2 },
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

// --- Raccoon (alley critter) ------------------------------------------------------------------
// A chunky low-poly critter: grey body, a dark "mask" (the head's OUTWARD faces coloured
// darker — the ai/HeliMesh.tsx/world/geometry/helicopter.ts livery trick of tinting a whole
// part instead of adding overlay geometry, applied here as a baked second cell rather than an
// instance tint since every raccoon shares one look), and a striped tail. A knockable light
// prop through the same pipeline as every other street prop (PROPS.masses/forceThresholds) —
// not a live AI creature in v1 (phase-19-plan.md: "fleeing = recorded stretch").
export function buildRaccoon(): BufferGeometry {
  const d = PROP_DIMS.raccoon;
  const b = createBuilder();
  const fur = PaletteCell.metal;
  const mask = PaletteCell.metalDark;

  const bodyTop = d.legHeightM + d.bodyHeightM;
  addBox(
    b,
    {
      minX: -d.bodyWidthM / 2,
      maxX: d.bodyWidthM / 2,
      minY: d.legHeightM,
      maxY: bodyTop,
      minZ: -d.bodyLengthM / 2,
      maxZ: d.bodyLengthM / 2,
    },
    {
      px: { albedo: fur },
      nx: { albedo: fur },
      py: { albedo: fur },
      pz: { albedo: fur },
      nz: { albedo: fur },
    },
  );

  // Head: outward side/front faces are the mask; the crown stays the lighter fur tone. Back
  // face omitted (flush against the body, never seen).
  const headZ0 = d.bodyLengthM / 2;
  const headZ1 = headZ0 + d.headSizeM;
  const headY0 = bodyTop - d.headSizeM * 0.8;
  const headY1 = headY0 + d.headSizeM;
  addBox(
    b,
    { minX: -d.headSizeM / 2, maxX: d.headSizeM / 2, minY: headY0, maxY: headY1, minZ: headZ0, maxZ: headZ1 },
    { px: { albedo: mask }, nx: { albedo: mask }, py: { albedo: fur }, pz: { albedo: mask } },
  );

  // Ears: two small dark stubs on the crown.
  const earY0 = headY1;
  const earY1 = earY0 + d.earSizeM;
  for (const sign of [-1, 1] as const) {
    const cx = sign * d.headSizeM * 0.25;
    const ez0 = headZ0 + d.headSizeM * 0.2;
    addBox(
      b,
      { minX: cx - d.earSizeM / 2, maxX: cx + d.earSizeM / 2, minY: earY0, maxY: earY1, minZ: ez0, maxZ: ez0 + d.earSizeM },
      { px: { albedo: mask }, nx: { albedo: mask }, py: { albedo: mask } },
    );
  }

  // Legs: four short stubs (top+bottom omitted — flush under the body / touching ground).
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const cx = sx * (d.bodyWidthM / 2 - d.legThicknessM / 2);
      const cz = sz * (d.bodyLengthM / 2 - d.legThicknessM * 1.5);
      addBox(
        b,
        {
          minX: cx - d.legThicknessM / 2,
          maxX: cx + d.legThicknessM / 2,
          minY: 0,
          maxY: d.legHeightM,
          minZ: cz - d.legThicknessM / 2,
          maxZ: cz + d.legThicknessM / 2,
        },
        { px: { albedo: fur }, nx: { albedo: fur }, pz: { albedo: fur }, nz: { albedo: fur } },
      );
    }
  }

  // Tail: alternating fur/mask stripe segments, curling gently upward off the body's rear
  // (-Z). Faces flush against the next/previous segment are omitted.
  let segZ = -d.bodyLengthM / 2;
  let segY = d.legHeightM + d.bodyHeightM * 0.5;
  for (let i = 0; i < d.tailSegments; i++) {
    const cell = i % 2 === 0 ? fur : mask;
    const z0 = segZ - d.tailSegmentLengthM;
    addBox(
      b,
      { minX: -d.tailThicknessM / 2, maxX: d.tailThicknessM / 2, minY: segY, maxY: segY + d.tailThicknessM, minZ: z0, maxZ: segZ },
      { px: { albedo: cell }, nx: { albedo: cell }, py: { albedo: cell }, nz: { albedo: cell } },
    );
    segZ = z0;
    segY += d.tailThicknessM * 0.4; // curls gently upward toward the tip
  }

  return toBufferGeometry(b);
}
