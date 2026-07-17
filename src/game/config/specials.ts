// Phase 17 special-behavior tunables (Task 3): the monster-truck civilian crush and the
// heavy-vehicle prop-plow speed assist. Both are ARCADE momentum rules layered on top of the
// existing civilian ram-conversion (ai/traffic.ts) and prop-swap (world/propDynamics.ts)
// paths by combat/playerSpecials.ts — they never bypass those systems, they drive them and
// then clamp the player's velocity LOSS so a heavy car reads "unstoppable" instead of getting
// hung up on debris. All leva-live; the TDD (§5.9) gives the intent ("rides over civilian
// cars = auto-wreck", "smashes props without slowing"), not the numbers.
export const SPECIALS = {
  // Monster-truck crush (selectedCarId === 'monsterTruck'): a player↔live-civilian contact at
  // or above minForceN auto-wrecks that civilian through the normal conversion→wreck path
  // (civHit then civWrecked, each exactly once) and retains most of the truck's momentum.
  monsterCrush: {
    // Contact-force magnitude (N) a player↔civilian impact must reach to crush. Well below
    // TRAFFIC_CIV.convertForceThreshold (900) so the truck crushes on any real drive-into, not
    // only a hard ram; comfortably above resting/idle micro-contact noise so sitting next to a
    // civ in traffic doesn't wreck it.
    minForceN: 400,
    // Fraction of the truck's PRE-contact planar speed it keeps through a crush. Clamps the
    // velocity LOSS only (never adds speed): if the collision barely slowed the truck this stays
    // inert. ~0.85 reads as "shrugs the car off and keeps rolling".
    speedRetention: 0.85,
  },
  // Heavy-vehicle prop plow (GENERIC — gated on the selected car's massFactor, not a car id, so
  // the school bus, monster truck, and streetcar/Red Rocket all benefit): when a car this heavy
  // knocks an HP-LESS street prop loose into the dynamic pool, the prop swaps out of the way and
  // the car keeps its momentum instead of getting nibbled down by a prop row.
  propPlow: {
    // Selected-car massFactor at/above which the plow assist engages. Bus 2.6 / monster 2.2 /
    // Red Rocket 3.0 clear it; pickup 1.4 / sedan 1.0 / racer 0.8 do not (they feel every prop).
    massFactorThreshold: 2.0,
    // Fraction of pre-contact planar speed retained knocking one hp-less prop loose. Higher than
    // the crush (props are far lighter than a car): a heavy vehicle barely notices a mailbox.
    speedRetention: 0.9,
  },
} as const;
