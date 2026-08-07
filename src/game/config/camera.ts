// Follow-camera tunables. TDD §5.3.
//
// THE RIG IS LAW (Phase 34, user pick 2026-07-26): yaw 45 / pitch 58 / baseDist 26 / FOV 38 —
// the Phase 33 lab's candidate E, chosen at that phase's USER GATE and pinned field-for-field in
// config/camera.law.test.ts. It supersedes the TDD §5.3 numbers (45/50/18) and the feel pass's
// baseDist 24; the fixed-bearing MODEL is unchanged (no player rotation control, so exactly two
// faces — south + east — of every box are ever visible).
//
// THE CONSTRAINT THAT PICKED IT — the corridor-airspace law, measured live in Phase 33: on the
// dieted Yonge spine (15.4 wu road + 3 wu sidewalk) the streetwall face plane sits ~10.7 wu off
// the centreline, so under the 45° yaw the eye only stays inside the street's own airspace while
// its HORIZONTAL RADIUS hr = dist·cos(pitch) ≤ ~14.8 wu. Rigs that "clear" by rising above the
// roofline don't exist here — downtown facades are far taller than any sane eye height. E holds
// hr = 26·cos58 = 13.78 wu with ~1 wu of margin; runner-up B sat at 14.84 (≈0 margin) and went
// eye-inside on 1 of 4 measured drives when a wedge angled it into the frontage. Every change to
// pitch/baseDist/speedZoom/tierZoom below is a change to that margin — the law test asserts the
// bound so feel churn can never silently re-break the corridor.
export const CAMERA = {
  // Fixed yaw/pitch — no player rotation control; key to the Smashy look. TDD §5.3.
  yawDeg: 45,
  pitchDeg: 58,
  // Base follow distance (m): 18 (TDD) -> 24 (feel pass) -> 26 (Phase 34 / rig E). Total distance
  // = baseDist + speedZoom·ease + tierZoom·tier; resting eye = 26·sin58 = 22.05 wu.
  baseDist: 26,
  // Vertical field of view (deg). Phase 33 moved this INTO config: it previously existed only as
  // a literal on the <Canvas camera> prop (game/index.tsx), which made a camera candidate
  // impossible to express as data. game/index.tsx now reads CAMERA.fov for the boot camera — but
  // that prop is INITIAL-ONLY, so a live change (this leaf via leva, or a CAMERA_PRESETS apply)
  // must additionally write camera.fov + updateProjectionMatrix() AND relatch fx/cameraRig's
  // FOV-kick base (resetBaseFov). fx/cameraLab.ts's applyCameraPreset is the one path that does
  // all three; tuning this leaf alone in leva changes config without moving the live lens.
  // 38° is rig E's flatten: it buys back the on-screen size the longer follow distance would
  // otherwise cost (26·tan19° = 8.95 of half-frame at the car vs the old rig's 24·tan22.5° =
  // 9.94, so the car actually reads a touch LARGER than before) while compressing canyon depth.
  fov: 38,
  // --- speed/tier framing ramp -------------------------------------------------------------
  // The ramp used to be pure DISTANCE (+10 m eased in with speed). Phase 33 measured what that
  // costs under the corridor law: distance alone grows hr, so the old +10 put the eye at
  // 36·cos58 = 19.08 wu of horizontal radius — inside the streetwall every time the player was
  // fast, which on the spine is most of the time. Phase 34 splits the ramp into a distance term
  // AND a PITCH term, because lifting the eye SHORTENS hr at the same follow distance: the frame
  // still opens up with speed and heat, but it opens upward-and-back instead of purely outward.
  // Both terms ride eases the rig already had (easeSpeedZoom's smoothstep for speed, linear per
  // tier), so nothing about the ramp's continuity changed — only where the extra framing goes.
  // Measured envelope (fx/cameraRig.ts's cameraDistance + cameraPitchOffsetDeg are the two
  // consumers): hr 13.78 at rest/★0, 13.62 at top speed/★0, 14.42 at rest/★5, 13.13 at top
  // speed/★5 — all inside the ~14.8 bound, worst absolute pitch 69.5° at ★5 + top speed (the
  // ~70° vertigo ceiling is the other side of this trade).
  speedZoom: 4,
  speedPitchDeg: 5,
  tierZoom: 1.5,
  tierPitchDeg: 1.3,
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
  // normal base/speed/tier zoom while the lock window is active. 6 (Phase 9) -> 8 (Phase 16,
  // a more deliberate move once the beat's shake was suppressed) -> 5 (Phase 34): at pitch 58
  // the corridor law leaves only ~2 m of pure-distance headroom (14.8/cos58 = 27.93 vs a base
  // of 26), so the old +8 pushed hr to 16.48 wu and put the eye in the streetwall for the one
  // moment the player is guaranteed to be watching. 5 m paired with the +4° lift below lands
  // hr 14.56 — the beat still steps visibly back, it just steps UP as it does.
  deathPullback: 5,
  // Cinematic death-beat framing (Phase 16, fx/cameraRig.ts). The beat eases in over
  // `easeInSec`; WRECKED pulls BACK and lifts slightly, BUSTED converges IN and LOWER
  // toward the arrest — two distinct, deliberate camera moves off the same lock window.
  // The gentle yaw drift is the fixed-yaw model's one sanctioned exception, and only during
  // the death beat. These are OFFSETS on the live framing, so they compose on top of the
  // speed/tier ramp above — a death at ★4 is already pitched up before the beat adds its own.
  cinematic: {
    // Seconds to ease the orbit/pitch offsets to full (the pull-back distance itself is
    // smoothed by the normal position lerp, so it needs no separate ease here).
    easeInSec: 0.9,
    // Gentle orbit (deg of yaw drift) eased in over the beat — a slight drift, not a spin.
    // 8 -> 10 in Phase 34: the swept WORLD arc is dist·cos(pitch)·Δyaw, and the higher pitch
    // shrinks that cos term ~11% against the old rig, so the drift needed a couple more degrees
    // to sweep the same amount of city.
    orbitYawDeg: 10,
    // WRECKED: a touch of extra downward look (deg of pitch, + = higher/more top-down) as
    // the camera pulls back — reads as "stepping back to survey the wreck". 3 -> 4 buys the
    // shortened pull-back (above) its corridor margin without tipping toward top-down flat.
    wreckedPitchOffsetDeg: 4,
    // BUSTED: pull the camera IN (negative = closer than the WRECKED pull-back — a tighter
    // frame) and LOWER (negative pitch = nearer the horizon) toward the surrounded car.
    // The -14 was sized against pitch 50 to land the arrest at ~36° absolute; from 58 it landed
    // at 44° and the low-angle identity was gone, so Phase 34 deepened it to -22 — 36° at ★0,
    // 38.6-39.9° at the ★2-★3 tiers a bust actually happens on. A low angle is inherently
    // wide (hr = dist·cos(36°) is 0.81·dist), so the converge was deepened -4 -> -8 to buy
    // back what the pitch spends: ★0 lands hr 14.56, inside the corridor. Higher tiers add
    // distance faster than the arrest angle can absorb (★2 16.4, ★5 18.8) — a deliberate,
    // measured cinematic excursion, and Phase 36's anti-clip is where it gets covered.
    bustedPullback: -8,
    bustedPitchOffsetDeg: -22,
  },
  // --- Phase 36: occlusion v2 boresight probe ------------------------------------------------
  // The occlusion pass no longer casts ONE ray at the car's centre. A single centre ray answers
  // "is the car's origin hidden?", but the failure players actually see is a wall grazing the
  // FRAME — the car's near corner disappearing behind a streetwall corner while its centre stays
  // clear (P35's census: 187/1268 frames had exactly that shape). So the pass casts five segments
  // from the eye: one to the car centre and four to the corners of a small box around the car.
  //
  // The box is deliberately YAW-INVARIANT (a square in XZ, not the car's oriented footprint):
  // reading the chassis' heading every frame would make the probe rotate — and therefore make a
  // grazing wall pop in and out of the hit set — as the car drifts, which is the strobe the
  // hysteresis hold exists to kill. A circumscribed square costs a few false positives at 45°
  // headings, and a false positive fades a wall that was nearly occluding anyway; a false negative
  // hides the car, which A.5 forbids. The asymmetry decides the trade.
  //
  // Values are the Rusty-Sedan reference chassis (config/vehicles.ts VEHICLE_TUNING.chassis:
  // halfWidth 0.9 / halfHeight 0.35 / halfLength 2.0) rather than a live read of the selected
  // car — a probe that changed size per garage pick would make the occlusion battery
  // un-comparable between runs, and the six cars differ by well under a metre.
  occlusionProbe: {
    /** XZ half-extent (m) of the yaw-invariant square whose corners are probed = chassis halfLength. */
    xzM: 2,
    /** Lower probe height (m, relative to the car's render origin) = the collider floor / sill line. */
    lowM: -0.35,
    /** Upper probe height (m, relative to the car's render origin) ≈ a pack car's roofline. The
     * collider box stops at +0.35, but the visible body (and therefore what a wall can hide) goes
     * higher; under a 58° pitch the high corners are the ones a streetwall crosses first. */
    highM: 0.9,
  },
  // --- Phase 36: camera anti-clip (last-resort eye guard) --------------------------------------
  // The primary defences against "the camera phases through a building" are the eye-line law
  // (CAMERA_EYE_MIN_WU below + config/cityPackScale.ts's streetwall cap) and the corridor-airspace
  // margin the rig itself was picked on. Both are STATIC guarantees about normal play. This block
  // covers what they deliberately do not: the death beat's measured excursions (BUSTED drops the
  // eye below EYE_MIN by design — see `cinematic` above), a respawn beside a tower, and any future
  // geometry that slips past the law. world/toronto/cameraAntiClip.ts is the solver; it pulls the
  // eye along the boresight TOWARD the car until it is clear, and never pushes it back out (the
  // rig's own damping does that, smoothly, for free).
  antiClip: {
    /** How far (m) outside every building volume the eye must be before it counts as clear. A
     * lens flush with a facade already looks broken, so the guard trips slightly early. */
    marginWu: 0.5,
    /** Hard cap (m) on the pull. Sized to cover the deepest ESCAPE the shipped map can demand,
     * not to keep the frame wide: the fattest street-facing towers (Aura's face sits ON Yonge)
     * can swallow the eye ~8–9 wu deep on an ordinary drive-by, and the boresight's exit from
     * such a box runs ~23–25 m (the Phase 36 drive census caught exactly this: 44 frames of
     * eye-inside-Aura with near-plane slicing under an earlier 14 m cap — the solver found no
     * clear point within the cap and declined, which read far worse than the resulting close-up
     * does). 25 keeps the law-pinned `maxPullM < baseDist` headroom; a deep pull is a brief
     * spring-arm close-up the rig's own lerp releases smoothly. The residual (a slice so deep
     * even 25 m finds no clear point — solver returns 0, eye stays put) is documented in the
     * Phase 36 notes for Phase 38's debt sweep. */
    maxPullM: 25,
    /** Rate cap (m/s) on how fast the pull may GROW. A wall the eye enters side-on can need most
     * of maxPullM in a single frame; ramping it over ~0.5 s reads as a spring arm, not a cut.
     * (The release direction is rate-limited too — by the rig's own position lerp, since this
     * guard never pushes outward.) */
    slewMPerSec: 30,
    /** Sample spacing (m) along the boresight when searching for the first clear point. 0.5 m is
     * well under the smallest indexed building footprint, so the search cannot step over a whole
     * volume, and caps the search at maxPullM/0.5 = 28 point queries — paid ONLY on frames the
     * eye is actually inside something (the clear fast path is a single query). */
    probeStepM: 0.5,
  },
} as const;

