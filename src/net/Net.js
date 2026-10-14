// Thin client for the co-op relay (server/relay.mjs). JSON messages with a
// type field `t`; handlers are registered per type with on(type, fn).

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
  }

  get isHost() { return this.connected && this.id === this.hostId; }
  get isClient() { return this.connected && this.id !== this.hostId; }

  /**
   * Relay address: VITE_RELAY_URL at build time (e.g. wss://my-relay.onrender.com/ws
   * when the game is on Vercel), otherwise the relay built into the Vite server.
   */
  static defaultUrl() {
    const configured = import.meta.env.VITE_RELAY_URL;
    if (configured) return configured;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  _emit(type, msg) {
    for (const fn of this.handlers.get(type) ?? []) fn(msg);
  }

  /** Resolves with the welcome message, rejects on failure / timeout. */
  connect(url, name, room) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      // Generous: free relay hosts (e.g. Render) sleep and take up to a minute to wake
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.close(); reject(new Error("Timed out: is the co-op server running?")); } }, 75000);
      ws.onopen = () => ws.send(JSON.stringify({ t: "join", name, room }));
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Can't reach the co-op server")); } };
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        clearInterval(this._pingTimer);
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Connection closed")); }
        else if (was) this._emit("disconnect", {});
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
            this._pingTimer = setInterval(() => this.send({ t: "ping", ts: performance.now() }), 2000);
            resolve(msg);
            break;
          case "full":
            if (!settled) { settled = true; clearTimeout(timer); reject(new Error("That room is full")); }
            break;
          case "joined": this.players.set(msg.p.id, msg.p); break;
          case "left": this.players.delete(msg.id); break;
          case "host": this.hostId = msg.id; break;
          case "pong": this.ping = Math.round(performance.now() - msg.ts); break;
        }
        this._emit(msg.t, msg);
      };
    });
  }

  /** to: player id, "host", or omitted for everyone else. */
  send(msg) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws?.close();
  }
}
