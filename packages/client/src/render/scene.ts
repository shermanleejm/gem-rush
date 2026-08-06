/**
 * Pixi scene (brief §2.7).
 *
 * Layer containers, sprite pooling, and a camera that follows the leader.
 * Nothing is constructed in the render loop: units, gems and hit effects all
 * come from pools, because §6 calls out mobile performance as a risk to design
 * for from M1 rather than retrofit.
 */

import {
  Application,
  Container,
  Graphics,
  Sprite,
  type Renderer,
  type Text,
} from 'pixi.js';

import { MAP, TILE_WALL, UNIT_DEFS, type UnitType } from '@squad-arena/shared';

import type { ViewEntity } from '../net/connection.ts';
import { buildSpriteAtlas, type SpriteAtlas } from './sprites.ts';

/** Screen pixels per world tile at zoom 1. */
const BASE_SCALE = 34;

const TEAM_COLORS = [
  0x4da3ff, 0xff7a59, 0x56d9a3, 0xffc857, 0xb98bff, 0xff6bb5, 0x5ee0e0, 0xa3d94d,
];

export class Scene {
  app!: Application;
  /** Pixi init is async; callers must not touch `app` before this is true. */
  ready = false;
  readonly world = new Container();
  readonly terrainLayer = new Container();
  readonly propLayer = new Container();
  readonly entityLayer = new Container();
  readonly effectLayer = new Container();

  private atlas!: SpriteAtlas;

  private pool: Sprite[] = [];
  private active: Sprite[] = [];
  private effects: { s: Sprite; life: number; max: number; vx: number; vy: number }[] = [];
  private effectPool: Sprite[] = [];

  private camX = MAP.size / 2;
  private camY = MAP.size / 2;
  private zoom = 1;
  private targetZoom = 1;

  private labelPool: Text[] = [];
  private activeLabels: Text[] = [];

  async init(mount: HTMLElement): Promise<void> {
    this.app = new Application();
    await this.app.init({
      background: 0x0b0e14,
      antialias: false,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      resizeTo: window,
      // Pixi picks WebGL and falls back to canvas on its own; forcing either
      // costs us the fallback on old mobile GPUs.
      preference: 'webgl',
    });
    mount.appendChild(this.app.canvas);

    this.world.addChild(this.terrainLayer, this.propLayer, this.entityLayer, this.effectLayer);
    this.app.stage.addChild(this.world);

    this.buildTextures();
    this.ready = true;
  }

  /**
   * Build the procedural sprite atlas (see render/sprites.ts). Bodies are white
   * so they can be tinted per archetype and team, and each archetype has its own
   * silhouette so role is readable before colour is (§1.5).
   */
  private buildTextures(): void {
    this.atlas = buildSpriteAtlas(this.app.renderer as Renderer);
  }

  /**
   * Bake the tilemap into one sprite.
   * 64x64 tiles as individual sprites would be 4096 nodes that never change;
   * drawing once into a texture makes terrain effectively free.
   */
  buildTerrain(size: number, tiles: Uint8Array): void {
    this.terrainLayer.removeChildren();

    const g = new Graphics();
    g.rect(0, 0, size, size).fill(0x11161f);

    // Zone rings, so the contested centre reads at a glance.
    const c = size / 2;
    g.circle(c, c, MAP.zoneRadii[2]!).fill({ color: 0x141b26, alpha: 1 });
    g.circle(c, c, MAP.zoneRadii[1]!).fill({ color: 0x18202e, alpha: 1 });
    g.circle(c, c, MAP.zoneRadii[0]!).fill({ color: 0x1d2736, alpha: 1 });

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y * size + x] === TILE_WALL) {
          g.rect(x, y, 1, 1).fill(0x39445a);
        }
      }
    }

    const tex = (this.app.renderer as Renderer).generateTexture({
      target: g,
      resolution: 2,
    });
    const sprite = new Sprite(tex);
    sprite.width = size;
    sprite.height = size;
    this.terrainLayer.addChild(sprite);
    g.destroy();
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
    for (const s of this.active) {
      s.visible = false;
      if (s.parent) s.parent.removeChild(s);
      this.pool.push(s);
    }
    this.active.length = 0;

    for (const t of this.activeLabels) {
      t.visible = false;
      if (t.parent) t.parent.removeChild(t);
      this.labelPool.push(t);
    }
    this.activeLabels.length = 0;
  }

  /** Draw one frame of interpolated state. */
  render(
    entities: Map<number, ViewEntity>,
    localLeader: { x: number; y: number } | null,
    squadSize: number,
    dt: number,
  ): void {
    this.releaseAll();

    // Camera: follow with a soft lerp, zoom out as the squad grows so a big
    // blob stays framed (§2.7).
    if (localLeader) {
      this.camX += (localLeader.x - this.camX) * Math.min(1, dt * 8);
      this.camY += (localLeader.y - this.camY) * Math.min(1, dt * 8);
    }
    this.targetZoom = Math.max(0.62, 1 - squadSize * 0.022);
    this.zoom += (this.targetZoom - this.zoom) * Math.min(1, dt * 3);

    const scale = BASE_SCALE * this.zoom;
    const w = this.app.renderer.width / this.app.renderer.resolution;
    const h = this.app.renderer.height / this.app.renderer.resolution;

    this.world.scale.set(scale);
    // Clamp so the camera never shows outside the arena.
    const halfW = w / (2 * scale);
    const halfH = h / (2 * scale);
    const cx = Math.min(Math.max(this.camX, halfW), MAP.size - halfW);
    const cy = Math.min(Math.max(this.camY, halfH), MAP.size - halfH);
    this.world.position.set(w / 2 - cx * scale, h / 2 - cy * scale);

    // Cull to the visible rect plus a margin — off-screen entities cost nothing.
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
  }

  private drawEntity(e: ViewEntity, localLeader: { x: number; y: number } | null): void {
    const s = this.take();

    switch (e.kind) {
      case 'gem':
        s.texture = this.atlas.gem;
        s.tint = 0x56d9a3;
        s.width = s.height = 0.44;
        break;
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
        s.texture = e.unitType ? this.atlas[e.unitType as UnitType] : this.atlas.striker;
        s.tint = def ? def.color : 0xffffff;
        const size = (def ? def.radius : 0.3) * 2.2 * (1 + e.tier * 0.26);
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
    if (e.kind === 'leader' && localLeader && e.team === this.localTeam) {
      s.x = localLeader.x;
      s.y = localLeader.y;
    } else {
      s.x = e.x;
      s.y = e.y;
    }

    this.entityLayer.addChild(s);

    // Damage tint: cheaper and more readable at this size than an HP bar.
    if (e.kind === 'unit' || e.kind === 'creep') {
      if (e.hpFrac < 0.999) {
        s.alpha = 0.45 + e.hpFrac * 0.55;
      } else {
        s.alpha = 1;
      }
      // A thin ring marks fused and elite units so upgrades are legible.
      if (e.tier > 0) {
        const ring = this.take();
        ring.texture = this.atlas.ring;
        ring.tint = e.tier === 2 ? 0xffe27a : 0xd8d8d8;
        ring.width = ring.height = Number(s.width) * 1.32;
        ring.alpha = 0.35;
        ring.x = s.x;
        ring.y = s.y;
        this.entityLayer.addChildAt(ring, Math.max(0, this.entityLayer.children.length - 1));
      }
    } else {
      s.alpha = 1;
    }
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
