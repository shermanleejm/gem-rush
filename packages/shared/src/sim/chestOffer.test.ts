import { describe, expect, it } from 'vitest';

import { MATCH } from '../config/match.ts';
import { MAX_TIER, unitsOfRarity, type UnitTier, type UnitType } from '../config/units.ts';
import { Rng } from '../math/rng.ts';
import { EntityStore, type Entity } from './entities.ts';
import { buildChestOffer, chestOfferWeight, spawnUnit } from './spawning.ts';

const POOL = unitsOfRarity('common');
const A = POOL[0]!;
const B = POOL[1]!;

function squadOf(store: EntityStore, spec: [UnitType, UnitTier, number][]): Entity[] {
  const out: Entity[] = [];
  for (const [type, tier, n] of spec) {
    for (let i = 0; i < n; i++) out.push(spawnUnit(store, 0, type, tier, i, 0));
  }
  return out;
}

/** Share of offers across many draws that included `type`. */
function offerRate(squad: Entity[], type: UnitType, rounds = 3000): number {
  const rng = new Rng(99);
  let hits = 0;
  for (let i = 0; i < rounds; i++) {
    if (buildChestOffer(rng, POOL, squad, MATCH.chestOfferCount).includes(type)) hits++;
  }
  return hits / rounds;
}

describe('chest offers', () => {
  it('ranks an unfinished fusion line above a maxed one', () => {
    const store = new EntityStore();
    // One maxed A, and two Bs — one short of a fusion.
    const squad = squadOf(store, [
      [A, MAX_TIER, 1],
      [B, 0, MATCH.fusionThreshold - 1],
    ]);

    expect(chestOfferWeight(squad, A)).toBe(1);
    expect(chestOfferWeight(squad, B)).toBeGreaterThan(chestOfferWeight(squad, A));
    // A type held at neither extreme still outranks the maxed one.
    expect(chestOfferWeight(squad, POOL[2]!)).toBeGreaterThan(chestOfferWeight(squad, A));
  });

  it('offers a type you have yet to mega far more often than one you have maxed', () => {
    const store = new EntityStore();
    const squad = squadOf(store, [[A, MAX_TIER, 1]]);

    const maxed = offerRate(squad, A);
    const fresh = offerRate(squad, B);
    expect(fresh, 'the un-megaed type should dominate').toBeGreaterThan(maxed * 2);
    // Never zero: a spare body still fights, it just stops crowding the offers.
    expect(maxed).toBeGreaterThan(0);
  });

  it('surfaces the unit that would complete a fusion most often of all', () => {
    const store = new EntityStore();
    const squad = squadOf(store, [[B, 0, MATCH.fusionThreshold - 1]]);
    expect(offerRate(squad, B)).toBeGreaterThan(offerRate(squad, POOL[2]!));
  });

  it('treats a battle mod that caps tiers as its own ceiling', () => {
    const store = new EntityStore();
    // Tier 1 is maxed when the mod says the ceiling is 1, so A is spent.
    const squad = squadOf(store, [[A, 1, 1]]);
    expect(chestOfferWeight(squad, A, 1)).toBe(1);
    expect(chestOfferWeight(squad, A, MAX_TIER)).toBeGreaterThan(1);
  });

  it('never repeats a unit within one offer, and fills every slot', () => {
    const store = new EntityStore();
    const squad = squadOf(store, [[A, MAX_TIER, 1]]);
    const rng = new Rng(7);
    for (let i = 0; i < 300; i++) {
      const offer = buildChestOffer(rng, POOL, squad, MATCH.chestOfferCount);
      expect(offer).toHaveLength(MATCH.chestOfferCount);
      expect(new Set(offer).size).toBe(offer.length);
    }
  });

  it('cannot offer more than the pool holds', () => {
    const store = new EntityStore();
    const offer = buildChestOffer(new Rng(1), POOL.slice(0, 2), squadOf(store, []), 3);
    expect(offer).toHaveLength(2);
  });

  it('stays deterministic for a seed', () => {
    const store = new EntityStore();
    const squad = squadOf(store, [[A, MAX_TIER, 1]]);
    const draw = (): UnitType[] => buildChestOffer(new Rng(1234), POOL, squad, 3);
    expect(draw()).toEqual(draw());
  });
});
