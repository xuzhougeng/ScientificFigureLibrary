import assert from "node:assert/strict";
import test from "node:test";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  PERSONAL_MODULE_PROVIDER_ID,
  assertExactTemplateSelector,
  assertFigureYaSelectorMatches,
  assertFigureYaSourceSelectorMatches,
  assertLocalPublishedSelectorMatches,
  exactSelectorDigest,
  figureYaCandidateSelector,
  figureYaExactSelector,
  localPublishedExactSelector,
  moduleArchiveExactSelector,
  assertModuleArchiveSelectorMatches,
  normalizeProviderId,
} from "../src/providers.ts";
import type { FigureYaCatalog, FigureYaModule, ModuleCatalogEntry } from "../src/types.ts";

const module: FigureYaModule = {
  moduleId: "FigureYaProviderTest",
  title: "Provider test",
  requirement: "test",
  application: "test",
  inputSummary: "test",
  codeFiles: ["plot.R"],
  inputFiles: [],
  packages: [],
  files: [],
  archiveAvailable: true,
  archiveBytes: 42,
  archiveSha256: "a".repeat(64),
  archiveIdentity: "sha256",
  sourceUrl: "https://example.invalid/source",
  fullText: "provider test",
};

const catalog: FigureYaCatalog = {
  schema: "figure-library.figureya-catalog.v2",
  generatedAt: "2026-08-10T00:00:00Z",
  figureya: { repository: "https://example.invalid/FigureYa", commit: "source-commit" },
  compressed: {
    repository: "https://example.invalid/FigureYa-compressed",
    commit: "archive-commit",
  },
  citation: "test",
  modules: [module],
};

const sourceOnlyModule: FigureYaModule = {
  ...module,
  moduleId: "FigureYaSourceOnly",
  archiveAvailable: false,
  archiveBytes: undefined,
  archiveSha256: undefined,
  archiveIdentity: undefined,
};

const sourceOnlyCatalog: FigureYaCatalog = {
  ...catalog,
  modules: [sourceOnlyModule],
};

test("provider selectors are tagged, portable, and content stable", () => {
  const selector = figureYaExactSelector(catalog, module, "template");
  assert.equal(selector.providerId, FIGUREYA_PROVIDER_ID);
  assert.equal(selector.kind, "figureya-module.v1");
  assert.equal(selector.identity.archive.algorithm, "sha256");
  assertExactTemplateSelector(selector);
  assertFigureYaSelectorMatches(selector, catalog, module, "template");
  assert.equal(exactSelectorDigest(selector), exactSelectorDigest({
    kind: selector.kind,
    identity: { ...selector.identity },
    providerId: selector.providerId,
    schema: selector.schema,
  }));
  assert.throws(
    () => assertFigureYaSelectorMatches(selector, catalog, module, "full"),
    /stale FigureYa selector/u,
  );
});

test("FigureYa source-only selectors reject stale or unsupported identities", () => {
  const selector = figureYaCandidateSelector(sourceOnlyCatalog, sourceOnlyModule);
  assert.equal(selector.kind, "figureya-source-module.v1");
  assertFigureYaSourceSelectorMatches(selector, sourceOnlyCatalog, sourceOnlyModule);
  assert.throws(
    () =>
      assertFigureYaSourceSelectorMatches(
        { ...selector, identity: { ...selector.identity, sourceCommit: "other-commit" } },
        sourceOnlyCatalog,
        sourceOnlyModule,
      ),
    /stale FigureYa source selector/u,
  );
  assert.throws(
    () =>
      assertFigureYaSourceSelectorMatches(
        { ...selector, kind: "unrelated-provider-kind.v1" },
        sourceOnlyCatalog,
        sourceOnlyModule,
      ),
    /not a FigureYa source-module selector/u,
  );
});

test("Local Published selectors preserve the complete immutable identity", () => {
  const identity = {
    templateId: "template-1",
    revisionId: "revision-2",
    contentDigest: "b".repeat(64),
    releaseId: "release-3",
  };
  const selector = localPublishedExactSelector(identity);
  assert.equal(selector.providerId, LOCAL_LIBRARY_PROVIDER_ID);
  assert.equal(selector.kind, "local-published.v1");
  assertLocalPublishedSelectorMatches(selector, identity);
  assert.throws(
    () => assertLocalPublishedSelectorMatches(selector, { ...identity, releaseId: "release-4" }),
    /stale Local Published selector/u,
  );
});

test("legacy sourceId is normalized only at an input compatibility boundary", () => {
  assert.equal(normalizeProviderId({ sourceId: "figureya" }), FIGUREYA_PROVIDER_ID);
  assert.equal(normalizeProviderId({ sourceId: "user" }), LOCAL_LIBRARY_PROVIDER_ID);
  assert.equal(
    normalizeProviderId({ providerId: "org.example.future-provider" }),
    "org.example.future-provider",
  );
  assert.throws(() => normalizeProviderId({ sourceId: "future" }), /providerId is required/u);
});

test("personal module selectors bind source, archive, Catalog, preview, and mode", () => {
  const entry: ModuleCatalogEntry = {
    moduleId: "personal-selector-fixture",
    title: "个人选择器测试",
    titleEn: "Personal selector fixture",
    description: "Selector identity fixture.",
    application: "Test",
    dataProfile: "Synthetic CSV",
    plotFamily: "scatter",
    language: "R",
    tags: ["fixture"],
    packages: ["ggplot2"],
    codeFiles: ["code/plot.R"],
    inputFiles: ["data/input.csv"],
    canonicalCode: "code/plot.R",
    requiredFiles: ["code/plot.R", "data/input.csv"],
    files: [
      { path: "code/plot.R", bytes: 10, sha256: "1".repeat(64) },
      { path: "data/input.csv", bytes: 8, sha256: "2".repeat(64) },
    ],
    source: {
      repository: "jarxunlai/ScientificFigureLibrary-personal",
      commit: "3".repeat(40),
      path: "modules/personal-selector-fixture",
    },
    archive: {
      repository: "jarxunlai/ScientificFigureLibrary-personal",
      commit: "4".repeat(40),
      path: "archives/personal-selector-fixture.zip",
      bytes: 100,
      sha256: "5".repeat(64),
    },
    preview: {
      path: "previews/personal-selector-fixture/preview.png",
      bytes: 80,
      sha256: "6".repeat(64),
      mediaType: "image/png",
    },
    thumbnail: {
      path: "thumbs/personal-selector-fixture.png",
      bytes: 40,
      sha256: "7".repeat(64),
      mediaType: "image/png",
    },
    licenses: { code: "MIT", content: "CC BY 4.0", documentation: "CC BY 4.0" },
    publisher: {
      reviewStatus: "approved",
      executionStatus: "passed",
      executionScope: "synthetic_data",
    },
  };
  const selector = moduleArchiveExactSelector(
    PERSONAL_MODULE_PROVIDER_ID,
    entry,
    "8".repeat(64),
    "template",
  );
  assert.equal(selector.kind, "module-archive.v1");
  assert.equal(selector.identity.archive.commit, entry.archive.commit);
  assert.equal(selector.identity.preview.digest, entry.preview.sha256);
  assertModuleArchiveSelectorMatches(
    selector,
    PERSONAL_MODULE_PROVIDER_ID,
    entry,
    "8".repeat(64),
  );
  assert.throws(
    () =>
      assertModuleArchiveSelectorMatches(
        { ...selector, identity: { ...selector.identity, mode: "full" } },
        PERSONAL_MODULE_PROVIDER_ID,
        entry,
        "9".repeat(64),
      ),
    /stale module selector/u,
  );
});
