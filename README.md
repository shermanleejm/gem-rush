# Squad Arena

Real-time multiplayer top-down arena collection game. Browser only, peer-hosted:
one person runs a single command and shares a URL. No accounts, no installs, no
app store, no company servers.

Six to eight players drop into a small procedurally-assembled arena for a
four-minute round. You control a **leader** — one movement cursor — and
everything else is automatic. Your squad trails behind you in formation and
auto-attacks whatever comes into range. Smash props, clear creep camps, open
chests, hoover up gems. Gems are both score *and* currency, so the strongest
squad is built by spending the very resource you're scored on.

## Play

**Everyone just opens the site.** One person clicks *Host a game* and gets a
five-character room code; everyone else types it in, or taps the invite link.
Nothing to install, no accounts, and nobody has to run a server.

The game is hosted by the **host's browser tab**. That tab runs the
authoritative simulation and every other player connects straight to it over
WebRTC. So one rule matters: **the host has to keep their tab open**, and if
they close it the match ends.

### If peer-to-peer fails

A minority of networks block direct browser-to-browser connections. WebRTC
needs to find a path between two machines, and behind strict or symmetric NAT
that requires a TURN relay, which costs money to run and so isn't provided
here. Expect roughly 85–90% of pairs to connect.

If someone can't join, the fallback is the downloadable host, which is a plain
web server and works anywhere on a LAN:

```bash
npx squad-arena
```

That prints a LAN URL, a public IP, and a tunnel command. Everyone opens the
URL and plays — no room codes, no WebRTC.

<details>
<summary>Running from a clone</summary>

```bash
pnpm install
pnpm build
pnpm host          # Node host on :8080
```
</details>

## Controls

One input: move.

- **Desktop** — WASD / arrow keys, or a gamepad left stick
- **Mobile** — touch the left half of the screen; a joystick anchors wherever
  your thumb lands
- **`~`** — dev overlay (fps, frame time, snapshot size, bandwidth, jitter)

The only other decision is picking one of three units when you open a chest.

## Development

```bash
pnpm dev          # Vite dev server on :5173, proxies /ws to the host on :8080
pnpm host         # the authoritative host process (TypeScript, no build)
pnpm test         # simulation tests
pnpm typecheck    # all three packages
pnpm build        # typecheck + client bundle + publishable host package
pnpm host:dist    # run the built package exactly as `npx` would
```

`pnpm build` bundles the host and the `shared` simulation into a single JS file
with esbuild and copies the client in beside it, so the published tarball has
one runtime dependency (`ws`) and needs no workspace. Verify a release the way
a stranger receives it rather than trusting the build:

```bash
cd packages/server && npm pack
cd /tmp && npm install /path/to/squad-arena-0.1.0.tgz && ./node_modules/.bin/squad-arena
```

Run `pnpm host` and `pnpm dev` together while working on the client: Vite serves
the UI with hot reload and proxies the socket through to the host.

## Architecture

```
packages/
  shared/    pure TS — the whole simulation, protocol, and tuning data
  server/    host process: serves the bundle + runs the authoritative sim
  client/    PixiJS renderer, input, netcode, UI
```

**Host-authoritative, over two interchangeable transports.** Exactly one peer
is authoritative and everyone else sends inputs; only the pipe differs.

- **WebRTC (default, static hosting).** A browser tab runs `Room` and guests
  connect by room code. Signalling uses PeerJS's free public broker, which only
  introduces two peers — once the DataChannel opens no game traffic touches it.
- **WebSocket (`npx squad-arena`).** A Node process runs the same `Room` and
  serves the bundle on one port.

A full peer-to-peer *mesh* was still rejected: with no single authority an
8-player mesh needs either lockstep determinism or trusting clients. This is
one authority reachable two ways, which is why `Room` lives in `shared/` and
neither host contains game logic — they are pure transport, and `Connection` on
the client cannot tell which one it is talking to. The hosting player reaches
their own `Room` through a loopback transport, so even the host is just another
client.

**`shared/` runs headless.** Its tsconfig has no DOM lib and no ambient
`@types`, so a stray `document.` or `process.` reference is a compile error
rather than something to catch in review. The host imports it to be
authoritative, tests run 10,000 ticks in milliseconds, and the client imports it
for prediction.

**Fixed 20 Hz tick, decoupled rendering.** `World.tick(inputs)` is the entire
contract. All randomness comes from a seeded PRNG stored in the world, never
`Math.random()`, so a seed plus an input stream fully determines a match — which
is what makes the sim testable and lets the host send a seed instead of a map.

**Only the local leader is predicted.** Squad units, other players, creeps and
props are pure interpolation rendered ~100ms in the past. Followers are visually
forgiving; predicting them would be a large complexity cost for no perceived
gain.

Balance is data, not code: every number lives in `shared/src/config/`, is sent
to clients in the `welcome` message, and the host is the source of truth.

## Status

