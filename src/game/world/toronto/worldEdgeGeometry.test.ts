import { describe, expect, it } from 'vitest';
import {
  BOX_VERTEX_COUNT,
  buildBarrierDressingGeometry,
  buildDeadEndColliders,
} from './worldEdgeGeometry';
import { buildWorldEdge } from './worldEdge';
import { PLAYABLE_POLYGON } from './polygon';
import { BARRIER, ROAD_CLASSES } from '../../config/torontoMap';
import { buildStreets } from './streets';

const layout = buildWorldEdge();

describe('worldEdgeGeometry — merged procedural dressing mesh', () => {
  it('is deterministic across independent builds (no rng, no hidden input)', () => {
    const a = buildBarrierDressingGeometry();
    const b = buildBarrierDressingGeometry();
    expect(a).not.toBe(b); // genuinely two builds, not a shared reference
    expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(b.getAttribute('position').array));
    expect(Array.from(a.getAttribute('normal').array)).toEqual(Array.from(b.getAttribute('normal').array));
    expect(Array.from(a.getAttribute('color').array)).toEqual(Array.from(b.getAttribute('color').array));
  });

  it('carries a vertex-colour attribute matching the position attribute 1:1 (unlit-literal convention)', () => {
    const g = buildBarrierDressingGeometry();
    const color = g.getAttribute('color');
    expect(color).toBeDefined();
    expect(color.count).toBe(g.getAttribute('position').count);
    expect(color.itemSize).toBe(3);
  });

  it('emits exactly one box per railPost/jerseyBarrier and TWO per hoardingPanel (body + stripe) — vertex count matches the Phase 37 placement census', () => {
    const countOf = (kind: string) => layout.dressing.filter((d) => d.kind === kind).length;
    const hoarding = countOf('hoardingPanel');
    const jersey = countOf('jerseyBarrier');
    const railPost = countOf('railPost');
    // These are the same numbers worldEdge.test.ts's "layer size" pin asserts (396/73/166) —
    // re-read here from the live layout rather than re-hardcoded, so a deliberate spacing edit
    // to either file still lines up automatically.
    expect({ hoarding, jersey, railPost }).toEqual({ hoarding: 396, jersey: 73, railPost: 166 });
    const expectedBoxes = hoarding * 2 + jersey + railPost;
    const g = buildBarrierDressingGeometry();
    expect(g.getAttribute('position').count).toBe(expectedBoxes * BOX_VERTEX_COUNT);
  });

  it('never emits geometry for fencePiece/cone (those render as pack models, not here)', () => {
    const fenceAndCone = layout.dressing.filter((d) => d.kind === 'fencePiece' || d.kind === 'cone').length;
    const everythingElse = layout.dressing.length - fenceAndCone;
    const hoarding = layout.dressing.filter((d) => d.kind === 'hoardingPanel').length;
    const jersey = layout.dressing.filter((d) => d.kind === 'jerseyBarrier').length;
    const railPost = layout.dressing.filter((d) => d.kind === 'railPost').length;
    expect(everythingElse).toBe(hoarding + jersey + railPost);
    const g = buildBarrierDressingGeometry();
    expect(g.getAttribute('position').count).toBe((hoarding * 2 + jersey + railPost) * BOX_VERTEX_COUNT);
  });

  it('keeps every box vertex within the playable polygon bounding box (world XZ = map XY identity swap)', () => {
    const xs = PLAYABLE_POLYGON.map((v) => v.x);
    const ys = PLAYABLE_POLYGON.map((v) => v.y);
    // Slack beyond the raw vertex bbox: the widest box half-extent in play is a hoarding panel's
    // half-width (BARRIER.hoarding.panelWidthWu / 2 = 2), so 3 wu of margin is generous.
    const SLACK = 3;
    const minX = Math.min(...xs) - SLACK;
    const maxX = Math.max(...xs) + SLACK;
    const minZ = Math.min(...ys) - SLACK;
    const maxZ = Math.max(...ys) + SLACK;
    const g = buildBarrierDressingGeometry();
    const pos = g.getAttribute('position').array;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!;
      const z = pos[i + 2]!;
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThanOrEqual(maxX);
      expect(z).toBeGreaterThanOrEqual(minZ);
      expect(z).toBeLessThanOrEqual(maxZ);
    }
  });

  it('lifts every box base clear of y=0 (the ground-stack epsilon convention, never sitting flush)', () => {
    const g = buildBarrierDressingGeometry();
    const pos = g.getAttribute('position').array;
    let minY = Infinity;
    for (let i = 1; i < pos.length; i += 3) minY = Math.min(minY, pos[i]!);
    expect(minY).toBeGreaterThan(0);
    expect(minY).toBeLessThan(0.05); // still a hair off the ground, not a visible gap
  });
});

