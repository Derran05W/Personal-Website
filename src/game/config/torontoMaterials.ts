// Toronto map v2 — named-building material → look map + window/decal tunables
// (TORONTO-MAP-SPEC-v2.md §4, Addendum A.1/A.5; phase-24-plan "Windows / the look fix").
//
// §4's premise: "colour + rough shape + flat logo = identity." A building's `material` string
// (from data/toronto/building-specs.json — the single source) maps HERE to a concrete LOOK:
//   • fill      — the flat wall colour. Rendered UNLIT-literal (the Phase 23 "material verdict":
//                 a grazing blue-hour sun crushes any lit box to black, so the authored hex IS
//                 the on-screen colour; bright window texels painted into the texture ARE the
//                 lit windows). Named towers get slightly more saturated/distinct fills than the
//                 muted §6 filler families so TD-black / RBC-gold / FCP-white / Scotia-red read
//                 as their signature colours at a block (§10.3 gate).
//   • windowKind — the §4 window pattern: glass → vertical column stripes, grid → punched
//                 windows (brick/limestone/precast/granite), storefront → ground glazing band.
//   • windowTint — the BRIGHT lit-window colour painted into a seeded fraction of the pattern
//                 (warm office glow, #ffc879 family; gold/white variants reinforce a few brands).
//
// Pure data, no three/react — the renderer (world/toronto/TorontoScene.tsx) consumes this and
// bakes one CanvasTexture per building; namedBuildings.ts consumes it for per-box `look`.

/** The §4 window-pattern family a material implies. */
export type WindowKind = 'glass' | 'grid' | 'storefront';

/** A resolved building look: flat fill colour + its window pattern + the lit-window tint. */
export interface MaterialLook {
  readonly fill: string;
  readonly windowKind: WindowKind;
  readonly windowTint: string;
}

/** Warm office glow — the default lit-window colour (plan: "#ffc879 family"). */
const WARM = '#ffc879';

/**
 * §4 material vocabulary → look. Every material a named building in building-specs.json can
 * carry has an entry here (the placement module throws on a missing one, so the map stays a
 * complete single source). Fills are the permanent-blue-hour muted-but-legible signature
 * colours; window kinds follow §4 ("glass = column stripes, brick = punched grid, storefront =
 * big ground glazing").
 */
export const MATERIAL_LOOKS = {
  glass_black: { fill: '#22262e', windowKind: 'glass', windowTint: WARM }, // TD matte black
  glass_blue: { fill: '#2f4d63', windowKind: 'glass', windowTint: '#ffce86' }, // Aura/CIBC/Well/Eaton
  glass_gold: { fill: '#8a6f34', windowKind: 'glass', windowTint: '#ffd67a' }, // RBC gold
  glass_green: { fill: '#2e5c56', windowKind: 'glass', windowTint: WARM }, // Hullmark/Emerald
  marble_white: { fill: '#b9bec6', windowKind: 'glass', windowTint: '#ffe4bd' }, // FCP white
  granite_red: { fill: '#6e3a33', windowKind: 'grid', windowTint: WARM }, // Scotia deep red
  brick_red: { fill: '#7a4d38', windowKind: 'grid', windowTint: WARM }, // The Well podium
  brick_yellow: { fill: '#a68a4a', windowKind: 'grid', windowTint: WARM },
  limestone: { fill: '#b7a06a', windowKind: 'grid', windowTint: WARM }, // Royal York / Union
  precast_grey: { fill: '#6a6670', windowKind: 'grid', windowTint: WARM }, // NY Civic Centre
  storefront: { fill: '#8f8a80', windowKind: 'storefront', windowTint: WARM },
} as const satisfies Record<string, MaterialLook>;

export type TorontoMaterial = keyof typeof MATERIAL_LOOKS;

/** Resolve a building-specs.json `material` string to its look (throws on an unmapped value so
 * a new material in the data can never silently render as a default). */
export function lookForMaterial(material: string): MaterialLook {
  const look = (MATERIAL_LOOKS as Record<string, MaterialLook>)[material];
  if (!look) throw new Error(`torontoMaterials: no look mapped for material "${material}"`);
  return look;
}

/**
 * Window-texture pattern tunables (§4 windows, Addendum A.5 "crunchy"). Baked into a per-building
 * CanvasTexture by the renderer; sampled NearestFilter + no mipmaps. Pure numbers — no magic
 * constants in the renderer.
 */
export const WINDOW_PATTERN = {
  /** Texels per world-unit when sizing a facade canvas (crunchy on purpose). */
  pxPerWu: 5,
  /** Canvas dimension clamp (keeps the biggest towers cheap). */
  maxCanvasPx: 384,
  minCanvasPx: 8,
  /** Storey height (wu) — floor rows of the facade grid. */
  floorHeightWu: 3.4,
  /** Horizontal window-column pitch (wu) for glass/grid facades. */
  columnPitchWu: 3.0,
  /** Fraction of a column/row cell that is glazing (rest is mullion/wall). */
  glazingFrac: 0.62,
  /** Seeded fraction of window cells painted BRIGHT (lit) — plan: "~35%". */
  litFraction: 0.35,
  /** Storefront: fraction of height (from the ground) that is the bright glazing band. */
  storefrontBandFrac: 0.34,
} as const;

/**
 * CROWN decal geometry (§4: "Logo centred on face at 70–85% of height, size = clamp(0.5 ×
 * faceWidth, 8, 16 wu)"). `bandCenterFrac` is the 70–85% midpoint; the decal quad sits
 * `offsetWu` proud of the face so it never z-fights the wall.
 */
export const CROWN_DECAL = {
  bandCenterFrac: 0.775,
  faceScale: 0.5,
  sizeMinWu: 8,
  sizeMaxWu: 16,
  offsetWu: 0.05,
} as const;
