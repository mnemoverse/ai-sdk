export declare const SURFACE_PACKAGE: string;
export declare const REPOSITORY: string;
export declare function sectionBody(text: string, version: string): string | undefined;
export declare function normaliseRepository(repository: unknown): string | null;
export declare function evaluateRelease(input: {
  tag: string;
  pkg: unknown;
  changelog: string;
  readme: string;
}): { problems: string[]; notes: string | undefined; version?: string; pin?: string };
export declare function parseArgs(argv: string[]): { tag: string; notes: string | undefined; offline: boolean };
