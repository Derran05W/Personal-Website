#!/usr/bin/env node
// Phase 74 Task 5 — the FEEL LAB CONTACT SHEET. Reads the evidence tree scripts/feel-lab.mjs
// produces (a `results.json` plus `<unit>/shot-*.png` and `<unit>.json` per run unit) and emits
// one self-contained, dependency-free HTML file: a verdict/summary table, a route-unit block per
// drive (headline stats + telemetry digest + screenshot strip), and a probe-suite block (one row
// per probe with its status and headline metric + screenshot strip). Image references are
// RELATIVE (computed from the sheet file's own directory), so the output can be opened straight
// off disk or served as a static folder — no build step, no CDN. Mirrors camera-lab-sheet.mjs's
// shape and degrade-gracefully stance: a missing/errored unit renders its recorded `reason`
// instead of a blank hole or a broken <img> — reading a results.json this sheet renders should
// never be a better source of truth than the sheet itself.
//
// A single sheet renders ONE `results.json` (one slice, one tier). scripts/feel-lab.mjs has no
// merge step across slices/tiers by design (see that file's header) — run this once per
// `<out>/<run>/` directory you want a sheet for.
//
// Usage:
//   node scripts/feel-lab-sheet.mjs --in .planning/screenshots/phase-74/<run>
//     [--o <in>/contact-sheet.html]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { in: '.planning/screenshots/phase-74', o: null };
  for (const arg of argv) {
    // pnpm forwards a bare `--` verbatim (see scripts/feel-lab.mjs's header) — ignore it.
    if (arg === '--') continue;
    const [key, ...rest] = arg.split('=');
    const value = rest.join('=');
    switch (key) {
      case '--in':
        out.in = value;
        break;
      case '--o':
        out.o = value;
        break;
      default:
        console.error(`[feel-lab-sheet] unknown arg: ${arg}`);
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

function fmtNum(n, digits = 1) {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(digits);
}

/** Relative POSIX-style path from the sheet file's directory to a path expressed relative to
 * `inDir` (the evidence tree root) — every screenshot path a unit record stores is already
 * relative to its own `screenshotDir`, itself relative to `inDir`. */
function relFromSheet(sheetFile, inDir, treeRelPath) {
  const abs = path.join(inDir, treeRelPath);
  return path.relative(path.dirname(sheetFile), abs).split(path.sep).join('/');
}

function statusClass(status) {
  if (status === 'ok') return 'good';
  if (status === 'insufficientRunway' || status === 'inconclusive') return 'warn';
  return 'bad';
}

function buildVerdictTable(results) {
  const v = results.verdict;
  return `<table class="stats-table">
    <tbody>
      <tr><td>schema</td><td>${esc(results.schema ?? 'n/a')}</td></tr>
      <tr><td>generated</td><td>${esc(results.generatedAt ?? 'n/a')}</td></tr>
      <tr><td>tier</td><td>${esc(results.tier)}</td></tr>
      <tr><td>mode</td><td>${esc(results.args?.mode ?? 'n/a')}</td></tr>
      <tr><td>slice</td><td>${results.slice ? `${results.slice.i}/${results.slice.n} (units ${results.slice.start}-${results.slice.end - 1} of ${results.allUnitIds?.length ?? '?'})` : 'not sliced (full filtered list)'}</td></tr>
      <tr><td>units this file</td><td>${esc((results.sliceUnitIds ?? []).join(', ') || 'none')}</td></tr>
      <tr><td>units planned / ok / error</td><td>${v.unitsPlanned} / <span class="good">${v.unitsOk}</span> / <span class="${v.unitsError > 0 ? 'bad' : ''}">${v.unitsError}</span></td></tr>
      <tr><td>console / page errors</td><td class="${v.consoleErrorCount + v.pageErrorCount > 0 ? 'bad' : 'good'}">${v.consoleErrorCount} / ${v.pageErrorCount}</td></tr>
      <tr><td>verdict</td><td class="${v.ok ? 'good' : 'bad'}">${v.ok ? 'OK' : `FAIL — ${esc(v.reasons.join('; '))}`}</td></tr>
    </tbody>
  </table>`;
}

function buildShotStrip(unit, sheetFile, inDir) {
  const shots = unit.screenshots ?? [];
  if (shots.length === 0) return '<p class="note">No screenshots captured.</p>';
  return `<div class="strip">${shots
    .map((fileName) => {
      const src = relFromSheet(sheetFile, inDir, `${unit.screenshotDir}/${fileName}`);
      const label = fileName.replace(/\.png$/, '');
      return `<figure><img src="${esc(src)}" loading="lazy" alt="${esc(unit.id)} ${esc(label)}"><figcaption>${esc(label)}</figcaption></figure>`;
    })
    .join('\n')}</div>`;
}

function buildRouteBlock(unit, sheetFile, inDir) {
  if (unit.status !== 'ok') {
    return `<div class="unit-block">
      <h3>${esc(unit.id)} <span class="bad">${esc(unit.status)}</span></h3>
      <p class="note">${esc(unit.reason ?? 'no further detail recorded')}</p>
      ${buildShotStrip(unit, sheetFile, inDir)}
    </div>`;
  }
  const r = unit.report;
  const t = r.telemetry;
  const warnings = unit.warnings ?? [];
  return `<div class="unit-block">
    <h3>${esc(unit.id)} — ${esc(r.label)} <span class="good">ok</span></h3>
    <p class="statsline">
      ${fmtNum(r.elapsedSec)}s of ${fmtNum(r.seconds, 0)}s requested · seed ${r.seed} · start node ${r.startNodeId} ·
      districts [${esc((r.districtIds ?? []).join(', '))}]
    </p>
    <p class="statsline">
      pace target ${fmtNum(r.speed?.targetMps)} m/s → mean ${fmtNum(r.speed?.meanMps)} med ${fmtNum(r.speed?.medianMps)}
      p95 ${fmtNum(r.speed?.p95Mps)} max ${fmtNum(r.speed?.maxMps)}
    </p>
    <p class="statsline">
      heat ${r.heatAtStart}→${r.heatAtEnd} · tier ${r.tierAtStart}→${r.tierAtEnd}
      (required ${r.requiredTier}, armed <span class="${r.tierArmed ? 'good' : 'bad'}">${r.tierArmed}</span>) ·
      revives ${r.driver?.revives ?? 0}
    </p>
    <p class="statsline">
      contacts <span class="${t.contact.eventsPerMin > 0 ? 'warn' : 'good'}">${fmtNum(t.contact.eventsPerMin)}/min</span>
      (${t.contact.events} events) · loss mean ${fmtNum(t.contact.meanSpeedLossMps, 2)} max ${fmtNum(t.contact.maxSpeedLossMps, 2)} m/s
    </p>
    <p class="statsline">
      stuck ${t.stuck.count} events, <span class="${t.stuck.unrecoverableCount > 0 ? 'bad' : 'good'}">${t.stuck.unrecoverableCount} unrecoverable</span>
      · longest ${fmtNum(t.stuck.longestSec, 2)}s · total ${fmtNum(t.stuck.totalStuckSec, 1)}s
    </p>
    <p class="statsline">
      airtime ${fmtPct(t.stability.airtimeFrac)} · slip ${fmtPct(t.cornering.lateralSlipFrac)} ·
      flips <span class="${t.stability.flipCount > 0 ? 'bad' : 'good'}">${t.stability.flipCount}</span> ·
      roll peak ${fmtNum(t.stability.rollPeakRad, 2)} rad · pitch peak ${fmtNum(t.stability.pitchPeakRad, 2)} rad
    </p>
    <p class="statsline">perf ${fmtNum(unit.perf?.calls, 0)} calls / ${fmtNum(unit.perf?.triangles, 0)} tris / ${fmtNum(unit.perf?.fps, 0)} fps</p>
    ${warnings.length > 0 ? `<p class="statsline warn">warnings: ${esc(warnings.join('; '))}</p>` : ''}
    <details><summary>formatted report</summary><pre>${esc(unit.formattedText ?? '')}</pre></details>
    ${buildShotStrip(unit, sheetFile, inDir)}
  </div>`;
}

function probeHeadline(p) {
  switch (p.kind) {
    case 'launch':
      return `t50 ${fmtNum(p.t50Sec, 2)}s · t90 ${fmtNum(p.t90Sec, 2)}s · peak ${fmtNum(p.peakSpeedMps)} m/s`;
    case 'brake':
      return `dist ${fmtNum(p.brakeDistM)} m · time ${fmtNum(p.brakeSec, 2)}s · entry ${fmtNum(p.entrySpeedMps)} m/s (target met ${p.entryTargetMet})`;
    case 'stepSteer':
      return `steer→peak-yaw ${fmtNum(p.steerToPeakYawSec, 3)}s (± ${fmtNum(p.quantizationSec, 3)}s) · peak yaw-rate ${fmtNum(p.peakYawRateRadS, 2)} rad/s`;
    case 'turnRadius':
      return (p.points ?? [])
        .map((pt) => `@${fmtNum(pt.targetSpeedMps, 0)}m/s→${pt.radiusM === null ? 'n/a' : `${fmtNum(pt.radiusM)}m`} (${pt.status})`)
        .join(', ');
    case 'slalom':
      return `half-period ${fmtNum(p.halfPeriodSec, 2)}s · flips ${p.flipEvents} · airtime ${fmtPct(p.airtimeFrac)}`;
    default:
      return '';
  }
}

function buildProbesBlock(unit, sheetFile, inDir) {
  if (unit.status !== 'ok') {
    return `<div class="unit-block">
      <h3>${esc(unit.id)} <span class="bad">${esc(unit.status)}</span></h3>
      <p class="note">${esc(unit.reason ?? 'no further detail recorded')}</p>
      ${buildShotStrip(unit, sheetFile, inDir)}
    </div>`;
  }
  const s = unit.suite;
  const warnings = unit.warnings ?? [];
  const rows = s.results
    .map(
      (p) => `<tr>
        <td>${esc(p.kind)}</td>
        <td class="${statusClass(p.status)}">${esc(p.status)}</td>
        <td>${esc(probeHeadline(p))}</td>
        <td>${p.contacts?.length ?? 0}</td>
      </tr>`,
    )
    .join('\n');
  return `<div class="unit-block">
    <h3>${esc(unit.id)} <span class="good">ok</span></h3>
    <p class="statsline">
      car ${esc(s.carId)} · top speed ${fmtNum(s.topSpeedMps)} m/s ·
      corridor ${fmtNum(s.corridor?.lengthM, 0)} m long, ${fmtNum(s.corridor?.clearHalfWidthM, 1)} m clear half-width
    </p>
    <p class="statsline">
      isolation: civTraffic=${s.isolation.civTraffic} transit=${s.isolation.transit}
      packParked=${s.isolation.packParked} invincible=${s.isolation.invincible}
    </p>
    ${warnings.length > 0 ? `<p class="statsline warn">warnings: ${esc(warnings.join('; '))}</p>` : ''}
    <table class="stats-table probe-table">
      <thead><tr><th>probe</th><th>status</th><th>headline</th><th>contacts</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="statsline">perf ${fmtNum(unit.perf?.calls, 0)} calls / ${fmtNum(unit.perf?.triangles, 0)} tris / ${fmtNum(unit.perf?.fps, 0)} fps</p>
    <details><summary>formatted report</summary><pre>${esc(unit.formattedText ?? '')}</pre></details>
    ${buildShotStrip(unit, sheetFile, inDir)}
  </div>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inDir = path.resolve(args.in);
  const sheetFile = path.resolve(args.o ?? path.join(inDir, 'contact-sheet.html'));

  const resultsPath = path.join(inDir, 'results.json');
  if (!existsSync(resultsPath)) {
    console.error(`[feel-lab-sheet] no results.json at ${resultsPath} — run scripts/feel-lab.mjs first ` +
      '(point --in at a specific <out>/<run> directory, not the phase-74 root).');
    process.exit(1);
  }
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));

  const units = results.units ?? [];
  if (units.length === 0) {
    console.error('[feel-lab-sheet] results.json has no units — nothing to render.');
    process.exit(1);
  }

  const blocks = units
    .map((u) => (u.kind === 'route' ? buildRouteBlock(u, sheetFile, inDir) : buildProbesBlock(u, sheetFile, inDir)))
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Phase 74 feel lab — contact sheet (${esc(results.args?.run ?? 'run')})</title>
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
  table.stats-table { border-collapse: collapse; width: 100%; max-width: 760px; }
  table.stats-table th, table.stats-table td { border: 1px solid #232a38; padding: 6px 10px; text-align: left; }
  table.stats-table th { background: #131824; color: #cdd6e3; }
  table.probe-table { max-width: 900px; }
  .good { color: #6fd08c; }
  .warn { color: #e0b34d; }
  .bad { color: #e0616f; font-weight: 600; }
  .unit-block { margin-bottom: 28px; padding: 12px 16px; background: #10141d; border: 1px solid #202634; border-radius: 6px; }
  .statsline { margin: 2px 0; color: #b5bec9; }
  .statsline.warn { color: #e0b34d; }
  details { margin: 10px 0; }
  details summary { cursor: pointer; color: #8b96a8; }
  pre { white-space: pre-wrap; font-size: 12px; color: #9aa5b5; background: #0b0e14; padding: 8px; border-radius: 4px; }
  .strip { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .strip figure { margin: 0; width: 220px; }
  .strip img { width: 100%; display: block; border-radius: 3px; background: #000; }
  .strip figcaption { font-size: 11px; color: #8b96a8; text-align: center; margin-top: 2px; }
  @media (prefers-color-scheme: light) {
    body { background: #f5f6f8; color: #1c2230; }
  }
</style>
</head>
<body>
  <h1>Phase 74 feel lab — contact sheet</h1>
  <p class="meta">run "${esc(results.args?.run ?? 'unknown')}" · tier ${esc(results.tier)} · mode ${esc(results.args?.mode ?? 'n/a')} ·
    generated ${esc(results.generatedAt ?? 'unknown time')}</p>

  <h2>Verdict</h2>
  ${buildVerdictTable(results)}

  <h2>Run units</h2>
  ${blocks}
</body>
</html>
`;

  writeFileSync(sheetFile, html);
  console.log(`[feel-lab-sheet] wrote ${sheetFile}`);
}

main().catch((err) => {
  console.error('[feel-lab-sheet] FAIL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
