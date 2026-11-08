// Team voice: WebRTC audio straight between players, signalled through the relay
// (`vo` messages). One connection per pair; of the two, the lower id always makes
// the offer, so there's no glare to resolve. The higher id says `hello` to ask for it.
//
// Peer-to-peer means the people you connect to can learn your IP address, which is
// why this is opt-in (Settings, off by default) and nothing connects while it's off.
// A strict NAT needs a TURN server: set VITE_TURN_URL, VITE_TURN_USER, VITE_TURN_PASS.
//
// Who hears what:
//  - sendsTo(peer) decides per connection whether your mic goes down it: to teammates
//    always, to anyone else only while your channel is "all";
//  - what you hear is muted per player (setMuted) or all at once (setSpeaker).
// A mic stays on only while it's needed: setActive(false) closes it all.

const HELLO_EVERY = 3000;  // ms between asking a lower-id peer to make its offer
const SPEAKING_LEVEL = 0.018;

function iceServers() {
  const servers = [{ urls: "stun:stun.l.google.com:19302" }];
  const env = import.meta.env;
  if (env.VITE_TURN_URL) servers.push({ urls: env.VITE_TURN_URL, username: env.VITE_TURN_USER, credential: env.VITE_TURN_PASS });
  return servers;
}

export class VoiceChat {
  /** cb: { onError(text), onMicState(state) } */
  constructor(net, cb = {}) {
    this.net = net;
    this.cb = cb;
    this.active = false;
    this.micMode = "ptt";     // "off" | "ptt" | "open"
    this.channel = "team";    // "team" | "all"
    this.speaker = true;
    this.pttDown = false;
    this.stream = null;
    this.track = null;
    this.peers = new Map();
    this.allowed = new Set(); // whose offers we take
    this.muted = new Set();
    this._hello = new Map();
    this._micAsked = false;
    this._buf = new Uint8Array(512);
    net.on("vo", m => this._signal(m));
  }

