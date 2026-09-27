/**
 * scripts/bump-surface.mjs, the auto-bump step: the version rule and the
 * CHANGELOG section a bump PR carries (test/version.test.ts then requires it).
 */
import { describe, expect, it } from "vitest";
import {
  bumpKind,
  mergeEntries,
  nextVersion,
  parseArgs,
  planBump,
  sectionDate,
  withChangelogSection,
  withReadmeSurface,
  withSurfaceFolded,
} from "../scripts/bump-surface.mjs";

/**
 * A CHANGELOG in this repository's shape, as it stood before the first bump.
 * A fixture, not the live file: the live one gains the very section this
 * test adds as soon as a real bump lands, and the test would then refuse its
 * own input ("already has a [0.2.0] section"). Line endings are LF on
 * purpose, so a checkout with core.autocrlf does not put a CR into the
 * heading the assertion below compares.
 */
const changelog = [
  "# Changelog",
  "",
  "Each release exposes exactly one version of `@mnemoverse/mcp-memory-server`.",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- Something not yet released.",
  "",
  "### Changed",
  "",
  "- Something changed and not yet released.",
  "",
  "## [0.1.0]",
  "",
  "Surface: `@mnemoverse/mcp-memory-server` 0.11.0.",
  "",
  "### Added",
  "",
  "- The first release.",
  "",
  "[Unreleased]: https://github.com/mnemoverse/ai-sdk/compare/v0.1.0...HEAD",
  "[0.1.0]: https://github.com/mnemoverse/ai-sdk/releases/tag/v0.1.0",
  "",
].join("\n");

describe("version rule: the surface component that moved moves here too", () => {
  it.each([
    ["0.11.0", "0.11.1", "patch", "0.1.0", "0.1.1"],
    ["0.11.0", "0.12.0", "minor", "0.1.0", "0.2.0"],
    ["0.11.3", "0.12.0", "minor", "0.1.4", "0.2.0"],
    ["0.11.0", "1.0.0", "major", "0.1.0", "1.0.0"],
  ])("surface %s → %s is a %s: own %s → %s", (from, to, kind, own, next) => {
    expect(bumpKind(from, to)).toBe(kind);
    expect(nextVersion(own, kind as "patch")).toBe(next);
  });

  it.each([["0.11.0", "0.11.0"], ["0.11.0", "0.10.9"], ["0.11.0", "0.12.0-rc.1"]])("refuses %s → %s", (from, to) => {
    expect(() => bumpKind(from, to)).toThrow();
  });
});

