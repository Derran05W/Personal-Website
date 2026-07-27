// Phase 37 (T3) — turns worldEdge.ts's pure placement math into renderable/collidable geometry
// for the two dressing kinds that have no city-pack model (hoardingPanel, jerseyBarrier,
// railPost — see BARRIER.packModelIds' doc comment for why 'fencePiece'/'cone' are pack models
// instead). Two exports:
//
//   1. `buildBarrierDressingGeometry()` — ONE merged, vertex-coloured BufferGeometry for every
//      procedural piece (all boxes, world XZ + yaw already baked into the vertex positions), the
//      same "one draw call, unlit-literal, authored hex IS the on-screen colour" convention every
//      other Toronto surface (roadPaint.ts, groundTintBlackout.ts, namedBuildings.ts) uses.
//   2. `buildDeadEndColliders()` — the orchestrator's Phase 37 addendum: a collider PER dead-end
//      "road closed" row (19 of them), positioned at the actual surviving jersey-barrier row's
//      centroid rather than re-deriving the inset arithmetic a second time — worldEdge.ts's own
//      polygon-clearance filter can trim a flush-ribbon row's barriers asymmetrically (proven live:
//      Bloor/Sheppard's rows sit ~1 wu off the naive `dead.x/z + inward * rowInsetWu` estimate), so
//      reading the actual placements back is the only way collider and visuals are GUARANTEED to
//      agree. Without this, a car driving a dead-end street would visually clip through the row and
//      only stop ~7-8 wu later at the ring's own collider line (edgeInsetWu 6 vs the street's
//      EDGE_PAD_WU 14) — the exact immersion bug class this phase exists to kill.
//
// Both are pure (no three scene state beyond building/returning a disposable BufferGeometry).

import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { BARRIER, ROAD_CLASSES } from '../../config/torontoMap';
import { buildStreets } from './streets';
import { buildWorldEdge } from './worldEdge';

// --- colours (module-local, unlit-literal: the authored hex IS the on-screen colour) ----------
/** Hoarding panel body: a dark plywood/teal construction board. Phase 38 reel verdict: the
 * original '#22322f' was near-black at blue hour — the panel read ONLY via its orange stripe
 * (P37's flagged readability question). Doubled luminance, same teal family: the body now reads
 * as a wall tone against both the void and the NY dirt apron while staying nighttime-dark. */
const HOARDING_BODY_COLOR = '#446158';
/** Hoarding panel top stripe: hazard orange, reads as a construction-site band from a distance. */
const HOARDING_STRIPE_COLOR = '#e2680f';
/** Concrete jersey barrier. */
const JERSEY_COLOR = '#9195a0';
/** Rail-corridor fence post: dark steel. */
const RAIL_POST_COLOR = '#3a3f46';

/** Fraction of a hoarding panel's height given to the top hazard stripe (see file header —
 * split into two stacked boxes rather than per-face vertex colouring on one box, since the tri
 * cost is trivial either way and two boxes reuses the exact same `pushBox` path as every other
 * dressing kind here). */
const HOARDING_STRIPE_FRACTION = 0.2;

/** Base lift (wu) of every dressing box's bottom face above y=0 — one step of the SAME
 * GROUND_TINT_Y (0.008 wu) family TorontoScene.tsx's district-tint quad uses, so a box's floor
 * face never shares a coplanar Z with the tint quad underneath it (the ground-stack ladder itself
 * is formalised in Phase 39; this follows the existing convention rather than inventing a new
 * epsilon). Two steps (0.016) rather than one keeps clearance even where a box also overlaps the
 * base ground mesh at y=0. */
const BOX_BASE_LIFT_WU = 0.016;

interface Sink {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
}

