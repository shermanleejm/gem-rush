/**
 * Wire protocol (brief §2.6).
 *
 * JSON for M0–M2 per the stack table; the shape is deliberately flat and
 * short-keyed so the eventual hand-written binary codec is a drop-in swap
 * behind encode/decode rather than a protocol redesign.
 */

import type { MatchConfig } from '../config/match.ts';
import type { GameModeId } from '../config/modes.ts';
import type { BattleModId } from '../config/battleMods.ts';
import type { MapId } from '../config/maps.ts';
import type { UnitTier, UnitType } from '../config/units.ts';
import type { EntityId } from '../sim/entities.ts';
import type { PlayerId, WorldEvent } from '../sim/world.ts';

// ── client -> host ──────────────────────────────────────────────────────────

export interface HelloMsg {
  t: 'hello';
  name: string;
  reconnectToken?: string;
}

export interface ReadyMsg {
  t: 'ready';
  ready: boolean;
}

export interface InputMsg {
  t: 'input';
  seq: number;
  /** Unit vector, or zero for "stop". */
  dirX: number;
  dirY: number;
  /** Index into the pending chest offer, when confirming a purchase. */
  chestChoice?: number;
  /** Index into the opening draft offer, when choosing a starting character. */
  draftChoice?: number;
  /** Set on the tick the player taps dash. The sim ignores it on cooldown. */
  dash?: boolean;
}

export interface StartRequestMsg {
  t: 'startRequest';
}

export type ClientMessage = HelloMsg | ReadyMsg | InputMsg | StartRequestMsg;

// ── host -> client ──────────────────────────────────────────────────────────

export interface LobbyPlayer {
  id: PlayerId;
  name: string;
  ready: boolean;
  connected: boolean;
}

export interface WelcomeMsg {
  t: 'welcome';
  playerId: PlayerId;
  reconnectToken: string;
  /** The host is the source of truth for tuning (§2.6). */
  config: MatchConfig;
  roomState: 'lobby' | 'playing' | 'ended';
}

export interface LobbyMsg {
  t: 'lobby';
  players: LobbyPlayer[];
  hostId: PlayerId;
}

export interface StartMsg {
  t: 'start';
  /** Which of the five fixed arenas this match is on. */
  map: MapId;
  seed: number;
  tick0: number;
  playerCount: number;
  /** Drawn at random per match; clients need it to render the right rules. */
  mode: GameModeId;
  /** The rule twist for this match, announced on the pre-match card. */
  battleMod: BattleModId;
  /** Index assigned to each player, so clients can colour teams consistently. */
  assignments: { id: PlayerId; index: number; name: string }[];
}

/** One entity's state on the wire. Short keys: this is the bulk of bandwidth. */
export interface EntityWire {
  i: EntityId;
  k: number;
  /** Position, quantised to 1/100 of a tile on encode. */
  x: number;
  y: number;
  /** Team index, -1 for neutral. */
  tm: number;
  /** Unit archetype index, -1 for non-units. */
  u: number;
  /** Tier. */
  tr: UnitTier;
  /** Current HP as a 0–255 fraction of max, so we never send maxHp. */
  h: number;
  /** Pickup value, only meaningful for gems and chests. */
  v: number;
}

export interface PlayerWire {
  id: PlayerId;
  g: number;
  /** Coins: spending money, shown top-right. */
  c: number;
  /** Dash cooldown as 0..1, where 0 is ready. */
  dc: number;
  /** Next chest price for this player. */
  p: number;
  offer?: UnitType[];
  /** Alliance index, so clients can colour duo partners as one side. */
  a: number;
  /** Knocked out for good. */
  out: boolean;
  /** The opening draft offer, present only during the draft phase. */
  draft?: UnitType[];
  /** The character this player drafted, once chosen. */
  starter?: UnitType;
}

export interface SnapshotMsg {
  t: 'snap';
  tick: number;
  /** Last input sequence the host has applied for this client. */
  ackSeq: number;
  /** Match seconds remaining. */
  time: number;
  phase: string;
  /** Full snapshot (join / every 100 ticks) vs delta. */
  full: boolean;
  entities: EntityWire[];
  /** Ids that died or left view since the last snapshot. */
  removed: EntityId[];
  players: PlayerWire[];
  events: WorldEvent[];
}

export interface MapMsg {
  t: 'map';
  size: number;
  /** Base64 of the tile array — sent once, it never changes mid-match. */
  tiles: string;
  homePads: { playerIndex: number; x: number; y: number }[];
}

export interface EndMsg {
  t: 'end';
  standings: { id: PlayerId; name: string; gems: number }[];
}

export interface ErrorMsg {
  t: 'error';
  message: string;
}

export type ServerMessage =
  | WelcomeMsg
  | LobbyMsg
  | StartMsg
  | SnapshotMsg
  | MapMsg
  | EndMsg
  | ErrorMsg;

// ── codec ───────────────────────────────────────────────────────────────────

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
