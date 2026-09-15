import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { get } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibraryService } from "../src/library-service.ts";
import { startLocalHttp } from "../src/local/http.ts";
import { browserLaunchSpec } from "../src/local/launch.ts";
import { createDefaultProviderRegistry } from "../src/provider-registry.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function record(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
const data = (value: unknown) => record(record(value).structuredContent);
const code = (value: unknown) => record(data(value).envelope).code;

async function isolated(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-local-client-test-"));
  const overrides = {
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "config"), LOCALAPPDATA: path.join(root, "data"),
    SFL_DIAGNOSTICS_DIR: path.join(root, "diagnostics"), SFL_WORKSPACE_LOCATOR_PATH: path.join(root, "config/workspace.json"),
    FIGURE_LIBRARY_DIR: path.join(root, "library"), FIGURE_WORKSPACE_DIR: path.join(root, "workspace"),
  };
  const previous = Object.fromEntries([...Object.keys(overrides), "SFL_HTTPS_PROXY"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  delete process.env.FIGURE_WORKSPACE_DIR;
  process.env.SFL_HTTPS_PROXY = "";
  const htmlPath = path.join(root, "index.html");
  await fs.writeFile(htmlPath, "<!doctype html><title>SFL local test</title>");
  const service = await createLibraryService({ registry: createDefaultProviderRegistry() });
  const local = await startLocalHttp({ service, htmlPath });
  t.after(async () => {
    await local.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (route: string, body?: unknown, headers: Record<string, string> = {}) => fetch(local.origin + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${local.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = async (route: string, body?: unknown) => {
    const response = await request(route, body);
    const value: unknown = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return record(value);
  };
  const call = (name: string, args: Record<string, unknown> = {}, approval = false) => api("/api/call", {
    name, arguments: args, ...(approval ? { approval: { confirmedBy: "user", planDigest: args.planDigest } } : {}),
  });
  return { root, local, service, request, api, call, overrides };
}

test("Windows local app HTML exposes setup, preview cache and provider source controls", async () => {
  const html = await fs.readFile(path.resolve(import.meta.dirname, "../app/local-app.html"), "utf8");
  for (const id of [
    "setup-banner", "cache-banner", "cache-previews", "preview-cache-hint",
    "provider-list", "add-source-form", "source-provider-id", "source-manifest-url", "source-public-key", "source-default-search",
    "proxy-form", "https-proxy",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
});

test("bundled runtime lock pins official Linux Node archives", async () => {
  const lock = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../scripts/runtime/node-runtime.json"), "utf8"));
  assert.equal(lock.archives["linux-x64"].file, `node-${lock.version}-linux-x64.tar.gz`);
  assert.equal(lock.archives["linux-arm64"].file, `node-${lock.version}-linux-arm64.tar.gz`);
  assert.equal(lock.archives["linux-x64"].sha256.length, 64);
  assert.equal(lock.archives["linux-arm64"].sha256.length, 64);
});

test("Linux no-node launcher resolves SFL_NODE_BINARY and rejects old Node", { skip: process.platform === "win32" }, async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const script = path.resolve(import.meta.dirname, "../desktop/linux/Launch-SFL.sh");
  const found = (await execute(script, ["--resolve-only"], { env: { ...process.env, SFL_NODE_BINARY: process.execPath }, encoding: "utf8" })).stdout.trim();
  assert.equal(path.resolve(found), path.resolve(process.execPath));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-linux-launcher-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const oldNode = path.join(dir, "old-node");
  await fs.writeFile(oldNode, "#!/bin/sh\necho v20.0.0\n", { mode: 0o755 });
  await assert.rejects(
    execute(script, ["--resolve-only"], { env: { ...process.env, SFL_NODE_BINARY: oldNode } }),
    /Node\.js 22\+/u,
  );
  await assert.rejects(
    execute(script, ["--resolve-only"], { env: { ...process.env, SFL_NODE_BINARY: path.join(dir, "missing") } }),
    /absolute Node\.js executable/u,
  );
});

test("Windows local client opens loopback URLs with cmd start so #connect= reaches the browser", () => {
  const url = "http://127.0.0.1:12345/#connect=ticket";
  const windows = browserLaunchSpec(url, "win32");
  assert.equal(windows.command, process.env.ComSpec && process.env.ComSpec.length > 0 ? process.env.ComSpec : "cmd.exe");
  assert.deepEqual(windows.args, ["/c", "start", '""', `"${url}"`]);
  assert.equal(windows.windowsVerbatimArguments, true);
  assert.ok(!JSON.stringify(windows).toLowerCase().includes("explorer"));
  assert.deepEqual(browserLaunchSpec(url, "darwin"), { command: "/usr/bin/open", args: [url] });
  assert.deepEqual(browserLaunchSpec(url, "linux"), { command: "xdg-open", args: [url] });
  assert.throws(() => browserLaunchSpec("https://example.com/", "win32"), /non-local/u);
});

test("local browser/native session enforces origin, authentication, one-use launch tickets and operation boundaries", async (t) => {
  const { local, request, api } = await isolated(t);
  assert.equal((await fetch(local.origin + "/")).status, 200);
  assert.equal((await fetch(local.origin + "/api/state")).status, 401);
  assert.equal((await fetch(local.origin + "/api/integrations")).status, 401);
  const integration = await (await request("/api/integrations")).json();
  const connection = await (await request("/api/connection")).json();
  assert.equal(integration.schema, "figure-library.local-integration-guide.v1");
  assert.deepEqual(JSON.parse(integration.snippets.find((item: { id: string }) => item.id === "json").content), connection);
  assert.equal(integration.command, process.execPath);
  assert.ok(!JSON.stringify(integration).includes(local.token));
  const cache = await api("/api/preview-cache");
  assert.equal(cache.schema, "figure-library.local-preview-cache.v1");
  assert.equal(typeof cache.complete, "boolean");
  assert.ok(Array.isArray(cache.sources));
  const filled = await api("/api/preview-cache", { limit: 1 });
  assert.equal(filled.schema, "figure-library.local-preview-cache.v1");
  const proxy = await api("/api/https-proxy");
  assert.equal(proxy.schema, "figure-library.https-proxy.v1");
  assert.equal(proxy.proxyUrl, null);
  const saved = await api("/api/https-proxy", { proxyUrl: "http://127.0.0.1:7890" });
  assert.equal(saved.proxyUrl, "http://127.0.0.1:7890");
  const denied = await request("/api/https-proxy", { proxyUrl: "http://8.8.8.8:7890" });
  assert.equal(denied.status, 400);
  assert.match(String(record(await denied.json()).error), /loopback/u);
  const cleared = await api("/api/https-proxy", { proxyUrl: "" });
  assert.equal(cleared.proxyUrl, null);
  assert.equal((await request("/api/state", undefined, { Origin: "https://unrelated.example" })).status, 403);
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = get(local.origin + "/api/state", { headers: { Host: "unrelated.example", Authorization: `Bearer ${local.token}` } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
  assert.equal(wrongHost, 403);
  const ticket = new URLSearchParams(new URL(local.openUrl()).hash.slice(1)).get("connect");
  const connected = await fetch(local.origin + "/api/connect", { method: "POST", headers: { "Content-Type": "application/json", Origin: local.origin }, body: JSON.stringify({ ticket }) });
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=Strict/u);
  assert.equal((await fetch(local.origin + "/api/state", { headers: { Cookie: cookie.split(";")[0]! } })).status, 200);
  assert.equal((await request("/api/connect", { ticket })).status, 401);
  assert.equal((await request("/api/call", { name: "figure_library_confirm_selection_headless", arguments: {} })).status, 403);
  assert.equal((await request("/api/call", { name: "figure_library_apply_bind_global", arguments: { planDigest: "0".repeat(64) } })).status, 403);
  assert.equal((await request("/api/resource", { uri: "file:///etc/passwd" })).status, 400);
  assert.equal((await request("/api/confirm", { previewChallenge: "fake", imageLoaded: false, displayedImageSha256: "0".repeat(64), confirmedBy: "user" })).status, 400);
  assert.equal(record(await api("/api/state?revision=0")).search, undefined);
  assert.equal((await request("/not-a-route")).status, 404);
});

test("local client binds, uploads, imports, reviews, publishes, previews and materializes through existing contracts", async (t) => {
  const { root, local, service, api, call, overrides } = await isolated(t);
  const plannedBinding = await call("figure_library_plan_bind_global", { libraryDirectory: overrides.FIGURE_LIBRARY_DIR, migrationMode: "none" });
  const binding = record(data(plannedBinding).plan);
  assert.equal(record(data(plannedBinding).envelope).outcome, "needs_user_confirmation");
  assert.equal(record(data(await call("figure_library_apply_bind_global", { planDigest: binding.planDigest, operationId: "bind-local-test" }, true)).envelope).outcome, "applied");
  const workspace = record(data(await call("figure_library_plan_bind_workspace", { workspaceDirectory: overrides.FIGURE_WORKSPACE_DIR })).plan);
  await call("figure_library_apply_bind_workspace", { planDigest: workspace.planDigest, operationId: "workspace-local-test" }, true);
  assert.equal(code(await call("figure_library_source_status")), "source_status_ready");
  const upload = async (name: string, bytes: Uint8Array) => {
    const response = await fetch(local.origin + "/api/upload", { method: "POST", headers: { Authorization: `Bearer ${local.token}`, "x-sfl-filename": name }, body: new Uint8Array(bytes) });
    assert.equal(response.status, 200);
    return String(record(await response.json()).sourcePath);
  };
  const imagePath = await upload("reference.png", png);
  const codePath = await upload("plot.R", Buffer.from("stop('must not execute')\n"));
  const planned = await call("figure_library_plan_working_revision", {
    mode: "create", templateId: "template-123d4567-1234-1234-1234-123456789abc", title: "localclientfixture reference", description: "Local image and code", application: "Reusable visual reference for localclientfixture", dataProfile: "x y",
    language: "R", license: "MIT", tags: ["localclientfixture"], assetKind: "plot_template", codeStatus: "scaffold", executionStatus: "not_run",
    visualAssets: [{ assetId: "reference", sourcePath: imagePath, visualRole: "source_reference" }],
    codeAssets: [{ assetId: "code", sourcePath: codePath, codeOrigin: "user_supplied", language: "R" }],
    canonicalCodeAssetId: "code",
    figureCodeLinks: [{ visualAssetId: "reference", codeAssetIds: ["code"], relationship: "user_supplied_pair", confirmedBy: "user", evidence: "User selected and confirmed this pair in the local UI." }],
    confirmations: { createOrUpdate: true, figureUnitBoundary: true, multiImageGrouping: true, primaryPreview: true, assetKind: true, canonicalImplementation: true, codeRelationships: true, codeOrigin: true, executionClaim: true, duplicateDecision: "create_new" },
  });
  const plan = record(data(planned).plan);
  assert.equal(record(data(planned).envelope).outcome, "needs_user_confirmation", JSON.stringify(planned));
  const applied = await call("figure_library_apply_working_revision", { planDigest: plan.planDigest, operationId: "local-test-import", expectedAction: plan.action, expectedTemplateId: plan.templateId, expectedSeriesDigest: plan.expectedSeriesDigest }, true);
  assert.equal(record(data(applied).envelope).outcome, "applied");
  const library = data(await api("/api/library"));
  assert.equal((library.items as unknown[]).length, 1);
  const review = await call("figure_library_review_open", { templateId: plan.templateId });
  assert.ok(data(review).workingContent);
  const content = record(data(review).workingContent);
  const file = await api("/api/asset", { templateId: plan.templateId, revisionId: content.revisionId, contentDigest: content.contentDigest, logicalPath: (content.assets as Array<Record<string, unknown>>).find((asset) => asset.role === "code")!.logicalPath });
  assert.equal(Buffer.from(String(data(file).data), "base64").toString(), "stop('must not execute')\n");
  const publication = record(data(await call("figure_library_plan_publish_working_revision", { templateId: plan.templateId })).plan);
  const published = await call("figure_library_apply_publish_working_revision", { planDigest: publication.planDigest, operationId: "local-test-publish", expectedTemplateId: plan.templateId, expectedSeriesDigest: publication.expectedSeriesDigest }, true);
  assert.equal(record(data(published).envelope).outcome, "applied", JSON.stringify(published));
  // A real external MCP client and the local app use the same business state.
  // The client exists only in this test; the local implementation has no MCP client.
  const mcp = await createServer({ service });
  const external = new Client({ name: "external-client-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(b);
  await external.connect(a);
  t.after(async () => { await external.close(); await mcp.close(); });
  const search = await external.callTool({ name: "figure_library_search", arguments: { query: "localclientfixture", providerIds: ["org.scientificfigurelibrary.local"] } });
  assert.ok((data(search).candidates as unknown[])?.length, JSON.stringify(search));
  const candidate = record((data(search).candidates as unknown[])[0]);
  const selection = { resultSetId: data(search).resultSetId, providerId: candidate.providerId, exactSelector: candidate.exactSelector };
  const preview = await api("/api/preview", selection);
  const exact = data(preview);
  const image = (preview.content as Array<Record<string, unknown>>).find((block) => block.type === "image")!;
  assert.equal(exact.transportSha256, hash(Buffer.from(String(image.data), "base64")));
  assert.equal(code(await service.execute("figure_library_confirm_selection_headless", { previewChallenge: exact.previewChallenge })), "preview_confirmation_mode_mismatch");
  assert.equal(code(await api("/api/confirm", { previewChallenge: exact.previewChallenge, displayedImageSha256: "0".repeat(64), imageLoaded: true, confirmedBy: "user" })), "preview_display_mismatch");
  const confirmed = await api("/api/confirm", { previewChallenge: exact.previewChallenge, displayedImageSha256: exact.transportSha256, imageLoaded: true, confirmedBy: "user" });
  assert.equal(code(confirmed), "preview_confirmed_local");
  const otherService = await createLibraryService({ registry: createDefaultProviderRegistry() });
  try {
    const rejected = await otherService.execute("figure_library_plan_materialize", { ...selection, previewReceipt: data(confirmed).previewReceipt, destination: path.join(root, "other-project"), allowNetwork: false });
    assert.equal(code(rejected), "preview_required");
  } finally { await otherService.close(); }
  const materialize = await call("figure_library_plan_materialize", { ...selection, previewReceipt: data(confirmed).previewReceipt, destination: path.join(root, "project"), allowNetwork: false });
  const prepared = record(data(materialize).plan);
  assert.equal(record(prepared.previewConfirmation).confirmationMode, "local");
  const applyArgs = { planDigest: prepared.planDigest, operationId: "local-test-materialize", expectedProviderId: candidate.providerId, expectedTarget: prepared.target };
  assert.equal(record(data(await call("figure_library_apply_materialize", applyArgs, true)).envelope).outcome, "applied");
  assert.equal(record(data(await call("figure_library_apply_materialize", applyArgs, true)).envelope).outcome, "replayed");
  const resource = String(candidate.thumbnailUri);
  assert.deepEqual(await service.readResource(resource), await external.readResource({ uri: resource }));

});

test("closing a shared service ends direct operations and local preview access", async (t) => {
  const { local, service } = await isolated(t);
  await local.close();
  await assert.rejects(service.execute("figure_library_source_status"), /closed/u);
  await assert.rejects(service.local.library(), /closed/u);
  await assert.rejects(service.readResource("figure-library://guidance/figure-library/SKILL.md"), /closed/u);
});
