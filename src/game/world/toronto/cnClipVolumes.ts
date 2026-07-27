// Phase 44 (T3) — the CN Tower's BASE as camera clip volume, shaped instead of blocked out.
//
// THE DEFECT THIS EXISTS FOR (filed by Phase 43, measured at Phase 44). Park the car ~11.5-20 wu
// NW of the tower axis and the fixed rig's eye — 13.78 wu SE of the car, 22.05 wu up — lands
// INSIDE the tower's own shaft. Every face of that shaft points outward, so the lens back-face-
// culls the whole tower: the frame reads as an empty lot with a car in it. The camera anti-clip
// guard (cameraAntiClip.ts) is the mechanism that should rescue such a pose — it pulls the eye
// down the boresight to the first CLEAR point — and it was declining, returning 0 pull, because
// the index it queries described CN's base as ONE 21x21x20 wu block: the leg splay's bounding box.
// That block covers the open arch void, the empty diagonal corners between the legs, and the air
// out to a 14.85 wu diagonal half-extent. The descending boresight (0.53 wu out per 0.85 wu down)
// could not clear a 14.85 wu diagonal within the guard's 25 m cap, so it gave up.
//
// WHAT THIS MODULE DOES. It derives the base's clip volumes FROM THE SHIPPED MESH — one pass over
// the tower's own triangle soup below `legTopY` — and emits a small set of tight boxes instead:
//   * per height band, the CORE (set-back trunk + the flared arch skirt above the void) as a
//     two-box PLUS rather than one square. A square of half-extent R over-covers its diagonal by
//     41 %; the plus (|x| <= R, |z| <= R/sqrt2 union |x| <= R/sqrt2, |z| <= R) still covers the whole
//     disc of radius R — for any point of that disc min(|x|,|z|) <= r/sqrt2 — while reaching exactly
//     r = R on the diagonal. The tower's diagonal is where the boresight runs, so this is not a
//     cosmetic tightening.
//   * per height band, per LEG, the fin's own rotated rectangle (radial extent x half-width in that
//     leg's frame), split into its two lateral halves. A diagonal leg's single AABB bulges to
//     r = 12.25 on the diagonal — its empty corner sits exactly on the boresight; splitting at the
//     leg's centreline drops that to the leg's true radial tip (10.3) plus the guard margin, which
//     is the geometric FLOOR for an axis-aligned cover of an on-diagonal fin.
// The union still contains every base vertex (each one is either within LEG_SECTOR_RAD of a rib —
// then its own leg rectangle holds it — or outside all three, then the core disc holds it), so the
// index never loses coverage the fat box had over real concrete. What it loses is air.
//
// WHY DERIVED FROM THE MESH, NOT FROM A TABLE OF RADII. heroes.ts's radius laws (trunkR/skirtR/
// finSection) are private implementation detail of the geometry builder, and Phase 41's anchor-
// derivation lesson is explicit: a second hand-copied profile is a drift bug waiting for the next
// re-proportioning. Feeding this the same position buffer the renderer draws makes the camera's
// idea of the tower and the tower itself the same object by construction.
//
// SCOPE. Base only (y in [0, legTopY]). The taper shaft above it keeps its own per-band hints
// (CnTowerMeta.shaftColliders, Phase 36) — `cnShaftClipVolumes` below re-expresses those as the
// same two-box plus, for the same diagonal reason.
//
// MEASURED OUTCOME (Phase 44, 12,992 drivable car poses on a 0.5 wu grid within 30 wu of the axis,
// each solved through cameraAntiClip's own solver):
//   poses the eye rests INSIDE with no escape:  94 -> 14
//   poses that converge to a < 5 wu close-up:  192 -> 71
//   poses the guard never touches at all:   12,086 -> 12,399
// So the tightening does not merely un-stick the filed pose: it means the guard fires LESS often
// and shallower everywhere around the tower. What it costs is a narrow slice — a car parked 12-16
// wu NW, dead on the diagonal — that used to sit still-but-illegal and now dives to a close-up.
//
// AND THE THING THE FIX CANNOT DO, which is worth writing down because it looks like a bug report
// and is not: from any of these poses the tower is BEHIND the camera. The rig looks NW along a
// fixed 45 deg bearing, a car NW of the tower puts the tower SE of the lens, and Phase 38's
// visible-band law says nothing above the eye line ever enters frame anyway. No amount of clip
// shaping can turn the defect frame into a shot of the arch — the only thing on offer is a frame
// that composes NORMALLY, which is what the numbers above buy. The 14 residual poses (a ~1 x 4 wu
// patch flat against the NW face, where the boresight would have to travel further than maxPullM
// down the NW leg to clear the splay) keep the wide, back-face-culled reading, which is the least
// bad of the available frames, not a broken one.

