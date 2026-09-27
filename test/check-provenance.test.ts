/**
 * scripts/check-provenance.mjs: the provenance gate the auto-update contour
 * puts before any auto-merge (docs/AUTO-UPDATE-CONTOUR.md, step 5).
 *
 * Regression for the supply-chain finding: the contract tests compare this
 * package with the same installed upstream, so an upstream release that keeps
 * the surface identical but adds in-process behaviour was green and would
 * have been auto-merged. The gate refuses any version without SLSA provenance
 * from the package's own repository and release workflow, which includes
 * 0.11.0 today (published with a token, no attestations). The network half is
 * not tested here; these pin every decision from the registry's answers,
 * shaped like the real ones (ai@7.0.113 was used as the model), plus one
 * real, unedited attestation bundle of a scoped package (@ai-sdk/mcp@2.0.57,
 * as registry.npmjs.org serves it) in test/fixtures/provenance/.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXPECTED,
  evaluate,
  integrityHex,
  modeFor,
  PACKAGE,
  parseArgs,
  purl,
  SELF,
  SLSA_V1,
  statementOf,
} from "../scripts/check-provenance.mjs";

const VERSION = "0.12.0";
const TARBALL = Buffer.from("the tarball bytes");
const SHA512 = createHash("sha512").update(TARBALL).digest();
const INTEGRITY = `sha512-${SHA512.toString("base64")}`;

function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: PACKAGE,
    version: VERSION,
    dist: {
      integrity: INTEGRITY,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/${PACKAGE}@${VERSION}`,
        provenance: { predicateType: SLSA_V1 },
      },
    },
    ...overrides,
  };
}

function bundle({
  // npm's own form: the scope's `@` percent-encoded (see `purl`).
  subject = `pkg:npm/%40mnemoverse/mcp-memory-server@${VERSION}`,
  digest = SHA512.toString("hex"),
  repository = EXPECTED.repository,
  path = EXPECTED.workflow,
  ref = `refs/tags/v${VERSION}`,
} = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: subject, digest: { sha512: digest } }],
    predicateType: SLSA_V1,
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { ref, repository, path } },
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  const envelope = (predicateType: string, body: unknown) => ({
    predicateType,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      dsseEnvelope: { payload: Buffer.from(JSON.stringify(body)).toString("base64"), payloadType: "application/vnd.in-toto+json" },
    },
  });
  return {
    attestations: [
      envelope("https://github.com/npm/attestation/tree/main/specs/publish/v0.1", { subject: statement.subject }),
      envelope(SLSA_V1, statement),
    ],
  };
}

describe("the provenance gate", () => {
  it("names the package and its release workflow as the only accepted builder", () => {
    expect(PACKAGE).toBe("@mnemoverse/mcp-memory-server");
    expect(EXPECTED.repository).toBe("https://github.com/mnemoverse/mcp-memory-server");
    expect(EXPECTED.workflow).toBe(".github/workflows/release.yml");
  });

  it("verified: SLSA provenance for this exact tarball, from the package's repository and release workflow", () => {
    const result = evaluate({ version: VERSION, entry: entry(), bundle: bundle() });
    expect(result).toEqual({ ok: true, message: expect.stringContaining(`${PACKAGE}@${VERSION}`) });
    expect(evaluate({ version: VERSION, entry: entry(), bundle: bundle({ ref: "refs/heads/main" }) }).ok).toBe(true);
  });

  it("0.11.0 as npm serves it today (a token publish, no attestations) is not verified", () => {
    const today = { name: PACKAGE, version: "0.11.0", dist: { integrity: INTEGRITY, signatures: [{ keyid: "x", sig: "y" }] } };
    const result = evaluate({ version: "0.11.0", entry: today, bundle: null });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no attestations/);
  });

  it.each([
    ["another repository (a fork, or a compromised credential publishing from elsewhere)", { repository: "https://github.com/evil/mcp-memory-server" }, /built from https:\/\/github\.com\/evil/],
    ["another workflow in the right repository", { path: ".github/workflows/test.yml" }, /built by \.github\/workflows\/test\.yml/],
    ["a branch that is not the default one", { ref: "refs/heads/feature" }, /built from refs\/heads\/feature/],
    ["another package's provenance", { subject: "pkg:npm/other@0.12.0" }, /not pkg:npm/],
    ["another tarball (digest mismatch)", { digest: "00".repeat(64) }, /digest does not match/],
  ])("refuses provenance from %s", (_label, change, message) => {
    const result = evaluate({ version: VERSION, entry: entry(), bundle: bundle(change) });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(message);
  });

  it("refuses a missing version, a non-SLSA provenance and an unreadable bundle", () => {
    expect(evaluate({ version: VERSION, entry: null, bundle: null }).ok).toBe(false);
    const oldPredicate = entry();
    (oldPredicate.dist.attestations.provenance as { predicateType: string }).predicateType = "https://slsa.dev/provenance/v0.2";
    expect(evaluate({ version: VERSION, entry: oldPredicate, bundle: bundle() }).message).toMatch(/not SLSA v1/);
    expect(evaluate({ version: VERSION, entry: entry(), bundle: { attestations: [] } }).message).toMatch(/could not be read/);
  });

  it("decodes statements and integrity strings", () => {
    expect(integrityHex(INTEGRITY)).toBe(SHA512.toString("hex"));
    expect(integrityHex("sha1-abc")).toBeNull();
    expect(statementOf({ bundle: { dsseEnvelope: { payload: "not base64 json" } } })).toBeNull();
    expect(statementOf(bundle().attestations[1])?.predicateType).toBe(SLSA_V1);
  });

  it("parses its arguments", () => {
    const none = { version: undefined, advisory: false, auto: false, self: false, json: false };
    expect(parseArgs([])).toEqual(none);
    expect(parseArgs(["--version", "0.12.0", "--advisory"])).toEqual({ ...none, version: "0.12.0", advisory: true });
    expect(parseArgs(["--auto", "--version", "0.12.2", "--json"])).toEqual({ ...none, version: "0.12.2", auto: true, json: true });
    expect(() => parseArgs(["--version", "latest"])).toThrow(/x\.y\.z/);
    expect(() => parseArgs(["--auto", "--advisory"])).toThrow(/exclusive/);
    expect(() => parseArgs(["--self", "--auto"])).toThrow(/exclusive/);
  });
});

/**
 * Regression: the gate compared the subject with `pkg:npm/@scope/name@x.y.z`,
 * and npm writes `pkg:npm/%40scope/name@x.y.z` (libnpmpublish names the
 * subject npa.toPurl(spec), which encodes the scope's `@`). Every scoped
 * package was refused, both of the ones this script checks included: the
 * first release would have gone red after npm accepted it, and the contour
 * would have stopped for good once upstream attests. The fixtures above were
 * built the same wrong way, which is why nothing failed. This one is real.
 */
