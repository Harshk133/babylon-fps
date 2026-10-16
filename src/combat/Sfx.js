// Procedural WebAudio sounds — no audio assets needed.
// The AudioContext is created on the first user gesture (browser autoplay rules).

// Per-gun gunshot character: crack filter sweep, crack/thump length and volume
const GUN_PROFILES = {
  pistol:  { hi: 6000, lo: 900, crack: 0.1,  vol: 0.75, thumpHz: 190, thumpLen: 0.08, thumpVol: 0.55 },
  smg:     { hi: 5200, lo: 700, crack: 0.14, vol: 0.9,  thumpHz: 160, thumpLen: 0.1,  thumpVol: 0.7 },
  rifle:   { hi: 4800, lo: 500, crack: 0.2,  vol: 1.0,  thumpHz: 130, thumpLen: 0.13, thumpVol: 0.85 },
  shotgun: { hi: 3200, lo: 250, crack: 0.32, vol: 1.1,  thumpHz: 95,  thumpLen: 0.2,  thumpVol: 1.0 },
  sniper:  { hi: 7000, lo: 300, crack: 0.45, vol: 1.15, thumpHz: 85,  thumpLen: 0.3,  thumpVol: 1.0 },
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.45;
    this.master.connect(this.ctx.destination);

    const len = Math.floor(this.ctx.sampleRate * 1.6);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  _env(gainNode, t, peak, decay) {
    gainNode.gain.setValueAtTime(peak, t);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t + decay);
  }

  _noise(t, dur, type, f0, f1, vol, rate = 1) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(f0, t);
    filter.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.85);
    const g = ctx.createGain();
    this._env(g, t, vol, dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.2);
    src.stop(t + dur + 0.05);
  }

  _sweep(t, f0, f1, dur, vol, type = "sine") {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.9);
    const g = ctx.createGain();
    this._env(g, t, vol, dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** vol < 1 for distant (enemy) shots: quieter and duller. */
  gunshot(kind = "smg", vol = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (kind === "flame") { this.fireBreath(vol); return; }
    const p = GUN_PROFILES[kind] ?? GUN_PROFILES.smg;
    const t = ctx.currentTime;
    const hi = vol < 1 ? p.hi * (0.4 + 0.6 * vol) : p.hi;
    // Crack: filtered noise burst. Thump: pitched-down sine for body.
    this._noise(t, p.crack, "lowpass", hi, p.lo, p.vol * vol, 0.9 + Math.random() * 0.2);
    this._sweep(t, p.thumpHz, 40, p.thumpLen, p.thumpVol * vol);
    if (vol < 1) return;
    if (kind === "shotgun") this.click(0.35);           // pump
    if (kind === "sniper") this._blip(700, 0.04, 0.2, "square", 0.55); // bolt
  }

  explosion(distance = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = 1.4 / (1 + distance * 0.05);
    this._noise(t, 1.4, "lowpass", 1800, 60, v);
    this._sweep(t, 90, 25, 0.9, v);
    this._noise(t, 0.12, "highpass", 3000, 1500, v * 0.4);
  }

  glassBreak() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this._noise(t, 0.25, "highpass", 4000, 2500, 0.5, 1.5);
    for (let i = 0; i < 4; i++) this._blip(2500 + Math.random() * 3000, 0.05, 0.12, "triangle", i * 0.03);
    // Ignition whoosh
    this._noise(t + 0.05, 0.9, "bandpass", 300, 900, 0.6);
  }

  throwWhoosh() {
    const ctx = this.ctx;
    if (!ctx) return;
    this._noise(ctx.currentTime, 0.18, "bandpass", 600, 1800, 0.25);
  }

  pickup(big = false) {
    this._blip(660, 0.06, 0.22, "triangle");
    this._blip(990, 0.08, 0.22, "triangle", 0.06);
    if (big) this._blip(1320, 0.12, 0.2, "triangle", 0.12);
  }

  equip() {
    this.click(0);
    this._blip(420, 0.05, 0.2, "square", 0.08);
  }

  doorOpen() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.click(0);
    // Hinge creak: slow, wobbling sawtooth through a narrow band
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(140, t + 0.05);
    osc.frequency.linearRampToValueAtTime(220, t + 0.45);
    osc.frequency.linearRampToValueAtTime(170, t + 0.8);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
    osc.connect(bp).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.9);
  }

  /** delay: seconds until the leaf hits the frame */
  doorClose(delay = 0.9) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + Math.max(0, delay - 0.05);
    this._noise(t, 0.18, "lowpass", 900, 120, 0.7);
    this._sweep(t, 110, 50, 0.18, 0.6);
    this.click(Math.max(0, delay));
  }

  /** A zombie hammering a closed door. */
  doorBang(distance = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = 0.9 / (1 + distance * 0.12);
    if (v < 0.05) return;
    const t = ctx.currentTime;
    this._noise(t, 0.16, "lowpass", 700, 90, v);
    this._sweep(t, 95, 45, 0.16, v * 0.8);
  }

  /** Monster growl; big = brute/boss. */
  growl(distance = 0, big = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = (big ? 0.7 : 0.45) / (1 + distance * 0.08);
    if (v < 0.03) return;
    const t = ctx.currentTime;
    const dur = big ? 1.1 : 0.6;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const base = (big ? 55 : 85) * (0.9 + Math.random() * 0.25);
    osc.frequency.setValueAtTime(base * 1.3, t);
    osc.frequency.exponentialRampToValueAtTime(base, t + dur);
    // Vibrato gives it a throaty rattle
    const lfo = ctx.createOscillator();
    lfo.frequency.value = big ? 18 : 26;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = base * 0.12;
    lfo.connect(lfoGain).connect(osc.frequency);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = big ? 500 : 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(lp).connect(g).connect(this.master);
    osc.start(t); lfo.start(t);
    osc.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    this._noise(t, dur * 0.8, "bandpass", big ? 300 : 600, big ? 150 : 300, v * 0.5);
  }

  /** "You've been spotted" sting. */
  spotted() {
    this._blip(880, 0.07, 0.16, "square");
    this._blip(1320, 0.1, 0.14, "square", 0.07);
  }

  /** Level start (rising) / level cleared (resolving) chords. */
  levelStart() {
    if (!this.ctx) return;
    for (const [f, d] of [[220, 0], [277, 0.12], [330, 0.24], [440, 0.36]]) this._blip(f, 0.5, 0.18, "sawtooth", d);
    this._sweep(this.ctx?.currentTime ?? 0, 60, 40, 1.2, 0.5);
  }

  levelCleared() {
    for (const [f, d] of [[392, 0], [494, 0.1], [587, 0.2], [784, 0.32]]) this._blip(f, 0.45, 0.2, "triangle", d);
  }

  heal() {
    this._blip(520, 0.12, 0.2, "sine");
    this._blip(780, 0.16, 0.2, "sine", 0.1);
  }

  _blip(freq, dur, vol, type = "sine", delay = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    this._env(g, t, vol, dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  hit(headshot) {
    this._blip(headshot ? 2400 : 1700, 0.05, 0.25, "triangle");
    if (headshot) this._blip(3200, 0.06, 0.18, "triangle", 0.03);
  }

  kill() {
    this._blip(220, 0.18, 0.35, "square");
    this._blip(110, 0.25, 0.3, "sine", 0.02);
  }

  click(delay = 0) {
    this._blip(900, 0.03, 0.3, "square", delay);
  }

  reload(duration) {
    this.click(0.05);
    this._blip(500, 0.05, 0.25, "square", duration * 0.45);
    this.click(duration - 0.12);
    this._blip(1300, 0.04, 0.3, "square", duration - 0.05);
  }

  hurt() {
    this._blip(140, 0.15, 0.4, "sawtooth");
  }

  // ── Creatures ───────────────────────────────────────────────────────────────

  /** A throaty voice: oscillator with vibrato through a lowpass, plus breath noise. */
  _voice(t, { type = "sawtooth", f0, f1, f2 = null, dur, vol, vib = 20, vibDepth = 0.1, lp = 900, breath = 0.4, breathHz = 600 }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f2) {
      osc.frequency.linearRampToValueAtTime(f1, t + dur * 0.4);
      osc.frequency.linearRampToValueAtTime(f2, t + dur);
    } else {
      osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = vib;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = f0 * vibDepth;
    lfo.connect(lfoGain).connect(osc.frequency);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.12, dur * 0.2));
    g.gain.setValueAtTime(vol, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(filter).connect(g).connect(this.master);
    osc.start(t); lfo.start(t);
    osc.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    if (breath > 0) this._noise(t, dur * 0.9, "bandpass", breathHz, breathHz * 0.5, vol * breath);
  }

  /** Hellhound pack call: a rising, wavering howl. */
  howl(distance = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = 0.4 / (1 + distance * 0.035);
    if (v < 0.02) return;
    const base = 330 * (0.9 + Math.random() * 0.2);
    this._voice(ctx.currentTime, {
      type: "triangle", f0: base, f1: base * 1.6, f2: base * 1.2, dur: 1.7, vol: v,
      vib: 6, vibDepth: 0.03, lp: 2200, breath: 0.25, breathHz: 1400,
    });
  }

  /** Short snarl as a hound leaps. */
  snarl(distance = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = 0.5 / (1 + distance * 0.08);
    if (v < 0.03) return;
    this._voice(ctx.currentTime, { f0: 170, f1: 110, dur: 0.38, vol: v, vib: 34, vibDepth: 0.18, lp: 1400, breath: 0.7, breathHz: 900 });
  }

  /** Hound death. */
  yelp(distance = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = 0.4 / (1 + distance * 0.08);
    if (v < 0.03) return;
    this._voice(ctx.currentTime, { type: "triangle", f0: 900, f1: 380, dur: 0.32, vol: v, vib: 12, vibDepth: 0.05, lp: 3000, breath: 0.2, breathHz: 1800 });
  }

  /** Dragon roar (dying: higher and falling away). */
  dragonRoar(distance = 0, dying = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = 0.85 / (1 + distance * 0.025);
    if (v < 0.03) return;
    const t = ctx.currentTime;
    if (dying) {
      this._voice(t, { f0: 160, f1: 40, dur: 2.2, vol: v, vib: 9, vibDepth: 0.2, lp: 700, breath: 0.8, breathHz: 500 });
      return;
    }
    this._voice(t, { f0: 62, f1: 95, f2: 48, dur: 2.0, vol: v, vib: 14, vibDepth: 0.22, lp: 520, breath: 0.9, breathHz: 380 });
    this._voice(t + 0.05, { type: "square", f0: 124, f1: 190, f2: 96, dur: 1.8, vol: v * 0.25, vib: 11, vibDepth: 0.15, lp: 900, breath: 0 });
  }

  /** Dragon fireball leaving the mouth. */
  fireBreath(vol = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this._noise(t, 0.7, "bandpass", 300, 1400, 0.9 * vol);
    this._noise(t, 0.5, "lowpass", 600, 120, 0.7 * vol);
    this._sweep(t, 80, 40, 0.5, 0.5 * vol);
  }

  /** Something heavy hitting the ground (a dragon crashing). */
  thud(distance = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = 1.3 / (1 + distance * 0.04);
    this._noise(t, 1.1, "lowpass", 700, 50, v);
    this._sweep(t, 70, 22, 0.9, v);
  }

  heartbeat(vol = 0.5) {
    if (!this.ctx) return;
    this._blip(58, 0.13, vol, "sine");
    this._blip(52, 0.16, vol * 0.8, "sine", 0.24);
  }

  /** Rolling thunder; close strikes crack first. */
  thunder(strength = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (strength > 0.7) this._noise(t, 0.35, "highpass", 2500, 800, 0.5 * strength);
    this._noise(t + 0.05, 3.6, "lowpass", 380, 35, 1.2 * strength, 0.6);
    this._noise(t + 0.4, 2.8, "lowpass", 220, 30, 0.8 * strength, 0.5);
    this._sweep(t, 55, 28, 2.5, 0.5 * strength);
  }

  /** Something unpleasant in the distance (night ambience). */
  stinger() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    switch ((Math.random() * 4) | 0) {
      case 0: this.howl(70 + Math.random() * 40); break;
      case 1: { // metal groan
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(70 + Math.random() * 40, t);
        osc.frequency.linearRampToValueAtTime(120 + Math.random() * 60, t + 1.8);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 600;
        bp.Q.value = 9;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.06, t + 0.6);
        g.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
        osc.connect(bp).connect(g).connect(this.master);
        osc.start(t);
        osc.stop(t + 2.3);
        break;
      }
      case 2: // whisper: breathy formant sweeps
        for (let i = 0; i < 3; i++) this._noise(t + i * 0.28, 0.35, "bandpass", 1800 + Math.random() * 1200, 900, 0.07);
        break;
      default: // far-off scream
        this._voice(t, { type: "triangle", f0: 700, f1: 1100, f2: 500, dur: 1.1, vol: 0.05, vib: 7, vibDepth: 0.04, lp: 2600, breath: 0.4, breathHz: 1500 });
    }
  }

  // ── Ambience: rain, wind, drone ─────────────────────────────────────────────

  _loopNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  _startAmbience() {
    const ctx = this.ctx;
    const a = this.amb = {};
    // Rain: hiss + patter, muffled indoors
    const rain = this._loopNoise(4.3);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 400;
    a.rainLP = ctx.createBiquadFilter();
    a.rainLP.type = "lowpass";
    a.rainLP.frequency.value = 7000;
    a.rain = ctx.createGain();
    a.rain.gain.value = 0;
    rain.connect(hp).connect(a.rainLP).connect(a.rain).connect(this.master);
    rain.start();
    // Wind: low rumble that swells
    const wind = this._loopNoise(5.1);
    const wlp = ctx.createBiquadFilter();
    wlp.type = "lowpass";
    wlp.frequency.value = 320;
    a.wind = ctx.createGain();
    a.wind.gain.value = 0;
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.09;
    const swellGain = ctx.createGain();
    swellGain.gain.value = 0.5;
    const windAmp = ctx.createGain();
    windAmp.gain.value = 0.6;
    swell.connect(swellGain).connect(windAmp.gain);
    wind.connect(wlp).connect(windAmp).connect(a.wind).connect(this.master);
    wind.start();
    swell.start();
    // Drone: two detuned lows, only at night
    a.drone = ctx.createGain();
    a.drone.gain.value = 0;
    const dlp = ctx.createBiquadFilter();
    dlp.type = "lowpass";
    dlp.frequency.value = 160;
    for (const f of [49, 51.7, 73.4]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.connect(dlp);
      o.start();
    }
    dlp.connect(a.drone).connect(this.master);
    a.last = { rain: -1, wind: -1, night: -1, indoor: null };
  }

  // ── Battle royale drop: plane engines and freefall wind ─────────────────────

  _startFlight() {
    const ctx = this.ctx;
    const f = this.flight = { last: { engine: -1, rush: -1 } };
    // Engines: detuned saws with a slow throb
    f.engine = ctx.createGain();
    f.engine.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    for (const hz of [62, 63.3, 124.5]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = hz;
      o.connect(lp);
      o.start();
    }
    lp.connect(f.engine).connect(this.master);
    // Freefall: band-passed rushing noise
    const rush = this._loopNoise(3.7);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 0.6;
    f.rush = ctx.createGain();
    f.rush.gain.value = 0;
    rush.connect(bp).connect(f.rush).connect(this.master);
    rush.start();
  }

  /** engine / rush: 0..1. Cheap to call every frame. */
  setFlight(engine, rush) {
    if (!this.ctx) return;
    if (!this.flight) {
      if (engine <= 0 && rush <= 0) return;
      this._startFlight();
    }
    const f = this.flight, l = f.last, t = this.ctx.currentTime;
    const q = v => Math.round(v * 20) / 20;
    if (q(engine) !== l.engine) { l.engine = q(engine); f.engine.gain.setTargetAtTime(l.engine * 0.12, t, 0.4); }
    if (q(rush) !== l.rush) { l.rush = q(rush); f.rush.gain.setTargetAtTime(l.rush * 0.35, t, 0.25); }
  }

  /** The canopy snapping open. */
  chuteOpen() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._noise(t, 0.35, "lowpass", 1800, 300, 0.7);
    this._noise(t + 0.05, 0.2, "bandpass", 500, 200, 0.4);
  }

  /** rain / wind / night: 0..1; indoor muffles the rain. Cheap to call every frame. */
  setAmbience(rain, wind, night, indoor) {
    if (!this.ctx) return;
    if (!this.amb) this._startAmbience();
    const a = this.amb, l = a.last, t = this.ctx.currentTime;
    const q = v => Math.round(v * 50) / 50;
    if (q(rain) !== l.rain || indoor !== l.indoor) {
      l.rain = q(rain);
      l.indoor = indoor;
      a.rain.gain.setTargetAtTime(l.rain * (indoor ? 0.16 : 0.28), t, 0.4);
      a.rainLP.frequency.setTargetAtTime(indoor ? 700 : 7000, t, 0.2);
    }
    if (q(wind) !== l.wind) { l.wind = q(wind); a.wind.gain.setTargetAtTime(l.wind * 0.22, t, 0.8); }
    if (q(night) !== l.night) { l.night = q(night); a.drone.gain.setTargetAtTime(l.night * 0.03, t, 1.5); }
  }
}
