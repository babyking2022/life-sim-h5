import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2020",
    outDir: ".artifacts/p1b-dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: "packages/engine/src/p1b-browser.ts",
      formats: ["iife"],
      name: "P1B",
      fileName: () => "p1b-golden.js"
    }
  }
});
