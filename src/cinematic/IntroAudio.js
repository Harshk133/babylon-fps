// The opening cinematic's score, synthesized live with the Web Audio API: an
// original composition, nothing sampled or licensed. Respectful by design: a
// tanpura-like drone, an unhurried bansuri-like flute line in the spirit of an
// evening raga (an original phrase, not a chant or any existing piece), soft
// bells, a wordless choir-like pad, santoor-like plucks over India, wind over
// the island, and one weighty orchestral-style hit for the title.
//
// Everything is scheduled against the intro's clock at play(t0), into one gain
// that runs through Sfx.master (so the game's mute and volume apply); stop()
// fades it out and lets it go.

const SA = 146.83;   // D3: the tonic
// The scale used: Sa Re Ga Ma(tivra) Pa Dha Ni, in semitones over Sa
const SWARA = { S: 0, R: 2, G: 4, M: 6, P: 7, D: 9, N: 11, "S'": 12, "R'": 14, "G'": 16 };
const f = (swara, oct = 0) => SA * Math.pow(2, (SWARA[swara] + 12 * oct) / 12);

export class IntroAudio {
  constructor(sfx) {
    this.sfx = sfx;
    this.ctx = null;
    this.out = null;
    this.nodes = [];
  }

  /** Schedules the whole score; cues: { name: seconds from the start }. start: the ctx time the intro's 0 maps to. */
  play(cues) {
    const ctx = this.ctx = this.sfx.ctx;
    if (!ctx || !this.sfx.master) return false;
    const t0 = ctx.currentTime + 0.05;
    this.t0 = t0;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    // A long, soft hall for everything
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.sfx._impulse(5.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    this.out.connect(this.sfx.master);
    this.out.connect(this.verb).connect(wet).connect(this.sfx.master);
    this.noise = this.sfx.noise;
    const T = n => t0 + (cues[n] ?? 0);

    this._drone(T("start"), T("drone_end"));
    this._dust(T("start"), 8);
    this._bells(T("artifact"));
    this._flute(T("flute"));
    this._choir(T("vision"), T("galaxy") + 6);
    this._whoosh(T("vision_through"), 1.6, 0.5);
    this._swell(T("multiverse"), 10, 55, 0.22);
    this._whoosh(T("multiverse_through"), 1.8, 0.7);
    this._bass(T("galaxy"), 9);
    this._whoosh(T("galaxy_through"), 2.0, 0.8);
    this._strings(T("solar"), T("india") + 2);
    this._whoosh(T("earth_dive"), 2.6, 0.6);
    this._santoor(T("india"));
    this._wind(T("world"), T("end") + 4);
    this._riser(T("title") - 2.2, 2.2);
    this._hit(T("title"));
    return true;
  }

  /** Fades the score out (skip, or the end). */
  stop(fade = 1.2) {
    if (!this.out) return;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + fade);
    const out = this.out, nodes = this.nodes;
    setTimeout(() => {
      for (const n of nodes) { try { n.stop(); } catch { /* already stopped */ } }
      try { out.disconnect(); } catch { /* gone */ }
    }, fade * 1000 + 200);
    this.out = null;
    this.nodes = [];
  }

