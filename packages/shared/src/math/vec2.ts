/**
 * 2D vector helpers.
 *
 * Deliberately not a class: the sim stores positions as plain `x`/`y` number
 * fields on entity objects and must not allocate in the hot path. These are
 * free functions that either return scalars or write into an existing target.
 */
export interface Vec2 {
  x: number;
  y: number;
}

export function length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function lengthSq(x: number, y: number): number {
  return x * x + y * y;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Squared distance — use this for comparisons to avoid the sqrt. */
export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Normalise into `out`. A zero-length input yields (0,0) rather than NaN. */
export function normalizeInto(out: Vec2, x: number, y: number): Vec2 {
  const len = Math.sqrt(x * x + y * y);
  if (len < 1e-8) {
    out.x = 0;
    out.y = 0;
  } else {
    out.x = x / len;
    out.y = y / len;
  }
  return out;
}

/** Clamp a vector's magnitude, writing into `out`. */
export function clampLengthInto(out: Vec2, x: number, y: number, max: number): Vec2 {
  const len = Math.sqrt(x * x + y * y);
  if (len > max && len > 1e-8) {
    const s = max / len;
    out.x = x * s;
    out.y = y * s;
  } else {
    out.x = x;
    out.y = y;
  }
  return out;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest signed angular difference, radians. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
