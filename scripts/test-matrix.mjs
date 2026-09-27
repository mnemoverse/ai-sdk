#!/usr/bin/env node
/**
 * The compatibility matrix, in temporary directories (nothing here touches
 * this repository's node_modules):
 *
 *   node scripts/test-matrix.mjs              # ai 5, 6 and 7, then the consumer legs
 *   node scripts/test-matrix.mjs --ai 6       # one major only (what CI's matrix calls)
 *   node scripts/test-matrix.mjs --legs       # the consumer legs only (CI's legs job)
 *   node scripts/test-matrix.mjs --latest     # newest of each major instead (canary; majors only)
 *   node scripts/test-matrix.mjs --keep       # leave the temp dirs for inspection
 *
 * MAJORS. Per ai major, in a copy of this repo with that major's `ai` and
 * `@ai-sdk/mcp` as devDependencies: install, typecheck src + tests against
 * that major's types, run the whole vitest suite (the contract tests
 * included), build, and run the CJS and ESM smoke tests on the built output.
 * Where the MCP client lives: from ai 5.0.79 on it is not in `ai` but in the
 * separate @ai-sdk/mcp package, whose major follows the ai major (npm
 * dist-tags ai-v5 → 0.0.x, ai-v6 → 1.0.x, latest → 2.0.x for ai 7).
 *
 * CONSUMER LEGS. The packed package, installed the way an application
 * installs it (pnpm and npm), with the dependency resolutions this package
 * does not support: a zod the package's schemas do not work with, and an
 * `ai` / `@ai-sdk/mcp` pair outside the matrix. Each must fail LOUDLY (a
 * refused or warned install, and an error when the tools are created), never
 * degrade silently. One supported install per package manager is the control.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The verified pairs. `tag` is the npm dist-tag each resolves from with --latest. */
export const MATRIX = {
  5: { ai: "5.0.265", mcp: "0.0.35", aiTag: "ai-v5", mcpTag: "ai-v5" },
  6: { ai: "6.0.290", mcp: "1.0.85", aiTag: "ai-v6", mcpTag: "ai-v6" },
  7: { ai: "7.0.113", mcp: "2.0.57", aiTag: "latest", mcpTag: "latest" },
};

/**
 * Consumer installs that must fail loudly (and two that must work).
 *
 *   install  "loud": pnpm must warn about the unmet zod peer (or refuse);
 *            "refused": npm must refuse (ERESOLVE), then it is retried with
 *            --legacy-peer-deps, as a developer silencing it would;
 *            "ok": a clean install.
 *   outcome  what scripts/consumer-probe.mjs must report.
 */
