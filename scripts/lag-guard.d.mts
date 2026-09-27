export declare const PACKAGE: string;
export declare function declaredRange(pkg: unknown): string | null;
export declare function lockedVersion(lockText: string): string | null;
export declare function parseVersion(v: string | null | undefined): [number, number, number] | null;
export declare function verdict(pinned: string, latest: string): "current" | "behind" | "ahead" | "unreadable";
export declare function hoursSince(publishedAt: string | null | undefined, now?: number): number;
export declare function evaluate(input: {
  range: string | null;
  locked: string | null;
  npm: { latest: string; publishedAt: string | null };
  graceHours?: number;
  now?: number;
}): { ok: boolean; message: string };
export declare function parseArgs(argv: string[]): { graceHours: number };
