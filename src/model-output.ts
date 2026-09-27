/**
 * What the MODEL reads from a Mnemoverse tool result.
 *
 * The AI SDK's MCP client returns the whole MCP `CallToolResult` from
 * `execute` (`{ content, structuredContent?, isError }`), and that is what the
 * CALLER gets as the tool result's `output`, untouched. What it hands the
 * MODEL differs by major:
 *
 *   ai 5 (@ai-sdk/mcp 0.x)  no `toModelOutput`, so the AI SDK sends the whole
 *                           result as JSON: the text escaped inside a
 *                           `content` array, `structuredContent` duplicated
 *                           beside it, `isError` as a field.
 *   ai 6 / 7 (1.x / 2.x)    `mcpToModelOutput`: the content parts as a
 *                           `content` output; `isError` is not passed on.
 *
 * This package sets one `toModelOutput` for all three, so the model reads the
 * package's text verbatim and nothing else, exactly the text an MCP host shows
 * its model: `text` on success, `error-text` when the server answered
 * `isError: true` (providers that have a tool-error flag, such as Anthropic's
 * `is_error`, then set it, as MCP hosts do). The text is never edited; only
 * the channel is chosen. A result with a non-text part (the package emits none
 * today) falls back to the client's own conversion.
 *
 * ai 5 calls `toModelOutput(output)`; ai 6 and 7 call
 * `toModelOutput({ toolCallId, input, output })`. An MCP result never has a
 * `toolCallId`, so the two call shapes cannot be confused.
 */

type Part = { type?: unknown; text?: unknown };
type CallToolResultLike = { content?: unknown; isError?: unknown };
type Fallback = ((arg: unknown) => unknown) | undefined;

export function createToModelOutput(fallback: Fallback): (arg: unknown) => unknown {
  return function toModelOutput(arg: unknown): unknown {
    const v6Shape = arg !== null && typeof arg === "object" && "toolCallId" in arg && "output" in arg;
    const output = (v6Shape ? (arg as { output: unknown }).output : arg) as CallToolResultLike | undefined;
    const parts = Array.isArray(output?.content) ? (output.content as Part[]) : undefined;
    if (parts !== undefined && parts.every((p) => p?.type === "text" && typeof p.text === "string")) {
      const value = parts.map((p) => p.text as string).join("\n");
      return output?.isError === true ? { type: "error-text", value } : { type: "text", value };
    }
    if (fallback !== undefined) return fallback(arg);
    return { type: "json", value: output ?? null };
  };
}
