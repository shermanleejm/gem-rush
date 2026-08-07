#!/usr/bin/env node
/**
 * Headless balance harness (brief §4).
 *
 *   pnpm sim:bench --players 8 --rounds 500
 *
 * Plays full matches with scripted bots and dumps win rates and gem curves to
 * CSV. Manual playtesting is for feel; this is for degeneracy — run it whenever
 * a number in shared/config changes.
 *
 * Lives in the server package rather than shared because it writes files, and
 * shared is compiled with no Node types on purpose.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOT_POLICIES,
  MATCH,
  TICK_DT,
  World,
  botInput,
  makeBot,
  type Bot,
  type BotPolicy,
  type InputCommand,
} from '@gem-rush/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Args {
  players: number;
  rounds: number;
  out: string;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
  };
  const outIdx = argv.indexOf('--out');
  return {
    players: Math.max(2, Math.min(MATCH.maxPlayers, get('--players', 8))),
    rounds: Math.max(1, get('--rounds', 200)),
    seed: get('--seed', 1),
    out: outIdx !== -1 ? argv[outIdx + 1]! : resolve(__dirname, '../../../bench'),
  };
}

interface RoundResult {
  round: number;
  seed: number;
  winner: BotPolicy;
  byPlayer: {
    policy: BotPolicy;
    gems: number;
    coinsEarned: number;
    chests: number;
    squad: number;
    rank: number;
  }[];
  /** Banked gems per policy sampled every 30s, for the gem curve. */
  samples: { t: number; policy: BotPolicy; gems: number }[];
}

/**
 * Total coins a player has already spent, given how many chests they opened.
 * Prices escalate per purchase, so this is the arithmetic series.
 */
function spentOn(chests: number): number {
  let total = 0;
  for (let i = 0; i < chests; i++) total += MATCH.chestBasePrice + i * MATCH.chestPriceStep;
  return total;
}

