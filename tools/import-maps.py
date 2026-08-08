"""Import the Squad Busters Gem Hunt arenas into `config/arenaData.ts`.

The wiki publishes each Gem Hunt map as an SVG authored *on the tile grid* —
`viewBox="0 0 64 64"`, the same 64x64 the sim uses, with terrain drawn as
axis-aligned rounded rectangles whose corners land on .05/.95 tile offsets and
every prop placed by integer `translate()`. So this is a transcription, not an
approximation: sampling the painted colour at each tile centre recovers the
layout exactly, and the object layer is read straight off the `<use>` hrefs.

Run it only to re-import (the wiki is not a build dependency):

    python tools/import-maps.py packages/shared/src/config/arenaData.ts

What maps to what:
  base `<rect>` fill  -> the void (water / lava / pit): impassable
  any painted terrain -> floor
  `* Deco Grass *`    -> tall grass, which is exactly its role there too
  `* Bridge *`        -> floor punched back through the void
  `Crop`              -> prop      `Box`   -> resource node
  `Tree`              -> tree      `Flag`  -> centre marker (ignored)
  `CommonChest`       -> chest pad `Tank`/`Hive` -> creep camp
  `* Mine Slot *`     -> the central gem mine

Hazards (spikes, fire traps, sand traps, disco tiles) have no counterpart in
this sim and are dropped rather than guessed at.
"""

import json
import re
import sys
import urllib.parse
import urllib.request

SIZE = 64
API = 'https://squad-busters.fandom.com/api.php'
UA = {'User-Agent': 'Mozilla/5.0 (gem-rush map import)'}

TILE_FLOOR, TILE_WALL, TILE_GRASS = 0, 1, 2

OBJECTS = {
    'Crop': 'props',
    'Box': 'nodes',
    'Tree': 'trees',
    'CommonChest': 'chests',
    'Tank': 'camps',
    'Hive': 'camps',
}


def api(**params):
    params['format'] = 'json'
    url = API + '?' + urllib.parse.urlencode(params)
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA)))


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        return r.read().decode('utf-8')


# ── svg reading ─────────────────────────────────────────────────────────────


def strip_defs(s):
    """Drop <defs> so symbol geometry is never mistaken for placed geometry."""
    out, i = [], 0
    while True:
        a = s.find('<defs', i)
        if a < 0:
            out.append(s[i:])
            return ''.join(out)
        out.append(s[i:a])
        i = s.find('</defs>', a) + 7


def parse_path(d):
    """SVG path data -> subpaths of points. Only M/L/Q/Z appear in these files."""
    toks = re.findall(r'[MLQZmlqz]|-?\d*\.?\d+', d)
    subs, cur = [], []
    x = y = 0.0
    i, cmd = 0, None
    while i < len(toks):
        t = toks[i]
        if t in 'MLQZmlqz':
            cmd = t
            i += 1
            if cmd in 'Zz':
                if cur:
                    subs.append(cur)
                    cur = []
                continue
        if cmd in 'Mm':
            nx, ny = float(toks[i]), float(toks[i + 1])
            i += 2
            x, y = (nx, ny) if cmd == 'M' else (x + nx, y + ny)
            if cur:
                subs.append(cur)
            cur = [(x, y)]
            cmd = 'L' if cmd == 'M' else 'l'
        elif cmd in 'Ll':
            nx, ny = float(toks[i]), float(toks[i + 1])
            i += 2
            x, y = (nx, ny) if cmd == 'L' else (x + nx, y + ny)
            cur.append((x, y))
        elif cmd in 'Qq':
            cx, cy, nx, ny = (float(v) for v in toks[i:i + 4])
            i += 4
            if cmd == 'q':
                cx, cy, nx, ny = x + cx, y + cy, x + nx, y + ny
            x0, y0 = x, y
            # Three samples is ample: every curve here is a sub-tile corner.
            for k in (0.34, 0.67, 1.0):
                m = 1 - k
                cur.append((m * m * x0 + 2 * m * k * cx + k * k * nx,
                            m * m * y0 + 2 * m * k * cy + k * k * ny))
            x, y = nx, ny
        else:
            i += 1
    if cur:
        subs.append(cur)
    return subs


