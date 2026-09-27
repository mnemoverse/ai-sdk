#!/usr/bin/env node
/**
 * What the surface-bump contour (.github/workflows/surface-bump.yml) does in
 * this run. Read-only: it asks the public npm registry and the local git
 * checkout, and prints its decision.
 *
 *   node scripts/surface-plan.mjs                        # human-readable
 *   node scripts/surface-plan.mjs --json                 # one JSON line (the workflow reads it)
 *   node scripts/surface-plan.mjs --dispatched 0.12.2    # the version the upstream dispatch named
 *   node scripts/surface-plan.mjs --cooldown-hours 6     # bump only a release at least 6 h old
 *        (unset or empty: 6 h while upstream provenance is advisory, 0 once
 *        it is required; see cooldownFor below)
 *
 * The decision (pure, `plan` below):
 *
 *   bump     npm's latest @mnemoverse/mcp-memory-server is newer than the
 *            pin, and this package's current version is released (dated in
 *            the CHANGELOG and served by npm): bump, test, tag, publish.
 *   release  this package's current version is dated and tagged, but npm
 *            does not serve it: an earlier publish did not finish. Publish
 *            that tag again (release.yml skips what npm already has).
 *   wait     the pin is behind, but the new release is younger than the
 *            cool-down: a later run bumps it.
 *   blocked  the pin is behind, but this package's own version is not in a
 *            state a bump can start from (not released yet, or dated and not
 *            tagged). A person finishes that release first; the run is red.
 *   none     nothing to do.
 *
 * The dispatched version is a hint, never the source of truth: the target is
 * always npm's `latest`, which the package's release job waits for before it
 * dispatches. A dispatched version that disagrees is reported.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sectionDate } from "./bump-surface.mjs";
import { modeFor } from "./check-provenance.mjs";
import { hoursSince, verdict } from "./lag-guard.mjs";

export const SURFACE_PACKAGE = "@mnemoverse/mcp-memory-server";
export const OWN_PACKAGE = "@mnemoverse/ai-sdk";
const REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 20_000;

/**
 * The cool-down while upstream provenance is ADVISORY (no version of the
 * package has ever carried attestations, so nothing proves a release came
 * from its release workflow): a new upstream version waits this long before
 * the contour bumps it, so a bad release can be noticed and deprecated
 * upstream first. With the six-hourly schedule a release is bumped 6 to 12 h
 * after npm serves it, inside the lag guard's 24 h.
 */
export const ADVISORY_COOLDOWN_HOURS = 6;

/**
 * The cool-down in force: the repository variable SURFACE_BUMP_COOLDOWN_HOURS
 * when it is set (0 included: an explicit choice), otherwise
 * ADVISORY_COOLDOWN_HOURS while upstream provenance is advisory (or unknown)
 * and none once it is required.
 */
export function cooldownFor(configured, provenanceMode) {
  if (typeof configured === "number") return configured;
  return provenanceMode === "required" ? 0 : ADVISORY_COOLDOWN_HOURS;
}