describe("npm's package URL for a scoped package", () => {
  const fixture = (file: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/provenance/${file}`, import.meta.url), "utf8"));
  const realEntry = fixture("ai-sdk-mcp-2.0.57.entry.json");
  const realBundle = fixture("ai-sdk-mcp-2.0.57.attestations.json");
  // What that package's own provenance names, as the expected builder.
  const vercel = {
    repository: "https://github.com/vercel/ai",
    workflow: ".github/workflows/release.yml",
    refs: () => ["refs/heads/main"],
  };

  it("is what npm-package-arg's toPurl returns (checked against npm 11.20.0 and 10.9.8)", () => {
    expect(purl("@mnemoverse/ai-sdk", "0.1.0")).toBe("pkg:npm/%40mnemoverse/ai-sdk@0.1.0");
    expect(purl("@mnemoverse/mcp-memory-server", "0.12.1")).toBe("pkg:npm/%40mnemoverse/mcp-memory-server@0.12.1");
    expect(purl("publint", "0.3.24")).toBe("pkg:npm/publint@0.3.24");
  });

  it("the real bundle npm serves for @ai-sdk/mcp@2.0.57 names the %40 form", () => {
    const names = (realBundle.attestations as unknown[]).map((a) => statementOf(a)?.subject?.[0]?.name);
    expect(names).toEqual(["pkg:npm/%40ai-sdk/mcp@2.0.57", "pkg:npm/%40ai-sdk/mcp@2.0.57"]);
  });

  it("verifies that real bundle: subject, digest, repository, workflow and ref", () => {
    const result = evaluate({ name: "@ai-sdk/mcp", version: "2.0.57", entry: realEntry, bundle: realBundle, expected: vercel });
    expect(result).toEqual({
      ok: true,
      message: "✓ @ai-sdk/mcp@2.0.57: SLSA provenance from https://github.com/vercel/ai .github/workflows/release.yml at refs/heads/main",
    });
  });

  it("still refuses that real bundle for another builder, version or tarball", () => {
    const other = { ...vercel, repository: "https://github.com/mnemoverse/ai-sdk" };
    expect(evaluate({ name: "@ai-sdk/mcp", version: "2.0.57", entry: realEntry, bundle: realBundle, expected: other }).ok).toBe(false);
    const tampered = { ...realEntry, dist: { ...realEntry.dist, integrity: INTEGRITY } };
    expect(evaluate({ name: "@ai-sdk/mcp", version: "2.0.57", entry: tampered, bundle: realBundle, expected: vercel }).message).toMatch(
      /digest does not match/,
    );
    expect(evaluate({ name: "@ai-sdk/other", version: "2.0.57", entry: { ...realEntry, name: "@ai-sdk/other" }, bundle: realBundle, expected: vercel }).message).toMatch(
      /is for pkg:npm\/%40ai-sdk\/mcp@2\.0\.57, not pkg:npm\/%40ai-sdk\/other@2\.0\.57/,
    );
  });

  it("our own two packages pass with npm's form of the subject, as the fixtures now build it", () => {
    expect(evaluate({ version: VERSION, entry: entry(), bundle: bundle() }).ok).toBe(true);
    expect(statementOf(bundle().attestations[1])?.subject?.[0]?.name).toBe(purl(PACKAGE, VERSION));
  });
});

/**
 * The contour keeps the gate ADVISORY while the package has never published
 * with provenance, and it becomes REQUIRED by itself from the first attested
 * version on: nobody has to remember to flip it, and nobody can flip it back
 * by publishing without provenance.
 */
describe("modeFor: advisory until the package attests, required from then on", () => {
  const plain = { dist: { integrity: INTEGRITY } };
  const attested = { dist: { integrity: INTEGRITY, attestations: { url: "x", provenance: { predicateType: SLSA_V1 } } } };

  it("advisory while no version carries attestations (0.11.0 to 0.12.1 today)", () => {
    expect(modeFor({ versions: { "0.11.0": plain, "0.12.0": plain, "0.12.1": plain } })).toEqual({ mode: "advisory", attested: [] });
  });

  it("required once any version carries them, including for a later version without them", () => {
    const packument = { versions: { "0.12.1": plain, "0.13.0": attested, "0.13.1": plain } };
    expect(modeFor(packument)).toEqual({ mode: "required", attested: ["0.13.0"] });
  });

  it("an unreadable packument is advisory with nothing attested, never a crash", () => {
    expect(modeFor(null)).toEqual({ mode: "advisory", attested: [] });
    expect(modeFor({ versions: "nope" })).toEqual({ mode: "advisory", attested: [] });
  });
});

/**
 * The release workflow checks this package's OWN publish with the same
 * decision: our repository, our release.yml, and only the release tag as the
 * ref (release.yml runs on tags only, so a branch ref means it did not).
 */
describe("SELF: this package's own provenance", () => {
  const name = SELF.name;
  const version = "0.1.0";
  const own = (overrides: Record<string, unknown> = {}) => ({
    ...entry(),
    name,
    version,
    dist: { ...entry().dist, attestations: { url: "x", provenance: { predicateType: SLSA_V1 } } },
    ...overrides,
  });
  const ownBundle = (change: Record<string, string> = {}) =>
    bundle({
      subject: `pkg:npm/%40mnemoverse/ai-sdk@${version}`,
      repository: SELF.expected.repository,
      path: SELF.expected.workflow,
      ref: `refs/tags/v${version}`,
      ...change,
    });

  it("expects this repository and its release workflow", () => {
    expect(SELF.expected.repository).toBe("https://github.com/mnemoverse/ai-sdk");
    expect(SELF.expected.workflow).toBe(".github/workflows/release.yml");
    expect(SELF.expected.refs(version)).toEqual(["refs/tags/v0.1.0"]);
  });

  it("verifies a publish from release.yml at the tag", () => {
    expect(evaluate({ name, version, entry: own(), bundle: ownBundle(), expected: SELF.expected }).ok).toBe(true);
  });

  it.each([
    ["the surface-bump workflow (a workflow_call caller would be recorded)", { path: ".github/workflows/surface-bump.yml" }],
    ["a branch instead of the tag", { ref: "refs/heads/main" }],
    ["the MCP package's repository", { repository: EXPECTED.repository }],
  ])("refuses %s", (_label, change) => {
    expect(evaluate({ name, version, entry: own(), bundle: ownBundle(change), expected: SELF.expected }).ok).toBe(false);
  });
});
