#!/usr/bin/env node
/**
 * Provenance gate: was this @mnemoverse/mcp-memory-server version built and
 * published by the package's own release workflow?
 *
 * The contract tests compare this package with the SAME installed upstream,
 * so they cannot tell an authentic release from a tampered one that keeps the
 * surface byte-identical and adds behaviour. That matters here: the package
 * runs in the application's process, and every request (API key included)
 * passes through it. So before a bump merges without a person, the new
 * version must carry npm provenance whose SLSA predicate names the expected
 * source repository and release workflow (docs/AUTO-UPDATE-CONTOUR.md, step 5)
 * once the package attests at all (modeFor); until then the contour relies on
 * scripts/check-upstream-release.mjs, which a stolen npm token cannot pass.
 *
 *   node scripts/check-provenance.mjs                   # the pinned version
 *   node scripts/check-provenance.mjs --version 0.12.0  # a candidate
 *   node scripts/check-provenance.mjs --advisory        # report only: exit 0, warn in CI
 *   node scripts/check-provenance.mjs --auto --version 0.12.2 --json
 *        # what the surface-bump contour runs: ADVISORY while no version of
 *        # the package has ever carried attestations, REQUIRED from the first
 *        # one on (see modeFor below); the last line is the decision as JSON
 *   node scripts/check-provenance.mjs --self --version 0.1.0
 *        # THIS package's own publish, checked by release.yml after it
 *        # publishes: our repository, our release.yml, the release tag
 *
 * Exit 0: verified (or not verified in advisory mode). Exit 1: not verified
 * where it is required, or the registry could not be read.
 *
 * What is checked, from the public npm registry (no credentials):
 *   1. the version's dist.attestations include an SLSA v1 provenance;
 *   2. the provenance statement's subject is the version's package URL as npm
 *      writes it (`purl` below: pkg:npm/%40scope/name@x.y.z for a scoped
 *      name), and its sha512 digest equals the version's dist.integrity;
 *   3. the predicate's workflow repository and path are EXPECTED below (this
 *      repository's own configuration, never read from the package, whose
 *      metadata a tampered release controls), and its ref is the release tag
 *      or the default branch.
 * The registry verifies an attestation's Sigstore signature when it accepts
 * the publish; `npm audit signatures` re-verifies signatures on an installed
 * tree, and the bump bot runs it as well. Registry signatures alone prove
 * nothing about the publisher: the registry signs every tarball it accepts.
 */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PACKAGE = "@mnemoverse/mcp-memory-server";

/** Who may build a release of PACKAGE: its repository and its release workflow. */
export const EXPECTED = {
  repository: "https://github.com/mnemoverse/mcp-memory-server",
  workflow: ".github/workflows/release.yml",
  refs: (version) => [`refs/tags/v${version}`, "refs/heads/main"],
};

/**
 * This package's own publishes: npm trusted publishing from this repository's
 * release workflow, on the release tag (never a branch: release.yml refuses
 * to run on anything but a tag, so the provenance names the exact commit).
 */
export const SELF = {
  name: "@mnemoverse/ai-sdk",
  expected: {
    repository: "https://github.com/mnemoverse/ai-sdk",
    workflow: ".github/workflows/release.yml",
    refs: (version) => [`refs/tags/v${version}`],
  },
};

export const SLSA_V1 = "https://slsa.dev/provenance/v1";
const REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 20_000;

/** The in-toto statement of an attestation bundle, or null. */
export function statementOf(attestation) {
  const payload = attestation?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string") return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The package URL npm puts in a provenance subject, exactly as npm builds it:
 * libnpmpublish names the subject `npa.toPurl(spec)`, and npm-package-arg's
 * toPurl encodes a scope's leading `@` as `%40` (the purl spec reserves `@`
 * for the version). So @mnemoverse/ai-sdk@0.1.0 is attested as
 * `pkg:npm/%40mnemoverse/ai-sdk@0.1.0`, never `pkg:npm/@mnemoverse/...`.
 * Both packages this script checks are scoped, so comparing with the
 * unencoded form refused every real attestation.
 */
