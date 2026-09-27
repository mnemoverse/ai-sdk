/**
 * The versions this package reports: its own semver, and the surface version
 * (the pinned, installed @mnemoverse/mcp-memory-server) shown next to it.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SURFACE_VERSION, VERSION } from "../src/index.js";
import { SURFACE_ZOD_RANGE } from "../src/version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

describe("versions", () => {
  it("VERSION is this package's own semver", () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("SURFACE_VERSION is the exact pin, and the installed copy is that version", () => {
    const pinned = pkg.dependencies["@mnemoverse/mcp-memory-server"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SURFACE_VERSION).toBe(pinned);
    expect(require("@mnemoverse/mcp-memory-server/package.json").version).toBe(pinned);
  });

  it("the MCP SDK dependency accepts what the package itself requires", () => {
    const surfacePkg = require("@mnemoverse/mcp-memory-server/package.json");
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBe(surfacePkg.dependencies["@modelcontextprotocol/sdk"]);
  });

  // Regression: without a zod peer, an application's zod 3.25 or 4.1 was
  // silently used by the in-process McpServer to convert the package's zod 4
  // schemas, dropping descriptions and limits. The peer makes such an install
  // conflict (npm) or warn (pnpm); it must track the package's own range.
  it("the zod peer is exactly the zod range the package's schemas need", () => {
    const surfacePkg = require("@mnemoverse/mcp-memory-server/package.json");
    expect(pkg.peerDependencies.zod).toBe(surfacePkg.dependencies.zod);
    expect(SURFACE_ZOD_RANGE).toBe(surfacePkg.dependencies.zod);
    expect(pkg.dependencies.zod).toBeUndefined();
  });

  it("the CHANGELOG names the surface version of the current release", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const section = changelog.split(/^## /m).find((s) => s.startsWith(`[${VERSION}]`));
    expect(section, `CHANGELOG has a [${VERSION}] section`).toBeDefined();
    expect(section).toContain(`@mnemoverse/mcp-memory-server\` ${SURFACE_VERSION}`);
  });

  // The README is the npm page. Its surface line is moved by
  // scripts/bump-surface.mjs; a hand edit that forgets it is red here.
  it("the README's surface line names the pinned surface version", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const lines = readme.match(/^Surface: `@mnemoverse\/mcp-memory-server` \d+\.\d+\.\d+/gm) ?? [];
    expect(lines).toEqual([`Surface: \`@mnemoverse/mcp-memory-server\` ${SURFACE_VERSION}`]);
  });
});
