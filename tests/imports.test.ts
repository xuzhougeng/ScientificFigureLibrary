import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { stringify } from "yaml";
import { UserTemplateLibrary } from "../src/user-library.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function transferManifest(image: Uint8Array) {
  return {
    schema: "figure-transfer-package.v1",
    version: 1,
    producer: { name: "CiteBox", version: "0.31.0" },
    exportedAt: "2026-08-01T01:02:03Z",
    source: {
      sourceId: "paper-42",
      figureId: 7,
      parentFigureId: null,
      figureLabel: "Fig 2",
      subfigureLabels: ["a", "b"],
      caption: "A preserved transfer-package caption.",
      page: 12,
      paper: {
        title: "Transfer Package Paper",
        authors: ["Ada Example", "Bo Example"],
        year: 2026,
        journal: "Journal of Test Figures",
        doi: "10.1234/example.figure",
        url: "https://example.test/paper/42",
      },
      license: { scope: "article figure", text: "CC BY 4.0" },
    },
    figure: {
      file: "figure.png",
      mediaType: "image/png",
      bytes: image.byteLength,
      sha256: digest(image),
    },
  };
}

async function writeTransferPackage(file: string, image: Uint8Array, manifest = transferManifest(image)) {
  await fs.writeFile(
    file,
    zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "figure.png": image,
    }),
  );
}

