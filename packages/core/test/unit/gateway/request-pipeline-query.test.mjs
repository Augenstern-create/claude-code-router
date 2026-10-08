import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { GatewayRequestPipeline } from "@ccr/core/gateway/request/pipeline.ts";

test("gateway pipeline preserves response retrieval query parameters and encoded values", async () => {
  const config = createDefaultAppConfig();
  config.observability.requestLogs = false;
  config.contextArchive.enabled = false;
  const pipeline = new GatewayRequestPipeline({
    getBrowserWebSearchMcpIntegration: () => undefined,
    getConfig: () => config,
    getCoreAuthToken: () => "test-core-token",
    getPlugin: () => ({}),
    getStatus: () => ({
      coreEndpoint: "http://127.0.0.1:3457",
      endpoint: "http://127.0.0.1:3456"
    })
  });
  const originalFetch = globalThis.fetch;
  const forwardedUrls = [];
  globalThis.fetch = async (url) => {
    forwardedUrls.push(String(url));
    return new Response(null, { status: 204 });
  };

  try {
    for (const requestUrl of [
      "/v1/responses/resp-test?stream=true&starting_after=42&include%5B%5D=reasoning.encrypted_content&include%5B%5D=message.output_text.logprobs",
      "/v1/responses/resp-test?custom=a%2Fb%26c%3Dd&custom=second",
      "/v1/responses/resp-test"
    ]) {
      const request = Readable.from([]);
      request.method = "GET";
      request.url = requestUrl;
      request.headers = {};
      const response = new Writable({ write(_chunk, _encoding, done) { done(); } });
      response.writeHead = () => response;
      await pipeline.proxyRequest(request, response, new URL(requestUrl, "http://127.0.0.1").pathname);
      assert.equal(forwardedUrls.at(-1), `http://127.0.0.1:3457${requestUrl}`);
    }
    assert.equal(forwardedUrls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway forwards JSON-wrapped Read images as structured Anthropic tool content", async () => {
  const config = createDefaultAppConfig();
  config.observability.requestLogs = false;
  config.contextArchive.enabled = false;
  const pipeline = new GatewayRequestPipeline({
    getBrowserWebSearchMcpIntegration: () => undefined,
    getConfig: () => config,
    getCoreAuthToken: () => "test-core-token",
    getPlugin: () => ({
      routeRequest: async ({ body }) => ({
        body,
        decision: { diagnostics: [], model: "qwen3.8-27b", reason: "test", source: "router" }
      })
    }),
    getStatus: () => ({
      coreEndpoint: "http://127.0.0.1:3457",
      endpoint: "http://127.0.0.1:3456"
    })
  });
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } };
  const body = {
    model: "qwen3.8-27b",
    max_tokens: 1,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: JSON.stringify([image]) }] }
    ]
  };
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = "POST";
  request.url = "/v1/messages";
  request.headers = { "content-type": "application/json", "user-agent": "claude-code/2.0" };
  const response = new Writable({ write(_chunk, _encoding, done) { done(); } });
  response.writeHead = () => response;
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith("/v1/messages")) return new Response(null, { status: 404 });
    forwarded = JSON.parse(Buffer.from(init.body).toString("utf8"));
    return new Response(JSON.stringify({ type: "message", role: "assistant", content: [], usage: {} }), {
      headers: { "content-type": "application/json" }, status: 200
    });
  };
  try {
    await pipeline.proxyRequest(request, response, "/v1/messages");
    assert.deepEqual(forwarded.messages[1].content[0].content, [image]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