Implemented and verified end to end: monorepo and host process with LAN/public
IP detection (M0), the full simulation — movement, formation, terrain
collision, combat, creeps, economy, fusion, phases (M1), host authority with
clients as input + render (M2), delta snapshots with an adaptive interpolation
buffer, leader prediction and the dev overlay (M3), all eight archetypes with
squad-vs-squad resolution (M4), chests, escalating prices, fusion tiers, last
call and a results screen (M5), and lobby, ready-up, reconnect and rematch (M6).

Measured against the §5 budgets:

| Metric | Target | Measured |
|---|---|---|
| Host tick (8p, squads at cap) | < 3ms | **0.24ms** |
| Client frame time | < 8ms | **0.30ms** |
| Snapshot size | ≤ 700 B | **178 B** |
| Downstream per client | ≤ 15 KB/s | **3.5 KB/s** |
| Bundle, gzipped | < 2 MB | **~152 KB** |

M7 done: a procedurally-generated original sprite atlas (per-archetype
silhouettes with role glyphs), synthesised WebAudio SFX with a mute toggle, the
touch joystick, a minimap, and a squad-wipe banner. M8 done: the host is
packaged so `npx squad-arena` works with no clone, no pnpm and no build step.

Neither the art nor the audio ships a single asset byte — both are generated at
boot — so the whole client is still ~83 KB gzipped against a 2 MB budget.

## Balance harness

```bash
pnpm sim:bench --players 8 --rounds 200
```

Plays full matches with four scripted bot policies and writes `summary.csv`,
`rounds.csv` and `gem_curve.csv` to `bench/`. It exits non-zero when a §4
failure mode trips, so it can gate a change to the tuning tables. Run it
whenever a number in `shared/src/config/` changes.

The policies each isolate one strategy so a win-rate gap is attributable:
`controller` holds the contested centre, `greedyGem` farms and buys
opportunistically, `chestHungry` buys the instant it can afford to,
`aggressive` hunts other squads across the map, and `turtle` farms the safe rim
and never buys — `turtle` is the control for the "can a non-buyer win?"
question.

### What it found, and what changed because of it

Three real defects, each fixed at the cause rather than by nudging numbers:

- **Units only ever lost HP.** They hold formation rather than chasing (§1.7),
  so they collected chip damage brushing past camps with no way to recover it —
  92 unit deaths against 3 creep kills in one match. Added out-of-combat regen.
- **Every creep camp was identical**, so a starting squad of two Strikers could
  not clear any of them (10 Strikers clear one in 0.1s; 2 cannot finish in 60s).
  Camps now scale with zone, per §1.8's "outer zones are safe, the centre has
  the toughest camp", and pay proportionally more.
- **Squad size did not affect income.** Only the leader collected gems, and
  farming is bottlenecked on travel time rather than kill speed, so a bot that
  bought five chests and one that bought none had identical gross income (~73).
  Squad units now collect gems too, at a shorter reach than the leader.

Current standing at 8 players × 120 rounds (20% is the balanced baseline):

| policy | win% | avg gems | chests |
|---|---:|---:|---:|
| controller (holds the centre) | 31.8 | 80.9 | 1.80 |
| greedyGem (opportunistic buyer) | 21.4 | 60.9 | 0.64 |
| turtle (never buys) | 6.8 | 33.7 | 0.00 |
| aggressive (hunts across the map) | 2.1 | 19.8 | 0.26 |
| chestHungry (over-buys) | 0.5 | 18.0 | 5.34 |

Holding the contested centre wins and earns the most, buying opportunistically
beats never buying, and a non-buyer still wins 6.8% of the time. Both the M5
spending tension and §1.3's "contest the richest zones" thesis hold up.

### A wrong conclusion, corrected

An earlier run read `aggressive`'s 2% win rate as "player-vs-player is a losing
play, the squad-vs-squad half of the design isn't pulling its weight". That was
wrong, and the way it was wrong is worth recording.

Attributing every banked gem to its source showed `aggressive` *losing* 117
fights and winning 58 — it hunts with a squad of 1.4 units and dies — while
`chestHungry`, which actually invests, won 134 and lost 33. Investment beating
naked aggression is the intended design, not a defect.

What was missing was a bot that models *holding ground* rather than *chasing*.
The `controller` policy was added for that, and it immediately became the
strongest strategy. `aggressive` and `chestHungry` remain near the bottom, but
they are deliberately bad strategies being correctly punished rather than
evidence of imbalance.

Two smaller confounds were fixed along the way: bots now pick up loot within 4
units before doing anything else (previously the aggressive bot would wipe a
squad, scatter its bank on the ground, and run off leaving the reward for
someone else), and `chestHungry`'s poor showing was verified as a commuting cost
rather than a price problem — sweeping `chestPriceStep` from 3 to 1 raised its
purchases from 5.8 to 8.8 and its win rate only from 0.0% to 2.5%.
