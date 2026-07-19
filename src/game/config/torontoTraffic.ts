// Phase 29 (D3) — Toronto civilian-traffic roster. The moving-car target for the Toronto map is a
// tier-scaled roster (32 high / 24 med / 16 low) DISTINCT from the legacy 64×64 world's
// TRAFFIC_CIV.activeTarget × trafficDensityModifier (24/20/16) — the Toronto grid is wider and reads
// emptier, so it carries a few more cars at high tier. Wired "like other tier params" (config/
// quality.ts): captured ONCE at mount and passed to the TrafficController as an activeTarget
// override, so a mid-run quality change only applies on the next keyed remount (matching every other
// Toronto mount-captured tier param — see world/CityScape.tsx / TorontoScene's precedent).

import type { QualityTier } from './quality';

/** Per-tier active moving-car count for the Toronto road graph (D3). */
export const TORONTO_TRAFFIC = {
  rosterByTier: {
    low: 16,
    med: 24,
    high: 32,
  },
} as const satisfies { rosterByTier: Record<QualityTier, number> };

/** The mount-captured Toronto traffic roster for `tier` (D3). */
export function torontoTrafficRoster(tier: QualityTier): number {
  return TORONTO_TRAFFIC.rosterByTier[tier];
}
