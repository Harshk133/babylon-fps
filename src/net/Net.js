// Thin client for the co-op relay (server/relay.mjs). JSON messages with a
// type field `t`; handlers are registered per type with on(type, fn).
//
// Lost connections: noticed quickly (unanswered pings, the browser going
// offline, the tab coming back from the background with a dead socket), then
// Net reconnects by itself and the relay hands back the same slot (`sid`, new
// on every page load), with the messages held for us meanwhile:
//   "reconnecting" { reason? }  the connection dropped; we're trying (the game goes on)
//   "resumed"      welcome      back in the same slot: same id, nothing missed
//   "rejoined"     welcome      the slot was gone (away too long, server restarted):
//                               a fresh join with a new id
// While reconnecting, isHost / isClient keep their last answer and send()
// queues everything but the high-rate streams, so nothing the game does in a
// blip is lost. Every tab also carries a key (`key`, kept across reloads) so
// the host can recognise a player who comes back after a reload.

const KEY_STORE = "babylon-fps:netkey";
const PING_EVERY = 2000;  // ms
const PING_LOST = 10000;  // ms without a pong: the connection is gone
const OUTBOX_MAX = 400;   // messages queued while reconnecting
// Replaced by the next one: not worth queueing while reconnecting
const STREAMS = new Set(["st", "mon", "bots", "br", "lvl", "ping", "shot", "ef", "anim", "noise", "takeover"]);

const randomId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

/** This tab's id: survives a reload, a new tab gets its own (two tabs = two players). */
function tabKey() {
  try {
    let k = sessionStorage.getItem(KEY_STORE);
    if (!k) { k = randomId(); sessionStorage.setItem(KEY_STORE, k); }
    return k;
  } catch {
    return randomId();
  }
}

