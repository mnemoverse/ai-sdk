/**
 * createMnemoverseTools: the Mnemoverse MCP surface as Vercel AI SDK tools.
 *
 * Architecture (no copies, no conversion):
 *
 *   @mnemoverse/mcp-memory-server/shared      @ai-sdk/mcp (the AI SDK's own
 *   registerMemoryTools(server, {apiFetch})    MCP client, per ai major)
 *              │                                        ▲
 *        new McpServer ◄── InMemoryTransport pair ──► MnemoverseTransport
 *        (in process)       (JSON round trip,           (custom transport:
 *                            no network hop)             policy + domain pin)
 *
 * The package's server runs in this process. The AI SDK's MCP client connects
 * to it over a linked in-memory transport pair and builds the AI SDK tools
 * from the server's own `tools/list`, so every description, input schema,
 * title and annotation the model sees is the package's, and every result is
 * what the package's handler returned, through the same MCP SDK server code
 * that answers over stdio. The only thing this package supplies to that
 * surface is `apiFetch`, bound to one API key.
 */
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { registerMemoryTools, SERVER_INSTRUCTIONS } from "@mnemoverse/mcp-memory-server/shared";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolSet } from "ai";
import { createApiFetch, type HeadersOption } from "./api-fetch.js";
import { needsApprovalFor, resolveRoomApproval } from "./approval.js";
import { installedAiVersions, refuseAiPair } from "./compat.js";
import { MnemoverseConfigError, MnemoverseSurfaceError } from "./errors.js";
import { checkSchemaFidelity, recordInputSchemas } from "./fidelity.js";
import { createToModelOutput } from "./model-output.js";
import { resolveDomain, selectTools, type MemoryToolName, type ToolsOption } from "./policy.js";
import { DEFAULT_BASE_URL } from "./refusals.js";
import { MnemoverseTransport, type ObservedTool } from "./transport.js";
import { SURFACE_VERSION, VERSION } from "./version.js";

export interface MnemoverseToolsOptions {
  /**
   * Mnemoverse API key (`mk_live_…`), the identity every request is made as.
   * Only when this property is ABSENT is `process.env.MNEMOVERSE_API_KEY`
   * used, read when the factory runs, never at import. A present `apiKey` is
   * never replaced by the environment, even when it is `undefined` or `""`:
   * a per-user key lookup that misses rejects with `missing_key` instead of
   * silently running on a shared server key.
   */
  apiKey?: string;
  /**
   * API base URL. Defaults to `process.env.MNEMOVERSE_API_URL`, then
   * `https://core.mnemoverse.com/api/v1`. Must be https, except for
   * http://localhost, http://127.0.0.1 and http://[::1].
   */
  baseUrl?: string;
  /**
   * Pin every domain-scoped tool to this domain (or `xroom:` room address).
   * The domain the model sends is replaced by the pin before the call reaches
   * the handler. Under a pin, 'all' leaves out the account-wide tools
   * (memory_stats, memory_list_rooms, vault_list) and naming one throws, as
   * does naming a room-changing tool. memory_feedback and memory_graph are
   * kept only under an `xroom:` pin; under any other pin they are left out and
   * naming one throws. A
   * pin scopes what the model reads and writes; it is NOT an access boundary:
   * give each end user their own key.
   */
  domain?: string;
  /**
   * Which tools to expose. 'all' (the default) is every tool except the
   * room-changing ones (memory_create_room, memory_invite_to_room,
   * memory_join_room), which are exposed only when named here; under a pinned
   * domain, 'all' is memory_write, memory_read and memory_list_recent, plus
   * memory_feedback and memory_graph when the pin is an `xroom:` address.
   */
  tools?: ToolsOption;
  /** `fetch` implementation. Defaults to `globalThis.fetch`, looked up per request. */
  fetch?: typeof globalThis.fetch;
  /**
   * Timeout per HTTP request, in milliseconds (default 10 000): a whole number
   * from 1 to 2147483647 (about 24.8 days, the longest a timer can wait).
   */
  timeoutMs?: number;
  /**
   * Extra headers for every request. `X-Api-Key` and `Authorization`, in any
   * letter case, are dropped: the credential is always `apiKey`.
   */
  headers?: HeadersOption;
  /**
   * Allow creating the tools in a browser, where the API key is readable by
   * anyone using the page. Only for a key that belongs to that one user.
   */
  dangerouslyAllowBrowser?: boolean;
  /**
   * ai 6 and 7: set `needsApproval` on the calls that act on a shared room,
   * whose content other members write (default `true`): memory_write into an
   * `xroom:` address, and the room-changing tools. `false` turns it off. ai 5
   * has no tool approval, so nothing is set there and `true` is refused.
   */
  roomApproval?: boolean;
}

