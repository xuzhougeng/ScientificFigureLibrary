#!/usr/bin/env node

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

const root = path.resolve(import.meta.dirname, "..");
const materializeAt = process.argv[2];
const serverEntry =
  process.env.FIGURE_LIBRARY_SMOKE_SERVER ?? path.join(root, "dist", "index.js");
const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-smoke-"));
const libraryDirectory = path.join(smokeRoot, "library");
const sourceDirectory = path.join(smokeRoot, "source");
await fs.mkdir(sourceDirectory);
const codePath = path.join(sourceDirectory, "smoke-plot.R");
await fs.writeFile(codePath, "# unique-smoke-ridge-reference\n");
const transferImage = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const transferPackagePath = path.join(sourceDirectory, "figure-transfer-package.zip");
const transferManifest = {
  schema: "figure-transfer-package.v1",
  version: 1,
  producer: { name: "CiteBox", version: "smoke" },
  exportedAt: "2026-08-01T00:00:00Z",
  source: {
    sourceId: "smoke-paper",
    figureId: "1",
    parentFigureId: null,
    figureLabel: "Fig 1",
    subfigureLabels: [],
    caption: "MCP smoke transfer figure",
    page: 1,
    paper: {
      title: "MCP Smoke Paper",
      authors: [],
      year: 2026,
      journal: null,
      doi: null,
      url: null,
    },
    license: { scope: "unknown", text: null },
  },
  figure: {
    file: "figure.png",
    mediaType: "image/png",
    bytes: transferImage.byteLength,
    sha256: createHash("sha256").update(transferImage).digest("hex"),
  },
};
await fs.writeFile(
  transferPackagePath,
  zipSync({
    "manifest.json": strToU8(JSON.stringify(transferManifest)),
    "figure.png": transferImage,
  }),
);

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);
childEnvironment.FIGURE_LIBRARY_DIR = libraryDirectory;

