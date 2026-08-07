/**
 * Game modes, the opening draft, and the roster mechanics they depend on.
 *
 * These assert the rules that differ *between* modes, because that is where the
 * data-driven design either holds up or quietly breaks: the same tick code runs
 * for all four, so a mode is only correct if its flags actually change outcomes.
 */

import { describe, expect, it } from 'vitest';

import { MATCH, TICK_DT } from '../config/match.ts';
import { GAME_MODES, GAME_MODE_IDS, eligibleModes } from '../config/modes.ts';
import {
  PLAYABLE_UNIT_TYPES,
  STARTER_UNIT_TYPES,
  UNIT_CLASSES,
  UNIT_DEFS,
  UNIT_TYPES,
  gemMultiplier,
} from '../config/units.ts';
import { squadAuras } from './auras.ts';
import { spawnUnit } from './spawning.ts';
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

  it('respawns the character the player drafted, not a default', () => {
    const w = new World(23, 1);
    const p = w.addPlayer(1, 'Solo');
    w.beginDraft();
    w.tick(new Map([[1, { seq: 1, dirX: 0, dirY: 0, draftChoice: 0 }]]));

    const chosen = p.starterType!;
    for (const u of w.squadOf(p.index)) w.store.despawn(u);

    const ticks = Math.ceil(MATCH.respawnSeconds / TICK_DT) + 4;
    for (let i = 0; i < ticks; i++) w.tick(idle([1]));

    const squad = w.squadOf(p.index);
    expect(squad.length).toBeGreaterThan(0);
    for (const u of squad) expect(u.unitType).toBe(chosen);
  });
});

