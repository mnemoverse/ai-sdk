export declare const UPSTREAM: { package: string; repository: string; branch: string };
export declare function evaluate(input: {
  version: string;
  ref: unknown;
  tag?: unknown;
  compare: unknown;
  release: unknown;
  upstream?: { package: string; repository: string; branch: string };
}): { ok: boolean; commit: string | null; message: string };
export declare function parseArgs(argv: string[]): { version: string | undefined; json: boolean };
