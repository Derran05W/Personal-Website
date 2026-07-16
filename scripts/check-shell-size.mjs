// Shell-chunk budget guard (run after `pnpm build`). Two invariants from the TDD (§4.1,
// §10) that a green build alone doesn't prove:
//   1. The entry chunk stays under the 150 KB gz shell budget.
//   2. No game dependency leaks into the entry chunk — three.js retains "THREE." string
//      literals even minified, so its presence in the entry chunk means the lazy seam
//      (src/app/GameCanvas.tsx being the only app→game import) has been broken.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 150 * 1024;

const assetsDir = join(process.cwd(), 'dist', 'assets');
const entryChunks = readdirSync(assetsDir).filter(
  (f) => f.startsWith('index-') && f.endsWith('.js'),
);
if (entryChunks.length !== 1) {
  console.error(`Expected exactly one dist/assets/index-*.js entry chunk, found: ${entryChunks}`);
  process.exit(1);
}

const source = readFileSync(join(assetsDir, entryChunks[0]));
const gzBytes = gzipSync(source, { level: 9 }).length;
const gzKb = (gzBytes / 1024).toFixed(2);

let failed = false;
if (gzBytes > BUDGET_BYTES) {
  console.error(`FAIL: entry chunk ${entryChunks[0]} is ${gzKb} KB gz — over the 150 KB shell budget.`);
  failed = true;
}
if (source.includes('THREE.')) {
  console.error(
    `FAIL: entry chunk ${entryChunks[0]} contains three.js code — a game dependency leaked into the shell. ` +
      'Only src/app/GameCanvas.tsx may import from src/game/, and only dynamically.',
  );
  failed = true;
}

if (failed) process.exit(1);
console.log(`OK: entry chunk ${entryChunks[0]} is ${gzKb} KB gz (budget 150 KB), no game deps detected.`);
