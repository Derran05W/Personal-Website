// Heat/wanted tunables. TDD §5.5 (heat events + tier thresholds), §5.10 (score risk bonus).
export const HEAT = {
  events: {
    // Light post, hydrant, mailbox, and bench all share this value — TDD §5.5 groups
    // them into a single "+1" row. Archetype→event-key mapping is Phase 6/8 work
    // (damage resolver), not a config concern.
    lightPost: 1,
    trafficLight: 2,
    civHit: 5,
    civWreck: 8,
    transformer: 12,
    policeWreck: 25,
    armoredWreck: 40,
    swatWreck: 50,
    gunTruckWreck: 60,
    tankWreck: 100,
  },
  // +1 heat/sec while wanted tier >= ★1. TDD §5.5.
  passivePerSec: 1,
  // Heat thresholds to reach ★0..★5. TDD §5.5 table; index = tier.
  tierThresholds: [0, 15, 75, 180, 350, 600],
  // Score = Σ heat events + this × current_tier per second while >= ★1. TDD §5.10.
  riskBonusPerTierPerSec: 5,
} as const;