// --- unit box template (built once, reused for every dressing piece) --------------------------
// A three.js BoxGeometry(1,1,1) already has correct outward-facing winding/normals on every one
// of its 6 faces; toNonIndexed() expands that to 36 flat (position, normal) pairs (6 faces x 2
// tris x 3 verts) with NO index buffer, matching this file's `Sink` shape (and roadPaint.ts's
// `quad()` convention) exactly. Scaling per-axis before rotating is safe for the normals too:
// every face normal of an axis-aligned box is a pure +-1 unit vector on one axis, so a NON-uniform
// scale never rotates it — only the yaw rotation (applied to positions AND normals identically)
// does that.
let unitBoxPositions: Float32Array | null = null;
let unitBoxNormals: Float32Array | null = null;
function unitBox(): { positions: Float32Array; normals: Float32Array } {
  if (!unitBoxPositions || !unitBoxNormals) {
    const geo = new BoxGeometry(1, 1, 1).toNonIndexed();
    unitBoxPositions = (geo.getAttribute('position').array as Float32Array).slice();
    unitBoxNormals = (geo.getAttribute('normal').array as Float32Array).slice();
    geo.dispose();
  }
  return { positions: unitBoxPositions, normals: unitBoxNormals };
}

/** Number of vertices one `pushBox` call appends — pinned for worldEdgeGeometry.test.ts's census
 * check (6 faces x 2 triangles x 3 vertices, non-indexed). */
export const BOX_VERTEX_COUNT = 36;

/**
 * One axis-aligned-then-yawed box, appended to `sink`. `lengthWu`/`thicknessWu` are FULL extents
 * (not half) along the piece's local +-X (along the edge) / +-Z (inward-outward) axes — see
 * worldEdge.ts's yaw convention header. `yBase`/`height` give the vertical span
 * `[yBase, yBase + height]`. World position: `(worldX, worldZ) = rotateY(yawRad) . (localX, localZ)
 * + (cx, cz)`, the same rotateY(yaw) three.js itself would apply to an Object3D — matches
 * worldEdge.ts's `yawFacing` convention exactly (local +Z -> the piece's inward vector).
 */
function pushBox(
  sink: Sink,
  hex: string,
  cx: number,
  cz: number,
  yBase: number,
  height: number,
  lengthWu: number,
  thicknessWu: number,
  yawRad: number,
): void {
  const { positions, normals } = unitBox();
  const c = new Color(hex);
  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  const yCenter = yBase + height / 2;
  for (let i = 0; i < positions.length; i += 3) {
    const lx = positions[i]! * lengthWu;
    const ly = positions[i + 1]! * height;
    const lz = positions[i + 2]! * thicknessWu;
    sink.positions.push(cx + lx * cosY + lz * sinY, yCenter + ly, cz - lx * sinY + lz * cosY);
    const nx = normals[i]!;
    const nz = normals[i + 2]!;
    sink.normals.push(nx * cosY + nz * sinY, normals[i + 1]!, -nx * sinY + nz * cosY);
    sink.colors.push(c.r, c.g, c.b);
  }
}

/**
 * The merged procedural dressing mesh: every `hoardingPanel` (as two stacked boxes — dark body +
 * hazard stripe), `jerseyBarrier`, and `railPost` placement from worldEdge.ts's dressing list.
 * `fencePiece`/`cone` are excluded on purpose — they render as pack models through
 * `CityPackBatched` (TorontoScene.tsx), not here.
 */
