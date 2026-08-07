/**
 * One match instance (brief §2.3).
 *
 * Owns a World and turns world state into per-client snapshots. Everything
 * authoritative lives here; clients only ever send inputs.
 *
 * Transport-agnostic and dependency-free on purpose: this runs unchanged in the
 * Node host over WebSocket *and* in a browser tab acting as host over a WebRTC
 * DataChannel. That means no Buffer, no NodeJS types, and no timers — the
 * caller owns the clock and calls `advance(dt)`, because `setInterval` is not
 * in this package's lib and the two environments schedule differently anyway.
 */

import { MATCH, TICK_DT, TICK_RATE } from '../config/match.ts';
import { UNIT_TYPES } from '../config/units.ts';
import { BOT_POLICIES, botInput, makeBot, type Bot } from '../sim/bots.ts';
import { DEFAULT_MODE, eligibleModes, type GameModeId } from '../config/modes.ts';
import type {
  ClientMessage,
  EntityWire,
  PlayerWire,
  SnapshotMsg,
} from '../protocol/messages.ts';
import { ENTITY_KINDS } from '../sim/entities.ts';
import { World, type InputCommand, type PlayerId, type WorldEvent } from '../sim/world.ts';

/** Full resync anchor every 100 ticks (5s), per §2.6. */
const FULL_SNAPSHOT_INTERVAL = 100;

export interface RoomMember {
  id: PlayerId;
  name: string;
  ready: boolean;
  connected: boolean;
  reconnectToken: string;
  /** Latest input received; applied on the next tick. */
  input: InputCommand;
  /** Last snapshot we sent them, for delta encoding. */
  lastSent: Map<number, EntityWire>;
  lastFullTick: number;
  disconnectedAt: number | null;
}

export type Broadcast = (id: PlayerId, msg: unknown) => void;

/** Bot player ids start here, safely above any id handed to a real member. */
const BOT_ID_BASE = 10_000;

/** Filler names. Plain and clearly not people, so the scoreboard reads honestly. */
const BOT_NAMES = [
  'Rook',
  'Pip',
  'Vex',
  'Nim',
  'Bolt',
  'Wren',
  'Fig',
  'Dax',
];

const KIND_INDEX = new Map(ENTITY_KINDS.map((k, i) => [k, i]));
const UNIT_INDEX = new Map(UNIT_TYPES.map((u, i) => [u, i]));

export class Room {
  world: World | null = null;
  readonly members = new Map<PlayerId, RoomMember>();
  hostId: PlayerId | null = null;
  state: 'lobby' | 'playing' | 'ended' = 'lobby';

  private accumulator = 0;
  private nextPlayerId = 1;
  private seed = 0;
  /** The mode this match is running. Drawn at random in `start()`. */
  mode: GameModeId = DEFAULT_MODE;
  /**
   * Bots that pad the lobby out to a full house.
   *
   * A match with two humans in an eight-player arena is a very different — and
   * much duller — game than the one that was designed: nobody to bust, no
   * contest for the middle, and the map's whole yield to yourself. Filling the
   * remaining slots means the arena always plays the way it was balanced.
   */
  private bots: Bot[] = [];

  /** Rolling stats for the dev overlay and the §5 budget check. */
  stats = { tickMs: 0, snapshotBytes: 0, entities: 0 };

  /**
   * Written out rather than a `private readonly send: Broadcast` parameter
   * property: Node's --experimental-strip-types runs in strip-only mode, which
   * rejects parameter properties because they emit real code.
   */
  private readonly send: Broadcast;

  constructor(send: Broadcast) {
    this.send = send;
  }

  /**
   * Transport key (socket id, peer id, or "local") to player id.
   *
   * Owning this here rather than in each host is what stops the Node and
   * browser hosts drifting apart: they differ only in how bytes move, and both
   * funnel every client message through `handle()`.
   */
  private readonly keyToPlayer = new Map<string, PlayerId>();

