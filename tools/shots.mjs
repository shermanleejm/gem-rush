/**
 * Screenshot the dev visual pages.
 *
 *   node tools/shots.mjs            # everything, into shots/
 *   node tools/shots.mjs arenas     # just the arena pages
 *   node tools/shots.mjs sprites
 *
 * Boots the Vite dev server itself, so there is nothing to start first and no
 * half-running server left behind. The sprite sheet and the arena viewer are
 * dev-only pages (`sprites.html`, `arenas.html`) that the production build
 * never sees.
 *
 * Why this exists: the things most likely to be wrong about a sprite or an
 * arena palette are things no test asserts — a unit that dissolves into the
 * floor it is standing on, a world whose water reads as walkable. Rendering
 * them to disk makes that reviewable, and diffable between branches.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'shots');
const PORT = 5177;
const BASE = `http://localhost:${PORT}`;

const want = process.argv[2] ?? 'all';
const wants = (name) => want === 'all' || want === name;

/** Start `vite dev` and resolve once it is actually serving. */
function startServer() {
  const proc = spawn(
    process.platform === 'win32' ? 'node_modules\\.bin\\vite.CMD' : 'node_modules/.bin/vite',
    ['--port', String(PORT), '--strictPort'],
    { cwd: resolve(root, 'packages/client'), shell: process.platform === 'win32' },
  );
  proc.stderr.on('data', (d) => process.stderr.write(d));

  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('vite did not start in 60s')), 60_000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('ready in')) {
        clearTimeout(timer);
        ok(proc);
      }
    });
    proc.on('exit', (code) => fail(new Error(`vite exited early (${code})`)));
  });
}

/**
 * Kill the server and everything it spawned.
 *
 * On Windows the child is a `vite.CMD` shell wrapper, so killing the handle we
 * hold leaves the actual node process listening — and the next run then dies on
 * "port already in use" for a server it can no longer see.
 */
function stopServer(proc) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    proc.kill();
  }
}

const server = await startServer();
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/**
 * Prefer an installed Chrome over Playwright's own build.
 *
 * Playwright pins a browser revision per release, so a bare `launch()` demands
 * a ~150MB download the moment the package is bumped. The pages here are plain
 * DOM and WebGL with nothing version-sensitive about them, so a system Chrome
 * does the job and the tool stays runnable straight after `pnpm install`. If
 * there is no Chrome, fall back — `npx playwright install chromium` fixes that.
 */
async function launch() {
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch {
    return await chromium.launch();
  }
}

const shots = [];
let browser;

try {
  browser = await launch();
  if (wants('sprites')) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.goto(`${BASE}/sprites.html`, { waitUntil: 'networkidle' });
    // The atlas is baked from 3D models at load; give it a beat to appear.
    await page.waitForTimeout(1500);
    const file = resolve(outDir, 'sprites.png');
    await page.screenshot({ path: file, fullPage: true });
    shots.push(file);
    await page.close();
  }

  if (wants('arenas')) {
    const sheet = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await sheet.goto(`${BASE}/arenas.html`, { waitUntil: 'networkidle' });
    await sheet.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    const layouts = resolve(outDir, 'arena-layouts.png');
    await sheet.locator('#grid').screenshot({ path: layouts });
    shots.push(layouts);
    await sheet.close();

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${BASE}/arena.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });

    // One gameplay shot per world rather than per map: the palette is what is
    // under test and maps of a world share one, so 22 shots would be 14 near
    // duplicates. The mine is wound to half charge so its warning colour shows.
    const perWorld = await page.evaluate(() => {
      const seen = new Set();
      return window.mapIds
        .filter(({ world }) => !seen.has(world) && seen.add(world))
        .map(({ id }) => id);
    });

    for (const id of perWorld) {
      await page.evaluate((m) => window.showArena(m, 0.5), id);
      await page.waitForTimeout(300);
      const file = resolve(outDir, `arena-${id}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
    }
    await page.close();
  }
} finally {
  await browser?.close();
  stopServer(server);
}

console.log(`\n${shots.length} shot(s) written to ${outDir}`);
for (const s of shots) console.log(`  ${s.slice(root.length + 1)}`);
