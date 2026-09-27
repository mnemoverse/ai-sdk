/**
 * Run INSIDE a consumer project that installed the packed @mnemoverse/ai-sdk
 * (scripts/test-matrix.mjs copies it there): creates the tools as an
 * application would, with a mocked fetch, and prints one JSON line saying
 * what happened.
 *
 *   {"outcome":"ok"}                                   the tools work and carry the package's schemas
 *   {"outcome":"surface-error", ...}                   MnemoverseSurfaceError at creation
 *   {"outcome":"config-error:<code>", ...}             MnemoverseConfigError at creation
 *   {"outcome":"broken", ...}                          created, but something the model or caller gets is wrong
 *   {"outcome":"crash", ...}                           anything else
 *
 * Nothing reaches the network: every request goes to the mocked fetch.
 */
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const versionOf = (name) => {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    return null;
  }
};
const versions = { ai: versionOf("ai"), "@ai-sdk/mcp": versionOf("@ai-sdk/mcp"), zod: versionOf("zod") };

function report(outcome, detail) {
  console.log(JSON.stringify({ outcome, detail, versions }));
}

const fetchImpl = async (url) =>
  new Response(
    JSON.stringify(
      String(url).endsWith("/memory/write") ? { stored: true, atom_id: "mem_01", importance: 0.5 } : { items: [] },
    ),
    { headers: { "content-type": "application/json" } },
  );

let mod;
try {
  mod = await import("@mnemoverse/ai-sdk");
} catch (error) {
  report("crash", `import failed: ${error?.message ?? error}`);
  process.exit(0);
}

let set;
try {
  set = await mod.createMnemoverseTools({ apiKey: "mk_live_deadbeef", fetch: fetchImpl });
} catch (error) {
  if (error instanceof mod.MnemoverseSurfaceError) report("surface-error", error.message);
  else if (error instanceof mod.MnemoverseConfigError) report(`config-error:${error.code}`, error.message);
  else report("crash", `${error?.name}: ${error?.message ?? error}`);
  process.exit(0);
}

try {
  const problems = [];
  const js = set.tools.memory_write.inputSchema.jsonSchema;
  const schema = typeof js === "function" ? await js() : await js;
  const content = schema?.properties?.content ?? {};
  if (typeof content.description !== "string" || content.description.length === 0) problems.push("content has no description");
  if (content.minLength !== 1) problems.push("content has no minLength");
  const pin = await mod
    .createMnemoverseTools({ apiKey: "mk_live_deadbeef", domain: "d".repeat(150), tools: ["memory_write"], fetch: fetchImpl })
    .then(
      async (s) => (await s.close(), "accepted"),
      (e) => e?.code ?? e?.name,
    );
  if (pin !== "invalid_domain") problems.push(`a 150-character pin was ${pin}, not invalid_domain`);
  const result = await set.tools.memory_write.execute({ content: "prefers tea" }, { toolCallId: "c1", messages: [] });
  if (result?.isError === true || result?.structuredContent?.memory_id !== "mem_01") {
    problems.push(`memory_write returned ${JSON.stringify(result).slice(0, 200)}`);
  }
  report(problems.length === 0 ? "ok" : "broken", problems.join("; ") || undefined);
} catch (error) {
  report("crash", `${error?.name}: ${error?.message ?? error}`);
} finally {
  await set.close();
}