  get supported() { return !!(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia); }
  get transmitting() { return !!this.track && (this.micMode === "open" || (this.micMode === "ptt" && this.pttDown)); }
  isSpeaking(id) { return !!this.peers.get(id)?.speaking; }
  isMuted(id) { return this.muted.has(id); }
  isConnected(id) { return this.peers.get(id)?.pc.connectionState === "connected"; }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    if (on) this._updateMic();
    else this.close();
  }

  setMicMode(mode) { this.micMode = mode; this._updateMic(); this._applyAll(); }
  setChannel(ch) { this.channel = ch; this._applyAll(); }
  setPtt(down) { if (this.pttDown !== down) { this.pttDown = down; this._applyAll(); } }

  setSpeaker(on) {
    this.speaker = on;
    for (const p of this.peers.values()) this._applyVolume(p);
  }

  setMuted(id, on) {
    if (on) this.muted.add(id); else this.muted.delete(id);
    const p = this.peers.get(id);
    if (p) this._applyVolume(p);
  }

  toggleMuted(id) { this.setMuted(id, !this.muted.has(id)); return this.muted.has(id); }

  /**
   * Who we should be talking to. wanted: Map id → { mate, volume }, allowed: ids
   * whose connections we'd accept. Called a couple of times a second.
   */
  sync(wanted, allowed) {
    if (!this.active) return;
    this.allowed = allowed;
    for (const [id, want] of wanted) {
      let p = this.peers.get(id);
      if (!p) {
        if (this.net.id < id) p = this._open(id, true);
        else {
          const now = performance.now();
          if (now - (this._hello.get(id) ?? -1e9) > HELLO_EVERY) {
            this._hello.set(id, now);
            this._send(id, { hello: 1 });
          }
        }
      }
      if (p) { p.mate = want.mate; p.volume = want.volume; this._applyVolume(p); this._applySend(p); }
    }
    for (const id of [...this.peers.keys()]) if (!wanted.has(id) && !allowed.has(id)) this._close(id, true);
  }

  /** Twice or more a second: who's talking (their audio level). */
  tick() {
    for (const p of this.peers.values()) {
      if (!p.analyser) continue;
      p.analyser.getByteTimeDomainData(this._buf);
      let sum = 0;
      for (let i = 0; i < this._buf.length; i += 4) { const v = (this._buf[i] - 128) / 128; sum += v * v; }
      p.speaking = Math.sqrt(sum / (this._buf.length / 4)) > SPEAKING_LEVEL && !this.muted.has(p.id);
    }
  }

  close() {
    for (const id of [...this.peers.keys()]) this._close(id, true);
    this._stopMic();
    this._hello.clear();
    this.pttDown = false;
  }

  // ── The mic ─────────────────────────────────────────────────────────────
  async _updateMic() {
    if (!this.active || this.micMode === "off") { this._stopMic(); return; }
    if (this.track || this._micAsked) return;
    if (!this.supported) {
      this.cb.onError?.(window.isSecureContext ? "This browser can't do voice chat" : "Voice chat needs an https:// page: the mic is blocked here");
      return;
    }
    this._micAsked = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!this.active || this.micMode === "off") { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      this.track = stream.getAudioTracks()[0];
      this._applyAll();
      this.cb.onMicState?.("on");
    } catch (err) {
      this.cb.onError?.(err?.name === "NotAllowedError" ? "Microphone blocked: allow it for this site to talk" : "No microphone found");
      this.cb.onMicState?.("blocked");
    } finally {
      this._micAsked = false;
    }
  }

  _stopMic() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.track = null;
    this._applyAll();
  }

  // ── Connections ─────────────────────────────────────────────────────────
  _send(id, d) { this.net.send({ t: "vo", to: id, d }); }

  _open(id, offer) {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const p = { id, pc, sender: null, sending: false, mate: true, volume: 1, audio: null, analyser: null, source: null, speaking: false, pending: [] };
    this.peers.set(id, p);
    pc.onicecandidate = e => { if (e.candidate) this._send(id, { ice: e.candidate }); };
    pc.ontrack = e => this._attach(p, e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this._close(id, false);
    };
    if (offer) {
      p.sender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
      this._applySend(p);
      pc.createOffer()
        .then(o => pc.setLocalDescription(o))
        .then(() => this._send(id, { desc: pc.localDescription }))
        .catch(err => console.warn("voice offer", err));
    }
    return p;
  }

  async _signal(msg) {
    const id = msg.from, d = msg.d;
    if (!this.active || !d || typeof id !== "number" || id === this.net.id) return;
    if (d.bye) { this._close(id, false); return; }
    if (!this.allowed.has(id)) return;
    if (d.hello) {
      if (this.net.id < id && !this.peers.has(id)) this._open(id, true);
      return;
    }
    try {
      if (d.desc?.type === "offer") {
        if (this.net.id < id) return; // we're the one who offers
        this._close(id, false);
        const p = this._open(id, false);
        await p.pc.setRemoteDescription(d.desc);
        const tr = p.pc.getTransceivers()[0];
        if (tr) { tr.direction = "sendrecv"; p.sender = tr.sender; this._applySend(p); }
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        this._send(id, { desc: p.pc.localDescription });
        this._flush(p);
      } else if (d.desc?.type === "answer") {
        const p = this.peers.get(id);
        if (p && p.pc.signalingState === "have-local-offer") { await p.pc.setRemoteDescription(d.desc); this._flush(p); }
      } else if (d.ice) {
        const p = this.peers.get(id);
        if (!p) return;
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.ice);
        else p.pending.push(d.ice);
      }
    } catch (err) {
      console.warn("voice signal", err);
    }
  }

  _flush(p) {
    for (const c of p.pending.splice(0)) p.pc.addIceCandidate(c).catch(() => {});
  }

  _attach(p, stream) {
    p.audio = new Audio();
    p.audio.srcObject = stream;
    p.audio.autoplay = true;
    this._applyVolume(p);
    p.audio.play().catch(() => {});
    // Only to see the level: the element above is what plays it
    try {
      this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === "suspended") this.ctx.resume();
      p.source = this.ctx.createMediaStreamSource(stream);
      p.analyser = this.ctx.createAnalyser();
      p.analyser.fftSize = 1024;
      p.source.connect(p.analyser);
    } catch { /* no level meter, the audio still plays */ }
  }

  _close(id, tell) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    if (tell) this._send(id, { bye: 1 });
    p.pc.onconnectionstatechange = null;
    p.pc.close();
    if (p.audio) { p.audio.pause(); p.audio.srcObject = null; }
    p.source?.disconnect();
  }

  // ── What goes where ─────────────────────────────────────────────────────
  _applyVolume(p) {
    if (!p.audio) return;
    p.audio.volume = Math.max(0, Math.min(1, p.volume ?? 1));
    p.audio.muted = !this.speaker || this.muted.has(p.id);
  }

  _applySend(p) {
    if (!p.sender) return;
    const on = this.transmitting && (p.mate || this.channel === "all");
    if (on === p.sending) return;
    p.sending = on;
    p.sender.replaceTrack(on ? this.track : null).catch(() => {});
  }

  _applyAll() {
    for (const p of this.peers.values()) this._applySend(p);
  }
}
