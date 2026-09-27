/**
 * Test helpers for driving the AI SDK tools the way `generateText` does,
 * without a model.
 */
import type { MnemoverseTools } from "../../src/index.js";

export const VALID_KEY = "mk_live_deadbeef";

/** The MCP CallToolResult every tool resolves with. */
export interface CallToolResultLike {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type AnyTool = {
  description?: string;
  title?: string;
  inputSchema: { jsonSchema: unknown };
  execute: (input: unknown, options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }) => Promise<unknown>;
  toModelOutput?: (arg: unknown) => unknown;
};

export function toolOf(set: MnemoverseTools, name: string): AnyTool {
  const tool = (set.tools as unknown as Record<string, AnyTool | undefined>)[name];
  if (tool === undefined) throw new Error(`tool ${name} not exposed`);
  return tool;
}

/** Execute a tool with already-valid input, as the AI SDK does after validation. */
export async function callTool(
  set: MnemoverseTools,
  name: string,
  input: unknown,
  options: { abortSignal?: AbortSignal } = {},
): Promise<CallToolResultLike> {
  return (await toolOf(set, name).execute(input, {
    toolCallId: "call_1",
    messages: [],
    abortSignal: options.abortSignal,
  })) as CallToolResultLike;
}

/** The JSON Schema the AI SDK sends to the model for this tool. */
export async function jsonSchemaOf(set: MnemoverseTools, name: string): Promise<Record<string, unknown>> {
  const schema = toolOf(set, name).inputSchema.jsonSchema;
  // Some AI SDK versions resolve the JSON Schema lazily.
  return (await (typeof schema === "function" ? (schema as () => unknown)() : schema)) as Record<string, unknown>;
}

export function textOf(result: CallToolResultLike): string {
  return result.content.map((p) => p.text ?? "").join("\n");
}
