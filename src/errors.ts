/**
 * Error classes.
 *
 * `ApiError`, `NetworkError` and `UnreadableBodyError` are the MCP package's
 * own classes, re-exported from `@mnemoverse/mcp-memory-server/shared`, never
 * copies: the package's tools branch on `instanceof` (memory_list_recent reads
 * `ApiError#isBare404`), so the request layer must reject with exactly these.
 *
 * The two classes defined here are this package's own, and neither ever
 * reaches the model: they are thrown to the developer, before any tool exists.
 */
export { ApiError, NetworkError, UnreadableBodyError } from "@mnemoverse/mcp-memory-server/shared";

/** Why createMnemoverseTools refused its options. */
export type MnemoverseConfigErrorCode =
  | "missing_key"
  | "placeholder_key"
  | "unsendable_key"
  | "insecure_base_url"
  | "invalid_option"
  | "invalid_domain"
  | "unknown_tool"
  | "empty_tools"
  | "tool_not_allowed_with_domain"
  | "browser_runtime"
  | "incompatible_ai_versions";

/**
 * The options passed to createMnemoverseTools cannot work. Thrown (the promise
 * rejects) before any tool exists and before any request is sent. Messages
 * never repeat a key or a header value.
 */
export class MnemoverseConfigError extends Error {
  readonly code: MnemoverseConfigErrorCode;

  constructor(code: MnemoverseConfigErrorCode, message: string) {
    super(message);
    this.name = "MnemoverseConfigError";
    this.code = code;
  }
}

/**
 * The tools this process would show the model are not what the installed
 * @mnemoverse/mcp-memory-server defines, or not what this package's policy was
 * reviewed against:
 *
 *   - the listed input schemas have lost descriptions or limits the package's
 *     own zod declares (the install paired @modelcontextprotocol/sdk with a zod
 *     the package's schemas do not support; see src/fidelity.ts);
 *   - a tool this package classifies is missing, or a tool that a pinned
 *     domain must scope has no `domain` input.
 *
 * The exact version pin and the `zod` peer dependency make this unreachable in
 * a normal install; it exists so an override, an ignored peer warning or a bad
 * bump fails loudly instead of degrading the surface or exposing an unreviewed
 * tool set.
 */
export class MnemoverseSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MnemoverseSurfaceError";
  }
}
