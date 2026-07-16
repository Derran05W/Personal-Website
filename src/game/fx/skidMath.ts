// Pure, framework-free geometry/fade math for the skid-mark system (fx/SkidMarks.tsx).
// Kept in its own module — plain numbers, zero three/R3F imports — so the load-bearing
// bits (segment placement, the fade curve) unit-test cleanly without dragging the whole
// InstancedMesh component (and its three dependency) into vitest. SkidMarks.tsx owns all
// the stateful ring-buffer/allocation-free wiring; this file is stateless helpers only.

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Fade progress 0..1 for a mark of the given age (s) over `fadeSeconds`. 0 = fresh rubber,
 * 1 = fully dissolved into the ground colour (caller then hides the instance). Guards a
 * zero/negative fade window by returning 1 (instant fade) rather than dividing by zero.
 */
export function skidFadeProgress(age: number, fadeSeconds: number): number {
  if (fadeSeconds <= 0) return 1;
  return clamp01(age / fadeSeconds);
}

export interface SkidSegment {
  /** Midpoint between the previous and current wheel ground point (world XZ). */
  readonly midX: number;
  readonly midZ: number;
  /** Yaw about world +Y (rad) that aligns a quad's local +Z (length axis) with the
   * travel direction. atan2(dx, dz) because +Z is forward in this project's frame. */
  readonly yaw: number;
  /** Segment length (m) — the distance travelled since the last emit, clamped to
   * `maxLength` so one over-long frame can't stretch a single quad. */
  readonly length: number;
}

/**
 * Solve the transform for one skid quad spanning the wheel's previous ground point
 * (a) → current ground point (b), in world XZ. The quad is centred on the midpoint,
 * oriented along a→b, and length-clamped. Width is applied by the caller (SKID.markWidth);
 * a degenerate a===b yields yaw 0 (atan2(0,0)) and length 0, which the caller never emits.
 */
export function computeSkidSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  maxLength: number,
): SkidSegment {
  const dx = bx - ax;
  const dz = bz - az;
  const rawLength = Math.hypot(dx, dz);
  return {
    midX: (ax + bx) * 0.5,
    midZ: (az + bz) * 0.5,
    yaw: Math.atan2(dx, dz),
    length: rawLength < maxLength ? rawLength : maxLength,
  };
}
