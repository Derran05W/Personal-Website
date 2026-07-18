// Phase 25.7 Task 3 (D3/D4/D6/D11) — the pure venue-dressing builder: resolved frontage venue
// claims (world/toronto/frontage.ts ResolvedVenueClaim) -> every fascia band / awning / dressing
// prop / queue / plaque placement, in WORLD space. Pure TS (no three / react, no randomness): the
// same claims -> deep-equal output. world/toronto/cityPack/VenueDressLayer.tsx (Task 4) consumes
// this and bakes the band atlas / awning + prop meshes; the jsdom-unsafe canvas/geometry work stays
// out of here, the same pure↔scene split as placesLayer.ts ↔ PlacesLayer.
//
// EVERYTHING is derived from the claim alone (D2: "no street re-derivation"). A claim carries its
// facade footprint centre (`position`), post-yaw half-extents (`hx/hy/hz`), `rotationY`, and the
// cardinal its front points (`facing`); from those this module builds a local facade frame — an
// outward unit vector (toward the street the player drives past) + an along-facade tangent ("right"
// when looking outward) — and resolves every kit-authored facade-relative offset
// (config/venueDressing.ts) to a world position. The §5.3 camera only sees south/east faces, so
// D4's fascia rule bands the street face AND, for a west/north-fronting venue, its camera-visible
// side flank (painted side-wall signage).

import {
  AWNING,
  AWNING_WIDTH_FRACTION,
  DRESSING_KITS,
  FASCIA_METRICS,
  FASCIA_WIDTH_MODE_EXTRA_INSET_WU,
  FINE_DINING_PLAQUE,
  VENUE_QUEUE,
  facadeSizeClassFor,
  type DressingPropOffset,
  type PropMount,
} from '../../config/venueDressing';
import type { FacadeFacing, ResolvedVenueClaim } from './frontage';
import type { LogoBrand } from './logoAtlas';

/** Shared near-black band backing (the "lit sign against the unlit dusk slice" read, logoAtlas.ts
 * BACKING_PLATE / TorontoScene makeBandAtlas). Karaoke overrides it (magenta) via the kit. */
const DEFAULT_BAND_BACKING = '#0a0d12';

/** How far a fascia band / plaque sits proud of the wall so it never z-fights (placesLayer.ts's
 * FACE_OFFSET). */
const FACE_OFFSET = 0.06;

/** Facade-fit clamp: a street/flank prop's along offset is clamped so it stays this far inside the
 * facade's own edge — keeps props on the building's clean frontage instead of hanging off a corner
 * (kit offsets are authored for the 13.5 wu family width; a narrow pizza-corner at a tight
 * intersection would otherwise push an edge prop past the wall into the crossing — the McDonald's @
 * Queen×Spadina flower-pot case). Purely structural (not an art dial): a prop within this of the
 * wall edge would read as half-detached regardless. */
const PROP_EDGE_MARGIN_WU = 1.5;

function clampAlong(alongWu: number, half: number): number {
  const limit = Math.max(0, half - PROP_EDGE_MARGIN_WU);
  return Math.max(-limit, Math.min(limit, alongWu));
}

// --- output shapes ---------------------------------------------------------------------------

/** A row of the venue band atlas (one per venue that has a fascia band). VenueDressLayer bakes one
 * atlas row per entry (logo cell + wordmark on `backingColor`); a venue's ≤2 bands share its row. */
export interface VenueBandRow {
  readonly venueId: string;
  readonly bandRow: number;
  readonly brand: LogoBrand;
  readonly name: string;
  readonly backingColor: string;
}

/** One FASCIA band quad on a camera-visible face (D4). Same world-quad convention as the P26
 * FasciaBand: `face` picks the plane orientation, the band spans [cy-h/2, cy+h/2]. */
export interface VenueFasciaBand {
  readonly venueId: string;
  readonly bandRow: number;
  /** 'street' = the fronted face (may be off-camera for W/N venues); 'side' = the S/E flank. */
  readonly kind: 'street' | 'side';
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly rotationY: number;
  readonly width: number;
  readonly height: number;
}

