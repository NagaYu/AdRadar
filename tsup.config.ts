import { defineConfig } from "tsup";

/**
 * Build config for the AdRadar CLI.
 *
 * Bundles the TypeScript sources into a single ESM entry that the `adradar`
 * bin points at. The shebang in src/index.ts is preserved by tsup, so the
 * emitted dist/index.js is directly executable.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  // Keep node built-ins and heavy runtime deps external — they're installed
  // from package.json, not inlined into the bundle.
  external: ["playwright"],
  banner: {},
});
