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
  },
  med: {
    targetFps: 60,
    maxDrawCalls: 120,
    maxTriangles: 200_000,
    maxDynamicBodies: 90,
    pursuitCapModifier: 1,
    shadowMapSize: 1024,
    dprCap: 1.5,
  },
  low: {
    targetFps: 30,
    maxDrawCalls: 90,
    maxTriangles: 120_000,
    maxDynamicBodies: 60,
    pursuitCapModifier: 0.7,
    shadowMapSize: 0,
    dprCap: 1.5,
  },
} as const satisfies Record<string, QualityTierDef>;

export type QualityTier = keyof typeof QUALITY_TIERS;
