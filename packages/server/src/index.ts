#!/usr/bin/env node
/**
 * Gem Rush host (brief §2.1).
 *
 * One Node process: serves the client bundle over HTTP and runs the
 * authoritative simulation over WebSocket, on a single port. The host plays in
 * a browser tab like everyone else — architecturally a listen server.
 */

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Room, TICK_DT, decode, type ClientMessage } from '@gem-rush/shared';
import { WebSocketServer, type WebSocket } from 'ws';

import { lanAddresses, printBanner, publicAddress } from './netinfo.ts';
import { createStaticHandler } from './static.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Built client bundle.
 *
 * Two layouts have to work: the published npx package, where the client sits in
 * `dist/public` beside the bundled server, and the workspace, where it is at
 * `packages/client/dist`. Checking published-first means the shipped copy is
 * never shadowed by a stale local build.
 */
const CLIENT_DIST = [
  resolve(__dirname, 'public'),
  resolve(__dirname, '../../client/dist'),
].find((p) => existsSync(p)) ?? resolve(__dirname, '../../client/dist');

/**
 * Keyed by transport key, not player id: Room sends `welcome` while still
 * inside `handle()`, so a playerId-keyed map would not be populated yet and the
 * first message to every joining client would be dropped.
 */
const sockets = new Map<string, WebSocket>();

const room = new Room((id, msg) => {
  const key = room.keyFor(id);
  if (key === undefined) return;
  const ws = sockets.get(key);
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
});

function broadcastLobby(): void {
  const payload = room.lobbyPayload();
  const raw = JSON.stringify(payload);
  for (const ws of sockets.values()) {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const serveStatic = createStaticHandler(CLIENT_DIST);

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, state: room.state, players: room.members.size }));
    return;
  }
  if (serveStatic(req, res)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    'Client bundle not found.\n\nRun `pnpm build` first, or `pnpm dev` for the Vite dev server.\n',
  );
});

// ── WebSocket ───────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // Every socket gets a stable key; Room owns the key -> player mapping and all
  // protocol handling, so this file is purely transport.
  const key = `ws-${nextKey++}`;

  // Register the socket before any message is handled, so the `welcome` that
  // Room emits from inside handle() has somewhere to go.
  sockets.set(key, ws);

  ws.on('message', (raw) => {
    const msg = decode<ClientMessage>(raw.toString());
    if (!msg || typeof msg.t !== 'string') return;
    if (room.handle(key, msg)) broadcastLobby();
  });

  ws.on('close', () => {
    sockets.delete(key);
    if (room.detach(key)) broadcastLobby();
  });

  ws.on('error', () => {
    /* a dropped client is normal; close handles cleanup */
  });
});

let nextKey = 1;

// ── tick loop ───────────────────────────────────────────────────────────────
// Room is transport-agnostic and deliberately owns no timer, so the clock lives
// here. A short interval with an accumulator rather than a 50ms one: setInterval
// drifts, and the simulation must advance in exact fixed steps.

let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  room.advance(dt);
}, Math.max(1, Math.round((TICK_DT * 1000) / 4)));

// ── boot ────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddresses();
  // Print the LAN block immediately — it's the common case and shouldn't wait
  // on a network round trip that might time out.
  printBanner(PORT, { lan, public: null });

  void publicAddress().then((pub) => {
    if (pub) {
      console.log(`  Public IP detected: \x1b[36mhttp://${pub}:${PORT}\x1b[0m`);
      console.log(
        `  \x1b[2m(needs TCP ${PORT} forwarded to this machine, or use the tunnel above)\x1b[0m\n`,
      );
    }
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Something else is running there — stop it, or set PORT=8081.\n`);
    process.exit(1);
  }
  throw err;
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\n  Shutting down host.\n');
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}