export interface MnemoverseTools {
  /**
   * The tools, for `generateText`, `streamText` or an agent. Built by the AI
   * SDK's MCP client from the package's `tools/list`. Each tool's `execute`
   * resolves with the MCP `CallToolResult`: `{ content, structuredContent?,
   * isError }`. The model reads the text (see src/model-output.ts). On ai 6
   * and 7, the calls that act on a shared room carry `needsApproval` unless
   * `roomApproval: false` (src/approval.ts).
   */
  tools: ToolSet;
  /**
   * Shut the MCP client and the in-process server (both transport ends).
   * Idempotent. After it, calling a tool rejects.
   */
  close(): Promise<void>;
  /** The @mnemoverse/mcp-memory-server version whose surface these tools expose. */
  surfaceVersion: string;
  /** This package's own version. */
  version: string;
}

/**
 * Create the Mnemoverse memory tools. Rejects with MnemoverseConfigError for
 * options (or an ai / @ai-sdk/mcp pair) that can never work, before any
 * request is sent, and with MnemoverseSurfaceError when the tool schemas the
 * model would see are not the package's (a zod the package's schemas do not
 * support, see src/fidelity.ts). Creating the tools sends nothing to the API.
 */
export async function createMnemoverseTools(options: MnemoverseToolsOptions = {}): Promise<MnemoverseTools> {
  if (typeof options !== "object" || options === null) {
    throw new MnemoverseConfigError("invalid_option", "Options must be an object.");
  }
  if (isBrowser() && options.dangerouslyAllowBrowser !== true) {
    throw new MnemoverseConfigError(
      "browser_runtime",
      "createMnemoverseTools() is running in a browser (a page or a Web Worker), where the Mnemoverse API " +
        "key would be readable by anyone using the page. Create the tools on your server instead. If the key " +
        "belongs to the person using this page and nobody else, pass dangerouslyAllowBrowser: true.",
    );
  }

  // Before anything is built: an ai / @ai-sdk/mcp pair outside the test
  // matrix would make every tool call fail inside the AI SDK (src/compat.ts).
  const installed = installedAiVersions();
  const aiMajor = refuseAiPair(installed.ai, installed.mcpClient);
  const approval = resolveRoomApproval(options.roomApproval, aiMajor);

  const env = readEnv();
  const apiKey = Object.prototype.hasOwnProperty.call(options, "apiKey")
    ? options.apiKey
    : env.MNEMOVERSE_API_KEY;
  const baseUrl = options.baseUrl !== undefined ? options.baseUrl : env.MNEMOVERSE_API_URL || DEFAULT_BASE_URL;
  const domain = resolveDomain(options);
  const exposed = selectTools(options.tools, domain);
  const apiFetch = createApiFetch({
    apiKey: apiKey as string,
    baseUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    headers: options.headers,
  });

  // One server per identity: the key lives only in this apiFetch closure.
  const server = new McpServer(
    { name: "mnemoverse-memory", version: SURFACE_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  // The package's own zod shapes, recorded on their way to the server, are
  // the reference the listed schemas are checked against (src/fidelity.ts).
  const registered = new Map<string, unknown>();
  registerMemoryTools(recordInputSchemas(server, registered), { apiFetch });

  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const transport = new MnemoverseTransport(clientEnd, { exposed, domain });
  let client: Awaited<ReturnType<typeof experimental_createMCPClient>> | undefined;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        if (client !== undefined) await client.close();
        else await transport.close();
      } finally {
        await server.close();
      }
    })();
    return closing;
  };

  try {
    await server.connect(serverEnd);
    client = await experimental_createMCPClient({
      transport,
      name: "mnemoverse-ai-sdk",
      version: VERSION,
    });
    const mcpTools = (await client.tools()) as Record<string, Record<string, unknown>>;
    checkSchemaFidelity(registered, transport.observed);
    checkSurface(exposed, transport.observed, mcpTools, domain);

    const tools: Record<string, unknown> = {};
    for (const [name, tool] of Object.entries(mcpTools)) {
      if (!exposed.has(name as MemoryToolName)) continue;
      const needsApproval = approval ? needsApprovalFor(name as MemoryToolName, domain) : undefined;
      tools[name] = {
        ...tool,
        execute: stopOnAbort(tool.execute as Execute),
        toModelOutput: createToModelOutput(tool.toModelOutput as ((arg: unknown) => unknown) | undefined),
        ...(needsApproval !== undefined ? { needsApproval } : {}),
      };
    }
    return {
      tools: tools as ToolSet,
      close,
      surfaceVersion: SURFACE_VERSION,
      version: VERSION,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/**
 * The package must still expose what the policy was reviewed against. Every
 * exposed name must have come back from the client; under a pin, each exposed
 * tool must declare a `domain` input (or the pin would scope nothing) and the
 * pin must satisfy that input's own string constraints, read from the
 * package's schema (or every call would fail validation). Runs after
 * checkSchemaFidelity, so the constraints read here are the package's, not
 * what a lossy conversion left of them.
 */
function checkSurface(
  exposed: ReadonlySet<MemoryToolName>,
  observed: ReadonlyMap<string, ObservedTool>,
  mcpTools: Record<string, unknown>,
  domain: string | undefined,
): void {
  for (const name of exposed) {
    if (!(name in mcpTools) || !observed.has(name)) {
      throw new MnemoverseSurfaceError(
        `@mnemoverse/mcp-memory-server ${SURFACE_VERSION} does not register ${name}. Reinstall the exact ` +
          "version this package depends on.",
      );
    }
    if (domain === undefined) continue;
    const properties = (observed.get(name)!.inputSchema.properties ?? {}) as Record<string, unknown>;
    const field = properties.domain as Record<string, unknown> | undefined;
    if (field === undefined || field === null || typeof field !== "object") {
      throw new MnemoverseSurfaceError(
        `${name} has no \`domain\` input in @mnemoverse/mcp-memory-server ${SURFACE_VERSION}, so a pinned ` +
          "domain cannot scope it.",
      );
    }
    const problem = checkString(field, domain);
    if (problem !== undefined) {
      throw new MnemoverseConfigError("invalid_domain", `\`domain\` is not a valid domain for ${name}: ${problem}`);
    }
  }
}

/** The JSON Schema string keywords, applied to the pin. */
function checkString(schema: Record<string, unknown>, value: string): string | undefined {
  const length = [...value].length;
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    return `it is ${length} characters long, and the limit is ${schema.maxLength}.`;
  }
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    return `it is ${length} characters long, and the minimum is ${schema.minLength}.`;
  }
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
    return `it does not match the pattern ${schema.pattern}.`;
  }
  return undefined;
}

