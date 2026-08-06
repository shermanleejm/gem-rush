/**
 * DOM chrome: join, lobby, HUD, chest offer, results, dev overlay.
 *
 * Plain DOM rather than a framework — the brief allows React for menus but
 * none of this is complex enough to earn a dependency, and keeping it out of
 * the bundle helps the <2MB budget.
 */

import { UNIT_DEFS, type LobbyPlayer, type UnitType } from '@gem-rush/shared';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

// ── join ────────────────────────────────────────────────────────────────────

export type StartChoice =
  | { mode: 'server'; name: string }
  | { mode: 'host'; name: string }
  | { mode: 'join'; name: string; code: string };

/**
 * Opening screen.
 *
 * When the page is served by the Node host there is already an authority to
 * talk to, so the only question is the player's name. On a static deployment
 * (GitHub Pages) there is no server at all, so somebody has to host from their
 * browser and the rest join by room code.
 */
export function showJoin(
  hasServer: boolean,
  onStart: (choice: StartChoice) => void,
): { close: () => void; setError: (msg: string) => void; setBusy: (msg: string | null) => void } {
  const overlay = el('div', 'overlay');
  const card = el('div', 'card');

  card.appendChild(el('h1', 'title', 'Gem Rush'));
  card.appendChild(
    el(
      'p',
      'subtitle',
      'Move your leader. Your squad follows and fights on its own. Smash things, grab gems, buy units. Most gems in four minutes wins.',
    ),
  );

  const label = el('label');
  label.textContent = 'Your name';
  label.htmlFor = 'name';
  const input = el('input');
  input.type = 'text';
  input.id = 'name';
  input.maxLength = 16;
  input.placeholder = 'e.g. Ace';
  input.value = localStorage.getItem('sa-name') ?? '';
  card.append(label, input);

  const err = el('div', 'err');
  const busy = el('div', 'hint');

  const nameOf = (): string => {
    const n = input.value.trim() || 'Player';
    localStorage.setItem('sa-name', n);
    return n;
  };

  if (hasServer) {
    const row = el('div', 'row mt');
    const btn = el('button');
    btn.textContent = 'Join game';
    btn.onclick = () => onStart({ mode: 'server', name: nameOf() });
    input.onkeydown = (e) => {
      if (e.key === 'Enter') btn.click();
    };
    row.appendChild(btn);
    card.append(row, err, busy);
  } else {
    const hostRow = el('div', 'row mt');
    const hostBtn = el('button');
    hostBtn.textContent = 'Host a game';
    hostBtn.onclick = () => onStart({ mode: 'host', name: nameOf() });
    hostRow.appendChild(hostBtn);

    const sep = el('div', 'hint');
    sep.textContent = 'or join a friend who is hosting';

    const codeLabel = el('label');
    codeLabel.textContent = 'Room code';
    codeLabel.htmlFor = 'code';
    const code = el('input');
    code.type = 'text';
    code.id = 'code';
    code.maxLength = 8;
    code.placeholder = 'ABC12';
    code.autocapitalize = 'characters';
    code.spellcheck = false;

    const joinRow = el('div', 'row mt');
    const joinBtn = el('button', 'secondary');
    joinBtn.textContent = 'Join with code';
    const submitJoin = (): void => {
      const c = code.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length < 4) {
        err.textContent = 'Enter the room code your friend sent you.';
        return;
      }
      err.textContent = '';
      onStart({ mode: 'join', name: nameOf(), code: c });
    };
    joinBtn.onclick = submitJoin;
    code.onkeydown = (e) => {
      if (e.key === 'Enter') submitJoin();
    };
    joinRow.appendChild(joinBtn);

    // A ?room= link lets the host share one tap instead of dictating letters.
    const preset = new URLSearchParams(location.search).get('room');
    if (preset) code.value = preset.toUpperCase();

    card.append(hostRow, sep, codeLabel, code, joinRow, err, busy);
  }

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 50);

  return {
    close: () => overlay.remove(),
    setError: (msg) => {
      err.textContent = msg;
      busy.textContent = '';
    },
    setBusy: (msg) => {
      busy.textContent = msg ?? '';
      if (msg) err.textContent = '';
    },
  };
}

/**
 * Shown to the host so they can hand the code (or a link) to friends.
 *
 * Only useful while waiting for people, so the caller hides it once somebody
 * has joined — a permanent overlay competing with the HUD is not worth the
 * screen on a phone.
 */
