import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createLibraryService } from "../src/library-service.ts";
import { createClientUpdateChecker } from "../src/local/updates.ts";
import { createMcpUpdateMonitor } from "../src/mcp-updates.ts";
import { networkAccessFile, resetNetworkAccessForTests } from "../src/network-access.ts";
import { createServer } from "../src/server.ts";

function assertEnvelope(result: CallToolResult, expectedOutcome: string, code: string) {
  const envelope = result.structuredContent?.envelope as Record<string, unknown> | undefined;
  assert.ok(envelope, "every diagnostic tool must return structuredContent.envelope");
  assert.equal(envelope.schema, "figure-library.tool-outcome.v1");
  assert.equal(envelope.outcome, expectedOutcome);
  assert.equal(envelope.code, code);
  assert.equal(envelope.terminal, true);
  assert.equal(envelope.retrySameCall, false);
  assert.equal(typeof envelope.nextAction, "string");
  const first = result.content[0];
  assert.equal(first?.type, "text");
  assert.match(String(first?.text), /^OUTCOME: .+\nTERMINAL: true\nRETRY_SAME_CALL: false/mu);
  assert.equal(result.isError === true, expectedOutcome === "failed");
}

test("network and update tools retain terminal envelopes on success and operational failures", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-network-tools-"));
  const environment = {
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root,
    FIGURE_LIBRARY_DIR: path.join(root, "library"), FIGURE_WORKSPACE_DIR: undefined,
    SFL_DIAGNOSTICS_DIR: path.join(root, "diagnostics"),
    SFL_WORKSPACE_LOCATOR_PATH: path.join(root, "workspace.json"),
    SFL_OPEN_FIGURE_AUTO_REFRESH: "0", SFL_MCP_UPDATE_NOTICES: "0",
  };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const originalFetch = globalThis.fetch;
  let offline = false;
  globalThis.fetch = async () => {
    if (offline) throw new Error("offline fixture");
    return Response.json({ tag_name: "v99.0.0", draft: false, prerelease: false });
  };
  let service: Awaited<ReturnType<typeof createLibraryService>> | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let client: Client | undefined;
  t.after(async () => {
    await client?.close(); await server?.close(); await service?.close();
    globalThis.fetch = originalFetch; resetNetworkAccessForTests();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  resetNetworkAccessForTests();
  const monitor = createMcpUpdateMonitor({ noticesEnabled: false });
  service = await createLibraryService();
  server = await createServer({ service, updateMonitor: monitor });
  client = new Client({ name: "network-tool-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  const call = async (name: string, args = {}) => await client!.callTool({ name, arguments: args }) as CallToolResult;

  await t.test("all three tools expose data and standard success envelopes", async () => {
    const status = await call("figure_library_network_status");
    assertEnvelope(status, "ok", "network_status");
    assert.equal(status.structuredContent?.scope, "same-user-and-machine");
    const tested = await call("figure_library_network_test");
    assertEnvelope(tested, "ok", "network_test_passed");
    assert.equal(tested.structuredContent?.forwardingTested, true);
    const update = await call("figure_library_update_status", { refresh: true });
    assertEnvelope(update, "ok", "update_status");
    assert.equal(update.structuredContent?.latestVersion, "99.0.0");
    assert.equal(update.structuredContent?.checkStatus, "fresh");
  });
  await t.test("network and update failures are terminal, not success-shaped results", async () => {
    offline = true;
    const tested = await call("figure_library_network_test");
    assertEnvelope(tested, "failed", "network_test_failed");
    assert.equal(tested.structuredContent?.forwardingTested, false);
    const update = await call("figure_library_update_status", { refresh: true });
    assertEnvelope(update, "failed", "update_check_failed");
    assert.equal(update.structuredContent?.checkStatus, "error");
    assert.equal(update.structuredContent?.latestVersion, null);
    offline = false;
  });
  await t.test("cache warnings stay usable over MCP and failures do not consume the one-time notice", async () => {
    const blocked = path.join(root, "blocked-cache-parent");
    await fs.writeFile(blocked, "fixture");
    const notifying = createMcpUpdateMonitor({
      cachePath: path.join(blocked, "cache.json"), noticesEnabled: true,
      checker: createClientUpdateChecker({ fetch: async () => Response.json({ tag_name: "v99.0.0", draft: false, prerelease: false }) }),
    });
    await notifying.refresh(true);
    const secondServer = await createServer({ service, updateMonitor: notifying });
    const secondClient = new Client({ name: "network-notice-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await secondServer.connect(serverTransport); await secondClient.connect(clientTransport);
    try {
      offline = true;
      const failed = await secondClient.callTool({ name: "figure_library_network_test", arguments: {} }) as CallToolResult;
      assertEnvelope(failed, "failed", "network_test_failed");
      assert.equal(failed.content.length, 1);
      offline = false;
      const status = await secondClient.callTool({ name: "figure_library_update_status", arguments: {} }) as CallToolResult;
      assertEnvelope(status, "ok", "update_status");
      assert.equal(status.structuredContent?.cachePersisted, false);
      assert.equal(status.structuredContent?.latestVersion, "99.0.0");
      assert.equal(status.content.length, 2);
      const again = await secondClient.callTool({ name: "figure_library_update_status", arguments: {} }) as CallToolResult;
      assert.deepEqual(again.structuredContent, status.structuredContent);
      assert.equal(again.content.length, 1);
    } finally {
      offline = false;
      await secondClient.close(); await secondServer.close();
    }
  });
  await t.test("corrupt config and invalid proxy cannot escape the terminal contract", async () => {
    await fs.mkdir(path.dirname(networkAccessFile()), { recursive: true });
    await fs.writeFile(networkAccessFile(), "not JSON");
    assertEnvelope(await call("figure_library_network_status"), "failed", "network_status_failed");
    assertEnvelope(await call("figure_library_network_test"), "failed", "network_test_failed");
    await fs.writeFile(networkAccessFile(), JSON.stringify({ useSystemProxy: true, httpsProxy: "socks5://127.0.0.1:9" }));
    assertEnvelope(await call("figure_library_network_status"), "failed", "network_configuration_invalid");
    assertEnvelope(await call("figure_library_network_test"), "failed", "network_test_failed");
  });
});

test("an update cache write failure preserves fresh remote results without repeated automatic checks", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-update-cache-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parentFile = path.join(root, "not-a-directory");
  await fs.writeFile(parentFile, "fixture");
  let calls = 0;
  const monitor = createMcpUpdateMonitor({
    currentVersion: "0.9.0", cachePath: path.join(parentFile, "cache.json"), noticesEnabled: true,
    checker: createClientUpdateChecker({ currentVersion: "0.9.0", fetch: async () => {
      calls++;
      return Response.json({ tag_name: "v99.0.0", draft: false, prerelease: false });
    } }),
  });
  const fresh = await monitor.refresh(true);
  assert.equal(fresh.latestVersion, "99.0.0");
  assert.equal(fresh.checkStatus, "fresh");
  assert.equal(fresh.cachePersisted, false);
  assert.ok(fresh.cachePersistenceError);
  await monitor.load();
  assert.equal(monitor.status().latestVersion, "99.0.0");
  await monitor.refresh();
  assert.equal(calls, 1);
  assert.match(monitor.notice() ?? "", /99\.0\.0/u);
});
