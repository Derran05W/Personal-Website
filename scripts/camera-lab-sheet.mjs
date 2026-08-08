#!/usr/bin/env node
// Phase 33 Task 3 — the camera-lab CONTACT SHEET. Reads the evidence tree scripts/camera-lab.mjs
// produces (a `summary.json` plus `<preset>/vantage-<id>.png`, `<preset>/stills.json`,
// `<preset>/drive.json` [+ `drive-repeat.json`], `<preset>/drive/<label>-t<sec>.png`) and emits one
// self-contained, dependency-free HTML file for the Phase 33 USER GATE: a stills grid (rows =
// vantages, cols = presets, each cell the screenshot + its clip rates), a per-preset drive strip
// (thumbnails + a stats row incl. tierAtEnd + the reproducibility verdict), and a plain stats
// summary table. Image references are RELATIVE (the sheet is written inside the same tree, or
// wherever --o points, and paths are computed relative to the sheet file's own directory), so the
// output can be opened straight off disk or served as a static folder — no build step, no CDN.
//
// Degrades gracefully: missing drive data (skipped battery, DRIVES phase absent because
// window.__smashy.startCameraLabDrive hadn't landed yet) renders a "not run" note instead of a
// blank hole; a missing preset/vantage cell renders "no data" instead of a broken <img>.
//
// Phase 76 additions:
//   - `--title` parameterizes the page title/heading (it was hardcoded to "Phase 33 camera lab" in
//     two places, which would have mislabelled every later phase's gate evidence).
//   - SLICED trees are merged: camera-lab.mjs writes `summary.slice-<i>-of-<n>.json` per slice
//     (P42's process rule — a dead slice must only lose itself), so this reads EVERY `summary*.json`
//     in `--in` and unions their presets/vantages into one sheet. Later files win per preset-phase
//     key, and the merged `slices` list is printed on the sheet so a partial battery is visible as
//     partial rather than looking complete.
//   - The Phase 76 readability block (city-in-frame / ground band / pursuer visibility) is rendered
//     per still cell, per drive and per chase, with `n/a` — never 0 — for a null denominator.
//
// Usage:
//   node scripts/camera-lab-sheet.mjs [--in .planning/screenshots/phase-33-lab]
//     [--o <in>/contact-sheet.html] [--title "Phase NN camera lab — contact sheet"]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TITLE = 'Camera lab — contact sheet';

function parseArgs(argv) {
  const out = { in: '.planning/screenshots/phase-33-lab', o: null, title: DEFAULT_TITLE };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const a = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const next = () => (inline === null ? argv[++i] : inline);
    switch (a) {
      case '--in':
        out.in = next();
        break;
      case '--o':
        out.o = next();
        break;
      case '--title':
        out.title = next();
        break;
      default:
        console.error(`[camera-lab-sheet] unknown arg: ${raw}`);
        process.exit(1);
    }
  }
  return out;
}

/**
 * Read every `summary*.json` in the evidence tree and merge into one summary object.
 *
 * Unsliced trees hold exactly `summary.json` and this is the identity. Sliced trees hold one file
 * per slice; each carries only the presets/cells IT ran, so the merge unions `presets` (per-preset,
 * per-phase: stills rows are concatenated and de-duplicated by vantage id; drive/chase/repeatVerdict
 * are taken from whichever file has them) and `vantageIds` (first file's full requested order,
 * extended with anything new). Console-error counts SUM — a sheet that hid one slice's errors
 * behind another's zero would be the exact failure this repo keeps re-learning.
 */
