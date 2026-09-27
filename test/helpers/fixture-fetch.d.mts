export interface ResponseSpec {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  reject?: string;
  bodyError?: string;
  hang?: boolean;
}

export type Routes = Record<string, ResponseSpec | ResponseSpec[]>;

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: string | null;
  hasSignal: boolean;
}

export interface FixtureFetch {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
  unmatched: string[];
  reset(): void;
}

export declare function fixtureFetch(routes: Routes, opts?: { baseUrl?: string }): FixtureFetch;
