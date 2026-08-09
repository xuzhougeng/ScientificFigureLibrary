import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function temporaryLibrary(prefix = "sfl-versioned-v1-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await ensureLibraryRootMarker(root);
  return { root, library: new VersionedTemplateLibrary(root) };
}

function pairedCandidate(options: {
  title: string;
  code?: string;
  preview?: string;
  relationship?: "user_supplied_pair" | "visual_inference";
  intake?: boolean;
}): VersionedTemplateCandidate {
  const preview = options.preview ?? "source-preview";
  const code = options.code ?? "plot(1)\n";
  const relationship = options.relationship ?? "user_supplied_pair";
  const previewHash = hash(preview);
  const codeHash = hash(code);
  return {
    title: options.title,
    description: "A complete, user-confirmed Figure Unit.",
    tags: ["publication", "scatter"],
    visualProfile: "points with labelled extremes",
    dataProfile: "tabular numeric input",
    packages: ["ggplot2"],
    license: "reference only",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "scatter",
    codeStatus: relationship === "visual_inference" ? "scaffold" : "reviewed",
    executionStatus: "not_run",
    primaryPreview: "visuals/source/preview.png",
    canonicalImplementation: { assetPath: "code/plot.R", selectedBy: "user" },
    visualGrouping: {
      visualAssetPaths: ["visuals/source/preview.png"],
      confirmedBy: "user",
      note: "The user confirmed this one-image Figure Unit boundary.",
    },
    figureCodeLinks: [
      {
        visualAssetPath: "visuals/source/preview.png",
        codeAssetPaths: ["code/plot.R"],
        relationship,
        confirmedBy: "user",
        evidence: "The user explicitly confirmed the visual-code association.",
      },
    ],
    provenance: { source: "user-upload", recordId: "local-figure-1" },
    ...(options.intake
      ? {
          intakeBinding: {
            adapterId: "user-upload",
            importId: `upload-${hash(options.title).slice(0, 16)}`,
            sourceManifest: {
              schema: "figure-library.user-upload-manifest.v1",
              recordId: "local-figure-1",
              originalNames: ["preview.png", "plot.R"],
            },
            requiredAssetSha256: [previewHash, codeHash].sort(),
          },
        }
      : {}),
    assets: [
      {
        logicalPath: "visuals/source/preview.png",
        role: "visual",
        visualRole: "source_reference",
        mediaType: "image/png",
        text: preview,
        origin: { kind: "user_supplied" },
      },
      {
        logicalPath: "code/plot.R",
        role: "code",
        codeOrigin: relationship === "visual_inference" ? "agent_generated" : "user_supplied",
        language: "R",
        text: code,
        origin: { kind: relationship === "visual_inference" ? "agent_generated" : "user_supplied" },
      },
    ],
  };
}

async function publish(
  library: VersionedTemplateLibrary,
  templateId: string,
  candidate: VersionedTemplateCandidate,
  operationPrefix: string,
) {
  const plan = await library.planCreateWorking({ templateId, candidate });
  assert.deepEqual(plan.review.validationErrors, []);
  assert.deepEqual(plan.review.blockingGates, []);
  await library.applyCreateWorking(plan, `${operationPrefix}-working`);
  const publishPlan = await library.planPublish({ templateId });
  return library.applyPublish(publishPlan, `${operationPrefix}-publish`);
}

