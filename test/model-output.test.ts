/**
 * toModelOutput: the model reads the package's text verbatim, on the `text`
 * channel or, for an MCP `isError` result, the `error-text` channel, under
 * both call shapes (ai 5: the output itself; ai 6/7: { toolCallId, input, output }).
 */
import { describe, expect, it } from "vitest";
import { createToModelOutput } from "../src/model-output.js";

const ok = { content: [{ type: "text", text: "1. User prefers dark mode" }], structuredContent: { items: [1] }, isError: false };
const bad = { content: [{ type: "text", text: "Mnemoverse: your API key was rejected (401)." }], isError: true };

describe("toModelOutput", () => {
  const toModelOutput = createToModelOutput(undefined);

  it.each([
    ["ai 5 shape", ok],
    ["ai 6/7 shape", { toolCallId: "c1", input: {}, output: ok }],
  ])("success → text, the package's text only (%s)", (_label, arg) => {
    expect(toModelOutput(arg)).toEqual({ type: "text", value: "1. User prefers dark mode" });
  });

  it.each([
    ["ai 5 shape", bad],
    ["ai 6/7 shape", { toolCallId: "c1", input: {}, output: bad }],
  ])("isError → error-text, same text (%s)", (_label, arg) => {
    expect(toModelOutput(arg)).toEqual({ type: "error-text", value: "Mnemoverse: your API key was rejected (401)." });
  });

  it("several text parts are joined with a newline, never edited", () => {
    const two = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
    expect(toModelOutput(two)).toEqual({ type: "text", value: "a\nb" });
  });

  it("a non-text part falls back to the client's own conversion", () => {
    const fallback = (arg: unknown) => ({ type: "content", from: "client", arg });
    const withImage = { toolCallId: "c1", input: {}, output: { content: [{ type: "image", data: "", mimeType: "image/png" }] } };
    expect(createToModelOutput(fallback)(withImage)).toEqual({ type: "content", from: "client", arg: withImage });
  });

  it("without a client conversion (ai 5), a non-text result is sent as JSON", () => {
    const odd = { toolResult: { x: 1 } };
    expect(toModelOutput(odd)).toEqual({ type: "json", value: odd });
  });
});
