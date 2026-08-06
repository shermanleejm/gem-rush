/**
 * Minimal static file server for the built client bundle.
 *
 * Hand-rolled rather than pulling in `sirv`: the host must be one `node`
 * command with as few moving parts as possible, and this is the whole of what
 * we need — MIME types, a path-traversal guard, and an index fallback.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
};

export function createStaticHandler(root: string) {
  const rootResolved = resolve(root);

  return function serve(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // Resolve then verify containment: `normalize` alone doesn't stop an
    // absolute path or a symlink from escaping the bundle directory.
    const candidate = resolve(join(rootResolved, normalize(pathname)));
    if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
      res.writeHead(403).end('Forbidden');
      return true;
    }

    let filePath = candidate;
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA fallback so a deep link still boots the client.
      const indexPath = join(rootResolved, 'index.html');
      if (!existsSync(indexPath)) return false;
      filePath = indexPath;
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const isHtml = type.startsWith('text/html');
    res.writeHead(200, {
      'Content-Type': type,
      // The bundle is rebuilt whenever the host restarts, and a stale cached
      // index.html against a fresh bundle is a confusing failure to debug.
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600',
    });
    createReadStream(filePath).pipe(res);
    return true;
  };
}
