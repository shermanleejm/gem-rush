/**
 * Client networking (brief §2.6).
 *
 * Three jobs:
 *  - keep a buffer of snapshots and render ~100ms in the past, interpolating
 *    between the two that straddle the render time
 *  - predict the local leader immediately and reconcile against ackSeq
 *  - surface events (hits, pickups, fusions) for VFX without deriving state
 *
 * Only the local leader is predicted. Squad units, other players, creeps and
 * props are pure interpolation — deliberately, per §2.6: followers are visually
 * forgiving and predicting them would cost a lot of complexity for no
 * perceived gain.
 */

import type { Transport } from './transport.ts';
import {
  ENTITY_KINDS,
  MATCH,
  UNIT_TYPES,
  type EntityWire,
  type LobbyPlayer,
  type MatchConfig,
  type PlayerWire,
  type GameModeId,
  DEFAULT_MODE,
  type BattleModId,
  DEFAULT_BATTLE_MOD,
  type ServerMessage,
  type SnapshotMsg,
  type UnitType,
  type WorldEvent,
} from '@gem-rush/shared';

/** Render this far behind the newest snapshot, in ms (§2.6). */
const BASE_INTERP_DELAY = 100;
const MAX_BUFFER = 40;

export interface ViewEntity {
  id: number;
  kind: string;
  x: number;
  y: number;
  team: number;
  unitType: UnitType | null;
  tier: number;
  /** 0..1 */
  hpFrac: number;
  value: number;
}

export interface NetStats {
  rtt: number;
  jitter: number;
  snapshotBytes: number;
  snapsPerSec: number;
  bytesPerSec: number;
  interpDelay: number;
  buffered: number;
}

interface TimedSnapshot {
  tick: number;
  /** Client receive time, ms. */
  at: number;
  entities: Map<number, EntityWire>;
}

type Listener = {
  onLobby?: (players: LobbyPlayer[], hostId: number) => void;
  onWelcome?: (playerId: number, config: MatchConfig, state: string) => void;
  onStart?: (assignments: { id: number; index: number; name: string }[], mode: GameModeId) => void;
  onMap?: (size: number, tiles: Uint8Array, pads: { x: number; y: number }[]) => void;
  onEnd?: (standings: { id: number; name: string; gems: number }[]) => void;
  onEvents?: (events: WorldEvent[]) => void;
  onClose?: () => void;
};

export class Connection {
  private transport: Transport | null = null;
  private buffer: TimedSnapshot[] = [];
  private seq = 0;
  private lastAckSeq = 0;

  /** Unacknowledged local inputs, replayed on top of the server position. */
  private pending: { seq: number; dirX: number; dirY: number; dt: number }[] = [];

  playerId = 0;
  playerIndex = 0;
  config: MatchConfig = MATCH;
  players: PlayerWire[] = [];
  /** Mode for the current match; the host draws it and tells us. */
  mode: GameModeId = DEFAULT_MODE;
  /** The twist rolled for this match. */
  battleMod: BattleModId = DEFAULT_BATTLE_MOD;
  phase = 'lobby';
  timeRemaining = 0;
  assignments = new Map<number, number>();
  /**
   * Display names for everyone in the match, bots included.
   *
   * The lobby list only ever contains connected members, so bots that fill the
   * empty seats have no entry there and would render as raw ids. The start
   * message carries the full roster, so that is where names come from.
   */
  names = new Map<number, string>();

  /** Predicted local leader position. */
  predicted = { x: 0, y: 0, valid: false };

  readonly stats: NetStats = {
    rtt: 0,
    jitter: 0,
    snapshotBytes: 0,
    snapsPerSec: 0,
    bytesPerSec: 0,
    interpDelay: BASE_INTERP_DELAY,
    buffered: 0,
  };

  /** Dev-panel latency injection (§M3). */
  simulate = { latencyMs: 0, jitterMs: 0, lossPct: 0 };

  private listener: Listener = {};
  private arrivalTimes: number[] = [];
  private byteWindow: { at: number; bytes: number }[] = [];
  private interpDelay = BASE_INTERP_DELAY;

  /**
   * Attach to a transport (WebSocket, WebRTC peer, or in-tab loopback).
   *
   * Connection is deliberately transport-blind: prediction, interpolation and
   * the snapshot buffer behave identically whether the authority is a Node
   * process across the internet or a Room running in this very tab.
   */
  connect(transport: Transport, name: string, listener: Listener): void {
    this.listener = listener;
    this.transport = transport;

    transport.onOpen = () => {
      const token = sessionStorage.getItem('sa-token');
      this.send({ t: 'hello', name, ...(token ? { reconnectToken: token } : {}) });
    };

    transport.onMessage = (raw) => {
      if (!raw) return;
      if (this.simulate.lossPct > 0 && Math.random() * 100 < this.simulate.lossPct) return;

      const delay =
        this.simulate.latencyMs + (Math.random() - 0.5) * 2 * this.simulate.jitterMs;
      if (delay > 0) {
        setTimeout(() => this.handle(raw), delay);
      } else {
        this.handle(raw);
      }
    };

    transport.onClose = () => this.listener.onClose?.();
  }

