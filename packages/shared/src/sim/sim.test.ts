import { describe, expect, it } from 'vitest';

import { MAP, TILE_WALL } from '../config/map.ts';
import { MATCH, TICK_DT } from '../config/match.ts';
import { UNIT_DEFS, gemMultiplier, speedBonus, unitMaxHp } from '../config/units.ts';
import { Rng } from '../math/rng.ts';
import { EntityStore } from './entities.ts';
import { applyFusions, type FusionResult } from './fusion.ts';
import { generateMap, isWallAt, tileIndex } from './mapgen.ts';
import { spawnUnit } from './spawning.ts';
import { World, type InputCommand } from './world.ts';

describe('Rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const seqA = Array.from({ length: 50 }, () => a.float());
    const seqB = Array.from({ length: 50 }, () => b.float());
    expect(seqA).toEqual(seqB);
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.float()).not.toBe(b.float());
  });

  it('stays in range', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 500; i++) {
      const f = rng.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = rng.int(3, 9);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThan(9);
    }
  });

  it('round-trips its state', () => {
    const rng = new Rng(99);
    rng.float();
    const saved = rng.getState();
    const expected = rng.float();
    rng.setState(saved);
    expect(rng.float()).toBe(expected);
  });
});

describe('stacking formulas (§1.6)', () => {
  // 0.3 is the baseline Supplier's gemBonus, so these are "n Suppliers".
  const suppliers = (n: number) => gemMultiplier(0.3 * n);

  it('supplier bonus diminishes and caps at +100%', () => {
    expect(suppliers(0)).toBe(1);
    const one = suppliers(1);
    const two = suppliers(2);
    const three = suppliers(3);
    expect(one).toBeCloseTo(1.35, 5);
    // Each additional Supplier adds strictly less than the previous one.
    expect(two - one).toBeLessThan(one - 1);
    expect(three - two).toBeLessThan(two - one);
    expect(suppliers(50)).toBeLessThanOrEqual(2);
  });

  it('weights suppliers by how much economy they actually bring', () => {
    // A Trader is worth appreciably more than a Wisp, which the old
    // count-the-units rule could not express at all.
    expect(gemMultiplier(UNIT_DEFS.trader.gemBonus)).toBeGreaterThan(
      gemMultiplier(UNIT_DEFS.wisp.gemBonus),
    );
  });

  it('speed aura caps at +25%', () => {
    expect(speedBonus(0)).toBe(0);
    expect(speedBonus(0.12)).toBeCloseTo(0.12, 5);
    expect(speedBonus(0.24)).toBeCloseTo(0.24, 5);
    expect(speedBonus(9)).toBe(0.25);
  });
});

describe('fusion (§1.4)', () => {
  it('fuses three identical base units into one of the next tier', () => {
    const store = new EntityStore();
    const squad = [
      spawnUnit(store, 0, 'brute', 0, 0, 0),
      spawnUnit(store, 0, 'brute', 0, 1, 0),
      spawnUnit(store, 0, 'brute', 0, 2, 0),
    ];
    const out: FusionResult[] = [];
    const after = applyFusions(store, squad, out);

    expect(out).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]!.tier).toBe(1);
    expect(after[0]!.maxHp).toBeCloseTo(unitMaxHp('brute', 1), 5);
    // Fusing heals to full — it should read as a reward.
    expect(after[0]!.hp).toBe(after[0]!.maxHp);
  });

  it('does not fuse across different types or tiers', () => {
    const store = new EntityStore();
    const squad = [
      spawnUnit(store, 0, 'brute', 0, 0, 0),
      spawnUnit(store, 0, 'golem', 0, 1, 0),
      spawnUnit(store, 0, 'archer', 0, 2, 0),
    ];
    const out: FusionResult[] = [];
    const after = applyFusions(store, squad, out);
    expect(out).toHaveLength(0);
    expect(after).toHaveLength(3);
  });

  it('cascades: nine base units become one elite', () => {
    const store = new EntityStore();
    const squad = Array.from({ length: 9 }, (_, i) =>
      spawnUnit(store, 0, 'brute', 0, i, 0),
    );
    const out: FusionResult[] = [];
    const after = applyFusions(store, squad, out);

    // 9 base -> 3 fused -> 1 elite
    expect(after).toHaveLength(1);
    expect(after[0]!.tier).toBe(2);
    expect(out).toHaveLength(4); // three tier-1 fusions plus one tier-2
  });

  it('stops at the elite tier', () => {
    const store = new EntityStore();
    const squad = Array.from({ length: 3 }, (_, i) => spawnUnit(store, 0, 'brute', 2, i, 0));
    const out: FusionResult[] = [];
    const after = applyFusions(store, squad, out);
    expect(out).toHaveLength(0);
    expect(after).toHaveLength(3);
  });
});