const client = new Client({ name: "scientific-figure-library-smoke", version: "0.2.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  stderr: "pipe",
  env: childEnvironment,
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const required of [
    "figure_library_open",
    "figure_library_search",
    "figure_library_import",
    "figure_library_diff",
    "figure_library_upsert",
    "figure_library_sync",
    "figure_library_archive",
    "figure_library_preview",
    "figure_library_source_status",
    "figure_library_describe",
    "figure_library_materialize",
  ]) {
    if (!names.includes(required)) throw new Error(`missing tool ${required}`);
  }

  const opened = await client.callTool({
    name: "figure_library_open",
    arguments: {},
  });
  if (opened.isError || opened.structuredContent?.candidates?.length !== 0) {
    throw new Error("open smoke call did not return an empty workbench");
  }

  const volcanoResult = await client.callTool({
    name: "figure_library_search",
    arguments: {
      query: "volcano differential expression",
      dataProfile: "gene; log2FC; pvalue; padj",
      visualProfile:
        "single panel; x=log2FC; y=-log10(padj); threshold lines; up/down colors; labels",
      sourceIds: ["figureya", "user"],
      limit: 6,
    },
  });
  if (
    volcanoResult.isError ||
    volcanoResult.structuredContent?.candidates?.[0]?.templateId !==
      "FigureYa59volcanoV2" ||
    volcanoResult.structuredContent?.reviewRequired !== true
  ) {
    throw new Error("volcano retrieval did not return the expected review candidate");
  }

  const previewDirectory = path.join(smokeRoot, "previews");
  const previewed = await client.callTool({
    name: "figure_library_preview",
    arguments: {
      templateId: "FigureYa59volcanoV2",
      destination: previewDirectory,
    },
  });
  const previewPath = previewed.structuredContent?.path;
  if (
    previewed.isError ||
    typeof previewPath !== "string" ||
    !previewed.content?.some((item) => item.type === "image")
  ) {
    throw new Error("preview smoke call did not return image content and a local path");
  }
  const previewStat = await fs.stat(previewPath);
  if (!previewStat.isFile() || path.dirname(previewPath) !== previewDirectory) {
    throw new Error("preview smoke call wrote an unexpected local file");
  }

  const imported = await client.callTool({
    name: "figure_library_import",
    arguments: {
      title: "Unique smoke ridge reference",
      description:
        "A unique-smoke-ridge-reference for MCP verification; explicitly not a volcano plot.",
      tags: ["unique-smoke-ridge-reference"],
      codePaths: [codePath],
    },
  });
  const userTemplateId = imported.structuredContent?.templateId;
  if (imported.isError || typeof userTemplateId !== "string") {
    throw new Error(`user import smoke call failed: ${JSON.stringify(imported.content)}`);
  }

  const transferImported = await client.callTool({
    name: "figure_library_import",
    arguments: { packagePath: transferPackagePath },
  });
  if (
    transferImported.isError ||
    transferImported.structuredContent?.reviewStatus !== "draft" ||
    transferImported.structuredContent?.action !== "create"
  ) {
    throw new Error(`transfer import smoke call failed: ${JSON.stringify(transferImported.content)}`);
  }
  const transferDiff = await client.callTool({
    name: "figure_library_diff",
    arguments: { packagePath: transferPackagePath },
  });
  if (transferDiff.isError || transferDiff.structuredContent?.action !== "unchanged") {
    throw new Error("transfer diff smoke call was not idempotent");
  }
  const transferUpsert = await client.callTool({
    name: "figure_library_upsert",
    arguments: { packagePath: transferPackagePath },
  });
  if (transferUpsert.isError || transferUpsert.structuredContent?.action !== "unchanged") {
    throw new Error("transfer upsert smoke call was not idempotent");
  }
  const emptyGallery = path.join(smokeRoot, "empty-gallery");
  await fs.mkdir(emptyGallery);
  const galleryDryRun = await client.callTool({
    name: "figure_library_sync",
    arguments: { galleryDirectory: emptyGallery, dryRun: true },
  });
  if (galleryDryRun.isError || galleryDryRun.structuredContent?.entries !== 0) {
    throw new Error("empty Gallery dry-run smoke call failed");
  }

  const mergedResult = await client.callTool({
    name: "figure_library_search",
    arguments: {
      query: "volcano differential expression",
      sourceIds: ["figureya", "user"],
      limit: 3,
    },
  });
  if (
    mergedResult.isError ||
    mergedResult.structuredContent?.candidates?.[0]?.templateId !==
      "FigureYa59volcanoV2"
  ) {
    throw new Error("cross-source retrieval scores were not globally comparable");
  }

  const result = await client.callTool({
    name: "figure_library_search",
    arguments: {
      query: "unique smoke ridge reference",
      sourceIds: ["user"],
      limit: 3,
    },
  });
  if (
    result.isError ||
    result.structuredContent?.candidates?.[0]?.templateId !== userTemplateId
  ) {
    throw new Error("search smoke call did not return the imported user template");
  }

  const described = await client.callTool({
    name: "figure_library_describe",
    arguments: { templateId: userTemplateId },
  });
  if (described.isError || described.structuredContent?.sourceId !== "user") {
    throw new Error("describe smoke call failed for the imported user template");
  }

  const userMaterialized = await client.callTool({
    name: "figure_library_materialize",
    arguments: {
      templateId: userTemplateId,
      destination: path.join(smokeRoot, "user-output"),
    },
  });
  if (userMaterialized.isError || !userMaterialized.structuredContent?.target) {
    throw new Error("user template materialization smoke call failed");
  }

  const sourceStatus = await client.callTool({
    name: "figure_library_source_status",
    arguments: {},
  });
  if (sourceStatus.isError || sourceStatus.structuredContent?.userTemplateCount !== 2) {
    throw new Error("source status smoke call failed");
  }

  const resource = await client.readResource({
    uri: "ui://figure-library/candidates.html",
  });
  if (!resource.contents[0]?.mimeType?.startsWith("text/html")) {
    throw new Error("MCP App resource was not returned as HTML");
  }

  const stopped = await client.callTool({
    name: "figure_library_materialize",
    arguments: {
      templateId: "FigureYa59volcanoV2",
      destination: path.join(smokeRoot, "hard-stop-output"),
      sourcePackDir: path.join(smokeRoot, "missing-pack"),
      allowNetwork: false,
    },
  });
  const stopText = stopped.content?.find((item) => item.type === "text")?.text ?? "";
  const stopNormalized = stopText.toLocaleLowerCase();
  if (
    !stopped.isError ||
    !stopText.startsWith("STOP:") ||
    !stopNormalized.includes("do not retry") ||
    !stopNormalized.includes("substitute/demo plot")
  ) {
    throw new Error("materialization failure did not enforce the hard-stop policy");
  }

  let materialized = "";
  if (materializeAt) {
    const downloaded = await client.callTool({
      name: "figure_library_materialize",
      arguments: {
        templateId: "FigureYa59volcanoV2",
        destination: path.resolve(materializeAt),
        mode: "template",
        sourcePackDir: process.env.FIGUREYA_SOURCE_PACK_DIR,
        allowNetwork: !process.env.FIGUREYA_SOURCE_PACK_DIR,
      },
    });
    if (downloaded.isError || !downloaded.structuredContent?.target) {
      throw new Error(`FigureYa materialization failed: ${JSON.stringify(downloaded.content)}`);
    }
    materialized = `; materialized ${downloaded.structuredContent.target}`;
  }

  console.log(
    `OK: ${names.join(", ")}; Agent review preview; import/diff/upsert/sync/archive tools; user search/materialization; app resource; hard stop${materialized}`,
  );
} finally {
  await client.close().catch(() => undefined);
  await fs.rm(smokeRoot, { recursive: true, force: true });
}
