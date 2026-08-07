/**
 * Client bootstrap: join -> lobby -> match -> results -> rematch.
 *
 * The render loop runs at display refresh and is fully decoupled from the
 * host's 20 Hz tick (§2.4). Input is sent at ~30 Hz (§2.6) rather than every
 * frame, so a 144 Hz display doesn't flood the host.
 */

import {
  GAME_MODES,
  INPUT_RATE,
  MATCH,
  type LobbyPlayer,
  type UnitType,
  type WorldEvent,
} from '@gem-rush/shared';

import { Controls } from './input/controls.ts';
import { BrowserHost } from './net/browserHost.ts';
import { Connection, type ViewEntity } from './net/connection.ts';
import { PeerTransport, WebSocketTransport } from './net/transport.ts';
import { Audio } from './render/audio.ts';
import { Scene } from './render/scene.ts';
import {
  createBanner,
  createDevPanel,
  createHud,
  createMinimap,
  createMuteButton,
  createStick,
  showJoin,
  showLobby,
  createGemTag,
  showDraft,
  showModeCard,
  showResults,
  showRoomCode,
  type HudHandle,
  type LobbyHandle,
} from './ui/screens.ts';

const mount = document.getElementById('app')!;

const conn = new Connection();
const controls = new Controls();
const scene = new Scene();
const dev = createDevPanel();
const stick = createStick();
const minimap = createMinimap();
const banner = createBanner();
const audio = new Audio();

let hud: HudHandle | null = null;
let gemTag: ReturnType<typeof createGemTag> | null = null;
let dashQueued = false;
let lobby: LobbyHandle | null = null;
let closeResults: (() => void) | null = null;
let removeMute: (() => void) | null = null;

let hostId = 0;
let lobbyPlayers: LobbyPlayer[] = [];
let running = false;
let pendingOffer: UnitType[] | null = null;

const view = new Map<number, ViewEntity>();

function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * Is a Node host serving this page?
 *
 * On GitHub Pages there is no server at all, so the game has to be hosted from
 * somebody's browser. Probing /healthz is more reliable than sniffing the
 * hostname, and it fails fast because a static host answers 404 immediately.
 */
