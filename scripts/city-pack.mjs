#!/usr/bin/env node
// Phase 25.5 Task 1 — city-pack asset pipeline (plan: .planning/phases/phase-25.5-plan.md,
// decisions D1-D4/D9/D11-D12). Two jobs, one script, run via `pnpm assets:pack`:
//
//   1. NORMALIZE: copy the 52 non-character GLBs out of the untracked source folder
//      ("City Pack.undefined-glb/", the user's raw download) into assets/city-pack/ under
//      kebab-case ids (D1: committed, byte-identical originals — survives if the source
//      folder ever vanishes). 5 skinned/animated character models + the zip are excluded
//      (D2 — locked "Pedestrians: none").
//   2. OPTIMIZE: run every normalized GLB through the D3 gltf-transform pipeline (dedup ->
//      flatten -> prune -> palette -> join -> weld -> quantize -> meshopt -> textureCompress)
//      and emit the runtime files to public/assets/city-pack/ (D5: public/-served, not
//      bundled) plus a generated manifest (D11) at src/game/assets/cityPackManifest.json
//      consumed by the hand-written src/game/assets/cityPackManifest.ts accessor.
//
// NOT part of `pnpm build` (D12): outputs are committed, so Vercel/CI never needs this
// toolchain. Re-run any time the source pack changes: `pnpm assets:pack`.
//
// Idempotency: every run reads fresh from assets/city-pack/ and fully regenerates
// public/assets/city-pack/ + the manifest — there is no incremental/cached state, so two
// consecutive runs over an unchanged source are expected to produce identical output
// (verified manually per the plan's "Verify idempotency" done-when; if gltf-transform ever
// turns out not to be byte-stable across runs, the manifest's contentHash regenerates WITH
// the files every time, so the drift guard in cityPackManifest.test.ts stays sound either way).

import { NodeIO, Primitive, Logger, Verbosity } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  flatten,
  prune,
  palette,
  join,
  weld,
  quantize,
  meshopt,
  textureCompress,
  getBounds,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENAME_MAP, kebabCase, idForFile, categoryFor, EXCLUDE_BASENAMES } from './lib/cityPackNaming.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_DIR = path.join(root, 'City Pack.undefined-glb');
const NORMALIZED_DIR = path.join(root, 'assets/city-pack');
const OPTIMIZED_DIR = path.join(root, 'public/assets/city-pack');
const MANIFEST_PATH = path.join(root, 'src/game/assets/cityPackManifest.json');

// Re-exported so anything importing THIS module (there shouldn't be — see
// scripts/lib/cityPackNaming.mjs's header) still sees the same names as before the split.
export { RENAME_MAP, kebabCase, idForFile, categoryFor };

function formatKB(bytes) {
  return (bytes / 1024).toFixed(1);
}

/** Sum of drawable triangles + primitive/material counts across every Mesh in the document
 * (post-transform state — called after the full D3 pipeline runs). Only TRIANGLES-mode
 * primitives count toward `tris` (the pack has no lines/points, but this stays correct if
 * one ever shows up). */
function measureGeometry(document) {
  let tris = 0;
  let prims = 0;
  const materials = new Set();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      prims += 1;
      const material = prim.getMaterial();
      if (material) materials.add(material);
      if (prim.getMode() === Primitive.Mode.TRIANGLES) {
        const indices = prim.getIndices();
        const position = prim.getAttribute('POSITION');
        const vertCount = indices ? indices.getCount() : position ? position.getCount() : 0;
        tris += Math.floor(vertCount / 3);
      }
    }
  }
  return { tris, prims, materialCount: materials.size };
}

/** See the call site in optimizeOne() for the full rationale. No-op unless the document
 * actually mixes alphaModes (BLEND/MASK alongside OPAQUE). */
function harmonizeAlphaForPalette(document) {
  const materials = document.getRoot().listMaterials();
  const hasBlend = materials.some((m) => m.getAlphaMode() === 'BLEND');
  const hasMask = materials.some((m) => m.getAlphaMode() === 'MASK');
  if (!hasBlend && !hasMask) return;
  const targetMode = hasBlend ? 'BLEND' : 'MASK';
  const doubleSided = materials.some((m) => m.getDoubleSided());
  for (const material of materials) {
    material.setAlphaMode(targetMode);
    material.setDoubleSided(doubleSided);
  }
}

function makeIO() {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    })
    .setLogger(new Logger(Verbosity.WARN));
}

/** Runs the full D3 pipeline on one GLB. Returns the measured before/after report row; throws
 * on a hard pipeline failure (caller catches per-file so one bad model doesn't kill the run). */
