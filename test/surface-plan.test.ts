/**
 * scripts/surface-plan.mjs: what one run of the surface-bump contour does.
 * Every state the repository can be in when a new upstream version appears,
 * including the ones a person has to finish first.
 */
import { describe, expect, it } from "vitest";
import { ADVISORY_COOLDOWN_HOURS, cooldownFor, parseArgs, plan } from "../scripts/surface-plan.mjs";

// No publish time: old enough for any cool-down (the cool-down has its own tests below).
const released = { pinned: "0.12.1", own: "0.1.0", ownDate: "2026-09-26", ownOnNpm: true, tagExists: true };

describe("plan", () => {
  it("bumps when npm's latest is newer and this package's version is released", () => {
    expect(plan({ ...released, latest: "0.12.2" })).toMatchObject({ action: "bump", target: "0.12.2", tag: "v0.1.0" });
    expect(plan({ ...released, latest: "0.13.0" })).toMatchObject({ action: "bump", target: "0.13.0" });
  });

  it("does nothing when the pin is current, or ahead of npm", () => {
    expect(plan({ ...released, latest: "0.12.1" })).toMatchObject({ action: "none", target: null });
    expect(plan({ ...released, pinned: "0.12.2", latest: "0.12.1" }).action).toBe("none");
  });

  it("re-publishes a tagged version npm does not serve, before anything newer", () => {
    const p = plan({ ...released, ownOnNpm: false, latest: "0.12.2" });
    expect(p).toMatchObject({ action: "release", tag: "v0.1.0", target: null });
    expect(plan({ ...released, ownOnNpm: false, latest: "0.12.1" }).action).toBe("release");
  });

  it("is blocked, not silent, when the own version is not released yet (the first release included)", () => {
    const p = plan({ ...released, ownDate: null, ownOnNpm: false, tagExists: false, latest: "0.12.2" });
    expect(p.action).toBe("blocked");
    expect(p.reason).toMatch(/not released yet/);
    expect(p.reason).toMatch(/Release v0\.1\.0 first/);
  });

  it("is blocked when the own version is dated but not tagged", () => {
    const p = plan({ ...released, ownOnNpm: false, tagExists: false, latest: "0.12.2" });
    expect(p.action).toBe("blocked");
    expect(p.reason).toMatch(/tag v0\.1\.0/);
  });

  it("waits quietly while a person prepares a release and the pin is current", () => {
    expect(plan({ ...released, ownDate: null, ownOnNpm: false, tagExists: false, latest: "0.12.1" }).action).toBe("none");
    expect(plan({ ...released, ownOnNpm: false, tagExists: false, latest: "0.12.1" }).action).toBe("none");
  });

  it("uses npm's latest as the target, whatever a dispatch says, and reports the difference", () => {
    const p = plan({ ...released, latest: "0.12.2", dispatched: "0.12.3" });
    expect(p.target).toBe("0.12.2");
    expect(p.notes.join("\n")).toMatch(/dispatched 0\.12\.3, but npm's latest is 0\.12\.2/);
    expect(plan({ ...released, latest: "0.12.2", dispatched: "$(evil)" }).notes.join("\n")).toMatch(/not x\.y\.z/);
    expect(plan({ ...released, latest: "0.12.2", dispatched: "0.12.2" }).notes).toEqual([]);
  });

  it("refuses to compare what is not x.y.z", () => {
    expect(() => plan({ ...released, latest: "0.13.0-rc.1" })).toThrow(/cannot compare/);
  });
});

/**
 * Regression for the finding: the cool-down defaulted to 0, so while upstream
 * provenance is advisory a version published with a leaked npm token was
 * bumped and republished by the next run, before anyone upstream could notice
 * and deprecate it. Now it is 6 h by default while advisory, 0 once upstream
 * attests, and SURFACE_BUMP_COOLDOWN_HOURS still decides when it is set.
 */
describe("cool-down", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const young = { ...released, latest: "0.12.2", latestPublishedAt: "2026-10-01T09:00:00Z", now };

  it("is 6 h by default while upstream provenance is advisory (or unknown), none once it is required", () => {
    expect(ADVISORY_COOLDOWN_HOURS).toBe(6);
    expect(cooldownFor(null, "advisory")).toBe(6);
    expect(cooldownFor(undefined, undefined)).toBe(6);
    expect(cooldownFor(null, "required")).toBe(0);
    expect(cooldownFor(0, "advisory")).toBe(0);
    expect(cooldownFor(12, "required")).toBe(12);
  });

  it("waits for a 3 h old release while advisory, by default, and says why", () => {
    const p = plan({ ...young, provenanceMode: "advisory" });
    expect(p).toMatchObject({ action: "wait", target: "0.12.2", cooldownHours: 6 });
    expect(p.reason).toMatch(/inside the 6 h cool-down \(the default while upstream provenance is advisory\)/);
    expect(plan({ ...young }).action).toBe("wait");
    expect(plan({ ...young, provenanceMode: "advisory", latestPublishedAt: "2026-10-01T05:59:00Z" }).action).toBe("bump");
  });

  it("bumps right away once upstream provenance is required", () => {
    expect(plan({ ...young, provenanceMode: "required" })).toMatchObject({ action: "bump", cooldownHours: 0 });
  });

  it("the repository variable decides when set, 0 included", () => {
    expect(plan({ ...young, provenanceMode: "required", cooldownHours: 6 })).toMatchObject({ action: "wait" });
    expect(plan({ ...young, provenanceMode: "required", cooldownHours: 6 }).reason).toMatch(/SURFACE_BUMP_COOLDOWN_HOURS/);
    expect(plan({ ...young, provenanceMode: "advisory", cooldownHours: 2 }).action).toBe("bump");
    expect(plan({ ...young, provenanceMode: "advisory", cooldownHours: 0 }).action).toBe("bump");
  });

  it("an unknown publish time is old enough (the lag guard has the same rule)", () => {
    expect(plan({ ...released, latest: "0.12.2", latestPublishedAt: null, cooldownHours: 6, now }).action).toBe("bump");
    expect(plan({ ...released, latest: "0.12.2", latestPublishedAt: null, provenanceMode: "advisory", now }).action).toBe("bump");
  });
});

describe("parseArgs", () => {
  it("reads the dispatched version, --json and the cool-down (unset or empty: the default)", () => {
    expect(parseArgs(["--dispatched", "0.12.2", "--json"])).toEqual({ dispatched: "0.12.2", json: true, cooldownHours: null });
    expect(parseArgs([])).toEqual({ dispatched: undefined, json: false, cooldownHours: null });
    expect(parseArgs(["--cooldown-hours", "6"]).cooldownHours).toBe(6);
    expect(parseArgs(["--cooldown-hours", "0"]).cooldownHours).toBe(0);
    expect(parseArgs(["--cooldown-hours", ""]).cooldownHours).toBeNull();
    expect(() => parseArgs(["--cooldown-hours", "-1"])).toThrow();
    expect(() => parseArgs(["--cooldown-hours", "six"])).toThrow();
  });
});
