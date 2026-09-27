export declare const SURFACE_PACKAGE: string;
export declare const OWN_PACKAGE: string;
export declare const ADVISORY_COOLDOWN_HOURS: number;
export declare function cooldownFor(configured: number | null | undefined, provenanceMode: "advisory" | "required" | undefined): number;
export declare function plan(input: {
  pinned: string;
  latest: string;
  dispatched?: string | null;
  own: string;
  ownDate: string | null | undefined;
  ownOnNpm: boolean;
  tagExists: boolean;
  latestPublishedAt?: string | null;
  cooldownHours?: number | null;
  provenanceMode?: "advisory" | "required";
  now?: number;
}): {
  action: "bump" | "release" | "blocked" | "wait" | "none";
  target: string | null;
  pinned: string;
  latest: string;
  own: string;
  tag: string;
  reason: string;
  notes: string[];
  cooldownHours?: number;
};
export declare function parseArgs(argv: string[]): { dispatched: string | undefined; json: boolean; cooldownHours: number | null };
