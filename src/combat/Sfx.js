// Game audio on WebAudio: recorded CC0 samples (public/sounds, built by
// scripts/build-sounds.py) for guns, footsteps, creatures, doors and blasts,
// plus the procedural sounds (ambience, engines, UI blips) that need no files.
// Every sample method falls back to its synthesized version until the files
// have decoded (or if they never load).
//
// Positional sounds take `at` ({x, y, z}) and go through a PannerNode (HRTF on
// desktop, so headphones hear left / right / behind; equal-power on phones),
// with distance roll-off and air absorption (far sounds lose their top end).
// setListener() follows the camera every frame. A shared reverb gives every
// sound a sense of space: a short tail outdoors, a long one in caves.
// The AudioContext is created on the first user gesture (browser autoplay rules).

const SOUND_DIR = "/sounds/";

// Synth fallback per gun: crack filter sweep, crack/thump length and volume
const GUN_PROFILES = {
  pistol:  { hi: 6000, lo: 900, crack: 0.1,  vol: 0.75, thumpHz: 190, thumpLen: 0.08, thumpVol: 0.55 },
  smg:     { hi: 5200, lo: 700, crack: 0.14, vol: 0.9,  thumpHz: 160, thumpLen: 0.1,  thumpVol: 0.7 },
  rifle:   { hi: 4800, lo: 500, crack: 0.2,  vol: 1.0,  thumpHz: 130, thumpLen: 0.13, thumpVol: 0.85 },
  shotgun: { hi: 3200, lo: 250, crack: 0.32, vol: 1.1,  thumpHz: 95,  thumpLen: 0.2,  thumpVol: 1.0 },
  sniper:  { hi: 7000, lo: 300, crack: 0.45, vol: 1.15, thumpHz: 85,  thumpLen: 0.3,  thumpVol: 1.0 },
};
/** Gun samples: volume, how far they carry (panner refDistance), reverb send. */
const GUN_MIX = {
  pistol:  { vol: 1.3,  ref: 7,  wet: 0.35 },
  smg:     { vol: 1.2,  ref: 7,  wet: 0.3 },
  rifle:   { vol: 1.35, ref: 10, wet: 0.4 },
  shotgun: { vol: 1.4,  ref: 10, wet: 0.45 },
  sniper:  { vol: 1.45, ref: 16, wet: 0.6 },
};
const RELOAD_SAMPLE = { pistol: "reload_pistol", smg: "reload_rifle", rifle: "reload_rifle", sniper: "reload_rifle", shotgun: "reload_pistol" };

const MAX_VOICES = 36;    // sample voices at once; extra low-priority ones are skipped
const LOW_PRIORITY = 24;  // footsteps / idle groans give way above this many
const SPACE_WET = { outdoor: 0.16, indoor: 0.3, cave: 0.75 };

export class Sfx {
  /** hrtf: true for proper 3D on headphones (desktop); phones use cheaper equal-power panning. */
  constructor({ hrtf = true } = {}) {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.hrtf = hrtf;
    this.buffers = {};       // group → AudioBuffer[]
    this._raw = null;        // group → Promise<ArrayBuffer>[] (fetched before the context exists)
    this._bus = null;        // where the synth helpers connect (master, or a panner while positioned)
    this.voices = 0;
    this.listener = { x: 0, y: 0, z: 0 };
    this._loops = new Map(); // key → { src, gain, panner }
    this._space = "outdoor";
  }

