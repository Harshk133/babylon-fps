// Co-op relay: rooms, player names/colours, host election, message forwarding.
// The game logic lives in the clients (one of them is the "host" that runs
// the monsters); the server just routes JSON messages between them.
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
const MAX_PER_ROOM = 8;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);

const rooms = new Map(); // room name → { players: Map<id, client>, hostId }
let nextId = 1;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const [id, c] of room.players) if (id !== exceptId && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
}

function publicInfo(c) {
  return { id: c.id, name: c.name, color: c.color };
}

function join(ws, msg) {
  const roomName = String(msg.room ?? "horde").trim().slice(0, 24).toLowerCase() || "horde";
  let room = rooms.get(roomName);
  if (!room) { room = { players: new Map(), hostId: null }; rooms.set(roomName, room); }
  if (room.players.size >= MAX_PER_ROOM) { send(ws, { t: "full" }); ws.close(); return null; }

  const used = new Set([...room.players.values()].map(c => c.color));
  const client = {
    id: nextId++,
    ws,
    room,
    roomName,
    name: String(msg.name ?? "Survivor").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16) || "Survivor",
    color: COLORS.find(c => !used.has(c)) ?? COLORS[nextId % COLORS.length],
  };
  room.players.set(client.id, client);
  if (room.hostId === null) room.hostId = client.id;

  send(ws, { t: "welcome", id: client.id, host: room.hostId, room: roomName, players: [...room.players.values()].map(publicInfo) });
  broadcast(room, { t: "joined", p: publicInfo(client) }, client.id);
  return client;
}

function leave(client) {
  const room = client.room;
  room.players.delete(client.id);
  broadcast(room, { t: "left", id: client.id });
  if (room.players.size === 0) {
    rooms.delete(client.roomName);
    return;
  }
  if (room.hostId === client.id) {
    // The longest-connected player takes over the monsters
    room.hostId = Math.min(...room.players.keys());
    broadcast(room, { t: "host", id: room.hostId });
  }
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
      if (msg.t === "ping") { send(ws, { t: "pong", ts: msg.ts }); return; }
      // Forward: to one player, to the host, or to everyone else in the room
      msg.from = client.id;
      const room = client.room;
      if (msg.to === "host") {
        const h = room.players.get(room.hostId);
        if (h && h !== client) send(h.ws, msg);
      } else if (typeof msg.to === "number") {
        const c = room.players.get(msg.to);
        if (c) send(c.ws, msg);
      } else {
        broadcast(room, msg, client.id);
      }
    });
    ws.on("close", () => { if (client) leave(client); });
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