// --- THE ONE TRUE EYE LINE (Phase 35) ---------------------------------------------------------
// Every "how tall may a building be before the camera phases through it?" question in the codebase
// resolves HERE, and nowhere else. Phases 19-25.7 all cited a "~13.8/15 wu camera wall" — that
// number was derived from the long-dead baseDist 18 of the TDD rig, survived two retunes by being
// copied between comments rather than computed, and was still being quoted (placesLayer.ts, the
// notes) after the feel pass had already moved the eye to 20+ wu. It is now DELETED, not corrected:
// the two constants below are computed from the CAMERA leaves above, so a rig change moves them and
// no comment can go stale again.
//
// WHAT THEY MEAN. The eye rides a sphere of radius `dist` around the car at absolute pitch θ, so
// its height above the car's ground plane is dist·sin(θ) — nothing more subtle than that. EYE_MIN
// is the RESTING height (parked, ★0: the lowest the eye ever sits in normal play, since both halves
// of the framing ramp only ever ADD distance and pitch); EYE_MAX is the top of that envelope
// (top speed, ★5). Together they bracket the band that ordinary geometry must stay out of.
//
// HOW THE WORLD USES THEM (the eye-line law, pinned in world/toronto/heightLaw.test.ts): ordinary
// streetwall/filler stays BELOW EYE_MIN, so the eye clears its roofline at every point in the
// envelope; only a counted, listed intentional-tall set (the three tower districts' filler, the
// backdrop-tower row, the named landmark towers, the heroes) is allowed to cross. Crossing is not
// forbidden — it is the skyline — it just makes a mesh an occluder, which is why that list is
// Phase 36's occlusion work order rather than a bug list. config/cityPackScale.ts enforces the same
// bound on pack building scale (STREETWALL_MAX_HEIGHT_WU) so an art-scale change can't smuggle a
// 24 wu facade into the streetwall the way brown-building did before this phase.
//
// WHAT THEY ARE NOT:
//  • NOT the death-beat envelope. The cinematic offsets (esp. BUSTED's -22° pitch, which LOWERS the
//    eye toward an arrest angle) drop below EYE_MIN by design. Those are documented, measured
//    excursions on a 1-2 s scripted beat, covered by Phase 36's anti-clip — the streetwall law is
//    about normal play and deliberately does not try to also be the beat's law.
//  • NOT rig E's 13.78 wu HORIZONTAL RADIUS (dist·cos θ, the corridor-airspace quantity in
//    camera.law.test.ts). The coincidence that the stale wall number and the corridor radius are
//    both "13.8" is exactly how the stale doctrine survived so long. Different axis, different law.
const DEG2RAD = Math.PI / 180;