function runRound(round: number, seed: number, playerCount: number): RoundResult {
  const world = new World(seed, playerCount);
  const bots: Bot[] = [];

  for (let i = 0; i < playerCount; i++) {
    // Round-robin the policies so every seed tests a balanced mix, and rotate
    // the starting offset per round so no policy is always player 0 (which
    // would confound policy strength with home-pad position).
    const policy = BOT_POLICIES[(i + round) % BOT_POLICIES.length]!;
    const id = i + 1;
    world.addPlayer(id, `${policy}-${i}`);
    bots.push(makeBot(id, policy, i));
  }
  world.start();

  const totalTicks = Math.ceil(MATCH.matchSeconds / TICK_DT);
  const sampleEvery = Math.round(30 / TICK_DT);
  const samples: RoundResult['samples'] = [];
  const inputs = new Map<number, InputCommand>();

  for (let tick = 0; tick < totalTicks; tick++) {
    inputs.clear();
    for (const bot of bots) inputs.set(bot.playerId, botInput(world, bot, tick));
    world.tick(inputs);

    if (tick % sampleEvery === 0) {
      for (const bot of bots) {
        const p = world.players.get(bot.playerId);
        if (p) samples.push({ t: Math.round(tick * TICK_DT), policy: bot.policy, gems: p.gems });
      }
    }
    if (world.phase === 'ended') break;
  }

  const standings = world.standings();
  const rankOf = new Map(standings.map((s, i) => [s.id, i + 1]));

  const byPlayer = bots.map((bot) => {
    const p = world.players.get(bot.playerId)!;
    return {
      policy: bot.policy,
      gems: p.gems,
      // Balance plus everything already spent: what the player actually earned
      // is the number that says whether the economy can fund a squad, and an
      // unspent balance of zero is ambiguous between broke and thrifty.
      coinsEarned: p.coins + spentOn(p.chestsOpened),
      chests: p.chestsOpened,
      squad: world.squadOf(p.index).length,
      rank: rankOf.get(bot.playerId) ?? playerCount,
    };
  });

  const winnerId = standings[0]?.id;
  const winner = bots.find((b) => b.playerId === winnerId)?.policy ?? 'turtle';
  return { round, seed, winner, byPlayer, samples };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `\n  sim:bench — ${args.rounds} rounds x ${args.players} players ` +
      `(${MATCH.matchSeconds}s each)\n`,
  );

  const results: RoundResult[] = [];
  const t0 = Date.now();

  for (let r = 0; r < args.rounds; r++) {
    results.push(runRound(r, args.seed + r * 7919, args.players));
    if ((r + 1) % 25 === 0 || r === args.rounds - 1) {
      const pct = (((r + 1) / args.rounds) * 100).toFixed(0);
      process.stdout.write(`\r  ${r + 1}/${args.rounds} rounds (${pct}%)   `);
    }
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\n  done in ${elapsed.toFixed(1)}s\n`);

  // ── aggregate ─────────────────────────────────────────────────────────────
  interface Agg {
    played: number;
    wins: number;
    gems: number;
    coinsEarned: number;
    chests: number;
    squad: number;
    rankSum: number;
  }
  const agg = new Map<BotPolicy, Agg>();
  for (const p of BOT_POLICIES) {
    agg.set(p, { played: 0, wins: 0, gems: 0, coinsEarned: 0, chests: 0, squad: 0, rankSum: 0 });
  }

  for (const res of results) {
    for (const row of res.byPlayer) {
      const a = agg.get(row.policy)!;
      a.played++;
      a.gems += row.gems;
      a.coinsEarned += row.coinsEarned;
      a.chests += row.chests;
      a.squad += row.squad;
      a.rankSum += row.rank;
      if (row.rank === 1) a.wins++;
    }
  }

  const pad = (s: string, n: number): string => s.padEnd(n);
  const padL = (s: string, n: number): string => s.padStart(n);
  console.log(
    `  ${pad('policy', 14)}${padL('win%', 8)}${padL('avg gems', 10)}${padL('coins', 8)}` +
      `${padL('avg rank', 10)}${padL('chests', 9)}${padL('squad', 8)}`,
  );
  console.log(`  ${'─'.repeat(59)}`);

  const summary: string[] = [];
  for (const policy of BOT_POLICIES) {
    const a = agg.get(policy)!;
    if (a.played === 0) continue;
    const winPct = (a.wins / a.played) * 100;
    const line =
      `  ${pad(policy, 14)}${padL(winPct.toFixed(1), 8)}` +
      `${padL((a.gems / a.played).toFixed(1), 10)}` +
      `${padL((a.coinsEarned / a.played).toFixed(0), 8)}` +
      `${padL((a.rankSum / a.played).toFixed(2), 10)}` +
      `${padL((a.chests / a.played).toFixed(2), 9)}` +
      `${padL((a.squad / a.played).toFixed(1), 8)}`;
    console.log(line);
    summary.push(
      [
        policy,
        a.played,
        a.wins,
        winPct.toFixed(2),
        (a.gems / a.played).toFixed(2),
        (a.rankSum / a.played).toFixed(3),
        (a.chests / a.played).toFixed(3),
        (a.squad / a.played).toFixed(2),
      ].join(','),
    );
  }

  // ── the checks that matter (§4 known failure modes) ───────────────────────
  const expected = 100 / BOT_POLICIES.length;
  console.log(`\n  Expected win rate if perfectly balanced: ${expected.toFixed(1)}%\n`);

  const turtle = agg.get('turtle')!;
  const chesty = agg.get('chestHungry')!;
  const turtleWin = (turtle.wins / Math.max(1, turtle.played)) * 100;

  const verdicts: string[] = [];
  // §M5: "someone who never buys a chest should sometimes win".
  if (turtleWin < 5) {
    verdicts.push(
      `FAIL  turtle (never buys) wins ${turtleWin.toFixed(1)}% — chests are mandatory. ` +
        `Raise chestPriceStep or lower fused-unit power.`,
    );
  } else if (turtleWin > 55) {
    verdicts.push(
      `FAIL  turtle wins ${turtleWin.toFixed(1)}% — turtling out-earns contesting. ` +
        `Raise centre yield (map.zoneYieldMultiplier) or lower chest prices.`,
    );
  } else {
    verdicts.push(`OK    turtle wins ${turtleWin.toFixed(1)}% — spending tension is real.`);
  }

  const chestsBought = chesty.chests / Math.max(1, chesty.played);
  if (chestsBought < 1) {
    verdicts.push(
      `FAIL  chest-hungry averages ${chestsBought.toFixed(2)} chests — nobody can ` +
        `afford one. Lower chestBasePrice.`,
    );
  }

  /*
   * Are both openings viable?
   *
   * The target is *parity*, not dominance. This check used to demand that
   * buying beat hoarding, on the theory that a squad you paid for ought to win
   * — but that makes hoarding a trap, and a game with one correct opening has
   * no opening decision in it. Snowballing into a big squad and patiently
   * farming with a small one should both be live, so the failure conditions
   * are now symmetric: either one running away from the other is a problem.
   *
   * The buyer is picked from the data rather than hard-coded. greedyGem was
   * once a fair proxy for "opportunistic buyer", but after prices escalated it
   * settled at under one purchase a match, and the check ended up comparing a
   * near-abstainer against an abstainer.
   */
  let buyer = agg.get('greedyGem')!;
  let buyerPolicy: BotPolicy = 'greedyGem';
  for (const p of BOT_POLICIES) {
    const a = agg.get(p)!;
    if (a.chests / Math.max(1, a.played) > buyer.chests / Math.max(1, buyer.played)) {
      buyer = a;
      buyerPolicy = p;
    }
  }
  const greedyWin = (buyer.wins / Math.max(1, buyer.played)) * 100;
  const greedyChests = buyer.chests / Math.max(1, buyer.played);
  // How far apart the two openings may sit before one is simply better.
  const PARITY_BAND = 6;
  const gap = greedyWin - turtleWin;

  if (greedyChests < 0.25) {
    verdicts.push(
      `WARN  the biggest buyer (${buyerPolicy}) bought ${greedyChests.toFixed(2)} chests — ` +
        `too few to judge whether spending pays. Lower chestBasePrice.`,
    );
  } else if (gap < -PARITY_BAND) {
    verdicts.push(
      `FAIL  buying (${buyerPolicy}, ${greedyWin.toFixed(1)}%) trails never buying ` +
        `(${turtleWin.toFixed(1)}%) by ${(-gap).toFixed(1)}pp — chests are not worth their ` +
        `coins. Lower squadGemFalloff.`,
    );
  } else if (gap > PARITY_BAND) {
    verdicts.push(
      `FAIL  buying (${buyerPolicy}, ${greedyWin.toFixed(1)}%) beats never buying ` +
        `(${turtleWin.toFixed(1)}%) by ${gap.toFixed(1)}pp — hoarding is a trap. ` +
        `Raise squadGemFalloff.`,
    );
  } else {
    verdicts.push(
      `OK    buying (${buyerPolicy}) ${greedyWin.toFixed(1)}% vs never buying ` +
        `${turtleWin.toFixed(1)}% — both openings viable, ${Math.abs(gap).toFixed(1)}pp apart.`,
    );
  }

  /*
   * §4's first named failure mode: "turtling in a safe outer zone out-earns
   * contesting the center". The controller policy holds the middle and fights
   * only what comes to it; turtle farms the rim and never contests. If holding
   * the centre does not beat hiding on the rim, the zone yields are wrong.
   */
  const controller = agg.get('controller');
  if (controller && controller.played > 0) {
    const controllerWin = (controller.wins / controller.played) * 100;
    const controllerGems = controller.gems / controller.played;
    const turtleGems = turtle.gems / Math.max(1, turtle.played);
    if (controllerWin <= turtleWin || controllerGems <= turtleGems) {
      verdicts.push(
        `FAIL  holding the centre (${controllerWin.toFixed(1)}%, ${controllerGems.toFixed(0)} gems) ` +
          `does not beat turtling (${turtleWin.toFixed(1)}%, ${turtleGems.toFixed(0)} gems) — ` +
          `raise centre yield in map.zoneYieldMultiplier.`,
      );
    } else {
      verdicts.push(
        `OK    holding the centre wins ${controllerWin.toFixed(1)}% with ${controllerGems.toFixed(0)} ` +
          `gems vs turtling ${turtleWin.toFixed(1)}% / ${turtleGems.toFixed(0)} — contesting pays.`,
      );
    }
  }

  const winRates = BOT_POLICIES.map((p) => {
    const a = agg.get(p)!;
    return a.played ? (a.wins / a.played) * 100 : 0;
  });
  const spread = Math.max(...winRates) - Math.min(...winRates);
  if (spread > 45) {
    verdicts.push(`FAIL  win-rate spread ${spread.toFixed(1)}pp — one strategy dominates.`);
  } else {
    verdicts.push(`OK    win-rate spread ${spread.toFixed(1)}pp across policies.`);
  }

  for (const v of verdicts) console.log(`  ${v}`);
  console.log('');

  // ── CSV ───────────────────────────────────────────────────────────────────
  mkdirSync(args.out, { recursive: true });

  writeFileSync(
    resolve(args.out, 'summary.csv'),
    'policy,played,wins,win_pct,avg_gems,avg_rank,avg_chests,avg_squad\n' +
      summary.join('\n') +
      '\n',
  );

  const rows = ['round,seed,policy,gems,chests,squad,rank,winner'];
  for (const res of results) {
    for (const p of res.byPlayer) {
      rows.push(
        [res.round, res.seed, p.policy, p.gems, p.chests, p.squad, p.rank, res.winner].join(','),
      );
    }
  }
  writeFileSync(resolve(args.out, 'rounds.csv'), rows.join('\n') + '\n');

  // Gem curve: mean banked gems per policy at each 30s sample point.
  const curve = new Map<string, { sum: number; n: number }>();
  for (const res of results) {
    for (const s of res.samples) {
      const key = `${s.t}|${s.policy}`;
      const c = curve.get(key) ?? { sum: 0, n: 0 };
      c.sum += s.gems;
      c.n++;
      curve.set(key, c);
    }
  }
  const curveRows = ['t_seconds,policy,mean_gems'];
  for (const [key, c] of [...curve.entries()].sort()) {
    const [t, policy] = key.split('|');
    curveRows.push(`${t},${policy},${(c.sum / c.n).toFixed(2)}`);
  }
  writeFileSync(resolve(args.out, 'gem_curve.csv'), curveRows.join('\n') + '\n');

  console.log(`  CSV written to ${args.out}\n`);

  // Non-zero exit on a FAIL so this can gate a change to the tuning tables.
  if (verdicts.some((v) => v.startsWith('FAIL'))) process.exitCode = 1;
}

main();
