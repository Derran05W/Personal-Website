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
//
// Phase 25.6 Task 2 (D15) — SIMPLIFY stage: the 25.5 tri-budget arithmetic showed even a
// per-instance-culled pack blows the desktop-med budget on ornate models (buildings especially
// — see phase-25.6-plan.md's "tri-budget arithmetic"). A `simplify()` pass now runs BEFORE
// quantize/meshopt (simplifying post-quantized/meshopt-reordered index buffers would fight the
// GPU-cache-friendly reorder meshopt() just did), driven by ./city-pack-budgets.json's per-id
// triangle caps — the SAME json a vitest test (cityPackBudgets.test.ts) asserts the shipped
// manifest never drifts back over. Ids absent from the budgets file, or in its `optOut` list,
// pass through unchanged (either already small, or a documented silhouette-break exception).

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
  simplify,
  textureCompress,
  getBounds,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENAME_MAP, kebabCase, idForFile, categoryFor, EXCLUDE_BASENAMES } from './lib/cityPackNaming.mjs';
import { CIVILIAN_VEHICLE_IDS, neutralBodyId, applyNeutralBody } from './lib/cityPackNeutralBody.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_DIR = path.join(root, 'City Pack.undefined-glb');
const NORMALIZED_DIR = path.join(root, 'assets/city-pack');
const OPTIMIZED_DIR = path.join(root, 'public/assets/city-pack');
const MANIFEST_PATH = path.join(root, 'src/game/assets/cityPackManifest.json');
const BUDGETS_PATH = path.join(root, 'scripts/city-pack-budgets.json');

/** Simplify tuning (D15). The plan's single `error: 0.008` is the first (tightest) rung here;
 * kept as a schedule rather than one value as a safety margin now that
 * stripNormalsForUnlitPipeline() has fixed the REAL blocker (below) — a model with genuinely
 * fine detail that still can't reach its cap at 0.008 gets a few looser attempts (up to 8%,
 * still sub-centimetre on a ~2-4 wu building) before the pipeline reports a cap violation
 * instead of silently shipping an over-budget model. `lockBorder` keeps open mesh-boundary
 * edges intact throughout (prevents cracks). */
const ERROR_SCHEDULE = [0.008, 0.02, 0.05, 0.08];
const SIMPLIFY_MAX_PASSES_PER_ERROR = 2;

async function loadBudgets() {
  const raw = JSON.parse(await readFile(BUDGETS_PATH, 'utf-8'));
  return { caps: raw.caps ?? {}, optOut: new Set(raw.optOut ?? []) };
}

/** Sum of TRIANGLES-mode primitive triangles across the whole document — same counting rule as
 * measureGeometry() below, factored out so the simplify stage can re-measure mid-pipeline
 * without pulling in prim/material bookkeeping it doesn't need. */
function countTris(document) {
  let tris = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const indices = prim.getIndices();
      const position = prim.getAttribute('POSITION');
      const vertCount = indices ? indices.getCount() : position ? position.getCount() : 0;
      tris += Math.floor(vertCount / 3);
    }
  }
  return tris;
}

/** Runs simplify() against `cap`, walking ERROR_SCHEDULE from tightest to loosest and stopping
 * as soon as the cap is hit. Within one error level, up to SIMPLIFY_MAX_PASSES_PER_ERROR passes
 * re-target the ratio against whatever tri count was actually reached (meshopt can stop short
 * of the requested ratio); a level that makes no progress at all is abandoned immediately
 * rather than burning passes. No-ops (0 passes) if already at/under cap. Returns
 * { before, after, passes, finalError } for the report. */
async function simplifyToBudget(document, cap) {
  const before = countTris(document);
  let current = before;
  let passes = 0;
  let finalError = null;
  for (const errorLevel of ERROR_SCHEDULE) {
    if (current <= cap) break;
    for (let i = 0; i < SIMPLIFY_MAX_PASSES_PER_ERROR; i++) {
      const ratio = cap / current;
      await document.transform(
        simplify({ simplifier: MeshoptSimplifier, ratio, error: errorLevel, lockBorder: true }),
      );
      const next = countTris(document);
      passes += 1;
      finalError = errorLevel;
      if (next >= current) break; // no further progress at this error level — try the next one.
      current = next;
      if (current <= cap) break;
    }
  }
  return { before, after: current, passes, finalError };
}

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

