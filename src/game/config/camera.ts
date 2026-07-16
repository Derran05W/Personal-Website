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
  // PLACEHOLDER — tune in Phase 3/16. TDD §5.3 only specifies "decaying noise, capped";
  // no concrete amplitude/decay numbers given. Trauma accumulates via fx/cameraRig's
  // addShake(), is capped at maxAmplitude (m), decays linearly by decayPerSec (per second),
  // and drives a decaying positional jitter at frequencyHz.
  shake: {
    maxAmplitude: 0.5,
    decayPerSec: 3,
    // Oscillation rate of the shake jitter (Hz). Needed for a real shake; still a
    // feel placeholder until the Phase 16 juice pass.
    frequencyHz: 24,
  },
} as const;
