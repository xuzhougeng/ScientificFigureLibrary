import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLibraryRootMarker, resolveLibraryRuntimeSnapshot } from "../src/library-runtime.ts";
import { buildOpenFigureModule } from "../src/open-figure-module.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function candidate(overrides: Partial<VersionedTemplateCandidate> = {}): VersionedTemplateCandidate {
  const base: VersionedTemplateCandidate = {
    title: "Cancer Cell通路NES热图",
    description: "A portable heatmap example.",
    tags: ["heatmap", "nes"],
    visualProfile: "Compare pathway NES values.",
    dataProfile: "A pathway table with subtype columns.",
    packages: ["ComplexHeatmap"],
    license: "unknown; private_reference only.",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "heatmap",
    codeStatus: "reviewed",
    executionStatus: "passed",
    validationState: {
      schema: "figure-library.validation-state.v1",
      plotExecution: { status: "passed", scope: "synthetic_data", evidenceAssetPaths: ["evidence/run.md"] },
      upstreamWorkflow: { status: "not_applicable" },
      scientificValidation: { status: "not_assessed" },
    },
    primaryPreview: "visuals/rendered/preview.png",
    primaryPreviewOverride: {
      confirmedBy: "user",
      reason: "Use the generated render as the public preview.",
    },
    canonicalImplementation: { assetPath: "code/code-organized.r", selectedBy: "user" },
    runtime: {schema:"figure-library.runtime-closure.v1",entrypoint:"code/code-organized.r",inputs:[{codePath:"data/pathway_nes.csv",assetPath:"references/nes-csv.csv",required:true,role:"example_data"}],output:{previewPath:"visuals/rendered/preview.png",mediaType:"image/png"}},
    visualGrouping: {
      visualAssetPaths: ["visuals/source/wechat-heatmap.png", "visuals/rendered/preview.png"],
      confirmedBy: "user",
    },
    figureCodeLinks: [
      {
        visualAssetPath: "visuals/rendered/preview.png",
        codeAssetPaths: ["code/code-organized.r", "code/code-example.r"],
        relationship: "generated_output",
        confirmedBy: "user",
        evidence: "The user confirmed the organized script generated this preview.",
      },
      {
        visualAssetPath: "visuals/source/wechat-heatmap.png",
        codeAssetPaths: ["code/code-organized.r"],
        relationship: "adapted_from_template",
        confirmedBy: "user",
        evidence: "The organized script is only generally inspired by the private source.",
      },
      {
        visualAssetPath: "visuals/source/wechat-heatmap.png",
        codeAssetPaths: ["code/code-original.r"],
        relationship: "author_provided_original",
        confirmedBy: "user",
        evidence: "The original script accompanied the source figure.",
      },
    ],
    assets: [
      {
        logicalPath: "code/code-organized.r",
        role: "code",
        codeOrigin: "adapted",
        language: "R",
        mediaType: "text/x-r-source",
        rights: { license: "MIT", distribution: "public" },
        text: "input <- read.csv('data/pathway_nes.csv')\nplot(input)\n",
      },
      {
        logicalPath: "code/code-example.r",
        role: "code",
        codeOrigin: "adapted",
        language: "R",
        mediaType: "text/x-r-source",
        text: "source('organized.R')\n",
      },
      {
        logicalPath: "code/code-original.r",
        role: "code",
        codeOrigin: "author_provided",
        language: "R",
        mediaType: "text/x-r-source",
        text: "# original third-party script\n",
      },
      {
        logicalPath: "references/nes-csv.csv",
        role: "reference",
        mediaType: "text/csv",
        rights: { license: "CC BY 4.0", distribution: "public" },
        text: "Pathway,A,B\nGlycolysis,1,2\n",
      },
      {
        logicalPath: "evidence/run.md",
        role: "evidence",
        mediaType: "text/markdown",
        text: "Local-only execution note.\n",
      },
      {
        logicalPath: "visuals/rendered/preview.png",
        role: "visual",
        visualRole: "rendered_output",
        mediaType: "image/png",
        rights: { license: "CC BY 4.0", distribution: "public" },
        bytes: new Uint8Array(PNG_BYTES),
      },
      {
        logicalPath: "visuals/source/wechat-heatmap.png",
        role: "visual",
        visualRole: "source_reference",
        mediaType: "image/png",
        bytes: new Uint8Array(PNG_BYTES),
      },
      {
        logicalPath: "evidence/render-png.png",
        role: "evidence",
        mediaType: "image/png",
        bytes: new Uint8Array(PNG_BYTES),
      },
    ],
  };
  const assets = overrides.assets ?? base.assets;
  const runtime = Object.hasOwn(overrides, "runtime")
    ? overrides.runtime
    : (overrides.assets && !base.runtime?.inputs.every((input) => assets.some((asset) => asset.logicalPath === input.assetPath)) ? undefined : base.runtime);
  return { ...base, ...overrides, runtime, assets };
}

