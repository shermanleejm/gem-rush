import { describe, expect, it } from 'vitest';

import { MAP } from '../config/map.ts';
import { MATCH, TICK_DT } from '../config/match.ts';
import { MAP_IDS } from '../config/maps.ts';
import { MINE } from './spawning.ts';
import { World, type InputCommand } from './world.ts';

const NO_INPUT = new Map<number, InputCommand>();

function playing(): World {
  const w = new World(4242, 1, 'gemHunt', 'bustervalley');
  w.addPlayer(1, 'A');
  w.start();
  return w;
}

/** Run the clock forward without any player doing anything. */
function run(w: World, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) w.tick(NO_INPUT);
}

describe('the centre gem mine', () => {
  it('sits at the middle of every arena', () => {
    for (const id of MAP_IDS) {
      const w = new World(1, 1, 'gemHunt', id);
      expect(w.store.count('mine'), `${id} has no mine`).toBe(1);
      expect(Math.hypot(w.mine.x - MAP.size / 2, w.mine.y - MAP.size / 2), id).toBeLessThan(2);
    }
  });

  it('drops gems on its own while the match runs', () => {
    const w = playing();
    const before = w.store.count('gem');
    run(w, MINE.interval * 2.5);
    expect(w.store.count('gem'), 'the mine produced nothing').toBeGreaterThan(before);
  });

  it('drops near itself, not across the arena', () => {
    const w = playing();
    run(w, MINE.interval * 1.2);
    const gems = w.store.ofKind('gem');
    expect(gems.length).toBeGreaterThan(0);
    for (const g of gems) {
      expect(Math.hypot(g.x - w.mine.x, g.y - w.mine.y)).toBeLessThanOrEqual(MINE.scatterRadius + 0.1);
    }
  });

  it('warns before it blows, with time left to reach it', () => {
    const w = playing();
    run(w, MATCH.matchSeconds - MINE.warningSeconds - 1);
    expect(w.events.some((e) => e.t === 'mineWarning')).toBe(false);

    let warning: { seconds: number } | null = null;
    for (let i = 0; i < 40 && !warning; i++) {
      w.tick(NO_INPUT);
      const ev = w.events.find((e) => e.t === 'mineWarning');
      if (ev && ev.t === 'mineWarning') warning = ev;
    }
    expect(warning, 'no warning was ever raised').not.toBeNull();
    // The countdown has to be long enough to cross the map, or it is an
    // announcement rather than a decision.
    expect(warning!.seconds).toBeGreaterThan(5);
  });

  it('blows once, near the end, for far more than an ordinary drop', () => {
    const w = playing();
    run(w, MATCH.matchSeconds - MINE.blastSeconds - 1);
    const before = w.store.count('gem');

    let blasts = 0;
    for (let i = 0; i < Math.round(MINE.blastSeconds / TICK_DT) + 40; i++) {
      w.tick(NO_INPUT);
      blasts += w.events.filter((e) => e.t === 'mineBlast').length;
    }

    expect(blasts, 'the mine must detonate exactly once').toBe(1);
    expect(w.store.count('gem') - before).toBeGreaterThanOrEqual(MINE.blastGems);
  });

  it('cannot be attacked, so nobody can farm it down early', () => {
    const w = playing();
    run(w, 30);
    expect(w.mine.alive).toBe(true);
    expect(w.mine.hp).toBe(w.mine.maxHp);
  });
});