  /** Route one decoded client message. Returns true if the lobby changed. */
  handle(key: string, msg: ClientMessage): boolean {
    switch (msg.t) {
      case 'hello': {
        const member = this.join(msg.name, msg.reconnectToken);
        this.keyToPlayer.set(key, member.id);
        this.send(member.id, {
          t: 'welcome',
          playerId: member.id,
          reconnectToken: member.reconnectToken,
          config: MATCH,
          roomState: this.state,
        });
        // A player arriving mid-match needs the map before snapshots mean
        // anything, so replay start+map to them immediately.
        if (this.state === 'playing' && this.world) {
          this.send(member.id, {
            t: 'start',
            seed: 0,
            tick0: this.world.tickNumber,
            playerCount: this.world.players.size,
            assignments: [...this.world.players.values()].map((p) => ({
              id: p.id,
              index: p.index,
              name: p.name,
            })),
          });
          this.send(member.id, this.mapPayload());
        }
        return true;
      }

      case 'ready': {
        const id = this.keyToPlayer.get(key);
        if (id === undefined) return false;
        this.setReady(id, msg.ready);
        return true;
      }

      case 'startRequest': {
        const id = this.keyToPlayer.get(key);
        // Only the host may start (§2.6).
        if (id === undefined || id !== this.hostId) return false;
        this.start();
        return true;
      }

      case 'input': {
        const id = this.keyToPlayer.get(key);
        if (id === undefined) return false;
        this.setInput(id, {
          seq: msg.seq,
          dirX: msg.dirX,
          dirY: msg.dirY,
          ...(msg.chestChoice !== undefined ? { chestChoice: msg.chestChoice } : {}),
          ...(msg.draftChoice !== undefined ? { draftChoice: msg.draftChoice } : {}),
        });
        return false;
      }
    }
  }

  /** A transport dropped. Returns true if the lobby changed. */
  detach(key: string): boolean {
    const id = this.keyToPlayer.get(key);
    if (id === undefined) return false;
    this.keyToPlayer.delete(key);
    this.markDisconnected(id);
    return true;
  }

  playerIdFor(key: string): PlayerId | undefined {
    return this.keyToPlayer.get(key);
  }

  /**
   * Transport key for a player, or undefined if they have none.
   *
   * Hosts must resolve their socket through this rather than keeping their own
   * playerId map: `handle()` sends `welcome` *during* the call, before it has
   * returned an id for the caller to record, so a host-side map is always one
   * message behind and silently drops the first one.
   */
  keyFor(playerId: PlayerId): string | undefined {
    for (const [key, id] of this.keyToPlayer) if (id === playerId) return key;
    return undefined;
  }

  // ── membership ────────────────────────────────────────────────────────────

  join(name: string, reconnectToken?: string): RoomMember {
    if (reconnectToken) {
      for (const m of this.members.values()) {
        if (m.reconnectToken === reconnectToken) {
          m.connected = true;
          m.disconnectedAt = null;
          m.name = name || m.name;
          return m;
        }
      }
    }

    const id = this.nextPlayerId++;
    const member: RoomMember = {
      id,
      name: name || `Player ${id}`,
      ready: false,
      connected: true,
      reconnectToken: `${id}-${Math.random().toString(36).slice(2, 10)}`,
      input: { seq: 0, dirX: 0, dirY: 0 },
      lastSent: new Map(),
      lastFullTick: -Infinity,
      disconnectedAt: null,
    };
    this.members.set(id, member);
    if (this.hostId === null) this.hostId = id;

    // A player who arrives mid-match spectates until the next round (§2.6).
    if (this.state === 'playing' && this.world) {
      member.ready = true;
    }
    return member;
  }

  markDisconnected(id: PlayerId): void {
    const m = this.members.get(id);
    if (!m) return;
    m.connected = false;
    m.disconnectedAt = Date.now();

    // In the lobby there is no squad worth preserving, so drop them outright.
    if (this.state !== 'playing') {
      this.members.delete(id);
      if (this.hostId === id) this.hostId = this.members.keys().next().value ?? null;
    }
  }

  setInput(id: PlayerId, input: InputCommand): void {
    const m = this.members.get(id);
    if (!m) return;
    // Ignore stale/replayed inputs; UDP-like reordering can't happen on a
    // WebSocket but a reconnect can replay an old seq.
    if (input.seq < m.input.seq) return;
    m.input = input;
  }

  setReady(id: PlayerId, ready: boolean): void {
    const m = this.members.get(id);
    if (m) m.ready = ready;
  }

