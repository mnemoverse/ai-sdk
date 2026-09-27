import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";
import { versionDefines } from "./scripts/versions.mjs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  // Dependencies and peers stay external, so the package's tools, its error
  // classes and the MCP SDK are the installed copies, never inlined ones.
  external: ["ai", "@ai-sdk/mcp", /^@mnemoverse\/mcp-memory-server(\/.*)?$/, /^@modelcontextprotocol\/sdk(\/.*)?$/],
  define: versionDefines(JSON.parse(readFileSync("package.json", "utf8"))),
  // src/compat.ts reads ai/package.json and @ai-sdk/mcp/package.json. Node
  // loads JSON from ESM only with `with { type: "json" }`, which esbuild drops
  // for an es2022 target unless told the target supports it. No rollup
  // treeshake pass either: rollup 4 rewrites `with` to the removed `assert`
  // syntax, which Node 22 cannot parse (esbuild's own tree shaking remains).
  esbuildOptions(options) {
    options.supported = { ...options.supported, "import-attributes": true };
  },
  treeshake: false,
});
