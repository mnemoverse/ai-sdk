export {
  createMnemoverseTools,
  type MnemoverseTools,
  type MnemoverseToolsOptions,
} from "./create.js";
export {
  MEMORY_TOOL_NAMES,
  TOOL_CLASSES,
  type MemoryToolName,
  type ToolClass,
  type ToolsOption,
} from "./policy.js";
export { DEFAULT_TIMEOUT_MS, type HeadersOption } from "./api-fetch.js";
export { DEFAULT_BASE_URL } from "./refusals.js";
export { SURFACE_VERSION, VERSION } from "./version.js";
export {
  ApiError,
  MnemoverseConfigError,
  MnemoverseSurfaceError,
  NetworkError,
  UnreadableBodyError,
  type MnemoverseConfigErrorCode,
} from "./errors.js";

/**
 * The MCP server's instructions (the text MCP clients put in the model's
 * system prompt), re-exported from @mnemoverse/mcp-memory-server, not copied.
 * It names every tool, including the room tools that are only exposed on
 * request; it is guidance, so a model without a named tool simply cannot call
 * it.
 */
export { SERVER_INSTRUCTIONS } from "@mnemoverse/mcp-memory-server/shared";
