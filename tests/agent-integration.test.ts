import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadGuidance, GUIDANCE_ROOT } from "../src/guidance.ts";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";
import { DefaultProviderRegistry, FigureYaProviderAdapter, LocalPublishedProviderAdapter } from "../src/provider-registry.ts";
import { createServer } from "../src/server.ts";
import { SEARCH_MAX_PAGE_DATA_URL_BYTES } from "../src/transport-image.ts";
import { VersionedTemplateLibrary, type VersionedTemplateCandidate } from "../src/versioned-library.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const data = (result: unknown) => record(record(result).structuredContent);
const code = (result: unknown) => record(data(result).envelope).code;
function entries(value: unknown) { assert.ok(Array.isArray(value)); return value.map(record); }
function fixture(title: string): VersionedTemplateCandidate {
  return {
    title, description: "agentnativefixture volcano", tags: ["agentnativefixture"],
    visualProfile: "volcano", dataProfile: "gene log2FC padj", packages: [], license: "MIT",
    assetKind: "plot_template", language: "R", plotFamily: "volcano", codeStatus: "reviewed", executionStatus: "not_run",
    canonicalImplementation: { assetPath: "code/plot.R", selectedBy: "user" },
    visualGrouping: { visualAssetPaths: ["visuals/source/preview.png"], confirmedBy: "user" },
    figureCodeLinks: [{ visualAssetPath: "visuals/source/preview.png", codeAssetPaths: ["code/plot.R"], relationship: "user_supplied_pair", confirmedBy: "user", evidence: "Test fixture pair." }],
    assets: [
      { logicalPath: "visuals/source/preview.png", role: "visual", visualRole: "source_reference", mediaType: "image/png", bytes: png },
      { logicalPath: "code/plot.R", role: "code", codeOrigin: "user_supplied", language: "R", text: "stop('must never execute')\n" },
    ],
  };
}

