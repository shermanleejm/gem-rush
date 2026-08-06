/**
 * Sound effects (brief §M7).
 *
 * Synthesised with WebAudio rather than shipped as files: the sounds are
 * original by construction, contribute zero bytes to the §5 bundle budget, and
 * a tweak is a number rather than a re-export.
 *
 * Everything is scheduled on short-lived oscillator/noise nodes that
 * disconnect themselves, so there is nothing to pool or leak. Playback is
 * rate-limited per kind because a squad fight can produce dozens of hit events
 * in one snapshot and stacking them is both ugly and expensive.
 */

export type Sfx = 'hit' | 'death' | 'pickup' | 'fusion' | 'chest' | 'phase' | 'wipe';

interface Limit {
  minGapMs: number;
  last: number;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  /** A burst of hits in one tick should read as one impact, not forty. */
  private limits: Record<Sfx, Limit> = {
    hit: { minGapMs: 55, last: 0 },
    death: { minGapMs: 70, last: 0 },
    pickup: { minGapMs: 45, last: 0 },
    fusion: { minGapMs: 150, last: 0 },
    chest: { minGapMs: 150, last: 0 },
    phase: { minGapMs: 500, last: 0 },
    wipe: { minGapMs: 800, last: 0 },
  };

  /**
   * Browsers refuse to start audio without a gesture, so this is called from
   * the first click rather than at load.
   */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    type WithWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (globalThis as WithWebkit).webkitAudioContext;
    if (!Ctor) return;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.32;
    this.master.connect(this.ctx.destination);

    // One second of white noise, reused for every percussive sound.
    const len = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.32, this.ctx.currentTime, 0.02);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private allowed(kind: Sfx): boolean {
    if (!this.ctx || this.muted) return false;
    const lim = this.limits[kind];
    const now = performance.now();
    if (now - lim.last < lim.minGapMs) return false;
    lim.last = now;
    return true;
  }

  /** Pitched blip with an exponential decay. */
  private tone(
    freq: number,
    duration: number,
    type: OscillatorType = 'sine',
    gain = 0.6,
    slideTo?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /** Filtered noise burst, for impacts. */
  private noise(duration: number, cutoff: number, gain = 0.5): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuffer) return;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(120, cutoff * 0.25), t + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(filter).connect(env).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  play(kind: Sfx): void {
    if (!this.allowed(kind)) return;

    switch (kind) {
      case 'hit':
        // Short, dry and quiet: this fires constantly during any engagement.
        this.noise(0.07, 2600, 0.28);
        break;
      case 'death':
        this.noise(0.2, 1400, 0.42);
        this.tone(180, 0.18, 'triangle', 0.25, 70);
        break;
      case 'pickup':
        this.tone(880, 0.1, 'sine', 0.35, 1320);
        break;
      case 'fusion':
        // Rising triad — the one moment worth celebrating.
        this.tone(523, 0.14, 'triangle', 0.4);
        window.setTimeout(() => this.tone(659, 0.14, 'triangle', 0.4), 70);
        window.setTimeout(() => this.tone(784, 0.22, 'triangle', 0.45), 140);
        break;
      case 'chest':
        this.tone(392, 0.12, 'square', 0.28);
        window.setTimeout(() => this.tone(587, 0.2, 'square', 0.3), 90);
        break;
      case 'phase':
        this.tone(330, 0.5, 'sawtooth', 0.3, 660);
        break;
      case 'wipe':
        this.tone(260, 0.5, 'sawtooth', 0.35, 90);
        this.noise(0.4, 900, 0.35);
        break;
    }
  }
}
