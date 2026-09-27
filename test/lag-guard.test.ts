/**
 * scripts/lag-guard.mjs: red when the exact pin of
 * @mnemoverse/mcp-memory-server is behind npm's latest (after an optional
 * grace period). The network half (asking npm) is not tested here; these pin
 * every decision the script makes from package.json, pnpm-lock.yaml and npm's
 * answer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  declaredRange,
  evaluate,
  hoursSince,
  lockedVersion,
  PACKAGE,
  parseArgs,
  parseVersion,
  verdict,
} from "../scripts/lag-guard.mjs";

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      '@modelcontextprotocol/sdk':
        specifier: ^1.30.0
        version: 1.30.1(zod@4.6.5)
      '@mnemoverse/mcp-memory-server':
        specifier: 0.11.0
        version: 0.11.0
    devDependencies:
      ai:
        specifier: 7.0.113
        version: 7.0.113(zod@4.6.5)

  packages/other:
    dependencies:
      '@mnemoverse/mcp-memory-server':
        specifier: 0.9.0
        version: 0.9.0

packages:

  '@mnemoverse/mcp-memory-server@0.11.0':
    resolution: {integrity: sha512-x}
`;

const HOUR = 3_600_000;
const now = Date.parse("2026-09-24T12:00:00Z");
const hoursAgo = (h: number) => new Date(now - h * HOUR).toISOString();

describe("reading the pin", () => {
  it("names the package that defines the MCP surface", () => {
    expect(PACKAGE).toBe("@mnemoverse/mcp-memory-server");
  });

  it("reads the root importer's locked version, not another importer's, and strips peer suffixes", () => {
    expect(lockedVersion(LOCK)).toBe("0.11.0");
    expect(lockedVersion(LOCK.replace("version: 0.11.0\n", "version: 0.11.0(zod@4.6.5)\n"))).toBe("0.11.0");
    expect(lockedVersion("importers:\n\n  .:\n    dependencies:\n      zod:\n        specifier: 4.6.5\n        version: 4.6.5\n")).toBeNull();
    expect(lockedVersion("")).toBeNull();
  });

  it("this repository's package.json pins exactly and its lockfile installs the pin", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
    const range = declaredRange(pkg);
    expect(parseVersion(range)).not.toBeNull();
    expect(lockedVersion(lock)).toBe(range);
  });
});

describe("the verdict", () => {
  it.each([
    ["0.11.0", "0.11.0", "current"],
    ["0.11.0", "0.11.1", "behind"],
    ["0.11.0", "0.12.0", "behind"],
    ["0.11.0", "1.0.0", "behind"],
    ["0.11.2", "0.11.10", "behind"],
    ["0.12.0", "0.11.9", "ahead"],
    ["0.11.0-rc.1", "0.11.0", "unreadable"],
    ["0.11.0", "latest", "unreadable"],
  ])("pinned %s against npm %s is %s", (pinned, latest, expected) => {
    expect(verdict(pinned, latest)).toBe(expected);
  });
});

describe("evaluate", () => {
  const base = { range: "0.11.0", locked: "0.11.0", now };

  it("green when current", () => {
    expect(evaluate({ ...base, npm: { latest: "0.11.0", publishedAt: hoursAgo(100) } }).ok).toBe(true);
  });

  it("red as soon as the pin is behind, by default", () => {
    const r = evaluate({ ...base, npm: { latest: "0.12.0", publishedAt: hoursAgo(1) } });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("0.12.0");
  });

  it("with a grace period: green (warning) while the newer release is younger, red after", () => {
    expect(evaluate({ ...base, graceHours: 24, npm: { latest: "0.12.0", publishedAt: hoursAgo(23) } }).ok).toBe(true);
    expect(evaluate({ ...base, graceHours: 24, npm: { latest: "0.12.0", publishedAt: hoursAgo(25) } }).ok).toBe(false);
  });

  it("an unknown publish time counts as old: red", () => {
    expect(evaluate({ ...base, graceHours: 24, npm: { latest: "0.12.0", publishedAt: null } }).ok).toBe(false);
  });

  it.each([
    ["a caret range", { range: "^0.11.0", locked: "0.11.0" }],
    ["no dependency", { range: null, locked: null }],
    ["a lockfile that disagrees", { range: "0.11.0", locked: "0.10.0" }],
    ["a lockfile without it", { range: "0.11.0", locked: null }],
  ])("red for %s, whatever npm says", (_label, state) => {
    expect(evaluate({ ...state, now, npm: { latest: "0.11.0", publishedAt: hoursAgo(1) } }).ok).toBe(false);
  });

  it("hoursSince and --grace-hours", () => {
    expect(hoursSince(hoursAgo(5), now)).toBeCloseTo(5);
    expect(hoursSince("not a date", now)).toBe(Infinity);
    expect(parseArgs([])).toEqual({ graceHours: 0 });
    expect(parseArgs(["--grace-hours", "24"])).toEqual({ graceHours: 24 });
    expect(() => parseArgs(["--grace-hours", "-1"])).toThrow();
  });
});
