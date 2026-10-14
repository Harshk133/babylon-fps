import { defineConfig } from "vite";
import { attachRelay } from "./server/relay.mjs";

// Co-op: the WebSocket relay rides on the same server/port as the game at /ws,
// so friends only need one URL (works through a single tunnel too).
const TUNNEL_HOSTS = [".ngrok-free.app", ".ngrok.app", ".trycloudflare.com", ".loca.lt"];

const coopRelay = {
  name: "coop-relay",
  configureServer(server) { if (server.httpServer) attachRelay(server.httpServer); },
  configurePreviewServer(server) { if (server.httpServer) attachRelay(server.httpServer); },
};

export default defineConfig({
  // Serve from project root so /models, /trees, /texture paths work.
  publicDir: "public",
  plugins: [coopRelay],

  build: {
    // Raise the chunk-size warning threshold — three.js is intentionally large.
    chunkSizeWarningLimit: 2000,

    rollupOptions: {
      output: {
        // Split vendor libs into separate chunks so the browser can cache them
        // independently from game code and parse them in parallel.
        manualChunks(id) {
          if (id.includes("three/addons/")) return "three-addons";
          if (id.includes("node_modules/three/")) return "three-core";
          if (id.includes("node_modules/cannon-es")) return "cannon-es";
          if (id.includes("node_modules/lil-gui")) return "lil-gui";
        },
      },
    },
  },

  server: {
    // Let friends reach a co-op game through a tunnel (ngrok / Cloudflare)
    allowedHosts: TUNNEL_HOSTS,
    // Enable HTTP/2 push-style headers so the browser can pre-fetch assets.
    headers: {
      "Cross-Origin-Opener-Policy":   "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },

  preview: {
    allowedHosts: TUNNEL_HOSTS,
  },
});
