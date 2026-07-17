// Follow-camera tunables. TDD §5.3.
export const CAMERA = {
  // Fixed yaw/pitch — no player rotation control; key to the Smashy look. TDD §5.3.
  yawDeg: 45,
  pitchDeg: 50,
  // Base follow distance (m).
  baseDist: 18,
  // Distance eases out up to +this many meters with speed...
  speedZoom: 10,
  // ...and +this many meters per wanted tier.
  tierZoom: 1.5,
  // Position damped-lerp factor per frame @60fps.
  lerp: 0.08,
  // Look-target leads this many meters along velocity.
  lookAhead: 4,
  // Camera shake (fx/cameraRig.ts). TDD §5.3 ("decaying noise, capped") + §8 (juice pass).
  // Phase 16 evolved the single-bucket trauma model into a PER-SOURCE one: addShake() tags
  // every hit with a source, each source accumulates into its own bucket (capped by
  // sourceCaps below) and decays independently, and the APPLIED amplitude each frame is
  // min(maxAmplitude, sum of the live per-source buckets) — so the overall cap still holds,
  // but each source has its OWN ceiling on how violent it can feel. A frequent, gentle
  // source (a spray of ram nudges) is held well under the budget so it can never build up to
  // feel like a real crash, while a big, rare one (a hard impact, an explosion) is allowed to
  // fill it. Values are feel placeholders, live-tunable via leva.
  shake: {
    // Hard ceiling on the applied jitter (m of peak offset). Unchanged from Phase 3.
    maxAmplitude: 0.5,
    // Linear trauma decay (per second), applied to every per-source bucket.
    decayPerSec: 3,
    // Oscillation rate of the jitter (Hz).
    frequencyHz: 24,
    // Per-source trauma caps (m), each ≤ maxAmplitude. `impact` and `explosion` — the game's
    // headline hits (a hard crash, a blast) — may saturate the FULL budget, matching the
    // pre-Phase-16 single-bucket feel for the common damage-shake path (combat/damage.ts
    // relies on a threshold-band impact reaching its raw trauma un-clamped up to the cap).
    // `ram` and `generic` sit lower so those gentler, more frequent sources LAYER onto a hit
    // rather than dominate it or stack up into crash-grade shake on their own.
    sourceCaps: {
      impact: 0.5,
      explosion: 0.5,
      ram: 0.3,
      generic: 0.4,
    },
    // FOV micro-kick on hard impacts (§8 "punch"): a hard collision briefly widens the FOV
    // a few degrees, snapping back over ~150 ms — a cheap, readable "hit" flourish the
    // positional jitter alone can't give. Armed ONLY by addShake(..., 'impact') at/above
    // minStrength (so light taps and non-impact sources never kick the lens). Suppressed
    // wholesale under reducedShake and during the death beat (fx/cameraRig.ts), same as the
    // positional shake. All degrees of FOV, not meters.
    fovKick: {
      // Impact trauma below this doesn't kick the lens at all (skip trivial contacts).
      minStrength: 0.3,
      // Degrees of FOV kick added per unit of impact strength (before the maxDeg cap).
      strengthToDeg: 5,
      // Cap on the FOV kick (deg) — "a few degrees", TDD §8.
      maxDeg: 4,
      // Linear decay (deg/sec). 4 / 27 ≈ 0.148 s from a full kick back to rest (~150 ms).
      decayPerSec: 27,
    },
  },
  // WRECKED death beat (combat/runLoop.ts calls fx/cameraRig.ts's setDeathPullback(true),
  // TDD §5.10 "brief ... camera pull-back"): extra follow-distance (m) added on top of the
  // normal base/speed/tier zoom while the lock window is active. Phase 16 bumped this 6 -> 8
  // for a more deliberate, cinematic pull-back (the positional shake is suppressed for the
  // whole beat, so the extra distance now reads as a clean camera move, not jitter).
  deathPullback: 8,
  // Cinematic death-beat framing (Phase 16, fx/cameraRig.ts). The beat eases in over
  // `easeInSec`; WRECKED pulls BACK and lifts slightly, BUSTED converges IN and LOWER
  // toward the arrest — two distinct, deliberate camera moves off the same lock window.
  // The gentle yaw drift is the fixed-yaw model's one sanctioned exception, and only during
  // the death beat.
  cinematic: {
    // Seconds to ease the orbit/pitch offsets to full (the pull-back distance itself is
    // smoothed by the normal position lerp, so it needs no separate ease here).
    easeInSec: 0.9,
    // Gentle orbit (deg of yaw drift) eased in over the beat — a slight drift, not a spin.
    orbitYawDeg: 8,
    // WRECKED: a touch of extra downward look (deg of pitch, + = higher/more top-down) as
    // the camera pulls back — reads as "stepping back to survey the wreck".
    wreckedPitchOffsetDeg: 3,
    // BUSTED: pull the camera IN (negative = closer than the WRECKED pull-back — a tighter
    // frame) and LOWER (negative pitch = nearer the horizon) toward the surrounded car.
    bustedPullback: -4,
    bustedPitchOffsetDeg: -14,
  },
} as const;
