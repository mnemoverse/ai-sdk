#!/usr/bin/env node
/**
 * Source gate: was this @mnemoverse/mcp-memory-server version released from
 * the package's own repository, or only published to npm?
 *
 * An npm credential alone can publish a version. It cannot create a tag in
 * the package's GitHub repository, put that tag on main, or make the
 * package's release workflow create a GitHub Release for it. And that
 * workflow creates the Release only after npm serves the version with the
 * bytes the workflow built itself (its publish step compares them), so a
 * version somebody else published first does not get one.
 *
 * While the package publishes without provenance (0.1.0 to 0.12.1: no
 * dist.attestations, so scripts/check-provenance.mjs is advisory), this is the
 * only check the surface-bump contour has that a stolen npm token cannot
 * pass. `npm audit signatures` is not one: the registry signs every tarball
 * it accepts, whoever published it. So the contour requires this check for
 * every bump, before anything else happens (docs/AUTO-UPDATE-CONTOUR.md,
 * step 5).
 *
 *   node scripts/check-upstream-release.mjs                    # the pinned version
 *   node scripts/check-upstream-release.mjs --version 0.12.2   # a candidate
 *   node scripts/check-upstream-release.mjs --version 0.12.2 --json
 *
 * Exit 0: the tag vX.Y.Z exists, its commit is on the default branch, and a
 * published (not draft) GitHub Release exists for it. Exit 1: any of those is
 * missing, or GitHub could not be read ("could not tell" is never "fine").
 *
 * Reads the public GitHub REST API. GH_TOKEN or GITHUB_TOKEN, when set, is
 * sent to api.github.com only, for the rate limit; no permission is needed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const UPSTREAM = {
  package: "@mnemoverse/mcp-memory-server",
  repository: "mnemoverse/mcp-memory-server",
  branch: "main",
};

const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The whole decision, pure. The inputs are the GitHub API's answers, or null
 * for a 404:
 *   ref      GET /repos/{repo}/git/ref/tags/v{version}
 *   tag      GET /repos/{repo}/git/tags/{ref.object.sha}   (annotated tags only)
 *   compare  GET /repos/{repo}/compare/{commit}...{branch}
 *   release  GET /repos/{repo}/releases/tags/v{version}
 * Returns { ok, commit, message }.
 */
export function evaluate({ version, ref, tag = null, compare, release, upstream = UPSTREAM }) {
  const name = `v${version}`;
  const refuse = (why) => ({
    ok: false,
    commit: null,
    message: `✗ ${upstream.package}@${version} was not released from ${upstream.repository}: ${why}.`,
  });
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) return refuse(`${JSON.stringify(version)} is not an x.y.z version`);
  if (ref?.ref !== `refs/tags/${name}`) return refuse(`it has no tag ${name}`);
  let commit;
  if (ref.object?.type === "commit") {
    commit = ref.object.sha;
  } else if (ref.object?.type === "tag") {
    // An annotated tag: the ref names the tag object, which names the commit.
    if (tag?.sha !== ref.object.sha || tag?.object?.type !== "commit") {
      return refuse(`its tag ${name} does not resolve to a commit`);
    }
    commit = tag.object.sha;
  } else {
    return refuse(`its tag ${name} points at a ${ref.object?.type ?? "missing"} object, not a commit`);
  }
  if (!SHA.test(commit ?? "")) return refuse(`its tag ${name} resolves to ${JSON.stringify(commit)}, not a commit id`);
  const onBranch =
    (compare?.status === "ahead" || compare?.status === "identical") && compare?.merge_base_commit?.sha === commit;
  if (!onBranch) {
    return refuse(
      `its tag ${name} (${commit.slice(0, 12)}) is not on ${upstream.branch} ` +
        `(${compare ? `compare status ${compare.status ?? "missing"}` : "no comparison"})`,
    );
  }
  if (!release) return refuse(`it has no GitHub Release for ${name}, which its release workflow creates after npm serves its own bytes`);
  if (release.tag_name !== name) return refuse(`the GitHub Release found is for ${release.tag_name ?? "no tag"}, not ${name}`);
  if (release.draft !== false) return refuse(`the GitHub Release for ${name} is a draft`);
  return {
    ok: true,
    commit,
    message: `✓ ${upstream.package}@${version}: tag ${name} at ${commit.slice(0, 12)} is on ${upstream.repository} ${upstream.branch}, with its GitHub Release`,
  };
}

export function parseArgs(argv) {
  const i = argv.indexOf("--version");
  const version = i === -1 ? undefined : argv[i + 1];
  if (i !== -1 && !/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("--version needs an x.y.z version");
  return { version, json: argv.includes("--json") };
}

async function getJson(path, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "mnemoverse-ai-sdk-upstream-release",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { signal: ctrl.signal, headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}: could not tell`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const version = args.version ?? pkg.dependencies?.[UPSTREAM.package];
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const repo = `/repos/${UPSTREAM.repository}`;
  const name = `v${version}`;
  const ref = await getJson(`${repo}/git/ref/tags/${name}`, token);
  const tag = ref?.object?.type === "tag" && SHA.test(ref.object.sha ?? "") ? await getJson(`${repo}/git/tags/${ref.object.sha}`, token) : null;
  const commit = ref?.object?.type === "commit" ? ref.object.sha : tag?.object?.sha;
  const compare = SHA.test(commit ?? "") ? await getJson(`${repo}/compare/${commit}...${UPSTREAM.branch}?per_page=1`, token) : null;
  const release = ref ? await getJson(`${repo}/releases/tags/${name}`, token) : null;
  const result = evaluate({ version, ref, tag, compare, release });
  const out = result.ok ? console.log : console.error;
  out(!result.ok && process.env.GITHUB_ACTIONS ? `::error title=Upstream release::${result.message}` : result.message);
  if (!result.ok) {
    console.error(
      "  An npm credential can publish a version, but not tag it on the package's main or make its release workflow create the GitHub Release." +
        " Nothing is bumped or published on this version until a person has checked where it came from.",
    );
  }
  if (args.json) console.log(JSON.stringify({ name: UPSTREAM.package, version, ok: result.ok, commit: result.commit, message: result.message }));
  return result.ok ? 0 : 1;
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
