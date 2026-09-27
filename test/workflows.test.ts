/**
 * CI hygiene the auto-update contour depends on:
 *   - every action a workflow uses is pinned to a full commit SHA (a moved
 *     tag cannot change what runs). Regression for the supply-chain finding
 *     (ci.yml used @v4 tags, including the third-party pnpm/action-setup);
 *   - exactly ONE workflow publishes, release.yml, and only it holds a
 *     publish credential or asks for an OIDC token;
 *   - inside release.yml, the one job with `id-token: write` (and the only
 *     one that sees NPM_TOKEN) runs no third-party code: no install from the
 *     lockfile, no package script, no repository script, no checkout. The
 *     runner exposes the OIDC request token to every step of such a job, so
 *     a dependency's install script or a tampered upstream running in the
 *     gate there could mint an npm token for this package. Regression for
 *     that finding (install, gate, pack and publish used to share one job);
 *   - release.yml restores no cache, downloads only its own build job's
 *     tarball, and cannot be called as a reusable workflow (npm trusted
 *     publishing would then check the CALLER's file name, and the provenance
 *     would record the caller's commit);
 *   - the contour pushes with GITHUB_TOKEN from one checkout only, reaches
 *     release.yml by workflow_dispatch on the tag, and is started by the
 *     upstream release through workflow_dispatch, never repository_dispatch
 *     (which needs a token that can also push commits and tags here);
 *   - no `run:` script interpolates event or step data (script injection):
 *     it arrives through `env:`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(new URL(f, dir), "utf8") }));
const byName = (file: string) => {
  const w = workflows.find((x) => x.file === file);
  if (!w) throw new Error(`no ${file}`);
  return w.text;
};
/** The text with every YAML comment line removed, so a comment can explain a rule without tripping it. */
const code = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** The jobs of a workflow, by id: each job's text, from its `  id:` line to the next one. */
function jobsOf(text: string): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const jobs = new Map<string, string>();
  const parts = body.split(/^(?= {2}[\w-]+:\s*$)/m);
  for (const part of parts) {
    const id = /^ {2}([\w-]+):/.exec(part)?.[1];
    if (id) jobs.set(id, part);
  }
  return jobs;
}

/** Every `run:` script, inline or block, with the workflow it is in. */
function runScripts(text: string): string[] {
  const lines = text.split("\n");
  const scripts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    if (!/^[|>][-+]?\s*$/.test(m[2]!)) {
      scripts.push(m[2]!);
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
      body.push(l);
    }
    scripts.push(body.join("\n"));
  }
  return scripts;
}

