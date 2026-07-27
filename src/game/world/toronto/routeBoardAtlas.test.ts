// Phase 31 (Part-8 D3, T1) — routeBoardAtlas.ts tests. jsdom has no real 2d canvas context (same
// caveat logoAtlas.ts/VenueDressLayer's atlas builders document), so this only asserts the
// structural contract (row assignment, geometry UV remap) — not rendered pixel content.
import { describe, expect, it } from 'vitest';
import { NearestFilter, NearestMipmapLinearFilter } from 'three';
import { buildRouteBoardAtlas, buildRouteBoardGeometry } from './routeBoardAtlas';

describe('buildRouteBoardAtlas', () => {
  it('assigns one row per DISTINCT route id, in order of first appearance', () => {
    const atlas = buildRouteBoardAtlas([
      { id: '97', label: '97 YONGE' },
      { id: '501', label: '501 QUEEN' },
      { id: '97', label: '97 YONGE' }, // repeat — same row, no new one
      { id: '504', label: '504 KING' },
    ]);
    expect(atlas.rowCount).toBe(3);
    expect(atlas.rowIndex.get('97')).toBe(0);
    expect(atlas.rowIndex.get('501')).toBe(1);
    expect(atlas.rowIndex.get('504')).toBe(2);
  });

  it('never throws with an empty entry list (rowCount floors at 1)', () => {
    expect(() => buildRouteBoardAtlas([])).not.toThrow();
    expect(buildRouteBoardAtlas([]).rowCount).toBe(1);
  });

  // Phase 41 (surface & shimmer pass): this atlas is THE one mipped homage texture
  // (config/surfaces.ts's ATLAS_POLICY.routeBoards) — measured ~5× minified at play distance on a
  // moving vehicle, where Nearest/no-mips strobed. The homage rule is preserved by the MAG filter
  // staying Nearest (near look untouched); only minification changed.
  it('keeps NEAREST magnification (the pixel-art convention) but mips for minification', () => {
    const atlas = buildRouteBoardAtlas([{ id: '97', label: '97 YONGE' }]);
    expect(atlas.texture.magFilter).toBe(NearestFilter);
    expect(atlas.texture.minFilter).toBe(NearestMipmapLinearFilter);
    expect(atlas.texture.generateMipmaps).toBe(true);
  });
});

describe('buildRouteBoardGeometry', () => {
  it('remaps every UV.y to exactly [row/rowCount, (row+1)/rowCount] range boundaries', () => {
    const rowCount = 4;
    for (let row = 0; row < rowCount; row++) {
      const g = buildRouteBoardGeometry(row, rowCount);
      const uv = g.getAttribute('uv');
      const v0 = 1 - (row + 1) / rowCount;
      const v1 = 1 - row / rowCount;
      const values = new Set<number>();
      for (let i = 0; i < uv.count; i++) values.add(Math.round(uv.getY(i) * 1e6) / 1e6);
      expect(values.size).toBeLessThanOrEqual(2);
      for (const v of values) {
        expect(v === Math.round(v0 * 1e6) / 1e6 || v === Math.round(v1 * 1e6) / 1e6).toBe(true);
      }
    }
  });

  it('keeps the plane at the configured board width/depth, rotated flat (Y extent ~0 — normal +Y)', () => {
    const g = buildRouteBoardGeometry(0, 1);
    g.computeBoundingBox();
    const box = g.boundingBox!;
    // Rotated -90deg about X (live-verification fix): the plane now lies flat in XZ (its
    // original height axis becomes the Z extent), normal +Y, so it always reads face-on to the
    // fixed camera regardless of a vehicle's own heading (see the geometry builder's doc
    // comment).
    expect(box.max.x - box.min.x).toBeCloseTo(2.2, 6); // ROUTE_BOARD.widthWu
    expect(box.max.z - box.min.z).toBeCloseTo(0.9, 6); // ROUTE_BOARD.heightWu (now the Z extent)
    expect(box.max.y - box.min.y).toBeCloseTo(0, 6); // flattened — no longer a Y extent
  });
});