export class Net {
  constructor() {
    this.ws = null;
    this.id = null;
    this.hostId = null;
    this.room = null;
    this.players = new Map(); // id → { id, name, color }
    this.handlers = new Map();
    this.connected = false;
    this.ping = 0;
    // Traffic counters (read by the ?perf=1 overlay; a few adds per message otherwise)
    this.stats = { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, parseMs: 0 };
    this._pingTimer = null;
    this._pingSent = 0;   // when the unanswered ping went out (0: none outstanding)
    this.key = tabKey();
    this.sid = randomId(); // this page load: what the relay resumes
    this.reconnecting = false;
    this._target = null;   // { url, name, room } of the room we're in
    this._outbox = [];
    this._retryTimer = 0;
    this._tries = 0;
    // The browser knows the network went: don't wait for the pings
    window.addEventListener("offline", () => this._drop());
    window.addEventListener("online", () => { if (this.reconnecting) this._retry(200); });
    // Back from the background (phones freeze hidden pages): check the socket at once
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || !this.connected) return;
      if (this._pingSent && performance.now() - this._pingSent > PING_LOST) this._drop();
      else if (!this._pingSent) this._heartbeat();
    });
    // Leaving the page (reload, closing the tab): free the slot now instead of after the grace
    window.addEventListener("pagehide", e => { if (!e.persisted) this._bye(); });
  }

  /** In a room: connected, or briefly reconnecting (the role holds meanwhile). */
  get inRoom() { return this.connected || this.reconnecting; }
  get isHost() { return this.inRoom && this.id === this.hostId; }
  get isClient() { return this.inRoom && this.id !== this.hostId; }

  /**
   * Relay address: RELAY_URL or VITE_RELAY_URL at build time (e.g.
   * wss://my-relay.onrender.com/ws when the game is on Vercel), otherwise the
   * relay built into the Vite server.
   */
  static defaultUrl() {
    // ?relay=wss://…/ws in the page address overrides the build setting (handy for testing)
    const fromLink = new URLSearchParams(location.search).get("relay");
    const configured = (fromLink || import.meta.env.RELAY_URL || import.meta.env.VITE_RELAY_URL || "").trim();
    if (configured) return Net.normalizeUrl(configured);
    // Static hosts can't run the relay, so falling back to this site's own /ws can't work there
    if (/\.(vercel\.app|netlify\.app|github\.io|pages\.dev)$/.test(location.hostname)) {
      throw new Error("Co-op server address isn't set in this build. Add RELAY_URL = wss://<your-relay>.onrender.com/ws in Vercel and redeploy.");
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  /**
   * Forgives the usual ways of writing the relay address:
   *   "wss://https://x.onrender.com/ws", "https://x.onrender.com", "x.onrender.com"
   * all become "wss://x.onrender.com/ws" (ws:// is kept for local http hosts).
   */
  static normalizeUrl(raw) {
    let s = raw.trim().replace(/^["']|["']$/g, "");
    let secure = true;
    // Strip every scheme someone typed (there may be two), remembering if it was plain http/ws
    let m;
    while ((m = /^(wss?|https?):\/\//i.exec(s))) {
      if (/^(ws|http)$/i.test(m[1])) secure = false;
      s = s.slice(m[0].length);
    }
    s = s.replace(/\/+$/, "");
    const slash = s.indexOf("/");
    const host = slash === -1 ? s : s.slice(0, slash);
    let path = slash === -1 ? "" : s.slice(slash);
    if (!path.endsWith("/ws")) path += "/ws";
    const local = /^(localhost|127\.|192\.168\.|10\.)/.test(host);
    return `${secure || !local ? "wss" : "ws"}://${host}${path}`;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  _emit(type, msg) {
    for (const fn of this.handlers.get(type) ?? []) fn(msg);
  }

  /**
   * Invite link to a room: opening it joins straight in (see Lobby). mode: "coop" | "br";
   * room: the code as typed (without the "br-" prefix). VITE_PUBLIC_URL sets the site
   * address for builds that don't run on it (the Android app is https://localhost).
   */
  static inviteUrl(mode, room) {
    const base = (import.meta.env.VITE_PUBLIC_URL || "").trim() || location.origin + location.pathname;
    const url = new URL(base, location.href);
    const here = new URLSearchParams(location.search);
    for (const k of ["relay"]) if (here.has(k)) url.searchParams.set(k, here.get(k)); // same server when testing
    url.searchParams.set("room", room);
    url.searchParams.set("mode", mode);
    return url.toString();
  }

  /** Joins a room. Resolves with the welcome message, rejects on failure / timeout. */
  connect(url, name, room) {
    this.close();
    this._target = { url, name, room };
    return this._open();
  }

  _open() {
    this._detach();
    const { url, name, room } = this._target;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      // Generous for the first join: free relay hosts (e.g. Render) sleep and take up to a minute to
      // wake. Reconnecting, a stalled attempt shouldn't hold up the next one.
      const limit = this.reconnecting ? 12000 : 75000;
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.onclose = null; ws.close(); this.ws = null; reject(new Error("Timed out: is the co-op server running?")); } }, limit);
      ws.onopen = () => ws.send(JSON.stringify({ t: "join", name, room, key: this.key, sid: this.sid }));
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Can't reach the co-op server at ${url}`)); } };
      ws.onclose = () => {
        if (!settled) { settled = true; clearTimeout(timer); this.ws = null; reject(new Error("Connection closed")); }
        else this._drop();
      };
      ws.onmessage = ev => {
        let msg;
        const st = this.stats;
        st.inMsgs++; st.inBytes += ev.data.length || 0;
        const tp = performance.now();
        try { msg = JSON.parse(ev.data); } catch { return; }
        st.parseMs += performance.now() - tp;
        switch (msg.t) {
          case "welcome":
            this.id = msg.id;
            this.hostId = msg.host;
            this.room = msg.room;
            this.players = new Map(msg.players.map(p => [p.id, p]));
            this.connected = true;
            this.modern = "resumed" in msg; // a relay that resumes slots and passes bot chat on
            settled = true;
            clearTimeout(timer);
            this._pingSent = 0;
            clearInterval(this._pingTimer);
            this._pingTimer = setInterval(() => this._heartbeat(), PING_EVERY);
            // Back after a drop: tell the game before the held messages that follow this one
            if (this.reconnecting) this._recovered(msg);
            resolve(msg);
            break;
          case "full":
            if (!settled) { settled = true; clearTimeout(timer); reject(new Error("That room is full")); }
            break;
          case "closed":
            if (!settled) { settled = true; clearTimeout(timer); reject(Object.assign(new Error(msg.reason || "That room isn't taking players right now"), { closed: true })); }
            break;
          case "joined": this.players.set(msg.p.id, msg.p); break;
          case "left": this.players.delete(msg.id); break;
          case "host": this.hostId = msg.id; break;
          case "pong": this.ping = Math.round(performance.now() - msg.ts); this._pingSent = 0; break;
        }
        this._emit(msg.t, msg);
      };
    });
  }

  /** to: player id, "host", or omitted for everyone else. Queued while reconnecting. */
  send(msg) {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      const text = JSON.stringify(msg);
      this.stats.outMsgs++; this.stats.outBytes += text.length;
      this.ws.send(text);
    } else if (this.reconnecting && !STREAMS.has(msg.t)) {
      this._outbox.push(msg);
      if (this._outbox.length > OUTBOX_MAX) this._outbox.shift();
    }
  }

  /** One ping in flight at a time; no answer within PING_LOST and the connection counts as gone. */
  _heartbeat() {
    if (!this.connected) return;
    const now = performance.now();
    if (this._pingSent) {
      if (now - this._pingSent > PING_LOST) this._drop();
      return;
    }
    this._pingSent = now;
    this.send({ t: "ping", ts: now });
  }

  /** The connection is gone (closed, timed out or offline): start getting it back. */
  _drop() {
    if (!this.connected) return;
    this.connected = false;
    this._detach();
    this.reconnecting = true;
    this._tries = 0;
    this._outbox.length = 0;
    this._emit("reconnecting", {});
    this._retry(300);
  }

  _retry(ms) {
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._attempt(), ms);
  }

  async _attempt() {
    if (!this.reconnecting || this._opening) return;
    this._opening = true;
    this._tries++;
    try {
      await this._open(); // _recovered() runs from the welcome
    } catch (err) {
      if (!this.reconnecting) return;
      // A battle royale in its last moments takes nobody new: in again when the next match opens
      const wait = err.closed ? 8000 : Math.min(10000, 500 * 2 ** Math.min(this._tries, 5));
      this._emit("reconnecting", {
        reason: err.closed ? err.message : navigator.onLine === false ? "No internet" : "",
        closed: !!err.closed, retryIn: wait,
      });
      this._retry(wait);
    } finally {
      this._opening = false;
    }
  }

  _recovered(welcome) {
    this.reconnecting = false;
    clearTimeout(this._retryTimer);
    if (welcome.resumed) {
      // Same slot: send what the game did meanwhile
      const queued = this._outbox.splice(0);
      for (const m of queued) this.send(m);
      this._emit("resumed", welcome);
    } else {
      this._outbox.length = 0;
      this._emit("rejoined", welcome);
    }
  }

  /** Tells the relay we're leaving on purpose (no grace, others see us go at once). */
  _bye() {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "bye" }));
  }

  /** Forget the current socket without it reporting anything more. */
  _detach() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch { /* already closed */ }
    this.ws = null;
  }

  /** Leave on purpose: no reconnecting. */
  close() {
    this._bye();
    this.connected = false;
    this.reconnecting = false;
    clearTimeout(this._retryTimer);
    this._outbox.length = 0;
    this._detach();
  }

  /** After close(): try to get back into the same room (a fresh join), e.g. once a closed match ends. */
  rejoinLater(ms) {
    if (!this._target) return;
    this.reconnecting = true;
    this._tries = 0;
    this._retry(ms);
  }
}