type Execute = (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;

/**
 * An aborted tool call stops waiting on every major. @ai-sdk/mcp 1.x and 2.x
 * (ai 6, 7) already reject the pending request when the call's `abortSignal`
 * fires; 0.x (ai 5) only looks at the signal once the server answers, which
 * can be `timeoutMs` later. The rejection here is deferred by one macrotask,
 * so wherever the client handles the abort itself, its own rejection wins and
 * nothing changes.
 */
function stopOnAbort(execute: Execute): Execute {
  return (input, options) => {
    const run = execute(input, options);
    const signal = options?.abortSignal;
    if (signal === undefined) return run;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        timer = setTimeout(() => reject(signal.reason ?? new Error("The tool call was aborted.")), 0);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
        if (timer !== undefined) clearTimeout(timer);
      });
    });
  };
}

function readEnv(): { MNEMOVERSE_API_KEY?: string; MNEMOVERSE_API_URL?: string } {
  const env =
    typeof process !== "undefined" && process !== null && typeof process.env === "object"
      ? process.env
      : undefined;
  return { MNEMOVERSE_API_KEY: env?.MNEMOVERSE_API_KEY, MNEMOVERSE_API_URL: env?.MNEMOVERSE_API_URL };
}

/**
 * A browser page, or a Web Worker (dedicated, shared or service), which has
 * neither `window` nor `document` but has `WorkerGlobalScope` (and
 * `importScripts` in classic workers). A server runtime that implements the
 * Web Worker globals (Deno's workers, for one) names itself in
 * `navigator.userAgent`; every browser's, in a worker too, starts "Mozilla/".
 */
function isBrowser(): boolean {
  const g = globalThis as {
    window?: unknown;
    document?: unknown;
    WorkerGlobalScope?: unknown;
    importScripts?: unknown;
    navigator?: { userAgent?: unknown };
  };
  if (typeof g.window !== "undefined" && typeof g.document !== "undefined") return true;
  const worker = typeof g.WorkerGlobalScope !== "undefined" || typeof g.importScripts === "function";
  if (!worker) return false;
  const userAgent = g.navigator?.userAgent;
  return typeof userAgent !== "string" || userAgent.startsWith("Mozilla/");
}
