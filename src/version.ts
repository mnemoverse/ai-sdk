/**
 * Versions, inlined at build time (tsup.config.ts `define`, and the same
 * `define` in vitest.config.ts for tests) from this package's package.json and
 * from the INSTALLED @mnemoverse/mcp-memory-server. The dependency is pinned
 * exactly, so the installed version is the pinned one; test/version.test.ts
 * checks all three agree.
 */
declare const __PACKAGE_VERSION__: string;
declare const __SURFACE_VERSION__: string;
declare const __SURFACE_ZOD_RANGE__: string;

/** This package's own semver. */
export const VERSION: string = __PACKAGE_VERSION__;

/**
 * The version of @mnemoverse/mcp-memory-server whose MCP surface (tool
 * descriptions, schemas, annotations, response text) these tools expose.
 */
export const SURFACE_VERSION: string = __SURFACE_VERSION__;

/**
 * The zod range the pinned @mnemoverse/mcp-memory-server declares for its
 * schemas, read from its package.json at build time. This package's `zod` peer
 * dependency is the same range (test/version.test.ts).
 */
export const SURFACE_ZOD_RANGE: string = __SURFACE_ZOD_RANGE__;
