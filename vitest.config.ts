import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { versionDefines } from "./scripts/versions.mjs";

export default defineConfig({
  define: versionDefines(JSON.parse(readFileSync("package.json", "utf8"))),
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    isolate: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