/** Resting camera-eye height above the car (wu): parked, ★0 — the LOWEST eye in normal play, and
 * therefore the ceiling ordinary streetwall must stay under. 26·sin58° = 22.05. */
export const CAMERA_EYE_MIN_WU = CAMERA.baseDist * Math.sin(CAMERA.pitchDeg * DEG2RAD);

/** The top wanted tier (★5) — how many tier steps the framing ramp can add. Hoisted at Phase 75 so
 * the two "both halves of the ramp saturated" expressions below share one statement of it. */
const MAX_WANTED_TIER = 5;

/** Absolute camera pitch (deg) at the TOP of the normal-play framing ramp — top speed at ★5, i.e.
 * the same pose CAMERA_EYE_MAX_WU is measured at. 58 + 5 + 5·1.3 = 69.5. */
export const CAMERA_PITCH_MAX_DEG = CAMERA.pitchDeg + CAMERA.speedPitchDeg + MAX_WANTED_TIER * CAMERA.tierPitchDeg;

/** Top of the normal-play eye envelope (wu): top speed at ★5, i.e. both halves of the framing ramp
 * saturated — distance (baseDist + speedZoom + 5·tierZoom) at pitch (pitchDeg + speedPitchDeg +
 * 5·tierPitchDeg). 37.5·sin69.5° = 35.13. Anything between EYE_MIN and this is inside the band the
 * eye sweeps as the player gets fast and hot. */