import type { ClipAabb } from './cameraClipIndex';

/** The slice of `CnTowerMeta` this module needs — structural, so nothing here imports heroes.ts. */
export interface CnBaseInput {
  /** Where the legs have fully merged into the closed shaft; the ceiling of this module's scope. */
  readonly legTopY: number;
  /** Apex of the parabolic arch void — the band cut that lets the void read as open below it. */
  readonly archApexY: number;
  /** Azimuths (rad, from +Z toward +X) of the three legs/fins. */
  readonly ribAzimuths: readonly number[];
}

/** A cylinder hint in the shape `CnTowerMeta.shaftColliders` / `.collider` publish. */
export interface CnCylinderHint {
  readonly radius: number;
  readonly halfHeight: number;
  readonly centerY: number;
}

/**
 * Half-angle (deg) of the sector each rib claims: every vertex is either within this of a rib
 * azimuth (and lands in that leg's own rectangle) or outside all three (and lands in the core
 * disc), which is what makes the coverage argument in the header airtight whatever the value is.
 *
 * 25 deg, and DELIBERATELY NOT A MULTIPLE OF 15. The arch skirt is azimuth-sampled every 15 deg and
 * the ribs sit on samples, so 30 deg — the even leg/gap split, the obvious pick — puts a whole ring
 * of skirt vertices EXACTLY on the classification boundary, where float noise decides which family
 * each one joins and the emitted box extents stop being reproducible. 25 clears the fin's own
 * angular half-width at its tip (atan(1.95 / 10.3) = 11 deg) with room to spare; the fin ROOT is
 * angularly wider than this and spills into the core, which costs nothing — its radius there
 * (~3.6 wu) is well inside the trunk the core disc already covers.
 */
const LEG_SECTOR_DEG = 25;
const LEG_SECTOR_RAD = (LEG_SECTOR_DEG * Math.PI) / 180;

/**
 * Height bands below `legTopY`, with a cut ON `archApexY`: below that line the only concrete in a
 * gap sector is the set-back trunk, so those bands' core radius collapses toward the trunk and the
 * arch void reads as the open air it is; above it the skirt has sprung and the core widens.
 *
 * FOUR bands below the arch, two above. The parabolic springing means a skirt triangle near a leg
 * spans a lot of height, and a band it merely CLIPS still takes its full radial extent (that is the
 * conservative rule that makes the boxes contain triangles, not just vertices) — so coarse bands
 * drag the sprung skirt's radius down into the open air beneath the arch. Four is where the lowest
 * band stops seeing any skirt at all.
 */
const BANDS_BELOW_ARCH = 4;
const BANDS_ABOVE_ARCH = 2;

const SQRT1_2 = Math.SQRT1_2;

interface LegAccum {
  minRadial: number;
  maxRadial: number;
  minLateral: number;
  maxLateral: number;
  seen: boolean;
}

function emptyLeg(): LegAccum {
  return { minRadial: Infinity, maxRadial: -Infinity, minLateral: Infinity, maxLateral: -Infinity, seen: false };
}