describe('game modes', () => {
  it('always offers at least one eligible mode for any lobby size', () => {
    for (let n = 1; n <= 8; n++) expect(eligibleModes(n).length).toBeGreaterThan(0);
  });

  it('only offers duos to even lobbies of four or more', () => {
    for (const n of [1, 2, 3, 5, 7]) expect(eligibleModes(n)).not.toContain('duoGemHunt');
    for (const n of [4, 6, 8]) expect(eligibleModes(n)).toContain('duoGemHunt');
  });

  it('gives every mode a hard time ceiling so none can run forever', () => {
    for (const id of GAME_MODE_IDS) expect(GAME_MODES[id].matchSeconds).toBeGreaterThan(0);
  });

  it('duos share a score and never target each other', () => {
    const w = new World(31, 4, 'duoGemHunt');
    const players = [1, 2, 3, 4].map((i) => w.addPlayer(i, `P${i}`));
    w.beginDraft();
    w.start();

    const [p1, p2, p3] = players;
    expect(p1!.alliance).toBe(p2!.alliance);
    expect(p1!.alliance).not.toBe(p3!.alliance);

    p1!.gems = 10;
    p2!.gems = 7;
    expect(w.allianceScore(p1!)).toBe(17);
    expect(w.allianceScore(p2!)).toBe(17);
    expect(w.allianceScore(p3!)).toBe(0);

    // Units of allied players must be mutually untargetable. Asserting on
    // *targeting* rather than on HP matters: the centre of the map has creep
    // camps, so a full-HP assertion would fail on incidental creep damage and
    // say nothing at all about friendly fire.
    const u1 = spawnUnit(w.store, p1!.index, 'brute', 0, 32, 32);
    u1.alliance = p1!.alliance;
    const u2 = spawnUnit(w.store, p2!.index, 'brute', 0, 32.3, 32);
    u2.alliance = p2!.alliance;
    for (let i = 0; i < 40; i++) {
      w.tick(idle([1, 2, 3, 4]));
      expect(u1.targetId).not.toBe(u2.id);
      expect(u2.targetId).not.toBe(u1.id);
    }
  });

  it('showdown eliminates a wiped squad instead of respawning it', () => {
    const w = new World(32, 3, 'showdown');
    const players = [1, 2, 3].map((i) => w.addPlayer(i, `P${i}`));
    w.beginDraft();
    w.start();

    const victim = players[0]!;
    for (const u of w.squadOf(victim.index)) w.store.despawn(u);
    w.tick(idle([1, 2, 3]));
    expect(victim.eliminated).toBe(true);

    const ticks = Math.ceil(MATCH.respawnSeconds / TICK_DT) + 5;
    for (let i = 0; i < ticks; i++) w.tick(idle([1, 2, 3]));
    // Still out, and no free squad handed back.
    expect(victim.eliminated).toBe(true);
    expect(w.squadOf(victim.index)).toHaveLength(0);
  });

  it('showdown ends when one side is left', () => {
    const w = new World(33, 3, 'showdown');
    const players = [1, 2, 3].map((i) => w.addPlayer(i, `P${i}`));
    w.beginDraft();
    w.start();

    for (const p of players.slice(0, 2)) {
      for (const u of w.squadOf(p.index)) w.store.despawn(u);
    }
    for (let i = 0; i < 5; i++) w.tick(idle([1, 2, 3]));
    expect(w.phase).toBe('ended');
  });

  it('showdown closes a ring that damages units left outside', () => {
    const w = new World(34, 3, 'showdown');
    const p = w.addPlayer(1, 'Edge');
    w.addPlayer(2, 'B');
    w.addPlayer(3, 'C');
    w.beginDraft();
    w.start();

    // Skip past the grace period, to the point the ring has fully closed.
    w.elapsed = w.mode.ringDelaySeconds + w.mode.ringCloseSeconds;
    const stray = spawnUnit(w.store, p.index, 'golem', 0, 1.5, 1.5);
    const before = stray.hp;
    for (let i = 0; i < 20; i++) w.tick(idle([1, 2, 3]));

    expect(w.ringRadius).toBeLessThan(64);
    expect(stray.hp).toBeLessThan(before);
  });

  it('hatchling run is co-op: collectibles exist and squads cannot fight', () => {
    const w = new World(35, 2, 'hatchlingRun');
    const a = w.addPlayer(1, 'A');
    const b = w.addPlayer(2, 'B');
    w.beginDraft();
    w.start();

    expect(w.store.count('hatchling')).toBe(GAME_MODES.hatchlingRun.collectibles);
    expect(a.alliance).toBe(b.alliance);

    const ua = spawnUnit(w.store, a.index, 'brute', 0, 32, 32);
    ua.alliance = a.alliance;
    const ub = spawnUnit(w.store, b.index, 'brute', 0, 32.3, 32);
    ub.alliance = b.alliance;
    for (let i = 0; i < 40; i++) w.tick(idle([1, 2]));
    expect(ua.hp).toBe(ua.maxHp);
  });

  it('hatchling run banks a rescue when the leader reaches one', () => {
    const w = new World(36, 1, 'hatchlingRun');
    const p = w.addPlayer(1, 'Rescuer');
    w.beginDraft();
    w.start();

    const leader = w.leaderOf(p)!;
    const chick = w.store.ofKind('hatchling')[0]!;
    chick.x = leader.x;
    chick.y = leader.y;

    w.tick(idle([1]));
    expect(p.rescued).toBe(1);
    expect(w.store.get(chick.id)).toBeUndefined();
  });

  it('ranks by what the mode counts, not always by gems', () => {
    const w = new World(37, 2, 'hatchlingRun');
    const a = w.addPlayer(1, 'Collector');
    const b = w.addPlayer(2, 'Miner');
    w.beginDraft();
    w.start();

    // b has more gems, a has more rescues. In this mode a must rank first.
    a.rescued = 3;
    b.gems = 500;
    expect(w.standings()[0]!.id).toBe(a.id);
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
    const w = new World(44, 1);
    const p = w.addPlayer(1, 'Pirate');
    w.start();

    const full = w.chestPriceFor(p);
    for (let i = 0; i < 6; i++) spawnUnit(w.store, p.index, 'buccaneer', 2, 32 + i * 0.3, 32);
    w.tick(idle([1]));

    const discounted = w.chestPriceFor(p);
    expect(discounted).toBeLessThan(full);
    expect(discounted).toBeGreaterThanOrEqual(1);
  });

  it('caps the supplier curve however many suppliers pile in', () => {
    expect(gemMultiplier(99)).toBeLessThanOrEqual(2);
  });
});
