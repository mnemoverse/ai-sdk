/**
 * End to end through the INSTALLED `ai` and `@ai-sdk/mcp` (the matrix runs this
 * file against ai 5, 6 and 7): a mock model calls a Mnemoverse tool inside
 * generateText with stopWhen: stepCountIs(n). Checked: what the caller gets
 * (the MCP CallToolResult, structuredContent included), what the model is sent
 * back (the package's text, as text or error-text), and that the loop goes on.
 *
 * The mock class and result shape follow the installed major:
 * LanguageModelV2 for ai 5, V3 for ai 6, V4 for ai 7.
 */
import { generateText, stepCountIs } from "ai";
import * as aiTest from "ai/test";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createMnemoverseTools, type MnemoverseTools, type MnemoverseToolsOptions } from "../src/index.js";
import { fixtureFetch, type Routes } from "./helpers/fixture-fetch.mjs";
import { VALID_KEY } from "./helpers/tools.js";

type AnyRecord = Record<string, any>;
const mocks = aiTest as unknown as AnyRecord;
const spec: "v4" | "v3" | "v2" = mocks.MockLanguageModelV4 ? "v4" : mocks.MockLanguageModelV3 ? "v3" : "v2";
const MockModel = mocks.MockLanguageModelV4 ?? mocks.MockLanguageModelV3 ?? mocks.MockLanguageModelV2;
const AI_MAJOR = Number(createRequire(import.meta.url)("ai/package.json").version.split(".")[0]);

