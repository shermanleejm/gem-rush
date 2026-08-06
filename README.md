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

One person hosts. Everyone else just opens a link.

```bash
npx squad-arena
```

That is the whole install. It needs [Node.js](https://nodejs.org) 20 or newer
and nothing else — no accounts, no game client, no configuration.

<details>
<summary>Running from a clone instead</summary>

```bash
pnpm install
pnpm build
pnpm host
```
</details>

The host prints everything needed to invite people:

```
  On this machine
    http://localhost:8080

  Same Wi-Fi / LAN — share this with friends in the room
    http://192.168.0.9:8080

  Can't port-forward? Run this in another terminal:
    cloudflared tunnel --url http://localhost:8080
```

Everyone — including the host — plays in a normal browser tab.

### Getting friends connected

| Situation | What to share |
|---|---|
| Same Wi-Fi | The `http://192.168.x.x:8080` line the host prints. Works immediately. |
| Over the internet, you can port-forward | Forward **TCP 8080** to the host machine, then share the public IP line. |
| Over the internet, you can't port-forward | Run `cloudflared tunnel --url http://localhost:8080` and share the `https://` URL it prints. No router setup. |

Not being able to port-forward is the single most likely reason a group fails to
play, which is why the tunnel command is printed on every boot.

**The host quitting ends the match.** There is no host migration in v1.

### Playing over the internet

You have two options. **Try the tunnel first** — it works everywhere and takes
about a minute. Port forwarding is faster once set up but every router's menus
are different.

#### Option A — a tunnel (recommended, no router access needed)

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
then in a *second* terminal while the host is running:

```bash
cloudflared tunnel --url http://localhost:8080
```

It prints a URL like `https://random-words-here.trycloudflare.com`. Share that.
It works from anywhere, needs no router changes, and gives you HTTPS for free.
The URL dies when you stop cloudflared, so generate a fresh one each session.

#### Option B — port forwarding

You are telling your router "traffic arriving on port 8080 goes to my computer".

1. **Find your router's address.** On Windows run `ipconfig` and use the
   "Default Gateway" line — usually `192.168.0.1` or `192.168.1.1`. Open it in
   a browser.
2. **Log in.** The password is often printed on a sticker on the router itself.
3. **Find the port forwarding page.** It hides under different names depending
   on the brand: *Port Forwarding*, *Virtual Server*, *NAT*, *Applications &
   Gaming*, or under an *Advanced* tab.
4. **Add a rule:**
   - External / public port: `8080`
   - Internal / private port: `8080`
   - Protocol: `TCP`
   - Internal IP: the LAN address the host printed (e.g. `192.168.0.9`)
5. **Save**, then share the public-IP URL the host printed.

Two things that catch people out: most home broadband gives you a *dynamic*
public IP, so it can change and the link stops working; and some ISPs use
CGNAT, where port forwarding cannot work at all no matter what you configure.
If forwarding looks correct but nobody can connect, it is probably CGNAT — use
the tunnel.

## It doesn't work

**Nobody can reach me on the same Wi-Fi.**
Check they typed `http://` and not `https://`, and the right port. If it still
fails it is almost always the host's firewall — on Windows, the first run pops
a "Windows Defender Firewall has blocked some features" dialog and you must
allow it on **private networks**. If you dismissed it, allow Node manually
under Settings → Network & Internet → Windows Firewall → Allow an app. Also
confirm both devices are on the same network: many homes have separate 2.4GHz
and 5GHz SSIDs, and a "Guest" network usually blocks device-to-device traffic
entirely.

**"Port 8080 is already in use".**
Something else is on that port. Run with a different one:
`PORT=8081 npx squad-arena` (PowerShell: `$env:PORT=8081; npx squad-arena`).
Remember to share the new port number too.

**The page loads but stays on "Connecting…".**
The HTTP side works and the WebSocket does not, which usually means a proxy or
corporate network stripping the upgrade. Try the tunnel, or a phone on mobile
data to confirm.

**It works for me but not over the internet.**
The LAN address (`192.168.x.x`) only works inside your house. You need Option A
or Option B above.

**Everything is laggy for one player.**
Press `~` to open the dev overlay and read their RTT and jitter. The host's
*upload* speed is the shared bottleneck: eight players is roughly 100 KB/s up.
If the host is on slow broadband, fewer players will help.

**The host closed their laptop and the game died.**
Expected. The host runs the simulation, so the match ends with it. There is no
host migration.

**A player dropped mid-match.**
Their squad is held for 30 seconds. If they reload the page in that window they
get it back; after that they respawn fresh next round.

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

**Host-authoritative over WebSocket.** One player's machine runs the sim and
serves the static files on one port — architecturally a listen server. A WebRTC
mesh was rejected: it needs a signalling server anyway (so the middleman isn't
actually removed) and an 8-player mesh with no authority needs either lockstep
determinism or trusting clients.

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