  setMuted(m) {
    if (!this.out) return;
    this.out.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.1);
  }

  // ── Voices ──────────────────────────────────────────────────────────────────

  _osc(type, freq, t, stop) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.start(t);
    if (stop) o.stop(stop);
    this.nodes.push(o);
    return o;
  }

  _noiseSrc(t, stop, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t, Math.random());
    if (stop) s.stop(stop);
    this.nodes.push(s);
    return s;
  }

  _gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }

  /** Tanpura-like: four strings (Pa, Sa', Sa', Sa) plucked in turn, buzzy, ringing over each other. */
  _drone(t, end) {
    const ctx = this.ctx;
    const bus = this._gain(0);
    bus.gain.setValueAtTime(0, t);
    bus.gain.linearRampToValueAtTime(0.32, t + 6);
    bus.gain.setValueAtTime(0.32, end - 6);
    bus.gain.linearRampToValueAtTime(0, end);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2600;
    bus.connect(lp).connect(this.out);
    const strings = [f("P", -1), f("S"), f("S"), f("S", -1)];
    const cycle = 4.4;
    for (let c = t; c < end; c += cycle) {
      strings.forEach((fr, i) => {
        const at = c + i * (cycle / 4) + Math.random() * 0.03;
        if (at > end - 1) return;
        const o = this._osc("sawtooth", fr, at, at + 5);
        // The buzzing "jawari" bridge: a resonant band that sweeps down as the string decays
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 3;
        bp.frequency.setValueAtTime(fr * 9, at);
        bp.frequency.exponentialRampToValueAtTime(fr * 3, at + 4);
        const g = this._gain(0);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.16, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, at + 4.8);
        const body = this._gain(0.5);
        o.connect(bp).connect(g).connect(bus);
        o.connect(body).connect(g);
      });
    }
  }

  /** The first moments: a faint shimmer, like dust in light. */
  _dust(t, dur) {
    const ctx = this.ctx;
    const s = this._noiseSrc(t, t + dur + 1, 0.5);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 6000;
    bp.Q.value = 2;
    const g = this._gain(0);
    g.gain.linearRampToValueAtTime(0.025, t + 3);
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(bp).connect(g).connect(this.out);
  }

  /** Soft bells as the artifact forms: inharmonic partials, long gentle decay, never struck hard. */
  _bells(t) {
    const strikes = [[0, f("S", 2), 0.06], [2.6, f("P", 1), 0.05], [5.4, f("S", 2), 0.045], [8.2, f("G", 2), 0.04]];
    for (const [dt, fr, vol] of strikes) {
      for (const [ratio, v, dec] of [[1, 1, 6], [2.76, 0.5, 4], [5.4, 0.25, 2.5], [8.93, 0.12, 1.4]]) {
        const at = t + dt;
        const o = this._osc("sine", fr * ratio, at, at + dec + 0.1);
        const g = this._gain(0);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(vol * v, at + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dec);
        o.connect(g).connect(this.out);
      }
    }
  }

  /**
   * A bansuri-like flute: a sine with a touch of second harmonic, breath noise
   * and vibrato, gliding (meend) between notes. An original slow phrase,
   * ascending with the tivra Ma of an evening raga, resting on Sa.
   */
  _flute(t) {
    const ctx = this.ctx;
    const phrase = [
      // [swara, octave, seconds held]
      ["N", -1, 1.6], ["R", 0, 1.2], ["G", 0, 2.2], ["M", 0, 1.0], ["G", 0, 1.0], ["R", 0, 1.4], ["S", 0, 2.6],
      ["G", 0, 1.0], ["M", 0, 1.0], ["P", 0, 2.4], ["D", 0, 1.0], ["N", 0, 1.2], ["S'", 0, 3.4],
      ["N", 0, 1.0], ["D", 0, 1.0], ["P", 0, 1.6], ["M", 0, 1.0], ["G", 0, 1.4], ["R", 0, 1.2], ["S", 0, 3.8],
    ];
    const dur = phrase.reduce((s, p) => s + p[2], 0);
    const o = this._osc("sine", f(phrase[0][0], phrase[0][1]), t, t + dur + 1.5);
    const o2 = this._osc("sine", f(phrase[0][0], phrase[0][1]) * 2, t, t + dur + 1.5);
    const vib = this._osc("sine", 5.2, t, t + dur + 1.5);
    const vibG = this._gain(2.4);
    vib.connect(vibG).connect(o.frequency);
    const h2 = this._gain(0.12);
    const g = this._gain(0);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3200;
    o.connect(g);
    o2.connect(h2).connect(g);
    // Breath
    const br = this._noiseSrc(t, t + dur + 1.5, 1);
    const bbp = ctx.createBiquadFilter();
    bbp.type = "bandpass";
    bbp.Q.value = 1.4;
    const brG = this._gain(0);
    br.connect(bbp).connect(brG).connect(lp);
    g.connect(lp).connect(this.out);
    let at = t;
    for (const [sw, oct, hold] of phrase) {
      const fr = f(sw, oct);
      // Glide into the note (meend), then hold
      o.frequency.setTargetAtTime(fr, at, 0.07);
      o2.frequency.setTargetAtTime(fr * 2, at, 0.07);
      bbp.frequency.setTargetAtTime(fr * 4, at, 0.1);
      g.gain.setTargetAtTime(0.11, at, 0.12);
      g.gain.setTargetAtTime(0.085, at + hold * 0.7, 0.3);
      brG.gain.setTargetAtTime(0.02, at, 0.05);
      brG.gain.setTargetAtTime(0.008, at + 0.2, 0.2);
      at += hold;
    }
    g.gain.setTargetAtTime(0, at, 0.8);
    brG.gain.setTargetAtTime(0, at, 0.5);
  }

  /** A wordless choir-like pad: saws through two "ah" formants, slowly opening. */
  _choir(t, end) {
    const ctx = this.ctx;
    const bus = this._gain(0);
    bus.gain.setValueAtTime(0, t);
    bus.gain.linearRampToValueAtTime(0.09, t + 5);
    bus.gain.setValueAtTime(0.09, end - 4);
    bus.gain.linearRampToValueAtTime(0, end);
    const f1 = ctx.createBiquadFilter(); f1.type = "bandpass"; f1.frequency.value = 760; f1.Q.value = 5;
    const f2 = ctx.createBiquadFilter(); f2.type = "bandpass"; f2.frequency.value = 1180; f2.Q.value = 6;
    const sum = this._gain(1);
    sum.connect(f1).connect(bus);
    sum.connect(f2).connect(bus);
    bus.connect(this.out);
    for (const [sw, oct] of [["S", 0], ["P", 0], ["S'", 0], ["G'", 0]]) {
      for (const d of [-6, 5]) {
        const o = this._osc("sawtooth", f(sw, oct), t, end + 0.2);
        o.detune.value = d;
        o.connect(sum);
      }
    }
  }

  /** Air rushing past: filtered noise sweeping up then away. */
  _whoosh(t, dur, vol) {
    const ctx = this.ctx;
    const s = this._noiseSrc(t, t + dur + 0.2, 1);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(250, t);
    bp.frequency.exponentialRampToValueAtTime(3500, t + dur * 0.7);
    bp.frequency.exponentialRampToValueAtTime(600, t + dur);
    const g = this._gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol * 0.35, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(bp).connect(g).connect(this.out);
  }

  /** An expanding orchestral swell: stacked fifths opening up. */
  _swell(t, dur, base, vol) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(2800, t + dur * 0.9);
    const g = this._gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol * 0.5, t + dur * 0.9);
    g.gain.linearRampToValueAtTime(0, t + dur + 1.5);
    lp.connect(g).connect(this.out);
    for (const [sw, oct] of [["S", -1], ["P", -1], ["S", 0], ["G", 0], ["P", 0], ["N", 0]]) {
      for (const d of [-8, 7]) {
        const o = this._osc("sawtooth", f(sw, oct), t, t + dur + 2);
        o.detune.value = d;
        o.connect(lp);
      }
    }
  }

  /** Deep bass under the galaxies. */
  _bass(t, dur) {
    const o = this._osc("sine", f("S", -2), t, t + dur + 2);
    const o2 = this._osc("triangle", f("S", -1), t, t + dur + 2);
    const g = this._gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.26, t + 2.5);
    g.gain.linearRampToValueAtTime(0, t + dur + 1.5);
    o.connect(g); o2.connect(this._gain(0.25)).connect(g);
    g.connect(this.out);
  }

  /** Rising strings toward Earth: a slow-bowing chord climbing a step. */
  _strings(t, end) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.linearRampToValueAtTime(3600, end);
    const g = this._gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13, t + 4);
    g.gain.linearRampToValueAtTime(0.18, end - 1);
    g.gain.linearRampToValueAtTime(0, end + 2.5);
    lp.connect(g).connect(this.out);
    const half = (t + end) / 2;
    for (const [a, b] of [[["S", -1], ["R", -1]], [["P", -1], ["D", -1]], [["G", 0], ["M", 0]], [["S", 1], ["R", 1]]]) {
      for (const d of [-9, 0, 8]) {
        const o = this._osc("sawtooth", f(a[0], a[1]), t, end + 3);
        o.detune.value = d;
        o.frequency.setTargetAtTime(f(b[0], b[1]), half, 1.2);
        const vib = this._osc("sine", 4.8 + Math.random(), t, end + 3);
        vib.connect(this._gain(1.5)).connect(o.frequency);
        o.connect(lp);
      }
    }
  }

  /** Santoor-like hammered strings over India: quick bright plucks, a falling and rising run. */
  _santoor(t) {
    const run = ["S'", "N", "D", "P", "M", "G", "R", "S", "R", "G", "M", "P", "D", "N", "S'", "R'"];
    run.forEach((sw, i) => {
      const at = t + i * 0.16 + (i > 7 ? 0.3 : 0);
      for (const [mult, v] of [[1, 0.06], [2, 0.03], [3, 0.012]]) {
        const o = this._osc("triangle", f(sw, 0) * 2 * mult, at, at + 1.6);
        o.detune.value = (Math.random() - 0.5) * 8;
        const g = this._gain(0);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(v, at + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 1.4);
        o.connect(g).connect(this.out);
      }
    });
  }

  /** Wind over the island while the drone flies. */
  _wind(t, end) {
    const ctx = this.ctx;
    const s = this._noiseSrc(t, end + 1, 0.7);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.8;
    bp.frequency.value = 500;
    const lfo = this._osc("sine", 0.13, t, end + 1);
    lfo.connect(this._gain(280)).connect(bp.frequency);
    const g = this._gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 3);
    g.gain.linearRampToValueAtTime(0.06, end - 6);
    g.gain.linearRampToValueAtTime(0, end);
    s.connect(bp).connect(g).connect(this.out);
  }

  /** A reverse-swell into the title: noise and a rising tone. */
  _riser(t, dur) {
    const ctx = this.ctx;
    const s = this._noiseSrc(t, t + dur, 1);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(800, t);
    hp.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const g = this._gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(hp).connect(g).connect(this.out);
  }

  /** The title: a sub boom, an orchestral-style hit (brass and strings on a big chord) and its long tail. */
  _hit(t) {
    const ctx = this.ctx;
    const sub = this._osc("sine", 70, t, t + 3.5);
    sub.frequency.exponentialRampToValueAtTime(32, t + 2.5);
    const sg = this._gain(0);
    sg.gain.setValueAtTime(0.75, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 3.2);
    sub.connect(sg).connect(this.out);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + 4);
    const g = this._gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.03);
    g.gain.setTargetAtTime(0.09, t + 0.3, 0.6);
    g.gain.linearRampToValueAtTime(0, t + 9);
    lp.connect(g).connect(this.out);
    for (const [sw, oct] of [["S", -1], ["P", -1], ["S", 0], ["G", 0], ["P", 0], ["S", 1]]) {
      for (const d of [-10, 0, 9]) {
        const o = this._osc("sawtooth", f(sw, oct), t, t + 9.5);
        o.detune.value = d;
        o.connect(lp);
      }
    }
    // The cymbal-like wash after it
    const s = this._noiseSrc(t, t + 6, 1);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5000;
    const cg = this._gain(0);
    cg.gain.setValueAtTime(0.12, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 5);
    s.connect(hp).connect(cg).connect(this.out);
  }
}
