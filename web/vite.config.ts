import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { resolveBrowserApiProxyTarget } from "./vite-proxy.js";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  envPrefix: ["VITE_", "TASKDROP_"],
  server: {
    proxy: {
      "/api": {
        target: resolveBrowserApiProxyTarget(process.env),
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../dist/landing", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@milkdown/crepe")) return "milkdown-crepe";
          if (id.includes("@milkdown/kit")) return "milkdown-kit";
          if (id.includes("prosemirror")) return "prosemirror";
        },
      },
    },
  },
});
