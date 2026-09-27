#!/usr/bin/env node
/**
 * The release workflow's gate before anything is packed (.github/workflows/release.yml):
 * is the tagged tree a release of the version it claims?
 *
 *   node scripts/release-check.mjs --tag v0.1.0                       # checks; asks npm for the pinned surface
 *   node scripts/release-check.mjs --tag v0.1.0 --notes notes.md      # also writes the release notes
 *   node scripts/release-check.mjs --tag v0.1.0 --offline             # the file checks only
 *
 * Exit 0: every check passed. Exit 1: the first line of the output says what
 * to fix, and nothing may be published from this tree.
 *
 * Checked, from the files (no network):
 *   1. the tag is vX.Y.Z, and X.Y.Z is package.json's version;
 *   2. CHANGELOG.md has `## [X.Y.Z] - YYYY-MM-DD`, dated: an undated section
 *      is the placeholder for a version that is not released yet, and a
 *      release dates it first (docs/AUTO-UPDATE-CONTOUR.md, release runbook);
 *   3. that section names the surface: `Surface: \`@mnemoverse/mcp-memory-server\` <pin>.`;
 *   4. the pin is an exact x.y.z, and README.md's surface line names it;
 *   5. package.json's repository is this repository (npm trusted publishing
 *      and provenance both require it), and publishConfig says public.
 * And, unless --offline, from the public npm registry: the pinned surface
 * version exists (an application installing this release must get it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SURFACE_PACKAGE = "@mnemoverse/mcp-memory-server";
export const REPOSITORY = "https://github.com/mnemoverse/ai-sdk";
const REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 20_000;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The body of `## [version]` (the text up to the next section or the link list), or undefined. */
export function sectionBody(input, version) {
  const text = input.replace(/\r\n/g, "\n");
  const m = new RegExp(`^## \\[${escape(version)}\\].*$`, "m").exec(text);
  if (!m) return undefined;
  const after = text.slice(m.index + m[0].length);
  const end = after.search(/^## \[|^\[[^\]]+\]: /m);
  return (end === -1 ? after : after.slice(0, end)).replace(/^\n+|\n+$/g, "");
}

/** `git+https://github.com/o/r.git`, `https://github.com/o/r` and friends, as `https://github.com/o/r`. */
export function normaliseRepository(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url !== "string") return null;
  return url.replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/$/, "");
}

/**
 * The file checks, pure. Returns the list of problems (empty: releasable)
 * and, when the section exists, the release notes.
 */
export function evaluateRelease({ tag, pkg, changelog, readme }) {
  const problems = [];
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? "");
  if (!m) return { problems: [`the tag ${JSON.stringify(tag)} is not vX.Y.Z`], notes: undefined };
  const version = m[1];
  if (pkg?.version !== version) {
    problems.push(`the tag is ${tag} but package.json's version is ${pkg?.version}: tag the commit whose package.json says ${version}`);
  }
  const pin = pkg?.dependencies?.[SURFACE_PACKAGE];
  if (!/^\d+\.\d+\.\d+$/.test(pin ?? "")) {
    problems.push(`${SURFACE_PACKAGE} must be pinned to an exact x.y.z version, found ${JSON.stringify(pin)}`);
  }
  const text = String(changelog ?? "").replace(/\r\n/g, "\n");
  const heading = new RegExp(`^## \\[${escape(version)}\\](.*)$`, "m").exec(text);
  const notes = heading ? sectionBody(text, version) : undefined;
  if (!heading) {
    problems.push(`CHANGELOG.md has no [${version}] section`);
  } else if (!/^ - \d{4}-\d{2}-\d{2}\s*$/.test(heading[1])) {
    problems.push(
      `CHANGELOG.md's [${version}] section is not dated: a release dates it first ("## [${version}] - YYYY-MM-DD"), in a commit on main, then tags that commit`,
    );
  }
  const surfaceLine = `Surface: \`${SURFACE_PACKAGE}\` ${pin}.`;
  if (notes !== undefined && !notes.split("\n").includes(surfaceLine)) {
    problems.push(`CHANGELOG.md's [${version}] section does not name its surface: "${surfaceLine}"`);
  }
  const readmeLines = String(readme ?? "").match(new RegExp(`^Surface: \`${escape(SURFACE_PACKAGE)}\` \\d+\\.\\d+\\.\\d+`, "gm")) ?? [];
  if (readmeLines.length !== 1 || readmeLines[0] !== `Surface: \`${SURFACE_PACKAGE}\` ${pin}`) {
    problems.push(`README.md must have exactly one surface line, "Surface: \`${SURFACE_PACKAGE}\` ${pin}"`);
  }
  if (normaliseRepository(pkg?.repository) !== REPOSITORY) {
    problems.push(`package.json's repository must be ${REPOSITORY} (npm trusted publishing and provenance compare it)`);
  }
  if (pkg?.publishConfig?.access !== "public") problems.push('package.json needs publishConfig.access "public"');
  return { problems, notes, version, pin };
}

async function surfaceExists(pin) {
  const url = `${REGISTRY}/${SURFACE_PACKAGE.replace("/", "%2f")}/${pin}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "mnemoverse-ai-sdk-release" } });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return (await res.json())?.version === pin;
  } finally {
    clearTimeout(timer);
  }
}

export function parseArgs(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const tag = value("--tag");
  if (!tag) throw new Error("usage: node scripts/release-check.mjs --tag vX.Y.Z [--notes <file>] [--offline]");
  return { tag, notes: value("--notes"), offline: argv.includes("--offline") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = new URL("../", import.meta.url);
  const read = (f) => readFileSync(new URL(f, root), "utf8");
  const result = evaluateRelease({
    tag: args.tag,
    pkg: JSON.parse(read("package.json")),
    changelog: read("CHANGELOG.md"),
    readme: read("README.md"),
  });
  if (result.problems.length === 0 && !args.offline && !(await surfaceExists(result.pin))) {
    result.problems.push(`npm does not serve ${SURFACE_PACKAGE}@${result.pin}, the pinned surface`);
  }
  if (result.problems.length > 0) {
    for (const p of result.problems) console.error(process.env.GITHUB_ACTIONS ? `::error title=Release check::${p}` : `✗ ${p}`);
    return 1;
  }
  if (args.notes) writeFileSync(args.notes, `${result.notes}\n`);
  console.log(`✓ ${args.tag}: package.json, CHANGELOG (dated, surface ${result.pin}), README and repository agree`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
