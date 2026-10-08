/** Claude Code's Read tool can send image blocks serialized inside a tool_result string. */
export function normalizeClaudeReadImageToolResults(body: Buffer): Buffer | undefined {
  if (!body.includes('"tool_result"') || !body.includes('"Read"')) return undefined;
  let request: unknown;
  try {
    request = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(request) || !Array.isArray(request.messages)) {
    return undefined;
  }

  const readToolUseIds = new Set<string>();
  for (const message of request.messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_use" && block.name === "Read" && typeof block.id === "string") {
        readToolUseIds.add(block.id);
      }
    }
  }
  if (readToolUseIds.size === 0) return undefined;

  let changed = false;
  for (const message of request.messages) {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result" ||
          typeof block.tool_use_id !== "string" || !readToolUseIds.has(block.tool_use_id) ||
          typeof block.content !== "string" || !block.content.trimStart().startsWith("[")) continue;
      let content: unknown;
      try {
        content = JSON.parse(block.content);
      } catch {
        continue;
      }
      if (!isImageContentBlocks(content)) continue;
      block.content = content;
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(request)) : undefined;
}

function isImageContentBlocks(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) return false;
  let hasImage = false;
  for (const block of value) {
    if (!isRecord(block)) return false;
    if (block.type === "text") {
      if (typeof block.text !== "string") return false;
      continue;
    }
    if (block.type !== "image" || !isRecord(block.source) || block.source.type !== "base64" ||
        typeof block.source.media_type !== "string" || !block.source.media_type.startsWith("image/") ||
        typeof block.source.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.source.data)) {
      return false;
    }
    hasImage = true;
  }
  return hasImage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