/** MEASURED DEVIATION (D15, discovered building this task): every model in the pack is
 * flat-shaded — each triangle owns its own NORMAL values, so no two triangles share a vertex
 * once NORMAL is part of the weld key, even at a shared geometric edge (`weld()` correctly
 * refuses to merge vertices that disagree on any attribute, not just position). Firing
 * simplify() against that topology gets almost nothing to work with: every edge looks like an
 * open mesh boundary, so the requested ratio stalls a few percent in regardless of `error`
 * (measured: building-red only reached 2291 -> 2075 against a 1100 cap at error up to 0.08).
 * Since world/toronto renders the entire city-pack UNLIT (phase-25.5 binding verdict —
 * meshBasicMaterial, no lighting, so NORMAL is never sampled at runtime), it costs nothing to
 * drop NORMAL/TANGENT before weld()+simplify(): weld can then merge purely on position (+
 * remaining UV), collapsing e.g. building-red from 3967 to 1590 vertices for the SAME 2291
 * triangles, and simplify() reaches every D15 cap cleanly in one error-schedule pass. Applied
 * to every model (not just capped ones) for the same file-size win; harmless if a future phase
 * ever re-lights the pack (three's `computeVertexNormals()` regenerates them trivially, or a
 * pipeline re-run can re-derive faceted normals from the still-present flat geometry). */
function stripNormalsForUnlitPipeline(document) {
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getAttribute('NORMAL')) prim.setAttribute('NORMAL', null);
      if (prim.getAttribute('TANGENT')) prim.setAttribute('TANGENT', null);
    }
  }
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

/** Runs the full D3(+D15) pipeline on one GLB. Returns the measured before/after report row;
 * throws on a hard pipeline failure (caller catches per-file so one bad model doesn't kill the
 * run). `budgets` is the parsed city-pack-budgets.json ({ caps, optOut }). */
