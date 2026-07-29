import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { buildSearchIntent, CatalogIndex } from "../src/catalog.ts";
import {
  gitBlobSha1,
  inspectFigureYaSourcePack,
  materializeFigureYaTemplate,
  shouldIncludeTemplateFile,
  validateArchivePath,
} from "../src/materialize.ts";
import type { FigureYaCatalog, FigureYaModule } from "../src/types.ts";
import { UserTemplateLibrary } from "../src/user-library.ts";

test("FigureYa source retrieves common plot families", async () => {
  const index = await CatalogIndex.load();
  const cases = [
    ["volcano plot logFC p value", /volcano/iu],
    ["Kaplan Meier survival time status group", /surv|survival/iu],
    ["PCA expression matrix batch", /pca/iu],
    ["基因表达相关性热图", /heatmap|correlation/iu],
  ] as const;

  for (const [query, expected] of cases) {
    const results = index.search({ query, limit: 10 });
    assert.ok(results.length > 0, `no results for ${query}`);
    assert.match(
      results[0]?.templateId ?? "",
      expected,
      `${query} ranked the wrong family first: ${results.map((item) => item.templateId).join(", ")}`,
    );
    assert.ok(results.every((result) => result.sourceId === "figureya"));
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
    const results = index.search({ ...request, limit: 6 });
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
    index.search({ query: "multi volcano multiple groups", limit: 1 })[0]?.templateId,
    "FigureYa135multiVolcano",
  );
  assert.equal(
    index.search({ query: "bubble volcano point size", limit: 1 })[0]?.templateId,
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

test("FigureYa materialization prefers and verifies a Source Pack", async () => {
  assert.equal(
    gitBlobSha1(new Uint8Array()),
    "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  );

  const moduleId = "FigureYaSourcePackTest";
  const archive = zipSync({
    [`${moduleId}/${moduleId}.Rmd`]: strToU8("# source pack demo"),
    [`${moduleId}/easy_input.csv`]: strToU8("gene,logFC,p\nA,2,0.01\n"),
  });
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
    sourceUrl: "https://example.invalid/source",
    fullText: "Source Pack test",
  };
  const catalog: FigureYaCatalog = {
    schema: "figure-library.figureya-catalog.v1",
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

    const status = await inspectFigureYaSourcePack(catalog, pack);
    assert.deepEqual(status.availableTemplates, [moduleId]);
    assert.equal(status.invalidTemplates.length, 0);
    assert.equal(status.missingCount, 0);

    const result = await materializeFigureYaTemplate({
      catalog,
      module,
      destination: path.join(root, "output"),
      mode: "template",
      sourcePackDir: pack,
      allowNetwork: false,
    });
    assert.equal(result.archiveSource, "source-pack");
    assert.ok(result.files.includes(`upstream/${moduleId}.Rmd`));
    const lock = JSON.parse(
      await fs.readFile(path.join(result.target, "template.lock.json"), "utf8"),
    );
    assert.equal(lock.sourceId, "figureya");
    assert.equal(lock.archiveSource, "source-pack");
    assert.equal(lock.archiveLocation, path.join(pack, "archives", `${moduleId}.zip`));
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
    assert.match(imported.template.templateId, /^user-custom-single-cell-ridge-plot-/u);

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
    assert.match(results[0]?.previewDataUrl ?? "", /^data:image\/png;base64,/u);
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
