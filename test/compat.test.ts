/**
 * The ai / @ai-sdk/mcp pair check (src/compat.ts).
 *
 * Regression for the pairing finding: ai 5 with @ai-sdk/mcp 1.x or 2.x
 * installs without a peer warning, the tools are created, and then every
 * tool call the model makes fails the AI SDK's input parsing ("value is not
 * a function") and never reaches the API. Only the pairs in the test matrix
 * are accepted now, before anything is built. The real mismatched install is
 * a consumer leg of scripts/test-matrix.mjs.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { MATRIX } from "../scripts/test-matrix.mjs";
import { installedAiVersions, MCP_CLIENT_MAJOR, refuseAiPair } from "../src/compat.js";
import { MnemoverseConfigError } from "../src/errors.js";

const require = createRequire(import.meta.url);

function refusal(ai: unknown, mcp: unknown): MnemoverseConfigError {
  try {
    refuseAiPair(ai, mcp);
  } catch (error) {
    expect(error).toBeInstanceOf(MnemoverseConfigError);
    expect((error as MnemoverseConfigError).code).toBe("incompatible_ai_versions");
    return error as MnemoverseConfigError;
  }
  throw new Error(`expected ai ${String(ai)} + @ai-sdk/mcp ${String(mcp)} to be refused`);
}

describe("refuseAiPair", () => {
  it.each(Object.entries(MATRIX).map(([major, pair]) => [major, pair.ai, pair.mcp]))(
    "ai %s: the matrix pair %s + %s is accepted",
    (_major, ai, mcp) => {
      expect(() => refuseAiPair(ai, mcp)).not.toThrow();
    },
  );

  it("accepts any version within a matched pair of majors", () => {
    expect(() => refuseAiPair("5.0.80", "0.0.1")).not.toThrow();
    expect(() => refuseAiPair("6.1.0", "1.9.9")).not.toThrow();
    expect(() => refuseAiPair("7.3.0-beta.1", "2.4.0")).not.toThrow();
  });

  it.each([
    ["5.0.265", "2.0.57", "@ai-sdk/mcp@ai-v5"],
    ["5.0.265", "1.0.85", "@ai-sdk/mcp@ai-v5"],
    ["6.0.290", "2.0.57", "@ai-sdk/mcp@ai-v6"],
    ["6.0.290", "0.0.35", "@ai-sdk/mcp@ai-v6"],
    ["7.0.113", "0.0.35", "@ai-sdk/mcp@^2"],
    ["7.0.113", "1.0.85", "@ai-sdk/mcp@^2"],
  ])("ai %s + @ai-sdk/mcp %s is refused, naming the install that fixes it", (ai, mcp, install) => {
    const error = refusal(ai, mcp);
    expect(error.message).toContain(`@ai-sdk/mcp ${mcp} is installed with ai ${ai}`);
    expect(error.message).toContain(install);
  });

  it.each([["4.3.19"], ["8.0.0"], ["not-a-version"], [undefined]])("ai %s is not supported", (ai) => {
    expect(refusal(ai, "2.0.57").message).toContain("works with ai 5, 6 and 7");
  });

  it("the accepted pairs are exactly the test matrix's", () => {
    expect(
      Object.fromEntries(Object.entries(MATRIX).map(([major, pair]) => [major, Number(pair.mcp.split(".")[0])])),
    ).toEqual(Object.fromEntries(Object.entries(MCP_CLIENT_MAJOR).map(([a, m]) => [a, m])));
  });
});

describe("installedAiVersions", () => {
  it("reads the installed ai and @ai-sdk/mcp package.json files", () => {
    expect(installedAiVersions()).toEqual({
      ai: require("ai/package.json").version,
      mcpClient: require("@ai-sdk/mcp/package.json").version,
    });
  });
});