async function optimizeOne(id, inputPath, outputPath, budgets, preTransform = null) {
  const io = makeIO();
  const document = await io.read(inputPath);

  // Native bounding box, measured on the PRISTINE read — before any transform touches
  // geometry — so it reflects the model's true native scale (D9 consumes this). Phase 29 T2
  // (D5): measured BEFORE the neutral-body pre-transform below so a `-neutral` variant reports
  // the SAME nativeDims as its base (the pre-transform only recolours materials/textures, never
  // geometry) — the runtime relies on that for collider/scale parity between the two.
  const scenes = document.getRoot().listScenes();
  const bounds = scenes.length > 0 ? getBounds(scenes[0]) : { min: [0, 0, 0], max: [0, 0, 0] };
  const nativeDims = {
    w: bounds.max[0] - bounds.min[0],
    h: bounds.max[1] - bounds.min[1],
    d: bounds.max[2] - bounds.min[2],
  };

  // Phase 29 T2 (D5): optional pre-transform (neutral-body recolour), applied to the pristine
  // read before the D3 pipeline so its recoloured materials/texture flow through palette/
  // textureCompress normally. Base passes leave this null (byte-identical to before).
  let preTransformReport = null;
  if (preTransform) preTransformReport = await preTransform(document, id);

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

  await document.transform(palette({ min: 2 }), join());

  // D15 (measured deviation — see stripNormalsForUnlitPipeline's own doc comment): drop
  // NORMAL/TANGENT before weld() so weld can merge purely on position, giving simplify() an
  // actually-collapsible topology instead of a flat-shaded mesh that looks all-seams to it.
  stripNormalsForUnlitPipeline(document);
  await document.transform(prune(), weld());

  // D15: simplify BEFORE quantize/meshopt (simplifying already-quantized/reordered geometry
  // fights meshopt's GPU-cache reorder). Only for ids with a budgets.json cap, not opted out,
  // and only if the post-join/weld tri count is actually over that cap.
  let simplifyReport = null;
  const cap = budgets.caps[id];
  if (cap !== undefined && !budgets.optOut.has(id)) {
    const before = countTris(document);
    if (before > cap) {
      simplifyReport = await simplifyToBudget(document, cap);
    }
  }

  await document.transform(
    quantize(),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
  );

  const geometry = measureGeometry(document);
  const hasTexture = document.getRoot().listTextures().length > 0;

  await io.write(outputPath, document);
  const optimizedBytes = (await stat(outputPath)).size;
  const contentHash = createHash('sha256').update(await readFile(outputPath)).digest('hex');

  return { id, nativeDims, ...geometry, hasTexture, optimizedBytes, contentHash, simplifyReport, preTransformReport };
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

  const budgets = await loadBudgets();

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;

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
      const measured = await optimizeOne(id, normalizedPath, optimizedPath, budgets);
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

      // Phase 29 T2 (D5): the seven civilian vehicle models ALSO emit a `<id>-neutral` variant —
      // the same source geometry with its body paint recoloured to a light neutral grey (material
      // factor for untextured cars, dominant saturated atlas cluster for textured ones), so a
      // render-time instanceColor multiply yields a true body colour with dark glass/trim. Derived
      // (no separate normalized archival copy): reads the SAME normalized input, writes only the
      // optimized runtime GLB. Reuses the base rawBytes (identical source model) for the manifest.
      if (CIVILIAN_VEHICLE_IDS.includes(id)) {
        const neutralId = neutralBodyId(id);
        const neutralOut = path.join(OPTIMIZED_DIR, `${neutralId}.glb`);
        const neutralMeasured = await optimizeOne(neutralId, normalizedPath, neutralOut, budgets, applyNeutralBody);
        totalOptimized += neutralMeasured.optimizedBytes;
        rows.push({ id: neutralId, category: categoryFor(neutralId), rawBytes, ...neutralMeasured });
      }
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

  // Simplify (D15) before/after report -----------------------------------------------------
  const simplified = rows.filter((r) => r.simplifyReport !== null);
  const capViolations = [];
  console.log('');
  console.log(`SIMPLIFY (D15) — ${simplified.length} model(s) over their city-pack-budgets.json cap:`);
  if (simplified.length > 0) {
    console.log('id                     before  ->  after   cap    passes  error   reduction');
    console.log('-'.repeat(80));
    for (const row of simplified.sort((a, b) => a.id.localeCompare(b.id))) {
      const cap = budgets.caps[row.id];
      const { before, after, passes, finalError } = row.simplifyReport;
      const pct = (((before - after) / before) * 100).toFixed(0);
      console.log(
        `${row.id.padEnd(23)}${String(before).padStart(6)}  -> ${String(after).padStart(6)}  ${String(cap).padStart(5)}  ${String(passes).padStart(6)}  ${String(finalError).padStart(6)}  ${pct.padStart(7)}%`,
      );
      if (after > cap) capViolations.push(`${row.id}: ${after} tris > cap ${cap} (simplifier stalled even at the loosest error level, ${ERROR_SCHEDULE[ERROR_SCHEDULE.length - 1]})`);
    }
  }
  const optedOutOverCap = rows.filter((r) => budgets.optOut.has(r.id) && budgets.caps[r.id] !== undefined && r.tris > budgets.caps[r.id]);
  if (optedOutOverCap.length > 0) {
    console.log('');
    console.log(`OPT-OUT (over cap, expected): ${optedOutOverCap.map((r) => `${r.id} (${r.tris})`).join(', ')}`);
  }
  if (capViolations.length > 0) {
    console.log('');
    console.log(`SIMPLIFY CAP VIOLATIONS (${capViolations.length}) — simplifier could not reach the cap within the error bound:`);
    for (const v of capViolations) console.log(`  FAIL ${v}`);
  }

  // Neutral-body (D5) report ---------------------------------------------------------------
  const neutralRows = rows.filter((r) => r.preTransformReport !== null && r.preTransformReport !== undefined);
  if (neutralRows.length > 0) {
    console.log('');
    console.log(`NEUTRAL-BODY (D5) — ${neutralRows.length} civilian-vehicle variant(s):`);
    console.log('id                        class          fallback  neutralized');
    console.log('-'.repeat(96));
    for (const row of neutralRows.sort((a, b) => a.id.localeCompare(b.id))) {
      const r = row.preTransformReport;
      console.log(
        `${row.id.padEnd(26)}${r.class.padEnd(15)}${(r.fallback ? 'YES' : 'no').padEnd(10)}${r.touched}`,
      );
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

  if (failures.length > 0 || assertionFailures.length > 0 || capViolations.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
