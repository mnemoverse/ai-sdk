/**
 * The contract with @mnemoverse/mcp-memory-server: what these AI SDK tools
 * expose and answer is exactly what the package's own stdio server exposes
 * and answers.
 *
 * Ground truth is the package's REAL stdio entry (its root module, with its
 * own private apiFetch), run in a child process with a clean environment and a
 * fixture fetch (test/helpers/reference-runner.mjs), read through a plain MCP
 * SDK client. This side is the full pipeline: createMnemoverseTools → the AI
 * SDK's MCP client (the installed major) → the custom transport → the
 * in-process McpServer with registerMemoryTools → this package's apiFetch.
 *
 * These are the checks the auto-update contour relies on
 * (docs/AUTO-UPDATE-CONTOUR.md): after a dependency bump, the tool set, the
 * metadata and a real round trip per tool must still match, or the bump is red.
 */
import { SERVER_INSTRUCTIONS as PACKAGE_INSTRUCTIONS } from "@mnemoverse/mcp-memory-server/shared";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMnemoverseTools,
  MEMORY_TOOL_NAMES,
  SERVER_INSTRUCTIONS,
  SURFACE_VERSION,
  TOOL_CLASSES,
  type MnemoverseTools,
} from "../src/index.js";
import { fixtureFetch, type RecordedCall, type Routes } from "./helpers/fixture-fetch.mjs";
import { SCENARIOS } from "./helpers/scenarios.mjs";
import { callTool, jsonSchemaOf, toolOf, VALID_KEY } from "./helpers/tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "helpers", "reference-runner.mjs");

interface Case {
  tool: string;
  args: Record<string, unknown>;
  routes: Routes;
}
interface ReferenceTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
interface Reference {
  tools: ReferenceTool[];
  instructions: string;
  results: Array<{ result: Record<string, unknown>; requests: RecordedCall[]; unmatched: string[] }>;
}

/** Run cases through the real stdio entry with exactly this environment and nothing inherited. */
function reference(env: Record<string, string | null>, cases: Case[]): Reference {
  const dir = mkdtempSync(join(tmpdir(), "mnemoverse-ref-"));
  try {
    const file = join(dir, "scenario.json");
    writeFileSync(file, JSON.stringify({ env, cases }));
    const out = execFileSync(process.execPath, [runner, file], {
      cwd: here,
      encoding: "utf8",
      // A clean environment: the developer's real MNEMOVERSE_* variables must
      // never reach the reference server.
      env: { PATH: process.env.PATH ?? "" },
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out) as Reference;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALL = [...MEMORY_TOOL_NAMES];
const cases: Case[] = SCENARIOS.map((s) => ({ tool: s.tool, args: s.args, routes: s.routes }));
let ref: Reference;
let mine: MnemoverseTools;

beforeAll(async () => {
  ref = reference({ MNEMOVERSE_API_KEY: VALID_KEY, MNEMOVERSE_API_URL: null }, cases);
  mine = await createMnemoverseTools({ apiKey: VALID_KEY, tools: ALL, fetch: () => Promise.reject(new Error("unused")) });
}, 60_000);

afterAll(async () => {
  await mine?.close();
});

describe("tool set", () => {
  it("client.tools() exposes exactly the set the package registers", () => {
    expect(Object.keys(mine.tools).sort()).toEqual(ref.tools.map((t) => t.name).sort());
  });

  it("every registered tool is classified by the policy, and nothing else is (a new upstream tool needs a human)", () => {
    expect(Object.keys(TOOL_CLASSES).sort()).toEqual(ref.tools.map((t) => t.name).sort());
  });

  it("the order is the package's registration order", () => {
    expect(Object.keys(mine.tools)).toEqual(ref.tools.map((t) => t.name));
  });
});

describe("metadata comes from the package, byte for byte", () => {
  it("descriptions", () => {
    for (const t of ref.tools) {
      expect(toolOf(mine, t.name).description, t.name).toBe(t.description);
    }
  });

  it("input schemas: the package's, plus only what the AI SDK MCP client itself adds to every MCP tool", async () => {
    for (const t of ref.tools) {
      // @ai-sdk/mcp (0.x, 1.x and 2.x alike) builds `jsonSchema({ ...inputSchema,
      // properties: inputSchema.properties ?? {}, additionalProperties: false })`.
      const expected = { ...t.inputSchema, properties: t.inputSchema.properties ?? {}, additionalProperties: false };
      expect(await jsonSchemaOf(mine, t.name), t.name).toStrictEqual(expected);
    }
  });

  it("titles, where the installed client carries them (ai 6 and 7), are the package's annotation titles", () => {
    for (const t of ref.tools) {
      const title = toolOf(mine, t.name).title;
      if (title !== undefined) expect(title, t.name).toBe(t.title ?? t.annotations?.title);
    }
  });

  it("SERVER_INSTRUCTIONS is the package's own export, and what the server announces", () => {
    expect(SERVER_INSTRUCTIONS).toBe(PACKAGE_INSTRUCTIONS);
    expect(ref.instructions).toBe(PACKAGE_INSTRUCTIONS);
  });

  it("surfaceVersion is the pinned package version", () => {
    expect(mine.surfaceVersion).toBe(SURFACE_VERSION);
  });
});

describe("a real round trip per tool equals the stdio server's", () => {
  it("every fixture: the same CallToolResult (content, structuredContent, isError) and the same requests", async () => {
    expect(new Set(cases.map((c) => c.tool))).toEqual(new Set(ALL));
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      const fixture = fixtureFetch(c.routes);
      const set = await createMnemoverseTools({ apiKey: VALID_KEY, tools: ALL, fetch: fixture.fetch });
      try {
        const result = await callTool(set, c.tool, c.args);
        const expected = ref.results[i]!;
        const label = SCENARIOS[i]!.id;
        expect(normalise(result), label).toStrictEqual(normalise(expected.result));
        expect(fixture.calls.map(wire), label).toStrictEqual(expected.requests.map(wire));
        expect(fixture.unmatched, label).toEqual(expected.unmatched);
      } finally {
        await set.close();
      }
    }
    // The fixtures did make real requests on both sides.
    expect(ref.results.some((r) => r.requests.length > 0)).toBe(true);
    expect(ref.results.flatMap((r) => r.unmatched)).toEqual([]);
  }, 120_000);
});

/** `isError: false` and an absent `isError` mean the same in MCP; clients differ in which they keep. */
function normalise(result: object): Record<string, unknown> {
  const { isError, ...rest } = result as Record<string, unknown>;
  return { ...rest, isError: isError === true };
}

/** The request as the wire sees it. The reference has no timeout signal; this package always does. */
function wire({ hasSignal: _ignored, ...rest }: RecordedCall) {
  return rest;
}
