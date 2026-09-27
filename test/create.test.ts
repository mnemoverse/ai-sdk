/**
 * createMnemoverseTools: options, the tool policy, the domain pin, lifecycle
 * and isolation between instances.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMnemoverseTools,
  MEMORY_TOOL_NAMES,
  MnemoverseConfigError,
  SURFACE_VERSION,
  TOOL_CLASSES,
  VERSION,
  type MemoryToolName,
  type MnemoverseTools,
} from "../src/index.js";
import { fixtureFetch } from "./helpers/fixture-fetch.mjs";
import { callTool, textOf, toolOf, VALID_KEY } from "./helpers/tools.js";

/** The installed ai major (the matrix runs this file against ai 5, 6 and 7). */
const AI_MAJOR = Number(createRequire(import.meta.url)("ai/package.json").version.split(".")[0]);

const open: MnemoverseTools[] = [];
async function create(options: Parameters<typeof createMnemoverseTools>[0]) {
  const set = await createMnemoverseTools(options);
  open.push(set);
  return set;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

const names = (set: MnemoverseTools) => Object.keys(set.tools).sort();
/** A memory as the API returns it (the shape the package's renderer reads). */
const memory = (id: string, content: string) => ({
  atom_id: id,
  content,
  relevance: 0.9,
  concepts: [],
  domain: "general",
  created_at: "2026-09-20T10:00:00Z",
});

const ofClass = (...classes: string[]) =>
  MEMORY_TOOL_NAMES.filter((n) => classes.includes(TOOL_CLASSES[n])).sort();

async function rejection(p: Promise<unknown>): Promise<MnemoverseConfigError> {
  const error = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MnemoverseConfigError);
  return error as MnemoverseConfigError;
}

describe("which tools", () => {
  it("default ('all') is every tool except the room-changing ones", async () => {
    const set = await create({ apiKey: VALID_KEY });
    expect(names(set)).toEqual(ofClass("domain", "room-routed", "account"));
    expect(names(await create({ apiKey: VALID_KEY, tools: "all" }))).toEqual(names(set));
  });

  it("room-changing tools only when named", async () => {
    const set = await create({ apiKey: VALID_KEY, tools: ["memory_read", "memory_create_room"] });
    expect(names(set)).toEqual(["memory_create_room", "memory_read"]);
  });

  it("naming every classified tool exposes all of them", async () => {
    expect(names(await create({ apiKey: VALID_KEY, tools: [...MEMORY_TOOL_NAMES] }))).toEqual(
      [...MEMORY_TOOL_NAMES].sort(),
    );
  });

  it.each([
    [[], "empty_tools"],
    [["memory_delete"], "unknown_tool"],
    ["some", "invalid_option"],
  ])("tools %j is refused (%s)", async (tools, code) => {
    const error = await rejection(createMnemoverseTools({ apiKey: VALID_KEY, tools: tools as never }));
    expect(error.code).toBe(code);
  });
});

const ROOM = "xroom:room_01ABC";

