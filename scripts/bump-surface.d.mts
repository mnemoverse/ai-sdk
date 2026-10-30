export declare const PACKAGE: string;
export declare const SHARED: string[];
type Aligned = { name: string; from: string; to: string };
export declare function sharedAlignment(dependencies: Record<string, string> | undefined, surfaceDependencies: Record<string, string> | undefined): Aligned[];
type Kind = "major" | "minor" | "patch";
export declare function bumpKind(from: string, to: string): Kind;
export declare function nextVersion(own: string, kind: Kind): string;
export declare function sectionDate(text: string, version: string): string | null | undefined;
export declare function mergeEntries(into: string, from: string): string;
export declare function withChangelogSection(
  text: string,
  input: { version: string; previous: string; surface: string; previousSurface: string; date: string; aligned?: Aligned[] },
): string;
export declare function withSurfaceFolded(text: string, input: { version: string; surface: string }): string;
export declare function withReadmeSurface(text: string, surface: string): string;
export declare function planBump(input: {
  pkg: { version: string; dependencies: Record<string, string>; [key: string]: unknown };
  changelog: string;
  readme: string;
  target: string;
  date: string;
  surfaceDependencies?: Record<string, string>;
}): {
  mode: "fold" | "release";
  kind: Kind;
  previousSurface: string;
  surface: string;
  aligned: Aligned[];
  previousVersion: string;
  version: string;
  pkg: { version: string; dependencies: Record<string, string>; [key: string]: unknown };
  changelog: string;
  readme: string;
};
export declare function parseArgs(argv: string[]): { target: string; date: string; dryRun: boolean; json: boolean };
