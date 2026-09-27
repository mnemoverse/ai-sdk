#!/usr/bin/env node
/**
 * The auto-bump step of the update contour (docs/AUTO-UPDATE-CONTOUR.md):
 * move the exact pin of @mnemoverse/mcp-memory-server to a new version, bump
 * this package's own semver by the same component, and cut the CHANGELOG
 * section that names the new surface version.
 *
 *   node scripts/bump-surface.mjs 0.12.1
 *   node scripts/bump-surface.mjs 0.12.1 --dry-run
 *   node scripts/bump-surface.mjs 0.12.1 --json          # the plan as one JSON line (the contour reads it)
 *   node scripts/bump-surface.mjs 0.12.1 --date 2026-10-01
 *
 * It edits package.json, CHANGELOG.md and README.md (the surface line) only.
 * Refresh the lockfile afterwards (`pnpm install`), then run the gate.
 *
 * Two modes, decided by the CHANGELOG, never by the network:
 *
 *   release  The current own version is RELEASED (its section is dated,
 *            `## [x.y.z] - YYYY-MM-DD`). The bump cuts a new release: the own
 *            version moves by the version rule below, and a dated section
 *            takes the unreleased entries plus the surface bullet.
 *   fold     The current own version is NOT RELEASED yet (its section has no
 *            date, the placeholder until release day). Nothing was ever
 *            published under it, so it simply carries the new surface: the
 *            own version stays, its `Surface:` line names the new version,
 *            and the unreleased entries move into it. No release is cut; a
 *            person dates the section and tags it (the release runbook).
 *
 * Version rule: the component that changed in the surface changes here too.
 * Surface patch → own patch, minor → minor, major → major. (The package treats
 * any change to a request body as a minor.)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PACKAGE = "@mnemoverse/mcp-memory-server";

/** The Keep a Changelog groups, in the order a section lists them. */
const GROUPS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  if (!m) throw new Error(`not an x.y.z version: ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Which component moved from `from` to `to`; throws unless `to` is newer. */
export function bumpKind(from, to) {
  const a = parse(from);
  const b = parse(to);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return ["major", "minor", "patch"][i];
    if (b[i] < a[i]) break;
  }
  throw new Error(`${to} is not newer than ${from}`);
}

/** This package's next version for a surface bump of `kind`. */
export function nextVersion(own, kind) {
  const [major, minor, patch] = parse(own);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The release date of `## [version]`: "YYYY-MM-DD" when the section is dated
 * (released), null when it has no date (not released yet), undefined when
 * the CHANGELOG has no such section.
 */
export function sectionDate(input, version) {
  const text = input.replace(/\r\n/g, "\n");
  const m = new RegExp(`^## \\[${escape(version)}\\](.*)$`, "m").exec(text);
  if (!m) return undefined;
  const date = /^ - (\d{4}-\d{2}-\d{2})\s*$/.exec(m[1]);
  if (date) return date[1];
  if (m[1].trim() === "") return null;
  throw new Error(`CHANGELOG.md: the [${version}] heading must be "## [${version}]" or "## [${version}] - YYYY-MM-DD"`);
}

/** Split a section body into the text before the first `### ` group and the groups themselves. */
function entriesOf(body) {
  const lines = body.split("\n");
  const preamble = [];
  const groups = [];
  let current = null;
  for (const line of lines) {
    const m = /^### (.+?)\s*$/.exec(line);
    if (m) {
      current = { name: m[1], lines: [] };
      groups.push(current);
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  const trim = (ls) => ls.join("\n").replace(/^\n+|\n+$/g, "");
  return { preamble: trim(preamble), groups: groups.map((g) => ({ name: g.name, text: trim(g.lines) })) };
}

function renderEntries({ preamble, groups }) {
  const parts = [];
  if (preamble !== "") parts.push(preamble);
  for (const g of groups) parts.push(g.text === "" ? `### ${g.name}` : `### ${g.name}\n\n${g.text}`);
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}

/**
 * `from`'s groups merged into `into`'s: a group both have gets `from`'s
 * items after its own (one heading, in order); a group only `from` has is
 * added in Keep a Changelog order. `into`'s preamble is kept.
 */
export function mergeEntries(into, from) {
  const a = entriesOf(into);
  const b = entriesOf(from);
  if (b.preamble !== "") a.preamble = a.preamble === "" ? b.preamble : `${a.preamble}\n\n${b.preamble}`;
  for (const g of b.groups) {
    const same = a.groups.find((x) => x.name === g.name);
    if (same) {
      same.text = same.text === "" ? g.text : g.text === "" ? same.text : `${same.text}\n${g.text}`;
      continue;
    }
    const rank = (name) => (GROUPS.includes(name) ? GROUPS.indexOf(name) : GROUPS.length);
    const at = a.groups.findIndex((x) => rank(x.name) > rank(g.name));
    a.groups.splice(at === -1 ? a.groups.length : at, 0, { ...g });
  }
  return renderEntries(a);
}

/** { head, unreleased, rest }: the text up to and including `## [Unreleased]`, its body, and the rest. */
function splitUnreleased(text) {
  const heading = "## [Unreleased]";
  if (!text.includes(heading)) throw new Error("CHANGELOG.md has no [Unreleased] section");
  const start = text.indexOf(heading) + heading.length;
  const after = text.slice(start);
  const next = after.search(/^## \[/m);
  const links = after.search(/^\[[^\]]+\]: /m);
  const end = next !== -1 ? next : links !== -1 ? links : after.length;
  return { head: text.slice(0, start), unreleased: after.slice(0, end).replace(/^\n+|\n+$/g, ""), rest: after.slice(end) };
}

/**
 * CHANGELOG with the release section a bump cuts, and its link (mode "release").
 *
 * A bump is what gets tagged and published (AUTO-UPDATE-CONTOUR step 5), so
 * whatever sits under [Unreleased] on main at that moment ships with the new
 * version. The new section therefore TAKES the unreleased entries: they move
 * under `## [version]`, the surface bullet joins their `### Changed` list (or
 * opens one), and `## [Unreleased]` is left empty.
 */
export function withChangelogSection(input, { version, previous, surface, previousSurface, date }) {
  // LF throughout: a CRLF checkout (core.autocrlf on Windows) would otherwise
  // leave CR-only remnants where the slicing trims "\n". The file is written
  // back with LF; git normalises on commit either way.
  const text = input.replace(/\r\n/g, "\n");
  if (text.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has a [${version}] section`);
  const { head, unreleased, rest } = splitUnreleased(text);
  const bullet = `- Exposes the MCP surface of \`${PACKAGE}\` ${surface} (was ${previousSurface}). See that release's notes for what changed in the tools.`;
  const entries = mergeEntries(unreleased, `### Changed\n\n${bullet}`);
  const section = `## [${version}] - ${date}\n\nSurface: \`${PACKAGE}\` ${surface}.\n\n${entries}`;
  let out = `${head}\n\n${section}${rest === "" ? "" : `\n${rest}`}`;
  out = out.replace(
    /^\[Unreleased\]: (.*)\/compare\/v[^.]+\.[^.]+\.[^.]+\.\.\.HEAD$/m,
    (_m, base) => `[Unreleased]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/compare/v${previous}...v${version}`,
  );
  return out;
}

/**
 * CHANGELOG with an UNRELEASED version re-targeted at a new surface (mode
 * "fold"): its `Surface:` line names `surface`, the [Unreleased] entries move
 * into it, [Unreleased] is left empty. The section stays undated and the
 * links stay as they are: nothing is released by this.
 */
export function withSurfaceFolded(input, { version, surface }) {
  const text = input.replace(/\r\n/g, "\n");
  if (sectionDate(text, version) !== null) throw new Error(`CHANGELOG.md has no undated [${version}] section to fold into`);
  const { head, unreleased, rest } = splitUnreleased(text);
  const heading = `## [${version}]`;
  const at = rest.indexOf(`${heading}\n`);
  if (at === -1) throw new Error(`CHANGELOG.md: [${version}] must be the first section after [Unreleased]`);
  if (rest.slice(0, at).trim() !== "") throw new Error(`CHANGELOG.md: [${version}] must be the first section after [Unreleased]`);
  const afterHeading = rest.slice(at + heading.length);
  const next = afterHeading.search(/^## \[|^\[[^\]]+\]: /m);
  const body = next === -1 ? afterHeading : afterHeading.slice(0, next);
  const tail = next === -1 ? "" : afterHeading.slice(next);
  const surfaceLine = `Surface: \`${PACKAGE}\` ${surface}.`;
  const surfaceRe = new RegExp(`^Surface: \`${escape(PACKAGE)}\` \\d+\\.\\d+\\.\\d+\\.$`, "m");
  const retargeted = surfaceRe.test(body) ? body.replace(surfaceRe, surfaceLine) : `${surfaceLine}\n\n${body.replace(/^\n+/, "")}`;
  const merged = mergeEntries(retargeted.replace(/^\n+|\n+$/g, ""), unreleased);
  return `${head}\n\n${heading}\n\n${merged}${tail === "" ? "" : `\n${tail}`}`;
}

/** The README's surface line, `Surface: \`@mnemoverse/mcp-memory-server\` x.y.z`, moved to `surface`. */
export function withReadmeSurface(input, surface) {
  const text = input.replace(/\r\n/g, "\n");
  const re = new RegExp(`^(Surface: \`${escape(PACKAGE)}\` )\\d+\\.\\d+\\.\\d+`, "m");
  if (!re.test(text)) throw new Error(`README.md has no "Surface: \`${PACKAGE}\` x.y.z" line`);
  return text.replace(re, `$1${surface}`);
}

/**
 * The whole bump, pure: what the three files become. `pkg` is package.json's
 * object, `changelog` and `readme` the file texts.
 */
export function planBump({ pkg, changelog, readme, target, date }) {
  const previousSurface = pkg.dependencies?.[PACKAGE];
  const kind = bumpKind(previousSurface, target);
  const released = sectionDate(changelog, pkg.version);
  if (released === undefined) throw new Error(`CHANGELOG.md has no [${pkg.version}] section for package.json's version`);
  const mode = released === null ? "fold" : "release";
  const version = mode === "fold" ? pkg.version : nextVersion(pkg.version, kind);
  const nextChangelog =
    mode === "fold"
      ? withSurfaceFolded(changelog, { version, surface: target })
      : withChangelogSection(changelog, { version, previous: pkg.version, surface: target, previousSurface, date });
  const nextPkg = { ...pkg, version, dependencies: { ...pkg.dependencies, [PACKAGE]: target } };
  return {
    mode,
    kind,
    previousSurface,
    surface: target,
    previousVersion: pkg.version,
    version,
    pkg: nextPkg,
    changelog: nextChangelog,
    readme: withReadmeSurface(readme, target),
  };
}

export function parseArgs(argv) {
  const target = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--date");
  const d = argv.indexOf("--date");
  const date = d === -1 ? new Date().toISOString().slice(0, 10) : argv[d + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("--date needs YYYY-MM-DD");
  if (!target) throw new Error("usage: node scripts/bump-surface.mjs <new surface version> [--dry-run] [--json] [--date YYYY-MM-DD]");
  parse(target);
  return { target, date, dryRun: argv.includes("--dry-run"), json: argv.includes("--json") };
}

function main() {
  const { target, date, dryRun, json } = parseArgs(process.argv.slice(2));
  const root = new URL("../", import.meta.url);
  const files = { pkg: new URL("package.json", root), changelog: new URL("CHANGELOG.md", root), readme: new URL("README.md", root) };
  const plan = planBump({
    pkg: JSON.parse(readFileSync(files.pkg, "utf8")),
    changelog: readFileSync(files.changelog, "utf8"),
    readme: readFileSync(files.readme, "utf8"),
    target,
    date,
  });
  const { pkg, changelog, readme, ...summary } = plan;
  if (json) console.log(JSON.stringify(summary));
  else
    console.log(
      `${PACKAGE} ${plan.previousSurface} → ${target} (${plan.kind}); @mnemoverse/ai-sdk ${plan.previousVersion} → ` +
        `${plan.version} (${plan.mode === "fold" ? "unreleased: folded into it, no release cut" : "release cut"})`,
    );
  if (dryRun) return;
  writeFileSync(files.pkg, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(files.changelog, changelog);
  writeFileSync(files.readme, readme);
  if (!json) console.log("Updated package.json, CHANGELOG.md and README.md. Next: pnpm install, then the gate.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
