type Expected = { repository: string; workflow: string; refs: (version: string) => string[] };
export declare const PACKAGE: string;
export declare const SLSA_V1: string;
export declare const EXPECTED: Expected;
export declare const SELF: { name: string; expected: Expected };
export declare function purl(name: string, version: string): string;
export declare function statementOf(attestation: unknown): any;
export declare function integrityHex(integrity: string | null | undefined): string | null;
export declare function evaluate(input: {
  name?: string;
  version: string;
  entry: unknown;
  bundle: unknown;
  expected?: Expected;
}): { ok: boolean; message: string };
export declare function modeFor(packument: unknown): { mode: "required" | "advisory"; attested: string[] };
export declare function parseArgs(argv: string[]): {
  version: string | undefined;
  advisory: boolean;
  auto: boolean;
  self: boolean;
  json: boolean;
};