export function showRoomCode(code: string): {
  close: () => void;
  setVisible: (visible: boolean) => void;
} {
  const wrap = el('div', 'roomcode');
  const label = el('div', 'roomcode-label');
  label.textContent = 'Room code';
  const value = el('div', 'roomcode-value');
  value.textContent = code;

  const copy = el('button', 'secondary');
  copy.textContent = 'Copy invite link';
  const link = `${location.origin}${location.pathname}?room=${code}`;
  copy.onclick = () => {
    void navigator.clipboard?.writeText(link).then(
      () => {
        copy.textContent = 'Link copied';
        setTimeout(() => (copy.textContent = 'Copy invite link'), 1600);
      },
      () => {
        copy.textContent = link;
      },
    );
  };

  wrap.append(label, value, copy);
  document.body.appendChild(wrap);
  return {
    close: () => wrap.remove(),
    setVisible: (visible) => {
      wrap.style.display = visible ? '' : 'none';
    },
  };
}

// ── lobby ───────────────────────────────────────────────────────────────────

export interface LobbyHandle {
  update: (players: LobbyPlayer[], hostId: number, myId: number) => void;
  close: () => void;
  setError: (msg: string) => void;
}

export function showLobby(onReady: (r: boolean) => void, onStart: () => void): LobbyHandle {
  const overlay = el('div', 'overlay');
  const card = el('div', 'card');
  card.appendChild(el('h1', 'title', 'Lobby'));
  const sub = el('p', 'subtitle', 'Waiting for players. The host starts the match.');
  card.appendChild(sub);

  const list = el('ul', 'player-list');
  const row = el('div', 'row mt');
  const readyBtn = el('button', 'secondary');
  readyBtn.textContent = 'Ready';
  const startBtn = el('button');
  startBtn.textContent = 'Start match';
  startBtn.style.display = 'none';
  row.append(readyBtn, startBtn);

  const err = el('div', 'err');
  const hint = el(
    'div',
    'hint',
    'Share this page&rsquo;s URL with friends on the same network. Nobody needs an account or an install.',
  );

  card.append(list, row, err, hint);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  let ready = false;
  readyBtn.onclick = () => {
    ready = !ready;
    readyBtn.textContent = ready ? 'Not ready' : 'Ready';
    readyBtn.className = ready ? 'secondary' : '';
    onReady(ready);
  };
  startBtn.onclick = () => onStart();

  return {
    update(players, hostId, myId) {
      list.innerHTML = '';
      for (const p of players) {
        const li = el('li');
        const dot = el('span', `dot${p.ready ? ' ready' : ''}`);
        const name = el('span');
        name.textContent = p.name + (p.id === myId ? ' (you)' : '');
        li.append(dot, name);
        if (p.id === hostId) {
          const tag = el('span', 'spacer');
          tag.textContent = 'host';
          tag.style.color = 'var(--ink-dim)';
          tag.style.fontSize = '12px';
          li.appendChild(tag);
        }
        if (!p.connected) {
          const tag = el('span');
          tag.textContent = 'disconnected';
          tag.style.color = 'var(--danger)';
          tag.style.fontSize = '12px';
          li.appendChild(tag);
        }
        list.appendChild(li);
      }
      // Only the host sees Start (§2.6).
      startBtn.style.display = myId === hostId ? '' : 'none';
      sub.textContent =
        myId === hostId
          ? 'You are the host. Start whenever everyone is in.'
          : 'Waiting for the host to start the match.';
    },
    setError(msg) {
      err.textContent = msg;
    },
    close() {
      overlay.remove();
    },
  };
}

// ── HUD ─────────────────────────────────────────────────────────────────────

export interface HudHandle {
  root: HTMLElement;
  setTimer: (seconds: number, lastCall: boolean) => void;
  setGems: (n: number) => void;
  setSquad: (n: number, cap: number) => void;
  setScores: (rows: { id: number; name: string; gems: number }[], myId: number) => void;
  showOffer: (options: UnitType[], price: number, onPick: (i: number) => void) => void;
  hideOffer: () => void;
  destroy: () => void;
}