/** A procedural awning (D6): resolved anchor + facade basis + dims; VenueDressLayer expands it into
 * the merged canopy/valance/side-triangle geometry (one mesh map-wide). `alongVec`/`outVec` are
 * world-XZ unit vectors; the awning spans ±halfWidth along `alongVec`, projects `canopyDepth` out
 * along `outVec`, its outer edge at `bottomY`, valance dropping `drop` below it, canopy sloping up
 * to the wall by `rise`. Colour is the saturated brand accent. */
export interface VenueAwning {
  readonly venueId: string;
  readonly color: string;
  /** World point at the facade wall, centre of the awning's wall attach line. */
  readonly anchorX: number;
  readonly anchorZ: number;
  readonly alongX: number;
  readonly alongZ: number;
  readonly outX: number;
  readonly outZ: number;
  readonly halfWidth: number;
  readonly canopyDepth: number;
  readonly drop: number;
  readonly bottomY: number;
  readonly rise: number;
}

/** A resolved dressing prop instance (kit-driven). VenueDressLayer groups by modelId → one
 * CityPackBatched per type. Position is the model footprint centre; its floor grounds at `y`. */
export interface VenuePropPlacement {
  readonly venueId: string;
  readonly modelId: string;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
}

/** A cosmetic queue lineup (Uncle Tetsu / Konjiki-Elm), re-anchored to the claimed facade line
 * (D11). Posts + person-blobs, NO colliders (locked "Pedestrians: none"). */
export interface VenueQueue {
  readonly venueId: string;
  readonly posts: readonly { readonly x: number; readonly z: number }[];
  readonly blobs: readonly { readonly x: number; readonly z: number }[];
}

/** Alo's deliberately-tiny plaque decal (D7) — a logo-atlas quad on the street face, no band. */
export interface VenuePlaque {
  readonly venueId: string;
  readonly brand: LogoBrand;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly size: number;
}

export interface VenueDress {
  readonly bandRows: readonly VenueBandRow[];
  readonly bands: readonly VenueFasciaBand[];
  readonly awnings: readonly VenueAwning[];
  readonly props: readonly VenuePropPlacement[];
  readonly queues: readonly VenueQueue[];
  readonly plaques: readonly VenuePlaque[];
}

// --- facade frame ----------------------------------------------------------------------------

/** Outward unit vector (world XZ) the front face points, per the claim's `facing`. */
const OUT_VEC: Readonly<Record<FacadeFacing, readonly [number, number]>> = {
  south: [0, 1],
  north: [0, -1],
  east: [1, 0],
  west: [-1, 0],
};

interface FacadeFrame {
  /** Front-face outward unit vector (toward the street). */
  readonly outX: number;
  readonly outZ: number;
  /** Along-facade unit tangent — the facade's "right" when looking outward. */
  readonly alongX: number;
  readonly alongZ: number;
  /** Half the facade width (along the street). */
  readonly alongHalf: number;
  /** Half the facade depth (perpendicular, out). */
  readonly outHalf: number;
  /** World XZ centre of the street-facing wall plane (footprint centre + out*outHalf). */
  readonly frontX: number;
  readonly frontZ: number;
  /** The camera-visible S/E flank: its outward normal + the wall-plane centre + its half-width
   * (the facade DEPTH runs along this flank). */
  readonly flankNX: number;
  readonly flankNZ: number;
  readonly flankX: number;
  readonly flankZ: number;
  readonly flankHalf: number;
}

/** local +Z → world direction (sinθ, cosθ); the yaw so local +Z points along an axis-aligned
 * world XZ vector. */
function yawForOut(x: number, z: number): number {
  return Math.atan2(x, z);
}

function facadeFrame(claim: ResolvedVenueClaim): FacadeFrame {
  const [outX, outZ] = OUT_VEC[claim.facing];
  // "right when facing out" = out rotated +90° CCW about Y: (x,z) → (−z, x).
  const alongX = -outZ;
  const alongZ = outX;
  const [cx, , cz] = claim.position;
  // Axis-aligned selectors: |vec.x|*hx + |vec.z|*hz picks hx for an X axis, hz for a Z axis.
  const outHalf = Math.abs(outX) * claim.hx + Math.abs(outZ) * claim.hz;
  const alongHalf = Math.abs(alongX) * claim.hx + Math.abs(alongZ) * claim.hz;
  // The camera-visible flank normal: whichever of ±along points toward +X/+Z (the §5.3 camera).
  const flankNX = alongX + alongZ >= 0 ? alongX : -alongX;
  const flankNZ = alongX + alongZ >= 0 ? alongZ : -alongZ;
  const flankHalf = Math.abs(flankNX) * claim.hx + Math.abs(flankNZ) * claim.hz;
  return {
    outX,
    outZ,
    alongX,
    alongZ,
    alongHalf,
    outHalf,
    frontX: cx + outX * outHalf,
    frontZ: cz + outZ * outHalf,
    flankNX,
    flankNZ,
    flankX: cx + flankNX * flankHalf,
    flankZ: cz + flankNZ * flankHalf,
    flankHalf,
  };
}

