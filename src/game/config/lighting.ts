// Blue-hour lighting-rig tunables (Phase 5, TDD §8.1-8.2). "Permanent early-evening blue
// hour" is a locked design decision (CLAUDE.md): one warm, low-angle dusk directional key
// (with a tight shadow frustum that FOLLOWS the player), a cool hemisphere ambient, a
// gradient sky matched to linear fog, and ACES tone mapping. No post-processing (TDD §8.2).
//
// Colour leaves are hex strings, so the leva auto-schema (core/devPanel.tsx only surfaces
// number/boolean leaves) skips them — retune colours in code + HMR. Every *number* here
// shows up live in the "LIGHTING" Config folder; the mood-critical scalars (sun/hemi
// intensity, exposure, fog near/far) are re-read each frame by world/lighting.ts so those
// sliders actually move the picture without a reload. Structural angles/frustum are read at
// module load (basis is precomputed) — tuning azimuth/elevation/frustum needs an HMR reload.
export const LIGHTING = {
  // --- Dusk directional key: a just-set sun raking in from the west-north-west ----------
  sun: {
    // Warm low-sun amber. The key that separates blue-hour from plain night: cool ambient
    // everywhere, this warm light only on sun-facing planes + the tops the top-down camera
    // sees most of.
    color: '#ffbb77',
    intensity: 3.6,
    // Compass azimuth of the sun, degrees: 0 = N (−Z), 90 = E (+X), 180 = S (+Z), 270 = W
    // (−X), clockwise seen from above (see world/lighting.ts sunToWorld for the exact
    // mapping). ~290° = WNW: the grid is axis-aligned N-S/E-W, so an off-axis sun rakes long
    // shadows DIAGONALLY across the streets instead of straight down them (which reads flat).
    azimuthDeg: 290,
    // Low, "just-set" elevation above the horizon. Low → long dramatic shadows; not so low
    // that every tower's shadow overshoots the 60 m follow frustum and clips.
    elevationDeg: 24,
    // How far up the light sits along its direction. Irrelevant to a directional light's
    // (parallel) shading — this only places the orthographic SHADOW camera, so it just needs
    // to clear the tallest geometry with the near/far below.
    distanceM: 100,
  },

  // --- Hemisphere ambient: cool dusk sky above, warm ground bounce below ----------------
  hemi: {
    skyColor: '#6d92cf', // cool dusk blue from overhead — this is what tints the shadows blue
    groundColor: '#6b5238', // warm ground/asphalt bounce from below
    intensity: 1.7,
  },

  // --- Linear fog: distant geometry dissolves into the sky's horizon band --------------
  // Fog COLOUR is the sky horizon colour (sky.horizon below) so the two match exactly — set
  // in world/lighting.ts, not duplicated here. near/far are leva-live for framing the haze.
  //
  // Phase 25.8 (D2/D3 L1): near 70→140, far 380→650. The D2 probe found the WARM fog
  // (#dd8b55) is a CONTRAST-COMPRESSOR under the tight §5.3 camera — the old near=70/far=380
  // ramp sat right across the visible frame, pulling bright crosswalks DOWN toward mid-orange
  // and lifting darks UP into a muddy flat mid. Pushing the ramp out doubles the crisp near
  // range (the drive-past reads sharp) while distant towers still haze into the horizon band.
  fog: {
    near: 140,
    far: 650,
  },

  // --- Gradient sky (CanvasTexture on scene.background) ---------------------------------
  // A 2D screen-space gradient painted into world/BlueHourRig.tsx's sky CanvasTexture: a
  // vertical blue-hour ramp (deep blue zenith → warm horizon band → ground-ward tint) PLUS a
  // directional "lake glow" lobe (below). Screen-space is legitimate here because the follow
  // camera is FIXED-YAW (config/camera.ts) — screen X/Y map to a constant compass bearing, so
  // the warm afterglow can be baked to sit over the lake without a world-space sky dome (0
  // extra draw calls; TDD §8.2 "cheapest that reads"). Colour leaves are hex strings, so the
  // leva auto-schema skips them; retune in code + HMR.
  sky: {
    top: '#0d1a33', // deep evening blue overhead
    horizon: '#dd8b55', // warm horizon band (== fog colour, == where the sun set)
    bottom: '#141d33', // ground-ward tint below the horizon line
    // Fraction of screen height (0 = top, 1 = bottom) where the warm horizon band centres.
    // The camera looks down, so the real horizon sits high — bias the band above mid-screen.
    horizonStop: 0.46,
    // Directional lake afterglow (Phase 19, TDD §13): a soft radial warm lobe added over the
    // vertical ramp so the amber-pink band reads STRONGEST toward the south/lake. The rig
    // looks WNW-and-down, so the southward side of the visible horizon falls to the lower-LEFT
    // of frame — hence a left-of-centre lobe. strength is the peak added warmth (0..1); the
    // numeric leaves are leva-live for framing, the colour is code-only.
    glow: {
      color: '#f0a878', // amber-pink afterglow — brighter/pinker than the plain horizon band
      strength: 0.55,
      centerX: 0.36, // lobe centre, screen-x fraction (lake/south side ≈ left)
      centerY: 0.52, // lobe centre, screen-y fraction (≈ the horizon band)
      radius: 0.55, // lobe radius as a fraction of the canvas diagonal
    },
  },

  // --- Shadow frustum (TDD §8.2: "tight ~60 m shadow frustum following the player") -----
  // Orthographic box side length (m), centred on the player and texel-quantized each frame
  // (world/lighting.ts) so the shadows don't shimmer while driving.
  shadowFrustumM: 60,
  // Ortho shadow-camera near/far, measured along the light direction from `sun.distanceM`
  // out. Wide enough to bracket the follow box + building heights; ortho depth is linear so
  // a generous range costs no precision.
  shadowNear: 10,
  shadowFar: 210,
  // Depth bias to kill shadow acne on the low-poly flats without detaching contact shadows.
  shadowBias: -0.0004,
} as const;
