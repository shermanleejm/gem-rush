/**
 * Input (brief §2.7).
 *
 * One input: move. Touch gets a virtual joystick anchored wherever the thumb
 * first lands on the left half of the screen — a fixed-position stick forces
 * the player to look at their thumb, which is exactly what a one-input game
 * shouldn't require.
 */

export interface InputState {
  dirX: number;
  dirY: number;
  /** Whether a touch stick is currently active, and where to draw it. */
  stick: { active: boolean; originX: number; originY: number; x: number; y: number };
}

const KEY_VECTORS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/** Max thumb travel before the stick is at full deflection, in CSS pixels. */
const STICK_RADIUS = 62;
/** Ignore micro-movement so a resting thumb doesn't drift the leader. */
const DEAD_ZONE = 0.14;

export class Controls {
  readonly state: InputState = {
    dirX: 0,
    dirY: 0,
    stick: { active: false, originX: 0, originY: 0, x: 0, y: 0 },
  };

  private keys = new Set<string>();
  private touchId: number | null = null;
  private disposers: (() => void)[] = [];

  attach(target: HTMLElement): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (KEY_VECTORS[e.code]) {
        this.keys.add(e.code);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    // Losing focus mid-key leaves the leader running forever otherwise.
    const onBlur = () => this.keys.clear();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (this.touchId !== null) return;
      // Left half only, so the right half stays free for UI (chest offers).
      if (e.clientX > window.innerWidth * 0.55) return;
      this.touchId = e.pointerId;
      const s = this.state.stick;
      s.active = true;
      s.originX = e.clientX;
      s.originY = e.clientY;
      s.x = e.clientX;
      s.y = e.clientY;
      target.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== this.touchId) return;
      this.state.stick.x = e.clientX;
      this.state.stick.y = e.clientY;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== this.touchId) return;
      this.touchId = null;
      this.state.stick.active = false;
    };

    target.addEventListener('pointerdown', onPointerDown);
    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerUp);

    this.disposers.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => target.removeEventListener('pointerdown', onPointerDown),
      () => target.removeEventListener('pointermove', onPointerMove),
      () => target.removeEventListener('pointerup', onPointerUp),
      () => target.removeEventListener('pointercancel', onPointerUp),
    );
  }

  /** Merge keyboard, touch and gamepad into one normalised direction. */
  poll(): InputState {
    let x = 0;
    let y = 0;

    for (const code of this.keys) {
      const v = KEY_VECTORS[code];
      if (v) {
        x += v[0];
        y += v[1];
      }
    }

    const s = this.state.stick;
    if (s.active) {
      const dx = s.x - s.originX;
      const dy = s.y - s.originY;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        const mag = Math.min(1, len / STICK_RADIUS);
        if (mag > DEAD_ZONE) {
          x += (dx / len) * mag;
          y += (dy / len) * mag;
        }
      }
    }

    const pad = navigator.getGamepads?.()[0];
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > DEAD_ZONE) {
        x += ax;
        y += ay;
      }
    }

    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.state.dirX = x;
    this.state.dirY = y;
    return this.state;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