  /** Starts downloading the samples (call at boot; decoding waits for unlock()). */
  preload() {
    if (this._raw) return;
    this._raw = {};
    // One request for every sample: pack.bin (the .ogg files back to back) +
    // pack.json (offsets), made by scripts/pack-sounds.mjs. Without it, one
    // request per file from manifest.json.
    const packed = Promise.all([
      fetch(`${SOUND_DIR}pack.json`).then(r => (r.ok ? r.json() : null)),
      fetch(`${SOUND_DIR}pack.bin`).then(r => (r.ok ? r.arrayBuffer() : null)),
    ]).then(([index, bin]) => {
      if (!index || !bin) return false;
      // slice() copies: decodeAudioData detaches the buffer it gets
      for (const [group, list] of Object.entries(index)) {
        this._raw[group] = list.map(([off, len]) => Promise.resolve(bin.slice(off, off + len)));
      }
      return true;
    }).catch(() => false);
    this._manifest = packed.then(ok => ok || fetch(`${SOUND_DIR}manifest.json`)
      .then(r => (r.ok ? r.json() : {}))
      .then(man => {
        for (const [group, n] of Object.entries(man)) {
          this._raw[group] = Array.from({ length: n }, (_, i) =>
            fetch(`${SOUND_DIR}${group}_${i}.ogg`).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
        }
      }))
      .then(() => { if (this.ctx) this._decodeAll(); })
      .catch(() => { /* offline: the synth fallbacks cover everything */ });
  }

  _decodeAll() {
    for (const [group, list] of Object.entries(this._raw)) {
      if (this.buffers[group]) continue;
      this.buffers[group] = [];
      for (const p of list) {
        p.then(ab => (ab ? this.ctx.decodeAudioData(ab) : null))
          .then(buf => { if (buf) this.buffers[group].push(buf); })
          .catch(() => { /* a bad file just leaves that variant out */ });
      }
    }
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = this.ctx = new Ctx();
    // Master: a soft-clip limiter so stacked gunfire and roars never crackle.
    // (A DynamicsCompressorNode would flatten the gunshot transients.)
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    const pre = ctx.createGain();
    pre.gain.value = 0.5;
    const limiter = ctx.createWaveShaper();
    limiter.curve = this._softClip();
    limiter.oversample = "2x";
    const post = ctx.createGain();
    post.gain.value = 2;
    this.master.connect(pre).connect(limiter).connect(post).connect(ctx.destination);
    // Shared reverb: one convolver, a send per sound
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.2);
    this.wet = ctx.createGain();
    this.wet.gain.value = SPACE_WET.outdoor;
    this.reverb.connect(this.wet).connect(this.master);
    this._bus = this.master;

    const len = Math.floor(ctx.sampleRate * 1.6);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    if (!this._raw) this.preload();
    else this._decodeAll();
  }