def fill_tiles(subs):
    """Even-odd scanline fill, sampled at tile centres."""
    hits = [[False] * SIZE for _ in range(SIZE)]
    for row in range(SIZE):
        sy = row + 0.5
        xs = []
        for sub in subs:
            n = len(sub)
            for k in range(n):
                x1, y1 = sub[k]
                x2, y2 = sub[(k + 1) % n]
                if (y1 > sy) == (y2 > sy):
                    continue
                xs.append(x1 + (sy - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        for a in range(0, len(xs) - 1, 2):
            lo, hi = xs[a], xs[a + 1]
            for col in range(max(0, int(lo)), min(SIZE, int(hi) + 2)):
                if lo <= col + 0.5 <= hi:
                    hits[row][col] = True
    return hits


def placement(seg):
    """Tile rect covered by a <use>, honouring translate/rotate transforms."""
    t = re.search(r'transform="([^"]+)"', seg)
    if not t:
        x = re.search(r'\bx="(-?[\d.]+)"', seg)
        y = re.search(r'\by="(-?[\d.]+)"', seg)
        px = float(x.group(1)) if x else 0.0
        py = float(y.group(1)) if y else 0.0
        return px, py, 1.0, 1.0

    # Compose the transform list right-to-left onto the unit box.
    ops = re.findall(r'(translate|rotate)\(([^)]*)\)', t.group(1))
    m = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)  # a b c d e f

    def mul(p, q):
        a1, b1, c1, d1, e1, f1 = p
        a2, b2, c2, d2, e2, f2 = q
        return (a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
                a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
                a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1)

    for op, raw in ops:
        v = [float(n) for n in re.findall(r'-?[\d.]+', raw)]
        if op == 'translate':
            m = mul(m, (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0))
        else:
            import math
            r = math.radians(v[0])
            cs, sn = round(math.cos(r)), round(math.sin(r))
            m = mul(m, (cs, sn, -sn, cs, 0, 0))

    w = re.search(r'data-w="(\d+)"', seg)
    h = re.search(r'data-h="(\d+)"', seg)
    bw = float(w.group(1)) if w else 1.0
    bh = float(h.group(1)) if h else 1.0
    a, b, c, d, e, f = m
    xs = [a * cx + c * cy + e for cx in (0, bw) for cy in (0, bh)]
    ys = [b * cx + d * cy + f for cx in (0, bw) for cy in (0, bh)]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def pattern_colours(svg):
    """
    `url(#id)` fills are checker patterns; map each to its pair of rect fills.

    The pair matters. A pattern's two tones are drawn a few percent apart on
    purpose — they give the ground a sense of scale without becoming a visible
    grid — so they are the only honest source for the floor checker. Picking the
    two commonest colours on the map instead lands on genuinely different
    terrain (Steel Gauntlet's stone and its grass), and the arena renders as a
    chessboard.
    """
    out = {}
    for m in re.finditer(r'<pattern id="([^"]+)"(.*?)</pattern>', svg, re.S):
        fills = re.findall(r'fill="(#[0-9a-fA-F]{3,6})"', m.group(2))
        if fills:
            second = next((f for f in fills if f != fills[0]), fills[0])
            out[f'url(#{m.group(1)})'] = (fills[0], second)
    return out


def shade(colour, factor):
    """Darken a `#rrggbb` by `factor`, for arenas whose floor is a flat fill."""
    c = colour.lstrip('#')
    rgb = [int(c[i:i + 2], 16) for i in (0, 2, 4)]
    return '#' + ''.join(f'{max(0, min(255, round(v * factor))):02x}' for v in rgb)


def convert(svg):
    body = strip_defs(svg)
    patterns = pattern_colours(svg)

    # Symbol footprints live in <defs>; read them before stripping.
    sizes = {}
    for m in re.finditer(r'<g id="([^"]+)"[^>]*data-w="(\d+)"[^>]*data-h="(\d+)"', svg):
        sizes[m.group(1)] = (int(m.group(2)), int(m.group(3)))

    # 1. Paint the terrain layers in document order, keeping the colour that
    #    ends up on top of each tile. The void is drawn, not left blank, so a
    #    tile's impassability is a question about its final colour.
    base = re.search(r'<rect[^>]*width="64"[^>]*fill="([^"]+)"', body)
    colours = [[base.group(1) if base else 'none'] * SIZE for _ in range(SIZE)]
    for m in re.finditer(r'<path\b[^>]*?/>', body):
        seg = m.group(0)
        f = re.search(r'fill="([^"]+)"', seg)
        d = re.search(r'\sd="([^"]+)"', seg)
        if not f or not d or f.group(1) == 'none':
            continue
        colour = f.group(1)
        for y, row in enumerate(fill_tiles(parse_path(d.group(1)))):
            for x, hit in enumerate(row):
                if hit:
                    colours[y][x] = colour

    # 2. Read the placed symbols. Bridges are collected rather than applied,
    #    because they are also what identifies the void: a bridge exists only to
    #    cross one, so whatever a bridge lies on is impassable by definition.
    #    That beats keying off the backing rect, which several maps paint over
    #    entirely (Midnight Mortuary backs a slime map with water).
    objects = {k: [] for k in set(OBJECTS.values())}
    bridges, grass = [], []
    mine = None

    for m in re.finditer(r'<use\b[^>]*?/?>', body):
        seg = m.group(0)
        href = re.search(r'href="#([^"]+)"', seg)
        if not href:
            continue
        name = href.group(1)
        if name in sizes:
            w, h = sizes[name]
            seg = seg.replace('<use', f'<use data-w="{w}" data-h="{h}"', 1)
        px, py, pw, ph = placement(seg)

        if 'Mine Slot' in name:
            # The symbol is drawn centred on its translate point.
            mine = (px + pw / 2, py + ph / 2)
        elif 'Bridge' in name:
            bridges.extend(
                (x, y)
                for y in range(int(round(py)), int(round(py + ph)))
                for x in range(int(round(px)), int(round(px + pw)))
                if 0 <= x < SIZE and 0 <= y < SIZE
            )
        elif 'Deco Grass' in name:
            grass.append((int(round(px)), int(round(py))))
        elif name in OBJECTS:
            objects[OBJECTS[name]].append((round(px, 1), round(py, 1)))

    under = {}
    for x, y in bridges:
        under[colours[y][x]] = under.get(colours[y][x], 0) + 1
    # A bridge overhangs its banks by a tile at each end, so the land colour
    # shows up too; keep only colours that account for a real share of the span.
    cutoff = max(under.values()) * 0.25 if under else 0
    void = {c for c, n in under.items() if n >= cutoff}

    tiles = [[TILE_WALL if c in void else TILE_FLOOR for c in row] for row in colours]
    for x, y in bridges:
        tiles[y][x] = TILE_FLOOR
    for x, y in grass:
        if 0 <= x < SIZE and 0 <= y < SIZE and tiles[y][x] == TILE_FLOOR:
            tiles[y][x] = TILE_GRASS

    # The arena's own colours, so a lava map does not render as a green field.
    def solid(c):
        return patterns[c][0] if c in patterns else c

    land = {}
    for y in range(SIZE):
        for x in range(SIZE):
            if tiles[y][x] != TILE_WALL:
                c = colours[y][x]
                land[c] = land.get(c, 0) + 1
    top = max(land, key=land.get) if land else None

    # The checker pair comes from the dominant fill itself — from its pattern
    # where it has one, and from a shade of it where the arena is drawn flat.
    if top in patterns:
        floor, floor_alt = patterns[top]
    elif top:
        floor, floor_alt = top, shade(top, 0.93)
    else:
        floor, floor_alt = '#6bbf59', '#63b552'

    palette = {
        'void': solid(max(under, key=under.get)) if under else '#05a3ff',
        'floor': floor,
        'floorAlt': floor_alt,
    }

    return tiles, objects, mine, palette


# ── emit ────────────────────────────────────────────────────────────────────


def rle(tiles):
    """Tile grid -> runs of `<count><kind>`, e.g. `12a3b`. a=floor b=wall c=grass."""
    flat = [t for row in tiles for t in row]
    out, run, prev = [], 0, flat[0]
    for t in flat:
        if t == prev:
            run += 1
        else:
            out.append(f'{run}{"abc"[prev]}')
            run, prev = 1, t
    out.append(f'{run}{"abc"[prev]}')
    return ''.join(out)


def slug(name):
    return re.sub(r'[^a-z0-9]+', '', name.lower().replace("'", '').replace('’', ''))


def main(out_path):
    members = api(action='query', list='categorymembers',
                  cmtitle='Category:Gem_Hunt_maps', cmlimit='200')['query']['categorymembers']

    entries = []
    for mem in members:
        title = mem['title']
        name = title[4:]
        page = api(action='query', titles=title, prop='revisions',
                   rvprop='content', rvslots='main')['query']['pages']
        cfg = json.loads(next(iter(page.values()))['revisions'][0]['slots']['main']['*'])
        world = next((c for c in cfg['pageCategories'] if c != 'Gem_Hunt_maps'), '')
        world = world.replace('_World_maps', '').replace('_maps', '').replace('_', ' ')

        info = api(action='query', titles='File:' + cfg['mapImage'],
                   prop='imageinfo', iiprop='url')['query']['pages']
        svg = fetch(next(iter(info.values()))['imageinfo'][0]['url'])

        tiles, objects, mine, palette = convert(svg)
        floor = sum(1 for r in tiles for t in r if t != TILE_WALL)
        entries.append({
            'id': slug(name), 'name': name, 'world': world,
            'tiles': rle(tiles), 'objects': objects,
            'mine': mine or (SIZE / 2, SIZE / 2), 'palette': palette,
        })
        print(f'{name:22} {world:14} floor={floor:5} '
              + ' '.join(f'{k}={len(v)}' for k, v in sorted(objects.items()))
              + f"  {palette['void']}/{palette['floor']}/{palette['floorAlt']}")

    entries.sort(key=lambda e: e['name'])
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(render(entries))
    print(f'\nwrote {out_path} ({len(entries)} arenas)')


def render(entries):
    lines = [
        '/**',
        ' * The Gem Hunt arenas, transcribed from the published map art.',
        ' *',
        ' * GENERATED by `tools/import-maps.py` — edit that, not this. Each arena is',
        ' * a 64x64 tile grid (run-length encoded: `a` floor, `b` void, `c` tall',
        ' * grass) plus the object placements read off the same source, so the',
        ' * layouts are transcriptions rather than seeds that happen to look right.',
        ' *',
        ' * `mine` is the central gem mine slot the source art marks on every map.',
        ' */',
        '',
        'export interface ArenaObjects {',
        '  props: [number, number][];',
        '  nodes: [number, number][];',
        '  trees: [number, number][];',
        '  chests: [number, number][];',
        '  camps: [number, number][];',
        '}',
        '',
        '/** The arena\'s own colours, lifted from its art. */',
        'export interface ArenaPalette {',
        '  /** Water, lava, slime — whatever this world drowns you in. */',
        '  void: number;',
        '  /** Two floor tones, laid in a checker so movement has a sense of scale. */',
        '  floor: number;',
        '  floorAlt: number;',
        '}',
        '',
        'export interface ArenaData {',
        '  id: string;',
        '  name: string;',
        '  world: string;',
        '  /** 64x64 run-length encoded tile grid. */',
        '  tiles: string;',
        '  objects: ArenaObjects;',
        '  mine: [number, number];',
        '  palette: ArenaPalette;',
        '}',
        '',
        'export const ARENA_DATA: ArenaData[] = [',
    ]
    for e in entries:
        lines.append('  {')
        lines.append(f"    id: '{e['id']}',")
        lines.append(f"    name: {json.dumps(e['name'])},")
        lines.append(f"    world: {json.dumps(e['world'])},")
        lines.append(f"    tiles: '{e['tiles']}',")
        lines.append('    objects: {')
        for key in ('props', 'nodes', 'trees', 'chests', 'camps'):
            pts = ','.join(f'[{x:g},{y:g}]' for x, y in e['objects'][key])
            lines.append(f'      {key}: [{pts}],')
        lines.append('    },')
        lines.append(f"    mine: [{e['mine'][0]:g}, {e['mine'][1]:g}],")
        p = e['palette']
        lines.append(
            '    palette: { '
            + ', '.join(f"{k}: 0x{p[k].lstrip('#'):0>6}" for k in ('void', 'floor', 'floorAlt'))
            + ' },'
        )
        lines.append('  },')
    lines.append('];')
    lines.append('')
    return '\n'.join(lines)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'arenaData.ts')
