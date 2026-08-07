/**
 * Battle Mods.
 *
 * A Mod is only real if it changes an outcome, so each test drives a World with
 * the Mod on and compares against the same World without it. Asserting that a
 * flag is set would pass forever while the sim quietly ignored it.
 */

import { describe, expect, it } from 'vitest';

import { MATCH, TICK_DT } from '../config/match.ts';
import {
  BATTLE_MODS,
  BATTLE_MOD_IDS,
  ROLLABLE_BATTLE_MODS,
  type BattleModId,
} from '../config/battleMods.ts';
import { MAX_TIER, UNIT_DEFS } from '../config/units.ts';
import { spawnProp, spawnUnit } from './spawning.ts';
import { World, type InputCommand } from './world.ts';

const idle = (ids: number[]): Map<number, InputCommand> =>
  new Map(ids.map((id) => [id, { seq: 1, dirX: 0, dirY: 0 }]));

/** A world with one player, already past the draft. */
function solo(mod: BattleModId, seed = 900): World {
  const w = new World(seed, 1, 'gemHunt', 'quarry', mod);
  w.addPlayer(1, 'P');
  w.start();
  return w;
}

/** Park the leader on a chest, take the first offer, return the new squad size. */
function buyOneChest(w: World): number {
  const p = w.players.get(1)!;
  const leader = w.leaderOf(p)!;
  p.coins = 9999;
  const chest = w.store.ofKind('chest')[0]!;
  leader.x = chest.x;
  leader.y = chest.y;
  for (let i = 0; i < 30; i++) {
    w.tick(idle([1]));
    if (p.offer) break;
  }
  const before = w.squadSize(p.index);
  w.tick(new Map([[1, { seq: 2, dirX: 0, dirY: 0, chestChoice: 0 }]]));
  return w.squadSize(p.index) - before;
}