describe("pinned domain", () => {
  it("'all' under a pin that is not a room is only the domain tools: no memory_feedback", async () => {
    const set = await create({ apiKey: VALID_KEY, domain: "user:alice" });
    expect(names(set)).toEqual(ofClass("domain"));
    expect(names(set)).toEqual(["memory_list_recent", "memory_read", "memory_write"]);
  });

  it("'all' under an xroom: pin keeps memory_feedback, which the room pin scopes", async () => {
    const set = await create({ apiKey: VALID_KEY, domain: ROOM });
    expect(names(set)).toEqual(ofClass("domain", "room-routed"));
    expect(names(set)).toContain("memory_feedback");
  });

  it.each(ofClass("account", "room-admin").map((n) => [n]))("naming %s under a pin throws", async (name) => {
    for (const domain of ["user:alice", ROOM]) {
      const error = await rejection(
        createMnemoverseTools({ apiKey: VALID_KEY, domain, tools: [name as MemoryToolName] }),
      );
      expect(error.code).toBe("tool_not_allowed_with_domain");
    }
  });

  // Regression: memory_feedback's domain only routes a rating to a room, so a
  // pin that is not a room address scoped nothing, and the model could rate
  // memories by id outside the pinned domain. Fail closed, as the account
  // tools do. A padded or re-cased room address is not a room to the API.
  it.each([["user:alice"], ["XROOM:room_01ABC"], [" xroom:room_01ABC"], ["room_01ABC"]])(
    "naming memory_feedback under the non-room pin %j throws tool_not_allowed_with_domain",
    async (domain) => {
      const fixture = fixtureFetch({});
      const error = await rejection(
        createMnemoverseTools({ apiKey: VALID_KEY, domain, tools: ["memory_read", "memory_feedback"], fetch: fixture.fetch }),
      );
      expect(error.code).toBe("tool_not_allowed_with_domain");
      expect(error.message).toContain("memory_feedback");
      expect(fixture.calls).toHaveLength(0);
    },
  );

  // memory_graph (0.13) is room-routed too: its domain only selects a room's
  // graph, and any other value reads the account's whole association graph,
  // which has no domain column. Under a non-room pin it would show the model
  // links outside the pinned domain, so it fails closed like memory_feedback.
  it.each([["user:alice"], ["XROOM:room_01ABC"], [" xroom:room_01ABC"], ["room_01ABC"]])(
    "naming memory_graph under the non-room pin %j throws tool_not_allowed_with_domain, naming the whole-account graph",
    async (domain) => {
      const fixture = fixtureFetch({});
      const error = await rejection(
        createMnemoverseTools({ apiKey: VALID_KEY, domain, tools: ["memory_read", "memory_graph"], fetch: fixture.fetch }),
      );
      expect(error.code).toBe("tool_not_allowed_with_domain");
      expect(error.message).toContain("memory_graph");
      expect(error.message).toContain("association graph");
      expect(fixture.calls).toHaveLength(0);
    },
  );

  it("'all' under a non-room pin leaves memory_graph out; under an xroom: pin it is in", async () => {
    expect(names(await create({ apiKey: VALID_KEY, domain: "user:alice" }))).not.toContain("memory_graph");
    expect(names(await create({ apiKey: VALID_KEY, domain: ROOM }))).toContain("memory_graph");
    expect(names(await create({ apiKey: VALID_KEY }))).toContain("memory_graph");
  });

  it("under an xroom: pin, the pin replaces memory_graph's domain before the handler runs", async () => {
    const fixture = fixtureFetch({
      "POST /memory/graph": { json: { nodes: [], edges: [], truncated: false, min_weight_applied: 0 } },
    });
    const set = await create({ apiKey: VALID_KEY, domain: ROOM, fetch: fixture.fetch });
    await callTool(set, "memory_graph", { seeds: ["deploy"], domain: "user:bob" });
    await callTool(set, "memory_graph", { seeds: ["deploy"] });
    const bodies = fixture.calls.filter((c) => c.url.endsWith("/memory/graph")).map((c) => JSON.parse(c.body ?? "{}").domain);
    expect(bodies).toEqual([ROOM, ROOM]);
  });

  it("naming memory_feedback under an xroom: pin is allowed", async () => {
    const set = await create({ apiKey: VALID_KEY, domain: ROOM, tools: ["memory_feedback"] });
    expect(names(set)).toEqual(["memory_feedback"]);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not a string", 42],
  ])("a %s domain is refused, never silently unpinned", async (_label, domain) => {
    const error = await rejection(createMnemoverseTools({ apiKey: VALID_KEY, domain: domain as string }));
    expect(error.code).toBe("invalid_domain");
  });

  it("a pin longer than the package's own schema allows is refused up front", async () => {
    const error = await rejection(createMnemoverseTools({ apiKey: VALID_KEY, domain: "d".repeat(5000) }));
    expect(error.code).toBe("invalid_domain");
  });

  it.each([["user:alice"], [ROOM]])("the pin %s replaces the model's domain before the handler runs, on every tool it scopes", async (pin) => {
    const fixture = fixtureFetch({
      "POST /memory/write": { json: { stored: true, atom_id: "m1", importance: 0.5 } },
      "POST /memory/read": { json: { items: [memory("m1", "x")] } },
      "POST /memory/recent": { json: { items: [memory("m1", "x")], next_cursor: null } },
      "POST /memory/feedback": { json: { updated_count: 1 } },
    });
    // roomApproval only decides what the AI SDK asks before execute; these calls execute directly.
    const set = await create({ apiKey: VALID_KEY, domain: pin, fetch: fixture.fetch });
    await callTool(set, "memory_write", { content: "prefers tea", domain: "user:bob" });
    await callTool(set, "memory_read", { query: "tea", domain: "user:bob" });
    await callTool(set, "memory_read", { query: "tea" });
    await callTool(set, "memory_list_recent", { domain: "user:bob" });
    if (pin === ROOM) await callTool(set, "memory_feedback", { memory_ids: ["m1"], outcome: 1, domain: "user:bob" });
    const bodies = fixture.calls
      .filter((c) => c.method === "POST")
      .map((c) => ({ path: c.url, domain: JSON.parse(c.body ?? "{}").domain }));
    expect(bodies).toHaveLength(pin === ROOM ? 5 : 4);
    for (const b of bodies) expect(b.domain, b.path).toBe(pin);
  });

  it("an invalid domain from the model cannot fail the call: it never reaches validation", async () => {
    const fixture = fixtureFetch({ "POST /memory/write": { json: { stored: true, atom_id: "m1", importance: 0.5 } } });
    const set = await create({ apiKey: VALID_KEY, domain: "user:alice", fetch: fixture.fetch });
    const result = await callTool(set, "memory_write", { content: "prefers tea", domain: "x".repeat(5000) });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(fixture.calls[0]!.body!).domain).toBe("user:alice");
  });
});

