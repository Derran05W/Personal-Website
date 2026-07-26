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
// Usage:
//   node scripts/camera-lab-sheet.mjs [--in .planning/screenshots/phase-33-lab]
//     [--o <in>/contact-sheet.html]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { in: '.planning/screenshots/phase-33-lab', o: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--in':
        out.in = next();
        break;
      case '--o':
        out.o = next();
        break;
      default:
        console.error(`[camera-lab-sheet] unknown arg: ${a}`);
        process.exit(1);
    }
  }
  return out;
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
              <span class="perf">${fmtNum(row.perf?.calls)} calls / ${fmtNum(row.perf?.triangles)} tris</span>
            </div>
          </td>`;
        })
        .join('');
      return `<tr><th class="rowhead">${esc(vid)}</th>${cells}</tr>`;
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
    ${verdictHtml}
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
      const d = summary.presets[pid]?.drive;
      return `<tr>
        <td>${esc(pid)}</td>
        <td>${vantageIds.length}</td>
        <td class="${rateClass(avg('eyeInsideRate'))}">${fmtPct(avg('eyeInsideRate'))}</td>
        <td class="${rateClass(avg('nearPlaneRate'))}">${fmtPct(avg('nearPlaneRate'))}</td>
        <td class="${rateClass(avg('occludedRate'))}">${fmtPct(avg('occludedRate'))}</td>
        <td class="${rateClass(avg('boresightRate'))}">${fmtPct(avg('boresightRate'))}</td>
        <td class="${rateClass(avg('clampedRate'))}">${fmtPct(avg('clampedRate'))}</td>
        <td>${d ? fmtPct(d.rates?.eyeInsideRate) : '—'}</td>
        <td>${d ? fmtPct(d.rates?.boresightRate) : '—'}</td>
        <td>${d ? fmtNum(d.tierAtEnd) : '—'}</td>
      </tr>`;
    })
    .join('\n');
  return `<table class="stats-table">
    <thead><tr>
      <th>preset</th><th>vantages sampled</th>
      <th>avg eye-in</th><th>avg near-plane</th><th>avg occluded</th><th>avg boresight</th><th>avg clamped</th>
      <th>drive eye-in</th><th>drive boresight</th><th>drive tierAtEnd</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inDir = path.resolve(args.in);
  const sheetFile = path.resolve(args.o ?? path.join(inDir, 'contact-sheet.html'));

  const summaryPath = path.join(inDir, 'summary.json');
  if (!existsSync(summaryPath)) {
    console.error(`[camera-lab-sheet] no summary.json at ${summaryPath} — run scripts/camera-lab.mjs first.`);
    process.exit(1);
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));

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
  const statsTable = buildStatsTable(summary, presetIds, vantageIds);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Phase 33 camera lab — contact sheet</title>
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
  td.cell { min-width: 200px; }
  td.cell.missing { color: #5a6473; text-align: center; }
  td.cell img { width: 100%; max-width: 260px; display: block; border-radius: 3px; background: #000; }
  .stats { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; font-size: 11.5px; color: #9aa5b5; }
  .stats .perf { flex-basis: 100%; color: #6c7789; }
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
  @media (prefers-color-scheme: light) {
    body { background: #f5f6f8; color: #1c2230; }
  }
</style>
</head>
<body>
  <h1>Phase 33 camera lab — contact sheet</h1>
  <p class="meta">Generated ${esc(summary.generatedAt ?? 'unknown time')} · presets: ${esc(presetIds.join(', '))} ·
    vantages: ${esc(vantageIds.join(', '))} ·
    console/page errors: ${esc(summary.consoleErrorCount ?? 'n/a')}</p>

  <h2>Stats summary</h2>
  ${statsTable}

  <h2>Stills — every vantage x preset</h2>
  ${stillsGrid}

  <h2>Drives — per-preset scripted cruise</h2>
  ${driveStrips}
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