  private handle(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.config = msg.config;
        sessionStorage.setItem('sa-token', msg.reconnectToken);
        this.listener.onWelcome?.(msg.playerId, msg.config, msg.roomState);
        break;

      case 'lobby':
        this.listener.onLobby?.(msg.players, msg.hostId);
        break;

      case 'start':
        this.assignments.clear();
        this.names.clear();
        for (const a of msg.assignments) {
          this.assignments.set(a.id, a.index);
          this.names.set(a.id, a.name);
          if (a.id === this.playerId) this.playerIndex = a.index;
        }
        this.buffer.length = 0;
        this.predicted.valid = false;
        this.mode = msg.mode;
        this.battleMod = msg.battleMod;
        this.listener.onStart?.(msg.assignments, msg.mode);
        break;

      case 'map': {
        const bin = atob(msg.tiles);
        const tiles = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) tiles[i] = bin.charCodeAt(i);
        this.listener.onMap?.(msg.size, tiles, msg.homePads);
        break;
      }

      case 'snap':
        this.ingest(msg, raw.length);
        break;

      case 'end':
        this.listener.onEnd?.(msg.standings);
        break;
    }
  }

  private ingest(snap: SnapshotMsg, bytes: number): void {
    const now = performance.now();

    // Delta snapshots patch the previous frame; a full snapshot replaces it.
    const prev = this.buffer[this.buffer.length - 1];
    const entities = new Map<number, EntityWire>();
    if (!snap.full && prev) {
      for (const [id, e] of prev.entities) entities.set(id, e);
    }
    for (const e of snap.entities) entities.set(e.i, e);
    for (const id of snap.removed) entities.delete(id);

    this.buffer.push({ tick: snap.tick, at: now, entities });
    while (this.buffer.length > MAX_BUFFER) this.buffer.shift();

    this.players = snap.players;
    this.phase = snap.phase;
    this.timeRemaining = snap.time;
    this.lastAckSeq = snap.ackSeq;

    // Drop inputs the host has already applied; the rest get replayed.
    this.pending = this.pending.filter((p) => p.seq > snap.ackSeq);

    if (snap.events.length > 0) this.listener.onEvents?.(snap.events);

    this.trackStats(now, bytes);
  }

  /**
   * Adaptive interpolation delay (§2.6).
   * Grows the buffer when observed jitter exceeds it, so a bursty connection
   * doesn't produce visible snapping, and shrinks back when things calm down.
   */
  private trackStats(now: number, bytes: number): void {
    this.arrivalTimes.push(now);
    while (this.arrivalTimes.length > 30) this.arrivalTimes.shift();

    this.byteWindow.push({ at: now, bytes });
    while (this.byteWindow.length > 0 && now - this.byteWindow[0]!.at > 1000) {
      this.byteWindow.shift();
    }

    if (this.arrivalTimes.length > 2) {
      const gaps: number[] = [];
      for (let i = 1; i < this.arrivalTimes.length; i++) {
        gaps.push(this.arrivalTimes[i]! - this.arrivalTimes[i - 1]!);
      }
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
      const jitter = Math.sqrt(variance);
      this.stats.jitter = jitter;
      this.stats.snapsPerSec = mean > 0 ? 1000 / mean : 0;

      const target = Math.max(BASE_INTERP_DELAY, mean + jitter * 2.5);
      // Grow fast, shrink slow: a late snapshot is far more visible than a
      // slightly stale one.
      this.interpDelay += (target - this.interpDelay) * (target > this.interpDelay ? 0.3 : 0.02);
      this.stats.interpDelay = this.interpDelay;
    }

    this.stats.snapshotBytes = bytes;
    this.stats.bytesPerSec = this.byteWindow.reduce((a, b) => a + b.bytes, 0);
    this.stats.buffered = this.buffer.length;
  }

  // ── sending ───────────────────────────────────────────────────────────────

  send(msg: unknown): void {
    this.transport?.send(msg);
  }

  /**
   * Send a draft pick immediately, rather than waiting for the input pump.
   *
   * Movement rides a ~30 Hz pump driven by the render loop, which is the right
   * home for a continuously-changing value. A one-shot menu choice is not that:
   * routing it through the pump makes the pick depend on the render loop still
   * running, and browsers stop `requestAnimationFrame` whenever the tab is
   * hidden or the window occluded. A player who picks and then tabs away would
   * silently get the auto-pick instead. Sending on click removes the coupling.
   */
  sendDraftChoice(index: number): void {
    this.seq++;
    this.send({ t: 'input', seq: this.seq, dirX: 0, dirY: 0, draftChoice: index });
  }

  sendInput(
    dirX: number,
    dirY: number,
    dt: number,
    chestChoice?: number,
    dash?: boolean,
  ): void {
    this.seq++;
    this.pending.push({ seq: this.seq, dirX, dirY, dt });
    // Cap the replay list; if it grows this large the connection is gone and
    // replaying thousands of inputs would freeze the tab.
    if (this.pending.length > 120) this.pending.shift();
    this.send({
      t: 'input',
      seq: this.seq,
      dirX,
      dirY,
      ...(chestChoice !== undefined ? { chestChoice } : {}),
      ...(dash ? { dash: true } : {}),
    });
  }

  setReady(ready: boolean): void {
    this.send({ t: 'ready', ready });
  }

  requestStart(): void {
    this.send({ t: 'startRequest' });
  }

  // ── reading interpolated state ────────────────────────────────────────────

  /**
   * Interpolated world state at (now - interpDelay).
   * Writes into the supplied map to avoid allocating a new one every frame.
   */
  sample(out: Map<number, ViewEntity>): void {
    out.clear();
    if (this.buffer.length === 0) return;

    const renderAt = performance.now() - this.interpDelay;

    let older: TimedSnapshot | null = null;
    let newer: TimedSnapshot | null = null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const s = this.buffer[i]!;
      if (s.at <= renderAt) {
        older = s;
        newer = this.buffer[i + 1] ?? null;
        break;
      }
    }
    // Behind the whole buffer (just connected) or ahead of it (stalled feed):
    // clamp to the nearest end rather than showing nothing.
    if (!older) older = this.buffer[0]!;
    if (!newer) newer = this.buffer[this.buffer.length - 1]!;

    const span = newer.at - older.at;
    const t = span > 1e-3 ? Math.max(0, Math.min(1, (renderAt - older.at) / span)) : 1;

    for (const [id, a] of older.entities) {
      const b = newer.entities.get(id);
      const wire = b ?? a;
      out.set(id, {
        id,
        kind: ENTITY_KINDS[wire.k] ?? 'prop',
        x: b ? a.x + (b.x - a.x) * t : a.x,
        y: b ? a.y + (b.y - a.y) * t : a.y,
        team: wire.tm,
        unitType: wire.u >= 0 ? (UNIT_TYPES[wire.u] ?? null) : null,
        tier: wire.tr,
        hpFrac: wire.h / 255,
        value: wire.v,
      });
    }

    // Entities that only exist in the newer snapshot (just spawned) still need
    // to render, or gems pop in a frame late.
    for (const [id, b] of newer.entities) {
      if (out.has(id)) continue;
      out.set(id, {
        id,
        kind: ENTITY_KINDS[b.k] ?? 'prop',
        x: b.x,
        y: b.y,
        team: b.tm,
        unitType: b.u >= 0 ? (UNIT_TYPES[b.u] ?? null) : null,
        tier: b.tr,
        hpFrac: b.h / 255,
        value: b.v,
      });
    }
  }

  /**
   * Local leader position with prediction applied.
   *
   * Takes the authoritative position from the newest snapshot and replays every
   * input the host hasn't acknowledged. That makes local movement respond on
   * the frame the thumb moves, regardless of RTT.
   */
  predictLeader(serverX: number, serverY: number, speed: number): { x: number; y: number } {
    let x = serverX;
    let y = serverY;
    for (const p of this.pending) {
      const len = Math.hypot(p.dirX, p.dirY);
      if (len < 1e-6) continue;
      x += (p.dirX / len) * speed * p.dt;
      y += (p.dirY / len) * speed * p.dt;
    }

    if (!this.predicted.valid) {
      this.predicted.x = x;
      this.predicted.y = y;
      this.predicted.valid = true;
    } else {
      // Smooth the correction instead of snapping. A hard reconcile is very
      // visible when the host disagrees by a few centimetres every tick.
      const err = Math.hypot(x - this.predicted.x, y - this.predicted.y);
      const blend = err > 2 ? 1 : 0.25; // large desync (teleport/respawn) snaps
      this.predicted.x += (x - this.predicted.x) * blend;
      this.predicted.y += (y - this.predicted.y) * blend;
    }
    return this.predicted;
  }

  get ackSeq(): number {
    return this.lastAckSeq;
  }

  close(): void {
    this.transport?.close();
    this.transport = null;
  }
}
