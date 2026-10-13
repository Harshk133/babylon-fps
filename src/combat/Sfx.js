// Procedural WebAudio sounds — no audio assets needed.
// The AudioContext is created on the first user gesture (browser autoplay rules).

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

    const len = Math.floor(this.ctx.sampleRate * 0.4);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  _env(gainNode, t, peak, decay) {
    gainNode.gain.setValueAtTime(peak, t);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t + decay);
  }

  gunshot() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;

    // Crack: filtered noise burst
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(5200, t);
    filter.frequency.exponentialRampToValueAtTime(700, t + 0.12);
    const g = ctx.createGain();
    this._env(g, t, 0.9, 0.14);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.2);

    // Thump: pitched-down sine for body
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    const og = ctx.createGain();
    this._env(og, t, 0.7, 0.1);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.12);
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
}