describe('worldEdgeGeometry — dead-end colliders (orchestrator Phase 37 addendum)', () => {
  it('emits exactly one collider per dead-end row (19, matching layout.deadEnds)', () => {
    const boxes = buildDeadEndColliders();
    expect(boxes).toHaveLength(layout.deadEnds.length);
    expect(boxes).toHaveLength(19);
  });

  it('is deterministic across independent builds', () => {
    const a = buildDeadEndColliders();
    const b = buildDeadEndColliders();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("sits at the ACTUAL surviving jersey row's centroid, not a re-derived estimate, and stays within one road width of its own street's cut end (closes the phase-through gap: the ring's own collider line sits BARRIER.edgeInsetWu(6) in, ~7-8 wu further out than EDGE_PAD_WU(14)-deep dead-end streets stop)", () => {
    // `buildDeadEndColliders` iterates `layout.deadEnds` in order and pushes exactly one box per
    // entry (the two early `continue`s are defensive-only — proven unreachable on the live layout
    // by worldEdge.test.ts's own barrierCount > 0 / edge-lookup invariants), so the two arrays are
    // index-aligned 1:1. Zipping by index is exact; fuzzy-matching by distance is not needed and
    // would be ambiguous for streets whose two dead ends could ever fall within one road width of
    // each other.
    const { streets } = buildStreets();
    const jerseys = layout.dressing.filter((d) => d.kind === 'jerseyBarrier');
    const boxes = buildDeadEndColliders();
    expect(boxes).toHaveLength(layout.deadEnds.length);
    layout.deadEnds.forEach((dead, i) => {
      const box = boxes[i]!;
      expect(box.streetId).toBe(dead.streetId);
      const street = streets.find((s) => s.id === dead.streetId)!;
      const near = jerseys.filter(
        (j) => j.streetId === dead.streetId && Math.hypot(j.x - dead.x, j.z - dead.z) < ROAD_CLASSES[street.cls],
      );
      expect(near.length).toBeGreaterThan(0);
      const cx = near.reduce((sum, j) => sum + j.x, 0) / near.length;
      const cz = near.reduce((sum, j) => sum + j.z, 0) / near.length;
      expect(box.cx).toBeCloseTo(cx, 9);
      expect(box.cz).toBeCloseTo(cz, 9);
      // Genuinely AT the row (within one road width of the street's cut end), never out at the
      // distant ring line.
      expect(Math.hypot(box.cx - dead.x, box.cz - dead.z)).toBeLessThan(ROAD_CLASSES[street.cls]);
    });
  });

  it('orients across the road: half-extents follow the faced edge axis, matching the road width', () => {
    const boxes = buildDeadEndColliders();
    layout.deadEnds.forEach((dead, i) => {
      const box = boxes[i]!;
      const edge = layout.edges.find((e) => e.index === dead.edgeIndex)!;
      if (edge.runAxis === 'x') {
        expect(box.hx).toBeCloseTo(dead.roadWidthWu / 2, 6);
        expect(box.hz).toBeCloseTo(BARRIER.jersey.widthWu / 2, 6);
      } else {
        expect(box.hz).toBeCloseTo(dead.roadWidthWu / 2, 6);
        expect(box.hx).toBeCloseTo(BARRIER.jersey.widthWu / 2, 6);
      }
    });
  });
});
