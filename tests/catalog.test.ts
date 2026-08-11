import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { strToU8, zipSync } from "fflate";
import { buildSearchIntent, CatalogIndex } from "../src/catalog.ts";
import {
  gitBlobSha1,
  figureYaMaterializePlanDigest,
  inspectFigureYaSourcePack,
  materializeFigureYaTemplate,
  shouldIncludeTemplateFile,
  validateArchivePath,
} from "../src/materialize.ts";
import { FIGUREYA_PROVIDER_ID, figureYaExactSelector } from "../src/providers.ts";
import type { FigureYaCatalog, FigureYaModule } from "../src/types.ts";
import { UserTemplateLibrary } from "../src/user-library.ts";

const execFileAsync = promisify(execFile);

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function figureYaPreviewManifest(
  catalog: FigureYaCatalog,
  module: FigureYaModule,
  bytes: Uint8Array,
) {
  return {
    schema: "figure-library.figureya-preview-manifest.v1",
    providerId: FIGUREYA_PROVIDER_ID,
    sourceRepository: catalog.figureya.repository,
    sourceCommit: catalog.figureya.commit,
    previews: [
      {
        moduleId: module.moduleId,
        file: module.primaryPreview ?? module.thumbnail,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        mediaType: "image/webp",
      },
    ],
  };
}

test("FigureYa source retrieves common plot families", async () => {
  const index = await CatalogIndex.load();
  const cases = [
    ["volcano plot logFC p value", /volcano/iu],
    ["Kaplan Meier survival time status group", /surv|survival/iu],
    ["PCA expression matrix batch", /pca/iu],
    ["基因表达相关性热图", /heatmap|correlation/iu],
  ] as const;

  for (const [query, expected] of cases) {
    const results = await index.search({ query, limit: 10 });
    assert.ok(results.length > 0, `no results for ${query}`);
    assert.match(
      results[0]?.templateId ?? "",
      expected,
      `${query} ranked the wrong family first: ${results.map((item) => item.templateId).join(", ")}`,
    );
    assert.ok(results.every((result) => result.providerId === FIGUREYA_PROVIDER_ID));
    assert.ok(results.every((result) => result.exactSelector.providerId === FIGUREYA_PROVIDER_ID));
    assert.ok(results.every((result) => !("previewDataUrl" in result)));
    assert.ok(results.every((result) => result.reviewStatus === "not_reviewed"));
    assert.ok(results.every((result) => result.executionStatus === "not_run"));
    const firstArchive = results.find((result) => result.materializable)?.exactSelector.identity
      .archive as { algorithm?: string } | undefined;
    assert.equal(firstArchive?.algorithm, "git-blob-sha1", "catalog v1 legacy identity was not preserved");
    assert.ok(results.every((result) => result.management.canArchive === false));
  }
});

test("Chinese and English bar-chart searches return the complete stable ranked set", async () => {
  const index = await CatalogIndex.load();
  for (const query of ["柱状图", "bar chart"]) {
    assert.deepEqual(buildSearchIntent({ query }).families, ["bar"]);
    const first = await index.searchAll({ query });
    const repeated = await index.searchAll({ query });
    const bounded = await index.search({ query, limit: 6 });
    assert.ok(first.length > 12, `${query} was prematurely truncated`);
    assert.equal(first[0]?.templateId, "FigureYa297Rbar");
    assert.deepEqual(
      repeated.map((item) => item.templateId),
      first.map((item) => item.templateId),
    );
    assert.deepEqual(
      bounded.map((item) => item.templateId),
      first.slice(0, 6).map((item) => item.templateId),
    );
  }
});