async function detectServer(): Promise<boolean> {
  try {
    const res = await fetch('healthz', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

let browserHost: BrowserHost | null = null;
let roomCode: { close: () => void; setVisible: (v: boolean) => void } | null = null;

const listeners = {
  onWelcome: () => {
    start?.close();
    start = null;
    if (!lobby) {
      lobby = showLobby(
        (r) => conn.setReady(r),
        () => conn.requestStart(),
      );
      lobby.update(lobbyPlayers, hostId, conn.playerId);
    }
  },
  onLobby: (players: LobbyPlayer[], host: number) => {
    lobbyPlayers = players;
    hostId = host;
    lobby?.update(players, host, conn.playerId);
  },
  onStart: () => {
    closeResults?.();
    closeResults = null;
    lobby?.close();
    lobby = null;
    void startMatch();
  },
  onMap: (size: number, tiles: Uint8Array) => {
    // The host sends `start` then `map` back to back, but Pixi init is async,
    // so the map routinely lands before the renderer exists. Buffer it and
    // let startMatch apply it once the scene is up.
    pendingMap = { size, tiles };
    if (scene.ready) applyPendingMap();
  },
  onEnd: (standings: { id: number; name: string; gems: number }[]) => {
    running = false;
    hud?.destroy();
    hud = null;
    gemTag?.destroy();
    gemTag = null;
    draft?.close();
    draft = null;
    closeModeCard?.();
    closeModeCard = null;
    closeResults = showResults(standings, conn.playerId, conn.playerId === hostId, () => {
      conn.requestStart();
    });
  },
  onEvents: handleEvents,
  onClose: () => {
    lobby?.setError('Lost connection to the host. Reload to try again.');
  },
};

let start: ReturnType<typeof showJoin> | null = null;

void detectServer().then((hasServer) => {
  start = showJoin(hasServer, (choice) => {
    // Browsers refuse to start an AudioContext without a gesture; this is one.
    audio.unlock();
    audio.setMuted(localStorage.getItem('sa-muted') === '1');

    if (choice.mode === 'server') {
      conn.connect(new WebSocketTransport(socketUrl()), choice.name, listeners);
      return;
    }

    if (choice.mode === 'join') {
      start?.setBusy('Connecting to the room…');
      conn.connect(
        new PeerTransport(choice.code, (msg) => start?.setError(msg)),
        choice.name,
        listeners,
      );
      return;
    }

    // Hosting: this tab runs the authoritative Room and every other player
    // connects to it. We join our own room through a loopback transport, so
    // from here on the host is just another client.
    start?.setBusy('Opening a room…');
    const host = new BrowserHost({
      onReady: (code) => {
        roomCode?.close();
        roomCode = showRoomCode(code);
        conn.connect(host.loopback, choice.name, listeners);
        host.openLocalClient();
      },
      onError: (msg) => start?.setError(msg),
      onPeersChanged: () => {
        /* the lobby list already reflects this */
      },
    });
    browserHost = host;
    host.start();
  });
});

let pendingMap: { size: number; tiles: Uint8Array } | null = null;

function applyPendingMap(): void {
  if (!pendingMap || !scene.ready) return;
  scene.buildTerrain(pendingMap.size, pendingMap.tiles);
  minimap.setTerrain(pendingMap.size, pendingMap.tiles);
  mapSize = pendingMap.size;
  pendingMap = null;
}

let mapSize = 64;

async function startMatch(): Promise<void> {
  if (!scene.ready) {
    await scene.init(mount);
    controls.attach(scene.app.canvas as unknown as HTMLElement);
    window.addEventListener('resize', () => scene.resize());
  }
  applyPendingMap();
  scene.localTeam = conn.playerIndex;
  hud ??= createHud(() => {
    dashQueued = true;
  });
  gemTag ??= createGemTag();
  removeMute ??= createMuteButton(audio.isMuted, (m) => audio.setMuted(m));
  running = true;
}

// ── events -> VFX only, never state (§2.6) ──────────────────────────────────

function handleEvents(events: WorldEvent[]): void {
  for (const ev of events) {
    switch (ev.t) {
      case 'hit':
        // Ranged attacks fly; melee attacks lunge. The sim already resolved the
        // damage, so both are replays of a settled event and neither can miss.
        if (ev.ranged) {
          scene.spawnProjectile(ev.sx, ev.sy, ev.x, ev.y, 0xffe9a8);
        } else {
          scene.spawnSwing(ev.sx, ev.sy, ev.x, ev.y, 0xffd9a0);
          scene.spawnHit(ev.x, ev.y, 0xffd9a0);
        }
        audio.play('hit');
        break;
      case 'death':
        scene.spawnBurst(ev.x, ev.y, ev.kind === 'creep' ? 0x9aa3b5 : 0x8a6f4f, 7);
        audio.play('death');
        break;
      case 'gem':
        // Only our own pickups make a sound; eight players hoovering gems would
        // otherwise be a constant chime.
        if (ev.player === conn.playerId) {
          scene.spawnBurst(ev.x, ev.y, 0x56d9a3, 4);
          audio.play('pickup');
        }
        break;
      case 'fusion':
        scene.spawnBurst(ev.x, ev.y, ev.tier === 2 ? 0xffe27a : 0xffffff, 14);
        audio.play('fusion');
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
        if (ev.player === conn.playerId) audio.play('chest');
        break;
      case 'squadFight':
        scene.spawnBurst(ev.x, ev.y, 0xff6b6b, 16);
        audio.play(ev.loser === conn.playerId ? 'wipe' : 'death');
        break;
      case 'respawn':
        break;
      case 'summon':
        scene.spawnBurst(ev.x, ev.y, 0x9d8cff, 8);
        break;
      case 'rescue':
        scene.spawnBurst(ev.x, ev.y, 0xffe27a, 12);
        if (ev.player === conn.playerId) audio.play('pickup');
        break;
      case 'eliminated':
        if (ev.player === conn.playerId) audio.play('wipe');
        break;

      case 'draftOffer':
        if (ev.player === conn.playerId && !draft) {
          draft = showDraft(ev.options, (i) => {
            conn.sendDraftChoice(i);
            // Optimistic: the host confirms via `draftPick`, but a button that
            // does nothing for a round-trip feels broken on a slow link.
            draft?.markPicked(ev.options[i]!);
          });
        }
        break;
      case 'draftPick':
        if (ev.player === conn.playerId) draft?.markPicked(ev.unit);
        break;

      case 'phase':
        audio.play('phase');
        // Leaving the draft: drop the picker and announce the mode, which is
        // drawn per match and is the first thing a player needs to know.
        if (ev.phase === 'playing') {
          draft?.close();
          draft = null;
          closeModeCard?.();
          closeModeCard = showModeCard(conn.mode);
        }
        break;
    }
  }
}

// ── loop ────────────────────────────────────────────────────────────────────

let chestChoice: number | undefined;
let draft: ReturnType<typeof showDraft> | null = null;
let closeModeCard: (() => void) | null = null;
const minimapDots: { x: number; y: number; kind: string; team: number; mine: boolean }[] = [];
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
      conn.sendInput(input.dirX, input.dirY, step, chestChoice, dashQueued);
      chestChoice = undefined;
      dashQueued = false;
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
      const mode = GAME_MODES[conn.mode];

      // The draft panel normally opens on the `draftOffer` event, but events
      // are fire-and-forget VFX-grade delivery (§2.6) and the offer also rides
      // in every snapshot. Rebuilding it from snapshot state means a dropped
      // event costs a frame, not the player's entire pick.
      if (conn.phase === 'draft' && me?.draft && !draft) {
        const options = me.draft;
        draft = showDraft(options, (i) => {
          conn.sendDraftChoice(i);
          draft?.markPicked(options[i]!);
        });
      }
      if (draft) {
        draft.setRemaining(conn.timeRemaining);
        if (conn.phase !== 'draft') {
          draft.close();
          draft = null;
        }
      }

      hud.setTimer(conn.timeRemaining, conn.phase === 'lastCall');
      hud.setCoins(me?.c ?? 0);
      hud.setSquad(squadSize, conn.config.squadCap);
      hud.setMode(mode.label);
      hud.setDashCooldown(me?.dc ?? 0);

      // Gem count rides above your own character.
      if (gemTag) {
        const anchor = predicted ?? serverLeader;
        if (anchor) {
          const p = scene.worldToScreen(anchor.x, anchor.y - 0.85);
          gemTag.set(me?.g ?? 0, p.x, p.y);
        } else {
          gemTag.hide();
        }
      }

      // The scoreboard has to count whatever the mode counts. Showing gems in
      // Hatchling Run would rank players by an irrelevant number, and in duos
      // the pair shares one total, so partners must show the same figure.
      const scoreOf = (p: (typeof conn.players)[number]): number => {
        if (mode.winBy === 'collect') return p.r;
        if (mode.teamSize > 1) {
          return conn.players.filter((q) => q.a === p.a).reduce((n, q) => n + q.g, 0);
        }
        return p.g;
      };
      const rows = conn.players
        .map((p) => ({
          id: p.id,
          name: conn.names.get(p.id) ?? lobbyPlayers.find((l) => l.id === p.id)?.name ?? `P${p.id}`,
          gems: scoreOf(p),
          out: p.out,
        }))
        .sort((a, b) => Number(a.out) - Number(b.out) || b.gems - a.gems);
      hud.setScores(rows, conn.playerId);
      if (!pendingOffer) hud.hideOffer();

      // The code is only worth screen space while the host is still waiting.
      roomCode?.setVisible(conn.players.length < 2);
    }

    // Joystick visual — screen-space, driven straight off the input state.
    stick.update(
      input.stick.active,
      input.stick.originX,
      input.stick.originY,
      input.stick.x,
      input.stick.y,
    );

    // Minimap. Only leaders, gems and chests: unit dots at this scale are
    // an unreadable smear, and the leader is what you navigate by.
    minimapDots.length = 0;
    for (const e of view.values()) {
      if (e.kind !== 'leader' && e.kind !== 'gem' && e.kind !== 'chest') continue;
      minimapDots.push({
        x: e.x,
        y: e.y,
        kind: e.kind,
        team: e.team,
        mine: e.kind === 'leader' && e.team === conn.playerIndex,
      });
    }
    minimap.draw(minimapDots, mapSize);

    // Tell the player why their squad vanished — there was no feedback at all.
    if (me?.wiped) {
      banner.show('Squad wiped', 'Respawning at your home pad…');
    } else {
      banner.hide();
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

// Tear the room down on navigate-away so the signalling broker drops the room
// code immediately instead of holding it until its own timeout.
window.addEventListener('pagehide', () => {
  browserHost?.stop();
  conn.close();
});
