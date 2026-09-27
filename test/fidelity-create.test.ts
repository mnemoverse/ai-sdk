/**
 * createMnemoverseTools end to end, in the install the zod-resolution finding
 * describes: an application whose zod gives @modelcontextprotocol/sdk the
 * zod 3.25 converter. The in-process McpServer here replays exactly that
 * conversion for `tools/list` (`zod/v4-mini` toJSONSchema from zod 3.25,
 * target draft-7, io input, as the SDK's zod-json-schema-compat does), so the
 * test needs no second install.
 *
 * Before the fix: the tools were created with every description and limit
 * stripped, and a 150-character pin passed the pin check (it read the
 * stripped schema), after which every memory_write failed validation. Now:
 * creation fails with MnemoverseSurfaceError, before any request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMnemoverseTools, MnemoverseSurfaceError } from "../src/index.js";
import { fixtureFetch } from "./helpers/fixture-fetch.mjs";
import { VALID_KEY } from "./helpers/tools.js";

const replay = vi.hoisted(() => ({ zod325: false }));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/sdk/server/mcp.js")>();
  const zod325 = await import("zod-3.25/v4-mini");
  type Handler = (request: unknown, extra: unknown) => Promise<{ tools: Array<Record<string, unknown>> }>;
  class ReplayingMcpServer extends actual.McpServer {
    override async connect(transport: Parameters<InstanceType<typeof actual.McpServer>["connect"]>[0]) {
      if (replay.zod325) {
        const handlers = (this.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
        const list = handlers.get("tools/list")!;
        const tools = (this as unknown as { _registeredTools: Record<string, { inputSchema?: any }> })._registeredTools;
        handlers.set("tools/list", async (request, extra) => {
          const result = await list(request, extra);
          for (const tool of result.tools) {
            const shape = tools[tool.name as string]?.inputSchema?._zod?.def?.shape ?? {};
            tool.inputSchema = zod325.toJSONSchema(zod325.object(shape), { target: "draft-7", io: "input" });
          }
          return result;
        });
      }
      return super.connect(transport);
    }
  }
  return { ...actual, McpServer: ReplayingMcpServer };
});

afterEach(() => {
  replay.zod325 = false;
});

describe("createMnemoverseTools when the SDK converts with zod 3.25", () => {
  it("control: with the package's zod, the tools are created and carry the package's limits", async () => {
    const set = await createMnemoverseTools({ apiKey: VALID_KEY, tools: ["memory_write"] });
    try {
      const schema = (set.tools.memory_write as any).inputSchema.jsonSchema;
      const resolved = typeof schema === "function" ? await schema() : await schema;
      expect(resolved.properties.content.minLength).toBe(1);
    } finally {
      await set.close();
    }
  });

  it("creation fails loudly instead of handing the model stripped schemas; nothing is sent", async () => {
    replay.zod325 = true;
    const fixture = fixtureFetch({});
    const error = await createMnemoverseTools({ apiKey: VALID_KEY, fetch: fixture.fetch }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MnemoverseSurfaceError);
    expect((error as Error).message).toMatch(/memory_write\.content\.(minLength|description)/);
    expect(fixture.calls).toHaveLength(0);
  });

  it("a pin longer than the package allows can no longer slip through a stripped schema", async () => {
    replay.zod325 = true;
    const error = await createMnemoverseTools({
      apiKey: VALID_KEY,
      domain: "d".repeat(150),
      tools: ["memory_write"],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MnemoverseSurfaceError);
  });
});
