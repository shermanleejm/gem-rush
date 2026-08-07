/**
 * Gameplay integration tests.
 *
 * These drive a real World for thousands of ticks and assert the loop from
 * §1.3 actually closes: break things -> gems drop -> gems bank -> chests buy
 * units -> units fuse. Unit tests cover the formulas; these cover the game.
 */

import { describe, expect, it } from 'vitest';

import { MATCH, TICK_DT } from '../config/match.ts';
import { PLAYABLE_UNIT_TYPES, RARITIES, STARTER_UNIT_TYPES, UNIT_DEFS } from '../config/units.ts';
import { chestPool, spawnProp, spawnUnit, unlockedRarities } from './spawning.ts';
import { World, type InputCommand } from './world.ts';

function input(dirX: number, dirY: number, seq = 1): Map<number, InputCommand> {
  return new Map([[1, { seq, dirX, dirY }]]);
}

describe('the core loop (§1.3)', () => {
  it('squad units destroy a prop and the leader banks the gems', () => {
    const world = new World(4242, 1);
    const player = world.addPlayer(1, 'Solo');
    world.start();

    const leader = world.leaderOf(player)!;
    // Put a prop right next to the leader so the starting Strikers reach it.
    const prop = spawnProp(world.store, leader.x + 0.9, leader.y);
    const propId = prop.id;

    let banked = 0;
    for (let i = 0; i < 400; i++) {
      world.tick(input(0, 0));
      for (const ev of world.events) if (ev.t === 'gem') banked += ev.value;
      if (banked > 0) break;
    }

    expect(world.store.get(propId), 'prop should have been destroyed').toBeUndefined();
    expect(banked).toBeGreaterThan(0);
    expect(player.gems).toBe(banked);
  });

  it('a chest is paid for in coins and never costs score', () => {
    const world = new World(77, 1);
    const player = world.addPlayer(1, 'Buyer');
    world.start();

    const leader = world.leaderOf(player)!;
    player.coins = 200;
    player.gems = 100;
    const coinsBefore = player.coins;
    const gemsBefore = player.gems;

    // Park the leader on a chest and accept the first offer.
    const chest = world.store.ofKind('chest')[0]!;
    leader.x = chest.x;
    leader.y = chest.y;

    let offered = false;
    for (let i = 0; i < 20 && !offered; i++) {
      world.tick(input(0, 0));
      offered = world.events.some((e) => e.t === 'chestOffer');
    }
    expect(offered, 'standing on a chest with enough gems should produce an offer').toBe(true);

    const squadBefore = world.squadOf(player.index).length;
    // Read the price on the tick it is charged: it is derived from squad size
    // now, so a value captured earlier would be stale the moment a unit spawns.
    const price = world.chestPriceFor(player);
    world.tick(new Map([[1, { seq: 2, dirX: 0, dirY: 0, chestChoice: 0 }]]));

    expect(player.coins).toBe(coinsBefore - price);
    // The whole point of splitting the currencies: buying must not touch score.
    expect(player.gems).toBe(gemsBefore);
    expect(world.squadOf(player.index).length).toBe(squadBefore + 1);
    // Escalating price is what stops chests being an auto-buy (§4) — and it now
    // escalates with the squad you are building, not with your purchase count.
    expect(world.chestPriceFor(player)).toBe(price + MATCH.chestPriceStep);
  });

  it('composition matters: Guard + Marksman beats an equal count of Strikers (§M4)', () => {
    // The brief's own acceptance criterion for M4. Runs both squads into each
    // other with no leader input and checks who is left standing.
    let mixedWins = 0;
    const trials = 12;

    for (let t = 0; t < trials; t++) {
      const world = new World(1000 + t, 2);
      const a = world.addPlayer(1, 'Mixed');
      const b = world.addPlayer(2, 'Strikers');
      world.start();

      // Clear the default squads so the matchup is exactly what we intend.
      for (const u of world.squadOf(a.index)) world.store.despawn(u);
      for (const u of world.squadOf(b.index)) world.store.despawn(u);

      const leaderA = world.leaderOf(a)!;
      const leaderB = world.leaderOf(b)!;
      // Face them off in open ground away from creeps and props.
      leaderA.x = 32;
      leaderA.y = 31;
      leaderB.x = 32;
      leaderB.y = 33;

      for (let i = 0; i < 2; i++) {
        spawnUnit(world.store, a.index, 'golem', 0, 32 + i * 0.4, 31.4);
        spawnUnit(world.store, a.index, 'archer', 0, 32 + i * 0.4, 30.6);
      }
      for (let i = 0; i < 4; i++) {
        spawnUnit(world.store, b.index, 'brute', 0, 32 + i * 0.4, 32.6);
      }

      const stand = new Map<number, InputCommand>([
        [1, { seq: 1, dirX: 0, dirY: 0 }],
        [2, { seq: 1, dirX: 0, dirY: 0 }],
      ]);

      for (let i = 0; i < 1200; i++) {
        world.tick(stand);
        const aLeft = world.squadOf(a.index).length;
        const bLeft = world.squadOf(b.index).length;
        if (aLeft === 0 || bLeft === 0) break;
      }
      if (world.squadOf(a.index).length > world.squadOf(b.index).length) mixedWins++;
    }

    // "Reliably beats" — allow the odd loss to positioning, but it must dominate.
    expect(mixedWins).toBeGreaterThanOrEqual(Math.ceil(trials * 0.75));
  });

  it('a full match runs to completion and produces a winner', () => {
    const world = new World(31337, 4);
    for (let i = 0; i < 4; i++) world.addPlayer(i + 1, `P${i + 1}`);
    world.start();

    const ticks = Math.ceil(MATCH.matchSeconds / TICK_DT) + 10;
    const centre = 32;

    for (let i = 0; i < ticks; i++) {
      const inputs = new Map<number, InputCommand>();
      for (let p = 0; p < 4; p++) {
        const state = world.players.get(p + 1)!;
        const leader = world.leaderOf(state);
        if (!leader) {
          inputs.set(p + 1, { seq: i, dirX: 0, dirY: 0 });
          continue;
        }
        // Head for the contested centre, orbiting once there. Players start on
        // the rim and the map is deliberately centre-biased (§1.8), so bots
        // that only wander locally never find anything to break — which is the
        // behaviour, not a bug, and would make this a vacuous test.
        const dx = centre - leader.x;
        const dy = centre - leader.y;
        const dist = Math.hypot(dx, dy);
        const orbit = Math.sin(i * 0.02 + p * 1.7);
        inputs.set(p + 1, {
          seq: i,
          dirX: dist > 6 ? dx : -dy * 0.6 + orbit,
          dirY: dist > 6 ? dy : dx * 0.6 + orbit,
        });
      }
      world.tick(inputs);
    }

    expect(world.phase).toBe('ended');
    const standings = world.standings();
    expect(standings).toHaveLength(4);
    // Ranked on `score`, which is what the mode actually counts — in duos that
    // is the pair's pooled total, so asserting on an individual's gems would
    // fail whenever the top pair's earner happens to be listed second.
    for (let i = 1; i < standings.length; i++) {
      expect(standings[i - 1]!.score).toBeGreaterThanOrEqual(standings[i]!.score);
    }
    expect(standings[0]!.score).toBeGreaterThan(0);
    // And the loop really closed: gems were banked by somebody.
    expect(standings.reduce((n, r) => n + r.gems, 0)).toBeGreaterThan(0);
  });

  it('rebuilds you instead of busting you during the opening grace', () => {
    // A bust twenty seconds into a four-minute match is three and a half
    // minutes of watching, which is a worse deal for the player than the rule
    // is worth that early.
    const world = new World(556, 2);
    const player = world.addPlayer(1, 'Early');
    world.addPlayer(2, 'Rival');
    world.start();
    expect(world.elapsed).toBeLessThan(MATCH.bustGraceSeconds);

    for (const u of world.squadOf(player.index)) world.store.despawn(u);
    world.tick(input(0, 0));

    expect(player.eliminated).toBe(false);
    expect(world.squadOf(player.index).length).toBe(MATCH.rebuildUnitCount);
    // And around the character they drafted, not somebody else's.
    for (const u of world.squadOf(player.index)) {
      expect(u.unitType).toBe(player.starterType);
    }
  });

  it('losing your whole squad busts you out of the match (§1.4)', () => {
    const world = new World(555, 2);
    const player = world.addPlayer(1, 'Wiped');
    world.addPlayer(2, 'Rival');
    world.start();
    // Past the opening grace, where a wipe would rebuild instead.
    world.elapsed = MATCH.bustGraceSeconds + 1;

    for (const u of world.squadOf(player.index)) world.store.despawn(u);
    world.tick(input(0, 0));
    expect(player.eliminated).toBe(true);

    // And stays out. There is no rebuild timer to wait through any more, so a
    // bust has to be permanent rather than a five-second inconvenience.
    for (let i = 0; i < 200; i++) world.tick(input(0, 0));
    expect(player.eliminated).toBe(true);
    expect(world.squadOf(player.index)).toHaveLength(0);
  });

  it('last call doubles gem value (§1.3)', () => {
    const world = new World(909, 1);
    const player = world.addPlayer(1, 'Late');
    world.start();

    // Jump to the last-call boundary. updatePhase advances elapsed before it
    // compares, so land exactly on the threshold and let one tick cross it.
    world.elapsed = MATCH.matchSeconds - MATCH.lastCallSeconds;
    world.tick(input(0, 0));
    expect(world.phase).toBe('lastCall');

    const leader = world.leaderOf(player)!;

    // Clear the arena's own breakables first. Leaders now smash crates they
    // walk into, so an untouched map feeds a steady trickle of ambient gems and
    // the first one banked is whichever crate happened to be underfoot — not
    // the one this test is measuring.
    for (const e of world.store.items) {
      if (e.alive && (e.kind === 'prop' || e.kind === 'node' || e.kind === 'creep')) {
        world.store.despawn(e);
      }
    }

    const prop = spawnProp(world.store, leader.x + 0.9, leader.y);
    const normalValue = prop.value;

    // Sum the whole drop rather than stopping at the first pickup: a payout is
    // scattered across several gems, and the smallest of them can be worth less
    // than the base on its own.
    let banked = 0;
    for (let i = 0; i < 400; i++) {
      world.tick(input(0, 0));
      for (const ev of world.events) if (ev.t === 'gem') banked += ev.value;
      if (banked > 0 && !world.store.get(prop.id) && world.store.count('gem') === 0) break;
    }
    // Zone multiplier also applies, so assert strictly greater than the base
    // rather than an exact doubling.
    expect(banked).toBeGreaterThan(normalValue);
  });
});

