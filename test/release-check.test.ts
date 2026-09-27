/**
 * scripts/release-check.mjs, the release workflow's first gate: a tag
 * publishes only a tree that says, in every place, that it is that release.
 * Plus the package metadata npm trusted publishing and provenance compare.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateRelease, normaliseRepository, parseArgs, REPOSITORY, sectionBody } from "../scripts/release-check.mjs";

const livePkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const pkg = {
  name: "@mnemoverse/ai-sdk",
  version: "0.1.0",
  repository: { type: "git", url: "git+https://github.com/mnemoverse/ai-sdk.git" },
  publishConfig: { access: "public", provenance: true },
  dependencies: { "@mnemoverse/mcp-memory-server": "0.12.1" },
};
const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [0.1.0] - 2026-09-26",
  "",
  "Surface: `@mnemoverse/mcp-memory-server` 0.12.1.",
  "",
  "### Added",
  "",
  "- The first release.",
  "",
  "[Unreleased]: https://github.com/mnemoverse/ai-sdk/compare/v0.1.0...HEAD",
  "[0.1.0]: https://github.com/mnemoverse/ai-sdk/releases/tag/v0.1.0",
  "",
].join("\n");
const readme = "# @mnemoverse/ai-sdk\n\nSurface: `@mnemoverse/mcp-memory-server` 0.12.1. The tools are that package's own.\n";
const ok = { tag: "v0.1.0", pkg, changelog, readme };

describe("evaluateRelease", () => {
  it("a consistent, dated tree is releasable, and the notes are its CHANGELOG section", () => {
    const result = evaluateRelease(ok);
    expect(result.problems).toEqual([]);
    expect(result.notes).toBe("Surface: `@mnemoverse/mcp-memory-server` 0.12.1.\n\n### Added\n\n- The first release.");
  });

  it("refuses a tag that is not vX.Y.Z, or that is not package.json's version", () => {
    expect(evaluateRelease({ ...ok, tag: "0.1.0" }).problems[0]).toMatch(/not vX\.Y\.Z/);
    expect(evaluateRelease({ ...ok, tag: "v0.1.0-rc.1" }).problems[0]).toMatch(/not vX\.Y\.Z/);
    expect(evaluateRelease({ ...ok, tag: "v0.1.1" }).problems.join("\n")).toMatch(/package\.json's version is 0\.1\.0/);
  });

  it("refuses an undated section: the placeholder until release day", () => {
    const problems = evaluateRelease({ ...ok, changelog: changelog.replace("## [0.1.0] - 2026-09-26", "## [0.1.0]") }).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not dated/);
  });

  it("refuses a missing section, and a section that names another surface", () => {
    expect(evaluateRelease({ ...ok, changelog: "## [Unreleased]\n" }).problems.join("\n")).toMatch(/no \[0\.1\.0\] section/);
    expect(evaluateRelease({ ...ok, changelog: changelog.replace("0.12.1.", "0.12.0.") }).problems.join("\n")).toMatch(
      /does not name its surface/,
    );
  });

  it("refuses a range pin, and a README that names another surface (or none, or two)", () => {
    const ranged = { ...pkg, dependencies: { "@mnemoverse/mcp-memory-server": "^0.12.1" } };
    expect(evaluateRelease({ ...ok, pkg: ranged }).problems.join("\n")).toMatch(/exact x\.y\.z/);
    expect(evaluateRelease({ ...ok, readme: readme.replace("0.12.1", "0.12.0") }).problems.join("\n")).toMatch(/README/);
    expect(evaluateRelease({ ...ok, readme: "# nothing\n" }).problems.join("\n")).toMatch(/README/);
    expect(evaluateRelease({ ...ok, readme: readme + readme }).problems.join("\n")).toMatch(/README/);
  });

  it("refuses a repository other than this one, and a non-public publishConfig", () => {
    const fork = { ...pkg, repository: { type: "git", url: "git+https://github.com/someone/ai-sdk.git" } };
    expect(evaluateRelease({ ...ok, pkg: fork }).problems.join("\n")).toMatch(/repository must be/);
    expect(evaluateRelease({ ...ok, pkg: { ...pkg, publishConfig: {} } }).problems.join("\n")).toMatch(/public/);
  });

  it("a CRLF CHANGELOG reads the same", () => {
    expect(evaluateRelease({ ...ok, changelog: changelog.replace(/\n/g, "\r\n") }).problems).toEqual([]);
  });
});

describe("helpers", () => {
  it("sectionBody stops at the next section or the link list", () => {
    expect(sectionBody(changelog, "0.1.0")).toContain("- The first release.");
    expect(sectionBody(changelog, "0.1.0")).not.toContain("[Unreleased]:");
    expect(sectionBody(changelog, "9.9.9")).toBeUndefined();
  });

  it("normaliseRepository accepts the forms npm writes", () => {
    for (const url of [
      "git+https://github.com/mnemoverse/ai-sdk.git",
      "https://github.com/mnemoverse/ai-sdk",
      "https://github.com/mnemoverse/ai-sdk/",
    ]) {
      expect(normaliseRepository({ url })).toBe(REPOSITORY);
    }
    expect(normaliseRepository(undefined)).toBeNull();
  });

  it("parseArgs needs a tag", () => {
    expect(parseArgs(["--tag", "v0.1.0", "--notes", "n.md"])).toEqual({ tag: "v0.1.0", notes: "n.md", offline: false });
    expect(() => parseArgs([])).toThrow(/usage/);
  });
});

describe("package.json, as npm sees it", () => {
  it("names this repository, so trusted publishing and provenance can match it", () => {
    expect(normaliseRepository(livePkg.repository)).toBe(REPOSITORY);
    expect(livePkg.repository.url).toBe(`git+${REPOSITORY}.git`);
    expect(livePkg.bugs.url).toBe(`${REPOSITORY}/issues`);
  });

  it("publishes public, with provenance, MIT, for Node 22.12+", () => {
    expect(livePkg.publishConfig).toEqual({ access: "public", provenance: true });
    expect(livePkg.license).toBe("MIT");
    expect(livePkg.engines.node).toBe(">=22.12");
  });

  it("describes itself in the canon's words, for the Vercel AI SDK", () => {
    expect(livePkg.description).toMatch(/^Hosted AI agent memory that learns from outcomes, with shared rooms, for the Vercel AI SDK/);
  });

  it("the current version is releasable apart from its date (release day dates it)", () => {
    const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const problems = evaluateRelease({
      tag: `v${livePkg.version}`,
      pkg: livePkg,
      changelog: read("CHANGELOG.md"),
      readme: read("README.md"),
    }).problems.filter((p: string) => !/not dated/.test(p));
    expect(problems).toEqual([]);
  });
});