// --- prop resolution -------------------------------------------------------------------------

/** Resolve one facade-relative prop offset to a world position + yaw. `street` mounts on the
 * fronted wall (offset along/out from its centre); `flank` mounts on the camera-visible side wall
 * (D4). The caller stamps the modelId. */
function resolveProp(
  claim: ResolvedVenueClaim,
  frame: FacadeFrame,
  offset: DressingPropOffset,
  mount: PropMount,
  yaw: number,
): { position: readonly [number, number, number]; rotationY: number } {
  if (mount === 'street') {
    // out-from-wall = frontCentre + out*outWu; along-shift = along*alongWu (clamped to the facade).
    const along = clampAlong(offset.alongWu, frame.alongHalf);
    return {
      position: [
        frame.frontX + frame.outX * offset.outWu + frame.alongX * along,
        offset.upWu,
        frame.frontZ + frame.outZ * offset.outWu + frame.alongZ * along,
      ],
      rotationY: claim.rotationY + yaw,
    };
  }
  // Flank: normal = flank wall normal; the flank's horizontal tangent is the facade OUT axis
  // (so the flank's along-extent is the facade depth, outHalf).
  const along = clampAlong(offset.alongWu, frame.outHalf);
  return {
    position: [
      frame.flankX + frame.flankNX * offset.outWu + frame.outX * along,
      offset.upWu,
      frame.flankZ + frame.flankNZ * offset.outWu + frame.outZ * along,
    ],
    rotationY: yawForOut(frame.flankNX, frame.flankNZ) + yaw,
  };
}

// --- the builder -----------------------------------------------------------------------------

/**
 * D3/D4/D6/D11: build every dressing placement for the resolved venue claims. Pure + deterministic.
 * Fascia bands: street face always (present kits), plus a camera-visible S/E side band for a
 * west/north-fronting venue. Awnings: per kit (skipped where `awning` is null). Props: kit-driven,
 * facade-relative → world. Queues: only queue-flagged claims. Plaque: fine-dining only.
 */