export function buildBarrierDressingGeometry(): BufferGeometry {
  const layout = buildWorldEdge();
  const sink: Sink = { positions: [], normals: [], colors: [] };

  for (const d of layout.dressing) {
    switch (d.kind) {
      case 'hoardingPanel': {
        const bodyH = BARRIER.hoarding.panelHeightWu * (1 - HOARDING_STRIPE_FRACTION);
        const stripeH = BARRIER.hoarding.panelHeightWu - bodyH;
        pushBox(
          sink,
          HOARDING_BODY_COLOR,
          d.x,
          d.z,
          BOX_BASE_LIFT_WU,
          bodyH,
          BARRIER.hoarding.panelWidthWu,
          BARRIER.hoarding.panelThicknessWu,
          d.yawRad,
        );
        pushBox(
          sink,
          HOARDING_STRIPE_COLOR,
          d.x,
          d.z,
          BOX_BASE_LIFT_WU + bodyH,
          stripeH,
          BARRIER.hoarding.panelWidthWu,
          BARRIER.hoarding.panelThicknessWu,
          d.yawRad,
        );
        break;
      }
      case 'jerseyBarrier':
        pushBox(
          sink,
          JERSEY_COLOR,
          d.x,
          d.z,
          BOX_BASE_LIFT_WU,
          BARRIER.jersey.heightWu,
          BARRIER.jersey.lengthWu,
          BARRIER.jersey.widthWu,
          d.yawRad,
        );
        break;
      case 'railPost':
        pushBox(
          sink,
          RAIL_POST_COLOR,
          d.x,
          d.z,
          BOX_BASE_LIFT_WU,
          BARRIER.rail.postHeightWu,
          BARRIER.rail.postWidthWu,
          BARRIER.rail.postWidthWu,
          d.yawRad,
        );
        break;
      case 'fencePiece':
      case 'cone':
        break; // pack models — CityPackBatched, not this merged mesh.
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(sink.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(sink.normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(sink.colors, 3));
  g.computeBoundingSphere();
  return g;
}

// --- dead-end colliders (orchestrator addendum) ------------------------------------------------

/** One dead-end "road closed" row's collider box, world XZ, axis-aligned (never rotated — every
 * land edge is axis-aligned, so every row is too; see worldEdge.ts's RawEdge comment). */
export interface DeadEndColliderBox {
  readonly streetId: string;
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hz: number;
}

/**
 * One solid collider per dead-end row (19 total — worldEdge.test.ts pins `layout.deadEnds` at
 * that length), positioned at the CENTROID of that row's actual surviving jersey-barrier
 * placements (not re-derived from `dead.x/z + inward * rowInsetWu` — the polygon-clearance filter
 * in worldEdge.ts's dead-end builder can trim a row asymmetrically on the two flush-ribbon streets
 * (Bloor/Sheppard), so reading the real placements back is the only way this can never drift out
 * of sync with what the player actually sees). Jerseys are disambiguated to THEIR OWN dead end by
 * the exact same proximity rule worldEdge.test.ts already pins (`< ROAD_CLASSES[street.cls]` of
 * `dead.x/z` — a street's two ends are always farther apart than one road width).
 *
 * Half-extents: `roadWidthWu / 2` across the road (the axis the polygon edge this row faces runs
 * along — `edge.runAxis`, exactly the same axis convention worldEdge.ts's own 11 ring colliders
 * use) and `BARRIER.jersey.widthWu / 2` deep (the row's thickness in the direction of travel).
 */
export function buildDeadEndColliders(): readonly DeadEndColliderBox[] {
  const layout = buildWorldEdge();
  const { streets } = buildStreets();
  const jerseys = layout.dressing.filter((d) => d.kind === 'jerseyBarrier');
  const boxes: DeadEndColliderBox[] = [];

  for (const dead of layout.deadEnds) {
    const street = streets.find((s) => s.id === dead.streetId);
    const edge = layout.edges.find((e) => e.index === dead.edgeIndex);
    if (!street || !edge) continue; // defensive only — both lookups always succeed today.
    const near = jerseys.filter(
      (j) => j.streetId === dead.streetId && Math.hypot(j.x - dead.x, j.z - dead.z) < ROAD_CLASSES[street.cls],
    );
    if (near.length === 0) continue; // defensive — worldEdge.test.ts pins barrierCount > 0 always.
    const cx = near.reduce((sum, j) => sum + j.x, 0) / near.length;
    const cz = near.reduce((sum, j) => sum + j.z, 0) / near.length;
    const acrossIsX = edge.runAxis === 'x';
    boxes.push({
      streetId: dead.streetId,
      cx,
      cz,
      hx: acrossIsX ? dead.roadWidthWu / 2 : BARRIER.jersey.widthWu / 2,
      hz: acrossIsX ? BARRIER.jersey.widthWu / 2 : dead.roadWidthWu / 2,
    });
  }
  return boxes;
}
