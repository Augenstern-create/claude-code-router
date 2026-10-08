import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readRawTraceRequestLogBundle } from "@ccr/core/observability/raw-trace-sync.ts";

test("gateway status patch is idempotent and rejects a version mismatch", async () => {
  const scriptUrl = pathToFileURL(path.resolve("scripts/patch-ai-gateway-raw-trace-status.mjs")).href;
  const { patchGatewaySource } = await import(scriptUrl);
  const gatewayEntry = path.resolve(process.env.CCR_TEST_GATEWAY_ENTRY ?? "node_modules/@the-next-ai/ai-gateway/dist/index.js");
  const source = readFileSync(gatewayEntry, "utf8");
  assert.deepEqual(patchGatewaySource(source, "1.0.21"), { source, changed: false });
  assert.throws(() => patchGatewaySource(source, "1.0.22"), /Refusing to patch.*1\.0\.22/);
});

test("buffered Anthropic-to-OpenAI raw trace retains upstream status and headers", { timeout: 30000 }, async (t) => {
  await runTraceScenario(t, {});
});

test("buffered stream conversion retains upstream status and headers", { timeout: 30000 }, async (t) => {
  await runTraceScenario(t, { stream: true });
});

test("retry retains the final upstream status and headers", { timeout: 30000 }, async (t) => {
  await runTraceScenario(t, {
    retry: true,
    upstreamResponse(call) {
      return call === 1
        ? { status: 503, headers: { "x-upstream-status-test": "first" }, choices: [] }
        : { status: 202, headers: { "x-upstream-status-test": "observed" }, content: "<block>no" };
    }
  });
});

test("transparent tool-loop final response retains upstream status and headers", { timeout: 30000 }, async (t) => {
  await runTraceScenario(t, { transparent: true, toolCall: true });
});

test("executed tool-loop continuation records the final upstream response", { timeout: 30000 }, async (t) => {
  await runTraceScenario(t, {
    transparent: true,
    toolCall: true,
    executeTool: true,
    upstreamResponse(call) {
      return call === 1
        ? { status: 201, headers: { "x-upstream-status-test": "first" } }
        : { status: 202, headers: { "x-upstream-status-test": "observed" }, content: "<block>no" };
    }
  });
});

test("transparent tool-loop empty-output retry records the retried response", { timeout: 30000 }, async (t) => {
  await runTraceScenario(t, {
    transparent: true,
    retry: true,
    upstreamResponse(call) {
      return call === 1
        ? { status: 201, headers: { "x-upstream-status-test": "first" }, choices: [] }
        : { status: 202, headers: { "x-upstream-status-test": "observed" }, content: "<block>no" };
    }
  });
});