/** Absolute angular distance between two azimuths, wrapped into [0, PI]. */
function angularDistance(a: number, b: number): number {
  const tau = Math.PI * 2;
  const d = (((a - b) % tau) + tau) % tau;
  return d > Math.PI ? tau - d : d;
}

/** The band cuts: [0 .. archApexY] then [archApexY .. legTopY], each evenly subdivided. */
export function cnBaseBandCuts(meta: CnBaseInput): number[] {
  const cuts: number[] = [];
  for (let i = 0; i < BANDS_BELOW_ARCH; i++) cuts.push((meta.archApexY * i) / BANDS_BELOW_ARCH);
  for (let i = 0; i <= BANDS_ABOVE_ARCH; i++)
    cuts.push(meta.archApexY + ((meta.legTopY - meta.archApexY) * i) / BANDS_ABOVE_ARCH);
  return cuts;
}

/**
 * A disc of radius `r` centred on (cx, cz), covered by TWO axis-aligned boxes in a plus formation
 * (see the header). Returns nothing for a non-positive radius.
 */
function discPlus(cx: number, cz: number, r: number, minY: number, maxY: number, out: ClipAabb[]): void {
  if (!(r > 0)) return;
  const s = r * SQRT1_2;
  out.push({ minX: cx - r, maxX: cx + r, minY, maxY, minZ: cz - s, maxZ: cz + s, fadeKey: null });
  out.push({ minX: cx - s, maxX: cx + s, minY, maxY, minZ: cz - r, maxZ: cz + r, fadeKey: null });
}