export function createHud(): HudHandle {
  const root = el('div', 'hud');

  const top = el('div', 'hud-top');
  const timer = el('div', 'pill timer', '4:00');
  const gems = el('div', 'pill gems', '0');
  const squad = el('div', 'pill', '0/15');
  top.append(timer, gems, squad);

  const left = el('div', 'hud-left');
  root.append(top, left);
  document.body.appendChild(root);

  let offer: HTMLElement | null = null;

  return {
    root,
    setTimer(seconds, lastCall) {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
      timer.className = `pill timer${lastCall ? ' last-call' : ''}`;
      if (lastCall) timer.textContent += '  DOUBLE';
    },
    setGems(n) {
      gems.textContent = `◆ ${n}`;
    },
    setSquad(n, cap) {
      squad.textContent = `${n}/${cap}`;
    },
    setScores(rows, myId) {
      left.innerHTML = '';
      for (const r of rows.slice(0, 8)) {
        const row = el('div', `score-row${r.id === myId ? ' me' : ''}`);
        const name = el('span');
        name.textContent = r.name;
        const g = el('span', 'g');
        g.textContent = String(r.gems);
        row.append(name, g);
        left.appendChild(row);
      }
    },
    showOffer(options, price, onPick) {
      if (offer) offer.remove();
      offer = el('div', 'offer');
      options.forEach((type, i) => {
        const def = UNIT_DEFS[type];
        const b = el('button');
        const sw = el('div', 'swatch');
        sw.style.background = `#${def.color.toString(16).padStart(6, '0')}`;
        const nm = el('div');
        nm.textContent = def.label;
        const role = el('div', 'role');
        role.textContent = def.role;
        b.append(sw, nm, role);
        b.onclick = () => onPick(i);
        offer!.appendChild(b);
      });
      const cost = el('div', 'pill');
      cost.textContent = `−${price} ◆`;
      cost.style.alignSelf = 'center';
      offer.appendChild(cost);
      document.body.appendChild(offer);
    },
    hideOffer() {
      offer?.remove();
      offer = null;
    },
    destroy() {
      root.remove();
      offer?.remove();
    },
  };
}

// ── results ─────────────────────────────────────────────────────────────────

export function showResults(
  standings: { id: number; name: string; gems: number }[],
  myId: number,
  isHost: boolean,
  onRematch: () => void,
): () => void {
  const overlay = el('div', 'overlay');
  const card = el('div', 'card results');
  const winner = standings[0];
  card.appendChild(el('h1', 'title', winner ? `${winner.name} wins` : 'Match over'));
  card.appendChild(el('p', 'subtitle', 'Final gem counts.'));

  const table = el('table');
  standings.forEach((s, i) => {
    const tr = el('tr', i === 0 ? 'win' : '');
    const rank = el('td');
    rank.textContent = `${i + 1}`;
    const name = el('td');
    name.textContent = s.name + (s.id === myId ? ' (you)' : '');
    const g = el('td', 'g');
    g.textContent = `◆ ${s.gems}`;
    tr.append(rank, name, g);
    table.appendChild(tr);
  });
  card.appendChild(table);

  const row = el('div', 'row mt');
  const btn = el('button');
  btn.textContent = isHost ? 'Rematch' : 'Waiting for host…';
  btn.disabled = !isHost;
  btn.onclick = () => {
    btn.disabled = true;
    onRematch();
  };
  row.appendChild(btn);
  card.appendChild(row);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  return () => overlay.remove();
}

// ── dev overlay (§5) ────────────────────────────────────────────────────────

export interface DevHandle {
  update: (rows: Record<string, string | number>) => void;
  toggle: () => void;
  destroy: () => void;
}

export function createDevPanel(): DevHandle {
  const panel = el('div', 'devpanel');
  panel.style.display = 'none';
  document.body.appendChild(panel);

  let visible = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === '`' || e.key === '~') {
      visible = !visible;
      panel.style.display = visible ? '' : 'none';
    }
  };
  window.addEventListener('keydown', onKey);

  return {
    update(rows) {
      if (!visible) return;
      panel.innerHTML = Object.entries(rows)
        .map(([k, v]) => `<div>${k} <b>${v}</b></div>`)
        .join('');
    },
    toggle() {
      visible = !visible;
      panel.style.display = visible ? '' : 'none';
    },
    destroy() {
      window.removeEventListener('keydown', onKey);
      panel.remove();
    },
  };
}

// ── virtual joystick ────────────────────────────────────────────────────────

export interface StickHandle {
  update: (active: boolean, ox: number, oy: number, kx: number, ky: number) => void;
  destroy: () => void;
}

/**
 * Visual for the touch joystick.
 *
 * The stick was previously tracked but never drawn, which left mobile players
 * with no feedback at all about where their thumb had anchored — the single
 * biggest barrier to the M7 goal of "an outsider can play without being told
 * anything". Only transforms are touched per frame, so this stays composited.
 */