test("Figure Transfer Packages validate, preserve provenance, diff, and upsert idempotently", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-transfer-test-"));
  try {
    const packagePath = path.join(root, "figure-transfer-package.zip");
    await writeTransferPackage(packagePath, PNG);
    const library = new UserTemplateLibrary(path.join(root, "library"));

    const imported = await library.importTransferPackage(packagePath);
    assert.equal(imported.action, "create");
    assert.equal(imported.template.reviewStatus, "draft");
    assert.equal(imported.template.assetKind, "visual_reference");
    assert.equal(imported.template.codeStatus, "none");
    assert.equal(imported.template.provenance?.caption, "A preserved transfer-package caption.");
    assert.equal(imported.template.provenance?.doi, "10.1234/example.figure");
    assert.equal(imported.template.provenance?.page, "12");
    assert.equal(imported.template.provenance?.url, "https://example.test/paper/42");
    assert.equal(imported.template.license, "article figure — CC BY 4.0");
    assert.equal(imported.template.registry?.sourceId, "CiteBox:paper-42:7");

    const repeated = await library.importTransferPackage(packagePath);
    assert.equal(repeated.action, "unchanged");
    assert.equal(repeated.template.templateId, imported.template.templateId);
    assert.equal((await library.list()).length, 1);
    assert.equal((await library.search({ query: "transfer package paper" })).length, 0);
    assert.equal(
      (await library.search({
        query: "transfer package paper",
        reviewStatus: "draft",
        assetKind: "visual_reference",
      }))[0]?.templateId,
      imported.template.templateId,
    );

    const changedImage = new Uint8Array([...PNG, 1]);
    await writeTransferPackage(packagePath, changedImage);
    await assert.rejects(
      library.importTransferPackage(packagePath),
      /figure_library_diff.*figure_library_upsert/u,
    );
    const diff = await library.diffImportSource({ packagePath });
    assert.equal(diff.action, "update");
    assert.notEqual(diff.existingContentHash, diff.incomingContentHash);
    assert.ok(diff.changes.some((change) => change.field === "preview"));

    const updated = await library.upsertImportSource({ packagePath });
    assert.equal(updated.action, "update");
    assert.equal(updated.template.templateId, imported.template.templateId);
    assert.equal((await library.list()).length, 1);

    const destination = path.join(root, "materialized");
    const materialized = await library.materialize(imported.template.templateId, destination);
    const preview = path.join(materialized.target, "reference", "preview.png");
    assert.equal((await fs.stat(preview)).mode & 0o222, 0, "materialized reference is writable");
    const lock = JSON.parse(
      await fs.readFile(path.join(materialized.target, "template.lock.json"), "utf8"),
    );
    assert.equal(lock.readOnlyReferences, true);
    assert.equal(lock.provenance.caption, "A preserved transfer-package caption.");
    assert.equal(lock.provenance.doi, "10.1234/example.figure");

    const invalidPath = path.join(root, "invalid.zip");
    const invalid = transferManifest(PNG);
    invalid.figure.sha256 = "0".repeat(64);
    await writeTransferPackage(invalidPath, PNG, invalid);
    await assert.rejects(library.importTransferPackage(invalidPath), /SHA-256 mismatch/u);

    const traversalPath = path.join(root, "traversal.zip");
    await fs.writeFile(
      traversalPath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify(transferManifest(PNG))),
        "figure.png": PNG,
        "../escape.R": strToU8("stop('never execute')"),
      }),
    );
    await assert.rejects(library.importTransferPackage(traversalPath), /unsafe package path/u);
  } finally {
    await fs.chmod(root, 0o755).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

interface GalleryEntryOptions {
  id: string;
  title: string;
  reviewStatus: "draft" | "approved";
  assetKind: "plot_template" | "visual_reference";
}

async function writeGalleryEntry(galleryRoot: string, options: GalleryEntryOptions) {
  const entry = path.join(galleryRoot, options.id);
  await fs.mkdir(path.join(entry, "source"), { recursive: true });
  await fs.mkdir(path.join(entry, "code"), { recursive: true });
  await fs.writeFile(path.join(entry, "preview.png"), PNG);
  await fs.writeFile(
    path.join(entry, "description.md"),
    `${options.title} is a unique approved-gallery scientific figure reference.\n`,
  );
  await fs.writeFile(
    path.join(entry, "source", "provenance.yml"),
    stringify({
      producer: "Personal Gallery",
      source_id: `source-${options.id}`,
      caption: `${options.title} caption`,
      doi: `10.1234/${options.id}`,
      page: 3,
      url: `https://example.test/${options.id}`,
      license_scope: "internal reference",
      rights: "Owner approved reuse",
    }),
  );
  const withCode = options.assetKind === "plot_template";
  if (withCode) {
    await fs.writeFile(path.join(entry, "code", "example.R"), "library(ggplot2)\n# reference\n");
    await fs.writeFile(path.join(entry, "code", "data_schema.yml"), "columns: [x, y]\n");
    await fs.writeFile(path.join(entry, "code", "example.csv"), "x,y\n1,2\n");
  }
  await fs.writeFile(
    path.join(entry, "figure.yml"),
    stringify({
      schema: "figure-library.gallery-entry.v1",
      gallery_id: options.id,
      title: options.title,
      tags: ["approved-gallery", withCode ? "volcano" : "mechanism"],
      visual_profile: withCode ? "volcano scatter with labels" : "mechanism diagram",
      data_profile: withCode ? "x and y numeric columns" : "visual reference only",
      packages: withCode ? ["ggplot2"] : [],
      license: "Internal lab reference",
      asset_kind: options.assetKind,
      language: withCode ? "R" : "none",
      plot_family: withCode ? "volcano" : "mechanism",
      review_status: options.reviewStatus,
      code_status: withCode ? "reviewed" : "none",
    }),
  );
  return entry;
}

test("Gallery sync imports only approved entries and supports filters, diff, upsert, and archive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-gallery-test-"));
  try {
    const galleryRoot = path.join(root, "gallery");
    await fs.mkdir(galleryRoot);
    const plotEntry = await writeGalleryEntry(galleryRoot, {
      id: "lab-volcano",
      title: "Approved gallery volcano",
      reviewStatus: "approved",
      assetKind: "plot_template",
    });
    const visualEntry = await writeGalleryEntry(galleryRoot, {
      id: "lab-mechanism",
      title: "Approved gallery mechanism",
      reviewStatus: "approved",
      assetKind: "visual_reference",
    });
    await writeGalleryEntry(galleryRoot, {
      id: "draft-reference",
      title: "Draft gallery reference",
      reviewStatus: "draft",
      assetKind: "visual_reference",
    });

    const library = new UserTemplateLibrary(path.join(root, "library"));
    const dryRun = await library.syncGallery({
      galleryDirectory: root,
      dryRun: true,
      sourceCommit: "gallery-commit-a",
    });
    assert.equal(dryRun.create, 2);
    assert.equal(dryRun.skipped, 1);
    assert.equal((await library.list()).length, 0, "dry-run wrote templates");

    const applied = await library.syncGallery({
      galleryDirectory: root,
      dryRun: false,
      sourceCommit: "gallery-commit-a",
    });
    assert.equal(applied.create, 2);
    assert.equal(applied.skipped, 1);
    assert.equal((await library.list()).length, 2);

    const repeated = await library.syncGallery({
      galleryDirectory: root,
      dryRun: true,
      sourceCommit: "gallery-commit-a",
    });
    assert.equal(repeated.unchanged, 2);
    assert.equal(repeated.skipped, 1);

    const plotResults = await library.search({
      query: "approved gallery",
      assetKind: "plot_template",
      language: "R",
      plotFamily: "volcano",
      codeStatus: "reviewed",
    });
    assert.equal(plotResults.length, 1);
    assert.equal(plotResults[0]?.assetKind, "plot_template");
    const plotTemplateId = plotResults[0]?.templateId ?? "";

    const visualResults = await library.search({
      query: "approved gallery",
      assetKind: "visual_reference",
      codeStatus: "none",
    });
    assert.equal(visualResults.length, 1);
    assert.equal(visualResults[0]?.assetKind, "visual_reference");
    assert.equal(
      (await library.list()).some(
        ({ template }) => template.registry?.galleryId === "draft-reference",
      ),
      false,
    );
    assert.ok(
      (await library.search({ query: "draft gallery" })).every(
        (candidate) => candidate.reviewStatus === "approved",
      ),
    );

    const unchanged = await library.diffImportSource({
      galleryPath: plotEntry,
      sourceCommit: "gallery-commit-a",
    });
    assert.equal(unchanged.action, "unchanged");
    await fs.writeFile(
      path.join(plotEntry, "description.md"),
      "Approved gallery volcano now has an updated description.\n",
    );
    const changed = await library.diffImportSource({
      galleryPath: plotEntry,
      sourceCommit: "gallery-commit-a",
    });
    assert.equal(changed.action, "update");
    assert.ok(changed.changes.some((change) => change.field === "description"));
    const upserted = await library.upsertImportSource({
      galleryPath: plotEntry,
      sourceCommit: "gallery-commit-a",
    });
    assert.equal(upserted.action, "update");
    assert.equal(upserted.template.templateId, plotTemplateId);
    assert.equal((await library.list()).length, 2);

    const materialized = await library.materialize(plotTemplateId, path.join(root, "output"));
    assert.ok(materialized.files.includes("reference/code/example.R"));
    assert.ok(materialized.files.includes("reference/code/data_schema.yml"));
    assert.ok(materialized.files.includes("reference/code/example.csv"));
    assert.ok(materialized.files.includes("reference/metadata/provenance.yml"));
    assert.equal(
      (await fs.stat(path.join(materialized.target, "reference", "code", "example.R"))).mode &
        0o222,
      0,
    );

    const archived = await library.archiveGallery("lab-volcano");
    assert.equal(archived.template.reviewStatus, "archived");
    assert.equal(
      (await library.search({ query: "approved gallery volcano", assetKind: "plot_template" }))
        .length,
      0,
    );
    assert.ok(await library.get(plotTemplateId), "logical archive deleted the template");

    await fs.appendFile(
      path.join(visualEntry, "figure.yml"),
      `content_hash: "${"0".repeat(64)}"\n`,
    );
    await assert.rejects(
      library.diffImportSource({ galleryPath: visualEntry, sourceCommit: "gallery-commit-a" }),
      /content_hash mismatch/u,
    );
  } finally {
    await fs.chmod(root, 0o755).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
