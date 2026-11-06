// The zombie-mode score: a generative horror soundtrack synthesized live (no
// files, so nothing to license). Off by default (Settings → Sound).
//
// Layers, all into Sfx.musicBus:
//  - a low drone: two detuned saws through a slowly breathing low-pass
//  - a dissonant string pad (a minor-second cluster) that swells with danger
//  - a sub pulse like a slow heartbeat, faster as the danger rises
//  - events every few seconds: a struck low piano note, a detuned high
//    "music box" phrase, a metallic scrape, a reversed-swell riser
// setIntensity(0..1) (main.js: monsters chasing, darkness, low health) moves
// the filter, the pad and the pulse; setActive() fades the whole score in / out.

const ROOT = 43.65;                 // F1: the drone's root (Hz)
const MINOR = [0, 1, 3, 5, 6, 8, 10]; // locrian-ish: dark, unresolved
const hz = semis => ROOT * Math.pow(2, semis / 12);

export class HorrorScore {
  constructor(sfx) {
    this.sfx = sfx;
    this.started = false;
    this.active = false;
    this.intensity = 0;
    this._shown = -1;
    this.nextEvent = 0;
    this.nextPulse = 0;
  }

  _start() {
    const ctx = this.sfx.ctx;
    if (!ctx || !this.sfx.musicBus) return false;
    this.started = true;
    const out = this.out = ctx.createGain();
    out.gain.value = 0;
    // A long dark reverb just for the score
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.sfx._impulse(4.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    out.connect(this.sfx.musicBus);
    out.connect(this.verb).connect(wet).connect(this.sfx.musicBus);

    // Drone
    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = 220;
    this.lp.Q.value = 4;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.16;
    for (const d of [-7, 6]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = ROOT;
      o.detune.value = d;
      o.connect(this.lp);
      o.start();
    }
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = ROOT / 2;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.22;
    sub.connect(subGain).connect(out);
    sub.start();
    this.lp.connect(droneGain).connect(out);
    // The filter breathes
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 90;
    lfo.connect(lfoGain).connect(this.lp.frequency);
    lfo.start();

    // Dissonant pad: a cluster high up, with a slow tremolo
    this.pad = ctx.createGain();
    this.pad.gain.value = 0;
    const padLp = ctx.createBiquadFilter();
    padLp.type = "lowpass";
    padLp.frequency.value = 1400;
    for (const s of [24, 25, 31]) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = hz(s);
      o.detune.value = (Math.random() - 0.5) * 14;
      const g = ctx.createGain();
      g.gain.value = 0.05;
      o.connect(g).connect(padLp);
      o.start();
    }
    const trem = ctx.createOscillator();
    trem.frequency.value = 5.5;
    const tremGain = ctx.createGain();
    tremGain.gain.value = 0.35;
    const tremAmp = ctx.createGain();
    tremAmp.gain.value = 0.65;
    trem.connect(tremGain).connect(tremAmp.gain);
    trem.start();
    padLp.connect(tremAmp).connect(this.pad).connect(out);
    return true;
  }

  /** Fades the score in (zombie mode, the setting on) or out. */
  setActive(on) {
    if (on && !this.started && !this._start()) return;
    if (!this.started || on === this.active) return;
    this.active = on;
    const t = this.sfx.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(on ? 0.9 : 0, t, on ? 2.5 : 1.2);
    if (on) { this.nextEvent = t + 3; this.nextPulse = t + 1; }
  }

  setIntensity(x) {
    this.intensity = Math.max(0, Math.min(1, x));
    if (!this.started) return;
    const q = Math.round(this.intensity * 20) / 20;
    if (q === this._shown) return;
    this._shown = q;
    const t = this.sfx.ctx.currentTime;
    this.lp.frequency.setTargetAtTime(160 + q * 520, t, 1.5);
    this.pad.gain.setTargetAtTime(0.12 + q * 0.9, t, 2);
  }

  /** Call every frame: schedules the next pulses and events a little ahead. */
  update() {
    if (!this.active || !this.started) return;
    const ctx = this.sfx.ctx, t = ctx.currentTime;
    const k = this.intensity;
    // The pulse: a muffled low thump, a slow heartbeat that quickens
    if (t >= this.nextPulse - 0.05) {
      const at = Math.max(t, this.nextPulse);
      this._thump(at, 0.3 + k * 0.35);
      if (k > 0.35) this._thump(at + 0.28, 0.2 + k * 0.25);
      this.nextPulse = at + (2.4 - k * 1.5);
    }
    if (t >= this.nextEvent) {
      const r = Math.random();
      if (r < 0.32) this._piano(t);
      else if (r < 0.55) this._musicBox(t);
      else if (r < 0.78) this._scrape(t);
      else this._riser(t);
      this.nextEvent = t + 5 + Math.random() * (12 - k * 6);
    }
  }

  _env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _thump(t, vol) {
    const ctx = this.sfx.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(62, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.25);
    const g = ctx.createGain();
    this._env(g, t, vol, 0.01, 0.3);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.4);
  }

  /** A low note struck on a detuned piano, left to ring. */
  _piano(t) {
    const ctx = this.sfx.ctx;
    const f = hz(12 + MINOR[(Math.random() * MINOR.length) | 0]);
    for (const [mul, vol] of [[1, 0.22], [2.01, 0.08], [3.02, 0.04]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f * mul;
      const g = ctx.createGain();
      this._env(g, t, vol, 0.005, 4.5);
      o.connect(g).connect(this.out);
      o.start(t);
      o.stop(t + 5);
    }
  }

  /** Three or four high, slightly out-of-tune notes, like a broken music box. */
  _musicBox(t) {
    const ctx = this.sfx.ctx;
    const n = 3 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const f = hz(48 + MINOR[(Math.random() * MINOR.length) | 0]) * (1 + (Math.random() - 0.5) * 0.02);
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const g = ctx.createGain();
      const at = t + i * (0.45 + Math.random() * 0.25);
      this._env(g, at, 0.05, 0.003, 1.6);
      o.connect(g).connect(this.out);
      o.start(at);
      o.stop(at + 1.8);
    }
  }

  /** Metal dragged on metal, far off. */
  _scrape(t) {
    const ctx = this.sfx.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.sfx.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 22;
    bp.frequency.setValueAtTime(900 + Math.random() * 600, t);
    bp.frequency.exponentialRampToValueAtTime(400 + Math.random() * 300, t + 2.2);
    const g = ctx.createGain();
    this._env(g, t, 0.25, 0.6, 1.8);
    src.connect(bp).connect(g).connect(this.out);
    src.start(t, Math.random());
    src.stop(t + 2.6);
  }

  /** A swell that builds and cuts off: something's coming. */
  _riser(t) {
    const ctx = this.sfx.ctx;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(hz(24), t);
    o.frequency.exponentialRampToValueAtTime(hz(36), t + 3);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(2400, t + 3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 2.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.05);
    o.connect(lp).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 3.2);
  }
}
