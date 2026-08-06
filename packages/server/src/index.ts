#!/usr/bin/env node
/**
 * Squad Arena host (brief §2.1).
 *
 * One Node process: serves the client bundle over HTTP and runs the
 * authoritative simulation over WebSocket, on a single port. The host plays in
 * a browser tab like everyone else — architecturally a listen server.
 */

import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MATCH, decode, type ClientMessage } from '@squad-arena/shared';
import { WebSocketServer, type WebSocket } from 'ws';

import { lanAddresses, printBanner, publicAddress } from './netinfo.ts';
import { Room } from './room.ts';
import { createStaticHandler } from './static.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8080);
/** Built client bundle. Falls back to the Vite dev output location. */
const CLIENT_DIST = resolve(__dirname, '../../client/dist');

const sockets = new Map<number, WebSocket>();

const room = new Room((id, msg) => {
  const ws = sockets.get(id);
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
});

function broadcastLobby(): void {
  const payload = room.lobbyPayload();
  for (const id of sockets.keys()) sendTo(id, payload);
}

function sendTo(id: number, msg: unknown): void {
  const ws = sockets.get(id);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
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
  let playerId: number | null = null;

  ws.on('message', (raw) => {
    const msg = decode<ClientMessage>(raw.toString());
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'hello': {
        const member = room.join(msg.name, msg.reconnectToken);
        playerId = member.id;
        sockets.set(member.id, ws);
        sendTo(member.id, {
          t: 'welcome',
          playerId: member.id,
          reconnectToken: member.reconnectToken,
          config: MATCH,
          roomState: room.state,
        });
        // A player joining mid-match needs the map before snapshots make sense.
        if (room.state === 'playing' && room.world) {
          sendTo(member.id, {
            t: 'start',
            seed: 0,
            tick0: room.world.tickNumber,
            playerCount: room.world.players.size,
            assignments: [...room.world.players.values()].map((p) => ({
              id: p.id,
              index: p.index,
              name: p.name,
            })),
          });
          sendTo(member.id, room.mapPayload());
        }
        broadcastLobby();
        break;
      }

      case 'ready': {
        if (playerId === null) return;
        room.setReady(playerId, msg.ready);
        broadcastLobby();
        break;
      }

      case 'startRequest': {
        if (playerId === null || playerId !== room.hostId) return;
        room.start();
        broadcastLobby();
        break;
      }

      case 'input': {
        if (playerId === null) return;
        room.setInput(playerId, {
          seq: msg.seq,
          dirX: msg.dirX,
          dirY: msg.dirY,
          ...(msg.chestChoice !== undefined ? { chestChoice: msg.chestChoice } : {}),
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (playerId === null) return;
    sockets.delete(playerId);
    room.markDisconnected(playerId);
    broadcastLobby();
  });

  ws.on('error', () => {
    /* a dropped client is normal; close handles cleanup */
  });
});

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
