import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts", "src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Bundle @session-bandit/core into the CLI output so the package is
  // self-contained. Without this, `workspace:*` can't resolve when the CLI
  // is installed globally via `npm install -g` (from npm or from a tarball).
  // commander stays external (it's a normal npm package).
  noExternal: ["@session-bandit/core"],
});