async function publishedLibrary(templateId: string, overrides: Partial<VersionedTemplateCandidate> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-figure-module-"));
  await ensureLibraryRootMarker(root);
  const snapshot = await resolveLibraryRuntimeSnapshot({ root });
  const versionedLibrary = new VersionedTemplateLibrary(snapshot);
  const prepared = candidate(overrides);
  prepared.assets = prepared.assets.map((asset) => ({
    ...asset,
    rights: asset.rights ?? (asset.role === "code"
      ? { license: "MIT", distribution: "public" as const }
      : asset.role === "evidence"
        ? { license: "local-only", distribution: "local_only" as const }
        : { license: "CC BY 4.0", distribution: "public" as const }),
  }));
  await versionedLibrary.applyCreateWorking(
    await versionedLibrary.planCreateWorking({
      templateId,
      candidate: prepared,
    }),
    `${templateId}-working`,
  );
  await versionedLibrary.applyPublish(
    await versionedLibrary.planPublish({ templateId }),
    `${templateId}-publish`,
  );
  const published = (await versionedLibrary.listPublishedCandidates())[0]!;
  const content = await versionedLibrary.getContent(published.templateId, published.revisionId, published.contentDigest);
  assert.ok(content);
  return { root, versionedLibrary, content };
}

test("Open Figure sanitizer keeps generated preview and drops source/original/private_reference license", async () => {
  const { root, versionedLibrary, content } = await publishedLibrary("cancercell-pathway-nes-heatmap");
  try {
    const built = await buildOpenFigureModule({ library: versionedLibrary, content });
    const paths = built.files.map((file) => file.path);
    assert.ok(paths.includes("code/organized.R"));
    assert.ok(!paths.includes("code/example.R"));
    assert.ok(paths.includes("preview.png"));
    assert.ok(paths.includes("thumbnail.jpg"));
    assert.ok(paths.includes("module.yml"));
    assert.ok(!paths.some((item) => item.includes("wechat") || item.includes("original")));
    assert.ok(built.excludedLogicalPaths.includes("visuals/source/wechat-heatmap.png"));
    assert.ok(built.excludedLogicalPaths.includes("code/code-original.r"));
    const yaml = new TextDecoder().decode(built.files.find((file) => file.path === "module.yml")!.bytes);
    assert.match(yaml, /code: MIT/u);
    assert.doesNotMatch(yaml, /private_reference/u);
    assert.equal(built.titleEnDerived, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("98176fd regression: three adapted R assets export without code collisions or preview changes", async () => {
  const original = candidate();
  // The real affected revisions classify organized/example/original as adapted,
  // so the historical author_provided exclusion did not prevent the collision.
  const { root, versionedLibrary, content } = await publishedLibrary("three-adapted-r-assets", {
    assets: original.assets.map((asset) => asset.role === "code"
      ? { ...asset, codeOrigin: "adapted" as const }
      : asset),
  });
  try {
    const built = await buildOpenFigureModule({ library: versionedLibrary, content });
    const codePaths = built.files.filter((file) => file.path.startsWith("code/")).map((file) => file.path);
    assert.deepEqual(codePaths, ["code/organized.R"]);
    assert.ok(built.excludedLogicalPaths.includes("code/code-example.r"));
    assert.ok(built.excludedLogicalPaths.includes("code/code-original.r"));
    assert.equal(new Set(built.files.map((file) => file.path)).size, built.files.length);
    const preview = built.files.find((file) => file.path === "preview.png");
    assert.ok(preview);
    assert.deepEqual(Buffer.from(preview.bytes), PNG_BYTES);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Open Figure sanitizer publishes only the canonical code and maps a sole data input to its referenced name", async () => {
  const { root, versionedLibrary, content } = await publishedLibrary("portable-ggtree", {
    canonicalImplementation: { assetPath: "code/code-organized.r", selectedBy: "user" },
    runtime: {
      schema: "figure-library.runtime-closure.v1",
      entrypoint: "code/code-organized.r",
      inputs: [{ codePath: "data/HPV58.nwk", assetPath: "references/tree-nwk.nwk", required: true, role: "example_data" }],
      output: { previewPath: "visuals/rendered/preview.png", mediaType: "image/png" },
    },
    visualGrouping: {
      visualAssetPaths: ["visuals/rendered/preview.png"],
      confirmedBy: "user",
    },
    figureCodeLinks: [
      {
        visualAssetPath: "visuals/rendered/preview.png",
        codeAssetPaths: ["code/code-organized.r"],
        relationship: "generated_output",
        confirmedBy: "user",
        evidence: "The organized script generated the rendered preview.",
      },
    ],
    assets: [
      {
        logicalPath: "code/code-organized.r",
        role: "code",
        codeOrigin: "adapted",
        language: "R",
        mediaType: "text/x-r-source",
        rights: { license: "MIT", distribution: "public" },
        text: 'tree <- read.tree(file.path(root, "data", "HPV58.nwk"))\n',
      },
      {
        logicalPath: "references/tree-nwk.nwk",
        role: "reference",
        mediaType: "text/plain",
        rights: { license: "CC BY 4.0", distribution: "public" },
        text: "(a:1,b:1);\n",
      },
      {
        logicalPath: "evidence/run.md",
        role: "evidence",
        mediaType: "text/markdown",
        text: "Local-only execution note.\n",
      },
      {
        logicalPath: "visuals/rendered/preview.png",
        role: "visual",
        visualRole: "rendered_output",
        mediaType: "image/png",
        rights: { license: "CC BY 4.0", distribution: "public" },
        bytes: new Uint8Array(PNG_BYTES),
      },
    ],
  });
  try {
    const built = await buildOpenFigureModule({ library: versionedLibrary, content });
    const paths = built.files.map((file) => file.path);
    assert.deepEqual(paths.filter((file) => file.startsWith("code/")), ["code/organized.R"]);
    assert.ok(paths.includes("data/HPV58.nwk"));
    const yaml = new TextDecoder().decode(built.files.find((file) => file.path === "module.yml")!.bytes);
    assert.match(yaml, /executionStatus: not_run/u);
    assert.match(yaml, /executionScope: unknown/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Open Figure sanitizer rejects UUID template IDs", async () => {
  const { root, versionedLibrary, content } = await publishedLibrary("template-5959c431-e005-4beb-9e1e-79bdb025e816");
  try {
    await assert.rejects(
      () => buildOpenFigureModule({ library: versionedLibrary, content }),
      /UUID/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Open Figure sanitizer rejects private machine paths in code", async () => {
  const { root, versionedLibrary, content } = await publishedLibrary("portable-heatmap", {
    visualGrouping: {
      visualAssetPaths: ["visuals/rendered/preview.png"],
      confirmedBy: "user",
    },
    primaryPreviewOverride: undefined,
    figureCodeLinks: [
      {
        visualAssetPath: "visuals/rendered/preview.png",
        codeAssetPaths: ["code/code-organized.r"],
        relationship: "generated_output",
        confirmedBy: "user",
        evidence: "The user confirmed the organized script generated this preview.",
      },
    ],
    assets: [
      {
        logicalPath: "code/code-organized.r",
        role: "code",
        codeOrigin: "adapted",
        language: "R",
        mediaType: "text/x-r-source",
        text: "setwd('C:/Users/Administrator/Desktop')\n",
      },
      {
        logicalPath: "evidence/run.md",
        role: "evidence",
        mediaType: "text/markdown",
        text: "Local-only execution note.\n",
      },
      {
        logicalPath: "visuals/rendered/preview.png",
        role: "visual",
        visualRole: "rendered_output",
        mediaType: "image/png",
        rights: { license: "CC BY 4.0", distribution: "public" },
        bytes: new Uint8Array(PNG_BYTES),
      },
    ],
  });
  try {
    await assert.rejects(
      () => buildOpenFigureModule({ library: versionedLibrary, content }),
      /private path|token|key/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("new OFM YAML and description.md retain one authoritative Markdown description", async () => {
  const description = "A **group comparison**.\n\nSecond paragraph.";
  const application = "### 免疫微环境\n\n- 比较处理组与对照组的细胞比例。";
  const dataProfile = "Long table with a sample column.";
  const original = candidate();
  const { root, versionedLibrary, content } = await publishedLibrary("markdown-module", {
    description, application, dataProfile, scientificQuestion: "处理前后群体组成是否不同？",
    assets: [...original.assets, { logicalPath: "references/description.md", role: "reference", mediaType: "text/markdown", text: "DIVERGENT OLD DOCUMENT" }],
  });
  try {
    const { parse } = await import("yaml");
    const { figureDescriptionMarkdown } = await import("../src/figure-description.ts");
    const built = await buildOpenFigureModule({ library: versionedLibrary, content });
    const read = (file: string) => new TextDecoder().decode(built.files.find((f) => f.path === file)!.bytes);
    const yaml = parse(read("module.yml"));
    assert.equal(yaml.description, description);
    assert.equal(yaml.application, application);
    assert.equal(yaml.dataProfile, dataProfile);
    assert.equal(yaml.scientificQuestion, "处理前后群体组成是否不同？");
    assert.equal(read("description.md"), figureDescriptionMarkdown({ title: content.title, description, application, dataProfile }));
    assert.deepEqual(yaml.files, built.files.map((f) => f.path));
    assert.equal(built.files.filter((f) => f.path === "description.md").length, 1);
    assert.ok(!built.files.some((f) => new TextDecoder().decode(f.bytes).includes("DIVERGENT OLD DOCUMENT")));
    assert.ok(built.excludedLogicalPaths.includes("references/description.md"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("legacy OFM export extracts scenarios or marks missing without copying visualProfile", async () => {
  for (const description of ["Background\n\n## 使用场景\n\n- Compare response groups.", "Background only"]) {
    const { root, versionedLibrary, content } = await publishedLibrary("legacy-markdown", { description, visualProfile: "RED POINTS ONLY" });
    try {
      const built = await buildOpenFigureModule({ library: versionedLibrary, content });
      assert.doesNotMatch(built.application, /RED POINTS/u);
      assert.equal(built.application, description.includes("使用场景") ? "- Compare response groups." : "未单独记录。此历史模板尚未提供独立应用场景。");
      assert.equal(content.description, description);
      assert.equal(content.application, undefined);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test("public modules exclude private supporting notes even if misclassified as references", async () => {
  const original = candidate();
  const { root, versionedLibrary, content } = await publishedLibrary("private-docs", {
    assets: [...original.assets,
      { logicalPath: "references/receipt.md", role: "reference", mediaType: "text/markdown", text: "PRIVATE NOTE" },
      { logicalPath: "references/private_reference.txt", role: "reference", mediaType: "text/plain", text: "PRIVATE NOTE" },
      { logicalPath: "references/paper.pdf", role: "reference", mediaType: "application/pdf", text: "PRIVATE NOTE" },
    ],
  });
  try {
    const built = await buildOpenFigureModule({ library: versionedLibrary, content });
    assert.ok(["references/receipt.md", "references/private_reference.txt", "references/paper.pdf"].every((file) => built.excludedLogicalPaths.includes(file)));
    assert.ok(!built.files.some((file) => new TextDecoder().decode(file.bytes).includes("PRIVATE NOTE")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Open Figure export blocks a Local Published input without explicit public rights", async () => {
  const original = candidate();
  const { root, versionedLibrary, content } = await publishedLibrary("rights-closed-input", {
    assets: original.assets.map((asset) => asset.logicalPath === "references/nes-csv.csv"
      ? { ...asset, rights: { license: "CC BY-NC-ND", distribution: "local_only" as const } }
      : asset),
  });
  try {
    await assert.rejects(
      () => buildOpenFigureModule({ library: versionedLibrary, content }),
      /explicit public redistribution right|non-public rights/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Local Published promotion blocks a code input closure that is only implicit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-runtime-closure-promotion-"));
  await ensureLibraryRootMarker(root);
  const snapshot = await resolveLibraryRuntimeSnapshot({ root });
  const versionedLibrary = new VersionedTemplateLibrary(snapshot);
  await versionedLibrary.applyCreateWorking(
    await versionedLibrary.planCreateWorking({
      templateId: "runtime-closure-required",
      candidate: candidate({ runtime: undefined }),
    }),
    "runtime-closure-required-working",
  );
  try {
    await assert.rejects(
      () => versionedLibrary.planPublish({ templateId: "runtime-closure-required" }),
      /requires an explicit runtime closure/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
