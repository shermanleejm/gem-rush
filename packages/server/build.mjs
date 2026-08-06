/**
 * Produce a self-contained, publishable host package (brief §M8).
 *
 * `npx gem-rush` has to work with no pnpm, no workspace and no build step on
 * the user's machine, so this bundles the TypeScript host *and* the `shared`
 * simulation it imports into one JS file, then copies the built client bundle
 * in beside it. `ws` stays external because it has native-ish internals and is
 * declared as a real dependency.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');
const clientDist = resolve(here, '../client/dist');

if (!existsSync(clientDist)) {
  console.error(
    '\n  Client bundle missing at packages/client/dist.\n' +
      '  Run `pnpm --filter @gem-rush/client build` first.\n',
  );
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(dist, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ws is a real runtime dependency; everything else (including the shared
  // package's TypeScript source) is inlined so the tarball stands alone.
  external: ['ws'],
  // No shebang banner here: src/index.ts already carries one and esbuild
  // preserves it, so adding another emits two and the second is a syntax error
  // on line 2. Only running the packed tarball catches that.
  logLevel: 'warning',
});

// The published layout puts the client next to the server bundle; the static
// handler checks this location first and falls back to the workspace path.
cpSync(clientDist, resolve(dist, 'public'), { recursive: true });

console.log('  Built host bundle -> packages/server/dist/index.js');
console.log('  Copied client     -> packages/server/dist/public');