export function createStick(): StickHandle {
  const base = el('div', 'stick');
  base.appendChild(el('div', 'stick-base'));
  const knob = el('div', 'stick');
  knob.appendChild(el('div', 'stick-knob'));
  document.body.append(base, knob);

  /** Must match STICK_RADIUS in input/controls.ts. */
  const maxTravel = 62;
  let shown = false;

  return {
    update(active, ox, oy, kx, ky) {
      if (active !== shown) {
        shown = active;
        base.classList.toggle('on', active);
        knob.classList.toggle('on', active);
      }
      if (!active) return;

      // Clamp the knob to the base so it can't fly off with the thumb.
      let dx = kx - ox;
      let dy = ky - oy;
      const len = Math.hypot(dx, dy);
      if (len > maxTravel) {
        dx = (dx / len) * maxTravel;
        dy = (dy / len) * maxTravel;
      }
      base.style.transform = `translate(${ox}px, ${oy}px)`;
      knob.style.transform = `translate(${ox + dx}px, ${oy + dy}px)`;
    },
    destroy() {
      base.remove();
      knob.remove();
    },
  };
}

// ── minimap ─────────────────────────────────────────────────────────────────

export interface MinimapHandle {
  setTerrain: (size: number, tiles: Uint8Array) => void;
  draw: (
    dots: { x: number; y: number; kind: string; team: number; mine: boolean }[],
    mapSize: number,
  ) => void;
  destroy: () => void;
}

const MINIMAP_TEAM_COLORS = [
  '#4da3ff', '#ff7a59', '#56d9a3', '#ffc857', '#b98bff', '#ff6bb5', '#5ee0e0', '#a3d94d',
];

/**
 * Corner minimap. Plain 2D canvas rather than another Pixi layer: it renders at
 * a fixed small size, never scales, and keeping it off the scene graph means it
 * costs nothing in the main batch.
 */
export function createMinimap(): MinimapHandle {
  const canvas = document.createElement('canvas');
  canvas.className = 'minimap';
  const px = 132;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = px * dpr;
  canvas.height = px * dpr;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  // Terrain is baked once — it never changes during a match.
  let terrain: HTMLCanvasElement | null = null;

  return {
    setTerrain(size, tiles) {
      const off = document.createElement('canvas');
      off.width = size;
      off.height = size;
      const octx = off.getContext('2d')!;
      const img = octx.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const wall = tiles[i] === 1;
        const o = i * 4;
        img.data[o] = wall ? 0x39 : 0x14;
        img.data[o + 1] = wall ? 0x44 : 0x1b;
        img.data[o + 2] = wall ? 0x5a : 0x26;
        img.data[o + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      terrain = off;
    },

    draw(dots, mapSize) {
      ctx.clearRect(0, 0, px, px);
      if (terrain) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(terrain, 0, 0, px, px);
      }
      const s = px / mapSize;

      // Draw pickups first so leaders always sit on top of them.
      for (const d of dots) {
        if (d.kind === 'gem') {
          ctx.fillStyle = '#56d9a3';
          ctx.fillRect(d.x * s - 1, d.y * s - 1, 2, 2);
        } else if (d.kind === 'chest') {
          ctx.fillStyle = '#ffc857';
          ctx.fillRect(d.x * s - 1.5, d.y * s - 1.5, 3, 3);
        }
      }
      for (const d of dots) {
        if (d.kind !== 'leader') continue;
        ctx.beginPath();
        ctx.arc(d.x * s, d.y * s, d.mine ? 3.5 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = MINIMAP_TEAM_COLORS[d.team % MINIMAP_TEAM_COLORS.length]!;
        ctx.fill();
        if (d.mine) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    },

    destroy() {
      canvas.remove();
    },
  };
}

// ── wipe / respawn banner ───────────────────────────────────────────────────

export interface BannerHandle {
  show: (big: string, small: string) => void;
  hide: () => void;
  destroy: () => void;
}

/** Tells the player why they suddenly have no squad — there was no feedback. */
export function createBanner(): BannerHandle {
  const root = el('div', 'banner');
  const big = el('div', 'big');
  const small = el('div', 'small');
  root.append(big, small);
  root.style.display = 'none';
  document.body.appendChild(root);

  return {
    show(b, s) {
      big.textContent = b;
      small.textContent = s;
      root.style.display = '';
    },
    hide() {
      root.style.display = 'none';
    },
    destroy() {
      root.remove();
    },
  };
}

// ── mute toggle ─────────────────────────────────────────────────────────────

/** Persisted so a player who mutes once stays muted across rematches. */
export function createMuteButton(
  initiallyMuted: boolean,
  onChange: (muted: boolean) => void,
): () => void {
  const btn = el('button', 'mute');
  let muted = initiallyMuted;
  const paint = (): void => {
    btn.textContent = muted ? 'Sound off' : 'Sound on';
  };
  paint();
  btn.onclick = () => {
    muted = !muted;
    localStorage.setItem('sa-muted', muted ? '1' : '0');
    paint();
    onChange(muted);
  };
  document.body.appendChild(btn);
  return () => btn.remove();
}
