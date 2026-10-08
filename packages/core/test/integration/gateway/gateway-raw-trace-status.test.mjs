import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readRawTraceRequestLogBundle } from "@ccr/core/observability/raw-trace-sync.ts";

test("buffered Anthropic-to-OpenAI raw trace retains the actual upstream HTTP status", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ccr-raw-status-"));
  const spoolDir = path.join(root, "raw-trace");
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(202, { "content-type": "application/json", "x-upstream-status-test": "observed" });
    response.end(JSON.stringify({
      id: "chat-status-test",
      object: "chat.completion",
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "<block>no" }, finish_reason: "stop" }],
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
      body: JSON.stringify({ model: "test-model", max_tokens: 16, messages: [{ role: "user", content: "permission check" }] }),
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(response.status, 200, await response.text());
    await waitFor(() => findResponseMetadata(spoolDir).length > 0);
    const metadataPath = findResponseMetadata(spoolDir)[0];
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.statusCode, 202);
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
});

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
