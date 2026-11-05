import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(root, "packages/ui"),
  base: "./",
  build: {
    target: "es2020",
    outDir: resolve(root, ".artifacts/p1c-dist"),
    emptyOutDir: true,
    minify: true,
    sourcemap: false
  },
  server: {
    fs: { allow: [root] }
  }
});
