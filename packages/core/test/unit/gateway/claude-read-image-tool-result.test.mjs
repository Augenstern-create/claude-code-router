import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeReadImageToolResults } from "@ccr/core/gateway/features/claude-read-image-tool-result.ts";

const image = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" }
};

function request(toolName, resultContent) {
  return Buffer.from(JSON.stringify({
    model: "qwen3.8-27b",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: toolName, input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: resultContent }] }
    ]
  }));
}

test("restores a JSON-wrapped Read image as an Anthropic image block", () => {
  const input = request("Read", JSON.stringify([image]));
  const output = normalizeClaudeReadImageToolResults(input);
  assert.ok(output);
  assert.deepEqual(JSON.parse(output).messages[1].content[0].content, [image]);
  assert.equal(typeof JSON.parse(input).messages[1].content[0].content, "string");
});

test("preserves accompanying text blocks in a JSON-wrapped Read image result", () => {
  const content = [{ type: "text", text: "Image file" }, image];
  const output = normalizeClaudeReadImageToolResults(request("Read", JSON.stringify(content)));
  assert.deepEqual(JSON.parse(output).messages[1].content[0].content, content);
});

test("does not reinterpret ordinary, malformed, unrelated, or already structured results", () => {
  for (const [name, content] of [
    ["Read", "ordinary file content"],
    ["Read", "[{not valid JSON]"],
    ["Read", JSON.stringify([{ type: "text", text: "no image" }])],
    ["Read", JSON.stringify([{ ...image, source: { ...image.source, data: "" } }])],
    ["Read", [image]],
    ["OtherTool", JSON.stringify([image])]
  ]) {
    assert.equal(normalizeClaudeReadImageToolResults(request(name, content)), undefined);
  }
});
