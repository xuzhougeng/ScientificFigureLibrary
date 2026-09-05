import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogIndex } from "../src/catalog.ts";
import { ensureLibraryRootMarker, resolveLibraryRuntimeSnapshot } from "../src/library-runtime.ts";
import { LocalPublishedProviderAdapter, createProviderContext } from "../src/provider-registry.ts";
import { PortableBundleManager } from "../src/portable-bundles.ts";
import { VersionedTemplateLibrary, type VersionedTemplateCandidate } from "../src/versioned-library.ts";

const description = "对比**免疫细胞**组成。\n\n保留原始 Markdown。";
const application = "### 治疗相关变化\n\n- 检视不同条件下群体比例的差异。";
const dataProfile = "sample × celltype × fraction";

function candidate(): VersionedTemplateCandidate {
  return {
    title: "免疫细胞构成", description, application, dataProfile,
    visualProfile: "BLUE POINTS ONLY", assetKind: "visual_reference",
    codeStatus: "none", executionStatus: "not_run", tags: ["immunity"],
    visualGrouping: { visualAssetPaths: ["visuals/source/preview.png"], confirmedBy: "user" },
    assets: [{ logicalPath: "visuals/source/preview.png", role: "visual", visualRole: "source_reference", mediaType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") }],
  };
}

test("Markdown survives Working -> Published -> search/describe -> portable Working import", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-description-roundtrip-"));
  try {
    const source = path.join(root, "library");
    await ensureLibraryRootMarker(source);
    const snapshot = await resolveLibraryRuntimeSnapshot({ root: source });
    const library = new VersionedTemplateLibrary(snapshot);
    const plan = await library.planCreateWorking({ templateId: "immune-composition", candidate: candidate() });
    assert.equal(plan.content.application, application);
    await library.applyCreateWorking(plan, "create");
    const release = await library.applyPublish(await library.planPublish({ templateId: "immune-composition" }), "publish");
    const index = await CatalogIndex.load();
    const context = createProviderContext({ snapshot, versionedLibrary: library }, index);
    const adapter = new LocalPublishedProviderAdapter();
    const hits = await adapter.search(context, { query: "治疗相关变化" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.description, description);
    assert.equal(hits[0]!.application, application);
    assert.equal(hits[0]!.applicationOrigin, "explicit");
    assert.equal(hits[0]!.dataProfile, dataProfile);
    assert.equal(hits[0]!.visualProfile, "BLUE POINTS ONLY");
    const exact = await adapter.resolve(context, hits[0]!.exactSelector, "describe");
    assert.equal((await adapter.describe(context, exact)).detail.content.application, application);

    const manager = new PortableBundleManager(source, library);
    const exported = await manager.applyExport(await manager.planPublishedTemplateExport({
      templateId: "immune-composition", releaseId: release.releaseId,
      destination: path.join(root, "exports"), targetName: "template",
    }), "export");
    const target = path.join(root, "target");
    await ensureLibraryRootMarker(target);
    const targetLibrary = new VersionedTemplateLibrary(target);
    const targetManager = new PortableBundleManager(target, targetLibrary);
    const imported = await targetManager.planTemplateBundleImport({
      bundleDirectory: exported.target, targetTemplateId: "copied-immune", mode: "create",
    });
    assert.equal(imported.lifecyclePlan.content.application, application);
    assert.equal(imported.lifecyclePlan.content.description, description);
    assert.equal(imported.lifecyclePlan.content.dataProfile, dataProfile);
    const applied = await targetManager.applyTemplateBundleImport(imported, "import");
    const stored = await targetLibrary.getContent("copied-immune", applied.revisionId!, applied.contentDigest!);
    assert.equal(stored!.application, application);
    assert.equal((await targetLibrary.listPublishedCandidates()).length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("legacy Published projections extract applications without rewriting immutable content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-description-legacy-"));
  try {
    await ensureLibraryRootMarker(root);
    const snapshot = await resolveLibraryRuntimeSnapshot({ root });
    const library = new VersionedTemplateLibrary(snapshot);
    const legacy = { ...candidate(), application: undefined, description: "Background\n\n## 适用场景\n\n- legacy needle" };
    const plan = await library.planCreateWorking({ templateId: "legacy-immune", candidate: legacy });
    await library.applyCreateWorking(plan, "create");
    await library.applyPublish(await library.planPublish({ templateId: "legacy-immune" }), "publish");
    const context = createProviderContext({ snapshot, versionedLibrary: library }, await CatalogIndex.load());
    const hits = await new LocalPublishedProviderAdapter().search(context, { query: "legacy needle" });
    assert.equal(hits[0]!.applicationOrigin, "legacy_description");
    assert.equal(hits[0]!.application, "- legacy needle");
    assert.equal(hits[0]!.description, "Background");
    const stored = await library.getContent(plan.content.templateId, plan.content.revisionId, plan.content.contentDigest);
    assert.equal(stored!.description, legacy.description);
    assert.equal(Object.hasOwn(stored!, "application"), false);
    assert.equal(stored!.contentDigest, plan.content.contentDigest);
    await assert.rejects(library.planCreateWorking({ templateId: "overlong", candidate: { ...candidate(), application: "x".repeat(8001) } }), /application/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