test("real Wisp volcano requests rank the standard template first", async () => {
  const index = await CatalogIndex.load();
  const requests = [
    {
      query:
        "火山图 volcano plot，用于展示差异分析结果：横轴 log2 fold change，纵轴 -log10 adjusted p-value/p-value，突出显著上调和下调特征，适合转录组/蛋白组/代谢组差异结果可视化",
      visualProfile:
        "Scatter volcano plot: x-axis log2FC centered at 0, y-axis -log10(padj or pvalue), vertical threshold lines for fold-change cutoffs, horizontal threshold line for significance cutoff, points colored by up/down/not significant, optional labels for top significant genes/features; publication-style clean theme.",
    },
    {
      query:
        "volcano plot differential expression 火山图 差异表达 RNA-seq DEG proteomics; scatter plot with log2FoldChange versus -log10 adjusted p-value, highlight up-regulated and down-regulated genes",
      dataProfile:
        "Differential analysis result table with one row per gene/feature; columns typically include gene symbol/id, log2FoldChange/log2FC, pvalue, padj/FDR; continuous x variable log2FC and p-value transformed y variable -log10(padj).",
      visualProfile:
        "Volcano plot / differential expression scatter: x=log2FoldChange, y=-log10(adjusted p-value), symmetric x limits around zero, vertical cutoff lines at ±1 log2FC, horizontal cutoff at adjusted p-value 0.05, colored significant up/down/non-significant points, optional gene labels for top hits.",
    },
  ];

  for (const request of requests) {
    assert.deepEqual(buildSearchIntent(request).families, ["volcano"]);
    const results = await index.search({ ...request, limit: 6 });
    assert.equal(
      results[0]?.templateId,
      "FigureYa59volcanoV2",
      results.map((item) => item.templateId).join(", "),
    );
  }
});

test("retrieval respects figure families and explicit specialized variants", async () => {
  const index = await CatalogIndex.load();
  assert.equal(buildSearchIntent({ query: "threshold" }).families.includes("forest"), false);
  assert.equal(
    (await index.search({ query: "multi volcano multiple groups", limit: 1 }))[0]?.templateId,
    "FigureYa135multiVolcano",
  );
  assert.equal(
    (await index.search({ query: "bubble volcano point size", limit: 1 }))[0]?.templateId,
    "FigureYa75bubble_volcano",
  );
});

