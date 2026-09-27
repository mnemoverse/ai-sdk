/**
 * The custom transport: JSON round trip in both directions, and the policy
 * enforced at the one choke point every message passes.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { MnemoverseTransport } from "../src/transport.js";
import type { MemoryToolName } from "../src/policy.js";

function pair(exposed: MemoryToolName[], domain?: string) {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const transport = new MnemoverseTransport(clientEnd, { exposed: new Set(exposed), domain });
  // Loosely typed on purpose: the tests read whatever arrived.
  const atServer: Array<Record<string, any>> = [];
  const atClient: Array<Record<string, any>> = [];
  serverEnd.onmessage = (m) => atServer.push(m);
  transport.onmessage = (m) => atClient.push(m);
  return { transport, serverEnd, atServer, atClient };
}

const call = (id: number, name: string, args: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) as JSONRPCMessage;

describe("MnemoverseTransport", () => {
  it("replaces the model's domain with the pin on domain tools, and leaves other arguments alone", async () => {
    const { transport, serverEnd, atServer } = pair(["memory_read"], "user:alice");
    await serverEnd.start();
    await transport.start();
    await transport.send(call(1, "memory_read", { query: "q", domain: "user:bob", top_k: 3 }));
    await transport.send(call(2, "memory_read", { query: "q" }));
    expect(atServer[0]!.params).toEqual({
      name: "memory_read",
      arguments: { query: "q", domain: "user:alice", top_k: 3 },
    });
    expect(atServer[1]!.params.arguments).toEqual({ query: "q", domain: "user:alice" });
  });

  it("memory_feedback's domain is replaced only by an xroom: pin, the only kind that scopes it", async () => {
    const room = pair(["memory_feedback"], "xroom:room_01ABC");
    await room.serverEnd.start();
    await room.transport.start();
    await room.transport.send(call(1, "memory_feedback", { memory_ids: ["m1"], outcome: 1, domain: "user:bob" }));
    expect(room.atServer[0]!.params.arguments.domain).toBe("xroom:room_01ABC");
    // createMnemoverseTools never exposes it under another pin; if a transport
    // were built that way anyway, it still does not pretend the pin scopes it.
    const own = pair(["memory_feedback"], "user:alice");
    await own.serverEnd.start();
    await own.transport.start();
    await own.transport.send(call(2, "memory_feedback", { memory_ids: ["m1"], outcome: 1 }));
    expect(own.atServer[0]!.params.arguments).toEqual({ memory_ids: ["m1"], outcome: 1 });
  });

  it("without a pin, arguments pass unchanged", async () => {
    const { transport, serverEnd, atServer } = pair(["memory_read"]);
    await serverEnd.start();
    await transport.start();
    await transport.send(call(1, "memory_read", { query: "q", domain: "user:bob" }));
    expect(atServer[0]!.params.arguments).toEqual({ query: "q", domain: "user:bob" });
  });

  it("a call to a tool outside the set never reaches the server and gets a JSON-RPC error", async () => {
    const { transport, serverEnd, atServer, atClient } = pair(["memory_read"]);
    await serverEnd.start();
    await transport.start();
    await transport.send(call(7, "memory_stats", {}));
    await transport.send(call(8, "not_a_tool", {}));
    await transport.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "memory_stats" } } as JSONRPCMessage);
    await new Promise((r) => setTimeout(r, 0));
    expect(atServer).toEqual([]);
    expect(atClient).toMatchObject([
      { id: 7, error: { code: -32602 } },
      { id: 8, error: { code: -32602 } },
    ]);
  });

  it("filters the server's tools/list answer to the exposed set, and records what the server listed", async () => {
    const { transport, serverEnd, atClient } = pair(["memory_read"]);
    await serverEnd.start();
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} } as JSONRPCMessage);
    const listed = [
      { name: "memory_read", description: "d1", inputSchema: { type: "object", properties: { domain: {} } } },
      { name: "memory_stats", description: "d2", inputSchema: { type: "object" } },
      { name: "brand_new_tool", description: "d3", inputSchema: { type: "object" } },
    ];
    await serverEnd.send({ jsonrpc: "2.0", id: 3, result: { tools: listed } } as JSONRPCMessage);
    expect(atClient[0]!.result.tools).toEqual([listed[0]]);
    expect([...transport.observed.keys()]).toEqual(["memory_read", "memory_stats", "brand_new_tool"]);
  });

  it("only answers to tools/list requests are filtered", async () => {
    const { transport, serverEnd, atClient } = pair(["memory_read"]);
    await serverEnd.start();
    await transport.start();
    const other = { jsonrpc: "2.0", id: 9, result: { tools: [{ name: "memory_stats" }] } } as JSONRPCMessage;
    await serverEnd.send(other);
    expect(atClient).toEqual([other]);
  });

  it("messages are serialised, not shared: mutating one side's copy changes nothing on the other", async () => {
    const { transport, serverEnd, atServer } = pair(["memory_read"]);
    await serverEnd.start();
    await transport.start();
    const message = call(1, "memory_read", { query: "q" }) as Record<string, any>;
    await transport.send(message as JSONRPCMessage);
    message.params.arguments.query = "changed later";
    expect(atServer[0]!.params.arguments.query).toBe("q");
  });

  it("close() closes both ends and reports it once", async () => {
    const { transport, serverEnd } = pair(["memory_read"]);
    let serverClosed = 0;
    let clientClosed = 0;
    serverEnd.onclose = () => serverClosed++;
    transport.onclose = () => clientClosed++;
    await serverEnd.start();
    await transport.start();
    await transport.close();
    await transport.close();
    expect(serverClosed).toBe(1);
    expect(clientClosed).toBe(1);
  });
});