  /**
   * Shaper curve over inputs ±2 (scaled into ±1 by the gains around it):
   * untouched below 0.7, then bending smoothly toward 1.
   */
  _softClip() {
    const n = 2048, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * 2;
      const a = Math.abs(x);
      const y = a < 0.7 ? a : 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3);
      curve[i] = Math.sign(x) * y / 2;
    }
    return curve;
  }

  /** Stereo decaying noise, darker as it fades: a generic room / valley tail. */
  _impulse(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const k = 0.15 + 0.8 * t; // more smoothing (darker) later in the tail
        lp += (Math.random() * 2 - 1 - lp) * (1 - k);
        d[i] = lp * Math.pow(1 - t, 3.2) * (i < 120 ? i / 120 : 1);
      }
    }
    return buf;
  }

  // ── Listener & space ────────────────────────────────────────────────────────

  /** pos: camera position; fwd / up: unit vectors. Call once per frame. */
  setListener(pos, fwd, up) {
    this.listener.x = pos.x; this.listener.y = pos.y; this.listener.z = pos.z;
    const l = this.ctx?.listener;
    if (!l) return;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(pos.x, t, 0.01);
      l.positionY.setTargetAtTime(pos.y, t, 0.01);
      l.positionZ.setTargetAtTime(pos.z, t, 0.01);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.01);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.01);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.01);
      l.upX.setTargetAtTime(up.x, t, 0.01);
      l.upY.setTargetAtTime(up.y, t, 0.01);
      l.upZ.setTargetAtTime(up.z, t, 0.01);
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /** "outdoor" | "indoor" | "cave": how much reverb everything gets. */
  setSpace(space) {
    if (!this.ctx || space === this._space) return;
    this._space = space;
    this.wet.gain.setTargetAtTime(SPACE_WET[space] ?? SPACE_WET.outdoor, this.ctx.currentTime, 0.4);
  }

  _dist(at) {
    const l = this.listener;
    return Math.hypot(at.x - l.x, at.y - l.y, at.z - l.z);
  }

  /**
   * Output chain for one sound: dry (through a panner when positioned, with
   * air absorption past ~25 m) plus a reverb send. Returns the input node.
   */
  _chain(at, { ref = 3, rolloff = 1, wet = 0.25, t = this.ctx.currentTime } = {}) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    let dry = input;
    if (at) {
      const d = this._dist(at);
      if (d > 25) {
        const air = ctx.createBiquadFilter();
        air.type = "lowpass";
        air.frequency.value = Math.max(700, 18000 * Math.exp(-(d - 25) / 45));
        dry.connect(air);
        dry = air;
      }
      const p = ctx.createPanner();
      p.panningModel = this.hrtf ? "HRTF" : "equalpower";
      p.distanceModel = "inverse";
      p.refDistance = ref;
      p.rolloffFactor = rolloff;
      p.maxDistance = 10000;
      if (p.positionX) {
        p.positionX.setValueAtTime(at.x, t);
        p.positionY.setValueAtTime(at.y, t);
        p.positionZ.setValueAtTime(at.z, t);
      } else {
        p.setPosition(at.x, at.y, at.z);
      }
      dry.connect(p);
      dry = p;
    }
    dry.connect(this.master);
    if (wet > 0) {
      const send = ctx.createGain();
      send.gain.value = wet;
      dry.connect(send).connect(this.reverb);
    }
    return input;
  }

  /** Runs synth helpers with their output placed at `at` (null = in your head). */
  _withAt(at, opts, fn) {
    const prev = this._bus;
    this._bus = this._chain(at, opts);
    try { fn(); } finally { this._bus = prev; }
  }

  /** Volume a sound would have at `at`, 0..1 (to skip inaudible ones). */
  _audible(at, ref, rolloff = 1) {
    if (!at) return 1;
    const d = this._dist(at);
    return d <= ref ? 1 : ref / (ref + rolloff * (d - ref));
  }

  has(group) { return (this.buffers[group]?.length ?? 0) > 0; }

  /**
   * Plays a random variant of a sample group. Returns false if it isn't loaded
   * (callers fall back to synth). opts: at, vol, rate, jitter (± rate),
   * delay, ref, rolloff, wet, low (low priority: skipped when busy), loop.
   */
  play(group, { at = null, vol = 1, rate = 1, jitter = 0.06, delay = 0, ref = 3, rolloff = 1, wet = 0.25, low = false, offset = 0 } = {}) {
    const ctx = this.ctx;
    const list = this.buffers[group];
    if (!ctx || !list?.length) return false;
    if (this.voices >= (low ? LOW_PRIORITY : MAX_VOICES)) return true;
    if (at && this._audible(at, ref, rolloff) * vol < 0.012) return true;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = list[(Math.random() * list.length) | 0];
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(this._chain(at, { ref, rolloff, wet, t }));
    this.voices++;
    src.onended = () => { this.voices--; g.disconnect(); };
    src.start(t, offset);
    return true;
  }

  /**
   * Keeps one looping sample per key alive (fires): call every frame with the
   * wanted volume; 0 fades it out and frees it.
   */
  loop(key, group, at, vol, { ref = 3, wet = 0.2 } = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.has(group)) return;
    let l = this._loops.get(key);
    if (!l) {
      if (vol <= 0) return;
      const src = ctx.createBufferSource();
      src.buffer = this.buffers[group][0];
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = ctx.createPanner();
      panner.panningModel = this.hrtf ? "HRTF" : "equalpower";
      panner.distanceModel = "inverse";
      panner.refDistance = ref;
      src.connect(gain).connect(panner).connect(this.master);
      const send = ctx.createGain();
      send.gain.value = wet;
      panner.connect(send).connect(this.reverb);
      src.start(0, Math.random() * src.buffer.duration);
      l = { src, gain, panner, vol: -1 };
      this._loops.set(key, l);
    }
    const t = ctx.currentTime;
    if (l.panner.positionX) {
      l.panner.positionX.setTargetAtTime(at.x, t, 0.05);
      l.panner.positionY.setTargetAtTime(at.y, t, 0.05);
      l.panner.positionZ.setTargetAtTime(at.z, t, 0.05);
    } else {
      l.panner.setPosition(at.x, at.y, at.z);
    }
    const q = Math.round(vol * 20) / 20;
    if (q !== l.vol) { l.vol = q; l.gain.gain.setTargetAtTime(q, t, 0.25); }
    if (vol <= 0) {
      this._loops.delete(key);
      l.src.stop(t + 1);
    }
  }

  // ── Synth helpers (connect to this._bus) ────────────────────────────────────

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
    src.connect(filter).connect(g).connect(this._bus);
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
    osc.connect(g).connect(this._bus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
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
    osc.connect(g).connect(this._bus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

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
    osc.connect(filter).connect(g).connect(this._bus);
    osc.start(t); lfo.start(t);
    osc.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    if (breath > 0) this._noise(t, dur * 0.9, "bandpass", breathHz, breathHz * 0.5, vol * breath);
  }

  // ── Guns ────────────────────────────────────────────────────────────────────

  /**
   * kind: weapon sound id ("flame" = dragon fire). at: where it was fired
   * (null = your own gun, in your head). vol scales it (enemy guns are quieter).
   */
  gunshot(kind = "smg", vol = 1, at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (kind === "flame") { this.fireBreath(vol, at); return; }
    const mix = GUN_MIX[kind] ?? GUN_MIX.smg;
    const own = !at;
    if (this.play(`gun_${kind}`, { at, vol: mix.vol * vol, jitter: 0.05, ref: mix.ref, wet: mix.wet })) {
      // Your own gun gets a little extra low-end punch; the mechanism follows
      if (own) this._withAt(null, { wet: 0 }, () => this._sweep(ctx.currentTime, GUN_PROFILES[kind]?.thumpHz ?? 150, 40, 0.09, 0.35));
      if (kind === "shotgun" && (own || this._dist(at) < 25)) this.play("pump", { at, vol: 0.7 * vol, delay: 0.32, ref: 2, wet: 0.1 });
      if (kind === "sniper" && (own || this._dist(at) < 25)) this.play("pump", { at, vol: 0.55 * vol, delay: 0.5, rate: 1.35, ref: 2, wet: 0.1 });
      return;
    }
    const p = GUN_PROFILES[kind] ?? GUN_PROFILES.smg;
    const t = ctx.currentTime;
    const far = own ? 1 : this._audible(at, mix.ref);
    const hi = far < 1 ? p.hi * (0.4 + 0.6 * far) : p.hi;
    this._withAt(at, { ref: mix.ref, wet: mix.wet }, () => {
      this._noise(t, p.crack, "lowpass", hi, p.lo, p.vol * vol, 0.9 + Math.random() * 0.2);
      this._sweep(t, p.thumpHz, 40, p.thumpLen, p.thumpVol * vol);
    });
    if (!own) return;
    if (kind === "shotgun") this.click(0.35);
    if (kind === "sniper") this._blip(700, 0.04, 0.2, "square", 0.55);
  }

  /** Trigger pulled on an empty magazine. */
  dryFire() {
    if (!this.play("dryfire", { vol: 0.8, wet: 0 })) this.click(0);
  }

  /** Mag out, mag in, charge: the clip is stretched a little to fit `duration`. */
  reload(duration, kind = "smg") {
    const ctx = this.ctx;
    if (!ctx) return;
    const group = RELOAD_SAMPLE[kind] ?? "reload_rifle";
    const buf = this.buffers[group]?.[0];
    if (buf) {
      const rate = Math.min(1.3, Math.max(0.8, buf.duration / Math.max(0.3, duration - 0.1)));
      this.play(group, { vol: 0.5, rate, jitter: 0, wet: 0.05 });
      if (kind === "shotgun") this.play("pump", { vol: 0.8, delay: Math.max(0, duration - 0.45), wet: 0.05 });
      if (kind === "sniper") this.play("pump", { vol: 0.7, rate: 1.35, delay: Math.max(0, duration - 0.4), wet: 0.05 });
      return;
    }
    this.click(0.05);
    this._blip(500, 0.05, 0.25, "square", duration * 0.45);
    this.click(duration - 0.12);
    this._blip(1300, 0.04, 0.3, "square", duration - 0.05);
  }

  equip() {
    if (this.play("equip", { vol: 0.8, wet: 0.05 })) return;
    this.click(0);
    this._blip(420, 0.05, 0.2, "square", 0.08);
  }

  // ── Footsteps ───────────────────────────────────────────────────────────────

  /**
   * One footfall. surface: "grass" | "dirt" | "wood" | "concrete". at: whose
   * feet (null = yours). vol 0..1 (sneaking is quiet, sprinting loud).
   */
  footstep(surface, vol = 1, at = null, rate = 1) {
    if (!this.ctx) return;
    const group = this.has(`step_${surface}`) ? `step_${surface}` : "step_dirt";
    if (this.play(group, { at, vol: vol * (at ? 1.4 : 0.55), rate, jitter: 0.08, ref: 2.5, rolloff: 1.3, wet: 0.08, low: !!at })) return;
    this._withAt(at, { ref: 2.5, rolloff: 1.3, wet: 0.05 }, () =>
      this._noise(this.ctx.currentTime, 0.07, "lowpass", 900, 200, 0.18 * vol));
  }

  // ── Grenades, molotovs, smoke ───────────────────────────────────────────────

  /** vol: 1 for a grenade, less for a dragon's fireball. */
  explosion(at = null, vol = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    // Sound travels: far blasts arrive a moment after the flash
    const delay = at ? Math.min(0.6, this._dist(at) / 343) : 0;
    const opts = { at, vol: 1.7 * vol, delay, jitter: 0.08, ref: 14, rolloff: 0.8, wet: 0.7 };
    if (this.play("explosion", opts)) {
      this._withAt(at, { ref: 14, rolloff: 0.8, wet: 0 }, () => this._sweep(ctx.currentTime + delay, 75, 24, 0.8, 0.9));
      return;
    }
    const t = ctx.currentTime + delay;
    this._withAt(at, { ref: 14, rolloff: 0.8, wet: 0.5 }, () => {
      this._noise(t, 1.4, "lowpass", 1800, 60, 1.4);
      this._sweep(t, 90, 25, 0.9, 1.4);
      this._noise(t, 0.12, "highpass", 3000, 1500, 0.56);
    });
  }

  /** Grenade spoon and pin as it leaves your hand. */
  pin() {
    this.play("pin", { vol: 0.6, wet: 0, rate: 1.2 });
  }

  /** A thrown grenade / smoke canister clinking off the ground. */
  bounce(at, strength = 1) {
    this.play("bounce", { at, vol: Math.min(1, 0.35 + strength * 0.15), ref: 2, rolloff: 1.4, wet: 0.1, low: true });
  }

  glassBreak(at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.play("glass", { at, vol: 1, ref: 5, wet: 0.3 })) {
      this.play("ignite", { at, vol: 0.9, delay: 0.05, ref: 6, wet: 0.3 });
      return;
    }
    const t = ctx.currentTime;
    this._withAt(at, { ref: 5, wet: 0.3 }, () => {
      this._noise(t, 0.25, "highpass", 4000, 2500, 0.5, 1.5);
      for (let i = 0; i < 4; i++) this._blip(2500 + Math.random() * 3000, 0.05, 0.12, "triangle", i * 0.03);
      this._noise(t + 0.05, 0.9, "bandpass", 300, 900, 0.6);
    });
  }

  /** Smoke grenade going off: a pop, then a long hiss. */
  smokeHiss(at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.play("bounce", { at, vol: 0.9, rate: 0.7, ref: 4, wet: 0.2 });
    if (this.play("smoke_hiss", { at, vol: 0.9, delay: 0.06, ref: 5, wet: 0.25, jitter: 0.1 })) return;
    const t = ctx.currentTime;
    this._withAt(at, { ref: 5, wet: 0.25 }, () => {
      this._noise(t, 0.14, "lowpass", 1400, 200, 0.6);
      this._noise(t + 0.06, 1.5, "highpass", 6000, 2600, 0.32, 0.8);
    });
  }

  /** Burning ground (molotov / dragon fire): call every frame per fire, vol 0 when out. */
  fireLoop(key, at, vol) {
    this.loop(key, "fire_loop", at, vol * 0.9, { ref: 3, wet: 0.2 });
  }

  throwWhoosh() {
    const ctx = this.ctx;
    if (!ctx) return;
    this._noise(ctx.currentTime, 0.18, "bandpass", 600, 1800, 0.25);
  }

  // ── Interface ───────────────────────────────────────────────────────────────

  pickup(big = false) {
    this._blip(660, 0.06, 0.22, "triangle");
    this._blip(990, 0.08, 0.22, "triangle", 0.06);
    if (big) this._blip(1320, 0.12, 0.2, "triangle", 0.12);
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
    this._sweep(this.ctx.currentTime, 60, 40, 1.2, 0.5);
  }

  levelCleared() {
    for (const [f, d] of [[392, 0], [494, 0.1], [587, 0.2], [784, 0.32]]) this._blip(f, 0.45, 0.2, "triangle", d);
  }

  heal() {
    this._blip(520, 0.12, 0.2, "sine");
    this._blip(780, 0.16, 0.2, "sine", 0.1);
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

  hurt() {
    this._blip(140, 0.15, 0.4, "sawtooth");
  }

  // ── Doors & lights ──────────────────────────────────────────────────────────

  doorOpen(at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.play("door_open", { at, vol: 0.9, ref: 3, wet: 0.3 })) return;
    const t = ctx.currentTime;
    this._withAt(at, { ref: 3, wet: 0.3 }, () => {
      this._blip(900, 0.03, 0.3, "square");
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
      osc.connect(bp).connect(g).connect(this._bus);
      osc.start(t);
      osc.stop(t + 0.9);
    });
  }

  /** delay: seconds until the leaf hits the frame */
  doorClose(delay = 0.9, at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    const d = Math.max(0, delay - 0.05);
    if (this.play("door_close", { at, vol: 1, delay: d, ref: 3, wet: 0.35 })) return;
    const t = ctx.currentTime + d;
    this._withAt(at, { ref: 3, wet: 0.35 }, () => {
      this._noise(t, 0.18, "lowpass", 900, 120, 0.7);
      this._sweep(t, 110, 50, 0.18, 0.6);
    });
  }

  /** A zombie hammering a closed door. */
  doorBang(at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.play("door_bang", { at, vol: 1, ref: 4, wet: 0.35, jitter: 0.1 })) return;
    const t = ctx.currentTime;
    this._withAt(at, { ref: 4, wet: 0.3 }, () => {
      this._noise(t, 0.16, "lowpass", 700, 90, 0.9);
      this._sweep(t, 95, 45, 0.16, 0.7);
    });
  }

  /** The light switch on the wall. */
  lightSwitch(at = null) {
    if (!this.play("switch", { at, vol: 0.9, ref: 2, wet: 0.15, jitter: 0.04 })) this.click(0);
  }

  // ── Creatures ───────────────────────────────────────────────────────────────

  /**
   * One monster vocal from a sample group, placed in the world. rate pitches
   * it per type (runners higher, brutes lower).
   */
  voice(group, at, { vol = 1, rate = 1, ref = 4, low = false, delay = 0 } = {}) {
    return this.play(group, { at, vol, rate, jitter: 0.08, ref, rolloff: 1, wet: 0.3, low, delay });
  }

  /** Monster growl (synth fallback); big = brute / boss. */
  growl(at = null, big = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.voice(big ? "brute_roar" : "z_alert", at, { vol: big ? 1 : 0.9, rate: big ? 0.8 : 1, ref: big ? 8 : 4 })) return;
    const t = ctx.currentTime;
    const dur = big ? 1.1 : 0.6;
    const v = big ? 0.7 : 0.45;
    this._withAt(at, { ref: big ? 8 : 4, wet: 0.3 }, () => {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      const base = (big ? 55 : 85) * (0.9 + Math.random() * 0.25);
      osc.frequency.setValueAtTime(base * 1.3, t);
      osc.frequency.exponentialRampToValueAtTime(base, t + dur);
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
      osc.connect(lp).connect(g).connect(this._bus);
      osc.start(t); lfo.start(t);
      osc.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
      this._noise(t, dur * 0.8, "bandpass", big ? 300 : 600, big ? 150 : 300, v * 0.5);
    });
  }

  /** Hellhound pack call: a rising, wavering howl (no recording fits, so it's synthesized). */
  howl(at = null, vol = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const base = 300 * (0.9 + Math.random() * 0.2);
    this._withAt(at, { ref: 12, rolloff: 0.7, wet: 0.6 }, () => {
      this._voice(ctx.currentTime, {
        type: "triangle", f0: base, f1: base * 1.6, f2: base * 1.15, dur: 1.9, vol: 0.4 * vol,
        vib: 6, vibDepth: 0.03, lp: 2000, breath: 0.25, breathHz: 1300,
      });
      // A lower octave under it makes it a hellhound, not a dog
      this._voice(ctx.currentTime, {
        type: "sawtooth", f0: base / 2, f1: base * 0.8, f2: base * 0.55, dur: 1.9, vol: 0.12 * vol,
        vib: 6, vibDepth: 0.03, lp: 700, breath: 0,
      });
    });
  }

  /** Short snarl as a hound leaps. */
  snarl(at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.voice("hound_snarl", at, { vol: 1, rate: 0.85, ref: 4 })) return;
    this._withAt(at, { ref: 4, wet: 0.3 }, () =>
      this._voice(ctx.currentTime, { f0: 170, f1: 110, dur: 0.38, vol: 0.5, vib: 34, vibDepth: 0.18, lp: 1400, breath: 0.7, breathHz: 900 }));
  }

  /** Hound death. */
  yelp(at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.voice("hound_yelp", at, { vol: 1, rate: 0.85, ref: 4 })) return;
    this._withAt(at, { ref: 4, wet: 0.3 }, () =>
      this._voice(ctx.currentTime, { type: "triangle", f0: 900, f1: 380, dur: 0.32, vol: 0.4, vib: 12, vibDepth: 0.05, lp: 3000, breath: 0.2, breathHz: 1800 }));
  }

  /** Dragon roar (dying: lower and falling away). */
  dragonRoar(at = null, dying = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.voice("dragon_roar", at, { vol: 1.3, rate: dying ? 0.7 : 0.9, ref: 25 })) return;
    const t = ctx.currentTime;
    this._withAt(at, { ref: 25, wet: 0.5 }, () => {
      if (dying) {
        this._voice(t, { f0: 160, f1: 40, dur: 2.2, vol: 0.85, vib: 9, vibDepth: 0.2, lp: 700, breath: 0.8, breathHz: 500 });
        return;
      }
      this._voice(t, { f0: 62, f1: 95, f2: 48, dur: 2.0, vol: 0.85, vib: 14, vibDepth: 0.22, lp: 520, breath: 0.9, breathHz: 380 });
      this._voice(t + 0.05, { type: "square", f0: 124, f1: 190, f2: 96, dur: 1.8, vol: 0.21, vib: 11, vibDepth: 0.15, lp: 900, breath: 0 });
    });
  }

  /** One beat of the dragon's wings. */
  wingBeat(at, vol = 1) {
    this.play("wing", { at, vol, rate: 0.75, jitter: 0.1, ref: 14, rolloff: 0.9, wet: 0.3, low: true });
  }

  /** Dragon fireball leaving the mouth. */
  fireBreath(vol = 1, at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.play("dragon_fire", { at, vol: 1.1 * vol, ref: 14, wet: 0.4, jitter: 0.1 })) return;
    const t = ctx.currentTime;
    this._withAt(at, { ref: 14, wet: 0.4 }, () => {
      this._noise(t, 0.7, "bandpass", 300, 1400, 0.9 * vol);
      this._noise(t, 0.5, "lowpass", 600, 120, 0.7 * vol);
      this._sweep(t, 80, 40, 0.5, 0.5 * vol);
    });
  }

  /** Something heavy hitting the ground (a dragon crashing, a rickshaw crash). */
  thud(at = null, heavy = true) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (heavy && this.play("crash", { at, vol: 1.2, ref: 14, rolloff: 0.8, wet: 0.5 })) return;
    if (!heavy && this.play("door_bang", { at, vol: 1, rate: 0.7, ref: 4, wet: 0.2 })) return;
    const t = ctx.currentTime;
    this._withAt(at, { ref: heavy ? 14 : 4, wet: 0.3 }, () => {
      this._noise(t, heavy ? 1.1 : 0.3, "lowpass", 700, 50, 1.3);
      this._sweep(t, 70, 22, heavy ? 0.9 : 0.25, 1.3);
    });
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

  /** Something unpleasant in the distance (night ambience), from a random direction. */
  stinger() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const a = Math.random() * Math.PI * 2, l = this.listener;
    const far = { x: l.x + Math.cos(a) * 60, y: l.y, z: l.z + Math.sin(a) * 60 };
    switch ((Math.random() * 4) | 0) {
      case 0: this.howl(far, 0.8); break;
      case 1: // metal groan
        this._withAt(far, { ref: 30, wet: 0.6 }, () => {
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
          osc.connect(bp).connect(g).connect(this._bus);
          osc.start(t);
          osc.stop(t + 2.3);
        });
        break;
      case 2: // a far-off groan
        if (this.voice("z_groan", far, { vol: 0.6, rate: 0.85, ref: 25 })) break;
        this._withAt(far, { ref: 30, wet: 0.6 }, () => {
          for (let i = 0; i < 3; i++) this._noise(t + i * 0.28, 0.35, "bandpass", 1800 + Math.random() * 1200, 900, 0.07);
        });
        break;
      default: // far-off scream
        this._withAt(far, { ref: 30, wet: 0.6 }, () =>
          this._voice(t, { type: "triangle", f0: 700, f1: 1100, f2: 500, dur: 1.1, vol: 0.05, vib: 7, vibDepth: 0.04, lp: 2600, breath: 0.4, breathHz: 1500 }));
    }
  }

  // ── Caves ───────────────────────────────────────────────────────────────────

  /** A water drop landing in a puddle somewhere in the dark: a falling "plink" and its echo. */
  drip(vol = 0.5) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = 900 + Math.random() * 900;
    const a = Math.random() * Math.PI * 2, l = this.listener;
    const at = { x: l.x + Math.cos(a) * 6, y: l.y + 2, z: l.z + Math.sin(a) * 6 };
    this._withAt(at, { ref: 4, wet: 0.8 }, () => {
      this._sweep(t, f * 1.6, f, 0.09, 0.05 * vol);
      this._sweep(t + 0.16 + Math.random() * 0.08, f * 1.5, f * 0.95, 0.12, 0.018 * vol);
    });
  }

  /** One crack of a burning torch (call often, with small random gaps). */
  crackle(vol = 0.5) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this._noise(t, 0.02 + Math.random() * 0.03, "bandpass", 2200 + Math.random() * 2500, 1200, 0.05 * vol, 1.5);
    if (Math.random() < 0.3) this._noise(t + 0.03, 0.05, "lowpass", 900, 300, 0.03 * vol);
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

  // ── Auto-rickshaw: a putt-putt two-stroke ───────────────────────────────────

  _startEngine() {
    const ctx = this.ctx;
    const e = this.engine = { last: { vol: -1, rpm: -1 } };
    // A sawtooth pulsed by a slower square = the uneven two-stroke beat
    e.osc = ctx.createOscillator();
    e.osc.type = "sawtooth";
    e.osc.frequency.value = 42;
    e.pulse = ctx.createOscillator();
    e.pulse.type = "square";
    e.pulse.frequency.value = 21;
    const pulseGain = ctx.createGain();
    pulseGain.gain.value = 0.45;
    const amp = ctx.createGain();
    amp.gain.value = 0.55;
    e.pulse.connect(pulseGain).connect(amp.gain);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    e.lp = lp;
    e.gain = ctx.createGain();
    e.gain.gain.value = 0;
    // Through its own panner, so you hear where a rickshaw is when someone else drives
    e.panner = ctx.createPanner();
    e.panner.panningModel = this.hrtf ? "HRTF" : "equalpower";
    e.panner.distanceModel = "inverse";
    e.panner.refDistance = 6;
    e.osc.connect(amp).connect(lp).connect(e.gain).connect(e.panner).connect(this.master);
    // Exhaust rasp
    const rasp = this._loopNoise(2.1);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 260;
    bp.Q.value = 1.2;
    const raspGain = ctx.createGain();
    raspGain.gain.value = 0.35;
    rasp.connect(bp).connect(raspGain).connect(amp);
    e.osc.start();
    e.pulse.start();
    rasp.start();
  }

  /**
   * vol: 0 off … 1 running; rpm: 0 idle … 1 flat out; at: where the vehicle
   * is (null = you're driving it). tone: pitch scale (1 the rickshaw's
   * two-stroke, ~0.7 a jeep's diesel). Cheap to call every frame.
   */
  setRickshaw(vol, rpm, at = null, tone = 1) {
    if (!this.ctx) return;
    if (!this.engine) {
      if (vol <= 0) return;
      this._startEngine();
    }
    const e = this.engine, l = e.last, t = this.ctx.currentTime;
    const p = at ?? this.listener;
    if (e.panner.positionX) {
      e.panner.positionX.setTargetAtTime(p.x, t, 0.05);
      e.panner.positionY.setTargetAtTime(p.y, t, 0.05);
      e.panner.positionZ.setTargetAtTime(p.z, t, 0.05);
    } else {
      e.panner.setPosition(p.x, p.y, p.z);
    }
    const q = v => Math.round(v * 40) / 40;
    if (q(vol) !== l.vol) { l.vol = q(vol); e.gain.gain.setTargetAtTime(l.vol * 0.22, t, 0.15); }
    if (q(rpm) !== l.rpm || tone !== l.tone) {
      l.rpm = q(rpm);
      l.tone = tone;
      e.osc.frequency.setTargetAtTime((38 + l.rpm * 70) * tone, t, 0.12);
      e.pulse.frequency.setTargetAtTime((19 + l.rpm * 35) * tone, t, 0.12);
      e.lp.frequency.setTargetAtTime((450 + l.rpm * 900) * tone, t, 0.12);
    }
  }

  /**
   * Pouring a petrol can into the tank: the cap, a glugging pour that rises
   * in pitch as the tank fills, the cap again.
   */
  refuel(at = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.play("can_cap", { at, vol: 0.8, ref: 2, wet: 0.1 });
    const t = ctx.currentTime + 0.2;
    this._withAt(at, { ref: 2, wet: 0.15 }, () => {
      for (let i = 0; i < 9; i++) {
        const f = 260 + i * 28 + Math.random() * 30;
        // Each glug: a bubble (pitch flick) over a gurgle of filtered noise
        this._sweep(t + i * 0.14, f * 0.8, f * 1.5, 0.08, 0.22);
        this._noise(t + i * 0.14, 0.12, "bandpass", f * 2.2, f * 1.2, 0.35);
      }
      this._noise(t, 1.3, "bandpass", 1600, 2600, 0.06); // the steady pour under it
    });
    this.play("can_cap", { at, vol: 0.7, delay: 1.55, ref: 2, wet: 0.1 });
  }

  /** The engine coughing on an empty tank. */
  sputter() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) this._noise(t + i * 0.16, 0.08, "lowpass", 600, 120, 0.4);
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
