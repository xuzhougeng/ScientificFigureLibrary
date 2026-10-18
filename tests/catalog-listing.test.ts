import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCatalogListing, catalogEntrySummary } from "../src/catalog-listing.ts";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";
import { DefaultProviderRegistry, FigureYaProviderAdapter, LocalPublishedProviderAdapter } from "../src/provider-registry.ts";
import { FIGUREYA_PROVIDER_ID, LOCAL_LIBRARY_PROVIDER_ID } from "../src/providers.ts";
import { createServer } from "../src/server.ts";
import type { TemplateCandidate } from "../src/types.ts";
import { VersionedTemplateLibrary, type VersionedTemplateCandidate } from "../src/versioned-library.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const data = (result: unknown) => record(record(result).structuredContent);
const code = (result: unknown) => record(data(result).envelope).code;
const text = (result: unknown) => (record(result).content as Array<{ type: string; text?: string }>).find((block) => block.type === "text")?.text ?? "";
function entries(value: unknown) { assert.ok(Array.isArray(value)); return value.map(record); }

function fixture(title: string, plotFamily: string, language: "R" | "Python"): VersionedTemplateCandidate {
  const codePath = language === "R" ? "code/plot.R" : "code/plot.py";
  return {
    title, description: `catalogfixture ${plotFamily} reference for semantic listing`, tags: ["catalogfixture"],
    visualProfile: plotFamily, dataProfile: "gene matrix", packages: [], license: "MIT",
    assetKind: "plot_template", language, plotFamily, codeStatus: "reviewed", executionStatus: "not_run",
    canonicalImplementation: { assetPath: codePath, selectedBy: "user" },
    visualGrouping: { visualAssetPaths: ["visuals/source/preview.png"], confirmedBy: "user" },
    figureCodeLinks: [{ visualAssetPath: "visuals/source/preview.png", codeAssetPaths: [codePath], relationship: "user_supplied_pair", confirmedBy: "user", evidence: "Test fixture pair." }],
    assets: [
      { logicalPath: "visuals/source/preview.png", role: "visual", visualRole: "source_reference", mediaType: "image/png", bytes: png },
      { logicalPath: codePath, role: "code", codeOrigin: "user_supplied", language, text: "# must never execute\n" },
    ],
  };
}

