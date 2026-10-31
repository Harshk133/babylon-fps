// Co-op relay: rooms, player names/colours, host election, message forwarding.
// The game logic lives in the clients (one of them is the "host" that runs
// the monsters); the server just routes JSON messages between them.
//
// Dropped connections: a player whose socket closes keeps their slot (id,
// name, colour, host role) for RESUME_GRACE. Messages meant for them are held
// (except the high-rate streams, which the next update replaces) and handed
// over when the same page (`sid`, new on every page load) joins again, so a network blip, a phone
// switching from Wi-Fi to mobile data or a few seconds in the background
// doesn't throw anyone out of the match. Others never see them leave unless
// the grace runs out. A host that's away longer than HOST_GRACE hands the
// role to someone still here. `bye` leaves at once (on purpose), and a
// reloaded tab (same `key`, new `sid`) replaces its own dropped slot.
//
// Embedded in the Vite dev/preview server at /ws (see vite.config.js), or run
// standalone:  node server/relay.mjs  (PORT env, default 8787)
//
// ALLOWED_ORIGINS (comma-separated, optional) limits which sites may connect,
// e.g. "https://my-game.vercel.app". Unset = anyone.

import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const COLORS = ["#4dd2ff", "#ffb347", "#7dff6a", "#ff6ad5", "#ffe14d", "#b48cff", "#ff6a6a", "#6affd8"];
const MAX_PER_ROOM = 8;      // co-op rooms
const MAX_PER_BR_ROOM = 100; // battle royale rooms ("br-<code>")
const CHAT_MAX = 120;        // characters per chat message (src/ui/Chat.js cuts at the same length)
const HOST_QUIET = 3000;     // ms: a battle royale host that sent no game messages this long can be replaced
const RESUME_GRACE = Number(process.env.RESUME_GRACE) || 45000; // ms a dropped player's slot is kept for them
const HOST_GRACE = Number(process.env.HOST_GRACE) || 6000;      // ms a dropped host keeps the role before someone still here takes it
const HELD_MAX = 3000;       // messages held for a dropped player (oldest go first)
// Not worth holding: replaced by the next one, or rebuilt from the welcome on resume
const NOT_HELD = new Set(["st", "mon", "bots", "pong", "joined", "left", "host"]);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);

const rooms = new Map(); // room name → { players: Map<id, client>, hostId, closed }
let nextId = 1;

/** To one player: straight down the socket, or held while they're away. */
function deliver(c, data, type) {
  if (c.ws) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  } else if (!NOT_HELD.has(type)) {
    c.held.push(data);
    if (c.held.length > HELD_MAX) c.held.shift();
  }
}

function send(c, msg) {
  deliver(c, JSON.stringify(msg), msg.t);
}

function broadcast(room, msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const [id, c] of room.players) if (id !== exceptId) deliver(c, data, msg.t);
}

function publicInfo(c) {
  return { id: c.id, name: c.name, color: c.color, k: c.key };
}

function welcome(c, resumed) {
  const room = c.room;
  send(c, { t: "welcome", id: c.id, host: room.hostId, room: c.roomName, resumed, players: [...room.players.values()].map(publicInfo) });
}

/** The longest-connected player who's actually here (else anyone) runs the room. */
function electHost(room) {
  let best = null;
  for (const c of room.players.values()) if (c.ws && (best === null || c.id < best)) best = c.id;
  room.hostId = best ?? Math.min(...room.players.keys());
  broadcast(room, { t: "host", id: room.hostId });
}

function join(ws, msg) {
  const roomName = String(msg.room ?? "horde").trim().slice(0, 24).toLowerCase() || "horde";
  const key = String(msg.key ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 24);
  const sid = String(msg.sid ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 24);
  let room = rooms.get(roomName);

  // The same page coming back (after a drop, or over a socket we still thought was open): same slot
  if (room && sid) {
    for (const c of room.players.values()) {
      if (c.sid !== sid) continue;
      const old = c.ws;
      c.ws = ws;
      c.lastGame = Date.now();
      clearTimeout(c.dropTimer);
      clearTimeout(c.hostTimer);
      if (old) { old.removeAllListeners("close"); try { old.close(); } catch { /* gone */ } }
      welcome(c, true);
      for (const data of c.held) if (ws.readyState === ws.OPEN) ws.send(data);
      c.held = [];
      return c;
    }
  }

  // The same tab reloaded: its old slot (dropped, nothing to resume) goes now, not in RESUME_GRACE
  if (room && key) for (const c of [...room.players.values()]) if (c.key === key && !c.ws) leave(c);
  if (room && !room.players.size) room = null; // leave() just deleted it

  if (!room) { room = { players: new Map(), hostId: null, closed: null }; rooms.set(roomName, room); }
  const max = roomName.startsWith("br-") ? MAX_PER_BR_ROOM : MAX_PER_ROOM;
  const reject = m => { ws.send(JSON.stringify(m)); ws.close(); if (!room.players.size) rooms.delete(roomName); return null; };
  if (room.players.size >= max) return reject({ t: "full" });
  // The host closed the doors (a battle royale down to its last few): try again after the match
  if (room.closed && room.players.size) return reject({ t: "closed", reason: room.closed });

  const used = new Set([...room.players.values()].map(c => c.color));
  const client = {
    id: nextId++,
    ws,
    room,
    roomName,
    name: String(msg.name ?? "Survivor").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16) || "Survivor",
    color: COLORS.find(c => !used.has(c)) ?? COLORS[nextId % COLORS.length],
    // The tab's own id (kept across reloads and reconnects): resumes its slot, and the host can tell a returning player
    key,
    sid,
    lastGame: Date.now(), // last game message (pings don't count: a background tab still pings)
    held: [],             // messages for them while they're away
    dropTimer: 0,
    hostTimer: 0,
  };
  room.players.set(client.id, client);
  if (room.hostId === null) room.hostId = client.id;

  welcome(client, false);
  broadcast(room, { t: "joined", p: publicInfo(client) }, client.id);
  return client;
}