export const LEGS = [
  { id: "zod 3.25 (pnpm)", pm: "pnpm", ai: "5.0.265", mcp: "0.0.35", zod: "3.25.76", install: "loud", outcome: "surface-error" },
  { id: "zod 4.1 (pnpm)", pm: "pnpm", ai: "6.0.290", mcp: "1.0.85", zod: "4.1.13", install: "loud", outcome: "surface-error" },
  { id: "zod 3.25 (npm)", pm: "npm", ai: "7.0.113", mcp: "2.0.57", zod: "3.25.76", install: "refused", outcome: "surface-error" },
  { id: "ai 5 + @ai-sdk/mcp latest", pm: "pnpm", ai: "5.0.265", mcp: "latest", zod: "4.6.5", install: "ok", outcome: "config-error:incompatible_ai_versions" },
  { id: "control: zod 4 (pnpm)", pm: "pnpm", ai: "6.0.290", mcp: "1.0.85", zod: "4.6.5", install: "ok", outcome: "ok" },
  { id: "control: zod 4 (npm)", pm: "npm", ai: "7.0.113", mcp: "2.0.57", zod: "4.6.5", install: "ok", outcome: "ok" },
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const COPY = [
  "package.json",
  "tsconfig.json",
  "tsup.config.ts",
  "vitest.config.ts",
  "src",
  "test",
  "scripts",
  ".github",
  "docs",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** stdout + stderr of a command, and whether it succeeded. */
function attempt(cmd, args, cwd) {
  try {
    return { ok: true, out: run(cmd, args, cwd) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}\n${error.stderr ?? ""}` };
  }
}

/**
 * A copy of the repository. The majors resolve afresh within the declared
 * ranges (no lockfile), as an application installing today would; the pack
 * for the consumer legs installs from the lockfile.
 */
function copyRepo(prefix, { lockfile = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const entry of lockfile ? [...COPY, "pnpm-lock.yaml"] : COPY) {
    if (existsSync(join(root, entry))) cpSync(join(root, entry), join(dir, entry), { recursive: true });
  }
  return dir;
}

function runMajors(majors, { latest, keep }) {
  const steps = [
    ["install", [pnpm, "install", "--ignore-workspace", "--no-frozen-lockfile", "--prefer-offline", "--reporter=silent"]],
    ["typecheck", [pnpm, "exec", "tsc", "--noEmit", "-p", "tsconfig.json"]],
    ["test", [pnpm, "exec", "vitest", "run", "--reporter=dot"]],
    ["build", [pnpm, "exec", "tsup", "--silent"]],
    ["smoke:cjs", [process.execPath, "scripts/smoke-cjs.cjs"]],
    ["smoke:esm", [process.execPath, "scripts/smoke-esm.mjs"]],
  ];
  const results = [];
  for (const major of majors) {
    const pair = MATRIX[major];
    if (!pair) throw new Error(`no matrix entry for ai ${major}`);
    const want = latest ? { ai: pair.aiTag, mcp: pair.mcpTag } : { ai: pair.ai, mcp: pair.mcp };
    const dir = copyRepo(`mnemoverse-ai-sdk-ai${major}-`);
    const row = { major, ai: "-", "@ai-sdk/mcp": "-", node: process.version };
    let failed = false;
    try {
      const pkgPath = join(dir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      pkg.devDependencies.ai = want.ai;
      pkg.devDependencies["@ai-sdk/mcp"] = want.mcp;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      for (const [name, [cmd, ...cmdArgs]] of steps) {
        if (failed) {
          row[name] = "skipped";
          continue;
        }
        const t0 = Date.now();
        try {
          const out = run(cmd, cmdArgs, dir);
          row[name] = `ok ${((Date.now() - t0) / 1000).toFixed(1)}s`;
          if (name === "test") {
            const summary = out.match(/Tests\s+(\d+ passed[^\n]*)/);
            if (summary) row.tests = summary[1].trim();
          }
          if (name === "install") {
            const req = createRequire(join(dir, "package.json"));
            row.ai = req("ai/package.json").version;
            row["@ai-sdk/mcp"] = req("@ai-sdk/mcp/package.json").version;
          }
        } catch (error) {
          failed = true;
          row[name] = "FAILED";
          console.error(`\n--- ai ${major}: ${name} failed ---`);
          console.error(String(error.stdout ?? "").slice(-6000));
          console.error(String(error.stderr ?? "").slice(-6000));
        }
      }
    } finally {
      if (keep) console.log(`kept ${dir}`);
      else rmSync(dir, { recursive: true, force: true });
    }
    row.result = failed ? "FAIL" : "PASS";
    results.push(row);
  }
  return results;
}

/** Build and pack this repo once, in a copy; returns the tarball path and the copy (to remove). */
function packOnce() {
  const dir = copyRepo("mnemoverse-ai-sdk-pack-", { lockfile: true });
  run(pnpm, ["install", "--ignore-workspace", "--frozen-lockfile", "--prefer-offline", "--reporter=silent"], dir);
  run(pnpm, ["exec", "tsup", "--silent"], dir);
  run(pnpm, ["pack", "--pack-destination", dir], dir);
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack produced no tarball");
  return { tarball: join(dir, tarball), dir };
}

function runLegs({ keep }) {
  const results = [];
  const { tarball, dir: packDir } = packOnce();
  try {
    for (const leg of LEGS) {
      const dir = mkdtempSync(join(tmpdir(), "mnemoverse-ai-sdk-leg-"));
      const row = { leg: leg.id, install: "-", outcome: "-", expected: `${leg.install} / ${leg.outcome}` };
      let failed = false;
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify(
            {
              name: "consumer",
              private: true,
              type: "module",
              dependencies: { "@mnemoverse/ai-sdk": `file:${tarball}`, ai: leg.ai, "@ai-sdk/mcp": leg.mcp, zod: leg.zod },
            },
            null,
            2,
          ),
        );
        cpSync(join(root, "scripts", "consumer-probe.mjs"), join(dir, "probe.mjs"));
        const install =
          leg.pm === "pnpm"
            ? attempt(pnpm, ["install", "--ignore-workspace", "--prefer-offline", "--reporter=append-only"], dir)
            : attempt(npm, ["install", "--no-audit", "--no-fund", "--prefer-offline"], dir);
        const warnedZod = /unmet peer zod@/i.test(install.out);
        const eresolve = /ERESOLVE/.test(install.out);
        if (leg.install === "ok") {
          row.install = install.ok ? "ok" : "FAILED";
          failed ||= !install.ok;
        } else if (leg.install === "loud") {
          row.install = !install.ok ? "refused" : warnedZod ? "warned (unmet zod peer)" : "SILENT";
          failed ||= install.ok && !warnedZod;
        } else {
          row.install = !install.ok && eresolve ? "refused (ERESOLVE)" : install.ok ? "SILENT" : "FAILED (not ERESOLVE)";
          failed ||= !(!install.ok && eresolve);
        }
        // A refused install is retried the way a developer would silence it.
        let installed = install.ok;
        if (!install.ok && !failed) {
          const forced =
            leg.pm === "pnpm"
              ? attempt(pnpm, ["install", "--ignore-workspace", "--prefer-offline", "--config.strict-peer-dependencies=false"], dir)
              : attempt(npm, ["install", "--no-audit", "--no-fund", "--prefer-offline", "--legacy-peer-deps"], dir);
          installed = forced.ok;
          row.install += forced.ok ? ", forced" : ", forced install FAILED";
          failed ||= !forced.ok;
          if (!forced.ok) console.error(forced.out.slice(-4000));
        }
        if (installed) {
          const out = attempt(process.execPath, ["probe.mjs"], dir);
          const line = out.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
          const probe = line ? JSON.parse(line) : { outcome: "crash", detail: out.out.slice(-2000) };
          row.outcome = probe.outcome;
          row.versions = Object.entries(probe.versions ?? {})
            .map(([k, v]) => `${k} ${v}`)
            .join(", ");
          if (probe.outcome !== leg.outcome) {
            failed = true;
            console.error(`\n--- ${leg.id}: expected ${leg.outcome}, got ${probe.outcome} ---\n${probe.detail ?? ""}`);
          }
        } else if (!failed) {
          failed = true;
        }
        if (failed && !install.ok) console.error(`\n--- ${leg.id}: install output ---\n${install.out.slice(-4000)}`);
      } catch (error) {
        failed = true;
        console.error(`\n--- ${leg.id}: ${error?.message ?? error} ---`);
      } finally {
        if (keep) console.log(`kept ${dir}`);
        else rmSync(dir, { recursive: true, force: true });
      }
      row.result = failed ? "FAIL" : "PASS";
      results.push(row);
    }
  } finally {
    if (keep) console.log(`kept ${packDir}`);
    else rmSync(packDir, { recursive: true, force: true });
  }
  return results;
}

function main(argv) {
  const keep = argv.includes("--keep");
  const latest = argv.includes("--latest");
  const legsOnly = argv.includes("--legs");
  const oneMajor = argv.includes("--ai");
  const majors = (oneMajor ? argv[argv.indexOf("--ai") + 1] : "5,6,7")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let ok = true;
  if (!legsOnly) {
    const rows = runMajors(majors, { latest, keep });
    console.table(rows);
    ok &&= rows.every((r) => r.result === "PASS");
  }
  if (legsOnly || (!oneMajor && !latest)) {
    const rows = runLegs({ keep });
    console.table(rows);
    ok &&= rows.every((r) => r.result === "PASS");
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
