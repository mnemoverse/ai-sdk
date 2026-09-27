/**
 * The identity-bound `apiFetch` this package hands to the MCP package's
 * `registerMemoryTools`. It is the ONLY thing this package supplies to the MCP
 * surface; everything the model reads comes from the package.
 *
 * Contract (the `ApiFetch` type of @mnemoverse/mcp-memory-server/shared):
 * `apiFetch(path, init)` resolves with the parsed JSON body, or rejects with
 * the package's own `ApiError`, `NetworkError` or `UnreadableBodyError`, and
 * with nothing else, because the tools branch on which one.
 *
 *   - URL is `${baseUrl}${path}`, not normalised;
 *   - `Content-Type: application/json` and `X-Api-Key` on every request;
 *   - caller headers (the `headers` option, and any a handler passes) are
 *     normalised through `Headers`, and `x-api-key` and `authorization` are
 *     deleted in every letter case before the key is set, so no header can
 *     replace the credential or ride along beside it;
 *   - a default per-request timeout, MERGED (AbortSignal.any) with the
 *     handler's own signal (the package's scope probes pass a 4 s one), never
 *     substituted for it;
 *   - `redirect: "error"` is set LAST, so nothing can turn redirects back on:
 *     following one would re-send the key to whoever answered (CWE-200);
 *   - `fetch` rejecting → NetworkError; non-2xx → ApiError (with the body and
 *     `retry-after`); a body that cannot be read or parsed → UnreadableBodyError;
 *   - 204 or `content-length: 0` → `{}`.
 *
 * Configuration that can never work (no key, the documentation placeholder, a
 * key no HTTP header can carry, a base URL that would send the key in
 * cleartext, a malformed header) is refused by `createApiFetch` itself, when
 * the function is built, with MnemoverseConfigError. So the returned function
 * never needs a fourth error class, and a misconfigured key costs zero
 * requests.
 */
import {
  ApiError,
  NetworkError,
  UnreadableBodyError,
  type ApiFetch,
} from "@mnemoverse/mcp-memory-server/shared";
import { MnemoverseConfigError } from "./errors.js";
import { refuseBaseUrl, refuseKey } from "./refusals.js";

export type { ApiFetch };

/** Default per-request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The longest timeout a timer can hold (2^31 - 1 ms, about 24.8 days). A
 * larger delay does not wait longer: timers clamp it to 1 ms, so every request
 * would abort at once.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Header names a caller may never set; the credential is ours alone. */
const PROTECTED_HEADERS = ["x-api-key", "authorization"] as const;

/** What `headers` accepts: anything `new Headers()` does. */
export type HeadersOption = Record<string, string> | Headers | [string, string][];

export interface ApiFetchConfig {
  apiKey: string;
  baseUrl: string;
  /** Defaults to `globalThis.fetch`, looked up on every request. */
  fetch?: typeof globalThis.fetch;
  /** Per request: a whole number of milliseconds, 1 to MAX_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Extra headers for every request. Credential headers are dropped. */
  headers?: HeadersOption;
}

/**
 * Build the `apiFetch` for one identity (one key). Throws MnemoverseConfigError
 * synchronously for configuration that can never work.
 */
