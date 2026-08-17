import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  envPrefix: ["VITE_", "TASKDROP_"],
  build: {
    outDir: fileURLToPath(new URL("../dist/landing", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
