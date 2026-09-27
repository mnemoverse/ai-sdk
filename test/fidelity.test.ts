/**
 * Schema fidelity (src/fidelity.ts): the tool schemas the model sees must
 * carry everything the package's own zod declares for each field.
 *
 * Regression for the zod-resolution finding: in an application whose install
 * gives @modelcontextprotocol/sdk zod 3.25 (or 4.0–4.2), the in-process
 * McpServer converted the package's zod 4 schemas with that zod's converter
 * and dropped every description and limit, silently. Here the SDK's
 * conversion (`zod/v4-mini` toJSONSchema, target draft-7, io input) is
 * replayed with the old converters on the package's REAL registered shapes,
 * and the check must refuse each result, while accepting the conversion the
 * package's own zod makes.
 */
import { registerMemoryTools } from "@mnemoverse/mcp-memory-server/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import * as zod325 from "zod-3.25/v4-mini";
import * as zod41 from "zod-4.1/v4-mini";
import { MnemoverseSurfaceError } from "../src/errors.js";
import { checkSchemaFidelity, recordInputSchemas } from "../src/fidelity.js";
import type { ObservedTool } from "../src/transport.js";
import { MEMORY_TOOL_NAMES } from "../src/policy.js";
import { SURFACE_ZOD_RANGE } from "../src/version.js";

type Json = Record<string, any>;

/** The listed properties of a tool, loosely typed for the tests. */
const props = (tool: ObservedTool | undefined): Json => (tool!.inputSchema as Json).properties;

/** The package's registered shapes, and its tools/list through this repo's SDK + zod 4. */
async function packageSurface() {
  const registered = new Map<string, unknown>();
  const server = new McpServer({ name: "probe", version: "0" });
  registerMemoryTools(recordInputSchemas(server, registered), { apiFetch: async () => ({}) as never });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "probe", version: "0" });
  await client.connect(a);
  const { tools } = await client.listTools();
  await client.close();
  const listed = new Map<string, ObservedTool>(
    tools.map((t) => [t.name, { name: t.name, inputSchema: t.inputSchema as Json }]),
  );
  return { registered, listed };
}

/** What the SDK lists when its `zod/v4-mini` is `mini` instead of the package's zod. */
function convertedWith(mini: { object: (shape: any) => any; toJSONSchema: (s: any, o: any) => any }, registered: Map<string, unknown>) {
  return new Map<string, ObservedTool>(
    [...registered].map(([name, shape]) => [
      name,
      { name, inputSchema: mini.toJSONSchema(mini.object(shape ?? {}), { target: "draft-7", io: "input" }) as Json },
    ]),
  );
}

function refusal(fn: () => void): MnemoverseSurfaceError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MnemoverseSurfaceError);
    return error as MnemoverseSurfaceError;
  }
  throw new Error("expected a MnemoverseSurfaceError");
}

describe("the listed schemas against the package's own zod", () => {
  it("the SDK paired with the package's zod lists exactly what the package declares: accepted", async () => {
    const { registered, listed } = await packageSurface();
    // Every tool the package registers, which the contract test pins to the
    // policy's classified set; no count is typed here.
    expect(registered.size).toBe(MEMORY_TOOL_NAMES.length);
    expect(() => checkSchemaFidelity(registered, listed)).not.toThrow();
  });

  it("zod 3.25's converter (the SDK in an app with zod 3.25): descriptions and limits lost, refused", async () => {
    const { registered } = await packageSurface();
    const degraded = convertedWith(zod325, registered);
    // What the model would have been given: no description, no limit.
    expect(props(degraded.get("memory_write")).content).toEqual({ type: "string" });
    const error = refusal(() => checkSchemaFidelity(registered, degraded));
    expect(error.message).toContain("memory_write.content.minLength");
    expect(error.message).toContain("memory_write.content.description");
    expect(error.message).toContain(`zod ${SURFACE_ZOD_RANGE}`);
    expect(SURFACE_ZOD_RANGE).toMatch(/^\^4\./);
  });

  it("zod 4.1's converter: descriptions kept, limits lost, refused", async () => {
    const { registered } = await packageSurface();
    const degraded = convertedWith(zod41, registered);
    expect(props(degraded.get("memory_write")).content.description).toEqual(expect.any(String));
    const error = refusal(() => checkSchemaFidelity(registered, degraded));
    expect(error.message).toContain("memory_write.content.minLength");
    expect(error.message).not.toContain("memory_write.content.description");
  });

  it("a single lost keyword, anywhere in a field, is refused", async () => {
    const { registered, listed } = await packageSurface();
    const read = structuredClone(listed.get("memory_read")!);
    delete props(read).top_k.maximum;
    const error = refusal(() => checkSchemaFidelity(registered, new Map([...listed, ["memory_read", read]])));
    expect(error.message).toContain("memory_read.top_k.maximum");
  });

  it("a changed value is refused (integer is not number)", async () => {
    const { registered, listed } = await packageSurface();
    const read = structuredClone(listed.get("memory_read")!);
    props(read).top_k.type = "number";
    const error = refusal(() => checkSchemaFidelity(registered, new Map([...listed, ["memory_read", read]])));
    expect(error.message).toContain("memory_read.top_k.type");
  });

  it("a server that ADDS to a schema is not refused", async () => {
    const { registered, listed } = await packageSurface();
    const write = structuredClone(listed.get("memory_write")!);
    props(write).content["x-extra"] = true;
    write.inputSchema.additionalProperties = false;
    expect(() => checkSchemaFidelity(registered, new Map([...listed, ["memory_write", write]]))).not.toThrow();
  });

  it("a listed tool the package did not register, or a field that cannot describe itself, cannot be checked: refused", async () => {
    const { registered, listed } = await packageSurface();
    const extra = new Map(listed).set("memory_delete", { name: "memory_delete", inputSchema: { type: "object" } });
    expect(refusal(() => checkSchemaFidelity(registered, extra)).message).toContain("memory_delete");
    const opaque = new Map(registered).set("memory_read", { query: { parse: () => undefined } });
    expect(refusal(() => checkSchemaFidelity(opaque, listed)).message).toContain("memory_read.query");
  });
});

describe("recordInputSchemas", () => {
  it("records each registered input schema and leaves the server working as before", async () => {
    const registered = new Map<string, unknown>();
    const server = new McpServer({ name: "probe", version: "0" });
    const recording = recordInputSchemas(server, registered);
    expect(recording).toBeInstanceOf(McpServer);
    const handle = recording.registerTool("probe_tool", { description: "d", inputSchema: {} }, async () => ({ content: [] }));
    expect(typeof handle.disable).toBe("function");
    expect(registered.has("probe_tool")).toBe(true);
    expect(recording.isConnected()).toBe(false);
  });
});
