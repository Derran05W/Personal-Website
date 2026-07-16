#!/usr/bin/env node
// Fallback for running Playwright chromium inside this devcontainer BEFORE a rebuild
// has baked the real system libs into the image (see the apt block in Dockerfile).
//
// Problem it solves: the runtime firewall (init-firewall.sh) blocks apt mirrors and the
// node user has no general sudo, so `playwright install-deps` is impossible in a live
// container. Chromium's binaries are BIND_NOW-linked against ~13 libs the base image
// lacks — but headless chromium never meaningfully CALLS most of them (X11 extensions,
// gbm, atk/atspi) or degrades gracefully when calls fail (dbus, asound). Only NSS/NSPR
// (TLS/crypto) must be real, and Playwright's own firefox bundle ships those for the
// right arch.
//
// So: harvest real NSS/NSPR from the Playwright firefox download, generate stub .so
// files (correct SONAMEs + versioned symbols, sane return values) for the rest, then
// run anything Playwright with:
//
//   pnpm exec playwright install chromium firefox   # firefox only for its NSS libs
//   node .devcontainer/gen-chromium-shims.mjs
//   LD_LIBRARY_PATH=$HOME/.cache/chromium-shim-libs pnpm smoke
//
// Verified 2026-07-15 (Playwright 1.61 / chromium 1228 / Debian bookworm arm64): full
// smoke suite + WebGL2-via-SwiftShader render correctly. Once the Dockerfile deps are
// image-baked this script is unnecessary (but harmless).
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = os.homedir();
const OUT = path.join(HOME, '.cache', 'chromium-shim-libs');
fs.mkdirSync(OUT, { recursive: true });

const pwCache = path.join(HOME, '.cache', 'ms-playwright');
const dirs = fs.readdirSync(pwCache);
const find = (prefix, sub) => {
  const d = dirs.filter((n) => n.startsWith(prefix)).sort().pop();
  return d ? path.join(pwCache, d, sub) : null;
};
const BINS = [
  find('chromium_headless_shell-', 'chrome-linux/headless_shell'),
  find('chromium-', 'chrome-linux/chrome'),
].filter((p) => p && fs.existsSync(p));
if (BINS.length === 0) {
  console.error('No Playwright chromium found — run `pnpm exec playwright install chromium` first.');
  process.exit(1);
}
const FF = find('firefox-', 'firefox');

// Ordered matchers: first hit wins (atk-bridge before atk).
const LIBS = [
  ['libatk-bridge-2.0.so.0', (n) => /^atk_bridge/.test(n)],
  ['libatk-1.0.so.0', (n) => /^atk_/.test(n)],
  ['libatspi.so.0', (n) => /^atspi_/.test(n)],
  ['libXcomposite.so.1', (n) => /^XComposite/.test(n)],
  ['libXdamage.so.1', (n) => /^XDamage/.test(n)],
  ['libXfixes.so.3', (n) => /^XFixes/.test(n)],
  ['libXrandr.so.2', (n) => /^XRR/.test(n)],
  ['libasound.so.2', (n, v) => /^ALSA_/.test(v) || /^snd_/.test(n)],
  ['libdbus-1.so.3', (n, v) => /^LIBDBUS/.test(v) || /^dbus_/.test(n)],
  ['libgbm.so.1', (n) => /^gbm_/.test(n)],
  ['libxkbcommon.so.0', (n, v) => /^V_0\./.test(v) || /^xkb_/.test(n)],
  ['libcups.so.2', (n) => /^(cups|http|ipp|ppd)[A-Z]/.test(n)],
];

// C body for one stub symbol. Semantics matter under BIND_NOW + CHECK-happy chromium:
// validators must say "valid", constructors must return real heap blocks, ref-counting
// must return its argument, error paths must look like clean failures (alsa returns -1
// so device probes report "no devices"). SHIM_DEBUG=1 traces stub calls to stderr.
function bodyFor(name, lib, suffix) {
  const fn = suffix ? `${name}_impl_${suffix}` : name;
  const trace = `if (shim_dbg()) fprintf(stderr, "SHIM ${lib} %s\\n", "${name}");`;
  if (name === 'snd_strerror')
    return `const char* ${fn}(int e) { (void)e; ${trace} return "chromium-shim"; }\n`;
  if (/^dbus_(message_ref|connection_ref|pending_call_ref)$/.test(name))
    return `void* ${fn}(void* a) { ${trace} return a; }\n`;
  if (/^dbus_(message_new|message_copy)/.test(name))
    return `void* ${fn}(void) { ${trace} return calloc(1, 512); }\n`;
  if (
    /^dbus_validate_/.test(name) ||
    /^dbus_message_(set_|append|iter_init_append|iter_append|iter_open_container|iter_close_container)/.test(name) ||
    name === 'dbus_threads_init_default'
  )
    return `long ${fn}(void) { ${trace} return 1; }\n`;
  const ret = lib.startsWith('libasound') ? '-1' : '0';
  return `long ${fn}(void) { ${trace} return ${ret}; }\n`;
}

