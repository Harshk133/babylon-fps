import { defineConfig } from "vite";

export default defineConfig({
  // Serve from project root so /models, /trees, /texture paths work.
  publicDir: "public",

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
    // Enable HTTP/2 push-style headers so the browser can pre-fetch assets.
    headers: {
      "Cross-Origin-Opener-Policy":   "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
