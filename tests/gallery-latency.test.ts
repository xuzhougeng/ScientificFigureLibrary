import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { createLibraryService } from "../src/library-service.ts";
import {
  DefaultProviderRegistry,
  LocalPublishedProviderAdapter,
  type ProviderContext,
} from "../src/provider-registry.ts";
import { LOCAL_LIBRARY_PROVIDER_ID } from "../src/providers.ts";
import { resetNetworkAccessForTests } from "../src/network-access.ts";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";
import { VersionedTemplateLibrary, type VersionedTemplateCandidate } from "../src/versioned-library.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const data = (value: unknown) => record(record(value).structuredContent);

/** Unique, structurally valid PNG per seed. */
function pngBytes(seed: number) {
  const image = new PNG({ width: 4, height: 4 });
  for (let index = 0; index < image.data.length; index += 1) image.data[index] = (seed * 37 + index * 11) % 256;
  return new Uint8Array(PNG.sync.write(image));
}

function candidate(index: number, title = `Latency fixture ${index}`): VersionedTemplateCandidate {
  return {
    title,
    description: "Synthetic Published template for latency regression tests.",
    tags: ["latencyfixture"],
    visualProfile: "points",
    dataProfile: "x y numeric",
    packages: ["ggplot2"],
    license: "MIT",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "scatter",
    codeStatus: "reviewed",
    executionStatus: "not_run",
    primaryPreview: "visuals/source/preview.png",
    canonicalImplementation: { assetPath: "code/plot.R", selectedBy: "user" },
    visualGrouping: { visualAssetPaths: ["visuals/source/preview.png"], confirmedBy: "user", note: "fixture" },
    figureCodeLinks: [{
      visualAssetPath: "visuals/source/preview.png", codeAssetPaths: ["code/plot.R"],
      relationship: "user_supplied_pair", confirmedBy: "user", evidence: "fixture",
    }],
    provenance: { source: "user-upload", recordId: `latency-${index}` },
    assets: [
      { logicalPath: "visuals/source/preview.png", role: "visual", visualRole: "source_reference", mediaType: "image/png", bytes: pngBytes(index + title.length), origin: { kind: "user_supplied" } },
      { logicalPath: "code/plot.R", role: "code", codeOrigin: "user_supplied", language: "R", text: `plot(1:${index + 1}) # ${title}\n`, origin: { kind: "user_supplied" } },
    ],
  };
}

async function publish(library: VersionedTemplateLibrary, templateId: string, value: VersionedTemplateCandidate, operation: string) {
  const plan = await library.planCreateWorking({ templateId, candidate: value });
  assert.deepEqual(plan.review.blockingGates, []);
  await library.applyCreateWorking(plan, `${operation}-working`);
  await library.applyPublish(await library.planPublish({ templateId }), `${operation}-publish`);
}

class CountingRegistry extends DefaultProviderRegistry {
  catalogRevisionCalls = 0;
  override async catalogRevision(providerIds: string[], context: ProviderContext) {
    this.catalogRevisionCalls += 1;
    return super.catalogRevision(providerIds, context);
  }
}

test("reference status checks the result set once, independent of candidate count", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-gallery-latency-"));
  const overrides = {
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "config"), LOCALAPPDATA: path.join(root, "data"),
    SFL_DIAGNOSTICS_DIR: path.join(root, "diagnostics"), SFL_WORKSPACE_LOCATOR_PATH: path.join(root, "config/workspace.json"),
    SFL_PREVIEW_CACHE_DIR: path.join(root, "library", "indexes", "preview-cache", "v1"),
    FIGURE_LIBRARY_DIR: path.join(root, "library"),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const registry = new CountingRegistry([new LocalPublishedProviderAdapter()]);
  const service = await createLibraryService({ registry });
  t.after(async () => {
    await service.close();
    resetNetworkAccessForTests();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const binding = record(data(await service.execute("figure_library_plan_bind_global", { libraryDirectory: overrides.FIGURE_LIBRARY_DIR, migrationMode: "none" })).plan);
  await service.execute("figure_library_apply_bind_global", { planDigest: binding.planDigest, operationId: "latency-bind" });
  await ensureLibraryRootMarker(overrides.FIGURE_LIBRARY_DIR);
  // A separate instance stands in for another process writing the shared Library.
  const writer = new VersionedTemplateLibrary(overrides.FIGURE_LIBRARY_DIR);
  for (let index = 0; index < 8; index += 1) {
    await publish(writer, `latency-${index}`, candidate(index), `latency-${index}`);
  }

  const gallery = data(await service.local.gallery({ providerIds: [LOCAL_LIBRARY_PROVIDER_ID], limit: 12 }));
  const ids = (gallery.candidates as unknown[]).map((item) => String(record(item).candidateId));
  assert.equal(ids.length, 8);

  registry.catalogRevisionCalls = 0;
  const single = await service.local.referenceStatus({ resultSetId: gallery.resultSetId, candidateIds: ids.slice(0, 1) });
  const singleCalls = registry.catalogRevisionCalls;
  registry.catalogRevisionCalls = 0;
  const all = await service.local.referenceStatus({ resultSetId: gallery.resultSetId, candidateIds: ids });
  assert.equal(singleCalls, 1);
  assert.equal(registry.catalogRevisionCalls, 1, "status must not re-check the catalog once per candidate");
  assert.equal(single.items.length, 1);
  assert.deepEqual(all.items.map((item) => item.candidateId), ids, "items keep request order");
  for (const item of all.items) {
    assert.equal(item.image, "cached");
    assert.equal(item.archive, "cached");
  }

  // Memoized listings must still observe writes from other Library instances.
  await publish(writer, "latency-3", candidate(3, "Latency fixture 3 revised"), "latency-3-v2");
  await assert.rejects(
    service.local.referenceStatus({ resultSetId: gallery.resultSetId, candidateIds: ids.slice(0, 1) }),
    (error: unknown) => record(error).code === "search_results_stale",
  );
  const refreshed = data(await service.local.gallery({ providerIds: [LOCAL_LIBRARY_PROVIDER_ID], limit: 12 }));
  const titles = (refreshed.candidates as unknown[]).map((item) => String(record(item).title));
  assert.ok(titles.includes("Latency fixture 3 revised"));
  assert.ok(!titles.includes("Latency fixture 3"));
});

test("memoized Published listing re-validates preview bytes when the file changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-listing-memo-"));
  try {
    await ensureLibraryRootMarker(root);
    const library = new VersionedTemplateLibrary(root);
    await publish(library, "memo-template", candidate(1), "memo");
    const [first] = await library.listPublishedEntries();
    assert.equal(first?.candidate.previewAvailable, true);
    // Returned entries are copies; mutating them must not leak into later listings.
    first!.candidate.tags.push("mutated");
    first!.content.title = "mutated";
    const [again] = await library.listPublishedEntries();
    assert.deepEqual(again?.candidate.tags, ["latencyfixture"]);
    assert.equal(again?.content.title, "Latency fixture 1");

    const asset = again!.content.assets.find((item) => item.logicalPath === "visuals/source/preview.png")!;
    const file = path.join(root, "store", "templates", "memo-template", "revisions", again!.content.revisionId, asset.file);
    const bytes = await fs.readFile(file);
    bytes.fill(0, 0, 8); // same size, broken PNG signature
    await fs.chmod(file, 0o644);
    await fs.writeFile(file, bytes);
    assert.equal((await library.listPublishedCandidates())[0]?.previewAvailable, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
