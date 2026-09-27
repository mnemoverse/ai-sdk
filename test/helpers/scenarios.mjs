/**
 * Behavioural fixtures shared by both contract tests: one tool call each, with
 * the API responses it will meet. Every scenario runs through the MCP server
 * AND through this package, and the two answers must be identical.
 *
 * Covers success for every tool, the empty-store path (which makes extra
 * probe requests), handler refusals, and every error class the request layer
 * can raise: ApiError (401, 404 bare, 429 with Retry-After, 500), NetworkError,
 * UnreadableBodyError (HTML 200, body stream failure) and the 204 → {} rule.
 */

const item = {
  atom_id: "mem_01",
  content: "User prefers dark mode in every editor",
  relevance: 0.91,
  concepts: ["ui", "preferences"],
  domain: "general",
  created_at: "2026-09-20T10:00:00Z",
};

const room = {
  room_id: "room_01ABC",
  name: "Team notes",
  address: "xroom:room_01ABC",
  role: "owner",
  scope: "read_write",
  archived: false,
};

/** @type {Array<{ id: string, tool: string, args: Record<string, unknown>, routes: Record<string, unknown> }>} */
export const SCENARIOS = [
  {
    id: "write stored",
    tool: "memory_write",
    args: { content: "User prefers dark mode in every editor", concepts: ["ui"] },
    routes: { "POST /memory/write": { json: { stored: true, atom_id: "mem_01", importance: 0.42 } } },
  },
  {
    id: "write filtered by the importance gate",
    tool: "memory_write",
    args: { content: "ok", domain: "project:acme" },
    routes: {
      "POST /memory/write": {
        json: { stored: false, atom_id: null, importance: 0.03, reason: "Below importance threshold (0.03 < 0.1)" },
      },
    },
  },
  {
    id: "write answered with an unrecognised shape",
    tool: "memory_write",
    args: { content: "User uses pnpm" },
    routes: { "POST /memory/write": { json: { ok: true } } },
  },
  {
    id: "write answered 204",
    tool: "memory_write",
    args: { content: "User uses pnpm" },
    routes: { "POST /memory/write": { status: 204 } },
  },
  {
    id: "write rate limited (429 + Retry-After)",
    tool: "memory_write",
    args: { content: "User uses pnpm" },
    routes: {
      "POST /memory/write": {
        status: 429,
        headers: { "retry-after": "7" },
        json: { error: { code: "rate_limited", message: "Too many requests" } },
      },
    },
  },
  {
    id: "read hit",
    tool: "memory_read",
    args: { query: "editor theme", top_k: 3 },
    routes: { "POST /memory/read": { json: { items: [item], search_time_ms: 12 } } },
  },
  {
    id: "read on an empty store (probes stats and rooms)",
    tool: "memory_read",
    args: { query: "anything at all" },
    routes: {
      "POST /memory/read": { json: { items: [] } },
      "GET /memory/stats": { json: { total_atoms: 0, domains: [] } },
      "GET /memory/rooms": { json: [] },
    },
  },
  {
    id: "read scoped to a domain that only exists in another case",
    tool: "memory_read",
    args: { query: "deploy target", domain: "project:acme" },
    routes: {
      "POST /memory/read": { json: { items: [] } },
      "GET /memory/stats": { json: { total_atoms: 4, domains: ["general", "Project:Acme"] } },
      "GET /memory/rooms": { json: [room] },
    },
  },
  {
    id: "read with filters and nothing new",
    tool: "memory_read",
    args: { query: "news", since: "2026-09-01T00:00:00Z" },
    routes: {
      "POST /memory/read": { json: { items: [] } },
      "GET /memory/rooms": { json: [room] },
    },
  },
  {
    id: "read rejected 401",
    tool: "memory_read",
    args: { query: "editor theme" },
    routes: { "POST /memory/read": { status: 401, json: { detail: "Invalid API key" } } },
  },
  {
    id: "read failed 500",
    tool: "memory_read",
    args: { query: "editor theme" },
    routes: { "POST /memory/read": { status: 500, text: "Internal Server Error" } },
  },
  {
    id: "read network failure",
    tool: "memory_read",
    args: { query: "editor theme" },
    routes: { "POST /memory/read": { reject: "getaddrinfo ENOTFOUND core.mnemoverse.com" } },
  },
  {
    id: "read answered by a captive portal (HTML 200)",
    tool: "memory_read",
    args: { query: "editor theme" },
    routes: {
      "POST /memory/read": {
        text: "<html><title>Sign in to Hotel WiFi</title></html>",
        headers: { "content-type": "text/html" },
      },
    },
  },
  {
    id: "read 502 whose body stream dies",
    tool: "memory_read",
    args: { query: "editor theme" },
    routes: { "POST /memory/read": { status: 502, bodyError: "terminated" } },
  },
  {
    id: "list recent page",
    tool: "memory_list_recent",
    args: { limit: 2 },
    routes: {
      "POST /memory/recent": {
        json: { items: [item, { ...item, atom_id: "mem_02", content: "Deploys go to Railway" }], next_cursor: null },
      },
    },
  },
  {
    id: "list recent on an engine without the endpoint (bare 404)",
    tool: "memory_list_recent",
    args: {},
    routes: { "POST /memory/recent": { status: 404, json: { detail: "Not Found" } } },
  },
  {
    id: "feedback applied",
    tool: "memory_feedback",
    args: { memory_ids: ["mem_01"], outcome: 1 },
    routes: {
      "POST /memory/feedback": { json: { updated_count: 1, avg_valence: 0.6, coactivation_edges: 0 } },
    },
  },
  {
    id: "feedback with only the removed atom_ids (refused without a request, 0.13)",
    tool: "memory_feedback",
    args: { atom_ids: ["mem_01"], outcome: 1 },
    routes: {},
  },
  {
    id: "feedback with the removed atom_ids next to memory_ids (ignored, 0.13)",
    tool: "memory_feedback",
    args: { memory_ids: ["mem_01"], atom_ids: ["mem_02"], outcome: 1 },
    routes: {
      "POST /memory/feedback": { json: { updated_count: 1, avg_valence: 0.6, coactivation_edges: 0 } },
    },
  },
  {
    id: "feedback acknowledged with 204 (unknown count)",
    tool: "memory_feedback",
    args: { memory_ids: ["mem_01"], outcome: -1, domain: "xroom:room_01ABC" },
    routes: { "POST /memory/feedback": { status: 204 } },
  },
  {
    id: "graph around two seeds",
    tool: "memory_graph",
    args: { seeds: ["deploy", "staging"] },
    routes: {
      "POST /memory/graph": {
        json: {
          nodes: [
            { concept: "deploy", degree: 1 },
            { concept: "staging", degree: 1 },
          ],
          edges: [
            { source: "deploy", target: "staging", weight: 0.6, valence: 0.2, count: 3, updated_at: "2026-09-27T10:00:00Z" },
          ],
          truncated: false,
          min_weight_applied: 0,
        },
      },
    },
  },
  {
    id: "graph of a shared room, depth 2, truncated",
    tool: "memory_graph",
    args: { seeds: ["deploy"], depth: 2, domain: "xroom:room_01ABC", limit: 1 },
    routes: {
      "POST /memory/graph": {
        json: {
          nodes: [
            { concept: "deploy", degree: 1 },
            { concept: "rollback", degree: 1 },
          ],
          edges: [
            { source: "deploy", target: "rollback", weight: 0.4, valence: -0.1, count: 2, updated_at: "2026-09-26T08:00:00Z" },
          ],
          truncated: true,
          min_weight_applied: 0.05,
        },
      },
    },
  },
  {
    id: "stats",
    tool: "memory_stats",
    args: {},
    routes: {
      "GET /memory/stats": {
        json: {
          total_atoms: 12,
          episodes: 3,
          prototypes: 1,
          hebbian_edges: 40,
          domains: ["general", "project:acme"],
          avg_valence: 0.1,
          avg_importance: 0.4,
        },
      },
    },
  },
  {
    id: "list rooms",
    tool: "memory_list_rooms",
    args: {},
    routes: { "GET /memory/rooms": { json: [room] } },
  },
  {
    id: "vault list",
    tool: "vault_list",
    args: {},
    routes: {
      "GET /vault/secrets": {
        json: { secrets: [{ alias: "github", context: "CI token", created_at: "2026-09-01T00:00:00Z", concepts: ["ci"] }] },
      },
    },
  },
  {
    id: "create room",
    tool: "memory_create_room",
    args: { name: "Team notes", description: "Shared decisions" },
    routes: { "POST /memory/rooms": { json: { room_id: "room_01ABC", address: "xroom:room_01ABC", name: "Team notes" } } },
  },
  {
    id: "invite to room",
    tool: "memory_invite_to_room",
    args: { room_id: "room_01ABC", scope: "read" },
    routes: {
      "POST /memory/rooms/room_01ABC/invites": {
        json: { share_message: "Join Team notes", join_url: "https://mnemoverse.com/join/ABC123", code: "ABC123" },
      },
    },
  },
  {
    id: "join room",
    tool: "memory_join_room",
    args: { code: "ABC123" },
    routes: {
      "POST /memory/rooms/join": {
        json: { address: "xroom:room_01ABC", name: "Team notes", scope: "read", already_member: false },
      },
    },
  },
];
