// Follow-camera tunables. TDD §5.3.
export const CAMERA = {
  // Fixed yaw/pitch — no player rotation control; key to the Smashy look. TDD §5.3.
  yawDeg: 45,
  pitchDeg: 50,
  // Base follow distance (m). Feel-tuning pass: 18 -> 24 (zoomed out for a wider view of
  // the action; total distance = baseDist + speedZoom·ease + tierZoom·tier).
  baseDist: 24,
  // Vertical field of view (deg). Phase 33 moved this INTO config: it previously existed only as
  // a literal on the <Canvas camera> prop (game/index.tsx), which made a camera candidate
  // impossible to express as data. game/index.tsx now reads CAMERA.fov for the boot camera — but
  // that prop is INITIAL-ONLY, so a live change (this leaf via leva, or a CAMERA_PRESETS apply)
  // must additionally write camera.fov + updateProjectionMatrix() AND relatch fx/cameraRig's
  // FOV-kick base (resetBaseFov). fx/cameraLab.ts's applyCameraPreset is the one path that does
  // all three; tuning this leaf alone in leva changes config without moving the live lens.
  // Phase 34 pins this as law alongside yaw/pitch/baseDist.
  fov: 45,
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
    // Master kill-switch (feel-tuning pass): false disables ALL applied shake — both the
    // positional jitter offset and the FOV micro-kick — at the application point in
    // fx/cameraRig.ts's updateCameraRig (`suppress`), same gate as reducedShake/death-beat.
    // Trauma still accumulates/decays underneath (untouched), so flipping this back to true
    // resumes exactly where the pre-existing math left off. All other shake values below are
    // left intact so the effect is fully reversible.
    enabled: false,
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

// --- Phase 33 camera lab: candidate rigs (NOT shipped defaults) ------------------------------
// The Part-9 user directive re-opened the "Camera bearing: FIXED" lock: the camera phases through
// buildings (pack streetwall facades ≈ 19.4 wu vs a resting eye of 24·sin50° = 18.39 wu). These
// five candidates are the evidence apparatus for that decision, applied LIVE by fx/cameraLab.ts
// (dev-only) and judged at the Phase 33 USER GATE; Phase 34 promotes the pick into CAMERA above
// and pins it as §5.3 law. Nothing here changes a shipped frame on its own — CAMERA is untouched
// until applyCameraPreset() writes into it.
//
// Every preset keeps the fixed-bearing MODEL (no player rotation control): yaw may take a
// different VALUE, but it never tracks the car during play. Presets deliberately carry only the
// four geometry leaves that define a rig — yaw/pitch/distance/lens; speedZoom, tierZoom, lerp and
// lookAhead stay SHARED (they are feel, not framing, and Phase 34 retunes them once against
// whichever geometry wins, rather than five times here).

/** Preset D's spring-arm ("canyon-aware") tunables. The arm reads the Phase-33 static building
 * AABB index (world/toronto/cameraClipIndex.ts) rather than physics raycasts — deterministic, no
 * physics cost, and the same index the clip instrumentation samples. */
export interface CameraSpringArmConfig {
  /** Max pitch the arm may ADD (deg, + = higher/more top-down) when the near field is blocked. */
  readonly maxPitchLiftDeg: number;
  /** Max follow distance the arm may REMOVE (m) when the near field is blocked. */
  readonly maxPullInM: number;
  /** Seconds for a full 0 → cap traversal (both axes rate-limit at cap/easeSec per second). */
  readonly easeSec: number;
  /** The near field must read CLEAR continuously for this long before the arm releases —
   * hysteresis, so grazing a corner can't strobe the framing (the flashing complaint reborn). */
  readonly clearHoldSec: number;
  /** Length (m) of the boresight probe ahead of the eye. Only occluders THIS close to the lens
   * count as "near field" — the whole eye→car segment is blocked constantly in a dense streetwall
   * (a corner building between camera and car is the normal case), which would leave the arm
   * permanently lifted and stop being a canyon RESPONSE. */
  readonly probeAheadM: number;
}

export interface CameraPreset {
  readonly id: string;
  readonly label: string;
  readonly yawDeg: number;
  readonly pitchDeg: number;
  readonly baseDist: number;
  readonly fov: number;
  /** Present only on candidates that run a dynamic arm (D). */
  readonly springArm?: CameraSpringArmConfig;
}

export const CAMERA_PRESETS = [
  {
    // Baseline control — MUST equal the shipped CAMERA values field-for-field (test-locked), so
    // "lab inactive" and "preset A" are the same camera. Wins only if the height re-grade (P35)
    // and occlusion v2 (P36) fix phasing on their own.
    id: 'A',
    label: 'A · tuned status quo',
    yawDeg: 45,
    pitchDeg: 50,
    baseDist: 24,
    fov: 45,
  },
  {
    // More top-down (closer to actual Smashy Road): the resting eye rises 18.39 → 23.75 wu, which
    // clears the 19.4 wu pack streetwall outright. Costs facade obliqueness — fascia/CROWN decals
    // are read at a steeper angle.
    id: 'B',
    label: 'B · high table',
    yawDeg: 45,
    pitchDeg: 58,
    baseDist: 28,
    fov: 45,
  },
  {
    // Telephoto flatten: distance buys the clearance (eye 26.81 wu) and the narrow lens keeps the
    // car the same size on screen. Compresses canyon depth — the city reads flatter/more diorama.
    id: 'C',
    label: 'C · long lens',
    yawDeg: 45,
    pitchDeg: 50,
    baseDist: 35,
    fov: 31,
  },
  {
    // A's framing in the open, with an arm that lifts/pulls in only when the near field is
    // blocked. Prototype-grade this phase: the most complex to tune and the easiest to make
    // strobe, but the only candidate that costs nothing in the 90% of the map that is open road.
    id: 'D',
    label: 'D · canyon-aware',
    yawDeg: 45,
    pitchDeg: 50,
    baseDist: 24,
    fov: 45,
    springArm: {
      maxPitchLiftDeg: 12,
      maxPullInM: 6,
      easeSec: 0.25,
      clearHoldSec: 0.3,
      // 8 m ≈ the distance the lens closes in ~0.2 s of hard cornering, so the arm starts moving
      // before a facade reaches the near plane, while ordinary streetwall 20 m out never trips it.
      probeAheadM: 8,
    },
  },
  {
    // The lab's discovery slot, tuned live 2026-07-26. The part file's worked example (54/28/38,
    // eye 22.65) AND a 56° variant both FAILED the fold-corridor rest test on the new boresight
    // counter (eye outside the flanking building, car 100% hidden behind the streetwall). Root
    // geometry, measured that session: on the dieted spine (15.4 road + 3 sidewalk) the
    // streetwall face plane sits ~10.7 wu off the centreline, so any rig with horizontal radius
    // dist·cos(pitch) > ~14.8 (i.e. >10.7 per axis under the 45° yaw) parks the eye inside or
    // behind the east frontage — B clears NOT by seeing over roofs but by keeping its eye inside
    // the canyon airspace. E therefore adopts B's corridor-safe envelope one step tighter
    // (58/26 → eye 22.05, horizontal 13.78 — ~1 wu of extra margin) and keeps its narrower
    // 38° lens as the flatten. Identity vs B: closer, calmer perspective; same clearance class.
    id: 'E',
    label: 'E · combo',
    yawDeg: 45,
    pitchDeg: 58,
    baseDist: 26,
    fov: 38,
  },
] as const satisfies readonly CameraPreset[];

export type CameraPresetId = (typeof CAMERA_PRESETS)[number]['id'];