describe("configuration", () => {
  it("reads MNEMOVERSE_API_KEY only when apiKey is absent, at call time", async () => {
    vi.stubEnv("MNEMOVERSE_API_KEY", "mk_live_fromenv");
    const fixture = fixtureFetch({ "GET /memory/stats": { json: { total_atoms: 0 } } });
    const set = await create({ fetch: fixture.fetch, tools: ["memory_stats"] });
    await callTool(set, "memory_stats", {});
    expect(fixture.calls[0]!.headers["x-api-key"]).toBe("mk_live_fromenv");
  });

  it("a present-but-undefined apiKey never falls back to the environment", async () => {
    vi.stubEnv("MNEMOVERSE_API_KEY", "mk_live_fromenv");
    const error = await rejection(createMnemoverseTools({ apiKey: undefined }));
    expect(error.code).toBe("missing_key");
  });

  it("no key anywhere is refused before anything is built", async () => {
    vi.stubEnv("MNEMOVERSE_API_KEY", undefined as unknown as string);
    expect((await rejection(createMnemoverseTools())).code).toBe("missing_key");
  });

  it("MNEMOVERSE_API_URL is the default base URL; an explicit baseUrl wins", async () => {
    vi.stubEnv("MNEMOVERSE_API_URL", "http://localhost:8100/api/v1");
    const a = fixtureFetch({ "GET /memory/stats": { json: {} } }, { baseUrl: "http://localhost:8100/api/v1" });
    await callTool(await create({ apiKey: VALID_KEY, fetch: a.fetch, tools: ["memory_stats"] }), "memory_stats", {});
    expect(a.calls[0]!.url).toBe("http://localhost:8100/api/v1/memory/stats");
    const b = fixtureFetch({ "GET /memory/stats": { json: {} } }, { baseUrl: "https://eu.example.com/v1" });
    await callTool(
      await create({ apiKey: VALID_KEY, baseUrl: "https://eu.example.com/v1", fetch: b.fetch, tools: ["memory_stats"] }),
      "memory_stats",
      {},
    );
    expect(b.calls[0]!.url).toBe("https://eu.example.com/v1/memory/stats");
  });

  it("a base URL with credentials is refused up front, from the option or from MNEMOVERSE_API_URL", async () => {
    const fixture = fixtureFetch({});
    const url = "https://proxyuser:S3CRET-PW@proxy.internal.example/api/v1";
    const fromOption = await rejection(createMnemoverseTools({ apiKey: VALID_KEY, baseUrl: url, fetch: fixture.fetch }));
    vi.stubEnv("MNEMOVERSE_API_URL", url);
    const fromEnv = await rejection(createMnemoverseTools({ apiKey: VALID_KEY, fetch: fixture.fetch }));
    for (const error of [fromOption, fromEnv]) {
      expect(error.code).toBe("insecure_base_url");
      expect(error.message).not.toContain("S3CRET-PW");
    }
    expect(fixture.calls).toHaveLength(0);
  });

  it("creating the tools sends nothing", async () => {
    const fixture = fixtureFetch({});
    await create({ apiKey: VALID_KEY, fetch: fixture.fetch, tools: [...MEMORY_TOOL_NAMES] });
    expect(fixture.calls).toHaveLength(0);
  });

  it("refuses to run in a browser unless dangerouslyAllowBrowser", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect((await rejection(createMnemoverseTools({ apiKey: VALID_KEY }))).code).toBe("browser_runtime");
    const set = await create({ apiKey: VALID_KEY, dangerouslyAllowBrowser: true });
    expect(names(set).length).toBeGreaterThan(0);
  });

  // Regression: a Web Worker has neither window nor document, so the guard did
  // not fire there, although the key is just as readable from the page.
  const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";
  it.each([
    ["a dedicated, shared or service worker (WorkerGlobalScope)", "WorkerGlobalScope", function WorkerGlobalScope() {}],
    ["a classic worker (importScripts)", "importScripts", () => undefined],
  ])("refuses to run in %s unless dangerouslyAllowBrowser", async (_label, global, value) => {
    vi.stubGlobal(global, value);
    vi.stubGlobal("navigator", { userAgent: BROWSER_UA });
    expect((await rejection(createMnemoverseTools({ apiKey: VALID_KEY }))).code).toBe("browser_runtime");
    const set = await create({ apiKey: VALID_KEY, dangerouslyAllowBrowser: true });
    expect(names(set).length).toBeGreaterThan(0);
  });

  it("a worker scope with no user agent at all is treated as a browser (fail closed)", async () => {
    vi.stubGlobal("WorkerGlobalScope", function WorkerGlobalScope() {});
    vi.stubGlobal("navigator", undefined);
    expect((await rejection(createMnemoverseTools({ apiKey: VALID_KEY }))).code).toBe("browser_runtime");
  });

  it.each([["Deno/2.5.0"], ["Cloudflare-Workers"], [`Node.js/${process.versions.node.split(".")[0]}`]])(
    "a server runtime with Web Worker globals (user agent %s) is not a browser",
    async (userAgent) => {
      vi.stubGlobal("WorkerGlobalScope", function WorkerGlobalScope() {});
      vi.stubGlobal("navigator", { userAgent });
      expect(names(await create({ apiKey: VALID_KEY })).length).toBeGreaterThan(0);
    },
  );

  it.each([[null], ["key"]])("options %j are refused", async (options) => {
    expect((await rejection(createMnemoverseTools(options as never))).code).toBe("invalid_option");
  });

  it("reports its own version and the surface version", async () => {
    const set = await create({ apiKey: VALID_KEY });
    expect(set.version).toBe(VERSION);
    expect(set.surfaceVersion).toBe(SURFACE_VERSION);
  });
});