describe("workflows", () => {
  it("exist", () => {
    expect(workflows.map((w) => w.file).sort()).toEqual(["ci.yml", "release.yml", "surface-bump.yml"]);
  });

  it("pin every action to a 40-character commit SHA", () => {
    const uses = workflows.flatMap((w) =>
      [...w.text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => ({ file: w.file, ref: m[1]! })),
    );
    expect(uses.length).toBeGreaterThan(0);
    const unpinned = uses.filter((u) => !/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/.test(u.ref));
    expect(unpinned).toEqual([]);
  });

  it("start from no permissions, or read-only ones", () => {
    for (const w of workflows) {
      expect(w.text, w.file).toMatch(/^permissions:(?: \{\}|\n {2}contents: read)$/m);
    }
  });

  it("only release.yml publishes, holds a publish credential, or asks for an OIDC token", () => {
    const publishing = /\bnpm publish\b|\bpnpm publish\b|NPM_TOKEN|NODE_AUTH_TOKEN|id-token:\s*write/;
    for (const w of workflows) {
      if (w.file === "release.yml") continue;
      expect(code(w.text), w.file).not.toMatch(publishing);
    }
    const release = code(byName("release.yml"));
    expect(release.match(/\bnpm publish\b/g)).toHaveLength(1);
    expect(release).toMatch(/npm publish "\$TGZ" --provenance --access public --ignore-scripts/);
    expect(release.match(/id-token:\s*write/g)).toHaveLength(1);
    expect(release.match(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/g)).toHaveLength(1);
  });

  describe("release.yml: the job that can publish runs no third-party code", () => {
    const jobs = jobsOf(code(byName("release.yml")));
    const holding = [...jobs].filter(([, text]) => /id-token:\s*write/.test(text));
    const [publishId, publish] = holding[0] ?? ["", ""];

    it("splits into build, publish, verify and github-release, in that order", () => {
      expect([...jobs.keys()]).toEqual(["build", "publish", "verify", "github-release"]);
      expect(jobs.get("publish")).toMatch(/^ {4}needs: build$/m);
      expect(jobs.get("verify")).toMatch(/^ {4}needs: \[build, publish\]$/m);
      expect(jobs.get("github-release")).toMatch(/^ {4}needs: verify$/m);
    });

    it("exactly one job holds id-token: write, NPM_TOKEN and npm publish, and it is publish", () => {
      expect(holding.map(([id]) => id)).toEqual(["publish"]);
      expect(publishId).toBe("publish");
      expect(publish).toMatch(/^ {4}permissions:\n {6}(?:#.*\n {6})*id-token: write\n {4}steps:/m);
      for (const [id, text] of jobs) {
        if (id === "publish") continue;
        expect(text, id).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|\bnpm publish\b|id-token/);
      }
      expect(publish).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    });

    it("installs nothing from the lockfile and runs no package or repository script", () => {
      expect(publish).not.toMatch(/\bpnpm\b/);
      expect(publish).not.toMatch(/\bnpm (?:ci|run|exec|test|rebuild|install-test|it)\b|\bnpx\b|\byarn\b|\bbun\b/);
      expect(publish).not.toMatch(/\bnode scripts\/|\bscripts\//);
      expect(publish).not.toMatch(/actions\/checkout@|pnpm\/action-setup@|^\s*cache:/m);
      // The one install is the pinned npm CLI itself, with its scripts off.
      const installs = [...publish.matchAll(/\bnpm (?:install|i|add)\b[^\n]*/g)].map((m) => m[0]);
      expect(installs).toEqual(["npm install --global --ignore-scripts --no-audit --no-fund npm@11.20.0"]);
      // The actions it uses: setup-node and the download of this run's tarball, nothing else.
      const uses = [...publish.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@/g)].map((m) => m[1]);
      expect(uses).toEqual(["actions/setup-node", "actions/download-artifact"]);
    });

    it("publishes only the build job's tarball, after recomputing its digest", () => {
      expect(jobs.get("build")).toMatch(/pnpm install --frozen-lockfile --ignore-scripts/);
      expect(jobs.get("build")).toMatch(/pnpm run gate/);
      expect(jobs.get("build")).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+name: npm-package\n/);
      expect(publish).toMatch(/uses: actions\/download-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+name: npm-package\n/);
      expect(publish).not.toMatch(/run-id:|github-token:|repository:/);
      expect(publish).toMatch(/INTEGRITY: \$\{\{ needs\.build\.outputs\.integrity \}\}/);
      expect(publish).toMatch(/openssl dgst -sha512 -binary "\$TGZ"/);
      expect(publish).toMatch(/if \[ "\$GOT" != "\$INTEGRITY" \]/);
    });

    it("the check after publishing, and the scripts it runs, live in a job without the credential", () => {
      expect(jobs.get("verify")).toMatch(/node scripts\/check-provenance\.mjs --self --version "\$VERSION"/);
      expect(jobs.get("verify")).toMatch(/^ {4}permissions:\n {6}contents: read\n/m);
    });

    it("the check that guards this reads a real job split (the helper itself)", () => {
      const sample = "on: push\njobs:\n  a:\n    steps:\n      - run: x\n  b-c:\n    permissions:\n      id-token: write\n";
      expect([...jobsOf(sample).keys()]).toEqual(["a", "b-c"]);
      expect(jobsOf(sample).get("b-c")).toMatch(/id-token/);
    });
  });

  it("release.yml runs on tags (pushed or dispatched), never as a reusable workflow, and refuses a branch", () => {
    const release = code(byName("release.yml"));
    expect(release).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- "v\*\.\*\.\*"\n {2}workflow_dispatch:/m);
    expect(release).not.toMatch(/workflow_call/);
    expect(release).toMatch(/\$REF_TYPE" != "tag"/);
    expect(release).toMatch(/merge-base --is-ancestor "\$SHA" refs\/remotes\/origin\/main/);
    expect(release).toMatch(/npm install --global --ignore-scripts --no-audit --no-fund npm@11\.\d+\.\d+/);
  });

  it("release.yml restores no cache, and downloads only the tarball its own build job uploaded", () => {
    const release = code(byName("release.yml"));
    expect(release).not.toMatch(/^\s*cache:/m);
    expect(release).not.toMatch(/actions\/cache@/);
    expect(release.match(/download-artifact@/g)).toHaveLength(1);
    expect(release.match(/upload-artifact@/g)).toHaveLength(1);
  });

  it("the contour publishes only through release.yml, dispatched on the tag", () => {
    const contour = code(byName("surface-bump.yml"));
    expect(contour).toMatch(/gh workflow run release\.yml --repo "\$REPO" --ref "\$TAG"/);
    // Started by a schedule or a workflow_dispatch (upstream's token needs only
    // Actions: write). repository_dispatch would need Contents: write, which
    // can push commits and tags here, and a tag pushed with a personal token
    // starts release.yml: the upstream token would be a publish credential.
    expect(contour).toMatch(/^on:\n {2}schedule:\n {4}(?:#.*\n {4})*- cron: "[^"]+"\n {2}workflow_dispatch:\n {4}inputs:\n {6}version:/m);
    expect(contour).not.toMatch(/repository_dispatch|client_payload/);
    expect(contour).toMatch(/DISPATCHED: \$\{\{ inputs\.version \}\}/);
    // The dispatch token can name any branch; only main's copy of this file runs.
    const plan = jobsOf(contour).get("plan") ?? "";
    expect(plan).toMatch(/if \[ "\$REF" != "refs\/heads\/main" \]; then/);
    expect(plan.indexOf("refs/heads/main")).toBeLessThan(plan.indexOf("actions/checkout@"));
    expect(contour).toMatch(/^concurrency:\n {2}group: surface-bump\n {2}cancel-in-progress: false/m);
    expect(contour).toMatch(/scripts\/bump-surface\.mjs "\$TARGET"/);
    expect(contour).toMatch(/check-provenance\.mjs --auto/);
    expect(contour).toMatch(/npm audit signatures/);
    // Unset variable → empty → the plan's default cool-down (6 h while advisory), never a forced 0.
    expect(contour).toMatch(/--cooldown-hours "\$\{COOLDOWN_HOURS:-\}"/);
    expect(contour).toMatch(/surface bump blocked: /);
  });

  it("the contour requires the upstream source check on every bump, before provenance and signatures", () => {
    const plan = jobsOf(code(byName("surface-bump.yml"))).get("plan") ?? "";
    const source = plan.indexOf("node scripts/check-upstream-release.mjs --version \"$TARGET\"");
    const provenance = plan.indexOf("check-provenance.mjs --auto");
    const signatures = plan.indexOf("npm audit signatures");
    expect(source).toBeGreaterThan(0);
    expect(source).toBeLessThan(provenance);
    expect(provenance).toBeLessThan(signatures);
    // Required: a plain step, no continue-on-error, no `|| true`, gated only on a bump.
    const step = plan.slice(plan.lastIndexOf("- name:", source), source + 80);
    expect(step).toMatch(/if: steps\.plan\.outputs\.action == 'bump'/);
    expect(step).not.toMatch(/continue-on-error|\|\| true|set \+e/);
    // Every later job needs the plan job, so a refusal stops the bump.
    for (const [id, text] of jobsOf(code(byName("surface-bump.yml")))) {
      if (id === "plan" || id === "report") continue;
      expect(text, id).toMatch(/^ {4}needs: (?:plan|\[plan,[^\]]*\])$/m);
    }
  });

  it("every checkout drops its credentials, except the one the contour pushes from", () => {
    for (const w of workflows) {
      const checkouts = w.text.split(/^\s*- uses: actions\/checkout@/m).slice(1);
      const keeping = checkouts.filter((c) => !/^\s*persist-credentials: false$/m.test(c.split(/^\s*- /m)[0]!));
      expect(keeping.length, w.file).toBe(w.file === "surface-bump.yml" ? 1 : 0);
    }
    expect(code(byName("surface-bump.yml")).match(/contents: write/g)).toHaveLength(1);
  });

  it("no run: script interpolates event, input, step or job data (it comes through env)", () => {
    const risky = /\$\{\{\s*(github\.event|inputs\.|steps\.|needs\.|github\.head_ref|vars\.)/;
    expect(runScripts(byName("surface-bump.yml")).length).toBeGreaterThan(8);
    expect(runScripts("      - run: echo ${{ github.event.issue.title }}\n")[0]).toMatch(risky);
    for (const w of workflows) {
      for (const script of runScripts(w.text)) {
        expect(script, `${w.file}: ${script.slice(0, 80)}`).not.toMatch(risky);
      }
    }
  });
});
