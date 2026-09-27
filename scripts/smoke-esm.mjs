/**
 * ESM smoke test against the BUILT package (run `pnpm run build` first):
 * importing has no side effects, a tool call round-trips through a mocked
 * fetch, and the ESM and CJS builds expose identical tools (names,
 * descriptions, JSON schemas).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

delete process.env.MNEMOVERSE_API_KEY;
delete process.env.MNEMOVERSE_API_URL;
globalThis.fetch = () => {
  throw new Error("smoke: the network was used");
};

const esm = await import("@mnemoverse/ai-sdk");
const cjs = createRequire(import.meta.url)("@mnemoverse/ai-sdk");

async function describeTools(mod) {
  const set = await mod.createMnemoverseTools({
    apiKey: "mk_live_deadbeef",
    tools: [...mod.MEMORY_TOOL_NAMES],
    fetch: async () => new Response(JSON.stringify({ stored: true, atom_id: "m1", importance: 0.5 })),
  });
  try {
    const out = {};
    for (const [name, tool] of Object.entries(set.tools)) {
      out[name] = { description: tool.description, schema: await tool.inputSchema.jsonSchema };
    }
    const r = await set.tools.memory_write.execute({ content: "x y z" }, { toolCallId: "c", messages: [] });
    assert.equal(r.structuredContent.memory_id, "m1");
    return out;
  } finally {
    await set.close();
  }
}

const a = await describeTools(esm);
const b = await describeTools(cjs);
assert.equal(Object.keys(a).length, esm.MEMORY_TOOL_NAMES.length); // every classified tool, no count typed here
assert.deepEqual(a, b, "ESM and CJS builds expose identical tools");
console.log(`ESM smoke OK: node ${process.version}, ${Object.keys(a).length} tools, identical to the CJS build`);
