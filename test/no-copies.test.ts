/**
 * The consumer rule, checked mechanically: no description, schema text,
 * annotation title, instruction or refusal sentence of the package is restated
 * anywhere in this package's source. Every 40-character window of every such
 * string (whitespace-normalised, starting at a word) is looked for in src/;
 * tool names alone do not count.
 */
import * as teaching from "@mnemoverse/mcp-memory-server/dist/teaching.js";
import { refusePlaceholderKey } from "@mnemoverse/mcp-memory-server/dist/requests.js";
import { registerMemoryTools, SERVER_INSTRUCTIONS } from "@mnemoverse/mcp-memory-server/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WINDOW = 40;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function collectStrings(value: unknown, keys: ReadonlySet<string>, out: string[]): void {
  if (Array.isArray(value)) value.forEach((v) => collectStrings(v, keys, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && keys.has(k)) out.push(v);
      else collectStrings(v, keys, out);
    }
  }
}

async function surfaceStrings(): Promise<string[]> {
  const server = new McpServer({ name: "probe", version: "0" });
  registerMemoryTools(server, { apiFetch: async () => ({}) as never });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "probe", version: "0" });
  await client.connect(a);
  const { tools } = await client.listTools();
  await client.close();
  const out: string[] = [SERVER_INSTRUCTIONS];
  collectStrings(tools, new Set(["description", "title"]), out);
  for (const v of Object.values(teaching)) if (typeof v === "string") out.push(v);
  const placeholder = refusePlaceholderKey("mk_live_YOUR_KEY")!;
  out.push(placeholder.toolCall, placeholder.startupLog);
  out.push(...packageLiterals());
  return out.map(norm).filter((s) => s.length >= WINDOW);
}

/**
 * Every double-quoted string literal of 40+ characters in the package's built
 * JavaScript, including the module-private texts (the stdio entry's own
 * refusals, the error explanations) that no export reaches.
 */
function packageLiterals(): string[] {
  const require = createRequire(import.meta.url);
  const dist = dirname(require.resolve("@mnemoverse/mcp-memory-server/shared"));
  const out: string[] = [];
  for (const file of readdirSync(dist).filter((f) => f.endsWith(".js"))) {
    const code = readFileSync(join(dist, file), "utf8");
    for (const m of code.matchAll(/"((?:[^"\\\n]|\\.){40,})"/g)) {
      try {
        out.push(JSON.parse(`"${m[1]}"`) as string);
      } catch {
        // not a JSON-compatible literal; skip
      }
    }
  }
  return out;
}

function sourceText(): string {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(dir, { recursive: true }) as string[];
  return norm(
    files
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n"),
  );
}

describe("no copies of the package's text", () => {
  it("src/ restates none of it", async () => {
    const strings = await surfaceStrings();
    expect(strings.length).toBeGreaterThan(50);
    const src = sourceText();
    const copied: string[] = [];
    for (const s of strings) {
      for (let i = 0; i + WINDOW <= s.length; i++) {
        if (i > 0 && s[i - 1] !== " ") continue;
        const window = s.slice(i, i + WINDOW);
        // Tool NAMES are shared vocabulary (the policy table is keyed by them);
        // a window that is mostly a list of names is not prose.
        if (window.replace(/\b(memory|vault)_\w*/g, "").replace(/[^A-Za-z]/g, "").length < 24) continue;
        if (src.includes(window)) {
          copied.push(window);
          break;
        }
      }
    }
    expect(copied).toEqual([]);
  });

  it("the check reaches module-private text too (what the superseded capture-and-convert attempt copied)", async () => {
    const strings = await surfaceStrings();
    // A fragment of the stdio entry's own missing-key sentence, private to its src/index.ts.
    expect(strings.some((s) => s.includes("no API key is configured, so this tool cannot run."))).toBe(true);
  });
});