test("immutable Working/Published lifecycle preserves old releases and exact revisions", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const publishedV1 = await publish(
      library,
      "scatter-series",
      pairedCandidate({ title: "Scatter v1" }),
      "v1",
    );
    const revisionV1 = publishedV1.revisionId!;
    const digestV1 = publishedV1.contentDigest!;
    await assert.rejects(
      library.getPreview("scatter-series", {
        revisionId: revisionV1,
        contentDigest: digestV1,
      }),
      /valid image\/png signature/u,
    );
    assert.equal(
      (await library.listPublishedCandidates())[0]?.previewAvailable,
      false,
      "invalid bytes must not be advertised as a usable MCP preview",
    );

    const workingV2 = await library.planCreateWorking({
      templateId: "scatter-series",
      candidate: pairedCandidate({
        title: "Scatter v2",
        preview: "source-preview-v2",
        code: "plot(2)\n",
      }),
    });
    await library.applyCreateWorking(workingV2, "v2-working");
    assert.equal((await library.listPublishedCandidates())[0]?.title, "Scatter v1");
    assert.notEqual(workingV2.content.revisionId, revisionV1);

    const historical = await library.getContent("scatter-series", revisionV1, digestV1);
    assert.equal(historical?.title, "Scatter v1");
    const diff = await library.diff("scatter-series", revisionV1, workingV2.content.revisionId);
    assert.ok(diff.fieldChanges.some((entry) => entry.field === "title"));
    assert.deepEqual(
      diff.assets.changed.map((entry) => entry.logicalPath),
      ["code/plot.R", "visuals/source/preview.png"],
    );

    await library.applyPublish(await library.planPublish({ templateId: "scatter-series" }), "v2-publish");
    assert.equal((await library.listPublishedCandidates())[0]?.title, "Scatter v2");
    assert.equal((await library.history("scatter-series")).releases.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("direct intake enforces canonical paths, code origin, grouping, links, and visual-inference claims", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const inferred = await library.planCreateWorking({
      templateId: "inferred-scaffold",
      candidate: pairedCandidate({
        title: "Inferred scaffold",
        relationship: "visual_inference",
      }),
    });
    assert.deepEqual(inferred.review.validationErrors, []);
    assert.ok(
      inferred.review.warnings.some((warning) => warning.code === "inspired_by_not_reproduced"),
    );
    assert.equal(inferred.content.codeStatus, "scaffold");
    assert.equal(inferred.content.executionStatus, "not_run");
    await library.applyCreateWorking(inferred, "apply-inferred");

    const invalidClaim = pairedCandidate({
      title: "Invalid inference claim",
      relationship: "visual_inference",
    });
    invalidClaim.executionStatus = "passed";
    const invalidPlan = await library.planCreateWorking({
      templateId: "invalid-inference",
      candidate: invalidClaim,
    });
    assert.ok(
      invalidPlan.review.validationErrors.some(
        (error) => error.code === "visual_inference_must_be_unrun_scaffold",
      ),
    );

    const missingOrigin = pairedCandidate({ title: "Missing origin" });
    delete missingOrigin.assets[1]!.codeOrigin;
    await assert.rejects(
      library.planCreateWorking({ templateId: "missing-origin", candidate: missingOrigin }),
      /missing codeOrigin/u,
    );
    const absoluteOrigin = pairedCandidate({ title: "Absolute origin" });
    absoluteOrigin.assets[0]!.origin = { originalPath: "C:\\Users\\Researcher\\preview.png" };
    await assert.rejects(
      library.planCreateWorking({ templateId: "absolute-origin", candidate: absoluteOrigin }),
      /cannot persist an absolute filesystem path/u,
    );
    const missingGrouping = pairedCandidate({ title: "Missing grouping" });
    delete missingGrouping.visualGrouping;
    await assert.rejects(
      library.planCreateWorking({ templateId: "missing-grouping", candidate: missingGrouping }),
      /grouping must be explicitly confirmed/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("generic intake receipts are self-contained and portable", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const plan = await library.planCreateWorking({
      templateId: "uploaded-template",
      candidate: pairedCandidate({ title: "Uploaded template", intake: true }),
    });
    const applied = await library.applyCreateWorking(plan, "apply-upload");
    assert.match(applied.importReceiptId ?? "", /^import-receipt-/u);
    const receipts = await library.listImportReceipts("user-upload");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.selfContained, true);
    assert.equal(receipts[0]?.revisionId, applied.revisionId);
    const importDirectory = path.join(
      root,
      "store",
      "imports",
      "user-upload",
      plan.content.intakeBinding!.importId,
      "receipts",
      applied.importReceiptId!,
    );
    assert.equal(
      JSON.stringify(JSON.parse(await fs.readFile(path.join(importDirectory, "receipt.json"), "utf8"))).includes(root),
      false,
    );

    const updateCandidate = pairedCandidate({
      title: "Uploaded template revision 2",
      intake: true,
    });
    updateCandidate.intakeBinding = {
      ...updateCandidate.intakeBinding!,
      importId: plan.content.intakeBinding!.importId,
      sourceManifest: plan.content.intakeBinding!.sourceManifest,
    };
    const updatePlan = await library.planUpdateWorking({
      templateId: "uploaded-template",
      candidate: updateCandidate,
    });
    const updated = await library.applyUpdateWorking(updatePlan, "apply-upload-v2");
    assert.notEqual(updated.revisionId, applied.revisionId);
    assert.equal((await library.listImportReceipts("user-upload")).length, 2);
    const replayed = await library.applyUpdateWorking(updatePlan, "apply-upload-v2");
    assert.equal(replayed.idempotentReplay, true);
    assert.equal(
      (
        await fs.stat(
          path.join(root, "store", "operations", "receipts", "apply-upload-v2.json"),
        )
      ).isFile(),
      true,
    );
    assert.equal(
      JSON.stringify(JSON.parse(await fs.readFile(path.join(importDirectory, "source-manifest.json"), "utf8"))).includes(root),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Local Published materialization uses the common portable envelope and durable replay", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const published = await publish(
      library,
      "portable-materialization",
      pairedCandidate({ title: "Portable materialization" }),
      "portable",
    );
    const destination = path.join(root, "outputs");
    const hostPlanDigest = hash("host-materialization-plan");
    const plan = await library.planMaterializeRevision({
      templateId: "portable-materialization",
      revisionId: published.revisionId!,
      contentDigest: published.contentDigest!,
      releaseId: published.releaseId,
      destination,
      operationId: "host-materialize-1",
      planDigest: hostPlanDigest,
    });
    const applied = await library.applyMaterializeRevision(plan, "host-materialize-1");
    assert.equal(applied.idempotentReplay, false);
    assert.equal(
      (await library.applyMaterializeRevision(plan, "host-materialize-1")).idempotentReplay,
      true,
    );
    const target = applied.target;
    for (const relative of [
      "TEMPLATE.md",
      "template.json",
      "template.lock.json",
      "assets/visuals/source/preview.png",
      "assets/code/plot.R",
    ]) {
      assert.equal((await fs.stat(path.join(target, ...relative.split("/")))).isFile(), true);
    }
    assert.equal(await fs.stat(path.join(target, "reference")).then(() => true).catch(() => false), false);
    const lockText = await fs.readFile(path.join(target, "template.lock.json"), "utf8");
    const lock = JSON.parse(lockText) as {
      operationId: string;
      planDigest: string;
      materializedAt?: string;
      files: Array<{ file: string; bytes: number; sha256: string }>;
    };
    assert.equal(lock.operationId, "host-materialize-1");
    assert.equal(lock.planDigest, hostPlanDigest);
    assert.equal(lock.materializedAt, undefined);
    assert.ok(lock.files.every((file) => !path.isAbsolute(file.file) && /^[a-f0-9]{64}$/u.test(file.sha256)));
    assert.equal(lockText.includes(root), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
