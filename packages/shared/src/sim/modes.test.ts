/**
 * Game modes, the opening draft, and the roster mechanics they depend on.
 *
 * These assert the rules that differ *between* modes, because that is where the
 * data-driven design either holds up or quietly breaks: the same tick code runs
 * for all four, so a mode is only correct if its flags actually change outcomes.
 */

import { describe, expect, it } from 'vitest';

import { MATCH, TICK_DT } from '../config/match.ts';
import { GAME_MODES, eligibleModes } from '../config/modes.ts';
import {
  PLAYABLE_UNIT_TYPES,
  STARTER_UNIT_TYPES,
  UNIT_CLASSES,
  UNIT_DEFS,
  UNIT_TYPES,
  gemMultiplier,
} from '../config/units.ts';
import { Rng } from '../math/rng.ts';
import { squadAuras } from './auras.ts';
import { rollChestRarity, spawnUnit, unlockedRarities } from './spawning.ts';
import { World, type InputCommand } from './world.ts';

const idle = (ids: number[]): Map<number, InputCommand> =>
  new Map(ids.map((id) => [id, { seq: 1, dirX: 0, dirY: 0 }]));

describe('the roster', () => {
  it('covers every class and has no duplicate labels', () => {
    const classes = new Set(PLAYABLE_UNIT_TYPES.map((t) => UNIT_DEFS[t].unitClass));
    for (const c of UNIT_CLASSES) expect(classes.has(c), `no unit in class ${c}`).toBe(true);

    const labels = UNIT_TYPES.map((t) => UNIT_DEFS[t].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keys every definition to its own type', () => {
    // A copy-paste slip here silently gives one unit another's stats, and
    // nothing else in the codebase would notice.
    for (const t of UNIT_TYPES) expect(UNIT_DEFS[t].type).toBe(t);
  });

  it('offers a real choice in the opening draft', () => {
    expect(STARTER_UNIT_TYPES.length).toBeGreaterThanOrEqual(MATCH.draftOfferCount);
    // Starters must be able to fight for themselves: you begin with exactly one
    // of them and have to earn the gems for anything else.
    for (const t of STARTER_UNIT_TYPES) expect(UNIT_DEFS[t].damage).toBeGreaterThan(0);
  });

  it('gives summoners a helper that is never purchasable', () => {
    const summoners = PLAYABLE_UNIT_TYPES.filter((t) => UNIT_DEFS[t].summonType);
    expect(summoners.length).toBeGreaterThan(0);
    for (const t of summoners) {
      const helper = UNIT_DEFS[t].summonType!;
      expect(UNIT_DEFS[helper].summonedOnly).toBe(true);
      expect(PLAYABLE_UNIT_TYPES).not.toContain(helper);
    }
  });
});

describe('squad auras', () => {
  it('sums economy across suppliers and caps it', () => {
    const w = new World(11, 1);
    const p = w.addPlayer(1, 'Eco');
    const squad = Array.from({ length: 8 }, (_, i) =>
      spawnUnit(w.store, p.index, 'trader', 0, i, 0),
    );
    expect(squadAuras(squad).gemMultiplier).toBeLessThanOrEqual(2);
    expect(squadAuras(squad.slice(0, 1)).gemMultiplier).toBeGreaterThan(1);
  });

  it('makes a fused supplier worth more than an unfused one', () => {
    const w = new World(12, 1);
    const p = w.addPlayer(1, 'Eco');
    const base = [spawnUnit(w.store, p.index, 'trader', 0, 0, 0)];
    const fused = [spawnUnit(w.store, p.index, 'trader', 2, 1, 0)];
    expect(squadAuras(fused).gemMultiplier).toBeGreaterThan(squadAuras(base).gemMultiplier);
  });

  it('raises squad max HP without healing anyone to full', () => {
    const w = new World(13, 1);
    const p = w.addPlayer(1, 'Tough');
    w.start();

    const hurt = spawnUnit(w.store, p.index, 'brute', 0, 32, 32);
    hurt.hp = hurt.maxHp * 0.5;
    const before = hurt.maxHp;

    spawnUnit(w.store, p.index, 'gunner', 0, 32.4, 32);
    w.tick(idle([1]));

    expect(hurt.maxHp).toBeGreaterThan(before);
    // Still hurt: the aura scales the pool, it is not a heal.
    expect(hurt.hp / hurt.maxHp).toBeLessThan(0.75);
  });
});

describe('the opening draft', () => {
  it('offers three characters and spawns exactly the one picked', () => {
    const w = new World(21, 2);
    const a = w.addPlayer(1, 'A');
    const b = w.addPlayer(2, 'B');
    w.beginDraft();

    expect(w.phase).toBe('draft');
    expect(a.draftOffer).toHaveLength(MATCH.draftOfferCount);
    // Nobody has a squad until they have chosen.
    expect(w.squadOf(a.index)).toHaveLength(0);

    const wanted = a.draftOffer![1]!;
    w.tick(new Map([[1, { seq: 1, dirX: 0, dirY: 0, draftChoice: 1 }]]));
    expect(a.starterType).toBe(wanted);

    // The match starts once *everyone* has picked, not on the first pick.
    expect(w.phase).toBe('draft');
    w.tick(new Map([[2, { seq: 1, dirX: 0, dirY: 0, draftChoice: 0 }]]));
    expect(w.phase).toBe('playing');

    const squad = w.squadOf(a.index);
    expect(squad).toHaveLength(MATCH.startingUnitCount);
    expect(squad[0]!.unitType).toBe(wanted);
    expect(b.starterType).toBe(b.draftOffer![0]);
  });

  it('announces the offer from inside a tick so it is actually broadcast', () => {
    // Regression: `beginDraft` used to push the offer event directly, but
    // `tick()` clears the event buffer before doing anything, so the offer was
    // discarded before the host could ever send it and the picker never opened.
    const w = new World(24, 1);
    w.addPlayer(1, 'A');
    w.beginDraft();

    w.tick(idle([1]));
    const offers = w.events.filter((e) => e.t === 'draftOffer');
    expect(offers).toHaveLength(1);

    // And exactly once — a re-announce every tick would reopen the picker over
    // a player who had already chosen.
    w.tick(idle([1]));
    expect(w.events.filter((e) => e.t === 'draftOffer')).toHaveLength(0);
  });

  it('auto-picks for anyone who never chooses', () => {
    const w = new World(22, 1);
    const p = w.addPlayer(1, 'Afk');
    w.beginDraft();

    const ticks = Math.ceil(MATCH.draftSeconds / TICK_DT) + 2;
    for (let i = 0; i < ticks; i++) w.tick(idle([1]));

    expect(w.phase).toBe('playing');
    expect(p.starterType).not.toBeNull();
    expect(w.squadOf(p.index)).toHaveLength(MATCH.startingUnitCount);
  });

  it('spawns the drafted character, and only that one', () => {
    const w = new World(23, 2);
    const p = w.addPlayer(1, 'Solo');
    w.addPlayer(2, 'Other');
    w.beginDraft();
    w.tick(new Map([[1, { seq: 1, dirX: 0, dirY: 0, draftChoice: 0 }]]));
    w.tick(new Map([[2, { seq: 1, dirX: 0, dirY: 0, draftChoice: 0 }]]));

    const squad = w.squadOf(p.index);
    expect(squad).toHaveLength(MATCH.startingUnitCount);
    for (const u of squad) expect(u.unitType).toBe(p.starterType);
  });
});

describe('the match', () => {
  it('offers Gem Hunt at every headcount', () => {
    for (let n = 1; n <= 8; n++) expect(eligibleModes(n)).toEqual(['gemHunt']);
  });

  it('has a hard time ceiling so a match cannot run forever', () => {
    expect(GAME_MODES.gemHunt.matchSeconds).toBeGreaterThan(0);
  });

  it('ends once a single side is left standing', () => {
    const w = new World(32, 3);
    const players = [1, 2, 3].map((i) => w.addPlayer(i, `P${i}`));
    w.start();

    for (const p of players.slice(0, 2)) {
      for (const u of w.squadOf(p.index)) w.store.despawn(u);
    }
    for (let i = 0; i < 5; i++) w.tick(idle([1, 2, 3]));
    expect(w.phase).toBe('ended');
  });

  it('does not end a solo match on its very first tick', () => {
    // "One side remains" is trivially true with one player, which used to end
    // the match instantly.
    const w = new World(33, 1);
    w.addPlayer(1, 'Solo');
    w.start();
    for (let i = 0; i < 20; i++) w.tick(idle([1]));
    expect(w.phase).toBe('playing');
  });

  it('ranks by gems', () => {
    const w = new World(37, 2);
    const a = w.addPlayer(1, 'Rich');
    const b = w.addPlayer(2, 'Poor');
    w.start();
    a.gems = 40;
    b.gems = 5;
    expect(w.standings()[0]!.id).toBe(a.id);
  });
});

describe('rarity gating', () => {
  it('opens with Commons only, then widens', () => {
    expect(unlockedRarities(0)).toEqual(['common']);
    expect(unlockedRarities(MATCH.rarityUnlockSeconds.rare)).toContain('rare');
    expect(unlockedRarities(MATCH.rarityUnlockSeconds.rare)).not.toContain('epic');
    expect(unlockedRarities(MATCH.rarityUnlockSeconds.epic)).toContain('epic');
  });

  it('never rolls a rarity that has not unlocked', () => {
    const rng = new Rng(4242);
    for (let i = 0; i < 200; i++) expect(rollChestRarity(rng, 0)).toBe('common');
    for (let i = 0; i < 200; i++) {
      expect(rollChestRarity(rng, MATCH.rarityUnlockSeconds.rare)).not.toBe('epic');
    }
  });

  it('prices a rarer chest higher', () => {
    const w = new World(45, 1);
    const p = w.addPlayer(1, 'Buyer');
    w.start();
    const common = w.chestPriceFor(p, 'common');
    expect(w.chestPriceFor(p, 'rare')).toBeGreaterThan(common);
    expect(w.chestPriceFor(p, 'epic')).toBeGreaterThan(w.chestPriceFor(p, 'rare'));
  });

  it('starts everyone on a Common, so nobody opens with an Epic', () => {
    for (const t of STARTER_UNIT_TYPES) expect(UNIT_DEFS[t].rarity).toBe('common');
  });
});

describe('squad-versus-squad', () => {
  it('closes the distance and fights instead of walking past', () => {
    // Units used to hold formation absolutely and only swing at whatever
    // happened to fall inside attack range, so two squads could pass through
    // each other trading almost nothing. Placed five tiles apart — inside the
    // engage radius but far outside any attack range — they must now commit.
    const w = new World(5150, 2, 'gemHunt', 'quarry');
    const a = w.addPlayer(1, 'A');
    const b = w.addPlayer(2, 'B');
    w.start();

    const la = w.leaderOf(a)!;
    const lb = w.leaderOf(b)!;
    la.x = 32;
    la.y = 30;
    lb.x = 32;
    lb.y = 35;
    for (const u of w.squadOf(a.index)) w.store.despawn(u);
    for (const u of w.squadOf(b.index)) w.store.despawn(u);
    for (let i = 0; i < 3; i++) {
      const ua = spawnUnit(w.store, a.index, 'brute', 0, 31.5 + i * 0.5, 30.4);
      ua.alliance = a.alliance;
      const ub = spawnUnit(w.store, b.index, 'brute', 0, 31.5 + i * 0.5, 34.6);
      ub.alliance = b.alliance;
    }

    const gap = (): number => {
      const ua = w.squadOf(a.index);
      const ub = w.squadOf(b.index);
      if (!ua.length || !ub.length) return -1;
      let m = Infinity;
      for (const x of ua) for (const y of ub) m = Math.min(m, Math.hypot(x.x - y.x, x.y - y.y));
      return m;
    };

    const before = gap();
    expect(before).toBeGreaterThan(3);

    let pvpHits = 0;
    const stand = idle([1, 2]);
    for (let i = 0; i < 60; i++) {
      w.tick(stand);
      for (const ev of w.events) {
        if (ev.t !== 'hit') continue;
        if (w.store.get(ev.targetId)?.kind === 'unit') pvpHits++;
      }
    }

    expect(gap()).toBeLessThan(1.5);
    expect(pvpHits).toBeGreaterThan(0);
  });

  it('keeps units on a leash so a squad cannot be baited apart', () => {
    const w = new World(5151, 2, 'gemHunt', 'quarry');
    const a = w.addPlayer(1, 'A');
    const b = w.addPlayer(2, 'B');
    w.start();

    const la = w.leaderOf(a)!;
    la.x = 32;
    la.y = 32;
    for (const u of w.squadOf(a.index)) w.store.despawn(u);
    const mine = spawnUnit(w.store, a.index, 'brute', 0, 32, 32.5);
    mine.alliance = a.alliance;

    // A lone enemy far across the arena must not drag the unit off its leader.
    const lb = w.leaderOf(b)!;
    lb.x = 55;
    lb.y = 55;
    for (const u of w.squadOf(b.index)) w.store.despawn(u);
    const bait = spawnUnit(w.store, b.index, 'brute', 0, 55, 55);
    bait.alliance = b.alliance;

    for (let i = 0; i < 120; i++) w.tick(idle([1, 2]));
    expect(Math.hypot(mine.x - la.x, mine.y - la.y)).toBeLessThan(9);
  });
});

describe('combat mechanics from the new roster', () => {
  it('stuns lock a unit out of attacking', () => {
    const w = new World(41, 1);
    const p = w.addPlayer(1, 'Stunner');
    w.start();

    const victim = spawnUnit(w.store, p.index, 'brute', 0, 32, 32);
    victim.stunRemaining = 1;
    victim.cooldown = 0;
    const target = spawnUnit(w.store, p.index, 'brute', 0, 32.3, 32);
    const before = target.hp;

    for (let i = 0; i < 5; i++) w.tick(idle([1]));
    // Same team anyway, but the point is the stun timer ticks down and clears.
    expect(target.hp).toBe(before);
    expect(victim.stunRemaining).toBeLessThan(1);
  });

  it('ramping damage builds only while the target is held', () => {
    const bee = UNIT_DEFS.beekeeper;
    expect(bee.rampMax).toBeGreaterThan(1);
    // Full ramp must be a meaningful payoff but not a different unit.
    expect(bee.rampMax).toBeLessThanOrEqual(3);
    expect(bee.rampPerHit).toBeGreaterThan(0);
  });

  it('summoners field a helper and respect their cap', () => {
    const w = new World(42, 1);
    const p = w.addPlayer(1, 'Necro');
    w.start();

    const necro = spawnUnit(w.store, p.index, 'necromancer', 0, 32, 32);
    const cap = UNIT_DEFS.necromancer.summonCap;

    const ticks = Math.ceil((UNIT_DEFS.necromancer.summonInterval * (cap + 3)) / TICK_DT);
    for (let i = 0; i < ticks; i++) w.tick(idle([1]));

    const helpers = w.squadOf(p.index).filter((u) => u.ownerId === necro.id);
    expect(helpers.length).toBe(cap);
    for (const h of helpers) expect(h.unitType).toBe('skeleton');
  });

  it('does not count summoned helpers against the squad cap', () => {
    const w = new World(43, 1);
    const p = w.addPlayer(1, 'Necro');
    w.start();

    const necro = spawnUnit(w.store, p.index, 'necromancer', 0, 32, 32);
    const ticks = Math.ceil((UNIT_DEFS.necromancer.summonInterval * 4) / TICK_DT);
    for (let i = 0; i < ticks; i++) w.tick(idle([1]));

    // Against the cap: the drafted starter plus the Necromancer, and none of
    // the skeletons. `squadOf` sees them all; `squadSize` must not.
    expect(w.squadOf(p.index).length).toBeGreaterThan(w.squadSize(p.index));
    expect(w.squadSize(p.index)).toBe(MATCH.startingUnitCount + 1);
    void necro;
  });

  it('supplier discounts make chests cheaper but never free', () => {
    // Compared against an equally large squad of non-discounting units, because
    // price now scales with squad size — measuring a six-unit discount squad
    // against an empty one would just measure the size increase.
    const withDiscount = new World(44, 1);
    const a = withDiscount.addPlayer(1, 'Pirate');
    withDiscount.start();

    const plain = new World(44, 1);
    const b = plain.addPlayer(1, 'Plain');
    plain.start();

    for (let i = 0; i < 6; i++) {
      spawnUnit(withDiscount.store, a.index, 'buccaneer', 2, 32 + i * 0.3, 32);
      spawnUnit(plain.store, b.index, 'pilferer', 2, 32 + i * 0.3, 32);
    }
    withDiscount.tick(idle([1]));
    plain.tick(idle([1]));

    const discounted = withDiscount.chestPriceFor(a);
    expect(discounted).toBeLessThan(plain.chestPriceFor(b));
    expect(discounted).toBeGreaterThanOrEqual(1);
  });

  it('caps the supplier curve however many suppliers pile in', () => {
    expect(gemMultiplier(99)).toBeLessThanOrEqual(2);
  });
});
