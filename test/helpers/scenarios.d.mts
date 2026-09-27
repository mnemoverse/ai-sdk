import type { Routes } from "./fixture-fetch.mjs";

export interface Scenario {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  routes: Routes;
}

export declare const SCENARIOS: Scenario[];
