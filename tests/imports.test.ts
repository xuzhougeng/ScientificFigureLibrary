import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { stringify } from "yaml";
import { prepareDirectImport } from "../src/importers.ts";
import { managementReference, UserTemplateLibrary } from "../src/user-library.ts";

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

test("direct imports plan stable updates, require duplicate decisions, replay safely, and archive by templateId", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-direct-plan-test-"));
  try {
    const source = path.join(root, "source");
    await fs.mkdir(source);
    const previewPath = path.join(source, "preview.png");
    const codePath = path.join(source, "plot.R");
    await fs.writeFile(previewPath, PNG);
    await fs.writeFile(codePath, "library(ggplot2)\n# stable direct source\n");
    const library = new UserTemplateLibrary(path.join(root, "library"));
    const direct = {
      title: "Stable direct plot",
      description: "First reviewed description",
      sourceKey: "manual:stable-direct-plot",
      imagePath: previewPath,
      codePaths: [codePath],
    };
    await assert.rejects(
      library.planDirectImport({ ...direct, sourceKey: "/host/private/plot" }),
      /portable logical identifier|lowercase ASCII/u,
    );
    await assert.rejects(
      library.planDirectImport({ ...direct, sourceKey: "https://example.test/plot?token=secret" }),
      /portable logical identifier|lowercase ASCII/u,
    );

    const planned = await library.planDirectImport(direct);
    assert.equal(planned.action, "create");
    assert.equal(planned.written, false);
    assert.equal((await library.list()).length, 0);
    assert.match(planned.proposedTemplateId, /^user-direct-[a-f0-9]{16}$/u);
    assert.equal(planned.proposedTemplateId.includes("stable-direct-plot"), false);

    const applied = await library.applyDirectImport({
      ...direct,
      planDigest: planned.planDigest,
      expectedAction: planned.action,
      expectedTemplateId: planned.proposedTemplateId,
      operationId: "direct-create-1",
    });
    assert.equal(applied.action, "create");
    assert.equal(applied.replayed, false);
    assert.equal(applied.template.registry?.sourceId, "manual:stable-direct-plot");

    const replayed = await library.applyDirectImport({
      ...direct,
      planDigest: planned.planDigest,
      expectedAction: "create",
      expectedTemplateId: planned.proposedTemplateId,
      operationId: "direct-create-1",
    });
    assert.equal(replayed.action, "unchanged");
    assert.equal(replayed.replayed, true);

    const updatedInput = {
      ...direct,
      title: "Stable direct plot with confirmed title",
      description: "Updated reviewed description",
    };
    const updatePlan = await library.planDirectImport(updatedInput);
    assert.equal(updatePlan.action, "update");
    assert.equal(updatePlan.proposedTemplateId, applied.template.templateId);
    assert.ok(updatePlan.changes.some((change) => change.field === "title"));
    const updated = await library.applyDirectImport({
      ...updatedInput,
      planDigest: updatePlan.planDigest,
      expectedAction: updatePlan.action,
      expectedTemplateId: updatePlan.proposedTemplateId,
      operationId: "direct-update-1",
    });
    assert.equal(updated.action, "update");
    assert.equal(updated.template.templateId, applied.template.templateId);

    const duplicateInput = { ...updatedInput, sourceKey: "manual:separate-source" };
    const duplicatePlan = await library.planDirectImport(duplicateInput);
    assert.equal(duplicatePlan.action, "duplicate_candidate");
    await assert.rejects(
      library.applyDirectImport({
        ...duplicateInput,
        planDigest: duplicatePlan.planDigest,
        expectedAction: duplicatePlan.action,
        expectedTemplateId: duplicatePlan.proposedTemplateId,
        operationId: "direct-duplicate-rejected",
      }),
      /explicit reuse or create_separate/u,
    );
    const reused = await library.applyDirectImport({
      ...duplicateInput,
      planDigest: duplicatePlan.planDigest,
      expectedAction: duplicatePlan.action,
      expectedTemplateId: duplicatePlan.proposedTemplateId,
      operationId: "direct-duplicate-reuse",
      duplicateResolution: {
        action: "reuse",
        templateId: updated.template.templateId,
        reason: "The files are identical and this source should reuse the canonical template.",
      },
    });
    assert.equal(reused.action, "reused");
    assert.equal((await library.list()).length, 1);
    assert.equal((await library.planDirectImport(duplicateInput)).action, "unchanged");

    const renamedAlias = {
      ...duplicateInput,
      title: "A different label for the reused source",
      description: "Alias metadata does not overwrite the canonical template.",
    };
    const renamedAliasPlan = await library.planDirectImport(renamedAlias);
    assert.equal(renamedAliasPlan.action, "unchanged");
    assert.equal(renamedAliasPlan.proposedTemplateId, updated.template.templateId);
    assert.equal((await library.get(updated.template.templateId))?.template.title, updatedInput.title);

    await fs.writeFile(codePath, "library(ggplot2)\n# intentionally diverged alias source\n");
    const divergedAliasPlan = await library.planDirectImport(renamedAlias);
    assert.equal(divergedAliasPlan.action, "source_conflict");
    assert.notEqual(divergedAliasPlan.proposedTemplateId, updated.template.templateId);
    const divergedAlias = await library.applyDirectImport({
      ...renamedAlias,
      planDigest: divergedAliasPlan.planDigest,
      expectedAction: divergedAliasPlan.action,
      expectedTemplateId: divergedAliasPlan.proposedTemplateId,
      operationId: "direct-alias-breakout-1",
      sourceConflictResolution: {
        action: "replace_source",
        reason: "This reused source has intentionally diverged and must not overwrite its canonical.",
      },
    });
    assert.equal(divergedAlias.action, "create");
    assert.equal(divergedAlias.template.registry?.sourceId, "manual:separate-source");
    assert.equal((await library.get(updated.template.templateId))?.template.title, updatedInput.title);
    assert.equal((await library.list()).length, 2);
    assert.equal((await library.planDirectImport(renamedAlias)).action, "unchanged");

    const archived = await library.archiveTemplate({ templateId: updated.template.templateId });
    assert.equal(archived.changed, true);
    assert.equal(archived.alreadyArchived, false);
    assert.equal(archived.template.reviewStatus, "archived");
    assert.ok(await fs.stat(path.join(archived.directory, "code", "plot.R")));
    const repeatedArchive = await library.archiveTemplate({
      registrySourceId: "manual:stable-direct-plot",
      adapter: "direct",
    });
    assert.equal(repeatedArchive.changed, false);
    assert.equal(repeatedArchive.alreadyArchived, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an exact v0.2 legacy direct template remains idempotent without a silent migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-legacy-repeat-test-"));
  try {
    const source = path.join(root, "source");
    await fs.mkdir(source);
    const codePath = path.join(source, "legacy.R");
    await fs.writeFile(codePath, "# exact legacy direct template\n");
    const input = {
      title: "Legacy exact template",
      description: "Preserve the v0.2 directory and manifest without writing on a repeat.",
      codePaths: [codePath],
    };
    const prepared = await prepareDirectImport(input);
    assert.ok(prepared.legacyTemplateId);
    const library = new UserTemplateLibrary(path.join(root, "library"));
    const imported = await library.importTemplate(input);
    const legacyDirectory = path.join(library.templatesDirectory, prepared.legacyTemplateId!);
    const manifest = imported.template;
    delete manifest.registry;
    manifest.templateId = prepared.legacyTemplateId!;
    await fs.rename(imported.directory, legacyDirectory);
    await fs.writeFile(
      path.join(legacyDirectory, "template.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const repeated = await library.importTemplate(input);
    assert.equal(repeated.action, "unchanged");
    assert.equal(repeated.template.templateId, prepared.legacyTemplateId);
    assert.equal(repeated.template.registry, undefined);
    assert.equal((await library.list()).length, 1);

    await library.archiveTemplate({ templateId: prepared.legacyTemplateId });
    const separatePlan = await library.planDirectImport(input);
    assert.equal(separatePlan.action, "duplicate_candidate");
    assert.notEqual(separatePlan.proposedTemplateId, prepared.legacyTemplateId);
    const separate = await library.applyDirectImport({
      ...input,
      planDigest: separatePlan.planDigest,
      expectedAction: separatePlan.action,
      expectedTemplateId: separatePlan.proposedTemplateId,
      operationId: "legacy-create-separate-1",
      duplicateResolution: {
        action: "create_separate",
        reason: "Keep the archived legacy record and create a separately managed current record.",
      },
    });
    assert.equal(separate.action, "create");
    assert.equal((await library.get(prepared.legacyTemplateId!))?.template.reviewStatus, "archived");
    assert.equal((await library.list()).length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("title-only similarity is advisory and stored fingerprint drift is invalid", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-audit-boundary-test-"));
  try {
    const firstCode = path.join(root, "first.R");
    const secondCode = path.join(root, "second.R");
    await fs.writeFile(firstCode, "# first unrelated implementation\n");
    await fs.writeFile(secondCode, "# second unrelated implementation\n");
    const library = new UserTemplateLibrary(path.join(root, "library"));
    const first = await library.importTemplate({
      title: "Shared display title",
      sourceKey: "manual:title-only-a",
      codePaths: [firstCode],
    });
    await library.importTemplate({
      title: "Shared display title",
      sourceKey: "manual:title-only-b",
      codePaths: [secondCode],
    });
    const audit = await library.auditTemplates({ scope: "duplicates", includeArchived: true });
    assert.equal(audit.duplicateGroupCount, 0);
    assert.equal(managementReference(first.template).canUpdate, true);

    const contentCode = path.join(root, "content-addressed.R");
    await fs.writeFile(contentCode, "# content-addressed implementation\n");
    const contentAddressed = await library.importTemplate({
      title: "Content-addressed direct source",
      codePaths: [contentCode],
    });
    assert.equal(contentAddressed.template.registry?.identityMode, "content-addressed");
    assert.equal(managementReference(contentAddressed.template).canUpdate, true);

    const manifestPath = path.join(first.directory, "template.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.registry.fingerprints.fullAssetSha256 = "0".repeat(64);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const integrity = await library.auditTemplates({ scope: "integrity", includeArchived: true });
    assert.equal(integrity.invalidTemplateCount, 1);
    assert.match(integrity.invalid[0]!.error, /component fingerprints/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("writers preserve an existing lock and stop on an incomplete transaction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-write-guard-test-"));
  try {
    const codePath = path.join(root, "plot.R");
    await fs.writeFile(codePath, "# writer guard\n");
    const library = new UserTemplateLibrary(path.join(root, "library"));
    await fs.mkdir(library.writeLockDirectory, { recursive: true });
    await fs.writeFile(
      path.join(library.writeLockDirectory, "owner.json"),
      JSON.stringify({ operation: "other-writer", createdAt: "2026-08-04T00:00:00Z" }),
    );
    await assert.rejects(
      library.importTemplate({ title: "Blocked by lock", codePaths: [codePath] }),
      /write-locked/u,
    );
    assert.ok(await fs.stat(library.writeLockDirectory), "existing writer lock was deleted");
    await fs.rm(library.writeLockDirectory, { recursive: true });

    const transaction = path.join(library.transactionsDirectory, "interrupted-test");
    await fs.mkdir(transaction, { recursive: true });
    await fs.writeFile(
      path.join(transaction, "journal.json"),
      JSON.stringify({ status: "committing" }),
    );
    await assert.rejects(
      library.importTemplate({ title: "Blocked by transaction", codePaths: [codePath] }),
      /incomplete user-library transaction/u,
    );
    await assert.rejects(fs.stat(library.writeLockDirectory), /ENOENT/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("audit connects partial legacy duplicates and reconcile archives and rolls them back", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-reconcile-test-"));
  try {
    const library = new UserTemplateLibrary(path.join(root, "library"));
    const previewPath = path.join(root, "preview.png");
    await fs.writeFile(previewPath, PNG);
    const variants = [
      { title: "UMAP density English", sourceKey: "legacy:a", code: "# code-one\n", readme: "notes-one\n" },
      { title: "UMAP 密度模板", sourceKey: "legacy:b", code: "# code-two\n", readme: "notes-two\n" },
      { title: "UMAP 密度模板", sourceKey: "legacy:c", code: "# code-one\n", readme: "notes-two\n" },
    ];
    const imported = [];
    for (const [index, variant] of variants.entries()) {
      const directory = path.join(root, `source-${index}`);
      await fs.mkdir(directory);
      const codePath = path.join(directory, "plot.R");
      const readmePath = path.join(directory, "README.md");
      await fs.writeFile(codePath, variant.code);
      await fs.writeFile(readmePath, variant.readme);
      const result = await library.importTemplate({
        title: variant.title,
        sourceKey: variant.sourceKey,
        imagePath: previewPath,
        codePaths: [codePath, readmePath],
      });
      const manifestPath = path.join(result.directory, "template.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      delete manifest.registry;
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      imported.push(result);
    }
    const invalidDirectory = path.join(library.templatesDirectory, "invalid-template");
    await fs.mkdir(invalidDirectory);
    await fs.writeFile(path.join(invalidDirectory, "template.json"), "{not-json\n");

    const audit = await library.auditTemplates({ scope: "all", includeArchived: true });
    assert.equal(audit.legacyTemplateCount, 3);
    assert.equal(audit.invalidTemplateCount, 1);
    assert.equal(audit.duplicateGroupCount, 1);
    const group = audit.duplicateGroups[0]!;
    assert.equal(group.templateIds.length, 3);
    assert.ok(group.evidence.every((edge) => edge.matchKinds.includes("same_preview")));
    assert.ok(group.evidence.some((edge) => edge.matchKinds.includes("same_executable_code")));
    assert.ok(group.evidence.some((edge) => edge.matchKinds.includes("same_metadata")));

    const canonicalTemplateId = imported[0]!.template.templateId;
    const duplicateTemplateIds = imported.slice(1).map((item) => item.template.templateId);
    const expectedState = Object.fromEntries(
      audit.templates
        .filter((item) => [canonicalTemplateId, ...duplicateTemplateIds].includes(item.templateId))
        .map((item) => [
          item.templateId,
          {
            manifestSha256: item.manifestSha256,
            verifiedFileSetDigest: item.verifiedFileSetDigest,
            reviewStatus: item.reviewStatus,
          },
        ]),
    );
    const reconcile = {
      reconcileId: "umap-legacy-test-1",
      canonicalTemplateId,
      duplicateTemplateIds,
      strategy: "archive_duplicates" as const,
      expectedState,
      reason: "Synthetic legacy entries share component evidence and were reviewed for this test.",
    };
    const dryRun = await library.reconcileTemplates({ ...reconcile, mode: "dry-run" });
    assert.equal(dryRun.written, false);
    assert.ok("filesRetained" in dryRun);
    assert.equal(dryRun.filesRetained, 6);
    assert.equal((await library.get(duplicateTemplateIds[0]!))?.template.reviewStatus, "approved");

    const applied = await library.reconcileTemplates({ ...reconcile, mode: "apply" });
    assert.equal(applied.written, true);
    for (const templateId of duplicateTemplateIds) {
      const item = await library.get(templateId);
      assert.equal(item?.template.reviewStatus, "archived");
      assert.ok(await fs.stat(path.join(item!.directory, "preview.png")));
    }
    assert.notEqual((await library.get(canonicalTemplateId))?.template.reviewStatus, "archived");

    const rolledBack = await library.reconcileTemplates({ ...reconcile, mode: "rollback" });
    assert.equal(rolledBack.written, true);
    for (const templateId of duplicateTemplateIds) {
      assert.equal((await library.get(templateId))?.template.reviewStatus, "approved");
    }
    assert.ok(
      await fs.stat(
        path.join(library.root, "migrations", "reconciliations", "umap-legacy-test-1.rollback.json"),
      ),
    );

    const interruptedReconcile = { ...reconcile, reconcileId: "umap-interrupted-test" };
    await library.reconcileTemplates({ ...interruptedReconcile, mode: "apply" });
    const interruptedJournalPath = path.join(
      library.transactionsDirectory,
      interruptedReconcile.reconcileId,
      "journal.json",
    );
    const interruptedJournal = JSON.parse(await fs.readFile(interruptedJournalPath, "utf8"));
    interruptedJournal.status = "committing";
    await fs.writeFile(interruptedJournalPath, `${JSON.stringify(interruptedJournal, null, 2)}\n`);
    const recovered = await library.reconcileTemplates({
      ...interruptedReconcile,
      mode: "rollback",
      reason: "Recover a simulated interruption after all manifests and the apply ledger were written.",
    });
    assert.equal("recoveredIncomplete" in recovered && recovered.recoveredIncomplete, true);
    for (const templateId of duplicateTemplateIds) {
      assert.equal((await library.get(templateId))?.template.reviewStatus, "approved");
    }
    await assert.rejects(
      fs.stat(
        path.join(
          library.root,
          "migrations",
          "reconciliations",
          `${interruptedReconcile.reconcileId}.json`,
        ),
      ),
      /ENOENT/u,
    );

    const failedReconcile = { ...reconcile, reconcileId: "umap-ledger-conflict-test" };
    const ledgerDirectory = path.join(library.root, "migrations", "reconciliations");
    await fs.mkdir(ledgerDirectory, { recursive: true });
    await fs.writeFile(path.join(ledgerDirectory, `${failedReconcile.reconcileId}.json`), "reserved\n");
    await assert.rejects(
      library.reconcileTemplates({ ...failedReconcile, mode: "apply" }),
      /EEXIST|file already exists/u,
    );
    for (const templateId of duplicateTemplateIds) {
      assert.equal((await library.get(templateId))?.template.reviewStatus, "approved");
    }
    const failedJournal = JSON.parse(
      await fs.readFile(
        path.join(library.transactionsDirectory, failedReconcile.reconcileId, "journal.json"),
        "utf8",
      ),
    );
    assert.equal(failedJournal.status, "rolled-back");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