describe('unit definitions', () => {
  it('every archetype has coherent stats', () => {
    for (const [type, def] of Object.entries(UNIT_DEFS)) {
      expect(def.hp, `${type} hp`).toBeGreaterThan(0);
      expect(def.attackInterval, `${type} interval`).toBeGreaterThan(0);
      expect(def.radius, `${type} radius`).toBeGreaterThan(0);
      expect(def.speed, `${type} speed`).toBeGreaterThan(0);
      // A unit either deals damage or heals; one that does neither is a bug.
      expect(def.damage > 0 || def.healPerSecond > 0, `${type} does nothing`).toBe(true);
    }
  });

  it('chests offer Commons only until the later rarities unlock (§1.5)', () => {
    // The Common-only opening is what keeps an economy start viable: nobody can
    // buy a stat lead in the first minute, so farming crates is a real plan
    // rather than a slower way to lose.
    expect(unlockedRarities(0)).toEqual(['common']);

    const common = chestPool('common');
    expect(common.length).toBeGreaterThanOrEqual(MATCH.chestOfferCount);
    expect(common.length).toBeLessThan(PLAYABLE_UNIT_TYPES.length);
    expect(common.every((t) => UNIT_DEFS[t].rarity === 'common')).toBe(true);

    const late = unlockedRarities(MATCH.rarityUnlockSeconds.epic);
    expect(late).toContain('rare');
    expect(late).toContain('epic');
  });

  it('never offers summoned helpers in chests or the draft', () => {
    expect(PLAYABLE_UNIT_TYPES.some((t) => UNIT_DEFS[t].summonedOnly)).toBe(false);
    expect(STARTER_UNIT_TYPES.some((t) => UNIT_DEFS[t].summonedOnly)).toBe(false);
    // Every playable unit is reachable through some rarity, so nothing in the
    // roster is stranded where a chest can never offer it.
    const reachable = new Set(RARITIES.flatMap((r) => chestPool(r)));
    expect(reachable.size).toBe(PLAYABLE_UNIT_TYPES.length);
  });
});
