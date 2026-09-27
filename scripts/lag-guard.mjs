#!/usr/bin/env node
/**
 * Lag guard: does this package pin the latest @mnemoverse/mcp-memory-server?
 *
 * Modelled on mnemoverse-mcp-remote's scripts/check-package-currency.mjs (PR
 * #51). The package defines the whole MCP surface; this consumer exposes it by
 * EXACT version. A pin behind npm's latest is a lag between this package's
 * surface and the package's, which is the drift the consumer rule exists to
 * end. The auto-bump PR (docs/AUTO-UPDATE-CONTOUR.md) is the fix; this is the
 * alarm for a bump that did not land.
 *
 *   node scripts/lag-guard.mjs                   # red as soon as the pin is behind
 *   node scripts/lag-guard.mjs --grace-hours 24  # red once the newer release is 24 h old
 *
 * Exit 0: current, ahead, or behind within the grace period.
 * Exit 1: behind past the grace period, not pinned exactly, the lockfile
 *         disagrees with the pin, a version that is not x.y.z, or npm unreachable.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PACKAGE = "@mnemoverse/mcp-memory-server";
const REGISTRY = `https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}`;
const TIMEOUT_MS = 20_000;

/** The range package.json declares, or null. */
export function declaredRange(pkg) {
  return pkg?.dependencies?.[PACKAGE] ?? null;
}

/**
 * The version pnpm-lock.yaml (lockfile v9) installs for the root importer, or
 * null. Read line by line so the guard needs no YAML dependency:
 *
 *   importers:
 *     .:
 *       dependencies:
 *         '@mnemoverse/mcp-memory-server':
 *           specifier: 0.11.0
 *           version: 0.11.0
 */
export function lockedVersion(lockText) {
  const lines = String(lockText ?? "").split(/\r?\n/);
  let section = null;
  let importer = null;
  let deps = false;
  let inPackage = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      importer = null;
      deps = false;
      inPackage = false;
      continue;
    }
    if (section !== "importers") continue;
    let m;
    if ((m = /^ {2}(\S.*):\s*$/.exec(line))) {
      importer = m[1].replace(/^'|'$/g, "");
      deps = false;
      inPackage = false;
    } else if ((m = /^ {4}(\S+):\s*$/.exec(line))) {
      deps = importer === "." && m[1] === "dependencies";
      inPackage = false;
    } else if (deps && (m = /^ {6}(\S.*):\s*$/.exec(line))) {
      inPackage = m[1].replace(/^'|'$/g, "") === PACKAGE;
    } else if (deps && inPackage && (m = /^ {8}version:\s*(\S+)\s*$/.exec(line))) {
      return m[1].replace(/^'|'$/g, "").replace(/\(.*$/, "");
    }
  }
  return null;
}

/** [major, minor, patch] of a release version, or null for anything else. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Compare the pin with npm's latest.
 *   current     pinned === latest
 *   behind      latest is newer
 *   ahead       pinned is newer (a prerelease, or npm has not caught up)
 *   unreadable  a version that is not x.y.z
 */
export function verdict(pinned, latest) {
  const a = parseVersion(pinned);
  const b = parseVersion(latest);
  if (!a || !b) return "unreadable";
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return "behind";
    if (a[i] > b[i]) return "ahead";
  }
  return "current";
}

/** Hours since `publishedAt` (ISO string) at `now`, or Infinity when unknown. */
export function hoursSince(publishedAt, now = Date.now()) {
  const t = Date.parse(publishedAt ?? "");
  return Number.isFinite(t) ? (now - t) / 3_600_000 : Infinity;
}

/**
 * The whole decision, pure. Returns { ok, message }.
 * `npm` is { latest, publishedAt } for npm's latest release.
 */
export function evaluate({ range, locked, npm, graceHours = 0, now = Date.now() }) {
  if (range === null) {
    return { ok: false, message: `package.json does not declare ${PACKAGE}; this package cannot work without it.` };
  }
  if (parseVersion(range) === null) {
    return {
      ok: false,
      message: `${PACKAGE} is declared as ${JSON.stringify(range)}; it must be pinned to an exact x.y.z version.`,
    };
  }
  if (locked !== range) {
    return {
      ok: false,
      message: `package.json pins ${PACKAGE}@${range} but pnpm-lock.yaml installs ${locked ?? "nothing"}. Run pnpm install and commit the lockfile.`,
    };
  }
  const line = `${PACKAGE}: pinned ${range}, npm latest ${npm.latest}`;
  switch (verdict(range, npm.latest)) {
    case "current":
      return { ok: true, message: `✓ ${line}` };
    case "ahead":
      return { ok: true, message: `✓ ${line} (ahead of npm: a prerelease, or npm has not served the release yet)` };
    case "behind": {
      const age = hoursSince(npm.publishedAt, now);
      if (age < graceHours) {
        return {
          ok: true,
          message: `! ${line}, published ${age.toFixed(1)} h ago: within the ${graceHours} h grace period for the auto-bump PR.`,
        };
      }
      return {
        ok: false,
        message:
          `✗ ${line}${Number.isFinite(age) ? `, published ${age.toFixed(1)} h ago` : ""}. This package's surface ` +
          `lags the package's. Merge the auto-bump PR, or pin ${PACKAGE}@${npm.latest} exactly, run pnpm install ` +
          "and commit the lockfile.",
      };
    }
    default:
      return { ok: false, message: `✗ ${line}: a version that is not x.y.z cannot be compared.` };
  }
}

async function fetchNpm() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "mnemoverse-ai-sdk-lag-guard" },
    });
    if (!res.ok) throw new Error(`${REGISTRY} answered ${res.status}`);
    const json = await res.json();
    const latest = json?.["dist-tags"]?.latest;
    if (typeof latest !== "string") throw new Error("npm's packument has no dist-tags.latest");
    return { latest, publishedAt: json?.time?.[latest] ?? null };
  } finally {
    clearTimeout(timer);
  }
}

export function parseArgs(argv) {
  const i = argv.indexOf("--grace-hours");
  if (i === -1) return { graceHours: 0 };
  const graceHours = Number(argv[i + 1]);
  if (!Number.isFinite(graceHours) || graceHours < 0) throw new Error("--grace-hours needs a non-negative number");
  return { graceHours };
}

async function main() {
  const { graceHours } = parseArgs(process.argv.slice(2));
  const root = new URL("../", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const lock = readFileSync(new URL("pnpm-lock.yaml", root), "utf8");
  const range = declaredRange(pkg);
  const locked = lockedVersion(lock);
  // Configuration problems are decided before asking npm.
  const offline = evaluate({ range, locked, npm: { latest: range ?? "", publishedAt: null }, graceHours });
  if (!offline.ok) {
    console.error(`✗ ${offline.message}`);
    return 1;
  }
  const result = evaluate({ range, locked, npm: await fetchNpm(), graceHours });
  (result.ok ? console.log : console.error)(result.message);
  return result.ok ? 0 : 1;
}

// The exit code is set, not forced: process.exit() while the fetch's socket is
// still open can make Node on Windows die with a fast-fail code instead of 1.
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
