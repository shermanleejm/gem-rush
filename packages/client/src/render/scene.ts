/**
 * Pixi scene (brief §2.7).
 *
 * Layer containers, sprite pooling, and a camera that follows the leader.
 * Nothing is constructed in the render loop: units, gems and hit effects all
 * come from pools, because §6 calls out mobile performance as a risk to design
 * for from M1 rather than retrofit.
 */

import { Application, Container, Graphics, Sprite, Text, TextStyle, type Renderer } from 'pixi.js';

import { MAP, TILE_GRASS, TILE_WALL, UNIT_DEFS, type UnitType } from '@gem-rush/shared';

import type { ViewEntity } from '../net/connection.ts';
import { buildSpriteAtlas, type SpriteAtlas } from './sprites3d.ts';

/**
 * Screen pixels per world tile at zoom 1.
 *
 * Raised from 34: at the old scale a unit was about 20px across, which is too
 * small for its silhouette and shading to read at all — and far too small on a
 * phone. The cost is seeing slightly less of the arena, which the minimap
 * already covers.
 */
const BASE_SCALE = 44;

/** Authored large and scaled down, so popups stay sharp at any camera zoom. */
const POPUP_STYLE = new TextStyle({
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  fontSize: 64,
  fontWeight: '900',
  fill: 0xffffff,
  stroke: { color: 0x11161f, width: 8 },
});

/** How long a dropped pickup spends bursting out before it settles. */
const POP_SECONDS = 0.42;

const TEAM_COLORS = [
  0x4da3ff, 0xff7a59, 0x56d9a3, 0xffc857, 0xb98bff, 0xff6bb5, 0x5ee0e0, 0xa3d94d,
];

export class Scene {
  app!: Application;
  /** Pixi init is async; callers must not touch `app` before this is true. */
  ready = false;
  readonly world = new Container();
  readonly terrainLayer = new Container();
  readonly shadowLayer = new Container();
  readonly propLayer = new Container();
  readonly entityLayer = new Container();
  readonly effectLayer = new Container();

  private atlas!: SpriteAtlas;

  private pool: Sprite[] = [];
  private active: Sprite[] = [];
  private shadowPool: Sprite[] = [];
  private shadows: Sprite[] = [];
  private effects: { s: Sprite; life: number; max: number; vx: number; vy: number }[] = [];
  private projectiles: {
    s: Sprite;
    life: number;
    max: number;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    color: number;
  }[] = [];
  private effectPool: Sprite[] = [];
  private barPool: Graphics[] = [];
  private activeBars: Graphics[] = [];
  private popups: { t: Text; life: number; max: number }[] = [];
  private popupPool: Text[] = [];
  /** Match time each pickup id was first seen, for the pop-in animation. */
  private seenAt = new Map<number, number>();

  private camX = MAP.size / 2;
  private camY = MAP.size / 2;
  private cameraPlaced = false;
  /** Seconds since the scene started; drives idle animation. */
  private time = 0;
  private zoom = 1;
  private targetZoom = 1;

  private labelPool: Text[] = [];
  private activeLabels: Text[] = [];

  async init(mount: HTMLElement): Promise<void> {
    this.app = new Application();
    await this.app.init({
      background: 0x2f6b8f,
      antialias: false,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      resizeTo: window,
      // Pixi picks WebGL and falls back to canvas on its own; forcing either
      // costs us the fallback on old mobile GPUs.
      preference: 'webgl',
    });
    mount.appendChild(this.app.canvas);

    this.world.addChild(
      this.terrainLayer,
      this.shadowLayer,
      this.propLayer,
      this.entityLayer,
      this.effectLayer,
    );
    this.app.stage.addChild(this.world);

    this.buildTextures();
    this.ready = true;
  }

  /**
   * Bake the sprite atlas from 3D models (see render/sprites3d.ts). Each sprite
   * is a real lit mesh rendered once at boot, in near-white so it can be tinted
   * per archetype and team, with a silhouette that reads role before colour
   * does (§1.5).
   */
  private buildTextures(): void {
    this.atlas = buildSpriteAtlas();
  }