/** The decision, pure. */
export function plan({ pinned, latest, dispatched, own, ownDate, ownOnNpm, tagExists, latestPublishedAt, cooldownHours = null, provenanceMode, now = Date.now() }) {
  const notes = [];
  const tag = `v${own}`;
  if (dispatched !== undefined && dispatched !== null && dispatched !== "") {
    if (!/^\d+\.\d+\.\d+$/.test(dispatched)) notes.push(`ignored a dispatched version that is not x.y.z: ${JSON.stringify(dispatched)}`);
    else if (dispatched !== latest) notes.push(`dispatched ${dispatched}, but npm's latest is ${latest}: the target is npm's latest`);
  }
  const base = { pinned, latest, own, tag, notes };
  const released = typeof ownDate === "string";
  // A publish that did not finish comes first: the tagged version must reach
  // npm before anything newer is cut on top of it.
  if (released && tagExists && !ownOnNpm) {
    return { ...base, action: "release", target: null, reason: `${OWN_PACKAGE}@${own} is tagged ${tag} but npm does not serve it: publish ${tag} again` };
  }
  const lag = verdict(pinned, latest);
  if (lag === "unreadable") throw new Error(`cannot compare the pin ${JSON.stringify(pinned)} with npm's latest ${JSON.stringify(latest)}`);
  if (lag !== "behind") {
    return { ...base, action: "none", target: null, reason: `pinned ${pinned}, npm latest ${latest}: ${lag}` };
  }
  if (!released) {
    return {
      ...base,
      action: "blocked",
      target: latest,
      reason:
        `${SURFACE_PACKAGE} ${latest} is out, but ${OWN_PACKAGE} ${own} is not released yet (its CHANGELOG section has no date). ` +
        `Release ${tag} first (date the section, merge, tag); the contour bumps from a released version only.`,
    };
  }
  if (!ownOnNpm) {
    return {
      ...base,
      action: "blocked",
      target: latest,
      reason: `${SURFACE_PACKAGE} ${latest} is out, but ${OWN_PACKAGE} ${own} is dated and not tagged: tag ${tag} (release.yml publishes it), then the contour bumps.`,
    };
  }
  const cooldown = cooldownFor(cooldownHours, provenanceMode);
  const age = hoursSince(latestPublishedAt, now);
  if (cooldown > 0 && age < cooldown) {
    const why = typeof cooldownHours === "number" ? "SURFACE_BUMP_COOLDOWN_HOURS" : "the default while upstream provenance is advisory";
    return {
      ...base,
      action: "wait",
      target: latest,
      cooldownHours: cooldown,
      reason: `${SURFACE_PACKAGE} ${latest} was published ${age.toFixed(1)} h ago, inside the ${cooldown} h cool-down (${why}): a later run bumps it`,
    };
  }
  return { ...base, action: "bump", target: latest, cooldownHours: cooldown, reason: `pinned ${pinned}, npm latest ${latest}: bump` };
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "mnemoverse-ai-sdk-surface-plan" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function tagExistsLocally(tag) {
  try {
    execFileSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const i = argv.indexOf("--dispatched");
  const c = argv.indexOf("--cooldown-hours");
  // Unset or empty (the repository variable is not set): null, the default of cooldownFor.
  const raw = c === -1 ? undefined : argv[c + 1];
  const cooldownHours = raw === "" || raw === undefined ? null : Number(raw);
  if (cooldownHours !== null && (!Number.isFinite(cooldownHours) || cooldownHours < 0)) {
    throw new Error("--cooldown-hours needs a non-negative number");
  }
  return { dispatched: i === -1 ? undefined : argv[i + 1], json: argv.includes("--json"), cooldownHours };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = new URL("../", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8");
  const upstream = await getJson(`${REGISTRY}/${SURFACE_PACKAGE.replace("/", "%2f")}`);
  const latest = upstream?.["dist-tags"]?.latest;
  if (typeof latest !== "string") throw new Error(`npm's packument for ${SURFACE_PACKAGE} has no dist-tags.latest`);
  const ownEntry = await getJson(`${REGISTRY}/${OWN_PACKAGE.replace("/", "%2f")}/${pkg.version}`);
  const decision = plan({
    pinned: pkg.dependencies?.[SURFACE_PACKAGE],
    latest,
    dispatched: args.dispatched,
    own: pkg.version,
    ownDate: sectionDate(changelog, pkg.version),
    ownOnNpm: ownEntry?.version === pkg.version,
    tagExists: tagExistsLocally(`v${pkg.version}`),
    latestPublishedAt: upstream?.time?.[latest] ?? null,
    cooldownHours: args.cooldownHours,
    provenanceMode: modeFor(upstream).mode,
  });
  for (const note of decision.notes) console.error(process.env.GITHUB_ACTIONS ? `::notice title=Surface plan::${note}` : `! ${note}`);
  if (args.json) console.log(JSON.stringify(decision));
  else console.log(`${decision.action}: ${decision.reason}`);
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
