// Performance quality tiers. TDD §10 budget table.
export interface QualityTierDef {
  readonly targetFps: number;
  readonly maxDrawCalls: number;
  readonly maxTriangles: number;
  readonly maxDynamicBodies: number;
  readonly pursuitCapModifier: number;
  // Shadow map resolution; 0 = shadows off (mobile/low tier).
  readonly shadowMapSize: number;
  readonly dprCap: number;
  // Phase 16: effective particle-pool budget (fx/particles.ts). The system always
  // allocates PARTICLES.poolSize (500) instance slots, but the sink never keeps more than
  // this many alive at once — lower tiers run a smaller effective pool so the FX layer
  // scales down with the frame budget (fewer overdraw fragments on the additive/alpha
  // passes). Capped at or below PARTICLES.poolSize; high tier uses the full pool.
  readonly particleCap: number;
  // Phase 18: civilian-traffic density scale (ai/traffic.ts). The active-car target is
  // TRAFFIC_CIV.activeTarget × this, so lower tiers run fewer cars (fewer kinematic bodies +
  // fewer potential dynamic conversions). high = full density; resolved counts (base 24):
  // high 24, med 20, low 16.
  readonly trafficDensityModifier: number;
  // Phase 18: fraction of parked cars actually instanced (world/cityInstances.ts, the med-tier
  // triangle-trim lever). Parked cars are the single biggest instanced pool by triangles
  // (~76 tris × 634–866 instances/seed = 48k–66k map-wide), so evenly thinning them is the
  // cheapest way to bring the med tier under its 200k budget. high = every car; meshes AND
  // colliders read the same thinned set so they can never disagree.
  readonly parkedCarKeepFraction: number;
  // Phase 18 low-tier scenery trim: fraction of trees/mailboxes/benches/hydrants kept
  // (world/cityInstances.ts SCENERY_ARCHETYPES — fences/lights/transformers deliberately
  // excluded, see its doc comment). Trees alone are 40–54k tris map-wide, the second-
  // biggest static pool after buildings; this is the lever that pulls the LOW tier toward
  // its 120k budget after the parked-car trim.
  readonly sceneryKeepFraction: number;
  // Phase 25.8 (D8): Toronto city-pack dress-density scale. Multiplies the pre-wired
  // config/torontoDress.ts DRESS_DENSITY_SCALAR that world/toronto/furniture.ts's row-spacing
  // math (trees/hydrants/benches/trash-cans/bus-stops/manholes AND parked-vehicle along-street
  // spacing) divides by — a lower scalar widens spacing, so fewer items place. Intersection-rule
  // furniture (traffic-light masts/stop-signs/power-boxes) is NEVER scaled by this (low tier
  // still signals every intersection). Threaded into buildFurniture(seed, tierParams) as part of
  // TorontoTierParams (config/torontoDress.ts), captured once at TorontoScene mount (the same
  // "next run, at mount" precedent as parkedCarKeepFraction/sceneryKeepFraction above).
  readonly dressDensityScalar: number;
  // Phase 25.8 (D8): Toronto pack-building frontage occupancy scale. Multiplies
  // config/torontoDress.ts FRONTAGE.occupancy's per-density (dense/medium/sparse) probabilities
  // that world/toronto/frontage.ts's GENERIC street-walk rolls against — a venue claim is
  // forced-occupied regardless of this roll and always survives (D1), only unclaimed slots thin.
  // Threaded into buildFrontage(seed, tierParams) via the same TorontoTierParams bag.
  readonly frontageOccupancyScalar: number;
  // Phase 25.8 (D8): gates world/toronto/cityPack/CityDress.tsx's TrafficLampOverlay on tier AND
  // its own devToggle ('packLightCycling') — both must be true for the per-frame lamp-phase
  // overlay to mount. The overlay is a small per-frame cost (instance-colour writes on phase
  // change) that buys nothing on a screen too small to read the phase anyway at low tier.
  readonly lampOverlay: boolean;
}

export const QUALITY_TIERS = {
  high: {
    targetFps: 60,
    maxDrawCalls: 150,
    maxTriangles: 300_000,
    maxDynamicBodies: 120,
    pursuitCapModifier: 1,
    shadowMapSize: 2048,
    dprCap: 2,
    particleCap: 500,
    trafficDensityModifier: 1,
    parkedCarKeepFraction: 1,
    sceneryKeepFraction: 1,
    dressDensityScalar: 1,
    frontageOccupancyScalar: 1,
    lampOverlay: true,
  },
  med: {
    targetFps: 60,
    maxDrawCalls: 120,
    maxTriangles: 200_000,
    maxDynamicBodies: 90,
    pursuitCapModifier: 1,
    shadowMapSize: 1024,
    dprCap: 1.5,
    particleCap: 350,
    trafficDensityModifier: 0.83,
    parkedCarKeepFraction: 0.6,
    sceneryKeepFraction: 1,
    dressDensityScalar: 0.85,
    frontageOccupancyScalar: 1,
    lampOverlay: true,
  },
  low: {
    targetFps: 30,
    maxDrawCalls: 90,
    maxTriangles: 120_000,
    maxDynamicBodies: 60,
    pursuitCapModifier: 0.7,
    shadowMapSize: 0,
    dprCap: 1.5,
    particleCap: 160,
    trafficDensityModifier: 0.67,
    parkedCarKeepFraction: 0.25,
    sceneryKeepFraction: 0.3,
    dressDensityScalar: 0.55,
    frontageOccupancyScalar: 0.75,
    lampOverlay: false,
  },
} as const satisfies Record<string, QualityTierDef>;

export type QualityTier = keyof typeof QUALITY_TIERS;

// Tiers ordered lowest → highest capability; the FPS probe (core/quality.ts) walks this to
// "drop one tier". Kept in sync with QUALITY_TIERS by the config test.
export const QUALITY_TIER_ORDER = ['low', 'med', 'high'] as const satisfies readonly QualityTier[];

// ===========================================================================================
// Pure per-tier budget resolvers (unit-tested; no side effects). Each consumer reads its own
// row through one of these so the budget table stays the single source of truth (CLAUDE.md).
// ===========================================================================================

/**
 * Effective dynamic-prop pool cap for a tier (world/propDynamics.ts). The configured base pool
 * (PROPS.dynamicPoolCap, authored as the high-tier count) is scaled by the tier's share of the
 * high-tier active-dynamic-body budget, so lower tiers hold fewer airborne props and the total
 * live dynamic-body count stays within each tier's `maxDynamicBodies`. Never exceeds `baseCap`
 * (high == baseCap) and never drops below 1. Resolved (base 60): high 60, med 45, low 30.
 */
export function dynamicPropPoolCap(baseCap: number, tier: QualityTier): number {
  const hi = QUALITY_TIERS.high.maxDynamicBodies;
  const scaled = Math.round((baseCap * QUALITY_TIERS[tier].maxDynamicBodies) / hi);
  return Math.max(1, Math.min(baseCap, scaled));
}

/**
 * Effective civilian-traffic active-car target for a tier (ai/traffic.ts): `baseTarget` scaled
 * by the tier's `trafficDensityModifier`, rounded, floored at 0. Resolved (base 24): high 24,
 * med 20, low 16.
 */
export function trafficActiveTarget(baseTarget: number, tier: QualityTier): number {
  return Math.max(0, Math.round(baseTarget * QUALITY_TIERS[tier].trafficDensityModifier));
}
