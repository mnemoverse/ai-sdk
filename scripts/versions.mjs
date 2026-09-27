/**
 * The two versions this package reports, read at build (and test) time:
 * its own, from package.json, and the surface version, from the INSTALLED
 * @mnemoverse/mcp-memory-server (plus the zod range that package declares).
 * Refuses to continue when the installed copy is not exactly the pinned one,
 * so a build can never report a surface it does not carry.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const SURFACE_PACKAGE = "@mnemoverse/mcp-memory-server";

const root = fileURLToPath(new URL("../", import.meta.url));

function installedSurfacePackage() {
  const require = createRequire(`${root}package.json`);
  return JSON.parse(readFileSync(require.resolve(`${SURFACE_PACKAGE}/package.json`), "utf8"));
}

export function installedSurfaceVersion() {
  return installedSurfacePackage().version;
}

export function versionDefines(pkg) {
  const pinned = pkg.dependencies?.[SURFACE_PACKAGE];
  const surface = installedSurfacePackage();
  const installed = surface.version;
  if (!/^\d+\.\d+\.\d+$/.test(pinned ?? "")) {
    throw new Error(`${SURFACE_PACKAGE} must be pinned to an exact x.y.z version, found ${JSON.stringify(pinned)}.`);
  }
  if (installed !== pinned) {
    throw new Error(`${SURFACE_PACKAGE}: package.json pins ${pinned} but ${installed} is installed. Run pnpm install.`);
  }
  return {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
    __SURFACE_VERSION__: JSON.stringify(installed),
    // The zod range the package's schemas need, named in the error when the
    // installed zod converts them lossily (src/fidelity.ts).
    __SURFACE_ZOD_RANGE__: JSON.stringify(surface.dependencies?.zod ?? "unknown"),
  };
}
