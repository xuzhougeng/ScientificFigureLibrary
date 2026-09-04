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
  return { ...base, ...overrides, assets: overrides.assets ?? base.assets };
}

async function publishedLibrary(templateId: string, overrides: Partial<VersionedTemplateCandidate> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-figure-module-"));
  await ensureLibraryRootMarker(root);
  const snapshot = await resolveLibraryRuntimeSnapshot({ root });
  const versionedLibrary = new VersionedTemplateLibrary(snapshot);
  await versionedLibrary.applyCreateWorking(
    await versionedLibrary.planCreateWorking({
      templateId,
      candidate: candidate(overrides),
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
