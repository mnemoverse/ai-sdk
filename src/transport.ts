/**
 * The custom transport handed to the Vercel AI SDK's MCP client.
 *
 * It wraps the client end of `InMemoryTransport.createLinkedPair()` from
 * @modelcontextprotocol/sdk, whose other end is connected to an in-process
 * `McpServer` carrying the package's `registerMemoryTools`. No network hop, no
 * second process: the AI SDK client speaks JSON-RPC to the package's server
 * exactly as it would over stdio or HTTP.
 *
 * Two things happen on the way through, and nothing else:
 *
 *   1. Every message is serialised and parsed (JSON round trip), in both
 *      directions, so what each side receives is exactly what a wire would
 *      deliver, and no object is shared between the server, the client and
 *      the caller.
 *   2. The tool policy (src/policy.ts) is enforced at this single choke point:
 *      a `tools/list` answer is FILTERED to the exposed names (entries are
 *      dropped, never edited), a `tools/call` for any other name is answered
 *      with a JSON-RPC error without reaching the server, and under a pinned
 *      domain the call's `domain` argument is replaced by the pin before the
 *      server sees it.
 *
 * The shape is the AI SDK's `MCPTransport` (start, send, close, onmessage,
 * onclose, onerror), which is the same in @ai-sdk/mcp 0.x (ai 5), 1.x (ai 6)
 * and 2.x (ai 7).
 */
import type { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { scopedByPin, TOOL_CLASSES, type MemoryToolName } from "./policy.js";

/** JSON-RPC "Invalid params", the code MCP servers use for an unknown tool. */
const INVALID_PARAMS = -32602;

export interface TransportPolicy {
  /** Tool names the client may list and call. */
  exposed: ReadonlySet<MemoryToolName>;
  /** The pinned domain, or undefined. */
  domain: string | undefined;
}

type Json = Record<string, unknown>;

/** What the transport learned from the server's `tools/list` answers. */
export interface ObservedTool {
  name: string;
  inputSchema: Json;
}

export class MnemoverseTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  /** Every tool the SERVER listed, before filtering: for the surface checks. */
  readonly observed = new Map<string, ObservedTool>();

  private readonly listRequests = new Set<string | number>();
  private closed = false;
  private closeReported = false;

  constructor(
    private readonly inner: InMemoryTransport,
    private readonly policy: TransportPolicy,
  ) {}

  async start(): Promise<void> {
    this.inner.onmessage = (message) => this.receive(message);
    this.inner.onerror = (error) => this.onerror?.(error);
    // InMemoryTransport reports its own close twice (once through the linked
    // end); the client hears it once.
    this.inner.onclose = () => {
      this.closed = true;
      if (this.closeReported) return;
      this.closeReported = true;
      this.onclose?.();
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const outbound = roundTrip(message) as Json;
    if (outbound.method === "tools/list" && "id" in outbound) {
      this.listRequests.add(outbound.id as string | number);
    }
    if (outbound.method === "tools/call") {
      const params = (outbound.params ?? {}) as Json;
      const name = params.name;
      if (typeof name !== "string" || !this.policy.exposed.has(name as MemoryToolName)) {
        // Not in the set: never forwarded. A request gets an error answer; a
        // (malformed) notification is dropped.
        if (!("id" in outbound)) return;
        const reply = {
          jsonrpc: "2.0",
          id: outbound.id,
          error: {
            code: INVALID_PARAMS,
            message: `Tool ${JSON.stringify(name)} is not in this Mnemoverse tool set.`,
          },
        } as JSONRPCMessage;
        // Asynchronously, as a real transport would answer.
        queueMicrotask(() => this.onmessage?.(reply));
        return;
      }
      if (this.policy.domain !== undefined && scopedByPin(TOOL_CLASSES[name as MemoryToolName], this.policy.domain)) {
        const args = isObject(params.arguments) ? params.arguments : {};
        outbound.params = { ...params, arguments: { ...args, domain: this.policy.domain } };
      }
    }
    await this.inner.send(outbound as JSONRPCMessage);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.inner.close();
  }

  private receive(message: JSONRPCMessage): void {
    const inbound = roundTrip(message) as Json;
    const id = inbound.id as string | number | undefined;
    const answersList = id !== undefined && !("method" in inbound) && this.listRequests.delete(id);
    if (answersList && isObject(inbound.result)) {
      const result = inbound.result;
      const tools = Array.isArray(result.tools) ? (result.tools as Json[]) : [];
      for (const tool of tools) {
        if (typeof tool.name === "string") {
          this.observed.set(tool.name, {
            name: tool.name,
            inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : {},
          });
        }
      }
      result.tools = tools.filter(
        (tool) => typeof tool.name === "string" && this.policy.exposed.has(tool.name as MemoryToolName),
      );
    }
    this.onmessage?.(inbound as JSONRPCMessage);
  }
}

function roundTrip(message: unknown): unknown {
  return JSON.parse(JSON.stringify(message));
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