  /**
   * Bake the tilemap into one sprite.
   * 64x64 tiles as individual sprites would be 4096 nodes that never change;
   * drawing once into a texture makes terrain effectively free.
   */
  buildTerrain(size: number, tiles: Uint8Array): void {
    this.cameraPlaced = false; // new map, re-snap to wherever we spawn
    this.terrainLayer.removeChildren();

    // Backdrop beyond the arena, drawn as vector geometry rather than baked
    // into the tile texture. The camera no longer clamps to the map, so the
    // space outside is on screen whenever the leader nears an edge — and every
    // home pad is on the rim, so that is every spawn. Baking it into the same
    // texture meant stretching a map-sized bitmap across a much larger area,
    // which came out badly blurred; a Graphics fill stays crisp at any zoom and
    // costs one draw call.
    const pad = 200;
    const backdrop = new Graphics()
      .rect(-pad, -pad, size + pad * 2, size + pad * 2)
      // Water, not void. Every home pad is on the rim, so this is on screen at
      // every spawn — a black surround made the whole game feel like it was
      // happening at night.
      .fill(0x2f6b8f);
    this.terrainLayer.addChild(backdrop);

    const g = new Graphics();

    // A bright mown-field checker, not a dark void. The arena used to be almost
    // black, which made every tinted sprite on top of it read as gloomy no
    // matter how the sprites themselves were lit — the floor sets the mood for
    // everything standing on it. Two close greens in a 2-tile check give the
    // ground readable scale as you move without turning into a busy pattern.
    g.rect(0, 0, size, size).fill(0x6bbf59);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (((x >> 1) + (y >> 1)) % 2 === 0) g.rect(x, y, 1, 1).fill(0x63b552);
      }
    }

    // Zone rings, so the contested centre reads at a glance. Warm and subtle:
    // they should say "this is the middle", not repaint the field.
    const c = size / 2;
    g.circle(c, c, MAP.zoneRadii[2]!).fill({ color: 0xffffff, alpha: 0.05 });
    g.circle(c, c, MAP.zoneRadii[1]!).fill({ color: 0xffe27a, alpha: 0.07 });
    g.circle(c, c, MAP.zoneRadii[0]!).fill({ color: 0xffe27a, alpha: 0.1 });

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = tiles[y * size + x];
        if (t === TILE_WALL) {
          // Rock, with a lighter top edge so the wall reads as having height.
          g.rect(x, y, 1, 1).fill(0x8d7c68);
          g.rect(x, y, 1, 0.28).fill(0xa89684);
        } else if (t === TILE_GRASS) {
          // Tall grass: darker and cooler than the mown field, so the slow
          // zones are obvious before you walk into one.
          g.rect(x, y, 1, 1).fill(0x3f8f46);
        }
      }
    }

    // Texture stays exactly map-sized so tiles remain crisp.
    const tex = (this.app.renderer as Renderer).generateTexture({
      target: g,
      resolution: 2,
    });
    const sprite = new Sprite(tex);
    sprite.width = size;
    sprite.height = size;
    this.terrainLayer.addChild(sprite);
    g.destroy();

    // Rim on top of the tiles, so the playable area has a definite edge against
    // the backdrop rather than fading into it.
    const rim = new Graphics()
      .rect(0, 0, size, size)
      .stroke({ color: 0xe0d5a8, width: 0.6, alignment: 1 });
    this.terrainLayer.addChild(rim);
  }

  /**
   * World position -> CSS pixel position, for DOM chrome that has to track
   * something in the arena (the gem tag over your character).
   */
  worldToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: this.world.position.x + x * this.world.scale.x,
      y: this.world.position.y + y * this.world.scale.y,
    };
  }

  private takeShadow(): Sprite {
    const s = this.shadowPool.pop() ?? new Sprite();
    s.visible = true;
    s.anchor.set(0.5);
    s.texture = this.atlas.shadow;
    s.tint = 0xffffff;
    this.shadows.push(s);
    this.shadowLayer.addChild(s);
    return s;
  }

  private take(): Sprite {
    const s = this.pool.pop() ?? new Sprite();
    s.visible = true;
    s.anchor.set(0.5);
    this.active.push(s);
    return s;
  }

  /** Return every sprite to the pool. Called once per frame before redraw. */
  private releaseAll(): void {
    for (const s of this.shadows) {
      s.visible = false;
      if (s.parent) s.parent.removeChild(s);
      this.shadowPool.push(s);
    }
    this.shadows.length = 0;

    for (const s of this.active) {
      s.visible = false;
      if (s.parent) s.parent.removeChild(s);
      this.pool.push(s);
    }
    this.active.length = 0;

    for (const g of this.activeBars) {
      g.visible = false;
      if (g.parent) g.parent.removeChild(g);
      this.barPool.push(g);
    }
    this.activeBars.length = 0;

    for (const t of this.activeLabels) {
      t.visible = false;
      if (t.parent) t.parent.removeChild(t);
      this.labelPool.push(t);
    }
    this.activeLabels.length = 0;
  }

  /** Drop pop-in bookkeeping for pickups that no longer exist. */
  private pruneSeen(entities: Map<number, ViewEntity>): void {
    if (this.seenAt.size < 256) return;
    for (const id of this.seenAt.keys()) {
      if (!entities.has(id)) this.seenAt.delete(id);
    }
  }

  /** Draw one frame of interpolated state. */
  render(
    entities: Map<number, ViewEntity>,
    localLeader: { x: number; y: number } | null,
    squadSize: number,
    dt: number,
  ): void {
    this.releaseAll();
    this.pruneSeen(entities);
    this.time += dt;

    // Camera: follow with a soft lerp, zoom out as the squad grows so a big
    // blob stays framed (§2.7).
    if (localLeader) {
      if (!this.cameraPlaced) {
        // First frame: jump, don't ease. Easing in from the map centre reads
        // as the camera drifting off the player at the start of every match.
        this.camX = localLeader.x;
        this.camY = localLeader.y;
        this.cameraPlaced = true;
      } else {
        this.camX += (localLeader.x - this.camX) * Math.min(1, dt * 8);
        this.camY += (localLeader.y - this.camY) * Math.min(1, dt * 8);
      }
    }
    this.targetZoom = Math.max(0.72, 1 - squadSize * 0.016);
    this.zoom += (this.targetZoom - this.zoom) * Math.min(1, dt * 3);

    const scale = BASE_SCALE * this.zoom;
    // app.screen is the logical (CSS) viewport. renderer.width is already
    // logical too, so dividing it by resolution shrank the viewport by the
    // device pixel ratio — invisible at DPR 1, but on a DPR-3 phone the leader
    // rendered at a third of the way across instead of centred.
    const w = this.app.screen.width;
    const h = this.app.screen.height;

    this.world.scale.set(scale);
    // No clamping to the arena bounds: the leader is the thing the player is
    // steering and it stays dead centre, always. Clamping kept the void off
    // screen but pushed the leader into a corner whenever they approached an
    // edge — and home pads sit on the rim, so that was every single spawn.
    const cx = this.camX;
    const cy = this.camY;
    this.world.position.set(w / 2 - cx * scale, h / 2 - cy * scale);

    // Cull to the visible rect plus a margin — off-screen entities cost nothing.
    const halfW = w / (2 * scale);
    const halfH = h / (2 * scale);
    const minX = cx - halfW - 2;
    const maxX = cx + halfW + 2;
    const minY = cy - halfH - 2;
    const maxY = cy + halfH + 2;

    const sorted: ViewEntity[] = [];
    for (const e of entities.values()) {
      if (e.x < minX || e.x > maxX || e.y < minY || e.y > maxY) continue;
      sorted.push(e);
    }
    // Painter's algorithm by y so squads overlap believably.
    sorted.sort((a, b) => a.y - b.y);

    for (const e of sorted) this.drawEntity(e, localLeader);
    this.updateEffects(dt);
    this.updateProjectiles(dt);
    this.updatePopups(dt);
  }

  private drawEntity(e: ViewEntity, localLeader: { x: number; y: number } | null): void {
    const s = this.take();

    switch (e.kind) {
      case 'gem': {
        s.texture = this.atlas.gem;
        s.tint = 0x56d9a3;
        // Gentle pulse so loose gems catch the eye against a busy floor.
        const pulse = 1 + Math.sin(this.time * 5 + e.id) * 0.07;
        s.width = s.height = 0.46 * pulse;
        break;
      }
      case 'prop':
        s.texture = this.atlas.prop;
        s.tint = 0x8a6f4f;
        s.width = s.height = 0.86;
        break;
      case 'node':
        s.texture = this.atlas.node;
        s.tint = 0x37b0c9;
        s.width = s.height = 1.1;
        break;
      case 'chest':
        s.texture = this.atlas.chest;
        s.tint = 0xffc857;
        s.width = s.height = 1.05;
        break;
      case 'coin': {
        // Same faceted shape as a gem but gold and smaller: the two are read at
        // a glance by colour, and the size difference reinforces which one is
        // score and which is change.
        const coinPulse = 1 + Math.sin(this.time * 6 + e.id) * 0.08;
        s.texture = this.atlas.gem;
        s.tint = 0xffc93c;
        s.width = s.height = 0.4 * coinPulse;
        break;
      }
      case 'tree':
        s.texture = this.atlas.node;
        s.tint = 0x3f9142;
        s.width = s.height = 1.45;
        break;
      case 'field':
        s.texture = this.atlas.prop;
        s.tint = 0xe8963c;
        s.width = s.height = 1.0;
        break;
      case 'hatchling':
        // Hatchling Run's rescue objective. Reuses the Fowl model, warm-tinted
        // and small, so it reads as "a little one of those" without a
        // dedicated sprite that only one of four modes would ever use.
        s.texture = this.atlas.fowl;
        s.tint = 0xffe9a8;
        s.width = s.height = 0.62;
        break;
      case 'creep':
        s.texture = this.atlas.creep;
        s.tint = 0x9aa3b5;
        s.width = s.height = 0.68;
        break;
      case 'leader': {
        s.texture = this.atlas.leader;
        s.tint = TEAM_COLORS[e.team % TEAM_COLORS.length]!;
        s.width = s.height = 0.95;
        break;
      }
      case 'unit': {
        const def = e.unitType ? UNIT_DEFS[e.unitType as UnitType] : null;
        s.texture = e.unitType ? this.atlas[e.unitType as UnitType] : this.atlas.brute;
        s.tint = def ? def.color : 0xffffff;
        const size = (def ? def.radius : 0.3) * 2.5 * (1 + e.tier * 0.26);
        s.width = s.height = size;
        break;
      }
      default:
        s.texture = this.atlas.spark;
        s.tint = 0xffffff;
        s.width = s.height = 0.5;
    }

    // The local leader renders at its predicted position, not the interpolated
    // one — that is the whole point of prediction.
    let px = e.x;
    let py = e.y;
    if (e.kind === 'leader' && localLeader && e.team === this.localTeam) {
      px = localLeader.x;
      py = localLeader.y;
    }

    const size = Number(s.width);

    // Ground shadow before any vertical animation, so the sprite bobs *above*
    // its shadow rather than dragging it along — that separation is most of
    // what sells the motion.
    if (e.kind === 'unit' || e.kind === 'creep' || e.kind === 'leader') {
      const sh = this.takeShadow();
      sh.x = px;
      sh.y = py + size * 0.38;
      sh.width = size * 0.85;
      sh.height = size * 0.42;
    }

    // Idle bob, offset per entity so a squad breathes rather than pulsing in
    // lockstep. Gems get a bigger, faster bounce because they are the reward.
    let bob = 0;
    if (e.kind === 'unit' || e.kind === 'creep') {
      bob = Math.sin(this.time * 4 + e.id * 1.7) * size * 0.045;
    } else if (e.kind === 'gem' || e.kind === 'coin') {
      bob = Math.sin(this.time * 5 + e.id) * 0.09;
      s.rotation = Math.sin(this.time * 2.2 + e.id) * 0.25;

      // Pop-in. The sim drops pickups straight onto the floor at their final
      // position, which appears as a pile blinking into existence. Giving each
      // one a brief hop and an overshooting scale as it arrives makes a smashed
      // crate read as bursting rather than as inventory arriving.
      let born = this.seenAt.get(e.id);
      if (born === undefined) {
        born = this.time;
        this.seenAt.set(e.id, born);
      }
      const age = this.time - born;
      if (age < POP_SECONDS) {
        const k = age / POP_SECONDS;
        // Arc up and back down, with a little spin, so it looks thrown.
        bob -= Math.sin(k * Math.PI) * 0.85;
        s.rotation += (1 - k) * 5 * (e.id % 2 === 0 ? 1 : -1);
        // Overshoot past full size and settle, which reads as impact.
        const punch = k < 0.7 ? 1.55 * (k / 0.7) : 1.55 - 0.55 * ((k - 0.7) / 0.3);
        s.width *= punch;
        s.height *= punch;
      }
    } else if (e.kind === 'tree') {
      // Trees sway rather than bob — they are rooted.
      s.rotation = Math.sin(this.time * 1.1 + e.id) * 0.05;
    } else if (e.kind === 'chest') {
      bob = Math.sin(this.time * 2.4 + e.id) * 0.05;
    } else if (e.kind === 'hatchling') {
      // Hop rather than drift: it should look alive and worth going to get.
      bob = Math.abs(Math.sin(this.time * 3.2 + e.id * 2.1)) * 0.16;
    }

    s.x = px;
    s.y = py + bob;
    this.entityLayer.addChild(s);

    if (e.kind === 'unit' || e.kind === 'creep') {
      // A light damage tint on top of the bar. The bar gives the number, the
      // fade gives the at-a-glance read when there are twenty units on screen
      // and nobody is reading bars.
      s.alpha = e.hpFrac < 0.999 ? 0.72 + e.hpFrac * 0.28 : 1;

      // Health bar, drawn only once a unit is actually hurt. Showing a full bar
      // over every unit at all times turns a busy fight into a wall of green
      // and hides the one piece of information the bar exists to give.
      if (e.hpFrac < 0.995) {
        this.drawHealthBar(s.x, s.y - size * 0.62, size * 0.86, e.hpFrac, e.team);
      }
      // A thin ring marks fused and elite units so upgrades are legible.
      if (e.tier > 0) {
        const ring = this.take();
        ring.texture = this.atlas.ring;
        ring.tint = e.tier === 2 ? 0xffe27a : 0xd8d8d8;
        ring.width = ring.height = Number(s.width) * 1.34;
        ring.alpha = 0.45;
        ring.x = s.x;
        ring.y = s.y;
        this.entityLayer.addChildAt(ring, Math.max(0, this.entityLayer.children.length - 1));
      }
    } else {
      s.alpha = 1;
    }
  }

  /**
   * A health bar above a unit.
   *
   * Drawn as pooled `Graphics` rather than sprites: a bar is two rectangles
   * whose width changes every frame, and rebuilding two rects is cheaper than
   * the texture swap and nine-slice a scaled sprite would need. Colour comes
   * from the health, not the team — when you are deciding whether to commit to
   * a fight, "how nearly dead is it" beats "whose is it", and the sprite
   * underneath already carries the team colour.
   */
  private drawHealthBar(x: number, y: number, width: number, frac: number, team: number): void {
    const g = this.barPool.pop() ?? new Graphics();
    g.clear();
    g.visible = true;

    const h = 0.13;
    const w = width;
    const clamped = Math.max(0, Math.min(1, frac));
    const fill = clamped > 0.6 ? 0x5ad46a : clamped > 0.3 ? 0xffc93c : 0xff5a5a;

    g.roundRect(-w / 2, -h / 2, w, h, h / 2).fill({ color: 0x11161f, alpha: 0.72 });
    if (clamped > 0) {
      g.roundRect(-w / 2, -h / 2, w * clamped, h, h / 2).fill(fill);
    }
    g.x = x;
    g.y = y;
    void team;

    this.activeBars.push(g);
    this.entityLayer.addChild(g);
  }

  /** Set by the app so the renderer knows which leader to predict. */
  localTeam = -1;

  // ── effects ───────────────────────────────────────────────────────────────

  spawnHit(x: number, y: number, color = 0xffffff): void {
    const s = this.effectPool.pop() ?? new Sprite();
    s.texture = this.atlas.spark;
    s.anchor.set(0.5);
    s.tint = color;
    s.width = s.height = 0.34;
    s.alpha = 0.95;
    s.x = x;
    s.y = y;
    s.visible = true;
    this.effectLayer.addChild(s);
    const a = Math.random() * Math.PI * 2;
    this.effects.push({
      s,
      life: 0.28,
      max: 0.28,
      vx: Math.cos(a) * 1.4,
      vy: Math.sin(a) * 1.4,
    });
  }

  spawnBurst(x: number, y: number, color: number, count = 6): void {
    for (let i = 0; i < count; i++) this.spawnHit(x, y, color);
  }

  /**
   * A number that floats up and fades where something was banked.
   *
   * The counter in the corner tells you your total; this tells you *that a
   * thing just happened, here, worth this much*. Without it a pickup is a digit
   * quietly changing somewhere you are not looking, which is the difference
   * between collecting and merely accumulating.
   */
  spawnPopup(x: number, y: number, text: string, color: number): void {
    const t = this.popupPool.pop() ?? new Text({ text, style: POPUP_STYLE.clone() });
    t.text = text;
    t.style.fill = color;
    t.anchor.set(0.5, 1);
    // Text is authored at 64px and scaled down, so it stays crisp when the
    // camera zooms rather than being re-rasterised every frame.
    t.scale.set(0.012);
    t.x = x;
    t.y = y;
    t.alpha = 1;
    t.visible = true;
    this.effectLayer.addChild(t);
    this.popups.push({ t, life: 0.85, max: 0.85 });
  }

  private updatePopups(dt: number): void {
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.t.visible = false;
        if (p.t.parent) p.t.parent.removeChild(p.t);
        this.popupPool.push(p.t);
        this.popups.splice(i, 1);
        continue;
      }
      const k = 1 - p.life / p.max;
      // Rises fast then eases, and only fades over the back half — a popup that
      // starts fading immediately is hard to read.
      p.t.y -= (1.9 - k * 1.2) * dt;
      p.t.alpha = k < 0.5 ? 1 : 1 - (k - 0.5) * 2;
      p.t.scale.set(0.012 * (1 + Math.max(0, 0.35 - k) * 1.2));
    }
  }

  /**
   * A shot travelling from attacker to target.
   *
   * Purely cosmetic and deliberately so: the sim resolved this hit the instant
   * it happened, so the projectile is a *replay* of a decided event, not a
   * thing that can miss. It is given a fixed flight time rather than a fixed
   * speed, so a long shot and a short one both land before the next volley and
   * the visuals never drift out of step with the damage numbers.
   */
  spawnProjectile(fromX: number, fromY: number, toX: number, toY: number, color: number): void {
    const s = this.effectPool.pop() ?? new Sprite();
    s.texture = this.atlas.spark;
    s.anchor.set(0.5);
    s.tint = color;
    s.width = s.height = 0.34;
    s.alpha = 1;
    s.x = fromX;
    s.y = fromY;
    s.visible = true;
    this.effectLayer.addChild(s);

    const flight = 0.12;
    this.projectiles.push({
      s,
      life: flight,
      max: flight,
      fromX,
      fromY,
      toX,
      toY,
      color,
    });
  }

  /**
   * A melee lunge: a streak thrown a short way toward the victim.
   * Cheaper and clearer than animating the attacker's sprite, which is a pooled
   * quad shared between frames and has no persistent identity to animate.
   */
  spawnSwing(fromX: number, fromY: number, toX: number, toY: number, color: number): void {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const len = Math.hypot(dx, dy) || 1;
    const s = this.effectPool.pop() ?? new Sprite();
    s.texture = this.atlas.spark;
    s.anchor.set(0.5);
    s.tint = color;
    s.width = 0.62;
    s.height = 0.24;
    s.alpha = 0.95;
    s.rotation = Math.atan2(dy, dx);
    s.x = fromX + (dx / len) * 0.4;
    s.y = fromY + (dy / len) * 0.4;
    s.visible = true;
    this.effectLayer.addChild(s);
    this.effects.push({
      s,
      life: 0.16,
      max: 0.16,
      vx: (dx / len) * 2.6,
      vy: (dy / len) * 2.6,
    });
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.s.visible = false;
        if (p.s.parent) p.s.parent.removeChild(p.s);
        this.effectPool.push(p.s);
        this.projectiles.splice(i, 1);
        // Impact sparks where it lands, so the shot resolves visibly.
        this.spawnHit(p.toX, p.toY, p.color);
        this.spawnHit(p.toX, p.toY, p.color);
        continue;
      }
      const t = 1 - p.life / p.max;
      p.s.x = p.fromX + (p.toX - p.fromX) * t;
      p.s.y = p.fromY + (p.toY - p.fromY) * t;
    }
  }

  private updateEffects(dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i]!;
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.s.visible = false;
        if (fx.s.parent) fx.s.parent.removeChild(fx.s);
        this.effectPool.push(fx.s);
        this.effects.splice(i, 1);
        continue;
      }
      const t = fx.life / fx.max;
      fx.s.alpha = t;
      fx.s.x += fx.vx * dt;
      fx.s.y += fx.vy * dt;
      fx.s.scale.set((0.34 * (1.6 - t)) / 64);
    }
  }

  resize(): void {
    this.app.renderer.resize(window.innerWidth, window.innerHeight);
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }
}
