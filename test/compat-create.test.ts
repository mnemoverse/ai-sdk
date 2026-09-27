/**
 * createMnemoverseTools refuses an ai / @ai-sdk/mcp pair outside the test
 * matrix before anything is built. Here the installed `ai` claims a major
 * that does not go with the installed @ai-sdk/mcp: with this repository's
 * @ai-sdk/mcp 2.x that is ai 5, the pairing from the finding (a bare
 * `pnpm add @ai-sdk/mcp` in an ai 5 project). Under the matrix's other
 * majors, the claimed ai is chosen to mismatch the @ai-sdk/mcp installed there.
 */
import { describe, expect, it, vi } from "vitest";
import { createMnemoverseTools, MnemoverseConfigError } from "../src/index.js";
import { fixtureFetch } from "./helpers/fixture-fetch.mjs";
import { VALID_KEY } from "./helpers/tools.js";

const claimed = vi.hoisted(() => {
  const { createRequire } = require("node:module") as typeof import("node:module");
  const mcpMajor = Number(createRequire(import.meta.url)("@ai-sdk/mcp/package.json").version.split(".")[0]);
  return mcpMajor === 0
    ? { ai: "7.0.113", install: "@ai-sdk/mcp@^2" }
    : { ai: "5.0.265", install: "@ai-sdk/mcp@ai-v5" };
});

vi.mock("ai/package.json", () => ({ default: { name: "ai", version: claimed.ai } }));

describe("an ai major installed with the wrong @ai-sdk/mcp major", () => {
  it("is refused with incompatible_ai_versions, before any request", async () => {
    const fixture = fixtureFetch({});
    const error = await createMnemoverseTools({ apiKey: VALID_KEY, fetch: fixture.fetch }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MnemoverseConfigError);
    expect((error as MnemoverseConfigError).code).toBe("incompatible_ai_versions");
    expect((error as Error).message).toContain(`pnpm add ${claimed.install}`);
    expect(fixture.calls).toHaveLength(0);
  });
});
