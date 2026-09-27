/**
 * Configuration refusals, decided before any tool exists.
 *
 * They are thrown to the DEVELOPER (MnemoverseConfigError from
 * createMnemoverseTools), never shown to the model. The MCP package refuses
 * the same configurations inside each tool call instead, with model-facing
 * text addressed to an MCP client's user ("put it in the MCP client config and
 * restart the MCP server"), which would be wrong advice here, and most of that
 * text is private to the package's stdio entry module anyway.
 *
 * Text rule (the consumer rule of @mnemoverse/mcp-memory-server): where the
 * package EXPORTS a refusal, it is called, never re-typed. That is only the
 * placeholder-key check, `refusePlaceholderKey`, whose decision AND wording are
 * the package's. The package exports no refusal for a missing key or an
 * insecure base URL (both live module-private in its `src/index.ts`), so those
 * two messages below are this package's own, developer-facing, and
 * deliberately not copies of the package's model-facing sentences. The
 * unsendable-key check has no counterpart in the package at all.
 */
import { refusePlaceholderKey } from "@mnemoverse/mcp-memory-server/dist/requests.js";
import { MnemoverseConfigError } from "./errors.js";

/** The hosted API. The package's own default (module-private there) is the same URL. */
export const DEFAULT_BASE_URL = "https://core.mnemoverse.com/api/v1";

/** Throws MnemoverseConfigError unless `apiKey` can be sent as this identity's credential. */
export function refuseKey(apiKey: unknown): asserts apiKey is string {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new MnemoverseConfigError(
      "missing_key",
      "No Mnemoverse API key: pass `apiKey` to createMnemoverseTools() or set MNEMOVERSE_API_KEY. " +
        "Keys start with mk_live_ and are created in the Mnemoverse console.",
    );
  }
  const placeholder = refusePlaceholderKey(apiKey);
  if (placeholder !== undefined) {
    // The package's own sentence for this exact configuration, verbatim.
    throw new MnemoverseConfigError("placeholder_key", placeholder.startupLog);
  }
  if (isUnsendableKey(apiKey)) {
    throw new MnemoverseConfigError(
      "unsendable_key",
      "The Mnemoverse API key contains a line break or another character an HTTP header cannot " +
        "carry, so it cannot be sent (most likely it was pasted with a line break inside). The key " +
        "is not repeated here.",
    );
  }
}

/**
 * A key no HTTP header can carry. `Headers` rejects NUL, CR, LF and anything
 * above U+00FF with a TypeError that QUOTES THE WHOLE VALUE, and other control
 * characters are refused by the HTTP client later; either way the key would
 * end up in an error message. Leading and trailing spaces, tabs, CRs and LFs
 * are fine: fetch strips them before sending, so a key read from a file with a
 * trailing newline keeps working.
 */
export function isUnsendableKey(apiKey: string): boolean {
  const sent = apiKey.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
  return /[\u0000-\u0008\u000a-\u001f\u007f]|[^\u0000-ÿ]/.test(sent);
}

/**
 * Throws MnemoverseConfigError unless the key may be sent to `baseUrl`: https
 * anywhere; plain http only to the literal loopback hosts localhost, 127.0.0.1
 * and [::1] (a local engine). The URL is never quoted, only its scheme: a URL
 * can carry credentials of its own.
 *
 * A URL WITH credentials (`https://user:pass@host/…`) is refused too. It can
 * never work (fetch refuses to build a request from it), and the TypeError it
 * throws quotes the whole URL, password included; the package would put that
 * text in the NetworkError result the model reads, on every call.
 */
export function refuseBaseUrl(baseUrl: unknown): asserts baseUrl is string {
  if (typeof baseUrl !== "string") {
    throw new MnemoverseConfigError("invalid_option", "`baseUrl` must be a string.");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new MnemoverseConfigError(
      "insecure_base_url",
      "The Mnemoverse base URL is not a complete URL (scheme and host), so it cannot be checked " +
        `before the API key is sent to it. Omit \`baseUrl\` to use ${DEFAULT_BASE_URL}.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new MnemoverseConfigError(
      "insecure_base_url",
      "The Mnemoverse base URL contains a user name or password. fetch cannot send such a URL, and its " +
        "error would quote it, password included, in every tool result the model reads. Remove them from " +
        "the URL: the Mnemoverse API is authenticated by the API key alone, and a header a proxy needs can " +
        "go in `headers` (except X-Api-Key and Authorization). The URL is not repeated here.",
    );
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return;
  throw new MnemoverseConfigError(
    "insecure_base_url",
    `The Mnemoverse base URL uses ${url.protocol}//, which would send the API key in cleartext. ` +
      "Use https://, or http:// only for localhost, 127.0.0.1 or [::1].",
  );
}