describe('battle mods', () => {
  it('declares every id it lists, and rolls only real twists', () => {
    for (const id of BATTLE_MOD_IDS) expect(BATTLE_MODS[id].id).toBe(id);
    // `none` exists so callers always have something valid to read, but a real
    // match should always get a twist.
    expect(ROLLABLE_BATTLE_MODS).not.toContain('none');
    expect(ROLLABLE_BATTLE_MODS.length).toBe(BATTLE_MOD_IDS.length - 1);
    for (const id of BATTLE_MOD_IDS) {
      expect(BATTLE_MODS[id].label.length, `${id} needs a label`).toBeGreaterThan(0);
      expect(BATTLE_MODS[id].blurb.length, `${id} needs a blurb`).toBeGreaterThan(0);
    }
  });

  it('Double Trouble hands over two units per chest', () => {
    expect(buyOneChest(solo('none'))).toBe(1);
    expect(buyOneChest(solo('doubleTrouble'))).toBe(2);
  });

  it('Fusion Start begins you already fused', () => {
    expect(solo('none').squadOf(0)[0]!.tier).toBe(0);
    expect(solo('fusionStart').squadOf(0)[0]!.tier).toBe(1);
  });

  it('Baby Battle stops anything fusing', () => {
    const w = solo('babyBattle');
    const p = w.players.get(1)!;
    for (const u of w.squadOf(p.index)) w.store.despawn(u);
    // Enough copies to fuse several times over under normal rules.
    for (let i = 0; i < MATCH.fusionThreshold * 2; i++) {
      spawnUnit(w.store, p.index, 'brute', 0, 32 + i * 0.3, 32);
    }
    p.coins = 9999;
    buyOneChest(w);
    for (const u of w.squadOf(p.index)) expect(u.tier).toBe(0);
    // And the roster itself still allows fusion — the cap is the Mod's doing.
    expect(MAX_TIER).toBeGreaterThan(0);
  });

  it('1-Coin Chests ignores squad size and rarity', () => {
    const w = solo('oneCoinChests');
    const p = w.players.get(1)!;
    for (let i = 0; i < 6; i++) spawnUnit(w.store, p.index, 'brute', 0, 32 + i * 0.3, 32);
    w.tick(idle([1]));
    expect(w.chestPriceFor(p, 'common')).toBe(1);
    expect(w.chestPriceFor(p, 'epic')).toBe(1);
  });

  it('Epic Overload deals Epics regardless of the clock', () => {
    const w = solo('epicOverload');
    const p = w.players.get(1)!;
    p.coins = 9999;
    const leader = w.leaderOf(p)!;
    const chest = w.store.ofKind('chest')[0]!;
    leader.x = chest.x;
    leader.y = chest.y;
    for (let i = 0; i < 30 && !p.offer; i++) w.tick(idle([1]));
    expect(p.offer).toBeTruthy();
    // Zero elapsed time, so only Commons would normally be on the table.
    for (const t of p.offer!) expect(UNIT_DEFS[t].rarity).toBe('epic');
  });

  it('Gem Overload pays more for the same monster', () => {
    const gemsFromOneCreep = (mod: BattleModId): number => {
      const w = solo(mod);
      const p = w.players.get(1)!;
      const creep = w.store.ofKind('creep')[0]!;
      const leader = w.leaderOf(p)!;
      leader.x = creep.x;
      leader.y = creep.y - 1;
      // Leaders only harvest crates and ore, never monsters, so the kill has to
      // come from a unit standing on it.
      for (const u of w.squadOf(p.index)) w.store.despawn(u);
      const killer = spawnUnit(w.store, p.index, 'brute', 0, creep.x, creep.y - 0.6);
      killer.alliance = p.alliance;
      creep.hp = 1;
      let banked = 0;
      for (let i = 0; i < 120; i++) {
        w.tick(idle([1]));
        for (const ev of w.events) if (ev.t === 'gem') banked += ev.value;
      }
      return banked;
    };
    expect(gemsFromOneCreep('gemOverload')).toBeGreaterThan(gemsFromOneCreep('none'));
  });

  it('Loot Surge raises what scenery pays', () => {
    const gemsFromOneProp = (mod: BattleModId): number => {
      const w = solo(mod);
      const p = w.players.get(1)!;
      const leader = w.leaderOf(p)!;
      // Clear ambient breakables so only the measured prop can pay out.
      for (const e of w.store.items) {
        if (e.alive && (e.kind === 'prop' || e.kind === 'node' || e.kind === 'creep')) {
          w.store.despawn(e);
        }
      }
      const prop = spawnProp(w.store, leader.x + 0.8, leader.y);
      let banked = 0;
      for (let i = 0; i < 300; i++) {
        w.tick(idle([1]));
        for (const ev of w.events) if (ev.t === 'gem') banked += ev.value;
        if (banked > 0 && !w.store.get(prop.id) && w.store.count('gem') === 0) break;
      }
      return banked;
    };
    expect(gemsFromOneProp('lootSurge')).toBeGreaterThan(gemsFromOneProp('none'));
  });

  it('the spawn-more mods actually put more on the map', () => {
    const count = (mod: BattleModId, kind: 'prop' | 'tree' | 'node' | 'creep'): number =>
      solo(mod).store.count(kind);

    expect(count('pinataParty', 'prop')).toBeGreaterThan(count('none', 'prop'));
    expect(count('crystalForest', 'tree')).toBeGreaterThan(count('none', 'tree'));
    expect(count('superGemMine', 'node')).toBeGreaterThan(count('none', 'node'));
    expect(count('treeGiants', 'creep')).toBeGreaterThan(count('none', 'creep'));
    expect(count('lootGoblins', 'creep')).toBeGreaterThan(count('none', 'creep'));
  });

  it('Golem Meteors keeps dropping monsters in', () => {
    const w = solo('golemMeteors');
    const before = w.store.count('creep');
    const ticks = Math.ceil((BATTLE_MODS.golemMeteors.meteorIntervalSeconds * 3) / TICK_DT);
    let announced = 0;
    for (let i = 0; i < ticks; i++) {
      w.tick(idle([1]));
      for (const ev of w.events) if (ev.t === 'meteor') announced++;
    }
    expect(announced).toBeGreaterThanOrEqual(2);
    expect(w.store.count('creep')).toBeGreaterThan(before);
  });

  it('Chest Imposter sometimes pays nothing, and says so', () => {
    // Many purchases, because the dud is a chance rather than a certainty.
    let duds = 0;
    let real = 0;
    for (let seed = 0; seed < 40; seed++) {
      const w = solo('chestImposter', 500 + seed);
      const p = w.players.get(1)!;
      p.coins = 9999;
      const leader = w.leaderOf(p)!;
      const chest = w.store.ofKind('chest')[0]!;
      leader.x = chest.x;
      leader.y = chest.y;
      for (let i = 0; i < 30 && !p.offer; i++) w.tick(idle([1]));
      if (!p.offer) continue;
      w.tick(new Map([[1, { seq: 2, dirX: 0, dirY: 0, chestChoice: 0 }]]));
      for (const ev of w.events) {
        if (ev.t !== 'chestOpen') continue;
        if (ev.dud) duds++;
        else real++;
      }
    }
    expect(duds, 'no chest was ever a dud').toBeGreaterThan(0);
    expect(real, 'every chest was a dud').toBeGreaterThan(0);
  });

  it('charges for a dud all the same', () => {
    // The gamble only exists if a fake still costs you. Drive purchases until
    // one comes up fake, then check the coins went.
    for (let seed = 0; seed < 60; seed++) {
      const w = solo('chestImposter', 700 + seed);
      const p = w.players.get(1)!;
      p.coins = 9999;
      const leader = w.leaderOf(p)!;
      const chest = w.store.ofKind('chest')[0]!;
      leader.x = chest.x;
      leader.y = chest.y;
      for (let i = 0; i < 30 && !p.offer; i++) w.tick(idle([1]));
      if (!p.offer) continue;
      const coinsBefore = p.coins;
      const sizeBefore = w.squadSize(p.index);
      w.tick(new Map([[1, { seq: 2, dirX: 0, dirY: 0, chestChoice: 0 }]]));
      const dud = w.events.some((e) => e.t === 'chestOpen' && e.dud);
      if (!dud) continue;
      expect(p.coins).toBeLessThan(coinsBefore);
      expect(w.squadSize(p.index)).toBe(sizeBefore);
      return;
    }
    throw new Error('never rolled a dud chest across 60 attempts');
  });

  it('runs a full match under every mod without falling over', () => {
    for (const id of BATTLE_MOD_IDS) {
      const w = new World(4242, 4, 'gemHunt', 'quarry', id);
      for (let i = 0; i < 4; i++) w.addPlayer(i + 1, `P${i + 1}`);
      w.start();
      const ticks = Math.ceil(MATCH.matchSeconds / TICK_DT) + 10;
      for (let i = 0; i < ticks && w.phase !== 'ended'; i++) w.tick(idle([1, 2, 3, 4]));
      expect(w.phase, `${id} never finished`).toBe('ended');
      expect(w.standings(), `${id} lost players`).toHaveLength(4);
    }
  });
});
