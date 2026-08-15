import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PNG } from "pngjs";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";
import { PortableBundleManager } from "../src/portable-bundles.ts";
import { LOCAL_LIBRARY_PROVIDER_ID } from "../src/providers.ts";
import { createServer } from "../src/server.ts";
import { estimateDataUrlLength } from "../src/transport-image.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function records(value: unknown) {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

function patternedPng(width: number, height: number) {
  const png = new PNG({ width, height, colorType: 2 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (png.width * y + x) << 2;
      png.data[index] = (x * 3) % 256;
      png.data[index + 1] = (y * 5) % 256;
      png.data[index + 2] = (x + y) % 256;
      png.data[index + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

function largeCandidate(bytes: Uint8Array): VersionedTemplateCandidate {
  return {
    title: "transportuniquemarker large local preview",
    description: "transportuniquemarker oversized canonical preview",
    tags: ["transportuniquemarker"],
    visualProfile: "heatmap",
    dataProfile: "matrix",
    packages: ["ggplot2"],
    license: "reference only",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "heatmap",
    codeStatus: "reviewed",
    executionStatus: "not_run",
    canonicalImplementation: { assetPath: "code/plot.R", selectedBy: "user" },
    visualGrouping: {
      visualAssetPaths: ["visuals/source/preview.png"],
      confirmedBy: "user",
    },
    figureCodeLinks: [
      {
        visualAssetPath: "visuals/source/preview.png",
        codeAssetPaths: ["code/plot.R"],
        relationship: "user_supplied_pair",
        confirmedBy: "user",
        evidence: "The user confirmed the image/code pair.",
      },
    ],
    assets: [
      {
        logicalPath: "visuals/source/preview.png",
        role: "visual",
        visualRole: "source_reference",
        mediaType: "image/png",
        bytes,
      },
      {
        logicalPath: "code/plot.R",
        role: "code",
        codeOrigin: "user_supplied",
        language: "R",
        text: "plot(1:3)\n",
      },
    ],
  };
}

test("search and exact preview adapt large canonical images without changing hashes or materialize bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-transport-protocol-"));
  const libraryRoot = path.join(root, "library");
  const previousLibraryDirectory = process.env.FIGURE_LIBRARY_DIR;
  const source = patternedPng(1400, 1100);
  const canonicalSha = createHash("sha256").update(source).digest("hex");
  assert.ok(estimateDataUrlLength(source.byteLength, "image/png") > 256 * 1024);
  try {
    await ensureLibraryRootMarker(libraryRoot);
    const library = new VersionedTemplateLibrary(libraryRoot);
    await library.applyCreateWorking(
      await library.planCreateWorking({
        templateId: "transport-large-preview",
        candidate: largeCandidate(source),
      }),
      "transport-working",
    );
    const published = await library.applyPublish(
      await library.planPublish({ templateId: "transport-large-preview" }),
      "transport-publish",
    );
    const digestBefore = published.contentDigest;
    const revisionId = published.revisionId;
    assert.ok(digestBefore);
    assert.ok(revisionId);

    process.env.FIGURE_LIBRARY_DIR = libraryRoot;
    const server = await createServer();
    const client = new Client(
      { name: "transport-protocol-test", version: "0.5.3" },
      {
        capabilities: {
          extensions: {
            [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
          },
        },
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await client.callTool({ name: "figure_library_open", arguments: {} });
    const searched = await client.callTool({
      name: "figure_library_search",
      arguments: { query: "transportuniquemarker oversized canonical", limit: 6 },
    });
    const searchedStructured = record(searched.structuredContent);
    const candidate = records(searchedStructured.candidates).find(
      (item) => item.templateId === "transport-large-preview",
    );
    assert.ok(candidate);
    assert.equal(candidate.previewAvailable, true);
    assert.equal(candidate.previewStatus, "ready");
    assert.equal(candidate.previewSha256, canonicalSha);
    assert.equal(candidate.previewByteLength, source.byteLength);
    assert.equal(candidate.previewMimeType, "image/png");
    const previews = record(record(record(searched)._meta).candidatePreviews);
    const thumb = record(previews[String(candidate.candidateId)]);
    const dataUrl = String(thumb.previewDataUrl);
    assert.match(dataUrl, /^data:image\/(png|jpeg);base64,/u);
    assert.ok(dataUrl.length <= 256 * 1024);
    assert.equal(thumb.previewSha256, canonicalSha);

    const exact = await client.callTool({
      name: "figure_library_preview_exact_headless",
      arguments: {
        resultSetId: searchedStructured.resultSetId,
        providerId: LOCAL_LIBRARY_PROVIDER_ID,
        exactSelector: candidate.exactSelector,
      },
    });
    const exactStructured = record(exact.structuredContent);
    assert.equal(exactStructured.sha256, canonicalSha);
    assert.equal(exactStructured.previewSha256, canonicalSha);
    assert.equal(exactStructured.bytes, source.byteLength);
    assert.equal(exactStructured.mimeType, "image/png");
    const exactImage = records(record(exact).content).find((item) => item.type === "image");
    assert.ok(exactImage);
    assert.ok(String(exactImage.data).length < estimateDataUrlLength(source.byteLength, "image/png"));

    const confirmed = await client.callTool({
      name: "figure_library_confirm_selection_headless",
      arguments: { previewChallenge: exactStructured.previewChallenge },
    });
    const planned = await client.callTool({
      name: "figure_library_plan_materialize",
      arguments: {
        providerId: LOCAL_LIBRARY_PROVIDER_ID,
        exactSelector: candidate.exactSelector,
        previewReceipt: record(confirmed.structuredContent).previewReceipt,
        destination: path.join(root, "materialize"),
        allowNetwork: false,
      },
    });
    assert.equal(record(record(planned.structuredContent).envelope).code, "materialization_plan_ready");
    assert.equal(
      record(record(record(planned.structuredContent).plan).previewConfirmation).previewSha256,
      canonicalSha,
    );

    const copied = path.join(root, "copied-preview");
    const compatibility = await client.callTool({
      name: "figure_library_preview",
      arguments: {
        providerId: LOCAL_LIBRARY_PROVIDER_ID,
        exactSelector: candidate.exactSelector,
        destination: copied,
      },
    });
    const compatibilityStructured = record(compatibility.structuredContent);
    assert.equal(compatibilityStructured.sha256, canonicalSha);
    assert.equal(compatibilityStructured.bytes, source.byteLength);
    const copiedFiles = await fs.readdir(copied);
    assert.equal(copiedFiles.length, 1);
    const copiedBytes = await fs.readFile(path.join(copied, copiedFiles[0]!));
    assert.equal(createHash("sha256").update(copiedBytes).digest("hex"), canonicalSha);

    const digestAfter = (await library.getContent(
      "transport-large-preview",
      revisionId,
      digestBefore,
    ))!.contentDigest;
    assert.equal(digestAfter, digestBefore);

    const cacheDir = path.join(libraryRoot, "indexes", "transport-images", "v1");
    const cached = await fs.readdir(cacheDir);
    assert.ok(cached.some((name) => name.endsWith(".img")));
    const backup = await new PortableBundleManager(libraryRoot, library).applyExport(
      await new PortableBundleManager(libraryRoot, library).planFullBackup({
        destination: path.join(root, "backups"),
        targetName: "full-backup",
      }),
      "export-transport-backup",
    );
    const inventoryText = await fs.readFile(path.join(backup.target, "inventory.jsonl"), "utf8");
    assert.equal(inventoryText.includes("payload/indexes/"), false);
    assert.equal(inventoryText.includes("transport-images"), false);
  } finally {
    if (previousLibraryDirectory === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = previousLibraryDirectory;
    await fs.rm(root, { recursive: true, force: true });
  }
});
