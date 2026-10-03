import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mountOperations } from "../src/mcp-adapter.ts";
import { createClientUpdateChecker } from "../src/local/updates.ts";
import { createMcpUpdateMonitor } from "../src/mcp-updates.ts";
import { OperationRegistry } from "../src/service/operations.ts";

const release = (tag = "v0.10.0") => Response.json({ tag_name: tag, draft: false, prerelease: false });

test("persistent cold/fresh/stale/error cache, opt-out and explicit refresh", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-mcp-updates-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cachePath = path.join(root, "cache.json");
  let now = Date.parse("2026-10-03T00:00:00Z"), calls = 0, offline = false;
  const checker = createClientUpdateChecker({ currentVersion: "0.9.0", now: () => now, fetch: async () => { calls++; if (offline) throw new Error("offline"); return release(); } });
  const make = (noticesEnabled = true) => createMcpUpdateMonitor({ currentVersion: "0.9.0", now: () => now, cachePath, checker, noticesEnabled });
  const first = make(); await first.load();
  assert.equal(first.status().checkStatus, "unchecked");
  first.begin();
  await first.refresh();
  assert.equal(calls, 1);
  assert.match(first.notice() ?? "", /0\.9\.0.*0\.10\.0.*releases\/tag\/v0\.10\.0.*restart/u);
  assert.equal(first.notice(), undefined);
  const second = make(); await second.load();
  assert.equal(second.status().checkStatus, "fresh");
  assert.equal(second.status().latestVersion, "0.10.0");
  second.begin(); assert.equal(calls, 1);
  assert.ok(second.notice());
  const optout = make(false); await optout.load(); optout.begin();
  assert.equal(optout.notice(), undefined); assert.equal(calls, 1);
  const previousOptout = process.env.SFL_MCP_UPDATE_NOTICES;
  process.env.SFL_MCP_UPDATE_NOTICES = "0";
  assert.equal(createMcpUpdateMonitor({ cachePath, checker }).status().noticesEnabled, false);
  if (previousOptout === undefined) delete process.env.SFL_MCP_UPDATE_NOTICES;
  else process.env.SFL_MCP_UPDATE_NOTICES = previousOptout;
  now += 24 * 60 * 60 * 1000;
  assert.equal(second.status().checkStatus, "stale");
  offline = true;
  const failed = await optout.refresh(true);
  assert.equal(failed.checkStatus, "error");
  assert.equal(failed.latestVersion, null);
  assert.equal(optout.notice(), undefined);
  const afterFailure = make(); await afterFailure.load();
  assert.equal(afterFailure.status().checkStatus, "error");
  now += 60 * 60 * 1000; offline = false;
  assert.equal((await optout.refresh(true)).checkStatus, "fresh");
  assert.equal(calls, 3);
});

test("concurrent MCP results append exactly one additional text item without changing structured content", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-mcp-notice-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const monitor = createMcpUpdateMonitor({
    currentVersion: "0.9.0", cachePath: path.join(root, "cache.json"),
    checker: createClientUpdateChecker({ currentVersion: "0.9.0", fetch: async () => release() }),
  });
  await monitor.load(); await monitor.refresh(true);
  const operations = new OperationRegistry();
  operations.define("fixture_result", { inputSchema: {} }, () => ({
    content: [{ type: "text", text: "authoritative" }], structuredContent: { envelope: { planDigest: "a".repeat(64), operationId: "fixed" } },
  }));
  const server = new McpServer({ name: "fixture", version: "1" });
  mountOperations(server, operations, monitor);
  const client = new Client({ name: "fixture-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const results = await Promise.all(Array.from({ length: 8 }, () => client.callTool({ name: "fixture_result", arguments: {} })));
  assert.equal(results.reduce((count, value) => count + ((value.content as unknown[]).length === 2 ? 1 : 0), 0), 1);
  for (const value of results) {
    const content = value.content as Array<{ type: string; text?: string }>;
    assert.deepEqual(value.structuredContent, { envelope: { planDigest: "a".repeat(64), operationId: "fixed" } });
    assert.equal(content[0]?.type, "text");
    assert.equal(content[0]?.text, "authoritative");
  }
});
