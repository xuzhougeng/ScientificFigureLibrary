import assert from "node:assert/strict";
import test from "node:test";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  assertExactTemplateSelector,
  assertFigureYaSelectorMatches,
  assertFigureYaSourceSelectorMatches,
  assertLocalPublishedSelectorMatches,
  exactSelectorDigest,
  figureYaCandidateSelector,
  figureYaExactSelector,
  localPublishedExactSelector,
  normalizeProviderId,
} from "../src/providers.ts";
import type { FigureYaCatalog, FigureYaModule } from "../src/types.ts";

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