test("ordinary MCP host reads the single Skill, browses images/pages and materializes only after exact confirmation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-agent-integration-"));
  const overrides = {
    FIGURE_LIBRARY_DIR: path.join(root, "library"), FIGURE_WORKSPACE_DIR: path.join(root, "workspace"),
    SFL_WORKSPACE_LOCATOR_PATH: path.join(root, "config/workspace-locator.json"),
    SFL_DIAGNOSTICS_DIR: path.join(root, "diagnostics"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "config"), LOCALAPPDATA: path.join(root, "data"),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const sessions: Array<{ client: Client; server: Awaited<ReturnType<typeof createServer>> }> = [];
  const connect = async () => {
    const server = await createServer({ registry: new DefaultProviderRegistry([new LocalPublishedProviderAdapter(), new FigureYaProviderAdapter()]) });
    const client = new Client({ name: "ordinary-mcp-host", version: "1" }); // No Apps extension.
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    sessions.push({ client, server });
    return client;
  };
  try {
    const client = await connect();
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    assert.match(client.getInstructions() ?? "", /figure_library_get_skill/u);
    assert.equal(code(await call("figure_library_source_status")), "setup_required");
    const guidance = await call("figure_library_get_skill");
    assert.equal(code(guidance), "guidance_ready");
    assert.equal(data(guidance).text, await fs.readFile(path.join(GUIDANCE_ROOT, "SKILL.md"), "utf8"));
    assert.equal(data(guidance).sha256, hash(String(data(guidance).text)));
    const docs = entries(data(guidance).documents);
    assert.ok(docs.length > 5);
    const listed = await client.listResources();
    for (const doc of docs) {
      assert.ok(listed.resources.some((resource) => resource.uri === doc.uri));
      const fromTool = await call("figure_library_get_skill", { document: doc.document });
      const fromResource = await client.readResource({ uri: String(doc.uri) });
      assert.equal(record(fromResource.contents[0]).text, data(fromTool).text);
      assert.equal(hash(String(data(fromTool).text)), doc.sha256);
    }
    for (const document of ["../package.json", "references/../SKILL.md", "%2e%2e/package.json", path.join(root, "private.txt")]) {
      assert.equal(code(await call("figure_library_get_skill", { document })), "guidance_not_found");
    }
    const tools = (await client.listTools()).tools;
    assert.deepEqual(record(record(tools.find((tool) => tool.name === "figure_library_search_page")?._meta).ui).visibility, ["app", "model"]);
    const templates = await client.listResourceTemplates();
    assert.ok(templates.resourceTemplates.some((entry) => entry.uriTemplate.includes("candidate-images")));

    await ensureLibraryRootMarker(overrides.FIGURE_LIBRARY_DIR);
    await fs.mkdir(overrides.FIGURE_WORKSPACE_DIR);
    const library = new VersionedTemplateLibrary(overrides.FIGURE_LIBRARY_DIR);
    const publish = async (id: string) => {
      await library.applyCreateWorking(await library.planCreateWorking({ templateId: id, candidate: fixture(id) }), `${id}-working`);
      await library.applyPublish(await library.planPublish({ templateId: id }), `${id}-publish`);
    };
    for (const id of ["agent-one", "agent-two", "agent-three"]) await publish(id);
    const search = await call("figure_library_search", { query: "agentnativefixture", limit: 2 });
    const resultSetId = data(search).resultSetId;
    const candidates = entries(data(search).candidates);
    assert.equal(candidates.length, 2);
    assert.equal(data(search).total, 3);
    assert.equal(JSON.stringify(data(search)).includes("data:image/"), false);
    const requested = [...candidates].reverse();
    const images = await call("figure_library_get_candidate_images", { resultSetId, candidateIds: requested.map((candidate) => candidate.candidateId) });
    assert.equal(code(images), "candidate_images_ready");
    const imageMetadata = entries(data(images).images);
    const imageBlocks = entries(images.content).filter((block) => block.type === "image");
    assert.equal(imageBlocks.length, 2);
    assert.ok(imageBlocks.reduce((total, block) => total + String(block.data).length + 30, 0) <= SEARCH_MAX_PAGE_DATA_URL_BYTES);
    for (let i = 0; i < imageBlocks.length; i++) {
      const meta = imageMetadata[i]!;
      assert.equal(meta.candidateId, requested[i]!.candidateId);
      assert.deepEqual(meta.exactSelector, requested[i]!.exactSelector);
      assert.equal(meta.sourceSha256, hash(png));
      assert.equal(meta.sha256, hash(Buffer.from(String(imageBlocks[i]!.data), "base64")));
      assert.equal(meta.mimeType, imageBlocks[i]!.mimeType);
      assert.equal(meta.uri, requested[i]!.thumbnailUri);
      const resource = await client.readResource({ uri: String(meta.uri) });
      assert.equal(record(resource.contents[0]).blob, imageBlocks[i]!.data);
    }
    assert.equal("previewReceipt" in data(images), false);
    assert.equal("previewChallenge" in data(images), false);
    const selected = candidates[0]!;
    const selection = { resultSetId, providerId: selected.providerId, exactSelector: selected.exactSelector };
    assert.equal(code(await call("figure_library_get_candidate_images", { resultSetId, candidateIds: [selected.candidateId, selected.candidateId] })), "preview_selection_mismatch");
    assert.equal(code(await call("figure_library_get_candidate_images", { resultSetId, candidateIds: [`candidate-${"0".repeat(32)}`] })), "preview_selection_mismatch");
    assert.equal((await call("figure_library_get_candidate_images", { resultSetId, candidateIds: Array(13).fill(selected.candidateId) })).isError, true);
    const second = await call("figure_library_search_page", { resultSetId, cursor: data(search).nextCursor });
    assert.equal(data(second).pageIndex, 2);
    const last = entries(data(second).candidates)[0]!;
    assert.equal(code(await call("figure_library_get_candidate_images", { resultSetId, candidateIds: [last.candidateId] })), "candidate_images_ready");
    const otherSearch = await call("figure_library_search", { query: "agentnativefixture", limit: 2 });
    assert.equal(code(await call("figure_library_get_candidate_images", { resultSetId: data(otherSearch).resultSetId, candidateIds: [selected.candidateId] })), "preview_selection_mismatch");
    assert.equal(code(await call("figure_library_search_page", { resultSetId: data(otherSearch).resultSetId, cursor: data(search).nextCursor })), "search_results_stale");

    const destination = path.join(root, "project");
    assert.equal(code(await call("figure_library_plan_materialize", { ...selection, destination, allowNetwork: false })), "preview_required");
    const exact = await call("figure_library_preview_exact_headless", selection);
    assert.equal(code(exact), "exact_preview_ready");
    assert.ok(entries(exact.content).some((block) => block.type === "image"));
    const other = await connect();
    assert.equal(code(await other.callTool({ name: "figure_library_confirm_selection_headless", arguments: { previewChallenge: data(exact).previewChallenge } })), "preview_challenge_invalid");
    assert.equal(code(await other.callTool({ name: "figure_library_get_candidate_images", arguments: { resultSetId, candidateIds: [selected.candidateId] } })), "search_results_stale");
    await assert.rejects(other.readResource({ uri: String(selected.thumbnailUri) }), /search|session/iu);
    const confirmed = await call("figure_library_confirm_selection_headless", { previewChallenge: data(exact).previewChallenge });
    const previewReceipt = data(confirmed).previewReceipt;
    assert.equal(code(await call("figure_library_confirm_selection_headless", { previewChallenge: data(exact).previewChallenge })), "preview_challenge_invalid");
    const planArgs = { ...selection, previewReceipt, destination, allowNetwork: false };
    const planned = await call("figure_library_plan_materialize", planArgs);
    assert.equal(code(planned), "materialization_plan_ready");
    assert.notEqual(code(await call("figure_library_plan_materialize", planArgs)), "materialization_plan_ready");
    const plan = record(data(planned).plan);
    const applyArgs = { planDigest: plan.planDigest, operationId: "agent-materialize", expectedProviderId: selected.providerId, expectedTarget: path.join(destination, String(selected.templateId)) };
    const applied = await call("figure_library_apply_materialize", applyArgs);
    assert.equal(record(data(applied).envelope).outcome, "applied");
    assert.equal(record(data(await call("figure_library_apply_materialize", applyArgs)).envelope).outcome, "replayed");
    assert.equal(await fs.readFile(path.join(String(applyArgs.expectedTarget), "assets/code/plot.R"), "utf8"), "stop('must never execute')\n");

    await publish("agent-four");
    assert.equal(code(await call("figure_library_get_candidate_images", { resultSetId, candidateIds: [selected.candidateId] })), "search_results_stale");
    await assert.rejects(client.readResource({ uri: String(selected.thumbnailUri) }), /changed|stale/iu);
    assert.equal(code(await call("figure_library_search_page", { resultSetId, cursor: data(search).nextCursor })), "search_results_stale");
    const fresh = await call("figure_library_search", { query: "agentnativefixture" });
    const freshCandidate = entries(data(fresh).candidates)[0]!;
    process.env.FIGURE_LIBRARY_DIR = path.join(root, "another-library");
    await ensureLibraryRootMarker(process.env.FIGURE_LIBRARY_DIR);
    assert.equal(code(await call("figure_library_get_candidate_images", { resultSetId: data(fresh).resultSetId, candidateIds: [freshCandidate.candidateId] })), "search_results_stale");
  } finally {
    for (const { client, server } of sessions) { await client.close(); await server.close(); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("all bundled guidance links resolve to the same MCP-readable inventory", async () => {
  const documents = await loadGuidance();
  assert.deepEqual([...documents.keys()].filter((id) => id.endsWith("SKILL.md")), ["SKILL.md"]);
  for (const entry of documents.values()) {
    if (entry.mimeType !== "text/markdown") continue;
    for (const match of entry.text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)) {
      if (/^(?:https?:|#)/u.test(match[1]!)) continue;
      const id = path.posix.normalize(path.posix.join(path.posix.dirname(entry.document), match[1]!.split("#")[0]!));
      assert.ok(documents.has(id), `${entry.document}: missing MCP guidance ${id}`);
      const resourceUri = new URL(match[1]!, entry.uri).href;
      assert.equal(resourceUri.split("#")[0], documents.get(id)!.uri);
    }
  }
});