test("catalog listing gives agents a compact, paginated, facet-counted catalog that plugs into candidate images and exact preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-catalog-listing-"));
  const overrides = {
    FIGURE_LIBRARY_DIR: path.join(root, "library"), FIGURE_WORKSPACE_DIR: path.join(root, "workspace"),
    SFL_WORKSPACE_LOCATOR_PATH: path.join(root, "config/workspace-locator.json"),
    SFL_DIAGNOSTICS_DIR: path.join(root, "diagnostics"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "config"), LOCALAPPDATA: path.join(root, "data"),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const server = await createServer({ registry: new DefaultProviderRegistry([new LocalPublishedProviderAdapter(), new FigureYaProviderAdapter()]) });
  const client = new Client({ name: "catalog-listing-host", version: "1" });
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

    const tool = (await client.listTools()).tools.find((entry) => entry.name === "figure_library_list_catalog");
    assert.ok(tool, "figure_library_list_catalog is registered");
    assert.equal(tool.annotations?.readOnlyHint, true);

    await ensureLibraryRootMarker(overrides.FIGURE_LIBRARY_DIR);
    await fs.mkdir(overrides.FIGURE_WORKSPACE_DIR);
    const library = new VersionedTemplateLibrary(overrides.FIGURE_LIBRARY_DIR);
    const publish = async (id: string, plotFamily: string, language: "R" | "Python") => {
      await library.applyCreateWorking(await library.planCreateWorking({ templateId: id, candidate: fixture(id, plotFamily, language) }), `${id}-working`);
      await library.applyPublish(await library.planPublish({ templateId: id }), `${id}-publish`);
    };
    await publish("listing-volcano-r", "volcano", "R");
    await publish("listing-volcano-py", "volcano", "Python");
    await publish("listing-heatmap-r", "heatmap", "R");

    const local = { providerIds: [LOCAL_LIBRARY_PROVIDER_ID] };
    const first = await call("figure_library_list_catalog", { ...local, limit: 2 });
    assert.equal(code(first), "catalog_listing_ready");
    assert.equal(data(first).total, 3);
    assert.equal(data(first).nextOffset, 2);
    assert.equal(JSON.stringify(data(first)).includes("data:image/"), false);
    assert.deepEqual(record(data(first).facets).plotFamily, [{ value: "volcano", count: 2 }, { value: "heatmap", count: 1 }]);
    assert.deepEqual(record(data(first).facets).language, [{ value: "R", count: 2 }, { value: "Python", count: 1 }]);
    const firstEntries = entries(data(first).entries);
    assert.equal(firstEntries.length, 2);
    for (const entry of firstEntries) {
      assert.match(String(entry.candidateId), /^candidate-[a-f0-9]{32}$/u);
      assert.equal(entry.providerId, LOCAL_LIBRARY_PROVIDER_ID);
      assert.match(String(entry.summary), /catalogfixture/u);
      assert.equal(entry.thumbnailAvailable, true);
    }
    assert.match(text(first), /^ENTRIES: candidateId \| title/mu);
    assert.match(text(first), /^FACET plotFamily: volcano=2, heatmap=1$/mu);
    assert.match(text(first), /not evidence that the library lacks/u);

    const resultSetId = data(first).resultSetId;
    const second = await call("figure_library_list_catalog", { resultSetId, offset: 2, limit: 2 });
    assert.equal(code(second), "catalog_listing_ready");
    assert.equal(entries(data(second).entries).length, 1);
    assert.equal(data(second).nextOffset, null);
    assert.equal(data(second).resultSetId, resultSetId);

    assert.equal(data(await call("figure_library_list_catalog", { ...local, plotFamily: "heatmap" })).total, 1);
    assert.equal(data(await call("figure_library_list_catalog", { ...local, language: "Python" })).total, 1);

    assert.equal(code(await call("figure_library_list_catalog", { resultSetId, plotFamily: "heatmap" })), "catalog_listing_invalid_input");
    assert.equal(code(await call("figure_library_list_catalog", { ...local, offset: 1 })), "catalog_listing_invalid_input");
    assert.equal(code(await call("figure_library_list_catalog", { resultSetId, offset: 4 })), "catalog_listing_invalid_input");
    const search = await call("figure_library_search", { query: "catalogfixture", ...local });
    assert.equal(code(await call("figure_library_list_catalog", { resultSetId: data(search).resultSetId })), "search_results_stale");

    // A listed candidate uses the ordinary thumbnail and exact-preview path; listing never creates receipts.
    const chosen = firstEntries[0]!;
    const images = await call("figure_library_get_candidate_images", { resultSetId, candidateIds: [chosen.candidateId] });
    assert.equal(code(images), "candidate_images_ready");
    const image = entries(data(images).images)[0]!;
    assert.equal(image.candidateId, chosen.candidateId);
    assert.equal("previewReceipt" in data(first), false);
    const exact = await call("figure_library_preview_exact_headless", { resultSetId, providerId: image.providerId, exactSelector: image.exactSelector });
    assert.equal(code(exact), "exact_preview_ready");

    const defaults = await call("figure_library_list_catalog", { limit: 1 });
    const sources = entries(data(defaults).sources);
    assert.ok(Number(sources.find((source) => source.providerId === FIGUREYA_PROVIDER_ID)?.matched) > 100);
    assert.equal(sources.find((source) => source.providerId === LOCAL_LIBRARY_PROVIDER_ID)?.matched, 3);
    assert.ok(Number(data(defaults).total) > 100);

    await publish("listing-pca-r", "pca", "R");
    assert.equal(code(await call("figure_library_list_catalog", { resultSetId, offset: 0 })), "search_results_stale");
  } finally {
    await client.close();
    await server.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("catalog listing summaries are single-line, bounded and fill missing facets", () => {
  const candidate = {
    providerId: "p", templateId: "t", exactSelector: { providerId: "p" }, title: "A |\ntitle",
    description: "# Heading\n\nLine one | with pipe.\n" + "x".repeat(200), excerpt: "", plotFamily: "", language: "",
    assetKind: "plot_template",
  } as unknown as TemplateCandidate;
  const summary = catalogEntrySummary(candidate);
  assert.equal(summary.includes("\n") || summary.includes("|"), false);
  assert.ok(summary.length <= 101);
  const listing = buildCatalogListing({ resultSetId: "rs", candidates: [candidate], sources: [] }, 0, 10);
  const [entry] = listing.structured.entries;
  assert.equal(entry!.title, "A title");
  assert.equal(entry!.plotFamily, "unclassified");
  assert.equal(entry!.language, "unknown");
  assert.equal(listing.structured.nextOffset, null);
  const empty = buildCatalogListing({ resultSetId: "rs", candidates: [], sources: [] }, 0, 10);
  assert.equal(empty.structured.total, 0);
  assert.match(empty.lines.at(-1)!, /do not claim the whole library lacks/u);
});