/** The socket went away: keep the slot for a while (see the top of the file). */
function detach(client) {
  client.ws = null;
  client.held = [];
  const room = client.room;
  client.dropTimer = setTimeout(() => leave(client), RESUME_GRACE);
  if (room.hostId === client.id) {
    client.hostTimer = setTimeout(() => {
      if (!client.ws && room.hostId === client.id && room.players.has(client.id)) electHost(room);
    }, HOST_GRACE);
  }
}

function leave(client) {
  const room = client.room;
  if (!room.players.has(client.id)) return;
  clearTimeout(client.dropTimer);
  clearTimeout(client.hostTimer);
  room.players.delete(client.id);
  broadcast(room, { t: "left", id: client.id });
  if (room.players.size === 0) {
    if (rooms.get(client.roomName) === room) rooms.delete(client.roomName);
    return;
  }
  if (room.hostId === client.id) electHost(room);
}

/** Attaches the relay to an existing http server, handling upgrades on `path` only. */
export function attachRelay(httpServer, path = "/ws") {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== path) return; // e.g. Vite's own HMR socket
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  wss.on("connection", ws => {
    let client = null;
    ws.on("message", data => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!client) {
        if (msg.t === "join") client = join(ws, msg);
        return;
      }
      if (client.ws !== ws) return; // an old socket the tab has replaced
      if (msg.t === "ping") { send(client, { t: "pong", ts: msg.ts }); return; }
      client.lastGame = Date.now();
      if (msg.t === "bye") { leave(client); client = null; ws.close(); return; }
      if (msg.t === "takeover") {
        // A battle royale player whose host went quiet (tab in the background, phone screen off):
        // they run the match from now on, so the countdown and the drop don't wait for anyone
        const room = client.room, host = room.players.get(room.hostId);
        if (client.roomName.startsWith("br-") && host && host !== client && (!host.ws || Date.now() - host.lastGame > HOST_QUIET)) {
          room.hostId = client.id;
          clearTimeout(host.hostTimer);
          broadcast(room, { t: "host", id: client.id });
        }
        return;
      }
      if (msg.t === "roomlock") {
        // The host opens / closes the room to new players; never forwarded
        if (client.id === client.room.hostId) client.room.closed = msg.closed ? String(msg.reason ?? "closed").slice(0, 160) : null;
        return;
      }
      if (msg.t === "chat") {
        // Room chat: plain text, length-capped, to everyone, at most a few lines a second
        const now = Date.now();
        if (now - (client.lastChat ?? 0) < 400) return;
        const m = String(msg.m ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, CHAT_MAX);
        if (!m) return;
        client.lastChat = now;
        // b: the host speaking for one of its battle royale bots
        const b = client.id === client.room.hostId && /^bot:\d{1,5}$/.test(String(msg.b ?? "")) ? msg.b : undefined;
        broadcast(client.room, { t: "chat", m, from: client.id, b }, client.id);
        return;
      }
      // Forward: to one player, to the host, or to everyone else in the room
      msg.from = client.id;
      const room = client.room;
      if (msg.to === "host") {
        const h = room.players.get(room.hostId);
        if (h && h !== client) send(h, msg);
      } else if (typeof msg.to === "number") {
        const c = room.players.get(msg.to);
        if (c) send(c, msg);
      } else {
        broadcast(room, msg, client.id);
      }
    });
    ws.on("close", () => { if (client && client.ws === ws) detach(client); });
    ws.on("error", () => {});
  });
  return wss;
}

// Standalone mode
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  const server = createServer((req, res) => { res.writeHead(200); res.end("Babylon FPS co-op relay\n"); });
  attachRelay(server);
  server.listen(port, () => {
    console.log(`Co-op relay listening on ws://localhost:${port}/ws`);
    if (ALLOWED_ORIGINS.length) console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  });
}
