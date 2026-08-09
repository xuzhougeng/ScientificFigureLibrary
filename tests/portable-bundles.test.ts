import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withCrossRuntimeWriteLock } from "../src/cross-runtime-lock.ts";
import { ensureLibraryRootMarker, readLibraryRootMarker } from "../src/library-runtime.ts";
import { PortableBundleManager } from "../src/portable-bundles.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

function candidate(title: string): VersionedTemplateCandidate {
  return {
    title,
    description: "Portable exact Published template bundle fixture.",
    tags: ["bundle"],
    visualProfile: "line chart",
    dataProfile: "x/y table",
    packages: ["ggplot2"],
    license: "reference only",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "line",
    codeStatus: "reviewed",
    executionStatus: "not_run",
    primaryPreview: "visuals/source/preview.png",
    canonicalImplementation: { assetPath: "code/plot.R", selectedBy: "user" },
    visualGrouping: {
      visualAssetPaths: ["visuals/source/preview.png"],
      confirmedBy: "user",
    },
    figureCodeLinks: [
      {
        visualAssetPath: "visuals/source/preview.png",
        codeAssetPaths: ["code/plot.R"],
        relationship: "author_provided_original",
        confirmedBy: "user",
        evidence: "The user confirmed that the author supplied this visual/code pair.",
      },
    ],
    provenance: { doi: "10.0000/portable-test" },
    assets: [
      {
        logicalPath: "visuals/source/preview.png",
        role: "visual",
        visualRole: "source_reference",
        mediaType: "image/png",
        text: "portable-preview",
      },
      {
        logicalPath: "code/plot.R",
        role: "code",
        codeOrigin: "author_provided",
        language: "R",
        text: "plot(1)\n",
      },
      {
        logicalPath: "references/caption.md",
        role: "reference",
        text: "Figure caption\n",
      },
      {
        logicalPath: "evidence/association.md",
        role: "evidence",
        text: "User-confirmed association.\n",
      },
    ],
  };
}

async function createPublished(root: string, templateId = "portable-bundle-template") {
  await ensureLibraryRootMarker(root);
  const library = new VersionedTemplateLibrary(root);
  const working = await library.planCreateWorking({ templateId, candidate: candidate("Bundle source") });
  await library.applyCreateWorking(working, "bundle-source-working");
  const published = await library.applyPublish(
    await library.planPublish({ templateId }),
    "bundle-source-publish",
  );
  return { library, published };
}

async function overwriteBundleFile(file: string, bytes: string) {
  await fs.chmod(file, 0o644);
  await fs.writeFile(file, bytes);
}