  lobbyPayload() {
    return {
      t: 'lobby' as const,
      hostId: this.hostId ?? 0,
      players: [...this.members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        ready: m.ready,
        connected: m.connected,
      })),
    };
  }

  // ── match lifecycle ───────────────────────────────────────────────────────

  start(): void {
    if (this.state === 'playing') return;
    const participants = [...this.members.values()].filter((m) => m.connected);
    if (participants.length === 0) return;

    this.seed = (Math.random() * 0xffffffff) >>> 0;

    // One mode per match, drawn from those the current headcount supports —
    // duos need even teams, Showdown needs a crowd. Picking before the World
    // is built matters: the mode decides map contents (collectibles) and how
    // players are allied, both of which are fixed at construction.
    const choices = eligibleModes(participants.length);
    this.mode = choices[Math.floor(Math.random() * choices.length)] ?? DEFAULT_MODE;

    // Bots fill every empty seat. The world is sized for the full roster, not
    // just the humans, so home pads are spread for eight either way.
    const botCount = Math.max(0, MATCH.maxPlayers - participants.length);
    const total = participants.length + botCount;

    this.world = new World(this.seed, total, this.mode);
    for (const m of participants) {
      this.world.addPlayer(m.id, m.name);
      m.lastSent.clear();
      m.lastFullTick = -Infinity;
    }

    this.bots = [];
    for (let i = 0; i < botCount; i++) {
      // Ids sit above any human id so they can never collide with a member.
      const id = BOT_ID_BASE + i;
      const policy = BOT_POLICIES[i % BOT_POLICIES.length]!;
      this.world.addPlayer(id, BOT_NAMES[i % BOT_NAMES.length]!);
      this.bots.push(makeBot(id, policy, i));
    }
    // Opens the character draft; `World.start()` runs when everyone has picked.
    this.world.beginDraft();
    this.state = 'playing';

    const assignments = [...this.world.players.values()].map((p) => ({
      id: p.id,
      index: p.index,
      name: p.name,
    }));

    for (const m of this.members.values()) {
      this.send(m.id, {
        t: 'start',
        seed: this.seed,
        tick0: 0,
        playerCount: participants.length,
        mode: this.mode,
        map: this.world!.mapId,
        assignments,
      });
      this.send(m.id, this.mapPayload());
    }

  }

  mapPayload() {
    if (!this.world) return { t: 'map' as const, size: 0, tiles: '', homePads: [] };
    return {
      t: 'map' as const,
      size: this.world.map.size,
      tiles: toBase64(this.world.map.tiles),
      homePads: this.world.map.homePads,
    };
  }

  /** Reset to lobby for a rematch without restarting the host process (§M6). */
  reset(): void {
    this.world = null;
    this.bots = [];
    this.state = 'lobby';
    for (const m of this.members.values()) {
      m.ready = false;
      m.lastSent.clear();
      m.input = { seq: 0, dirX: 0, dirY: 0 };
    }
  }

  /**
   * Advance the match by `dtSeconds` of wall time, running whole fixed ticks.
   *
   * The caller drives this from whatever scheduler it has (setInterval in Node,
   * requestAnimationFrame or a worker timer in a browser). Elapsed time is
   * clamped so a stalled host — a closed laptop lid, a GC pause, a backgrounded
   * tab — resumes instead of trying to catch up with a burst of hundreds of
   * ticks all at once.
   */
  advance(dtSeconds: number): void {
    if (this.state !== 'playing') return;
    this.accumulator += Math.min(dtSeconds, 0.25);
    while (this.accumulator >= TICK_DT) {
      this.accumulator -= TICK_DT;
      this.step();
    }
  }

  private step(): void {
    const world = this.world;
    if (!world) return;

    this.dropExpiredReconnects();

    const inputs = new Map<PlayerId, InputCommand>();
    for (const m of this.members.values()) {
      if (m.connected) inputs.set(m.id, m.input);
    }
    for (const bot of this.bots) {
      inputs.set(bot.playerId, botInput(world, bot, world.tickNumber));
    }

    const t0 = Date.now();
    world.tick(inputs);
    this.stats.tickMs = Date.now() - t0;
    this.stats.entities = world.store.liveCount;

    // Chest choices are one-shot: clear after the tick that consumed them so
    // the player doesn't buy three chests from one tap.
    for (const m of this.members.values()) {
      if (m.input.chestChoice !== undefined || m.input.draftChoice !== undefined) {
        m.input = { ...m.input, chestChoice: undefined, draftChoice: undefined };
      }
    }

    this.broadcastSnapshots(world.events);

    if (world.phase === 'ended') {
      this.state = 'ended';
      const standings = world.standings();
      for (const m of this.members.values()) this.send(m.id, { t: 'end', standings });
    }
  }

  private dropExpiredReconnects(): void {
    const graceMs = MATCH.reconnectGraceSeconds * 1000;
    const now = Date.now();
    for (const [id, m] of this.members) {
      if (m.connected || m.disconnectedAt === null) continue;
      if (now - m.disconnectedAt < graceMs) continue;
      this.world?.removePlayer(id);
      this.members.delete(id);
      if (this.hostId === id) this.hostId = this.members.keys().next().value ?? null;
    }
  }

  // ── snapshots ─────────────────────────────────────────────────────────────

  private entityWire(e: {
    id: number;
    kind: string;
    x: number;
    y: number;
    team: number;
    unitType: string | null;
    tier: number;
    hp: number;
    maxHp: number;
    value: number;
  }): EntityWire {
    return {
      i: e.id,
      k: KIND_INDEX.get(e.kind as never) ?? 0,
      // Quantise to 1/100 tile: sub-centimetre precision is invisible at this
      // zoom and costs several bytes per entity per tick in JSON.
      x: Math.round(e.x * 100) / 100,
      y: Math.round(e.y * 100) / 100,
      tm: e.team,
      u: e.unitType ? (UNIT_INDEX.get(e.unitType as never) ?? -1) : -1,
      tr: e.tier as 0 | 1 | 2,
      h: e.maxHp > 0 ? Math.round((e.hp / e.maxHp) * 255) : 0,
      v: e.value,
    };
  }

  private broadcastSnapshots(events: WorldEvent[]): void {
    const world = this.world;
    if (!world) return;

    const current = new Map<number, EntityWire>();
    for (const e of world.store.items) {
      if (!e.alive) continue;
      current.set(e.id, this.entityWire(e));
    }

    const players: PlayerWire[] = [...world.players.values()].map((p) => ({
      id: p.id,
      g: p.gems,
      c: p.coins,
      dc: Math.max(0, Math.min(1, p.dashCooldown / MATCH.dashCooldownSeconds)),
      // The discounted price, since that is what the player will actually be
      // charged — showing the undiscounted one would make Suppliers look broken.
      p: world.chestPriceFor(p),
      wiped: p.wiped,
      a: p.alliance,
      r: p.rescued,
      out: p.eliminated,
      ...(p.offer ? { offer: p.offer } : {}),
      ...(p.draftOffer && !p.starterType ? { draft: p.draftOffer } : {}),
      ...(p.starterType ? { starter: p.starterType } : {}),
    }));

    let measured = 0;
    for (const m of this.members.values()) {
      if (!m.connected) continue;

      const wantFull = world.tickNumber - m.lastFullTick >= FULL_SNAPSHOT_INTERVAL;
      const entities: EntityWire[] = [];
      const removed: number[] = [];

      if (wantFull) {
        for (const wire of current.values()) entities.push(wire);
        m.lastFullTick = world.tickNumber;
      } else {
        for (const [id, wire] of current) {
          const prev = m.lastSent.get(id);
          if (!prev || !sameWire(prev, wire)) entities.push(wire);
        }
        for (const id of m.lastSent.keys()) {
          if (!current.has(id)) removed.push(id);
        }
      }

      const snap: SnapshotMsg = {
        t: 'snap',
        tick: world.tickNumber,
        ackSeq: m.input.seq,
        time: world.phase === 'draft' ? world.draftRemaining : world.timeRemaining,
        phase: world.phase,
        ...(Number.isFinite(world.ringRadius) ? { ring: world.ringRadius } : {}),
        full: wantFull,
        entities,
        removed,
        players,
        events,
      };

      const payload = JSON.stringify(snap);
      if (measured === 0) measured = payload.length;
      this.send(m.id, payload);

      m.lastSent = current;
    }
    this.stats.snapshotBytes = measured;
  }
}

/**
 * Base64 without Buffer or btoa.
 * Node has Buffer and browsers have btoa, but this package must not assume
 * either, and the tile array is sent once per match so the cost is irrelevant.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)]! : '=';
    out += i + 2 < bytes.length ? B64[c & 63]! : '=';
  }
  return out;
}

/** Cheap field-wise compare; the delta only needs to know "did anything move". */
function sameWire(a: EntityWire, b: EntityWire): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.h === b.h &&
    a.tr === b.tr &&
    a.u === b.u &&
    a.tm === b.tm &&
    a.v === b.v
  );
}

export const TICKS_PER_SECOND = TICK_RATE;
