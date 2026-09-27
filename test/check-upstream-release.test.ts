/**
 * scripts/check-upstream-release.mjs: the check the surface-bump contour
 * requires for every upstream version, and the only one a stolen npm token
 * cannot pass while the package publishes without provenance.
 *
 * Regression for the finding: with provenance advisory (no upstream version
 * has ever carried attestations), the contour had no authenticity check at
 * all. `npm audit signatures` passes for any tarball the registry accepted,
 * and the contract tests compare against the same installed upstream, so a
 * version published with a leaked token that kept the surface identical and
 * added behaviour went all the way to a published @mnemoverse/ai-sdk. The
 * fixtures in test/fixtures/upstream/ are GitHub's real answers for v0.12.1
 * (the compare trimmed to the fields read).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, parseArgs, UPSTREAM } from "../scripts/check-upstream-release.mjs";

const fixture = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/upstream/${file}`, import.meta.url), "utf8"));
const ref = fixture("ref-v0.12.1.json");
const tag = fixture("tag-v0.12.1.json");
const compare = fixture("compare-v0.12.1-main.json");
const release = fixture("release-v0.12.1.json");
const COMMIT = "d79943cdb6c5203679eafb30a6818bae7b256a76";
const real = { version: "0.12.1", ref, tag, compare, release };

describe("the upstream source gate", () => {
  it("names the package's public repository and default branch", () => {
    expect(UPSTREAM).toEqual({ package: "@mnemoverse/mcp-memory-server", repository: "mnemoverse/mcp-memory-server", branch: "main" });
  });

  it("passes 0.12.1 as GitHub serves it: annotated tag → commit on main, with a published Release", () => {
    const result = evaluate(real);
    expect(result).toEqual({ ok: true, commit: COMMIT, message: expect.stringContaining("tag v0.12.1 at d79943cdb6c5 is on mnemoverse/mcp-memory-server main") });
  });

  it("passes a lightweight tag, and a tag at main's head (identical)", () => {
    const light = { ref: "refs/tags/v0.12.1", object: { sha: COMMIT, type: "commit" } };
    expect(evaluate({ ...real, ref: light, tag: null }).ok).toBe(true);
    expect(evaluate({ ...real, compare: { status: "identical", merge_base_commit: { sha: COMMIT } } }).ok).toBe(true);
  });

  it("refuses a version published to npm with no tag (a leaked npm token: the finding's 0.12.2)", () => {
    const result = evaluate({ version: "0.12.2", ref: null, tag: null, compare: null, release: null });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/has no tag v0\.12\.2/);
  });

  it("refuses a tag that is not on main (a branch or a fork's history pushed as a tag)", () => {
    const diverged = { status: "diverged", merge_base_commit: { sha: "1".repeat(40) } };
    expect(evaluate({ ...real, compare: diverged }).message).toMatch(/is not on main \(compare status diverged\)/);
    // "behind" means main is behind the tag: the tag's commit is not in main.
    expect(evaluate({ ...real, compare: { status: "behind", merge_base_commit: { sha: "2".repeat(40) } } }).ok).toBe(false);
    // "ahead" with another merge base would be a lie; only the tag's own commit as the base counts.
    expect(evaluate({ ...real, compare: { status: "ahead", merge_base_commit: { sha: "3".repeat(40) } } }).ok).toBe(false);
    expect(evaluate({ ...real, compare: null }).message).toMatch(/no comparison/);
  });

  it("refuses a tag without its GitHub Release, a draft Release, or another tag's Release", () => {
    expect(evaluate({ ...real, release: null }).message).toMatch(/no GitHub Release for v0\.12\.1/);
    expect(evaluate({ ...real, release: { ...release, draft: true } }).message).toMatch(/is a draft/);
    expect(evaluate({ ...real, release: { ...release, draft: undefined } }).ok).toBe(false);
    expect(evaluate({ ...real, release: { ...release, tag_name: "v0.12.0" } }).message).toMatch(/for v0\.12\.0, not v0\.12\.1/);
  });

  it("refuses a ref for another tag, an unresolvable annotated tag, and a tag of a tree or a blob", () => {
    expect(evaluate({ ...real, ref: { ...ref, ref: "refs/tags/v0.12.10" } }).message).toMatch(/has no tag v0\.12\.1/);
    expect(evaluate({ ...real, tag: null }).message).toMatch(/does not resolve to a commit/);
    expect(evaluate({ ...real, tag: { ...tag, sha: "4".repeat(40) } }).message).toMatch(/does not resolve to a commit/);
    expect(evaluate({ ...real, tag: { ...tag, object: { ...tag.object, type: "tree" } } }).ok).toBe(false);
    expect(evaluate({ ...real, ref: { ...ref, object: { sha: COMMIT, type: "blob" } } }).message).toMatch(/points at a blob object/);
    expect(evaluate({ ...real, ref: { ...ref, object: { sha: "HEAD", type: "commit" } }, tag: null }).message).toMatch(/not a commit id/);
  });

  it("refuses what is not an x.y.z version", () => {
    expect(evaluate({ ...real, version: "latest" }).ok).toBe(false);
  });

  it("parses its arguments", () => {
    expect(parseArgs([])).toEqual({ version: undefined, json: false });
    expect(parseArgs(["--version", "0.12.2", "--json"])).toEqual({ version: "0.12.2", json: true });
    expect(() => parseArgs(["--version", "$(evil)"])).toThrow(/x\.y\.z/);
  });
});