test("FigureYa previews can be handed to an Agent for visual review", async () => {
  const index = await CatalogIndex.load();
  const preview = await index.preview("FigureYa59volcanoV2");
  assert.ok(preview);
  assert.equal(preview.mimeType, "image/webp");
  assert.equal(preview.extension, ".webp");
  assert.equal(Buffer.from(preview.bytes.subarray(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(preview.bytes.subarray(8, 12)).toString("ascii"), "WEBP");
});

test("FigureYa search does not advertise a declared preview with invalid image bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-invalid-preview-"));
  try {
    const module: FigureYaModule = {
      moduleId: "InvalidPreviewFixture",
      title: "invalidpreviewuniquemarker chart",
      requirement: "invalidpreviewuniquemarker chart",
      application: "preview validation",
      inputSummary: "x and y",
      codeFiles: [],
      inputFiles: [],
      packages: [],
      files: [],
      archiveAvailable: false,
      thumbnail: "thumbs/invalid.png",
      sourceUrl: "https://example.invalid/invalid-preview",
      fullText: "invalidpreviewuniquemarker",
    };
    const catalog: FigureYaCatalog = {
      schema: "figure-library.figureya-catalog.v1",
      generatedAt: "2026-08-10T00:00:00Z",
      figureya: {
        repository: "https://example.invalid/FigureYa",
        commit: "source-commit",
      },
      compressed: {
        repository: "https://example.invalid/FigureYa-compressed",
        commit: "archive-commit",
      },
      citation: "Test citation",
      modules: [module],
    };
    await fs.mkdir(path.join(root, "thumbs"), { recursive: true });
    const invalidBytes = Buffer.from("not a PNG");
    await fs.writeFile(path.join(root, "thumbs", "invalid.png"), invalidBytes);
    await fs.writeFile(path.join(root, "catalog.json"), `${JSON.stringify(catalog)}\n`);
    const manifest = figureYaPreviewManifest(catalog, module, invalidBytes);
    manifest.previews[0]!.mediaType = "image/png";
    await fs.writeFile(
      path.join(root, "figureya-preview.manifest.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    const index = await CatalogIndex.load(root);
    const result = (await index.search({ query: "invalidpreviewuniquemarker", limit: 1 }))[0];
    assert.ok(result);
    assert.equal(result.previewAvailable, false);
    assert.equal(result.previewRef, undefined);
    assert.ok(result.warnings.some((warning) => warning.includes("图像结构完整性校验")));
    await assert.rejects(index.preview(module.moduleId), /valid image\/png signature/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FigureYa preview selectors pin bytes and reject stale or tampered previews", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-stale-preview-"));
  try {
    const module: FigureYaModule = {
      moduleId: "PinnedPreviewFixture",
      title: "pinnedpreviewuniquemarker chart",
      requirement: "pinnedpreviewuniquemarker chart",
      application: "preview identity validation",
      inputSummary: "x and y",
      codeFiles: [],
      inputFiles: [],
      packages: [],
      files: [],
      archiveAvailable: false,
      thumbnail: "thumbs/preview.webp",
      sourceUrl: "https://example.invalid/pinned-preview",
      fullText: "pinnedpreviewuniquemarker",
    };
    const catalog: FigureYaCatalog = {
      schema: "figure-library.figureya-catalog.v1",
      generatedAt: "2026-08-10T00:00:00Z",
      figureya: {
        repository: "https://example.invalid/FigureYa",
        commit: "source-commit",
      },
      compressed: {
        repository: "https://example.invalid/FigureYa-compressed",
        commit: "archive-commit",
      },
      citation: "Test citation",
      modules: [module],
    };
    const firstBytes = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "assets", "thumbs", "FigureYa59volcanoV2.webp"),
    );
    const replacementBytes = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "assets", "thumbs", "FigureYa101PCA.webp"),
    );
    assert.notEqual(sha256(firstBytes), sha256(replacementBytes));
    await fs.mkdir(path.join(root, "thumbs"), { recursive: true });
    await fs.writeFile(path.join(root, "catalog.json"), `${JSON.stringify(catalog)}\n`);
    await fs.writeFile(path.join(root, "thumbs", "preview.webp"), firstBytes);
    await fs.writeFile(
      path.join(root, "figureya-preview.manifest.json"),
      `${JSON.stringify(figureYaPreviewManifest(catalog, module, firstBytes))}\n`,
    );

    const originalIndex = await CatalogIndex.load(root);
    const originalResult = (
      await originalIndex.search({ query: "pinnedpreviewuniquemarker", limit: 1 })
    )[0];
    assert.equal(originalResult?.previewAvailable, true);
    assert.equal(
      (originalResult?.exactSelector.identity.preview as { digest?: string } | undefined)?.digest,
      sha256(firstBytes),
    );
    assert.ok(await originalIndex.preview(originalResult!.exactSelector));

    await fs.writeFile(path.join(root, "thumbs", "preview.webp"), replacementBytes);
    const tamperedResult = (
      await originalIndex.search({ query: "pinnedpreviewuniquemarker", limit: 1 })
    )[0];
    assert.equal(tamperedResult?.previewAvailable, false);
    assert.equal(tamperedResult?.previewRef, undefined);
    await assert.rejects(
      originalIndex.preview(originalResult!.exactSelector),
      /disagree with the pinned SHA-256 identity/u,
    );

    await fs.writeFile(
      path.join(root, "figureya-preview.manifest.json"),
      `${JSON.stringify(figureYaPreviewManifest(catalog, module, replacementBytes))}\n`,
    );
    const reboundIndex = await CatalogIndex.load(root);
    await assert.rejects(
      reboundIndex.preview(originalResult!.exactSelector),
      /stale FigureYa source selector/u,
    );
    const reboundResult = (
      await reboundIndex.search({ query: "pinnedpreviewuniquemarker", limit: 1 })
    )[0];
    assert.equal(reboundResult?.previewAvailable, true);
    assert.notDeepEqual(reboundResult?.exactSelector, originalResult?.exactSelector);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("archive paths and template-mode files are bounded", () => {
  assert.equal(validateArchivePath("FigureYa59volcanoV2/main.Rmd"), "FigureYa59volcanoV2/main.Rmd");
  assert.throws(() => validateArchivePath("../escape.txt"));
  assert.throws(() => validateArchivePath("/etc/passwd"));
  assert.throws(() => validateArchivePath("C:\\Windows\\system.ini"));

  assert.equal(shouldIncludeTemplateFile("module/plot.Rmd"), true);
  assert.equal(shouldIncludeTemplateFile("module/easy_input_data.csv"), true);
  assert.equal(shouldIncludeTemplateFile("module/example.png"), true);
  assert.equal(shouldIncludeTemplateFile("module/huge-output.rds"), false);
});

