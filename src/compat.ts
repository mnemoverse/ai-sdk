/**
 * Which `ai` and `@ai-sdk/mcp` are installed together.
 *
 * The AI SDK's MCP client builds each tool's input schema with its own
 * @ai-sdk/provider-utils, and `ai` parses the model's tool input with ITS own.
 * Each @ai-sdk/mcp major is built against one `ai` major (they ship the same
 * provider-utils). The peer ranges cannot say which goes with which, and
 * @ai-sdk/mcp 1.x and 2.x declare no peer on `ai` at all, so nothing stops
 * ai 5 from being installed next to @ai-sdk/mcp 2.x (what a bare
 * `pnpm add @ai-sdk/mcp` gives). Then every tool call fails the AI SDK's input
 * parsing and never reaches Mnemoverse, while generateText finishes normally
 * with tool errors only.
 *
 * So only the pairs in the test matrix (scripts/test-matrix.mjs) are
 * accepted, decided from the two installed package.json files before anything
 * is built.
 */
import mcpClientPackage from "@ai-sdk/mcp/package.json" with { type: "json" };
import aiPackage from "ai/package.json" with { type: "json" };
import { MnemoverseConfigError } from "./errors.js";

/** ai major → the @ai-sdk/mcp major built against it. Every pair is in the test matrix. */
export const MCP_CLIENT_MAJOR: Readonly<Record<number, number>> = Object.freeze({ 5: 0, 6: 1, 7: 2 });

/** How to install the matching @ai-sdk/mcp, per ai major (npm dist-tags ai-v5, ai-v6; latest is 2.x). */
const INSTALL: Readonly<Record<number, string>> = Object.freeze({
  5: "@ai-sdk/mcp@ai-v5",
  6: "@ai-sdk/mcp@ai-v6",
  7: "@ai-sdk/mcp@^2",
});

/** The installed versions, as their package.json files state them. */
export function installedAiVersions(): { ai: unknown; mcpClient: unknown } {
  return { ai: aiPackage.version, mcpClient: mcpClientPackage.version };
}

/**
 * Throws MnemoverseConfigError (`incompatible_ai_versions`) unless `ai` and
 * `@ai-sdk/mcp` are a tested pair. Returns the `ai` major.
 */
export function refuseAiPair(ai: unknown, mcpClient: unknown): number {
  const aiMajor = majorOf(ai);
  const mcpMajor = majorOf(mcpClient);
  const wanted = aiMajor === undefined ? undefined : MCP_CLIENT_MAJOR[aiMajor];
  if (wanted !== undefined && mcpMajor === wanted) return aiMajor!;
  const supported = Object.entries(MCP_CLIENT_MAJOR)
    .map(([a, m]) => `@ai-sdk/mcp ${m === 0 ? "0.0.x" : `${m}.x`} for ai ${a}`)
    .join(", ");
  throw new MnemoverseConfigError(
    "incompatible_ai_versions",
    wanted === undefined
      ? `ai ${String(ai)} is not supported: @mnemoverse/ai-sdk works with ai 5, 6 and 7 (${supported}).`
      : `@ai-sdk/mcp ${String(mcpClient)} is installed with ai ${String(ai)}. The AI SDK's MCP client must match ` +
          `the ai major (${supported}); with any other pair every tool call fails the AI SDK's input parsing and ` +
          `never reaches Mnemoverse. Install the matching one: pnpm add ${INSTALL[aiMajor!]}`,
  );
}

function majorOf(version: unknown): number | undefined {
  const m = typeof version === "string" ? /^(\d+)\.\d+\.\d+/.exec(version) : null;
  return m ? Number(m[1]) : undefined;
}
