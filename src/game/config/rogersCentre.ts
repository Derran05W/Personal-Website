// Phase 45 — the ROGERS CENTRE's night program (spec §5 + Part 11 phase 45). Every number the
// stadium's lights run on lives here; world/toronto/rogersProgram.ts turns them into phases and
// world/toronto/rogersNightMaterial.ts hands those to the shader. This is the sibling of
// config/cnTower.ts and follows its rules exactly:
//   • nothing else in the codebase may re-type one of these values (the P27 literal-drift class);
//   • the GEOMETRY-derived numbers the program also needs — how many COLUMNS the board has, where
//     the gates and the hotel strip are — are deliberately NOT here: they come off `RogersMeta`
//     (jumboCells / gates / hotel) so the mesh can never drift from the program that lights it;
//   • no logic, no imports: a leaf of plain `as const` data (config.test.ts's standing rule).
//
// CONTENT RULE (Part 11 shared rule 6, and the reason this table looks abstract): the board shows
// GENERIC COLOUR BLOCKS. No team marks, no league marks, no wordmarks — the homage is "a big lit
// LED board on the south face", which is what the researcher round verified is actually there (an
// exterior LED display: a large pylon board plus a ribbon, on the SOUTH face — conveniently one of
// the two faces the fixed rig ever sees). The three-colour block sets below are ordinary saturated
// hues chosen to read at blue hour, exactly like cnTower.ts's palettes: nothing deep-blue, because
// deep blue on a deep-blue sky is an invisible board.
//
// BLACKOUT: unlike the CN Tower — which is STRUCTURALLY forbidden from knowing the grid exists,
// because "the tower stays lit through DARK CITY" is the money shot — the Rogers Centre DIMS with
// its district (harbourfront). One lit stadium next to a dark skyline would dilute the very shot
// CN's law protects. `blackout` below is that fade; rogersNightMaterial.ts drives it off the
// powergrid's own dark state.

/** One jumbotron scheme: three colour blocks the board cycles across its columns. */
export interface RogersJumboScheme {
  readonly name: string;
  readonly blocks: readonly [string, string, string];
}

export const ROGERS_CENTRE = {
  jumbotron: {
    /** The seeded scheme set. Index 0 is the neutral "broadcast" set and carries the most weight. */
    schemes: [
      { name: 'broadcast', blocks: ['#ff5a3c', '#ffd24a', '#4ad9ff'] },
      { name: 'replay', blocks: ['#ff3f7a', '#ffe066', '#3fe0b0'] },
      { name: 'scoreboard', blocks: ['#ffb020', '#ff6a3d', '#f2f2f2'] },
      { name: 'concert', blocks: ['#c96bff', '#ff5ea8', '#4ad9ff'] },
    ] as readonly RogersJumboScheme[],
    /** Weight per scheme index (same order/length as `schemes`; normalized at pick time). */
    schemeWeights: [0.4, 0.2, 0.22, 0.18],
    /**
     * Steady additive brightness of a colour block (unlit/toneMapped=false slice: 1 ≈ "as bright
     * as full white paint", so >1 is genuine glow). Below CN's ring peak on purpose — the tower is
     * the hero light in this block, the board is its neighbour.
     */
    baseIntensity: 1.25,
    /** A brighter band sweeping across the columns — the life in an otherwise static board. */
    bandBoost: 0.8,
    /** Half-width of that band as a fraction of the board's width. */
    bandWidth: 0.16,
    bandPeriodMs: 2600,
    /** One full colour-block scroll across the board. Stepwise (one column at a time, as a real
     *  LED board does) — the shader floors the phase into a whole-column shift. */
    scrollPeriodMs: 5200,
  },

  /** The entrance bays' lintel strips (CN_PROGRAM.EMISS, selector `gate`). Warm, low, steady. */
  gates: {
    color: '#ffb15c',
    intensity: 0.9,
  },

  /** The north-face hotel strip's lit rooms (CN_PROGRAM.EMISS, selector `hotel`). */
  hotel: {
    color: '#ffd9a0',
    intensity: 0.75,
  },

  blackout: {
    /** How long the whole program takes to fade out when harbourfront loses power. Slow enough to
     *  read as a fade on camera, fast enough to be finished before the player drives away. */
    fadeMs: 1600,
    /** What's left at full dark: emergency/standby lighting, not a black hole punched in the mesh.
     *  Multiplies every program emissive (the `uDark` uniform lerps 1 → this). */
    floor: 0.07,
  },
} as const;