export function purl(name, version) {
  return `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
}

/** `sha512-<base64>` → hex, or null. */
export function integrityHex(integrity) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity ?? "");
  return m ? Buffer.from(m[1], "base64").toString("hex") : null;
}

/**
 * The whole decision, pure. `entry` is the registry's document for one
 * version; `bundle` is the JSON its dist.attestations.url serves (or null).
 * Returns { ok, message }.
 */
export function evaluate({ name = PACKAGE, version, entry, bundle, expected = EXPECTED }) {
  const who = `${name}@${version}`;
  const refuse = (why) => ({
    ok: false,
    message: `✗ ${who} has no verified provenance: ${why}.`,
  });
  if (entry?.version !== version) return refuse("the registry has no such version");
  const declared = entry?.dist?.attestations;
  if (!declared) return refuse("npm shows no attestations (it was not published with provenance)");
  if (declared.provenance?.predicateType !== SLSA_V1) {
    return refuse(`its provenance is not SLSA v1 (${declared.provenance?.predicateType ?? "none"})`);
  }
  const provenance = (bundle?.attestations ?? []).find((a) => a?.predicateType === SLSA_V1);
  const statement = statementOf(provenance);
  if (!statement) return refuse("the provenance attestation could not be read");
  const want = purl(name, version);
  const subject = (statement.subject ?? []).find((s) => s?.name === want);
  if (!subject) return refuse(`the provenance is for ${statement.subject?.[0]?.name ?? "nothing"}, not ${want}`);
  const digest = integrityHex(entry.dist.integrity);
  if (!digest || subject.digest?.sha512 !== digest) return refuse("the provenance digest does not match the published tarball");
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  if (workflow.repository !== expected.repository) {
    return refuse(`it was built from ${workflow.repository ?? "an unnamed repository"}, not ${expected.repository}`);
  }
  if (workflow.path !== expected.workflow) {
    return refuse(`it was built by ${workflow.path ?? "an unnamed workflow"}, not ${expected.workflow}`);
  }
  if (!expected.refs(version).includes(workflow.ref)) {
    return refuse(`it was built from ${workflow.ref ?? "an unnamed ref"}, not ${expected.refs(version).join(" or ")}`);
  }
  return { ok: true, message: `✓ ${who}: SLSA provenance from ${workflow.repository} ${workflow.path} at ${workflow.ref}` };
}

/**
 * ADVISORY or REQUIRED, decided by the package's own history, never by a
 * setting someone has to remember to flip. While no version of the package
 * has ever carried attestations (0.11.0 to 0.12.1 were published with a
 * token), a missing provenance is the known state: the contour warns and
 * goes on. From the first attested version on, provenance is how releases
 * are made, so a version without it is either a mistake or a release that
 * did not come from the release workflow (a stolen token), and it stops the
 * contour. An attacker cannot switch the gate back to advisory by publishing
 * without provenance: the attested versions stay in the packument.
 */
export function modeFor(packument) {
  const versions = packument?.versions && typeof packument.versions === "object" ? packument.versions : {};
  const attested = Object.keys(versions).filter((v) => Boolean(versions[v]?.dist?.attestations));
  return { mode: attested.length > 0 ? "required" : "advisory", attested };
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "mnemoverse-ai-sdk-provenance" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function parseArgs(argv) {
  const i = argv.indexOf("--version");
  const version = i === -1 ? undefined : argv[i + 1];
  if (i !== -1 && !/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("--version needs an x.y.z version");
  const args = {
    version,
    advisory: argv.includes("--advisory"),
    auto: argv.includes("--auto"),
    self: argv.includes("--self"),
    json: argv.includes("--json"),
  };
  if ([args.advisory, args.auto, args.self].filter(Boolean).length > 1) {
    throw new Error("--advisory, --auto and --self are exclusive");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const name = args.self ? SELF.name : PACKAGE;
  const expected = args.self ? SELF.expected : EXPECTED;
  const version = args.version ?? (args.self ? pkg.version : pkg.dependencies?.[PACKAGE]);
  const encoded = name.replace("/", "%2f");
  const entry = await getJson(`${REGISTRY}/${encoded}/${version}`);
  const url = entry?.dist?.attestations?.url;
  // Only the registry's own attestation endpoint is asked, whatever the document says.
  const bundle =
    typeof url === "string" && url.startsWith(`${REGISTRY}/-/npm/v1/attestations/`) ? await getJson(url) : null;
  const result = evaluate({ name, version, entry, bundle, expected });
  let mode = args.advisory ? "advisory" : "required";
  let attested = [];
  if (args.auto) {
    const packument = await getJson(`${REGISTRY}/${encoded}`);
    if (packument === null) throw new Error(`the registry has no ${name}`);
    ({ mode, attested } = modeFor(packument));
  }
  const report = () => {
    if (args.json) console.log(JSON.stringify({ name, version, mode, verified: result.ok, message: result.message, attested }));
  };
  if (result.ok) {
    console.log(result.message);
    report();
    return 0;
  }
  if (mode === "advisory") {
    const why = args.auto ? " (advisory: no version of the package has ever carried attestations)" : "";
    console.log(process.env.GITHUB_ACTIONS ? `::warning title=Upstream provenance::${result.message}${why}` : `${result.message}${why}`);
    report();
    return 0;
  }
  const why = args.auto
    ? ` Required, because ${attested.length} version(s) of the package carry attestations (${attested.slice(-3).join(", ")}):` +
      " a release without them did not come from its release workflow. Nothing is bumped or published on it until a person has checked it."
    : args.self
      ? " This package's own release must carry provenance from its release workflow: check the publish before announcing it."
      : " A person must approve this version; do not auto-merge it.";
  console.error(process.env.GITHUB_ACTIONS ? `::error title=Provenance::${result.message}${why}` : `${result.message}${why}`);
  report();
  return 1;
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
