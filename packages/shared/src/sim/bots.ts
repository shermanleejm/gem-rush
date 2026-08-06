/**
 * Scripted bot policies for the balance harness (brief §4).
 *
 * Pure and headless like the rest of `sim/`, so the harness, tests and any
 * future practice mode all drive bots through the same code path a human input
 * would take: they only ever produce an `InputCommand`.
 *
 * The policies are deliberately simple and legible. They are not meant to play
 * well — they are meant to isolate *one* strategy each, so that when win rates
 * diverge you can attribute it to the strategy rather than to bot cleverness.
 */

import { MATCH } from '../config/match.ts';
import { MAP } from '../config/map.ts';
import type { Entity } from './entities.ts';
import type { InputCommand, PlayerState, World } from './world.ts';

export const BOT_POLICIES = ['greedyGem', 'chestHungry', 'aggressive', 'turtle'] as const;
export type BotPolicy = (typeof BOT_POLICIES)[number];

export interface Bot {
  playerId: number;
  policy: BotPolicy;
  /** Chest choice queued for the next tick, if the bot wants to buy. */
  pendingChoice?: number;
  /** Rotating preference so chest-hungry bots don't all build the same squad. */
  choiceBias: number;
}

export function makeBot(playerId: number, policy: BotPolicy, choiceBias = 0): Bot {
  return { playerId, policy, choiceBias };
}

function nearest(
  world: World,
  from: Entity,
  predicate: (e: Entity) => boolean,
): Entity | null {
  let best: Entity | null = null;
  let bestSq = Number.MAX_VALUE;
  for (const e of world.store.items) {
    if (!e.alive || !predicate(e)) continue;
    const dx = e.x - from.x;
    const dy = e.y - from.y;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestSq) {
      bestSq = dSq;
      best = e;
    }
  }
  return best;
}

function toward(from: Entity, tx: number, ty: number, seq: number): InputCommand {
  return { seq, dirX: tx - from.x, dirY: ty - from.y };
}

/**
 * One bot's input for this tick.
 *
 * Every policy also accepts a pending chest offer according to its appetite —
 * that is the lever the harness exists to measure, so it must be per-policy
 * rather than a shared default.
 */
export function botInput(world: World, bot: Bot, seq: number): InputCommand {
  const player = world.players.get(bot.playerId);
  if (!player) return { seq, dirX: 0, dirY: 0 };
  const leader = world.leaderOf(player);
  if (!leader) return { seq, dirX: 0, dirY: 0 };

  // Answer an outstanding chest offer first; it costs nothing to move as well.
  let chestChoice: number | undefined;
  if (player.offer) {
    if (wantsChest(bot, player, world)) {
      chestChoice = bot.choiceBias % player.offer.length;
    } else {
      // Declining is expressed by choosing nothing; the offer clears when the
      // leader walks off the chest.
      chestChoice = undefined;
    }
  }

  const move = movementFor(world, bot, player, leader, seq);
  return chestChoice === undefined ? move : { ...move, chestChoice };
}

function wantsChest(bot: Bot, player: PlayerState, world: World): boolean {
  const squadFull = world.squadOf(player.index).length >= MATCH.squadCap;
  if (squadFull) return false;
  if (player.gems < player.nextChestPrice) return false;

  switch (bot.policy) {
    case 'chestHungry':
      // Buys whenever it can afford to — the "always worth buying" extreme.
      return true;
    case 'aggressive':
      // Buys to win fights, but keeps a little banked.
      return player.gems >= player.nextChestPrice * 1.5;
    case 'greedyGem':
      // Buys only when very rich, so gems mostly stay banked as score.
      return player.gems >= player.nextChestPrice * 4;
    case 'turtle':
      // Never buys — this is the control that answers the M5 question
      // "can someone who never buys a chest still win?".
      return false;
  }
}

function movementFor(
  world: World,
  bot: Bot,
  player: PlayerState,
  leader: Entity,
  seq: number,
): InputCommand {
  const centre = MAP.size / 2;

  switch (bot.policy) {
    case 'greedyGem': {
      // Loose gems first, then whatever breakable is closest.
      const gem = nearest(world, leader, (e) => e.kind === 'gem' && e.pickupDelay <= 0);
      if (gem) return toward(leader, gem.x, gem.y, seq);
      const target = nearest(
        world,
        leader,
        (e) => e.kind === 'node' || e.kind === 'prop',
      );
      if (target) return toward(leader, target.x, target.y, seq);
      return toward(leader, centre, centre, seq);
    }

    case 'chestHungry': {
      // Beeline for chests it can afford; otherwise farm to afford one.
      if (player.gems >= player.nextChestPrice) {
        const chest = nearest(world, leader, (e) => e.kind === 'chest');
        if (chest) return toward(leader, chest.x, chest.y, seq);
      }
      const gem = nearest(world, leader, (e) => e.kind === 'gem' && e.pickupDelay <= 0);
      if (gem) return toward(leader, gem.x, gem.y, seq);
      const breakable = nearest(world, leader, (e) => e.kind === 'prop' || e.kind === 'node');
      if (breakable) return toward(leader, breakable.x, breakable.y, seq);
      return toward(leader, centre, centre, seq);
    }

    case 'aggressive': {
      // Hunt other players' squads; fall back to creep camps, then the centre.
      const enemy = nearest(
        world,
        leader,
        (e) => e.kind === 'unit' && e.team !== player.index,
      );
      if (enemy) return toward(leader, enemy.x, enemy.y, seq);
      const creep = nearest(world, leader, (e) => e.kind === 'creep');
      if (creep) return toward(leader, creep.x, creep.y, seq);
      return toward(leader, centre, centre, seq);
    }

    case 'turtle': {
      // Farm the safe outer ring and never contest the middle. This is the
      // §4 failure mode "turtling out-earns contesting" made measurable.
      const safe = nearest(
        world,
        leader,
        (e) =>
          (e.kind === 'gem' && e.pickupDelay <= 0) || e.kind === 'prop' || e.kind === 'node',
      );
      if (safe) {
        const dxc = safe.x - centre;
        const dyc = safe.y - centre;
        const distFromCentre = Math.hypot(dxc, dyc);
        if (distFromCentre > MAP.zoneRadii[1]!) return toward(leader, safe.x, safe.y, seq);
      }
      // Nothing safe nearby: orbit the rim.
      const angle = Math.atan2(leader.y - centre, leader.x - centre) + 0.25;
      const r = MAP.zoneRadii[2]!;
      return toward(leader, centre + Math.cos(angle) * r, centre + Math.sin(angle) * r, seq);
    }
  }
}
