#!/usr/bin/env node
/**
 * Packs the package exactly as it would be published (`pnpm pack`; nothing is
 * uploaded), then checks the tarball holds only dist/, README.md,
 * CHANGELOG.md, LICENSE and package.json, and that "Are the types wrong?"
 * finds no problem for ESM or CJS consumers. Run after `pnpm run build`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const out = mkdtempSync(join(tmpdir(), "mnemoverse-pack-"));
try {
  execFileSync(pnpm, ["pack", "--pack-destination", out], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  const tarball = join(out, readdirSync(out).find((f) => f.endsWith(".tgz")));
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n").sort();
  const allowed = (f) =>
    /^package\/dist\/[^/]+$/.test(f) ||
    ["package/package.json", "package/README.md", "package/CHANGELOG.md", "package/LICENSE"].includes(f);
  const problems = files.filter((f) => !allowed(f)).map((f) => `unexpected ${f}`);
  for (const required of [
    "package/dist/index.js",
    "package/dist/index.cjs",
    "package/dist/index.d.ts",
    "package/dist/index.d.cts",
    "package/README.md",
    "package/LICENSE",
  ]) {
    if (!files.includes(required)) problems.push(`missing ${required}`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`pack OK: ${files.length} files`);
  }
  execFileSync(pnpm, ["exec", "attw", tarball, "--profile", "node16"], { cwd: root, stdio: "inherit" });
} finally {
  rmSync(out, { recursive: true, force: true });
}
