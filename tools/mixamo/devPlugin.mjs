// Dev-server only (never in a production build): lets tools/mixamo/convert.html
// list the Mixamo FBX downloads and save what it converts.
//
//   GET  /__mixamo/list         → { characters: [file…], anims: [file…] } (.fbx / .glb)
//   POST /__mixamo/save/<name>  → writes the body to public/models/mixamo/raw/<name>
//
// Names are plain file names (letters, digits, _ - .) ending in .glb or .json,
// so nothing can be written outside that folder.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("public/models/mixamo");
const RAW = path.join(ROOT, "raw");
const SAFE = /^[\w.-]+\.(glb|json)$/;

export function mixamoTools() {
  return {
    name: "mixamo-tools",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__mixamo/", (req, res) => {
        const send = (code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
        if (req.method === "GET" && req.url === "/list") {
          const list = dir => (fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)).filter(f => /\.(fbx|glb)$/i.test(f)) : []);
          return send(200, { characters: list("characters"), anims: list("anims") });
        }
        const m = req.method === "POST" && req.url.match(/^\/save\/([^/?]+)$/);
        if (m) {
          const name = decodeURIComponent(m[1]);
          if (!SAFE.test(name)) return send(400, { error: "bad name" });
          const chunks = [];
          req.on("data", c => chunks.push(c));
          req.on("end", () => {
            fs.mkdirSync(RAW, { recursive: true });
            const buf = Buffer.concat(chunks);
            fs.writeFileSync(path.join(RAW, name), buf);
            send(200, { ok: true, bytes: buf.length });
          });
          return;
        }
        send(404, { error: "not found" });
      });
    },
  };
}