// lib -> Map(symbol -> Set(versions))  ('' = unversioned)
const collected = new Map(LIBS.map(([l]) => [l, new Map()]));
for (const bin of BINS) {
  const out = execSync(`objdump -T ${bin}`, { maxBuffer: 64 * 1024 * 1024 }).toString();
  for (const line of out.split('\n')) {
    if (!line.includes('*UND*')) continue;
    const m = line.split('*UND*')[1].trim().split(/\s+/);
    let name, ver;
    if (m.length >= 3) {
      ver = m[1].replace(/[()]/g, '');
      name = m[2];
    } else if (m.length === 2) {
      name = m[1];
      ver = '';
    } else continue;
    if (ver === 'Base') ver = '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    for (const [lib, match] of LIBS) {
      if (match(name, ver)) {
        const map = collected.get(lib);
        if (!map.has(name)) map.set(name, new Set());
        map.get(name).add(ver);
        break;
      }
    }
  }
}

for (const [lib, syms] of collected) {
  if (syms.size === 0) continue;
  const versions = new Set();
  let c = `/* auto-generated stub for ${lib} */\n#include <stdio.h>\n#include <stdlib.h>\n`;
  c += `static int shim_dbg_v = -1;\nstatic int shim_dbg(void) { if (shim_dbg_v < 0) shim_dbg_v = getenv("SHIM_DEBUG") != 0; return shim_dbg_v; }\n`;
  const scriptNodes = new Map(); // version -> [names]
  let i = 0;
  for (const [name, vers] of syms) {
    const vlist = [...vers];
    vlist.forEach((v) => v && versions.add(v));
    if (vlist.length === 1) {
      c += bodyFor(name, lib, '');
      const v = vlist[0];
      if (!scriptNodes.has(v)) scriptNodes.set(v, []);
      scriptNodes.get(v).push(name);
    } else {
      // same symbol required at several versions: one impl per version via .symver
      vlist.forEach((v, k) => {
        c += bodyFor(name, lib, `${i}_${k}`);
        c += `__asm__(".symver ${name}_impl_${i}_${k}, ${name}${k === 0 ? '@@' : '@'}${v || 'Base'}");\n`;
      });
    }
    i++;
  }
  const stem = path.join(OUT, lib.replace(/\.so.*/, ''));
  fs.writeFileSync(`${stem}.c`, c);
  const args = ['-shared', '-fPIC', '-O0', '-Wl,-z,noexecstack', `-Wl,-soname,${lib}`, '-o', path.join(OUT, lib), `${stem}.c`];
  if (versions.size > 0) {
    let vs = '';
    for (const [v, names] of scriptNodes) {
      if (!v) continue;
      vs += `${v} {\n  global:\n    ${names.join(';\n    ')};\n};\n`;
    }
    for (const v of versions) if (!scriptNodes.has(v)) vs += `${v} {\n};\n`;
    const base = scriptNodes.get('');
    if (base && base.length) vs = `SHIM_BASE {\n  global:\n    ${base.join(';\n    ')};\n};\n` + vs;
    fs.writeFileSync(`${stem}.ver`, vs);
    args.push(`-Wl,--version-script=${stem}.ver`);
  }
  execSync(`gcc ${args.join(' ')}`);
  console.log(`${lib}: ${syms.size} symbols stubbed`);
}

// Real NSS/NSPR family from the firefox bundle (right arch, properly versioned).
if (FF && fs.existsSync(FF)) {
  for (const f of fs.readdirSync(FF)) {
    if (/^lib(nss|nspr|plc|plds|smime|softokn|freebl|ssl)/.test(f)) {
      fs.copyFileSync(path.join(FF, f), path.join(OUT, f));
      console.log(`${f}: copied from firefox bundle (real)`);
    }
  }
} else {
  console.warn('WARNING: no Playwright firefox found — NSS libs missing. Run `pnpm exec playwright install firefox`.');
}
console.log(`\nDone. Use: LD_LIBRARY_PATH=${OUT} <playwright command>`);
