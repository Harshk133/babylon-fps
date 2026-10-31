// Thin client for the co-op relay (server/relay.mjs). JSON messages with a
// type field `t`; handlers are registered per type with on(type, fn).
//
// A lost connection is noticed quickly (unanswered pings, the browser going
// offline) and reported once as "disconnect"; main.js then calls connect()
// again with the same name and room. Every tab carries a key (`Net.key`,
// kept across reloads) so the host can recognise a player who comes back.

const KEY_STORE = "babylon-fps:netkey";
const PING_EVERY = 2000;  // ms
const PING_LOST = 9000;   // ms without a pong: the connection is gone

/** This tab's id: survives a reload, a new tab gets its own (two tabs = two players). */
function tabKey() {
  try {
    let k = sessionStorage.getItem(KEY_STORE);
    if (!k) { k = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); sessionStorage.setItem(KEY_STORE, k); }
    return k;
  } catch {
    return Math.random().toString(36).slice(2, 12);
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
    this._pingTimer = null;
    this._pingSent = 0;   // when the unanswered ping went out (0: none outstanding)
    this.key = tabKey();
    // The browser knows the network went: don't wait for the pings
    window.addEventListener("offline", () => this._drop());
  }

  get isHost() { return this.connected && this.id === this.hostId; }
  get isClient() { return this.connected && this.id !== this.hostId; }

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

  /** Resolves with the welcome message, rejects on failure / timeout. */
  connect(url, name, room) {
    this._detach();
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      // Generous: free relay hosts (e.g. Render) sleep and take up to a minute to wake
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.close(); reject(new Error("Timed out: is the co-op server running?")); } }, 75000);
      ws.onopen = () => ws.send(JSON.stringify({ t: "join", name, room, key: this.key }));
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Can't reach the co-op server at ${url}`)); } };
      ws.onclose = () => {
        if (!settled) { settled = true; clearTimeout(timer); this.ws = null; reject(new Error("Connection closed")); }
        else this._drop();
      };
      ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg.t) {
          case "welcome":
            this.id = msg.id;
            this.hostId = msg.host;
            this.room = msg.room;
            this.players = new Map(msg.players.map(p => [p.id, p]));
            this.connected = true;
            settled = true;
            clearTimeout(timer);
            this._pingSent = 0;
            clearInterval(this._pingTimer);
            this._pingTimer = setInterval(() => this._heartbeat(), PING_EVERY);
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

  /** to: player id, "host", or omitted for everyone else. */
  send(msg) {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
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

  /** The connection is gone (closed, timed out or offline): report it once. */
  _drop() {
    if (!this.connected) return;
    this.connected = false;
    this._detach();
    this._emit("disconnect", {});
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

  /** Leave on purpose: no "disconnect" event. */
  close() {
    this.connected = false;
    this._detach();
  }
}
