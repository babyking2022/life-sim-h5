import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2020",
    outDir: ".artifacts/dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: "packages/engine/src/smoke.ts",
      formats: ["es"],
      fileName: () => "engine-smoke.js"
    }
  }
});