describe("CHANGELOG section", () => {
  const bumped = withChangelogSection(changelog, {
    version: "0.2.0",
    previous: "0.1.0",
    surface: "0.12.0",
    previousSurface: "0.11.0",
    date: "2026-10-01",
  });

  it("goes right under [Unreleased] and names the new surface version", () => {
    const sections = bumped.split(/^## /m).map((s) => s.split("\n")[0]);
    expect(sections.slice(1, 4)).toEqual(["[Unreleased]", "[0.2.0] - 2026-10-01", "[0.1.0]"]);
    expect(bumped).toContain("Surface: `@mnemoverse/mcp-memory-server` 0.12.0.");
  });

  it("cuts a release: the unreleased entries move under the new version, and [Unreleased] is left empty", () => {
    const sections = bumped.split(/^## /m);
    const unreleased = sections[1]!;
    const release = sections[2]!;
    expect(unreleased.trim()).toBe("[Unreleased]");
    expect(release).toContain("- Something not yet released.");
    expect(release).toContain("- Something changed and not yet released.");
    // The surface bullet joins the existing Changed list: one heading, in order.
    expect(release.match(/^### Changed$/gm)).toHaveLength(1);
    expect(release.indexOf("### Added")).toBeLessThan(release.indexOf("### Changed"));
    expect(release.indexOf("- Something changed and not yet released.")).toBeLessThan(
      release.indexOf("- Exposes the MCP surface of `@mnemoverse/mcp-memory-server` 0.12.0 (was 0.11.0)."),
    );
    // The previous release is untouched.
    expect(sections[3]).toContain("- The first release.");
  });

  it("with nothing unreleased, the new section carries only the surface bullet", () => {
    const empty = changelog.replace(/### Added[\s\S]*?(?=## \[0\.1\.0\])/, "");
    const out = withChangelogSection(empty, {
      version: "0.2.0",
      previous: "0.1.0",
      surface: "0.12.0",
      previousSurface: "0.11.0",
      date: "2026-10-01",
    });
    const release = out.split(/^## /m)[2]!;
    expect(release.match(/^### .*$/gm)).toEqual(["### Changed"]);
    expect(release).toContain("(was 0.11.0)");
    expect(out.split(/^## /m)[1]!.trim()).toBe("[Unreleased]");
  });

  it("a CRLF input (a core.autocrlf checkout) produces the same LF output as an LF input, with no CR-only blank lines", () => {
    const crlf = changelog.replace(/\n/g, "\r\n");
    const out = withChangelogSection(crlf, {
      version: "0.2.0",
      previous: "0.1.0",
      surface: "0.12.0",
      previousSurface: "0.11.0",
      date: "2026-10-01",
    });
    expect(out).toBe(bumped);
    expect(out).not.toContain("\r");
    // Exactly one blank line between the Surface line and the first heading.
    expect(out).toContain("Surface: `@mnemoverse/mcp-memory-server` 0.12.0.\n\n### Added");
    expect(out).not.toContain("\n\n\n");
  });

  it("updates the compare links", () => {
    expect(bumped).toContain("[Unreleased]: https://github.com/mnemoverse/ai-sdk/compare/v0.2.0...HEAD");
    expect(bumped).toContain("[0.2.0]: https://github.com/mnemoverse/ai-sdk/compare/v0.1.0...v0.2.0");
  });

  it("refuses a section that already exists", () => {
    expect(() =>
      withChangelogSection(bumped, { version: "0.2.0", previous: "0.1.0", surface: "0.12.0", previousSurface: "0.11.0", date: "x" }),
    ).toThrow();
  });
});

/** The same CHANGELOG once 0.1.0 is released (its section dated). */
const released = changelog.replace("## [0.1.0]\n", "## [0.1.0] - 2026-09-26\n");
const readme = "# @mnemoverse/ai-sdk\n\nSurface: `@mnemoverse/mcp-memory-server` 0.11.0 (see Versions below).\n";
const pkg = {
  name: "@mnemoverse/ai-sdk",
  version: "0.1.0",
  dependencies: { "@mnemoverse/mcp-memory-server": "0.11.0", "@modelcontextprotocol/sdk": "^1.30.0" },
};

describe("sectionDate: a dated section is released, an undated one is not", () => {
  it("reads the date, null for no date, undefined for no section", () => {
    expect(sectionDate(released, "0.1.0")).toBe("2026-09-26");
    expect(sectionDate(changelog, "0.1.0")).toBeNull();
    expect(sectionDate(changelog, "0.2.0")).toBeUndefined();
    expect(sectionDate(changelog.replace(/\n/g, "\r\n"), "0.1.0")).toBeNull();
  });

  it("refuses a heading that is neither form", () => {
    expect(() => sectionDate(changelog.replace("## [0.1.0]\n", "## [0.1.0] (soon)\n"), "0.1.0")).toThrow(/YYYY-MM-DD/);
  });
});

describe("mergeEntries", () => {
  it("appends to a group both have, adds a missing group in Keep a Changelog order, keeps the preamble", () => {
    const out = mergeEntries("Surface: x.\n\n### Added\n\n- a1\n\n### Fixed\n\n- f1", "### Changed\n\n- c1\n\n### Added\n\n- a2");
    expect(out).toBe("Surface: x.\n\n### Added\n\n- a1\n- a2\n\n### Changed\n\n- c1\n\n### Fixed\n\n- f1\n");
  });

  it("merging nothing changes nothing", () => {
    expect(mergeEntries("### Added\n\n- a1", "")).toBe("### Added\n\n- a1\n");
  });
});

describe("fold: an unreleased own version carries the new surface, and no release is cut", () => {
  const folded = withSurfaceFolded(changelog, { version: "0.1.0", surface: "0.12.1" });
  const sections = folded.split(/^## /m);

  it("the undated section names the new surface and stays undated; [Unreleased] is left empty", () => {
    expect(sections[1]!.trim()).toBe("[Unreleased]");
    expect(sections[2]!.startsWith("[0.1.0]\n\nSurface: `@mnemoverse/mcp-memory-server` 0.12.1.\n")).toBe(true);
    expect(folded).not.toContain("0.11.0");
    expect(sectionDate(folded, "0.1.0")).toBeNull();
  });

  it("the unreleased entries join the section's own groups, one heading each", () => {
    const release = sections[2]!;
    expect(release.match(/^### Added$/gm)).toHaveLength(1);
    expect(release.match(/^### Changed$/gm)).toHaveLength(1);
    expect(release.indexOf("- The first release.")).toBeLessThan(release.indexOf("- Something not yet released."));
    expect(release).toContain("- Something changed and not yet released.");
    expect(release).not.toContain("Exposes the MCP surface");
  });

  it("the links are untouched, and nothing is tripled", () => {
    expect(folded).toContain("[Unreleased]: https://github.com/mnemoverse/ai-sdk/compare/v0.1.0...HEAD");
    expect(folded).toContain("[0.1.0]: https://github.com/mnemoverse/ai-sdk/releases/tag/v0.1.0");
    expect(folded).not.toContain("\n\n\n");
  });

  it("refuses to fold into a released section", () => {
    expect(() => withSurfaceFolded(released, { version: "0.1.0", surface: "0.12.1" })).toThrow(/undated/);
  });
});

describe("README surface line", () => {
  it("moves to the new surface version", () => {
    expect(withReadmeSurface(readme, "0.12.1")).toContain("Surface: `@mnemoverse/mcp-memory-server` 0.12.1 (see Versions below).");
  });

  it("refuses a README without the line", () => {
    expect(() => withReadmeSurface("# nothing\n", "0.12.1")).toThrow(/Surface/);
  });
});

describe("planBump", () => {
  it("unreleased own version: fold, own version kept", () => {
    const plan = planBump({ pkg, changelog, readme, target: "0.12.1", date: "2026-09-25" });
    expect(plan).toMatchObject({ mode: "fold", kind: "minor", previousSurface: "0.11.0", previousVersion: "0.1.0", version: "0.1.0" });
    expect(plan.pkg.dependencies["@mnemoverse/mcp-memory-server"]).toBe("0.12.1");
    expect(plan.pkg.version).toBe("0.1.0");
    expect(plan.readme).toContain("0.12.1");
  });

  it("released own version: a release is cut by the version rule, dated", () => {
    const plan = planBump({ pkg, changelog: released, readme, target: "0.11.1", date: "2026-10-01" });
    expect(plan).toMatchObject({ mode: "release", kind: "patch", version: "0.1.1" });
    expect(sectionDate(plan.changelog, "0.1.1")).toBe("2026-10-01");
    expect(plan.changelog).toContain("Surface: `@mnemoverse/mcp-memory-server` 0.11.1.");
    expect(plan.pkg.version).toBe("0.1.1");
  });

  it("refuses a package.json version the CHANGELOG does not have", () => {
    expect(() => planBump({ pkg: { ...pkg, version: "0.3.0" }, changelog, readme, target: "0.12.1", date: "2026-09-25" })).toThrow(
      /\[0\.3\.0\]/,
    );
  });

  it("refuses a target that is not newer than the pin", () => {
    expect(() => planBump({ pkg, changelog, readme, target: "0.11.0", date: "2026-09-25" })).toThrow(/not newer/);
  });
});

describe("parseArgs", () => {
  it("reads the target, the date and the flags", () => {
    expect(parseArgs(["0.12.1", "--date", "2026-10-01", "--json"])).toEqual({
      target: "0.12.1",
      date: "2026-10-01",
      dryRun: false,
      json: true,
    });
  });

  it("refuses a target that is not x.y.z, and a bad date", () => {
    expect(() => parseArgs(["latest"])).toThrow();
    expect(() => parseArgs(["0.12.1", "--date", "tomorrow"])).toThrow(/YYYY-MM-DD/);
  });
});