export function createApiFetch(config: ApiFetchConfig): ApiFetch {
  const { apiKey, baseUrl } = config;
  refuseKey(apiKey);
  refuseBaseUrl(baseUrl);
  const timeoutMs = config.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : config.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new MnemoverseConfigError(
      "invalid_option",
      `\`timeoutMs\` must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS} (about 24.8 days).`,
    );
  }
  if (config.fetch !== undefined && typeof config.fetch !== "function") {
    throw new MnemoverseConfigError("invalid_option", "`fetch` must be a function.");
  }
  const configuredHeaders = parseHeaders(config.headers);

  return async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();

    let headers: Headers;
    try {
      headers = new Headers({ "Content-Type": "application/json" });
      configuredHeaders.forEach((value, name) => headers.set(name, value));
      new Headers(options.headers).forEach((value, name) => headers.set(name, value));
      for (const name of PROTECTED_HEADERS) headers.delete(name);
      headers.set("X-Api-Key", apiKey);
    } catch {
      // Unreachable for the package's handlers (they pass no headers) and for
      // our own (validated above). The cause is replaced on purpose: a Headers
      // TypeError quotes the offending value, which can be a credential.
      throw new NetworkError(method, path, new Error("a request header could not be built"));
    }

    const signal = mergeSignals([options.signal ?? undefined, AbortSignal.timeout(timeoutMs)]);

    const fetchImpl = config.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        ...options,
        headers,
        signal,
        // LAST, so neither a handler's options nor anything above can turn
        // redirects back on.
        redirect: "error",
      });
    } catch (cause) {
      throw new NetworkError(method, path, cause);
    }

    if (!res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch (cause) {
        throw new UnreadableBodyError({ status: res.status, method, path, cause });
      }
      throw new ApiError({
        status: res.status,
        body: text,
        method,
        path,
        retryAfter: res.headers.get("retry-after"),
      });
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return {} as T;
    }

    let body: string;
    try {
      body = await res.text();
    } catch (cause) {
      throw new UnreadableBodyError({ status: res.status, method, path, cause });
    }
    try {
      return JSON.parse(body) as T;
    } catch (cause) {
      throw new UnreadableBodyError({ status: res.status, method, path, bodyPreview: body, cause });
    }
  };
}

/**
 * A header name shaped like an ordinary one (letters, digits, hyphens), the
 * only kind an error may repeat. Anything else can be a credential pasted in
 * whole as the name ("Authorization: Bearer …", or a bare token).
 */
const PLAIN_HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

/**
 * Parse the `headers` option once. On failure the message says which entry is
 * wrong and whether its name or its value is, but never repeats a value, and
 * repeats a name only when it is a plain one (PLAIN_HEADER_NAME): a header can
 * carry a secret, and this error ends up in logs.
 */
export function parseHeaders(input: HeadersOption | undefined): Headers {
  if (input !== undefined && (input === null || typeof input !== "object")) {
    throw new MnemoverseConfigError("invalid_option", "`headers` must be an object, a Headers or a list of pairs.");
  }
  try {
    return new Headers(input);
  } catch {
    throw new MnemoverseConfigError(
      "invalid_option",
      `\`headers\` is not a valid set of HTTP headers${describeInvalidHeader(input)}. Header values are not ` +
        "repeated here, nor names that are not plain header names.",
    );
  }
}

/** Which entry of a `headers` option `new Headers()` refused, without repeating anything secret. */
function describeInvalidHeader(input: HeadersOption | undefined): string {
  if (input === undefined || input instanceof Headers) return "";
  const entries: unknown[] = Array.isArray(input) ? input : Object.entries(input);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const at = `header ${i + 1} of ${entries.length}`;
    if (!Array.isArray(entry) || entry.length !== 2) return `: ${at} is not a [name, value] pair`;
    const name = String(entry[0]);
    if (!buildsHeader(name, "")) {
      return `: the name of ${at} is not a valid header name (it is not shown: a name with a colon, a space or a control character is often a credential pasted in whole)`;
    }
    if (!buildsHeader(name, String(entry[1]))) {
      const shown = PLAIN_HEADER_NAME.test(name) ? JSON.stringify(name) : `${at} (its name is not shown)`;
      return `: the value of ${shown} is not a valid header value (a line break or a control character?)`;
    }
  }
  return "";
}

function buildsHeader(name: string, value: string): boolean {
  try {
    new Headers([[name, value]]);
    return true;
  } catch {
    return false;
  }
}

/**
 * One signal that aborts when any of `signals` does, with the first reason.
 * `AbortSignal.any` where the runtime has it; a listener-based merge otherwise.
 */
export function mergeSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
  }
  const onAbort = (event: Event) => {
    controller.abort((event.target as AbortSignal).reason);
    for (const s of present) s.removeEventListener("abort", onAbort);
  };
  for (const s of present) s.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