test("catalog builds fail closed without a complete SHA-256 archive manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-catalog-build-"));
  const source = path.join(root, "FigureYa");
  const output = path.join(root, "assets");
  const treeFile = path.join(root, "tree.json");
  const manifestFile = path.join(root, "archive-manifest.json");
  const moduleId = "FigureYaBuildTest";
  const archiveBytes = 42;
  const gitBlobSha1 = "c".repeat(40);
  const archiveSha256 = "d".repeat(64);
  const script = path.resolve(import.meta.dirname, "..", "scripts", "build-catalog.mjs");
  const args = [
    script,
    "--source",
    source,
    "--figureya-commit",
    "source-commit",
    "--compressed-commit",
    "archive-commit",
    "--compressed-tree",
    treeFile,
    "--archive-manifest",
    manifestFile,
    "--output",
    output,
  ];
  try {
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(path.join(source, "gallery_compress"), { recursive: true });
    await fs.writeFile(path.join(source, "chapters.json"), "[]\n");
    await fs.writeFile(
      path.join(source, "file_list.json"),
      `${JSON.stringify({ [moduleId]: [{ name: "plot.R", size: 5 }] })}\n`,
    );
    await fs.writeFile(path.join(source, "LICENSE"), "test license\n");
    const previewBytes = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "assets", "thumbs", "FigureYa59volcanoV2.webp"),
    );
    await fs.writeFile(
      path.join(source, "gallery_compress", `${moduleId}.webp`),
      previewBytes,
    );
    await fs.writeFile(
      treeFile,
      `${JSON.stringify({
        truncated: false,
        tree: [{ type: "blob", path: `${moduleId}.zip`, size: archiveBytes, sha: gitBlobSha1 }],
      })}\n`,
    );
    const baseManifest = {
      archiveCommit: "archive-commit",
      archives: [
        {
          moduleId,
          file: `${moduleId}.zip`,
          bytes: archiveBytes,
          gitBlobSha1,
        },
      ],
    };
    await fs.writeFile(manifestFile, `${JSON.stringify(baseManifest)}\n`);
    await assert.rejects(execFileAsync(process.execPath, args), /lacks required SHA-256/u);

    await fs.writeFile(
      manifestFile,
      `${JSON.stringify({
        ...baseManifest,
        archives: [{ ...baseManifest.archives[0], sha256: archiveSha256 }],
      })}\n`,
    );
    await execFileAsync(process.execPath, args);
    const catalog = JSON.parse(await fs.readFile(path.join(output, "catalog.json"), "utf8"));
    assert.equal(catalog.schema, "figure-library.figureya-catalog.v2");
    assert.equal(catalog.modules[0].archiveSha256, archiveSha256);
    assert.equal(catalog.modules[0].archiveIdentity, "sha256");
    assert.deepEqual(catalog.modules[0].requiredFiles, ["plot.R"]);
    const packManifest = JSON.parse(
      await fs.readFile(path.join(output, "figureya-source-pack.manifest.json"), "utf8"),
    );
    assert.equal(packManifest.schema, "figure-library.source-pack.v2");
    assert.equal(packManifest.archives[0].sha256, archiveSha256);
    const previewManifest = JSON.parse(
      await fs.readFile(path.join(output, "figureya-preview.manifest.json"), "utf8"),
    );
    assert.equal(previewManifest.schema, "figure-library.figureya-preview-manifest.v1");
    assert.equal(previewManifest.providerId, FIGUREYA_PROVIDER_ID);
    assert.equal(previewManifest.sourceCommit, "source-commit");
    assert.deepEqual(previewManifest.previews, [
      {
        moduleId,
        file: `thumbs/${moduleId}.webp`,
        bytes: previewBytes.byteLength,
        sha256: sha256(previewBytes),
        mediaType: "image/webp",
      },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FigureYa materialization prefers and verifies a Source Pack", async () => {
  assert.equal(
    gitBlobSha1(new Uint8Array()),
    "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  );

  const moduleId = "FigureYaSourcePackTest";
  const archive = zipSync({
    [`${moduleId}/${moduleId}.Rmd`]: strToU8("# source pack demo"),
    [`${moduleId}/easy_input.csv`]: strToU8("gene,logFC,p\nA,2,0.01\n"),
    [`${moduleId}/example.png`]: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const module: FigureYaModule = {
    moduleId,
    title: moduleId,
    requirement: "Source Pack test",
    application: "",
    inputSummary: "gene, logFC, p",
    codeFiles: [`${moduleId}.Rmd`],
    inputFiles: ["easy_input.csv"],
    packages: [],
    files: [],
    archiveAvailable: true,
    archiveBytes: archive.byteLength,
    archiveGitBlobSha1: gitBlobSha1(archive),
    archiveSha256,
    archiveIdentity: "sha256",
    canonicalCode: `${moduleId}.Rmd`,
    requiredFiles: [`${moduleId}.Rmd`, "easy_input.csv", "example.png"],
    sourceUrl: "https://example.invalid/source",
    fullText: "Source Pack test",
  };
  const catalog: FigureYaCatalog = {
    schema: "figure-library.figureya-catalog.v2",
    generatedAt: "2026-07-29T00:00:00Z",
    figureya: {
      repository: "https://example.invalid/FigureYa",
      commit: "source-commit",
    },
    compressed: {
      repository: "https://example.invalid/FigureYa-compressed",
      commit: "archive-commit",
    },
    citation: "Test citation",
    modules: [module],
  };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-source-pack-test-"));
  const pack = path.join(root, "pack");
  try {
    await fs.mkdir(path.join(pack, "archives"), { recursive: true });
    await fs.writeFile(path.join(pack, "archives", `${moduleId}.zip`), archive);
    const unmanifested = await inspectFigureYaSourcePack(catalog, pack);
    assert.equal(unmanifested.manifestValid, false);
    assert.equal(unmanifested.ready, false);
    assert.equal(unmanifested.availableTemplates.length, 0);
    await fs.writeFile(
      path.join(pack, "figureya-source-pack.manifest.json"),
      `${JSON.stringify({
        schema: "figure-library.source-pack.v2",
        providerId: FIGUREYA_PROVIDER_ID,
        archiveRepository: catalog.compressed.repository,
        archiveCommit: catalog.compressed.commit,
        archives: [
          {
            moduleId,
            file: `archives/${moduleId}.zip`,
            bytes: archive.byteLength,
            gitBlobSha1: gitBlobSha1(archive),
            sha256: archiveSha256,
          },
        ],
      })}\n`,
    );

    const status = await inspectFigureYaSourcePack(catalog, pack);
    assert.equal(status.manifestValid, true);
    assert.equal(status.ready, true);
    assert.deepEqual(status.availableTemplates, [moduleId]);
    assert.equal(status.invalidTemplates.length, 0);
    assert.equal(status.missingCount, 0);

    await fs.writeFile(path.join(pack, "archives", `${moduleId}.zip`), new Uint8Array([1, 2, 3]));
    const corrupted = await inspectFigureYaSourcePack(catalog, pack);
    assert.equal(corrupted.ready, false);
    assert.deepEqual(corrupted.invalidTemplates, [moduleId]);
    await fs.writeFile(path.join(pack, "archives", `${moduleId}.zip`), archive);

    const exactSelector = figureYaExactSelector(catalog, module, "template");
    const operationId = "test-source-pack-materialize-001";
    const planDigest = figureYaMaterializePlanDigest(exactSelector);
    const result = await materializeFigureYaTemplate({
      catalog,
      module,
      destination: path.join(root, "output"),
      mode: "template",
      exactSelector,
      operationId,
      planDigest,
      sourcePackDir: pack,
      allowNetwork: false,
    });
    assert.equal(result.archiveSource, "source-pack");
    assert.ok(result.files.includes(`upstream/${moduleId}.Rmd`));
    assert.ok(result.files.includes(`assets/code/${moduleId}.Rmd`));
    assert.ok(result.files.includes("assets/visuals/example.png"));
    assert.ok(result.fileInventory.every((file) => file.bytes > 0 && /^[a-f0-9]{64}$/u.test(file.sha256)));
    const lock = JSON.parse(
      await fs.readFile(path.join(result.target, "template.lock.json"), "utf8"),
    );
    assert.equal(lock.providerId, FIGUREYA_PROVIDER_ID);
    assert.equal(lock.exactSelector.identity.archive.algorithm, "sha256");
    assert.equal(lock.exactSelector.identity.archive.digest, archiveSha256);
    assert.equal(lock.operation.operationId, operationId);
    assert.equal(lock.operation.planDigest, planDigest);
    const lockText = JSON.stringify(lock);
    assert.equal(lockText.includes(pack), false, "portable lock leaked a Source Pack path");
    assert.equal("createdAt" in lock, false);
    assert.equal("archiveLocation" in lock, false);
    assert.equal("archiveSource" in lock, false);

    for (const directory of ["visuals", "code", "references", "evidence"]) {
      assert.equal((await fs.stat(path.join(result.target, "assets", directory))).isDirectory(), true);
    }
    assert.equal(
      JSON.parse(await fs.readFile(path.join(result.target, "template.json"), "utf8")).review
        .localReviewStatus,
      "not_reviewed",
    );

    const replay = await materializeFigureYaTemplate({
      catalog,
      module,
      destination: path.join(root, "output"),
      mode: "template",
      exactSelector,
      operationId,
      planDigest,
      sourcePackDir: path.join(root, "does-not-need-to-exist"),
      allowNetwork: false,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.archiveSource, "existing");
    await assert.rejects(
      materializeFigureYaTemplate({
        catalog,
        module,
        destination: path.join(root, "output"),
        mode: "template",
        exactSelector,
        operationId: "different-operation",
        planDigest,
        sourcePackDir: pack,
        allowNetwork: false,
      }),
      /different operation|stale plan/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("user figures and code import, search, and materialize without executing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-user-test-"));
  try {
    const source = path.join(root, "source");
    await fs.mkdir(source);
    const previewPath = path.join(source, "ridge plot.png");
    const codePath = path.join(source, "plot.R");
    await fs.writeFile(previewPath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    await fs.writeFile(codePath, "library(ggridges)\n# reference only\n");

    const library = new UserTemplateLibrary(path.join(root, "library"));
    const imported = await library.importTemplate({
      title: "Custom single-cell ridge plot",
      description: "Ridge density distributions for single-cell marker expression.",
      tags: ["ridgeplot", "single cell"],
      visualProfile: "stacked density ridges",
      dataProfile: "long table: cell type, gene, expression",
      packages: ["ggridges", "ggplot2"],
      imagePath: previewPath,
      codePaths: [codePath],
    });
    assert.equal(imported.existed, false);
    assert.match(imported.template.templateId, /^user-direct-[a-f0-9]{16}$/u);
    assert.equal(imported.template.registry?.adapter, "direct");
    assert.equal(imported.template.registry?.identityMode, "content-addressed");
    assert.equal(imported.template.assetKind, "plot_template");
    assert.equal(imported.template.language, "R");

    const manifestPath = path.join(imported.directory, "template.json");
    const manifestText = await fs.readFile(manifestPath, "utf8");
    assert.equal(manifestText.includes(source), false, "manifest leaked an absolute source path");

    const repeated = await library.importTemplate({
      title: "Custom single-cell ridge plot",
      description: "Ridge density distributions for single-cell marker expression.",
      tags: ["ridgeplot", "single cell"],
      visualProfile: "stacked density ridges",
      dataProfile: "long table: cell type, gene, expression",
      packages: ["ggridges", "ggplot2"],
      imagePath: previewPath,
      codePaths: [codePath],
    });
    assert.equal(repeated.existed, true);
    assert.equal(repeated.template.templateId, imported.template.templateId);

    const results = await library.search({ query: "single cell ridge plot", limit: 3 });
    assert.equal(results[0]?.templateId, imported.template.templateId);
    assert.equal(results[0]?.management.adapter, "direct");
    assert.equal(results[0]?.management.canArchive, true);
    assert.equal("previewDataUrl" in (results[0] ?? {}), false);
    const preview = await library.preview(imported.template.templateId);
    assert.equal(preview?.mimeType, "image/png");
    assert.equal(Buffer.from(preview?.bytes ?? []).subarray(0, 4).toString("hex"), "89504e47");

    const materialized = await library.materialize(
      imported.template.templateId,
      path.join(root, "output"),
    );
    assert.equal(materialized.materializationSource, "user-library");
    assert.ok(materialized.files.includes("reference/code/plot.R"));
    const lock = JSON.parse(
      await fs.readFile(path.join(materialized.target, "template.lock.json"), "utf8"),
    );
    assert.equal(lock.sourceId, "user");
    assert.equal(lock.templateId, imported.template.templateId);

    await fs.appendFile(path.join(imported.directory, "code", "plot.R"), "# tampered\n");
    await assert.rejects(
      library.materialize(imported.template.templateId, path.join(root, "tampered-output")),
      /size mismatch|checksum mismatch/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