/** AABB of the rectangle {radial in [r0,r1], lateral in [s0,s1]} in the frame of azimuth `az`. */
function rotatedRectAabb(
  cx: number,
  cz: number,
  az: number,
  r0: number,
  r1: number,
  s0: number,
  s1: number,
  minY: number,
  maxY: number,
): ClipAabb {
  const ux = Math.sin(az);
  const uz = Math.cos(az);
  const px = Math.cos(az);
  const pz = -Math.sin(az);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const r of [r0, r1]) {
    for (const s of [s0, s1]) {
      const x = r * ux + s * px;
      const z = r * uz + s * pz;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return { minX: cx + minX, maxX: cx + maxX, minY, maxY, minZ: cz + minZ, maxZ: cz + maxZ, fadeKey: null };
}

/**
 * The shaped base volumes for a CN Tower standing at `at`.
 *
 * `positions` is the tower geometry's own non-indexed position buffer (x,y,z triples, three
 * consecutive vertices per triangle) in the mesh's LOCAL frame — i.e. exactly
 * `geometry.getAttribute('position').array` from `buildCnTowerGeometry()`. Triangles are assigned
 * to every band their y-range overlaps and contribute ALL THREE vertices to it, which is what makes
 * each band's boxes contain the triangles' full convex hulls rather than just their vertices.
 */
export function cnBaseClipVolumes(
  positions: ArrayLike<number>,
  meta: CnBaseInput,
  at: { readonly x: number; readonly z: number },
): ClipAabb[] {
  const cuts = cnBaseBandCuts(meta);
  const bandCount = cuts.length - 1;
  const ribs = meta.ribAzimuths;
  const coreR: number[] = new Array<number>(bandCount).fill(0);
  const legs: LegAccum[][] = Array.from({ length: bandCount }, () => ribs.map(() => emptyLeg()));

  const triCount = Math.floor(positions.length / 9);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const y0 = positions[o + 1];
    const y1 = positions[o + 4];
    const y2 = positions[o + 7];
    const tMinY = Math.min(y0, y1, y2);
    const tMaxY = Math.max(y0, y1, y2);
    if (tMinY >= meta.legTopY) continue; // the shaft's own hints own everything above the merge
    for (let b = 0; b < bandCount; b++) {
      // Half-open overlap: a triangle that merely TOUCHES a band's ceiling (the arch skirt's
      // springing points sit exactly on archApexY) belongs to the band above, which is what keeps
      // the void's ceiling from being pulled down into the open band below it.
      if (!(tMaxY > cuts[b] && tMinY < cuts[b + 1])) continue;
      for (let v = 0; v < 3; v++) {
        const x = positions[o + v * 3];
        const z = positions[o + v * 3 + 2];
        const az = Math.atan2(x, z);
        let best = -1;
        let bestD = LEG_SECTOR_RAD;
        for (let i = 0; i < ribs.length; i++) {
          const d = angularDistance(az, ribs[i]);
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
        if (best < 0) {
          const r = Math.hypot(x, z);
          if (r > coreR[b]) coreR[b] = r;
          continue;
        }
        const a = ribs[best];
        const radial = x * Math.sin(a) + z * Math.cos(a);
        const lateral = x * Math.cos(a) - z * Math.sin(a);
        const acc = legs[b][best];
        acc.seen = true;
        if (radial < acc.minRadial) acc.minRadial = radial;
        if (radial > acc.maxRadial) acc.maxRadial = radial;
        if (lateral < acc.minLateral) acc.minLateral = lateral;
        if (lateral > acc.maxLateral) acc.maxLateral = lateral;
      }
    }
  }

  const out: ClipAabb[] = [];
  for (let b = 0; b < bandCount; b++) {
    const minY = cuts[b];
    const maxY = cuts[b + 1];
    discPlus(at.x, at.z, coreR[b], minY, maxY, out);
    for (let i = 0; i < ribs.length; i++) {
      const acc = legs[b][i];
      if (!acc.seen) continue;
      // Split at the fin's own centreline. The two halves' union is the same rectangle, but each
      // half's AABB stops at the fin's true radial tip on the diagonal instead of ~1.4x past it.
      const lo = Math.min(acc.minLateral, 0);
      const hi = Math.max(acc.maxLateral, 0);
      const r0 = Math.max(0, acc.minRadial);
      const r1 = acc.maxRadial;
      if (!(r1 > r0)) continue;
      if (lo < 0) out.push(rotatedRectAabb(at.x, at.z, ribs[i], r0, r1, lo, 0, minY, maxY));
      if (hi > 0) out.push(rotatedRectAabb(at.x, at.z, ribs[i], r0, r1, 0, hi, minY, maxY));
    }
  }
  return out;
}

/**
 * The taper shaft's Phase-36 band hints, re-expressed as the same two-box plus. Same reason as the
 * base: each band's square reached 1.41x its own radius on the diagonal the boresight runs down, so
 * the eye read as "inside the tower" out to 12.7 wu from the axis when the widest thing actually
 * there — a fin crest — stops at 9.
 */
export function cnShaftClipVolumes(
  bands: readonly CnCylinderHint[],
  at: { readonly x: number; readonly z: number },
): ClipAabb[] {
  const out: ClipAabb[] = [];
  for (const b of bands) {
    discPlus(at.x, at.z, b.radius, Math.max(0, b.centerY - b.halfHeight), b.centerY + b.halfHeight, out);
  }
  return out;
}

/**
 * A hero base cylinder (Rogers' ring base, and any future round hero) as a single AABB — the
 * pre-existing shape, factored out so the scene's clip-index effect reads as one list of
 * volume-producing calls rather than an inline map.
 */
export function heroCylinderClipVolume(
  hint: CnCylinderHint,
  at: { readonly x: number; readonly z: number },
): ClipAabb {
  return {
    minX: at.x - hint.radius,
    maxX: at.x + hint.radius,
    minY: Math.max(0, hint.centerY - hint.halfHeight),
    maxY: hint.centerY + hint.halfHeight,
    minZ: at.z - hint.radius,
    maxZ: at.z + hint.radius,
    fadeKey: null,
  };
}
