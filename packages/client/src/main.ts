/**
 * Client bootstrap: join -> lobby -> match -> results -> rematch.
 *
 * The render loop runs at display refresh and is fully decoupled from the
 * host's 20 Hz tick (§2.4). Input is sent at ~30 Hz (§2.6) rather than every
 * frame, so a 144 Hz display doesn't flood the host.
 */

import {
  INPUT_RATE,
  MATCH,
  type LobbyPlayer,
  type UnitType,
  type WorldEvent,
} from '@squad-arena/shared';

import { Controls } from './input/controls.ts';
import { Connection, type ViewEntity } from './net/connection.ts';
import { Scene } from './render/scene.ts';
import {
  createDevPanel,
  createHud,
  showJoin,
  showLobby,
  showResults,
  type HudHandle,
  type LobbyHandle,
} from './ui/screens.ts';

const mount = document.getElementById('app')!;

const conn = new Connection();
const controls = new Controls();
const scene = new Scene();
const dev = createDevPanel();

let hud: HudHandle | null = null;
let lobby: LobbyHandle | null = null;
let closeResults: (() => void) | null = null;
let closeJoin: (() => void) | null = null;

let hostId = 0;
let lobbyPlayers: LobbyPlayer[] = [];
let running = false;
let pendingOffer: UnitType[] | null = null;

const view = new Map<number, ViewEntity>();

function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

// ── flow ────────────────────────────────────────────────────────────────────

closeJoin = showJoin((name) => {
  conn.connect(socketUrl(), name, {
    onWelcome: () => {
      closeJoin?.();
      closeJoin = null;
      if (!lobby) {
        lobby = showLobby(
          (r) => conn.setReady(r),
          () => conn.requestStart(),
        );
        lobby.update(lobbyPlayers, hostId, conn.playerId);
      }
    },
    onLobby: (players, host) => {
      lobbyPlayers = players;
      hostId = host;
      lobby?.update(players, host, conn.playerId);
    },
    onStart: () => {
      closeResults?.();
      closeResults = null;
      lobby?.close();
      lobby = null;
      startMatch();
    },
    onMap: (size, tiles) => {
      // The host sends `start` then `map` back to back, but Pixi init is async,
      // so the map routinely lands before the renderer exists. Buffer it and
      // let startMatch apply it once the scene is up.
      pendingMap = { size, tiles };
      if (scene.ready) applyPendingMap();
    },
    onEnd: (standings) => {
      running = false;
      hud?.destroy();
      hud = null;
      closeResults = showResults(standings, conn.playerId, conn.playerId === hostId, () => {
        conn.requestStart();
      });
    },
    onEvents: handleEvents,
    onClose: () => {
      lobby?.setError('Lost connection to the host. Reload to try again.');
    },
  });
});

let pendingMap: { size: number; tiles: Uint8Array } | null = null;

function applyPendingMap(): void {
  if (!pendingMap || !scene.ready) return;
  scene.buildTerrain(pendingMap.size, pendingMap.tiles);
  pendingMap = null;
}

async function startMatch(): Promise<void> {
  if (!scene.ready) {
    await scene.init(mount);
    controls.attach(scene.app.canvas as unknown as HTMLElement);
    window.addEventListener('resize', () => scene.resize());
  }
  applyPendingMap();
  scene.localTeam = conn.playerIndex;
  hud ??= createHud();
  running = true;
}

// ── events -> VFX only, never state (§2.6) ──────────────────────────────────

function handleEvents(events: WorldEvent[]): void {
  for (const ev of events) {
    switch (ev.t) {
      case 'hit':
        scene.spawnHit(ev.x, ev.y, 0xffd9a0);
        break;
      case 'death':
        scene.spawnBurst(ev.x, ev.y, ev.kind === 'creep' ? 0x9aa3b5 : 0x8a6f4f, 7);
        break;
      case 'gem':
        if (ev.player === conn.playerId) scene.spawnBurst(ev.x, ev.y, 0x56d9a3, 4);
        break;
      case 'fusion':
        scene.spawnBurst(ev.x, ev.y, ev.tier === 2 ? 0xffe27a : 0xffffff, 14);
        break;
      case 'chestOffer':
        if (ev.player === conn.playerId) {
          pendingOffer = ev.options;
          hud?.showOffer(ev.options, ev.price, (i) => {
            pendingOffer = null;
            hud?.hideOffer();
            chestChoice = i;
          });
        }
        break;
      case 'chestOpen':
        scene.spawnBurst(ev.x, ev.y, 0xffc857, 10);
        break;
      case 'squadFight':
        scene.spawnBurst(ev.x, ev.y, 0xff6b6b, 16);
        break;
      case 'respawn':
        break;
      case 'phase':
        break;
    }
  }
}

// ── loop ────────────────────────────────────────────────────────────────────

let chestChoice: number | undefined;
let lastFrame = performance.now();
let inputAcc = 0;
let frameMsAvg = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);

  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const t0 = performance.now();

  if (running && scene.ready) {
    const input = controls.poll();

    // Fixed-rate input send, independent of frame rate.
    inputAcc += dt;
    const step = 1 / INPUT_RATE;
    while (inputAcc >= step) {
      inputAcc -= step;
      conn.sendInput(input.dirX, input.dirY, step, chestChoice);
      chestChoice = undefined;
    }

    conn.sample(view);

    // Find our leader in the interpolated state, then overlay prediction.
    let serverLeader: ViewEntity | null = null;
    let squadSize = 0;
    for (const e of view.values()) {
      if (e.kind === 'leader' && e.team === conn.playerIndex) serverLeader = e;
      else if (e.kind === 'unit' && e.team === conn.playerIndex) squadSize++;
    }

    const predicted = serverLeader
      ? conn.predictLeader(serverLeader.x, serverLeader.y, MATCH.leaderSpeed)
      : null;

    scene.render(view, predicted, squadSize, dt);

    // HUD
    const me = conn.players.find((p) => p.id === conn.playerId);
    if (hud) {
      hud.setTimer(conn.timeRemaining, conn.phase === 'lastCall');
      hud.setGems(me?.g ?? 0);
      hud.setSquad(squadSize, conn.config.squadCap);
      const rows = conn.players
        .map((p) => ({
          id: p.id,
          name: lobbyPlayers.find((l) => l.id === p.id)?.name ?? `P${p.id}`,
          gems: p.g,
        }))
        .sort((a, b) => b.gems - a.gems);
      hud.setScores(rows, conn.playerId);
      if (!pendingOffer) hud.hideOffer();
    }
  }

  const frameMs = performance.now() - t0;
  frameMsAvg += (frameMs - frameMsAvg) * 0.1;

  dev.update({
    fps: (1 / Math.max(dt, 1e-4)).toFixed(0),
    'frame ms': frameMsAvg.toFixed(2),
    entities: view.size,
    'snap B': conn.stats.snapshotBytes,
    'KB/s down': (conn.stats.bytesPerSec / 1024).toFixed(1),
    'snaps/s': conn.stats.snapsPerSec.toFixed(1),
    'jitter ms': conn.stats.jitter.toFixed(1),
    'interp ms': conn.stats.interpDelay.toFixed(0),
    buffered: conn.stats.buffered,
    'sim lat': conn.simulate.latencyMs,
    'sim loss%': conn.simulate.lossPct,
  });
}
requestAnimationFrame(frame);

// Dev latency injection (§M3). Exposed on window so it can be driven from the
// console without shipping a settings UI.
declare global {
  interface Window {
    saNet: { latencyMs: number; jitterMs: number; lossPct: number };
  }
}
window.saNet = conn.simulate;
