/**
 * Compile-only (the typecheck step runs it against each ai major in the
 * matrix): the public types work with the installed `ai`.
 */
import { generateText, stepCountIs, streamText, type LanguageModel, type ToolSet } from "ai";
import {
  createMnemoverseTools,
  MnemoverseConfigError,
  SERVER_INSTRUCTIONS,
  type MemoryToolName,
  type MnemoverseTools,
  type MnemoverseToolsOptions,
} from "../src/index.js";

declare const model: LanguageModel;

export async function quickStart(): Promise<string> {
  const memory = await createMnemoverseTools();
  try {
    const { text } = await generateText({
      model,
      system: SERVER_INSTRUCTIONS,
      tools: memory.tools,
      stopWhen: stepCountIs(5),
      prompt: "I switched to Neovim. Remember that.",
    });
    return text;
  } finally {
    await memory.close();
  }
}

export async function perUser(apiKey: string, userId: string): Promise<void> {
  const options: MnemoverseToolsOptions = { apiKey, domain: `user:${userId}`, tools: ["memory_read", "memory_write"] };
  const memory: MnemoverseTools = await createMnemoverseTools(options);
  const tools: ToolSet = { ...memory.tools };
  const result = streamText({ model, tools, stopWhen: stepCountIs(3), prompt: "hi" });
  await result.consumeStream?.();
  await memory.close();
  const names: MemoryToolName[] = ["memory_stats"];
  void names;
  void memory.surfaceVersion.toUpperCase();
}

export function isConfigError(e: unknown): boolean {
  return e instanceof MnemoverseConfigError && e.code === "missing_key";
}

// @ts-expect-error: not a tool name
export const bad: MemoryToolName = "memory_delete";
