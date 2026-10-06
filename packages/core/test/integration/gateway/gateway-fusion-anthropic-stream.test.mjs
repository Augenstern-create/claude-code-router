import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { deletePersistedRuntimeState } from "@ccr/core/config/config-repository.ts";
import { gatewayService } from "@ccr/core/gateway/service.ts";

test("Fusion Anthropic streaming preserves native SSE while direct and non-streaming remain unchanged", async (t) => {
  const upstream = createServer(async (request, response) => {
    const body = JSON.parse(await readRequestBody(request));
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.end(anthropicStreamFixture());
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(anthropicNonStreamFixture()));
  });

  try {
    await gatewayService.stop();
    await listen(upstream);
    const config = fusionGatewayConfig(serverPort(upstream), await findAvailablePort());
    const status = await gatewayService.start(config);
    assert.equal(status.state, "running", status.lastError);

    const response = await postMessages(status.endpoint, "Fusion/qwen-web", true);
    const text = await response.text();
    assert.equal(response.status, 200, text);

    const events = parseSseEvents(text);
    assert.deepEqual(events.map((event) => event.type), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
    assert.equal(events[0].message.model, "qwen3.8-27b");
    assert.deepEqual(events.slice(1, 4).map((event) => event.index), [0, 0, 0]);
    assert.equal(events[2].delta.type, "thinking_delta");
    assert.equal(events[2].delta.thinking, "reasoning");
    assert.deepEqual(events.slice(4, 8).map((event) => event.index), [1, 1, 1, 1]);
    assert.equal(events[5].delta.type, "text_delta");
    assert.equal(events[5].delta.text, "CCR");
    assert.equal(events[6].delta.text, " streaming 正常");
    assert.equal(events[8].usage.output_tokens, 82);
    assert.equal(events[8].delta.stop_reason, "end_turn");

    const directResponse = await postMessages(status.endpoint, "NInfer Local/qwen3.8-27b", true);
    const directText = await directResponse.text();
    assert.equal(directResponse.status, 200, directText);
    assert.deepEqual(parseSseEvents(directText), events);

    const nonStreamResponse = await postMessages(status.endpoint, "Fusion/qwen-web", false);
    const nonStreamText = await nonStreamResponse.text();
    assert.equal(nonStreamResponse.status, 200, nonStreamText);
    const nonStream = JSON.parse(nonStreamText);
    assert.equal(nonStream.model, "qwen3.8-27b");
    assert.deepEqual(nonStream.content, [
      { thinking: "reasoning", type: "thinking" },
      { text: "CCR streaming 正常", type: "text" }
    ]);
    assert.equal(nonStream.usage.output_tokens, 82);
  } catch (error) {
    if (isLocalListenUnavailable(error)) {
      t.skip(`Local HTTP listen is unavailable: ${formatError(error)}`);
      return;
    }
    throw error;
  } finally {
    await gatewayService.stop();
    await deletePersistedRuntimeState("gateway");
    await closeServer(upstream);
  }
});

function fusionGatewayConfig(upstreamPort, gatewayPort) {
  const config = createDefaultAppConfig();
  config.APIKEY = "test-api-key";
  config.gateway.enabled = true;
  config.gateway.host = "127.0.0.1";
  config.gateway.port = gatewayPort;
  config.Providers = [{
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    credentials: [{ apiKey: "test-provider-key", id: "test-provider-key" }],
    models: ["qwen3.8-27b"],
    name: "NInfer Local",
    type: "anthropic_messages"
  }];
  config.virtualModelProfiles = [{
    baseModel: { fixedModel: "NInfer Local/qwen3.8-27b", mode: "fixed" },
    displayName: "Qwen Web",
    enabled: true,
    execution: {
      clientToolsPolicy: "allow",
      maxToolCalls: 8,
      maxTurns: 6,
      mode: "tool_loop",
      streamMode: "optimistic"
    },
    id: "qwen-web",
    key: "qwen-web",
    match: { exactAliases: ["Fusion/qwen-web"], prefixes: [], suffixes: [] },
    materialization: { enabled: true, includeInGatewayModels: true },
    tools: []
  }];
  return config;
}

function anthropicStreamFixture() {
  return [
    sseEvent("message_start", {
      message: {
        content: [],
        id: "msg_fixture",
        model: "qwen3.8-27b",
        role: "assistant",
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 115, output_tokens: 0 }
      },
      type: "message_start"
    }),
    sseEvent("content_block_start", { content_block: { thinking: "", type: "thinking" }, index: 0, type: "content_block_start" }),
    sseEvent("content_block_delta", { delta: { thinking: "reasoning", type: "thinking_delta" }, index: 0, type: "content_block_delta" }),
    sseEvent("content_block_stop", { index: 0, type: "content_block_stop" }),
    sseEvent("content_block_start", { content_block: { text: "", type: "text" }, index: 1, type: "content_block_start" }),
    sseEvent("content_block_delta", { delta: { text: "CCR", type: "text_delta" }, index: 1, type: "content_block_delta" }),
    sseEvent("content_block_delta", { delta: { text: " streaming 正常", type: "text_delta" }, index: 1, type: "content_block_delta" }),
    sseEvent("content_block_stop", { index: 1, type: "content_block_stop" }),
    sseEvent("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      type: "message_delta",
      usage: { input_tokens: 0, output_tokens: 82 }
    }),
    sseEvent("message_stop", { type: "message_stop" })
  ].join("\n\n") + "\n\n";
}

function anthropicNonStreamFixture() {
  return {
    content: [
      { thinking: "reasoning", type: "thinking" },
      { text: "CCR streaming 正常", type: "text" }
    ],
    id: "msg_fixture",
    model: "qwen3.8-27b",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 115, output_tokens: 82 }
  };
}

function postMessages(endpoint, model, stream, tools) {
  return fetch(new URL("/v1/messages", endpoint), {
    body: JSON.stringify({
      max_tokens: 128,
      messages: [{ content: "只回复：CCR streaming 正常", role: "user" }],
      model,
      stream,
      ...(tools ? { tools } : {})
    }),
    headers: {
      authorization: "Bearer test-api-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    method: "POST"
  });
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}`;
}

function parseSseEvents(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
    return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function serverPort(server) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function findAvailablePort() {
  const server = net.createServer();
  await listen(server);
  const port = serverPort(server);
  await closeServer(server);
  return port;
}

function isLocalListenUnavailable(error) {
  return error && typeof error === "object" && (error.code === "EPERM" || error.code === "EACCES");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