function loadSummaries(inDir) {
  const files = readdirSync(inDir)
    .filter((f) => /^summary.*\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  const parts = files.map((f) => ({ file: f, data: JSON.parse(readFileSync(path.join(inDir, f), 'utf8')) }));
  const merged = {
    generatedAt: parts[parts.length - 1].data.generatedAt,
    args: parts[0].data.args,
    vantageIds: [],
    presets: {},
    slices: [],
    sourceFiles: files,
    drivesSkippedReason: null,
    chaseSkippedReason: null,
    consoleErrorCount: 0,
    hasReadabilityCapability: true,
    // The union of every slice's metric SPEC, first-seen order preserved. Slices are separate
    // browser sessions, so one may have measured against a bridge the next did not have — unioning
    // (rather than taking the first file's) means a metric only one slice could see still gets a
    // column, and its absent cells render as "no data" instead of vanishing from the sheet.
    metricSpec: [],
    notes: [],
  };
  const seenMetricKeys = new Set();
  const seenNotes = new Set();
  let sawDrive = false;
  let sawChase = false;
  for (const { file, data } of parts) {
    for (const m of data.metricSpec ?? []) {
      if (!seenMetricKeys.has(m.key)) {
        seenMetricKeys.add(m.key);
        merged.metricSpec.push(m);
      }
    }
    for (const note of data.notes ?? []) {
      if (!seenNotes.has(note)) {
        seenNotes.add(note);
        merged.notes.push(note);
      }
    }
    for (const vid of data.vantageIds ?? []) if (!merged.vantageIds.includes(vid)) merged.vantageIds.push(vid);
    merged.consoleErrorCount += data.consoleErrorCount ?? 0;
    if (data.hasReadabilityCapability === false) merged.hasReadabilityCapability = false;
    merged.slices.push({
      file,
      slice: data.slice ?? null,
      cells: data.sliceStillCellIds ?? null,
      generatedAt: data.generatedAt ?? null,
    });
    if (data.drivesSkippedReason) merged.drivesSkippedReason = data.drivesSkippedReason;
    if (data.chaseSkippedReason) merged.chaseSkippedReason = data.chaseSkippedReason;
    for (const [pid, block] of Object.entries(data.presets ?? {})) {
      const target = (merged.presets[pid] = merged.presets[pid] ?? { stills: [] });
      for (const row of block.stills ?? []) {
        if (!target.stills.some((r) => r.vantage === row.vantage)) target.stills.push(row);
      }
      if (block.drive) {
        target.drive = block.drive;
        sawDrive = true;
      }
      if (block.repeatVerdict) target.repeatVerdict = block.repeatVerdict;
      if (block.chase) {
        target.chase = block.chase;
        sawChase = true;
      }
    }
  }
  // A skip reason recorded by one slice must not blank out real data another slice produced.
  if (sawDrive) merged.drivesSkippedReason = null;
  if (sawChase) merged.chaseSkippedReason = null;
  return merged;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtPct(r) {
  return r === null || r === undefined ? '—' : `${(r * 100).toFixed(1)}%`;
}

function fmtNum(n) {
  return n === null || n === undefined ? '—' : String(n);
}

/** A readability field: `n/a` for a null denominator (NEVER 0 — see camera-lab.mjs's block on why
 * the two are different findings), and `n/a` for a whole block the bridge never produced. */
function fmtR(n, digits = 1) {
  return n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : n.toFixed(digits);
}

function fmtRPct(r) {
  return r === null || r === undefined ? 'n/a' : `${(r * 100).toFixed(1)}%`;
}

/** Phase 76 readability spans for a still cell. */
function readabilitySpans(r) {
  if (!r) return `<span class="readability">readability n/a</span>`;
  return (
    `<span class="readability">city ${fmtRPct(r.cityInFrameFraction)}</span>` +
    `<span class="readability">band ${fmtR(r.groundBandWu)} wu</span>` +
    `<span class="readability">cops ${fmtR(r.onScreenPursuerCount, 2)}</span>` +
    `<span class="readability">warn ${fmtR(r.pursuerWarningDistanceM)} m</span>`
  );
}

/** Phase 76 readability as one line, for the drive/chase blocks. */
function readabilityLine(r) {
  if (!r) return `<p class="statsline note">readability block not present on this run.</p>`;
  return `<p class="statsline">
    city-in-frame <b>${fmtRPct(r.cityInFrameFraction)}</b>
      (${fmtR(r.cityBoxesInFrame)} of ${fmtNum(r.cityBoxesTested)} indexed boxes in frustum) ·
    ground band <b>${fmtR(r.groundBandWu)} wu</b> ·
    on-screen pursuers <b>${fmtR(r.onScreenPursuerCount, 2)}</b> (max ${fmtNum(r.onScreenPursuerMax)}) ·
    warning distance <b>${fmtR(r.pursuerWarningDistanceM)} m</b> over ${fmtNum(r.sightings)} sighting(s) ·
    readability frames ${fmtNum(r.frames)}
  </p>`;
}

/** Relative POSIX-style path from the sheet file's directory to a path expressed relative to
 * `inDir` (the evidence tree root) — every screenshot/report path summary.json stores is already
 * relative to inDir by construction (scripts/camera-lab.mjs writes them that way). */
function relFromSheet(sheetFile, inDir, treeRelPath) {
  const abs = path.join(inDir, treeRelPath);
  return path.relative(path.dirname(sheetFile), abs).split(path.sep).join('/');
}

function rateClass(r) {
  if (r === null || r === undefined) return '';
  if (r >= 0.15) return 'bad';
  if (r >= 0.02) return 'warn';
  return 'good';
}

/**
 * The POSE label for a vantage row — junction vs mid-block, the road class, the signed lane offset
 * and whether it sits on a planted median.
 *
 * It belongs on the ROW HEAD, not in every cell: the pose is a property of the anchor, identical
 * down the whole row, and repeating it per preset would bury it. It is what stops a reader
 * comparing a wide-junction framing against a mid-block one and concluding something about the
 * camera — after Phase 75 a spine/major crossing is ~22 x 17.6 wu of open asphalt, most of any
 * frame, and all seven of the historic anchors are exactly that.
 *
 * Derived entirely from world/toronto/cameraVantages.ts (camera-lab.mjs copies it onto each row),
 * so an older evidence tree without the fields simply renders no label rather than a wrong one.
 */
function poseLabel(summary, presetIds, vid) {
  for (const pid of presetIds) {
    const row = (summary.presets[pid]?.stills ?? []).find((r) => r.vantage === vid);
    if (!row || !row.kind) continue;
    const offset = typeof row.laneOffsetWu === 'number' ? row.laneOffsetWu : null;
    const bits = [
      row.kind,
      row.cls ? `${row.cls}${row.streetId ? ` (${row.streetId})` : ''}` : null,
      offset === null ? null : offset === 0 ? 'centreline' : `lane ${offset > 0 ? '+' : ''}${offset.toFixed(1)} wu`,
      row.onMedian ? 'ON MEDIAN' : null,
    ].filter(Boolean);
    return `<br><span class="pose${row.onMedian ? ' warn' : ''}">${esc(bits.join(' · '))}</span>`;
  }
  return '';
}

function buildStillsGrid(summary, presetIds, vantageIds, sheetFile, inDir) {
  const header = `<tr><th class="corner">vantage \\ preset</th>${presetIds
    .map((p) => `<th>${esc(p)}</th>`)
    .join('')}</tr>`;

  const rows = vantageIds
    .map((vid) => {
      const cells = presetIds
        .map((pid) => {
          const row = (summary.presets[pid]?.stills ?? []).find((r) => r.vantage === vid);
          if (!row) return `<td class="cell missing">no data</td>`;
          const src = relFromSheet(sheetFile, inDir, row.screenshot);
          return `<td class="cell">
            <img src="${esc(src)}" loading="lazy" alt="preset ${esc(pid)} at ${esc(vid)}">
            <div class="stats">
              <span class="${rateClass(row.eyeInsideRate)}">eye-in ${fmtPct(row.eyeInsideRate)}</span>
              <span class="${rateClass(row.nearPlaneRate)}">near-plane ${fmtPct(row.nearPlaneRate)}</span>
              <span class="${rateClass(row.occludedRate)}">occluded ${fmtPct(row.occludedRate)}</span>
              <span class="${rateClass(row.boresightRate)}">boresight ${fmtPct(row.boresightRate)}</span>
              <span class="${rateClass(row.clampedRate)}">clamped ${fmtPct(row.clampedRate)}</span>
              <span class="frames">${fmtNum(row.frames)} frames</span>
              ${readabilitySpans(row.readability)}
              <span class="perf">${fmtNum(row.perf?.calls)} calls / ${fmtNum(row.perf?.triangles)} tris</span>
            </div>
          </td>`;
        })
        .join('');
      return `<tr><th class="rowhead">${esc(vid)}${poseLabel(summary, presetIds, vid)}</th>${cells}</tr>`;
    })
    .join('\n');

  return `<table class="grid">${header}${rows}</table>`;
}

function buildDriveStrip(presetId, summary, sheetFile, inDir) {
  const d = summary.presets[presetId]?.drive;
  if (!d) return `<div class="drive-block"><h3>${esc(presetId)}</h3><p class="note">Drive not run for this preset.</p></div>`;

  const thumbs = (d.shots ?? [])
    .filter((_, i, arr) => {
      // Aim for roughly one thumbnail every ~10s of drive time regardless of --shot-every: keep
      // every Nth shot where N approximates 10 / shotEvery, but always keep at least a handful.
      const shotEvery = summary.args?.shotEvery ?? 2;
      const stride = Math.max(1, Math.round(10 / shotEvery));
      return i % stride === 0 || i === arr.length - 1;
    })
    .map((fileName) => {
      const src = relFromSheet(sheetFile, inDir, `${d.driveDir}/${fileName}`);
      const secMatch = fileName.match(/t(\d+)\.png$/);
      const label = secMatch ? `t=${secMatch[1]}s` : fileName;
      return `<figure><img src="${esc(src)}" loading="lazy" alt="${esc(presetId)} drive ${esc(label)}"><figcaption>${esc(label)}</figcaption></figure>`;
    })
    .join('\n');

  const verdict = summary.presets[presetId]?.repeatVerdict;
  const verdictHtml = verdict
    ? `<p class="verdict ${verdict.ok ? 'good' : 'bad'}">
        Reproducibility: ${verdict.ok ? 'PASS' : 'FAIL'}
        (waypoints ${verdict.waypointsMatch ? 'match' : 'DIFFER'},
        ${Object.entries(verdict.rateChecks)
          .map(([k, v]) => `${esc(k)} ${fmtPct(v.primary)}→${fmtPct(v.repeat)} ${v.ok ? 'ok' : 'FAIL'}`)
          .join(', ')})
      </p>`
    : `<p class="note">No repeat run — reproducibility not checked this pass.</p>`;

  return `<div class="drive-block">
    <h3>${esc(presetId)}</h3>
    <p class="statsline">
      ${d.seconds}s @ seed ${d.seed} · frames ${fmtNum(d.framesObserved)} · waypoints ${fmtNum(d.waypointCount)} ·
      heatAtEnd ${fmtNum(d.heatAtEnd)} · tierAtEnd ${fmtNum(d.tierAtEnd)}
    </p>
    <p class="statsline">
      eye-in <span class="${rateClass(d.rates?.eyeInsideRate)}">${fmtPct(d.rates?.eyeInsideRate)}</span> ·
      near-plane <span class="${rateClass(d.rates?.nearPlaneRate)}">${fmtPct(d.rates?.nearPlaneRate)}</span> ·
      occluded <span class="${rateClass(d.rates?.occludedRate)}">${fmtPct(d.rates?.occludedRate)}</span> ·
      boresight <span class="${rateClass(d.rates?.boresightRate)}">${fmtPct(d.rates?.boresightRate)}</span> ·
      clamped <span class="${rateClass(d.rates?.clampedRate)}">${fmtPct(d.rates?.clampedRate)}</span>
    </p>
    ${readabilityLine(d.readability)}
    ${verdictHtml}
    <div class="strip">${thumbs || '<p class="note">No screenshots captured.</p>'}</div>
  </div>`;
}

/** Phase 76 CHASE block: the ★3 run on dev/feelDrives.ts's `chase3` route, whose whole point is the
 * pursuer half of the readability block (structurally n/a everywhere else — nothing chases a parked
 * car). An unarmed run is called out in red rather than quietly presented as a chase. */
function buildChaseBlock(presetId, summary, sheetFile, inDir) {
  const c = summary.presets[presetId]?.chase;
  if (!c) return `<div class="drive-block"><h3>${esc(presetId)}</h3><p class="note">Chase not run for this preset.</p></div>`;
  const armed = c.tierArmed !== false && c.tierObserved !== false;
  const thumbs = (c.shots ?? [])
    .map((fileName) => {
      const src = relFromSheet(sheetFile, inDir, `${c.chaseDir}/${fileName}`);
      const secMatch = fileName.match(/t(\d+)\.png$/);
      const label = secMatch ? `t=${secMatch[1]}s` : fileName;
      return `<figure><img src="${esc(src)}" loading="lazy" alt="${esc(presetId)} chase ${esc(label)}"><figcaption>${esc(label)}</figcaption></figure>`;
    })
    .join('\n');
  return `<div class="drive-block">
    <h3>${esc(presetId)}</h3>
    <p class="statsline">
      route ${esc(c.route)} · ${fmtNum(c.seconds)}s @ seed ${fmtNum(c.seed)} · frames ${fmtNum(c.frames)} ·
      ★${fmtNum(c.tierAtStart)}→★${fmtNum(c.tierAtEnd)} (required ★${fmtNum(c.requiredTier)}) ·
      pursuit units ${fmtNum(c.pursuitUnitsAtStart)}→max ${fmtNum(c.maxPursuitUnits)} ·
      <span class="${armed ? 'good' : 'bad'}">${armed ? 'ARMED' : 'NOT ARMED — not a chase'}</span>
    </p>
    ${readabilityLine(c.readability)}
    <p class="statsline">
      eye-in <span class="${rateClass(c.rates?.eyeInsideRate)}">${fmtPct(c.rates?.eyeInsideRate)}</span> ·
      boresight <span class="${rateClass(c.rates?.boresightRate)}">${fmtPct(c.rates?.boresightRate)}</span> ·
      clamped <span class="${rateClass(c.rates?.clampedRate)}">${fmtPct(c.rates?.clampedRate)}</span>
    </p>
    <div class="strip">${thumbs || '<p class="note">No screenshots captured.</p>'}</div>
  </div>`;
}

function buildStatsTable(summary, presetIds, vantageIds) {
  const rows = presetIds
    .map((pid) => {
      const stills = summary.presets[pid]?.stills ?? [];
      const avg = (key) => {
        const vals = stills.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
        if (vals.length === 0) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      };
      // Readability means over the still cells THIS preset actually has (a sliced tree may hold
      // fewer than the full vantage list — `stills.length` is printed so the denominator is visible
      // instead of implied). Null cells are excluded from their own mean, never counted as 0.
      const avgR = (key) => {
        const vals = stills.map((r) => r.readability?.[key]).filter((v) => typeof v === 'number');
        if (vals.length === 0) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      };
      const d = summary.presets[pid]?.drive;
      const c = summary.presets[pid]?.chase;
      return `<tr>
        <td>${esc(pid)}</td>
        <td>${stills.length}/${vantageIds.length}</td>
        <td>${fmtNum(stills.reduce((a, r) => a + (r.frames ?? 0), 0))}</td>
        <td class="${rateClass(avg('eyeInsideRate'))}">${fmtPct(avg('eyeInsideRate'))}</td>
        <td class="${rateClass(avg('nearPlaneRate'))}">${fmtPct(avg('nearPlaneRate'))}</td>
        <td class="${rateClass(avg('occludedRate'))}">${fmtPct(avg('occludedRate'))}</td>
        <td class="${rateClass(avg('boresightRate'))}">${fmtPct(avg('boresightRate'))}</td>
        <td class="${rateClass(avg('clampedRate'))}">${fmtPct(avg('clampedRate'))}</td>
        <td>${fmtRPct(avgR('cityInFrameFraction'))}</td>
        <td>${fmtR(avgR('groundBandWu'))}</td>
        <td>${d ? fmtPct(d.rates?.eyeInsideRate) : '—'}</td>
        <td>${d ? fmtPct(d.rates?.boresightRate) : '—'}</td>
        <td>${d ? fmtNum(d.tierAtEnd) : '—'}</td>
        <td>${c ? fmtR(c.readability?.onScreenPursuerCount, 2) : '—'}</td>
        <td>${c ? fmtR(c.readability?.pursuerWarningDistanceM) : '—'}</td>
      </tr>`;
    })
    .join('\n');
  return `<table class="stats-table">
    <thead><tr>
      <th>preset</th><th>vantages sampled</th><th>still frames</th>
      <th>avg eye-in</th><th>avg near-plane</th><th>avg occluded</th><th>avg boresight</th><th>avg clamped</th>
      <th>avg city-in-frame</th><th>avg ground band (wu)</th>
      <th>drive eye-in</th><th>drive boresight</th><th>drive tierAtEnd</th>
      <th>chase pursuers</th><th>chase warn (m)</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * THE GENERIC METRICS TABLE. Every other table on this sheet names its columns; this one asks the
 * evidence what columns it has.
 *
 * camera-lab.mjs writes each cell's whole counter readout as `metrics` (a flat `{key: value}` map)
 * plus a `metricSpec` describing every key — kind (rate/mean/raw), the raw field it came from, and
 * the denominator it was divided by. Rendering off that spec is what makes a counter added to
 * world/toronto/cameraClipStats.ts appear here on its first battery run with NO edit to this file.
 * A curated table that silently omits a new metric is indistinguishable from one that read zero,
 * and this repo has learned that lesson in three different subsystems.
 *
 * Rows are (preset × phase): the stills row is the mean over the still cells that preset actually
 * has (a sliced tree may hold fewer — the denominator is printed), and the drive/chase rows are
 * that single run's values. Null cells are EXCLUDED from a mean, never counted as 0.
 */
function buildMetricsTable(summary, presetIds) {
  const spec = summary.metricSpec ?? [];
  if (spec.length === 0) {
    return `<p class="note">No <code>metricSpec</code> in this evidence tree — it predates the generic
      readout (camera-lab.mjs, Phase 76). The curated tables above are the whole picture for it.</p>`;
  }
  const header = `<tr><th>preset</th><th>phase</th><th>n</th>${spec
    .map((m) => `<th title="${esc(`${m.kind} · from ${m.source}${m.denomKey ? ` ÷ ${m.denomKey}` : ''}`)}">${esc(m.key)}<br><span class="kind">${esc(m.kind)}</span></th>`)
    .join('')}</tr>`;

  const cells = (values, n) =>
    `<td>${fmtNum(n)}</td>${spec
      .map((m) => {
        const v = values?.[m.key];
        if (v === null || v === undefined) return `<td class="na">n/a</td>`;
        const text = m.kind === 'rate' || m.key.endsWith('Fraction') ? fmtPct(v) : fmtR(v, Number.isInteger(v) ? 0 : 3);
        return `<td>${esc(text)}</td>`;
      })
      .join('')}`;

  const rows = presetIds
    .flatMap((pid) => {
      const block = summary.presets[pid] ?? {};
      const stills = block.stills ?? [];
      const out = [];
      if (stills.length > 0) {
        const meaned = {};
        for (const m of spec) {
          const vals = stills.map((r) => r.metrics?.[m.key]).filter((v) => typeof v === 'number');
          meaned[m.key] = vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        out.push(`<tr><td>${esc(pid)}</td><td>stills (mean)</td>${cells(meaned, stills.length)}</tr>`);
      }
      if (block.drive) out.push(`<tr><td>${esc(pid)}</td><td>drive</td>${cells(block.drive.metrics, 1)}</tr>`);
      if (block.chase) out.push(`<tr><td>${esc(pid)}</td><td>chase ★</td>${cells(block.chase.metrics, 1)}</tr>`);
      return out;
    })
    .join('\n');

  return `<table class="stats-table metrics-table"><thead>${header}</thead><tbody>${rows}</tbody></table>`;
}

/**
 * The measurement-validity facts the battery cannot express as a number. camera-lab.mjs writes them
 * into every summary (`notes`) so they travel WITH the evidence; anything a future run adds shows
 * up here automatically. Rendered above the tables, not below, because both of the standing ones
 * change how a reader must interpret the very first thing they look at.
 */
function buildNotes(summary) {
  const notes = summary.notes ?? [];
  if (notes.length === 0) return '';
  return `<div class="notes"><h3>Read these before the numbers</h3><ul>${notes
    .map((n) => `<li>${esc(n)}</li>`)
    .join('')}</ul></div>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inDir = path.resolve(args.in);
  const sheetFile = path.resolve(args.o ?? path.join(inDir, 'contact-sheet.html'));

  if (!existsSync(inDir)) {
    console.error(`[camera-lab-sheet] no evidence tree at ${inDir} — run scripts/camera-lab.mjs first.`);
    process.exit(1);
  }
  const summary = loadSummaries(inDir);
  if (!summary) {
    console.error(
      `[camera-lab-sheet] no summary*.json in ${inDir} — run scripts/camera-lab.mjs first (a sliced ` +
        'battery writes summary.slice-<i>-of-<n>.json per slice; this reads all of them).',
    );
    process.exit(1);
  }
  console.log(`[camera-lab-sheet] merged ${summary.sourceFiles.length} summary file(s): ${summary.sourceFiles.join(', ')}`);

  const presetIds = Object.keys(summary.presets ?? {});
  if (presetIds.length === 0) {
    console.error('[camera-lab-sheet] summary.json has no presets — nothing to render.');
    process.exit(1);
  }
  const vantageIds =
    summary.vantageIds && summary.vantageIds.length > 0
      ? summary.vantageIds
      : Array.from(
          new Set(presetIds.flatMap((pid) => (summary.presets[pid]?.stills ?? []).map((r) => r.vantage))),
        );

  const stillsGrid = buildStillsGrid(summary, presetIds, vantageIds, sheetFile, inDir);
  const driveStrips = summary.drivesSkippedReason
    ? `<p class="note">DRIVES phase skipped: ${esc(summary.drivesSkippedReason)}</p>`
    : presetIds.map((pid) => buildDriveStrip(pid, summary, sheetFile, inDir)).join('\n');
  const chaseBlocks = summary.chaseSkippedReason
    ? `<p class="note">CHASE phase skipped: ${esc(summary.chaseSkippedReason)}</p>`
    : presetIds.map((pid) => buildChaseBlock(pid, summary, sheetFile, inDir)).join('\n');
  const statsTable = buildStatsTable(summary, presetIds, vantageIds);
  const metricsTable = buildMetricsTable(summary, presetIds);
  const notesBlock = buildNotes(summary);
  const sliceNote =
    (summary.slices ?? []).some((s) => s.slice)
      ? `<p class="note">Merged from ${summary.slices.length} slice file(s): ${esc(
          summary.slices
            .map((s) => (s.slice ? `${s.file} (slice ${s.slice.i}/${s.slice.n}, ${s.cells?.length ?? '?'} cells)` : s.file))
            .join(' · '),
        )}</p>`
      : '';
  const readabilityNote =
    summary.hasReadabilityCapability === false
      ? `<p class="note">Readability instrumentation was NOT present on the bridge for at least one slice — those cells read <b>n/a</b>, which is not the same as 0.</p>`
      : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(args.title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 32px 64px;
    background: #0b0e14; color: #d7dde5;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  h1 { font-size: 22px; margin: 0 0 4px; color: #fff; }
  h2 { font-size: 17px; margin: 40px 0 12px; color: #fff; border-bottom: 1px solid #2a3140; padding-bottom: 6px; }
  h3 { font-size: 15px; margin: 0 0 6px; color: #fff; }
  .meta { color: #8b96a8; margin-bottom: 8px; }
  .note { color: #8b96a8; font-style: italic; }
  table.grid { border-collapse: collapse; width: 100%; }
  table.grid th, table.grid td { border: 1px solid #232a38; padding: 6px; vertical-align: top; }
  table.grid th { background: #131824; color: #cdd6e3; font-weight: 600; text-align: left; }
  table.grid th.corner { background: #0b0e14; }
  table.grid th.rowhead { white-space: nowrap; }
  table.grid th.rowhead .pose { display: block; font-weight: 400; font-size: 11px; color: #8b96a8; margin-top: 2px; }
  td.cell { min-width: 200px; }
  td.cell.missing { color: #5a6473; text-align: center; }
  td.cell img { width: 100%; max-width: 260px; display: block; border-radius: 3px; background: #000; }
  .stats { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; font-size: 11.5px; color: #9aa5b5; }
  .stats .perf { flex-basis: 100%; color: #6c7789; }
  .stats .frames { color: #6c7789; }
  .stats .readability { color: #7fb6e8; }
  .good { color: #6fd08c; }
  .warn { color: #e0b34d; }
  .bad { color: #e0616f; font-weight: 600; }
  .drive-block { margin-bottom: 28px; padding: 12px 16px; background: #10141d; border: 1px solid #202634; border-radius: 6px; }
  .statsline { margin: 2px 0; color: #b5bec9; }
  .verdict { margin: 8px 0; font-weight: 600; }
  .strip { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .strip figure { margin: 0; width: 160px; }
  .strip img { width: 100%; display: block; border-radius: 3px; background: #000; }
  .strip figcaption { font-size: 11px; color: #8b96a8; text-align: center; margin-top: 2px; }
  table.stats-table { border-collapse: collapse; }
  table.stats-table th, table.stats-table td { border: 1px solid #232a38; padding: 6px 10px; text-align: right; }
  table.stats-table th:first-child, table.stats-table td:first-child { text-align: left; }
  table.stats-table th { background: #131824; }
  table.metrics-table { display: block; max-width: 100%; overflow-x: auto; white-space: nowrap; font-size: 12px; }
  table.metrics-table th .kind { color: #6c7789; font-weight: 400; font-size: 10px; }
  table.stats-table td.na { color: #5a6473; }
  .notes { margin: 16px 0 8px; padding: 10px 16px; background: #10141d; border: 1px solid #2a3140; border-radius: 6px; }
  .notes h3 { margin: 0 0 6px; }
  .notes li { margin-bottom: 6px; color: #b5bec9; }
  @media (prefers-color-scheme: light) {
    body { background: #f5f6f8; color: #1c2230; }
  }
</style>
</head>
<body>
  <h1>${esc(args.title)}</h1>
  <p class="meta">Generated ${esc(summary.generatedAt ?? 'unknown time')} · presets: ${esc(presetIds.join(', '))} ·
    vantages: ${esc(vantageIds.join(', '))} ·
    console/page errors: ${esc(summary.consoleErrorCount ?? 'n/a')}</p>
  ${sliceNote}
  ${readabilityNote}

  ${notesBlock}

  <h2>Stats summary</h2>
  ${statsTable}

  <h2>All metrics — whatever the bridge reported</h2>
  <p class="note">Rendered from the run's own <code>metricSpec</code>, so a counter added to
    <code>cameraClipStats</code> gets a column here with no edit to the sheet. Hover a header for its
    kind, source field and denominator. <code>n/a</code> is an empty denominator, never a zero.</p>
  ${metricsTable}

  <h2>Stills — every vantage x preset</h2>
  ${stillsGrid}

  <h2>Drives — per-preset scripted cruise</h2>
  ${driveStrips}

  <h2>Chase — ★3 pursuit (dev/feelDrives.ts <code>chase3</code>)</h2>
  ${chaseBlocks}
</body>
</html>
`;

  writeFileSync(sheetFile, html);
  console.log(`[camera-lab-sheet] wrote ${sheetFile}`);
}

main().catch((err) => {
  console.error('[camera-lab-sheet] FAIL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