export function buildVenueDress(claims: readonly ResolvedVenueClaim[]): VenueDress {
  const bandRows: VenueBandRow[] = [];
  const bands: VenueFasciaBand[] = [];
  const awnings: VenueAwning[] = [];
  const props: VenuePropPlacement[] = [];
  const queues: VenueQueue[] = [];
  const plaques: VenuePlaque[] = [];
  let nextBandRow = 0;

  for (const claim of claims) {
    const kit = DRESSING_KITS[claim.kitId];
    const frame = facadeFrame(claim);

    // --- FASCIA (D4/D10) ---------------------------------------------------------------------
    if (kit.fascia.present) {
      const metrics = FASCIA_METRICS[facadeSizeClassFor(claim.modelId)];
      const cy = (metrics.bandBottomWu + metrics.bandTopWu) / 2;
      const height = metrics.bandTopWu - metrics.bandBottomWu;
      const inset = metrics.insetWu + FASCIA_WIDTH_MODE_EXTRA_INSET_WU[kit.fascia.widthMode];
      const backingColor = kit.fascia.backingColorOverride ?? DEFAULT_BAND_BACKING;
      const bandRow = nextBandRow++;
      bandRows.push({ venueId: claim.venueId, bandRow, brand: claim.brand, name: claim.name, backingColor });

      // Street face — always (the drive-past sign). Sits proud of the wall by FACE_OFFSET.
      bands.push({
        venueId: claim.venueId,
        bandRow,
        kind: 'street',
        cx: frame.frontX + frame.outX * FACE_OFFSET,
        cy,
        cz: frame.frontZ + frame.outZ * FACE_OFFSET,
        rotationY: claim.rotationY,
        width: Math.max(1, 2 * frame.alongHalf - 2 * inset),
        height,
      });

      // Camera-visible side band for a west/north-fronting venue (its street face is off-camera).
      if (claim.facing === 'west' || claim.facing === 'north') {
        bands.push({
          venueId: claim.venueId,
          bandRow,
          kind: 'side',
          cx: frame.flankX + frame.flankNX * FACE_OFFSET,
          cy,
          cz: frame.flankZ + frame.flankNZ * FACE_OFFSET,
          rotationY: yawForOut(frame.flankNX, frame.flankNZ),
          // The side band runs along the facade DEPTH (2*outHalf), inset the same amount.
          width: Math.max(1, 2 * frame.outHalf - 2 * inset),
          height,
        });
      }
    }

    // --- AWNING (D6) -------------------------------------------------------------------------
    if (kit.awning) {
      const halfWidth = frame.alongHalf * AWNING_WIDTH_FRACTION[kit.awning.widthMode];
      awnings.push({
        venueId: claim.venueId,
        color: claim.accentColor,
        anchorX: frame.frontX,
        anchorZ: frame.frontZ,
        alongX: frame.alongX,
        alongZ: frame.alongZ,
        outX: frame.outX,
        outZ: frame.outZ,
        halfWidth,
        canopyDepth: AWNING.canopyDepthWu,
        drop: AWNING.dropWu,
        bottomY: AWNING.bottomYWu,
        rise: 0.6, // canopy slopes up to the wall by this much (reads as a real awning pitch)
      });
    }

    // --- DRESSING PROPS ----------------------------------------------------------------------
    for (const spec of kit.props) {
      for (const offset of spec.offsets) {
        const { position, rotationY } = resolveProp(claim, frame, offset, spec.mount, spec.yaw);
        props.push({ venueId: claim.venueId, modelId: spec.modelId, position, rotationY });
      }
    }

    // --- QUEUE (D11) -------------------------------------------------------------------------
    if (claim.queue) queues.push(buildQueue(claim, frame));

    // --- PLAQUE (D7, fine-dining) ------------------------------------------------------------
    if (kit.plaque) {
      plaques.push({
        venueId: claim.venueId,
        brand: claim.brand,
        position: [
          frame.frontX + frame.outX * (FINE_DINING_PLAQUE.outWu + FACE_OFFSET),
          FINE_DINING_PLAQUE.upWu,
          frame.frontZ + frame.outZ * (FINE_DINING_PLAQUE.outWu + FACE_OFFSET),
        ],
        rotationY: claim.rotationY,
        size: FINE_DINING_PLAQUE.sizeWu,
      });
    }
  }

  return { bandRows, bands, awnings, props, queues, plaques };
}

/** A staggered double-file lineup along the claimed facade's street-facing edge, `frontOffsetWu`
 * off it (inside the sidewalk band) — the P26 queue re-anchored to the claim's front plane (D11). */
function buildQueue(claim: ResolvedVenueClaim, frame: FacadeFrame): VenueQueue {
  const { blobCount, spacingWu, staggerWu, frontOffsetWu, postExtraWu } = VENUE_QUEUE;
  // Line base: the facade front edge pushed out onto the sidewalk by frontOffsetWu.
  const baseX = frame.frontX + frame.outX * frontOffsetWu;
  const baseZ = frame.frontZ + frame.outZ * frontOffsetWu;
  const blobs: { x: number; z: number }[] = [];
  for (let i = 0; i < blobCount; i++) {
    const alongT = (i - (blobCount - 1) / 2) * spacingWu;
    const outT = i % 2 === 0 ? 0 : staggerWu; // every other blob steps out onto the sidewalk
    blobs.push({
      x: baseX + frame.alongX * alongT + frame.outX * outT,
      z: baseZ + frame.alongZ * alongT + frame.outZ * outT,
    });
  }
  const endT = (blobCount / 2) * spacingWu + postExtraWu;
  const posts = [
    { x: baseX + frame.alongX * -endT, z: baseZ + frame.alongZ * -endT },
    { x: baseX + frame.alongX * endT, z: baseZ + frame.alongZ * endT },
  ];
  return { venueId: claim.venueId, posts, blobs };
}