const mockMcpServerSource = `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") result = {
    capabilities: { tools: {} },
    protocolVersion: "2024-11-05",
    serverInfo: { name: "test-mcp", version: "1.0.0" }
  };
  if (message.method === "tools/list") result = {
    tools: [{ name: "test_tool", description: "test", inputSchema: { type: "object", properties: {} } }]
  };
  if (message.method === "tools/call") result = { content: [{ type: "text", text: "tool completed" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

async function runTraceScenario(t, options) {
  const root = mkdtempSync(path.join(tmpdir(), "ccr-raw-status-"));
  const spoolDir = path.join(root, "raw-trace");
  let upstreamCalls = 0;
  const upstreamRequests = [];
  const upstream = createServer(async (request, response) => {
    let requestText = "";
    for await (const chunk of request) requestText += chunk;
    upstreamCalls += 1;
    upstreamRequests.push({ url: request.url, body: requestText.slice(0, 300) });
    const payload = options.upstreamResponse?.(upstreamCalls) ?? {
      status: 202,
      headers: { "x-upstream-status-test": "observed" },
      content: "<block>no"
    };
    response.writeHead(payload.status, { "content-type": "application/json", ...payload.headers });
    response.end(JSON.stringify({
      id: "chat-status-test",
      object: "chat.completion",
      model: "test-model",
      choices: payload.choices ?? [options.toolCall && (!options.executeTool || upstreamCalls === 1) ? {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "test_tool", arguments: "{}" } }] },
        finish_reason: "tool_calls"
      } : { index: 0, message: { role: "assistant", content: payload.content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }));
  });
  let child;
  let exited;
  let output = "";
  try {
    await listen(upstream);
    const reservation = createServer();
    await listen(reservation);
    const gatewayPort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const configFile = path.join(root, "gateway.json");
    writeFileSync(configFile, JSON.stringify({
      host: "127.0.0.1",
      port: gatewayPort,
      logging: { enabled: false },
      billing: { enabled: false },
      ...(options.transparent ? { transparentToolExecution: { enabled: true, maxTurns: 2, maxToolCalls: 2 } } : {}),
      ...(options.executeTool ? { agent: { mcpServers: [{
        name: "test-mcp",
        transport: "stdio",
        stdioMessageMode: "newline-json",
        command: process.execPath,
        args: ["-e", mockMcpServerSource]
      }] } } : {}),
      ...(options.retry ? { upstreamRetry: { enabled: true, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, retryStatusCodes: [503] } } : {}),
      rawTrace: { enabled: true, mode: "wire_raw", spoolDir, sync: { enabled: false } },
      providers: [{
        name: "Test OpenAI",
        type: "openai_chat_completions",
        baseurl: `http://127.0.0.1:${upstream.address().port}/v1`,
        apikey: "test-only",
        models: ["test-model"]
      }]
    }));
    const gatewayEntry = process.env.CCR_TEST_GATEWAY_ENTRY ?? "node_modules/@the-next-ai/ai-gateway/dist/index.js";
    child = spawn(process.execPath, [path.resolve(gatewayEntry)], {
      cwd: root,
      env: { ...process.env, GATEWAY_CONFIG_PATH: configFile },
      stdio: ["ignore", "pipe", "pipe"]
    });
    exited = once(child, "exit");
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-8000); });
    const origin = `http://127.0.0.1:${gatewayPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(output);
      try { ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await delay(50);
    }
    assert.ok(ready, output);

    const response = await fetch(`${origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-target-provider": "Test OpenAI" },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        stream: options.stream ?? false,
        messages: [{ role: "user", content: "permission check" }],
        ...(options.toolCall ? { tools: [{ name: "test_tool", description: "test", input_schema: { type: "object", properties: {} } }] } : {})
      }),
      signal: AbortSignal.timeout(5000)
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    if (options.toolCall && !options.executeTool) assert.match(responseText, /test_tool/, responseText);
    if (!options.retry && !options.executeTool) assert.equal(upstreamCalls, 1);
    if (options.retry) assert.match(responseText, /<block>no/, responseText);
    if (options.executeTool) {
      assert.equal(upstreamCalls, 2, `${JSON.stringify(upstreamRequests)}\n${responseText}\n${output}`);
      assert.match(responseText, /<block>no/, responseText);
    }
    try {
      await waitFor(() => findResponseMetadata(spoolDir).some((file) => {
        const metadata = JSON.parse(readFileSync(file, "utf8"));
        return metadata.statusCode === 202 && metadata.headers?.["x-upstream-status-test"] === "observed";
      }));
    } catch (error) {
      throw new Error(`${error.message}\n${JSON.stringify(upstreamRequests)}\n${output}`);
    }
    const metadataPaths = findResponseMetadata(spoolDir);
    const metadataPath = metadataPaths.at(-1);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (options.retry) assert.equal(upstreamCalls, 2);
    assert.equal(metadata.statusCode, 202, JSON.stringify(metadataPaths.map((file) => JSON.parse(readFileSync(file, "utf8")))));
    assert.equal(metadata.headers["x-upstream-status-test"], "observed", JSON.stringify(metadata));
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(metadataPath), "manifest.json"), "utf8"));
    const bundle = await readRawTraceRequestLogBundle(manifest, spoolDir);
    assert.equal(bundle?.update.statusCode, 202);

  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      t.skip(`Local HTTP listen is unavailable: ${error.message}`);
      return;
    }
    throw error;
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(force);
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

function findResponseMetadata(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? findResponseMetadata(entryPath)
        : entry.name.includes("upstream_response_metadata") ? [entryPath] : [];
    });
  } catch {
    return [];
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await delay(50);
  }
  assert.fail("Timed out waiting for raw trace response metadata");
}