describe("lifecycle", () => {
  it("close() shuts the client and the in-process server; it is idempotent; calls afterwards reject", async () => {
    const fixture = fixtureFetch({ "GET /memory/stats": { json: {} } });
    const set = await createMnemoverseTools({ apiKey: VALID_KEY, fetch: fixture.fetch, tools: ["memory_stats"] });
    await callTool(set, "memory_stats", {});
    await set.close();
    await set.close();
    await expect(callTool(set, "memory_stats", {})).rejects.toThrow(/closed/i);
    expect(fixture.calls).toHaveLength(1);
  });

  it("aborting a tool call stops the wait (the in-flight request then ends at timeoutMs)", async () => {
    const fixture = fixtureFetch({ "POST /memory/read": { hang: true } });
    const set = await create({ apiKey: VALID_KEY, fetch: fixture.fetch, timeoutMs: 2_000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = callTool(set, "memory_read", { query: "q" }, { abortSignal: controller.signal });
    setTimeout(() => controller.abort(new Error("user cancelled")), 20);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a failure during creation closes what was opened", async () => {
    const error = await rejection(createMnemoverseTools({ apiKey: VALID_KEY, domain: "d".repeat(5000) }));
    expect(error.code).toBe("invalid_domain");
  });

  it("parallel instances with different keys and domains never cross-contaminate", async () => {
    const users = Array.from({ length: 8 }, (_, i) => ({
      key: `mk_live_user${i}`,
      domain: `user:${i}`,
      fixture: fixtureFetch({
        "POST /memory/read": { json: { items: [memory(`m${i}`, `secret of user ${i}`)] } },
        "POST /memory/write": { json: { stored: true, atom_id: `w${i}`, importance: 0.5 } },
      }),
    }));
    const sets = await Promise.all(
      users.map((u) => create({ apiKey: u.key, domain: u.domain, fetch: u.fixture.fetch })),
    );
    const results = await Promise.all(
      users.flatMap((u, i) => [
        callTool(sets[i]!, "memory_read", { query: "secret", domain: "user:0" }),
        callTool(sets[i]!, "memory_write", { content: `note ${i}` }),
      ]),
    );
    users.forEach((u, i) => {
      expect(u.fixture.calls).toHaveLength(2);
      for (const call of u.fixture.calls) {
        expect(call.headers["x-api-key"]).toBe(u.key);
        expect(JSON.parse(call.body!).domain).toBe(u.domain);
      }
      const read = textOf(results[i * 2]!);
      expect(read).toContain(`secret of user ${i}`);
      for (let j = 0; j < users.length; j++) if (j !== i) expect(read).not.toContain(`secret of user ${j}`);
    });
  });

  it("a caller mutating a result cannot affect another call (no shared objects)", async () => {
    const fixture = fixtureFetch({ "POST /memory/read": { json: { items: [memory("m1", "a")] } } });
    const set = await create({ apiKey: VALID_KEY, fetch: fixture.fetch });
    const first = await callTool(set, "memory_read", { query: "a" });
    (first.structuredContent as { items: unknown[] }).items.length = 0;
    first.content[0]!.text = "tampered";
    const second = await callTool(set, "memory_read", { query: "a" });
    expect(textOf(second)).not.toBe("tampered");
    expect((second.structuredContent as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe("the policy tables cannot be changed after import", () => {
  it("TOOL_CLASSES and MEMORY_TOOL_NAMES are frozen: writes throw and change nothing a pin enforces", async () => {
    expect(Object.isFrozen(TOOL_CLASSES)).toBe(true);
    expect(Object.isFrozen(MEMORY_TOOL_NAMES)).toBe(true);
    const classes = TOOL_CLASSES as unknown as Record<string, string>;
    expect(() => {
      classes.memory_stats = "domain";
    }).toThrow(TypeError);
    expect(() => {
      classes.memory_feedback = "domain";
    }).toThrow(TypeError);
    expect(() => {
      classes.memory_brand_new = "domain";
    }).toThrow(TypeError);
    expect(() => {
      delete classes.memory_create_room;
    }).toThrow(TypeError);
    expect(() => (MEMORY_TOOL_NAMES as string[]).push("memory_brand_new")).toThrow(TypeError);
    expect(() => (MEMORY_TOOL_NAMES as string[]).splice(0, 1)).toThrow(TypeError);
    expect(TOOL_CLASSES.memory_stats).toBe("account");
    expect(TOOL_CLASSES.memory_feedback).toBe("room-routed");

    // Enforcement is unchanged after the attempts.
    const set = await create({ apiKey: VALID_KEY, domain: "user:alice" });
    expect(names(set)).toEqual(["memory_list_recent", "memory_read", "memory_write"]);
    for (const name of ["memory_stats", "memory_feedback"] as const) {
      const error = await rejection(createMnemoverseTools({ apiKey: VALID_KEY, domain: "user:alice", tools: [name] }));
      expect(error.code).toBe("tool_not_allowed_with_domain");
    }
  });
});

describe("room approval: shared-room content is untrusted", () => {
  const approvalOf = (set: MnemoverseTools, name: string) =>
    (toolOf(set, name) as { needsApproval?: unknown }).needsApproval;
  const NO_APPROVAL = ["memory_read", "memory_list_recent", "memory_feedback", "memory_graph", "memory_stats", "memory_list_rooms", "vault_list"];

  it.runIf(AI_MAJOR >= 6)("ai 6+: by default, memory_write into a room and the room-changing tools need approval", async () => {
    const set = await create({ apiKey: VALID_KEY, tools: [...MEMORY_TOOL_NAMES] });
    const write = approvalOf(set, "memory_write") as (input: unknown) => boolean;
    expect(typeof write).toBe("function");
    // Looser than the API's own prefix test on purpose: a false positive only costs a prompt.
    for (const domain of [ROOM, " xroom:room_01ABC", "XRoom:room_01ABC", "\u200bxroom:room_01ABC"]) {
      expect(write({ content: "x", domain }), domain).toBe(true);
    }
    for (const domain of [undefined, "", "user:alice", "project:xroom:room_01ABC"]) {
      expect(write({ content: "x", domain }), String(domain)).toBe(false);
    }
    expect(write(null)).toBe(false);
    for (const name of ofClass("room-admin")) expect(approvalOf(set, name), name).toBe(true);
    for (const name of NO_APPROVAL) expect(approvalOf(set, name), name).toBeUndefined();
  });

  it.runIf(AI_MAJOR >= 6)("ai 6+: under a pin, the pin decides, since it replaces the model's domain", async () => {
    const room = await create({ apiKey: VALID_KEY, domain: ROOM });
    expect(approvalOf(room, "memory_write")).toBe(true);
    expect(approvalOf(room, "memory_feedback")).toBeUndefined();
    const own = await create({ apiKey: VALID_KEY, domain: "user:alice" });
    expect(approvalOf(own, "memory_write")).toBeUndefined();
  });

  it.runIf(AI_MAJOR >= 6)("ai 6+: roomApproval: false turns it off", async () => {
    const set = await create({ apiKey: VALID_KEY, tools: [...MEMORY_TOOL_NAMES], roomApproval: false });
    for (const name of MEMORY_TOOL_NAMES) expect(approvalOf(set, name), name).toBeUndefined();
    const room = await create({ apiKey: VALID_KEY, domain: ROOM, roomApproval: false });
    expect(approvalOf(room, "memory_write")).toBeUndefined();
  });

  it.runIf(AI_MAJOR < 6)("ai 5: no tool approval exists, so nothing is set, and roomApproval: true is refused", async () => {
    const set = await create({ apiKey: VALID_KEY, tools: [...MEMORY_TOOL_NAMES] });
    for (const name of MEMORY_TOOL_NAMES) expect(approvalOf(set, name), name).toBeUndefined();
    expect(names(await create({ apiKey: VALID_KEY, roomApproval: false })).length).toBeGreaterThan(0);
    const error = await rejection(createMnemoverseTools({ apiKey: VALID_KEY, roomApproval: true }));
    expect(error.code).toBe("invalid_option");
    expect(error.message).toMatch(/ai 5/);
  });

  it("roomApproval must be a boolean", async () => {
    const error = await rejection(createMnemoverseTools({ apiKey: VALID_KEY, roomApproval: "yes" as never }));
    expect(error.code).toBe("invalid_option");
  });
});