export const CAMERA_EYE_MAX_WU =
  (CAMERA.baseDist + CAMERA.speedZoom + MAX_WANTED_TIER * CAMERA.tierZoom) * Math.sin(CAMERA_PITCH_MAX_DEG * DEG2RAD);

/**
 * PHASE 75 — THE VISIBLE GROUND BAND, made computable.
 *
 * Depth (wu, measured ALONG the camera's boresight on the ground plane) of the strip of ground the
 * frame actually shows, for an eye `eyeWu` above the car's ground plane at absolute pitch
 * `absPitchDeg`: where the frustum's TOP edge meets y = 0, less where its BOTTOM edge does. Both
 * edges are below the horizon at every legal pose (the shallowest is pitchDeg − fov/2 = 39°), which
 * is Phase 38's measured finding stated as geometry: **no sky, no horizon, ever in frame**, so the
 * band is finite and the arithmetic below never divides through zero.
 *
 * Phase 38 measured this band at 27–29 wu in play and filed it as a verbal law ("the visible-band
 * law"). It is a pure function of the CAMERA leaves, so it is expressed here instead — a rig change
 * moves it and no comment can go stale.
 */
export function cameraGroundBandWu(eyeWu: number, absPitchDeg: number): number {
  const top = (absPitchDeg - CAMERA.fov / 2) * DEG2RAD;
  const bottom = (absPitchDeg + CAMERA.fov / 2) * DEG2RAD;
  return eyeWu / Math.tan(top) - eyeWu / Math.tan(bottom);
}

