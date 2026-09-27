"use strict";
/**
 * CommonJS smoke test against the BUILT package (run `pnpm run build` first).
 *
 * The package is required by its own name, so this goes through package.json
 * "exports" exactly as a CommonJS application's require() would. The CJS build
 * requires ESM-only modules (@mnemoverse/mcp-memory-server/shared, and
 * @ai-sdk/mcp 2.x for ai 7) through require(esm): Node 22.12+.
 *
 * Checks: requiring has no side effects (no env read, no network); the error
 * classes are the MCP package's own across the CJS/ESM boundary; the MCP SDK
 * server, loaded as CJS here while the package's modules are ESM, still
 * converts the package's schemas with their descriptions; and a tool call
 * round-trips through a mocked fetch.
 */
const assert = require("node:assert/strict");

delete process.env.MNEMOVERSE_API_KEY;
delete process.env.MNEMOVERSE_API_URL;
globalThis.fetch = () => {
  throw new Error("smoke: the network was used");
};

const m = require("@mnemoverse/ai-sdk");
const shared = require("@mnemoverse/mcp-memory-server/shared");

async function main() {
  assert.equal(typeof m.createMnemoverseTools, "function");
  assert.equal(m.ApiError, shared.ApiError, "ApiError is the MCP package's class");
  assert.equal(m.SERVER_INSTRUCTIONS, shared.SERVER_INSTRUCTIONS, "instructions are re-exported, not copied");
  assert.equal(m.SURFACE_VERSION, require("@mnemoverse/mcp-memory-server/package.json").version);
  assert.equal(m.VERSION, require("@mnemoverse/ai-sdk/package.json").version);

  const calls = [];
  const routes = {
    "/memory/write": [200, { stored: true, atom_id: "mem_01", importance: 0.5 }],
    "/memory/read": [401, { detail: "Invalid API key" }],
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const [status, body] = routes[url.replace(m.DEFAULT_BASE_URL, "")];
    return new Response(JSON.stringify(body), { status });
  };
  const set = await m.createMnemoverseTools({ apiKey: "mk_live_deadbeef", fetch: fetchImpl });
  try {
    assert.equal(calls.length, 0, "creating tools sends nothing");
    assert.ok(Object.keys(set.tools).includes("memory_write"));
    const schema = await set.tools.memory_write.inputSchema.jsonSchema;
    const description = schema.properties.content.description;
    assert.ok(typeof description === "string" && description.length > 20, "schema descriptions survive the CJS build");

    const ok = await set.tools.memory_write.execute({ content: "User prefers dark mode" }, { toolCallId: "c1", messages: [] });
    assert.notEqual(ok.isError, true);
    assert.equal(ok.structuredContent.memory_id, "mem_01");
    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0].init.headers).get("x-api-key"), "mk_live_deadbeef");
    assert.equal(calls[0].init.redirect, "error");

    const bad = await set.tools.memory_read.execute({ query: "x" }, { toolCallId: "c2", messages: [] });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /^Mnemoverse: /);
  } finally {
    await set.close();
  }

  let aiVersion = "unknown";
  let mcpVersion = "unknown";
  try {
    aiVersion = require("ai/package.json").version;
    mcpVersion = require("@ai-sdk/mcp/package.json").version;
  } catch {
    // an exports map without package.json
  }
  console.log(`CJS smoke OK: node ${process.version}, ai ${aiVersion}, @ai-sdk/mcp ${mcpVersion}, surface ${m.SURFACE_VERSION}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