async function overwriteBundleJson(file: string, value: unknown) {
  await overwriteBundleFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("exact Published bundle imports as Working and never inherits source approval", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-template-bundle-"));
  try {
    const sourceRoot = path.join(root, "source-library");
    const { library: sourceLibrary, published } = await createPublished(sourceRoot);
    const unreviewedWorking = await sourceLibrary.planCreateWorking({
      templateId: "portable-bundle-template",
      candidate: candidate("Private Working v2"),
      assessment: {
        blockingGates: [
          {
            gateId: "working-v2-review",
            code: "human_review_required",
            message: "This Working Revision is intentionally not Published.",
          },
        ],
      },
    });
    await sourceLibrary.applyCreateWorking(unreviewedWorking, "bundle-private-working-v2");
    const manager = new PortableBundleManager(sourceRoot, sourceLibrary);
    const exportPlan = await manager.planPublishedTemplateExport({
      templateId: "portable-bundle-template",
      releaseId: published.releaseId,
      destination: path.join(root, "exports"),
      targetName: "exact-template-bundle",
    });
    const exported = await manager.applyExport(exportPlan, "export-exact-template");
    assert.equal(exported.idempotentReplay, false);
    assert.equal((await manager.applyExport(exportPlan, "export-exact-template")).idempotentReplay, true);
    const bundle = JSON.parse(
      await fs.readFile(path.join(exported.target, "bundle.json"), "utf8"),
    ) as { schema: string; selector: { releaseId: string }; importAuthorityPolicy: string };
    assert.equal(bundle.schema, "figure-library.published-template-bundle.v1");
    assert.equal(bundle.selector.releaseId, published.releaseId);
    assert.equal(bundle.importAuthorityPolicy, "working_revision_requires_local_review");
    const exportedSeriesText = await fs.readFile(
      path.join(exported.target, "payload", "series", "series.json"),
      "utf8",
    );
    const exportedSeries = JSON.parse(exportedSeriesText) as {
      workingHead?: unknown;
      publishedHead?: { revisionId: string; releaseId: string };
    };
    assert.equal(exportedSeries.workingHead, undefined);
    assert.equal(exportedSeries.publishedHead?.revisionId, published.revisionId);
    assert.equal(exportedSeries.publishedHead?.releaseId, published.releaseId);
    const completeBundleText = (
      await Promise.all(
        [
          "payload/series/series.json",
          "payload/revision/content.json",
          "payload/review/review.json",
          "payload/release/release.json",
        ].map((relative) => fs.readFile(path.join(exported.target, ...relative.split("/")), "utf8")),
      )
    ).join("\n");
    assert.equal(completeBundleText.includes(unreviewedWorking.content.revisionId), false);
    assert.equal(completeBundleText.includes(unreviewedWorking.review.reviewId), false);

    const targetRoot = path.join(root, "target-library");
    await ensureLibraryRootMarker(targetRoot);
    const targetLibrary = new VersionedTemplateLibrary(targetRoot);
    const targetManager = new PortableBundleManager(targetRoot, targetLibrary);
    const importPlan = await targetManager.planTemplateBundleImport({
      bundleDirectory: exported.target,
      targetTemplateId: "imported-template",
      mode: "create",
    });
    assert.equal(importPlan.lifecyclePlan.action, "create_working");
    assert.ok(
      importPlan.lifecyclePlan.review.warnings.some(
        (warning) => warning.code === "imported_approval_not_inherited",
      ),
    );
    const imported = await targetManager.applyTemplateBundleImport(
      importPlan,
      "import-exact-template",
    );
    assert.ok(imported.revisionId);
    const series = await targetLibrary.getSeries("imported-template");
    assert.ok(series?.workingHead);
    assert.equal(series?.publishedHead, undefined);
    assert.equal((await targetLibrary.listPublishedCandidates()).length, 0);
    assert.equal((await targetLibrary.listImportReceipts("template-bundle")).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("full backup excludes derived/runtime state and supports restore versus fork identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-full-backup-"));
  try {
    const sourceRoot = path.join(root, "source-library");
    const { library } = await createPublished(sourceRoot, "backup-template");
    await fs.writeFile(path.join(sourceRoot, "indexes", "published.jsonl"), "derived\n");
    await fs.writeFile(path.join(sourceRoot, "locks", "ignored-runtime-file"), "runtime\n");
    const sourceMarker = (await readLibraryRootMarker(sourceRoot))!.value;
    const manager = new PortableBundleManager(sourceRoot, library);
    const backupPlan = await manager.planFullBackup({
      destination: path.join(root, "backups"),
      targetName: "full-backup",
    });
    const backup = await manager.applyExport(backupPlan, "export-full-backup");
    const inventoryText = await fs.readFile(path.join(backup.target, "inventory.jsonl"), "utf8");
    assert.equal(inventoryText.includes("payload/indexes/"), false);
    assert.equal(inventoryText.includes("payload/locks/"), false);
    assert.equal(inventoryText.includes("payload/library.json"), true);
    assert.equal(inventoryText.includes("payload/store/templates/"), true);

    const restoredRoot = path.join(root, "restored-library");
    const restorePlan = await PortableBundleManager.planFullLibraryRestore({
      bundleDirectory: backup.target,
      targetDirectory: restoredRoot,
      mode: "restore",
      authorityTransferConfirmed: true,
    });
    const restored = await PortableBundleManager.applyFullLibraryRestore(
      restorePlan,
      "restore-full-backup",
    );
    assert.equal(restored.idempotentReplay, false);
    assert.equal(restored.targetLibraryId, sourceMarker.libraryId);
    assert.equal((await readLibraryRootMarker(restoredRoot))?.value.libraryId, sourceMarker.libraryId);
    assert.equal(
      (await new VersionedTemplateLibrary(restoredRoot).listPublishedCandidates())[0]?.templateId,
      "backup-template",
    );

    const forkRoot = path.join(root, "forked-library");
    const forkPlan = await PortableBundleManager.planFullLibraryRestore({
      bundleDirectory: backup.target,
      targetDirectory: forkRoot,
      mode: "fork",
    });
    const forked = await PortableBundleManager.applyFullLibraryRestore(
      forkPlan,
      "fork-full-backup",
    );
    assert.equal(forked.idempotentReplay, false);
    assert.notEqual(forked.targetLibraryId, sourceMarker.libraryId);
    const forkMarker = (await readLibraryRootMarker(forkRoot))!.value;
    assert.equal(forkMarker.libraryId, forked.targetLibraryId);
    assert.equal(forkMarker.forkedFromLibraryId, sourceMarker.libraryId);
    const restoreReceipt = JSON.parse(
      await fs.readFile(
        path.join(
          forkRoot,
          "store",
          "operations",
          "receipts",
          "bundle-restores",
          "fork-full-backup.json",
        ),
        "utf8",
      ),
    );
    assert.equal(JSON.stringify(restoreReceipt).includes(forkRoot), false);
    assert.equal(
      (
        await PortableBundleManager.applyFullLibraryRestore(
          forkPlan,
          "fork-full-backup",
        )
      ).idempotentReplay,
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restore refuses implicit split-brain and requires fork without authority transfer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-restore-guard-"));
  try {
    const sourceRoot = path.join(root, "source");
    const { library } = await createPublished(sourceRoot, "guard-template");
    const manager = new PortableBundleManager(sourceRoot, library);
    const backup = await manager.applyExport(
      await manager.planFullBackup({ destination: path.join(root, "backup") }),
      "guard-backup",
    );
    await assert.rejects(
      PortableBundleManager.planFullLibraryRestore({
        bundleDirectory: backup.target,
        targetDirectory: path.join(root, "unsafe-restore"),
        mode: "restore",
      }),
      /authorityTransferConfirmed/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("full backup Apply uses the shared writer lock and rejects recursive targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-backup-lock-"));
  try {
    const sourceRoot = path.join(root, "source");
    const { library } = await createPublished(sourceRoot, "locked-backup-template");
    const manager = new PortableBundleManager(sourceRoot, library);
    await assert.rejects(
      manager.planFullBackup({
        destination: path.join(sourceRoot, "exports"),
        targetName: "recursive-backup",
      }),
      /must be outside/u,
    );
    const linkedSource = path.join(root, "linked-source");
    await fs.symlink(sourceRoot, linkedSource, "dir");
    await assert.rejects(
      manager.planFullBackup({
        destination: linkedSource,
        targetName: "symlink-recursive-backup",
      }),
      /must be outside/u,
    );
    const plan = await manager.planFullBackup({
      destination: path.join(root, "backups"),
      targetName: "locked-backup",
    });
    const marker = (await readLibraryRootMarker(sourceRoot))!.value;
    await withCrossRuntimeWriteLock(
      {
        root: sourceRoot,
        lockDirectory: path.join(sourceRoot, "locks", "write"),
        libraryId: marker.libraryId,
        operation: "test-held-writer",
      },
      async () => {
        await assert.rejects(
          manager.applyExport(plan, "backup-must-respect-lock"),
          /library_busy/u,
        );
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("authoritative export intent recovers rename-before-receipt without adopting an unplanned target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-export-intent-recovery-"));
  try {
    const sourceRoot = path.join(root, "source");
    const { library } = await createPublished(sourceRoot, "export-intent-template");
    const targetName = "recoverable-template-bundle";
    const plan = await new PortableBundleManager(sourceRoot, library).planPublishedTemplateExport({
      templateId: "export-intent-template",
      destination: path.join(root, "exports"),
      targetName,
    });
    const operationId = "recover-export-after-rename";
    const crashing = new PortableBundleManager(sourceRoot, library, {
      faultInjector(point) {
        if (point === "before_export_receipt") {
          throw new Error("simulated crash before export receipt");
        }
      },
    });
    await assert.rejects(
      crashing.applyExport(plan, operationId),
      /simulated crash before export receipt/u,
    );
    const target = path.join(plan.destination, plan.targetName);
    assert.equal((await fs.stat(target)).isDirectory(), true);
    await assert.rejects(
      fs.stat(
        path.join(
          sourceRoot,
          "store",
          "operations",
          "receipts",
          "exports",
          `${operationId}.json`,
        ),
      ),
      { code: "ENOENT" },
    );
    assert.equal(
      (
        await fs.stat(
          path.join(
            sourceRoot,
            "store",
            "operations",
            "intents",
            "bundle-exports",
            `${operationId}.json`,
          ),
        )
      ).isFile(),
      true,
    );

    const recovered = await new PortableBundleManager(sourceRoot, library).recoverExport({
      planDigest: plan.planDigest,
      operationId,
      expectedTarget: target,
    });
    assert.equal(recovered?.idempotentReplay, true);
    assert.equal(recovered?.recovered, true);
    assert.equal(
      (
        await new PortableBundleManager(sourceRoot, library).recoverExport({
          planDigest: plan.planDigest,
          operationId,
          expectedTarget: target,
        })
      )?.recovered,
      undefined,
    );

    const intentOnlyPlan = await new PortableBundleManager(
      sourceRoot,
      library,
    ).planPublishedTemplateExport({
      templateId: "export-intent-template",
      destination: path.join(root, "exports"),
      targetName: "intent-only-template-bundle",
    });
    const intentOnlyOperationId = "intent-only-export";
    const intentOnly = new PortableBundleManager(sourceRoot, library, {
      faultInjector(point) {
        if (point === "after_export_intent") {
          throw new Error("simulated crash after export intent");
        }
      },
    });
    await assert.rejects(
      intentOnly.applyExport(intentOnlyPlan, intentOnlyOperationId),
      /simulated crash after export intent/u,
    );
    const intentOnlyTarget = path.join(
      intentOnlyPlan.destination,
      intentOnlyPlan.targetName,
    );
    await assert.rejects(fs.stat(intentOnlyTarget), { code: "ENOENT" });
    assert.equal(
      await new PortableBundleManager(sourceRoot, library).recoverExport({
        planDigest: intentOnlyPlan.planDigest,
        operationId: intentOnlyOperationId,
        expectedTarget: intentOnlyTarget,
      }),
      undefined,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("full restore Apply revalidates bundle metadata and payload on replay", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-restore-revalidate-"));
  try {
    const sourceRoot = path.join(root, "source");
    const { library } = await createPublished(sourceRoot, "restore-revalidate-template");
    const manager = new PortableBundleManager(sourceRoot, library);
    const backup = await manager.applyExport(
      await manager.planFullBackup({
        destination: path.join(root, "backups"),
        targetName: "restore-revalidate-backup",
      }),
      "restore-revalidate-export",
    );
    const targetDirectory = path.join(root, "restored");
    const plan = await PortableBundleManager.planFullLibraryRestore({
      bundleDirectory: backup.target,
      targetDirectory,
      mode: "restore",
      authorityTransferConfirmed: true,
    });
    const metadataFile = path.join(backup.target, "bundle.json");
    const originalMetadataText = await fs.readFile(metadataFile, "utf8");
    const originalMetadata = JSON.parse(originalMetadataText) as Record<string, unknown>;
    const mutations: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        "schema",
        { ...originalMetadata, schema: "figure-library.full-backup-bundle.v2" },
        /bundle schema changed/u,
      ],
      [
        "bundleId",
        { ...originalMetadata, bundleId: "full-backup-replaced" },
        /bundleId changed/u,
      ],
      [
        "sourceLibraryId",
        { ...originalMetadata, sourceLibraryId: "source-library-replaced" },
        /sourceLibraryId changed/u,
      ],
      [
        "payloadInventoryDigest",
        {
          ...originalMetadata,
          payloadInventoryDigest:
            originalMetadata.payloadInventoryDigest === "0".repeat(64)
              ? "1".repeat(64)
              : "0".repeat(64),
        },
        /bundle inventory digest changed/u,
      ],
    ];
    for (const [label, metadata, expected] of mutations) {
      await overwriteBundleJson(metadataFile, metadata);
      await assert.rejects(
        PortableBundleManager.applyFullLibraryRestore(
          plan,
          `restore-revalidate-${label}`,
        ),
        expected,
      );
      await assert.rejects(fs.stat(targetDirectory), { code: "ENOENT" });
      await overwriteBundleFile(metadataFile, originalMetadataText);
    }

    const restored = await PortableBundleManager.applyFullLibraryRestore(
      plan,
      "restore-revalidate-success",
    );
    assert.equal(restored.idempotentReplay, false);

    const payloadMarker = path.join(backup.target, "payload", "library.json");
    const originalMarker = await fs.readFile(payloadMarker, "utf8");
    await overwriteBundleFile(payloadMarker, `${originalMarker}\n`);
    await assert.rejects(
      PortableBundleManager.applyFullLibraryRestore(
        plan,
        "restore-revalidate-success",
      ),
      /bundle payload inventory mismatch/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("template import Apply rejects replaced metadata and non-asset payload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-template-import-revalidate-"));
  try {
    const sourceRoot = path.join(root, "source");
    const { library: sourceLibrary } = await createPublished(
      sourceRoot,
      "template-import-revalidate-source",
    );
    const sourceManager = new PortableBundleManager(sourceRoot, sourceLibrary);
    const bundle = await sourceManager.applyExport(
      await sourceManager.planPublishedTemplateExport({
        templateId: "template-import-revalidate-source",
        destination: path.join(root, "exports"),
        targetName: "template-import-revalidate-bundle",
      }),
      "template-import-revalidate-export",
    );

    const targetRoot = path.join(root, "target");
    await ensureLibraryRootMarker(targetRoot);
    const targetLibrary = new VersionedTemplateLibrary(targetRoot);
    const targetManager = new PortableBundleManager(targetRoot, targetLibrary);
    const plan = await targetManager.planTemplateBundleImport({
      bundleDirectory: bundle.target,
      targetTemplateId: "template-import-revalidate-target",
      mode: "create",
    });

    const metadataFile = path.join(bundle.target, "bundle.json");
    const originalMetadataText = await fs.readFile(metadataFile, "utf8");
    const changedMetadata = JSON.parse(originalMetadataText) as Record<string, unknown>;
    changedMetadata.createdAt = "1970-01-01T00:00:00.000Z";
    await overwriteBundleJson(metadataFile, changedMetadata);
    await assert.rejects(
      targetManager.applyTemplateBundleImport(
        plan,
        "template-import-revalidate-metadata",
      ),
      /bundle metadata changed/u,
    );
    assert.equal(await targetLibrary.getSeries("template-import-revalidate-target"), undefined);
    await overwriteBundleFile(metadataFile, originalMetadataText);

    const reviewFile = path.join(bundle.target, "payload", "review", "review.json");
    const originalReview = await fs.readFile(reviewFile, "utf8");
    await overwriteBundleFile(reviewFile, `${originalReview}\n`);
    await assert.rejects(
      targetManager.applyTemplateBundleImport(
        plan,
        "template-import-revalidate-payload",
      ),
      /bundle payload inventory mismatch/u,
    );
    assert.equal(await targetLibrary.getSeries("template-import-revalidate-target"), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("full restore rejects a bundled operationId conflict before creating target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-restore-operation-conflict-"));
  try {
    const sourceRoot = path.join(root, "source");
    const { library } = await createPublished(
      sourceRoot,
      "restore-operation-conflict-template",
    );
    const sourceMarker = (await readLibraryRootMarker(sourceRoot))!.value;
    const operationId = "restore-operation-conflict";
    const inheritedReceiptFile = path.join(
      sourceRoot,
      "store",
      "operations",
      "receipts",
      "bundle-restores",
      `${operationId}.json`,
    );
    await fs.mkdir(path.dirname(inheritedReceiptFile), { recursive: true });
    await fs.writeFile(
      inheritedReceiptFile,
      `${JSON.stringify(
        {
          schema: "figure-library.bundle-operation-receipt.v1",
          receiptId: "bundle-restore-receipt-inherited",
          operationId,
          action: "restore",
          planId: "bundle-restore-plan-inherited",
          planDigest: "0".repeat(64),
          bundleId: "full-backup-inherited",
          inventoryDigest: "1".repeat(64),
          sourceLibraryId: sourceMarker.libraryId,
          targetLibraryId: sourceMarker.libraryId,
          appliedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );

    const manager = new PortableBundleManager(sourceRoot, library);
    const backup = await manager.applyExport(
      await manager.planFullBackup({
        destination: path.join(root, "backups"),
        targetName: "operation-conflict-backup",
      }),
      "operation-conflict-export",
    );
    const targetDirectory = path.join(root, "must-not-exist");
    const plan = await PortableBundleManager.planFullLibraryRestore({
      bundleDirectory: backup.target,
      targetDirectory,
      mode: "restore",
      authorityTransferConfirmed: true,
    });
    await assert.rejects(
      PortableBundleManager.applyFullLibraryRestore(plan, operationId),
      /operationId was used for a different restore\/fork/u,
    );
    await assert.rejects(fs.stat(targetDirectory), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