async function optimizeOne(id, inputPath, outputPath) {
  const io = makeIO();
  const document = await io.read(inputPath);

  // Native bounding box, measured on the PRISTINE read — before any transform touches
  // geometry — so it reflects the model's true native scale (D9 consumes this).
  const scenes = document.getRoot().listScenes();
  const bounds = scenes.length > 0 ? getBounds(scenes[0]) : { min: [0, 0, 0], max: [0, 0, 0] };
  const nativeDims = {
    w: bounds.max[0] - bounds.min[0],
    h: bounds.max[1] - bounds.min[1],
    d: bounds.max[2] - bounds.min[2],
  };

  await document.transform(dedup(), flatten(), prune());

  // palette()/join() rightly refuse to fold materials with different alphaMode/doubleSided
  // into one primitive (that's a real render-state difference, not just a color difference) —
  // discovered on 'greenhouse', whose opaque frame + translucent BLEND glass-roof material
  // otherwise survive palette+join as 2 prims/2 materials. A fully-opaque BLEND material
  // (alpha=1) renders identically to OPAQUE for this pack's simple convex low-poly geometry, so
  // harmonizing every material in a MIXED-mode document onto the least-restrictive common
  // alphaMode/doubleSided before palette() lets the merge proceed losslessly for the (one)
  // affected model. Single-mode documents (the other 51 files, all plain OPAQUE) hit the early
  // return and are completely untouched.
  harmonizeAlphaForPalette(document);

  await document.transform(
    palette({ min: 2 }),
    join(),
    weld(),
    quantize(),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
  );

  const geometry = measureGeometry(document);
  const hasTexture = document.getRoot().listTextures().length > 0;

  await io.write(outputPath, document);
  const optimizedBytes = (await stat(outputPath)).size;
  const contentHash = createHash('sha256').update(await readFile(outputPath)).digest('hex');

  return { id, nativeDims, ...geometry, hasTexture, optimizedBytes, contentHash };
}

async function main() {
  if (!existsSync(SOURCE_DIR)) {
    console.error(`FAIL: source folder not found: ${path.relative(root, SOURCE_DIR)}`);
    console.error('This script expects the raw City Pack download to sit at the repo root.');
    process.exitCode = 1;
    return;
  }

  await mkdir(NORMALIZED_DIR, { recursive: true });
  await mkdir(OPTIMIZED_DIR, { recursive: true });

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  const allBasenames = (await readdir(SOURCE_DIR)).filter((f) => f.toLowerCase().endsWith('.glb'));
  const included = allBasenames.filter((f) => !EXCLUDE_BASENAMES.has(f));
  const excludedFound = allBasenames.filter((f) => EXCLUDE_BASENAMES.has(f));

  console.log(
    `Source: ${allBasenames.length} GLBs (${included.length} runtime, ${excludedFound.length} excluded — characters/Pedestrians:none)`,
  );

  const rows = [];
  const failures = [];
  const assertionFailures = [];
  let totalRaw = 0;
  let totalOptimized = 0;

  for (const basename of included.sort()) {
    const id = idForFile(basename);
    const sourcePath = path.join(SOURCE_DIR, basename);
    const normalizedPath = path.join(NORMALIZED_DIR, `${id}.glb`);
    const optimizedPath = path.join(OPTIMIZED_DIR, `${id}.glb`);

    try {
      // 1. Normalize: byte-identical copy under the kebab-case id (D1 — the archival copy).
      await copyFile(sourcePath, normalizedPath);
      const rawBytes = (await stat(normalizedPath)).size;
      totalRaw += rawBytes;

      // 2. Optimize: pipeline reads the NORMALIZED copy (never the raw source), writes the
      // runtime GLB to public/assets/city-pack/.
      const measured = await optimizeOne(id, normalizedPath, optimizedPath);
      totalOptimized += measured.optimizedBytes;

      const category = categoryFor(id);
      if ((category === 'building' || category === 'building-blank') && (measured.prims !== 1 || measured.materialCount !== 1)) {
        assertionFailures.push(
          `${id}: expected 1 prim/1 material (building), got ${measured.prims} prim(s)/${measured.materialCount} material(s)`,
        );
      }

      rows.push({
        id,
        category,
        rawBytes,
        ...measured,
      });
    } catch (err) {
      failures.push({ id, basename, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Report table -------------------------------------------------------------------------
  console.log('');
  console.log('id                     category         raw KB  ->  opt KB   prims  mats  tris   tex');
  console.log('-'.repeat(96));
  for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(
      `${row.id.padEnd(23)}${row.category.padEnd(17)}${formatKB(row.rawBytes).padStart(7)}  -> ${formatKB(row.optimizedBytes).padStart(7)}  ${String(row.prims).padStart(5)}  ${String(row.materialCount).padStart(4)}  ${String(row.tris).padStart(5)}  ${row.hasTexture ? 'yes' : '-'}`,
    );
  }
  console.log('-'.repeat(96));
  console.log(
    `TOTAL: ${rows.length} files, raw ${formatKB(totalRaw)} KB (${(totalRaw / 1024 / 1024).toFixed(2)} MB) -> optimized ${formatKB(totalOptimized)} KB (${(totalOptimized / 1024 / 1024).toFixed(2)} MB)`,
  );

  if (failures.length > 0) {
    console.log('');
    console.log(`PIPELINE FAILURES (${failures.length}):`);
    for (const f of failures) {
      console.log(`  FAIL ${f.id} (${f.basename}): ${f.error}`);
    }
  }

  if (assertionFailures.length > 0) {
    console.log('');
    console.log(`BUILDING 1-PRIM/1-MATERIAL ASSERTION FAILURES (${assertionFailures.length}):`);
    for (const msg of assertionFailures) {
      console.log(`  FAIL ${msg}`);
    }
  }

  // Manifest -------------------------------------------------------------------------------
  const manifestEntries = rows
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) => ({
      id: row.id,
      url: `/assets/city-pack/${row.id}.glb`,
      category: row.category,
      nativeDims: row.nativeDims,
      tris: row.tris,
      prims: row.prims,
      bytes: { raw: row.rawBytes, optimized: row.optimizedBytes },
      hasTexture: row.hasTexture,
      contentHash: row.contentHash,
    }));

  await mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifestEntries, null, 2) + '\n', 'utf-8');
  console.log('');
  console.log(`OK: wrote ${path.relative(root, MANIFEST_PATH)} (${manifestEntries.length} entries)`);

  if (failures.length > 0 || assertionFailures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