describe('mapgen (§1.8)', () => {
  it('is deterministic for a seed', () => {
    const a = generateMap(new Rng(42), 6);
    const b = generateMap(new Rng(42), 6);
    expect(Array.from(a.tiles)).toEqual(Array.from(b.tiles));
    expect(a.homePads).toEqual(b.homePads);
  });

  it('gives every player a home pad on open floor', () => {
    for (const seed of [1, 2, 3, 99, 12345]) {
      const map = generateMap(new Rng(seed), 8);
      expect(map.homePads).toHaveLength(8);
      for (const pad of map.homePads) {
        expect(isWallAt(map.tiles, pad.x, pad.y, map.size)).toBe(false);
      }
    }
  });

  it('seals the border so nothing can leave the arena', () => {
    const map = generateMap(new Rng(5), 4);
    for (let i = 0; i < map.size; i++) {
      expect(map.tiles[tileIndex(i, 0, map.size)]).toBe(TILE_WALL);
      expect(map.tiles[tileIndex(0, i, map.size)]).toBe(TILE_WALL);
      expect(map.tiles[tileIndex(i, map.size - 1, map.size)]).toBe(TILE_WALL);
      expect(map.tiles[tileIndex(map.size - 1, i, map.size)]).toBe(TILE_WALL);
    }
  });

  it('keeps every home pad connected to the centre', () => {
    // The contested centre must be reachable from every spawn, or a player is
    // locked out of the whole point of the map.
    for (const seed of [1, 7, 13, 256, 90210]) {
      const map = generateMap(new Rng(seed), 8);
      const seen = new Uint8Array(map.size * map.size);
      const start = tileIndex(Math.floor(map.size / 2), Math.floor(map.size / 2), map.size);
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const idx = stack.pop()!;
        const x = idx % map.size;
        const y = Math.floor(idx / map.size);
        for (const [nx, ny] of [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ] as const) {
          if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
          const n = tileIndex(nx, ny, map.size);
          if (seen[n] || map.tiles[n] === TILE_WALL) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      for (const pad of map.homePads) {
        const idx = tileIndex(Math.floor(pad.x), Math.floor(pad.y), map.size);
        expect(seen[idx], `seed ${seed} pad ${pad.playerIndex} unreachable`).toBe(1);
      }
    }
  });
});

describe('World', () => {
  function newWorld(players = 2): World {
    const w = new World(1337, players);
    for (let i = 0; i < players; i++) w.addPlayer(i + 1, `P${i + 1}`);
    w.start();
    return w;
  }

  const still = (): Map<number, InputCommand> => new Map();

  it('spawns the configured starting squad', () => {
    const w = newWorld(2);
    expect(w.squadOf(0)).toHaveLength(MATCH.startingUnitCount);
    expect(w.squadOf(1)).toHaveLength(MATCH.startingUnitCount);
  });

  it('populates the arena per config', () => {
    const w = newWorld(1);
    expect(w.store.count('prop')).toBe(MAP.props);
    expect(w.store.count('node')).toBe(MAP.resourceNodes);
    expect(w.store.count('chest')).toBe(MAP.chestSpawns);
    expect(w.store.count('creep')).toBe(MAP.creepCamps * MAP.creepsPerCamp);
  });

  it('moves the leader on input and never through walls', () => {
    const w = newWorld(1);
    const leader = w.leaderOf(w.players.get(1)!)!;
    const inputs = new Map<number, InputCommand>([[1, { seq: 1, dirX: 1, dirY: 0 }]]);
    for (let i = 0; i < 100; i++) w.tick(inputs);
    expect(isWallAt(w.map.tiles, leader.x, leader.y, w.map.size)).toBe(false);
  });

  it('is deterministic: same seed and inputs produce the same state', () => {
    const run = (): string => {
      const w = new World(2024, 2);
      w.addPlayer(1, 'A');
      w.addPlayer(2, 'B');
      w.start();
      const inputs = new Map<number, InputCommand>([
        [1, { seq: 1, dirX: 1, dirY: 0.3 }],
        [2, { seq: 1, dirX: -0.5, dirY: 1 }],
      ]);
      for (let i = 0; i < 200; i++) w.tick(inputs);
      return w.store.items
        .filter((e) => e.alive)
        .map((e) => `${e.id}:${e.kind}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp.toFixed(2)}`)
        .join('|');
    };
    expect(run()).toBe(run());
  });

  it('advances the clock and reaches last call then end', () => {
    const w = newWorld(1);
    const ticks = Math.ceil(MATCH.matchSeconds / TICK_DT) + 5;
    let sawLastCall = false;
    for (let i = 0; i < ticks; i++) {
      w.tick(still());
      if (w.phase === 'lastCall') sawLastCall = true;
    }
    expect(sawLastCall).toBe(true);
    expect(w.phase).toBe('ended');
    expect(w.timeRemaining).toBe(0);
  });

  it('banks gems when the leader walks over them', () => {
    const w = newWorld(1);
    const player = w.players.get(1)!;
    const leader = w.leaderOf(player)!;
    const gem = w.store.spawn('gem');
    gem.x = leader.x;
    gem.y = leader.y;
    gem.value = 5;
    gem.pickupDelay = 0;

    const before = player.gems;
    w.tick(still());
    expect(player.gems).toBe(before + 5);
    expect(w.store.get(gem.id)).toBeUndefined();
  });

  it('keeps the tick under the 3ms budget with a full lobby', () => {
    const w = new World(88, 8);
    for (let i = 0; i < 8; i++) w.addPlayer(i + 1, `P${i}`);
    w.start();
    // Fill every squad to the cap so this is the worst case from §5.
    for (let p = 0; p < 8; p++) {
      const leader = w.leaderOf(w.players.get(p + 1)!)!;
      while (w.squadOf(p).length < MATCH.squadCap) {
        spawnUnit(w.store, p, 'brute', 0, leader.x, leader.y);
      }
    }
    const inputs = new Map<number, InputCommand>();
    for (let i = 0; i < 8; i++) inputs.set(i + 1, { seq: 1, dirX: 1, dirY: 0 });

    for (let i = 0; i < 20; i++) w.tick(inputs); // warm up
    const start = performance.now();
    const N = 100;
    for (let i = 0; i < N; i++) w.tick(inputs);
    const perTick = (performance.now() - start) / N;

    expect(w.store.liveCount).toBeGreaterThan(150);
    // Generous vs the 3ms target: CI machines are slower and noisier than the
    // "mid laptop" the budget assumes. A regression to 10ms is still caught.
    expect(perTick).toBeLessThan(10);
  });
});