/**
 * The DEEPEST that band ever gets inside the normal-play eye envelope (wu) — 28.04, at top
 * speed/★5. Evaluated at both ENDS of the envelope rather than assumed monotonic: the ramp raises
 * the eye (deeper band) and steepens the pitch (shallower band) at the same time, so which end wins
 * is a fact about the tuned leaves, not a given. Rest = 22.14, saturated = 28.04.
 *
 * Consumers use it as "how much ground is on screen at once" — Phase 75's median planting derives
 * its pitch from it so no two planters can share a frame (config/torontoDress.ts's MEDIAN_PLANTING).
 */
export const CAMERA_GROUND_BAND_MAX_WU = Math.max(
  cameraGroundBandWu(CAMERA_EYE_MIN_WU, CAMERA.pitchDeg),
  cameraGroundBandWu(CAMERA_EYE_MAX_WU, CAMERA_PITCH_MAX_DEG),
);

// --- Phase 33 camera lab: candidate rigs (kept for re-comparison, NOT re-applied on boot) ------
// The Part-9 user directive re-opened the "Camera bearing: FIXED" lock: the camera phased through
// buildings (pack streetwall facades ≈ 19.4 wu vs the old rig's resting eye of 24·sin50° =
// 18.39 wu). These five candidates were the evidence apparatus for that decision, applied LIVE by
// fx/cameraLab.ts (dev-only) and judged at the Phase 33 USER GATE. Phase 34 promoted the pick (E)
// into CAMERA above and pinned it as §5.3 law — the identity invariant lives on preset E
// (cameraLab.test.ts), not on this table being touched. The table itself STAYS: it's the lab's
// re-comparison harness for P35 (height re-grade) and P36 (occlusion v2), both of which may want
// to re-run the gate against a changed city. Nothing here changes a shipped frame on its own —
// CAMERA is untouched until applyCameraPreset() writes into it.
//
// Every preset keeps the fixed-bearing MODEL (no player rotation control): yaw may take a
// different VALUE, but it never tracks the car during play. Presets deliberately carry only the
// four geometry leaves that define a rig — yaw/pitch/distance/lens; speedZoom, tierZoom,
// speedPitchDeg, tierPitchDeg, lerp and lookAhead stay SHARED (they are feel, not framing, and
// Phase 34 retuned them once — including splitting the ramp into distance AND pitch terms —
// against the winning geometry, rather than five times here).

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
    // The Phase-33 lab's baseline CONTROL — the pre-P34 shipped rig (45/50/24/45), kept exactly
    // as it was so P35/P36 can still ask "does the new geometry read better than what shipped
    // before adoption?". It no longer equals CAMERA above (that identity moved to preset E at
    // adoption — see E's comment below) and carries no test-locked invariant of its own; it's
    // history, not a fallback.
    id: 'A',
    label: 'A · pre-P34 status quo',
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
    // THIS IS THE SHIPPED RIG (Phase 33 USER GATE pick, 2026-07-26; promoted into CAMERA above at
    // Phase 34 — that block is the LAW copy, this row is kept only so the table stays a complete,
    // re-runnable comparison set for P35/P36). Discovered live in the Phase 33 lab session. The
    // part file's worked example (54/28/38, eye 22.65) AND a 56° variant both FAILED the
    // fold-corridor rest test on the boresight counter (eye outside the flanking building, car
    // 100% hidden behind the streetwall). Root geometry, measured that session: on the dieted
    // spine (15.4 road + 3 sidewalk) the streetwall face plane sits ~10.7 wu off the centreline,
    // so any rig with horizontal radius dist·cos(pitch) > ~14.8 (i.e. >10.7 per axis under the
    // 45° yaw) parks the eye inside or behind the east frontage — B clears NOT by seeing over
    // roofs but by keeping its eye inside the canyon airspace. E adopts B's corridor-safe envelope
    // one step tighter (58/26 → eye 22.05, horizontal 13.78 — ~1 wu of extra margin) and keeps its
    // narrower 38° lens as the flatten. Identity vs B: closer, calmer perspective; same clearance
    // class. CAMERA_PRESETS's own identity test (cameraLab.test.ts) pins this row against CAMERA
    // field-for-field — if the two ever diverge, the test catches it, not this comment.
    id: 'E',
    label: 'E · combo (shipped)',
    yawDeg: 45,
    pitchDeg: 58,
    baseDist: 26,
    fov: 38,
  },
] as const satisfies readonly CameraPreset[];

export type CameraPresetId = (typeof CAMERA_PRESETS)[number]['id'];
