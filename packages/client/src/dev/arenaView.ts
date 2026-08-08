/**
 * Live arena viewer (see arena.html).
 *
 * Dev-only, and deliberately built on the real `Scene` rather than a redraw of
 * the tile rules: a preview that paints the map its own way can look perfect
 * while the thing players actually see is broken, which is worse than having no
 * preview at all. So this calls `buildTerrain` and `render` exactly as a match
 * does, at the real zoom, and only the entity list is faked.
 *
 * It is the only way to see two things without playing a full match: whether a
 * world's palette still works with sprites standing on it, and what the mine
 * looks like once its detonation glow winds up.
 */

import { ARENAS, MAP_IDS, buildArena, type MapId } from '@gem-rush/shared';

import type { ViewEntity } from '../net/connection.ts';
import { Scene } from '../render/scene.ts';

/**
 * A spread of entities around the mine, so every sprite class is seen against
 * the palette rather than the terrain alone.
 */
function sampleEntities(cx: number, cy: number): Map<number, ViewEntity> {
  const at = (
    id: number,
    kind: string,
    dx: number,
    dy: number,
    extra: Partial<ViewEntity> = {},
  ): [number, ViewEntity] => [
    id,
    {
      id,
      kind,
      x: cx + dx,
      y: cy + dy,
      team: 0,
      unitType: null,
      tier: 0,
      hpFrac: 1,
      value: 0,
      ...extra,
    },
  ];

  return new Map([
    at(1, 'mine', 0, 0),
    at(2, 'leader', -5, 3.5),
    at(3, 'unit', -3.6, 4, { unitType: 'brute' }),
    at(4, 'unit', -2.3, 4.2, { unitType: 'archer' }),
    at(5, 'leader', 5, 3.5, { team: 1 }),
    at(6, 'unit', 3.6, 4, { team: 1, unitType: 'golem' }),
    at(7, 'creep', 6, -4),
    at(8, 'chest', -6, -4),
    at(9, 'prop', -3.8, -5.5),
    at(10, 'node', 3.8, -5.5),
    at(11, 'tree', 8, 0.5),
    at(12, 'field', -8, 0.5),
    at(13, 'gem', 2, 1.6),
    at(14, 'coin', 2.7, 1),
  ]);
}

const scene = new Scene();
const picker = document.getElementById('map') as HTMLSelectElement;
const charge = document.getElementById('charge') as HTMLInputElement;

for (const id of MAP_IDS as readonly MapId[]) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = `${ARENAS[id].name} · ${ARENAS[id].world}`;
  picker.appendChild(opt);
}

let current: MapId = (MAP_IDS as readonly MapId[]).includes(
  location.hash.slice(1) as MapId,
)
  ? (location.hash.slice(1) as MapId)
  : MAP_IDS[0]!;

function show(id: MapId): void {
  current = id;
  picker.value = id;
  location.hash = id;
  const arena = buildArena(id, 8);
  scene.buildTerrain(arena.size, arena.tiles, id);

  const view = sampleEntities(arena.mine.x, arena.mine.y);
  const eye = { x: arena.mine.x, y: arena.mine.y };
  // Several frames: the camera jumps into place on the first, and the zoom
  // easing needs a few more before a screenshot means anything.
  for (let i = 0; i < 40; i++) scene.render(view, eye, 3, 1 / 60);
}

async function main(): Promise<void> {
  await scene.init(document.getElementById('stage') as HTMLElement);
  scene.localTeam = 0;

  picker.onchange = () => show(picker.value as MapId);
  charge.oninput = () => {
    scene.mineCharge = Number(charge.value);
    show(current);
  };
  show(current);

  // Hooks for the screenshot harness in tools/shots.mjs.
  Object.assign(window, {
    showArena: (id: MapId, mineCharge = 0) => {
      scene.mineCharge = mineCharge;
      show(id);
    },
    mapIds: (MAP_IDS as readonly MapId[]).map((id) => ({ id, world: ARENAS[id].world })),
  });
  document.body.dataset.ready = 'true';
}

void main();
