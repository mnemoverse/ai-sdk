/**
 * The two pnpm legs with an old zod change their expectation with the surface:
 * from mcp-memory-server 0.15.1 the package re-converts its own tools/list
 * schemas (#210), so those installs work; below it they fail loudly.
 */
import { describe, expect, it } from "vitest";
import { expectedOutcome, LEGS, surfaceReconvertsSchemas } from "../scripts/test-matrix.mjs";

describe("surfaceReconvertsSchemas", () => {
  it("is false below 0.15.1 and true from it", () => {
    expect(surfaceReconvertsSchemas("0.15.0")).toBe(false);
    expect(surfaceReconvertsSchemas("0.14.9")).toBe(false);
    expect(surfaceReconvertsSchemas("0.15.1")).toBe(true);
    expect(surfaceReconvertsSchemas("0.17.0")).toBe(true);
    expect(surfaceReconvertsSchemas("1.0.0")).toBe(true);
  });
});

describe("consumer legs", () => {
  it("the npm leg with an old zod still expects a loud surface error", () => {
    expect(LEGS.find((l) => l.id === "zod 3.25 (npm)")?.outcome).toBe("surface-error");
  });
  it("the two pnpm legs with an old zod follow the surface, resolved when the legs run", () => {
    for (const id of ["zod 3.25 (pnpm)", "zod 4.1 (pnpm)"]) {
      const leg = LEGS.find((l) => l.id === id)!;
      expect(expectedOutcome(leg, () => true)).toBe("ok");
      expect(expectedOutcome(leg, () => false)).toBe("surface-error");
    }
  });
  it("loading the matrix does not read the installed surface", async () => {
    // the matrix jobs import the file before installing anything
    expect(LEGS.every((l) => typeof l.outcome === "string")).toBe(true);
  });
});
