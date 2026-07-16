// Archetype + palette contracts for the instanced city (TDD §8, §5.8). This file is the
// SEAM between the geometry builders (world/geometry/*), the instancing/buffer layer
// (world/instancing.ts), collider placement, the powergrid (Phase 13), and debug tooling —
// everything speaks in these names and cells, nothing hardcodes either.

/** Every instanced world archetype. One archetype = one InstancedMesh = one draw call,
 * instances ordered grouped-by-district with recorded [start,count] ranges (sacred —
 * Phase 13 blackouts write exactly one buffer range per archetype). */
export const ARCHETYPES = [
  // Buildings (emissive window cells — blackout participants)
  'buildingSmall', // 1×1..2×1/1×2 footprints, low
  'buildingTower', // 2×2 footprints, tall
  // Street props (PROP_STATIC colliders; some emissive)
  'streetlight', // emissive head — blackout participant
  'trafficLight', // emissive heads — blackout participant
  'tree',
  'bench',
  'hydrant',
  'mailbox',
  'fenceSegment', // transformer-lot fencing
  'transformerBox', // the destructible prop itself (hp — TDD §5.8)
] as const;

export type ArchetypeName = (typeof ARCHETYPES)[number];

/** Archetypes whose aEmissiveOn attribute participates in district blackouts (Phase 13
 * flips these ranges; everything else ignores the attribute). */
export const EMISSIVE_ARCHETYPES: readonly ArchetypeName[] = [
  'buildingSmall',
  'buildingTower',
  'streetlight',
  'trafficLight',
] as const;

// --- Palette ------------------------------------------------------------------------------
// One tiny canvas-generated atlas (world/palette.ts renders it), 8×4 grid of flat colour
// cells; every geometry UV-maps each face to ONE cell's center. `uv` samples the albedo
// cell; `uv2` samples the cell used for the emissive term (gated per-instance by
// aEmissiveOn). Cell ids are stable — appending is fine, reordering is not (baked UVs).

export const PALETTE_COLS = 8;
export const PALETTE_ROWS = 4;

export const PaletteCell = {
  asphalt: 0,
  sidewalk: 1,
  wallA: 2, // warm brick
  wallB: 3, // cool concrete
  wallC: 4, // painted teal
  wallD: 5, // sandstone
  wallE: 6, // deep red
  wallF: 7, // slate
  roof: 8,
  foliage: 9,
  foliageDark: 10,
  trunk: 11,
  metal: 12,
  metalDark: 13,
  glassCool: 14, // unlit window glass
  windowWarm: 15, // EMISSIVE: lit window
  streetlightWarm: 16, // EMISSIVE: sodium streetlight head
  signalRed: 17, // EMISSIVE: traffic light heads
  signalGreen: 18, // EMISSIVE
  water: 19,
  sand: 20,
  liveryRed: 21, // streetcar/generic livery (no real-world marks)
  liveryWhite: 22,
  policeBlue: 23, // reserved (Phase 9)
  militaryGreen: 24, // reserved (Phase 11)
  tailRed: 25, // reserved vehicle lights
  headWarm: 26, // reserved vehicle lights
  // 27..31 reserved
} as const;

export type PaletteCellName = keyof typeof PaletteCell;

/** UV center of a palette cell (v=0 at atlas bottom, standard three.js convention). */
export function paletteCellUv(cell: number): { u: number; v: number } {
  const col = cell % PALETTE_COLS;
  const row = Math.floor(cell / PALETTE_COLS);
  return {
    u: (col + 0.5) / PALETTE_COLS,
    v: 1 - (row + 0.5) / PALETTE_ROWS,
  };
}
