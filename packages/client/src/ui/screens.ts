/**
 * DOM chrome: join, lobby, HUD, chest offer, results, dev overlay.
 *
 * Plain DOM rather than a framework — the brief allows React for menus but
 * none of this is complex enough to earn a dependency, and keeping it out of
 * the bundle helps the <2MB budget.
 */

import { UNIT_DEFS, type LobbyPlayer, type UnitType } from '@squad-arena/shared';

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

export function showJoin(onJoin: (name: string) => void): () => void {
  const overlay = el('div', 'overlay');
  const card = el('div', 'card');

  card.appendChild(el('h1', 'title', 'Squad Arena'));
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
  input.placeholder = 'e.g. Sherman';
  input.value = localStorage.getItem('sa-name') ?? '';

  const row = el('div', 'row mt');
  const btn = el('button');
  btn.textContent = 'Join game';
  row.appendChild(btn);

  const err = el('div', 'err');

  const submit = (): void => {
    const name = input.value.trim() || 'Player';
    localStorage.setItem('sa-name', name);
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    onJoin(name);
  };
  btn.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
  };

  card.append(label, input, row, err);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 50);

  return () => overlay.remove();
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
