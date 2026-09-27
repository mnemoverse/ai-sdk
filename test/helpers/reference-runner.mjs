/**
 * Runs the REAL @mnemoverse/mcp-memory-server stdio entry (its package root,
 * dist/index.js, with its own private apiFetch) in this process and answers
 * `tools/list` and tool calls through a plain MCP SDK client. It is the ground
 * truth test/contract.test.ts compares this package with: what an MCP host
 * connected to the stdio server would receive.
 *
 *   node reference-runner.mjs <scenario-file.json>
 *
 * Scenario file: { env: {NAME: value|null}, cases: [{ tool, args, routes }] }.
 * Prints one JSON line: { tools, instructions, results: [{ result, requests, unmatched }] }.
 *
 * The entry reads MNEMOVERSE_API_KEY / MNEMOVERSE_API_URL once at import, so
 * each environment needs its own process. MNEMOVERSE_MCP_NO_AUTOSTART=1 keeps
 * it from opening stdio or probing the key; `fetch` is replaced before the
 * import, so nothing can leave this machine.
 */
import { readFileSync } from "node:fs";
import { fixtureFetch } from "./fixture-fetch.mjs";

const scenario = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const [name, value] of Object.entries(scenario.env)) {
  if (value === null) delete process.env[name];
  else process.env[name] = value;
}
process.env.MNEMOVERSE_MCP_NO_AUTOSTART = "1";

const baseUrl = process.env.MNEMOVERSE_API_URL || "https://core.mnemoverse.com/api/v1";
let current = fixtureFetch({}, { baseUrl });
globalThis.fetch = (input, init) => current.fetch(input, init);

const { server } = await import("@mnemoverse/mcp-memory-server");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "reference-runner", version: "0.0.0" });
await client.connect(clientTransport);

const { tools } = await client.listTools();
const results = [];
for (const c of scenario.cases) {
  current = fixtureFetch(c.routes, { baseUrl });
  const result = await client.callTool({ name: c.tool, arguments: c.args });
  results.push({ result, requests: current.calls, unmatched: current.unmatched });
}
await client.close();
process.stdout.write(JSON.stringify({ tools, instructions: client.getInstructions(), results }));