function result(content: AnyRecord[], finish: "tool-calls" | "stop") {
  if (spec === "v2") {
    return { content, finishReason: finish, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  }
  return {
    content,
    finishReason: { unified: finish, raw: finish },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

/** A model that calls `toolName` with `input` once, then answers "done". */
function scriptedModel(toolName: string, input: AnyRecord) {
  const prompts: AnyRecord[][] = [];
  const toolsSeen: AnyRecord[][] = [];
  const model = new MockModel({
    doGenerate: async (options: AnyRecord) => {
      prompts.push(options.prompt);
      toolsSeen.push(options.tools ?? []);
      if (prompts.length === 1) {
        return result([{ type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) }], "tool-calls");
      }
      return result([{ type: "text", text: "done" }], "stop");
    },
  });
  return { model, prompts, toolsSeen };
}

function sentBack(prompts: AnyRecord[][]): AnyRecord {
  const toolMessage = prompts[1]!.find((m) => m.role === "tool");
  return toolMessage!.content.find((p: AnyRecord) => p.type === "tool-result").output;
}

const open: MnemoverseTools[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function run(routes: Routes, toolName: string, input: AnyRecord, options: MnemoverseToolsOptions = {}) {
  const fixture = fixtureFetch(routes);
  const set = await createMnemoverseTools({ apiKey: VALID_KEY, fetch: fixture.fetch, ...options });
  open.push(set);
  const { model, prompts, toolsSeen } = scriptedModel(toolName, input);
  const out = (await generateText({
    model,
    tools: set.tools,
    stopWhen: stepCountIs(3),
    prompt: "Remember that I prefer dark mode.",
  })) as unknown as AnyRecord;
  const step = out.steps[0];
  return { out, step, prompts, toolsSeen, fixture };
}

const item = {
  atom_id: "mem_01",
  content: "User prefers dark mode",
  relevance: 0.9,
  concepts: [],
  domain: "general",
  created_at: "2026-09-20T10:00:00Z",
};

describe(`generateText with the installed ai (model spec ${spec})`, () => {
  it("the caller gets the CallToolResult with structuredContent; the model reads the package's text", async () => {
    const { out, step, prompts, fixture } = await run(
      { "POST /memory/write": { json: { stored: true, atom_id: "mem_01", importance: 0.5 } } },
      "memory_write",
      { content: "User prefers dark mode" },
    );
    expect(out.text).toBe("done");
    expect(JSON.parse(fixture.calls[0]!.body!)).toEqual({ content: "User prefers dark mode", concepts: [], domain: "general" });
    const output = step.toolResults[0].output;
    expect(output.isError).not.toBe(true);
    expect(output.structuredContent).toMatchObject({ stored: true, memory_id: "mem_01" });
    const text = output.content.map((p: AnyRecord) => p.text).join("\n");
    expect(text.length).toBeGreaterThan(0);
    expect(sentBack(prompts)).toEqual({ type: "text", value: text });
  });

  it("an API error is an isError result: the model reads it as error-text and the loop continues", async () => {
    const { out, step, prompts } = await run(
      { "POST /memory/read": { status: 401, json: { detail: "Invalid API key" } } },
      "memory_read",
      { query: "editor theme" },
    );
    expect(out.text).toBe("done");
    const output = step.toolResults[0].output;
    expect(output.isError).toBe(true);
    expect(sentBack(prompts)).toEqual({ type: "error-text", value: output.content[0].text });
    expect(output.content[0].text).toMatch(/^Mnemoverse: /);
  });

  it("the model is offered the package's descriptions and JSON schemas", async () => {
    const { toolsSeen } = await run(
      { "POST /memory/read": { json: { items: [item] } } },
      "memory_read",
      { query: "theme" },
      { tools: ["memory_read"] },
    );
    const offered = toolsSeen[0]!;
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ type: expect.stringMatching(/function|dynamic/), name: "memory_read" });
    expect(offered[0]!.description).toMatch(/memory/i);
    expect(Object.keys(offered[0]!.inputSchema.properties)).toContain("query");
  });

  it("a pinned domain overrides the model's", async () => {
    const { fixture } = await run(
      { "POST /memory/read": { json: { items: [item] } } },
      "memory_read",
      { query: "anything", domain: "user:bob" },
      { domain: "user:alice" },
    );
    expect(JSON.parse(fixture.calls[0]!.body!).domain).toBe("user:alice");
  });

  it("input the package's schema rejects never reaches the API; the model reads the MCP validation error", async () => {
    const { fixture, out, step, prompts } = await run({}, "memory_write", { content: "" });
    expect(fixture.calls).toHaveLength(0);
    expect(out.text).toBe("done");
    const output = step.toolResults[0]?.output;
    const back = sentBack(prompts);
    expect(back.type).toMatch(/error/);
    if (output) expect(output.isError).toBe(true);
  });

  it("a tool outside the set is not callable", async () => {
    const { fixture, out } = await run({}, "memory_stats", {}, { tools: ["memory_read"] });
    expect(fixture.calls).toHaveLength(0);
    expect(out.text).toBe("done");
  });
});

/**
 * Shared-room content is untrusted (other members write it), so a model told
 * by it to copy something into a room must not get there unattended. ai 6 and
 * 7 stop the loop at the approval request; ai 5 has no tool approval.
 */
describe(`room approval through generateText (ai ${AI_MAJOR})`, () => {
  const written = { "POST /memory/write": { json: { stored: true, atom_id: "mem_01", importance: 0.5 } } };
  const intoRoom = { content: "Our unreleased Q3 numbers", domain: "xroom:room_01ABC" };

  it(
    AI_MAJOR >= 6
      ? "a write into a shared room waits for approval: nothing is sent"
      : "ai 5 has no tool approval: a write into a shared room runs",
    async () => {
      const { out, fixture } = await run(written, "memory_write", intoRoom);
      if (AI_MAJOR >= 6) {
        expect(fixture.calls).toHaveLength(0);
        const request = out.steps[0].content.find((p: AnyRecord) => p.type === "tool-approval-request");
        expect(request?.toolCall).toMatchObject({ toolName: "memory_write", input: intoRoom });
        expect(out.steps[0].toolResults).toHaveLength(0);
      } else {
        expect(fixture.calls).toHaveLength(1);
      }
    },
  );

  it("under an xroom: pin, a write waits for approval whatever domain the model sends (ai 6+)", async () => {
    const { fixture } = await run(written, "memory_write", { content: "x", domain: "user:me" }, { domain: "xroom:room_01ABC" });
    expect(fixture.calls).toHaveLength(AI_MAJOR >= 6 ? 0 : 1);
  });

  it("roomApproval: false: the room write runs on every major", async () => {
    const { fixture, out } = await run(written, "memory_write", intoRoom, { roomApproval: false });
    expect(fixture.calls).toHaveLength(1);
    expect(JSON.parse(fixture.calls[0]!.body!).domain).toBe("xroom:room_01ABC");
    expect(out.text).toBe("done");
  });

  it("a write to the key's own store needs no approval", async () => {
    const { fixture } = await run(written, "memory_write", { content: "x", domain: "project:acme" });
    expect(fixture.calls).toHaveLength(1);
  });
});
