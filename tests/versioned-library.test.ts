import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.ts";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";
import {
  VALIDATION_STATE_SCHEMA,
  VersionedTemplateLibrary,
  effectiveValidationState,
  legacyValidationStateFromExecutionStatus,
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


test("canonical preview policy defaults to uploaded sources and requires rendered overrides", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const defaultSource = pairedCandidate({ title: "Default source" });
    defaultSource.assets.push({
      logicalPath: "visuals/rendered/default-output.png",
      role: "visual",
      visualRole: "rendered_output",
      mediaType: "image/png",
      text: "default-rendered-output",
    });
    defaultSource.visualGrouping!.visualAssetPaths.push(
      "visuals/rendered/default-output.png",
    );
    defaultSource.figureCodeLinks!.push({
      visualAssetPath: "visuals/rendered/default-output.png",
      codeAssetPaths: ["code/plot.R"],
      relationship: "generated_output",
      confirmedBy: "user",
      evidence: "This code generated the optional rendered comparison.",
    });
    delete defaultSource.primaryPreview;
    const defaultPlan = await library.planCreateWorking({
      templateId: "default-source",
      candidate: defaultSource,
    });
    assert.deepEqual(defaultPlan.review.validationErrors, []);
    assert.equal(defaultPlan.content.primaryPreview, "visuals/source/preview.png");
    assert.deepEqual(defaultPlan.content.canonicalPreviewDecision, {
      assetPath: "visuals/source/preview.png",
      reason: "default_uploaded_source",
      selectedBy: "policy",
    });

    const explicitSource = await library.planCreateWorking({
      templateId: "explicit-source",
      candidate: pairedCandidate({ title: "Explicit source" }),
    });
    assert.deepEqual(explicitSource.content.canonicalPreviewDecision, {
      assetPath: "visuals/source/preview.png",
      reason: "user_selected_source",
      selectedBy: "user",
    });

    const renderedOverride = pairedCandidate({ title: "Rendered override" });
    renderedOverride.assets.push({
      logicalPath: "visuals/rendered/output.png",
      role: "visual",
      visualRole: "rendered_output",
      mediaType: "image/png",
      text: "rendered-output",
    });
    renderedOverride.visualGrouping!.visualAssetPaths.push("visuals/rendered/output.png");
    renderedOverride.figureCodeLinks!.push({
      visualAssetPath: "visuals/rendered/output.png",
      codeAssetPaths: ["code/plot.R"],
      relationship: "generated_output",
      confirmedBy: "user",
      evidence: "The user confirmed that this code generated the rendered output.",
    });
    renderedOverride.primaryPreview = "visuals/rendered/output.png";
    const blocked = await library.planCreateWorking({
      templateId: "rendered-override-blocked",
      candidate: renderedOverride,
    });
    assert.ok(
      blocked.review.validationErrors.some(
        (error) => error.code === "canonical_preview_override_required",
      ),
    );

    renderedOverride.primaryPreviewOverride = {
      confirmedBy: "user",
      reason: "The rendered output is the reviewed publication-ready view.",
    };
    const allowed = await library.planCreateWorking({
      templateId: "rendered-override-allowed",
      candidate: renderedOverride,
    });
    assert.equal(
      allowed.review.validationErrors.some(
        (error) => error.code === "canonical_preview_override_required",
      ),
      false,
    );
    assert.deepEqual(allowed.content.canonicalPreviewDecision, {
      assetPath: "visuals/rendered/output.png",
      reason: "user_override_rendered",
      selectedBy: "user",
      note: "The rendered output is the reviewed publication-ready view.",
    });

    const ambiguousSources = pairedCandidate({ title: "Ambiguous sources" });
    delete ambiguousSources.primaryPreview;
    ambiguousSources.assets.push({
      logicalPath: "visuals/source/alternate.png",
      role: "visual",
      visualRole: "source_reference",
      mediaType: "image/png",
      text: "alternate-source",
    });
    ambiguousSources.visualGrouping!.visualAssetPaths.push("visuals/source/alternate.png");
    ambiguousSources.figureCodeLinks!.push({
      visualAssetPath: "visuals/source/alternate.png",
      codeAssetPaths: ["code/plot.R"],
      relationship: "user_supplied_pair",
      confirmedBy: "user",
      evidence: "The user supplied this alternate source with the code.",
    });
    const ambiguous = await library.planCreateWorking({
      templateId: "ambiguous-sources",
      candidate: ambiguousSources,
    });
    assert.ok(
      ambiguous.review.validationErrors.some(
        (error) => error.code === "canonical_preview_ambiguous",
      ),
    );

    const onlyRendered = pairedCandidate({ title: "Only rendered" });
    const rendered = onlyRendered.assets[0]!;
    rendered.logicalPath = "visuals/rendered/only.png";
    rendered.visualRole = "rendered_output";
    onlyRendered.visualGrouping!.visualAssetPaths = ["visuals/rendered/only.png"];
    onlyRendered.figureCodeLinks![0]!.visualAssetPath = "visuals/rendered/only.png";
    delete onlyRendered.primaryPreview;
    const onlyRenderedPlan = await library.planCreateWorking({
      templateId: "only-rendered",
      candidate: onlyRendered,
    });
    assert.deepEqual(onlyRenderedPlan.content.canonicalPreviewDecision, {
      assetPath: "visuals/rendered/only.png",
      reason: "only_visual_available",
      selectedBy: "policy",
    });

    const multipleRendered = pairedCandidate({ title: "Multiple rendered" });
    multipleRendered.assets[0]!.logicalPath = "visuals/rendered/first.png";
    multipleRendered.assets[0]!.visualRole = "rendered_output";
    multipleRendered.assets.push({
      logicalPath: "visuals/rendered/second.png",
      role: "visual",
      visualRole: "rendered_output",
      mediaType: "image/png",
      text: "second-rendered",
    });
    multipleRendered.visualGrouping!.visualAssetPaths = [
      "visuals/rendered/first.png",
      "visuals/rendered/second.png",
    ];
    multipleRendered.figureCodeLinks![0]!.visualAssetPath = "visuals/rendered/first.png";
    multipleRendered.figureCodeLinks!.push({
      visualAssetPath: "visuals/rendered/second.png",
      codeAssetPaths: ["code/plot.R"],
      relationship: "generated_output",
      confirmedBy: "user",
      evidence: "This code generated the second rendered output.",
    });
    delete multipleRendered.primaryPreview;
    const multipleRenderedPlan = await library.planCreateWorking({
      templateId: "multiple-rendered",
      candidate: multipleRendered,
    });
    assert.ok(
      multipleRenderedPlan.review.validationErrors.some(
        (error) => error.code === "canonical_preview_ambiguous",
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("validationState records scoped execution truth and enforces compatibility evidence", async () => {
  const { root, library } = await temporaryLibrary();
  try {
    const executed = pairedCandidate({ title: "Scoped execution" });
    executed.assets.push(
      {
        logicalPath: "visuals/rendered/output.png",
        role: "visual",
        visualRole: "rendered_output",
        mediaType: "image/png",
        text: "rendered-output",
      },
      {
        logicalPath: "evidence/execution.json",
        role: "evidence",
        mediaType: "application/json",
        text: '{"exitCode":0}',
      },
    );
    executed.visualGrouping!.visualAssetPaths.push("visuals/rendered/output.png");
    executed.figureCodeLinks!.push({
      visualAssetPath: "visuals/rendered/output.png",
      codeAssetPaths: ["code/plot.R"],
      relationship: "generated_output",
      confirmedBy: "user",
      evidence: "The execution record ties the rendered output to this code.",
    });
    executed.executionStatus = "passed";
    executed.validationState = {
      schema: VALIDATION_STATE_SCHEMA,
      plotExecution: {
        status: "passed",
        scope: "synthetic_data",
        evidenceAssetPaths: ["evidence/execution.json"],
      },
      upstreamWorkflow: { status: "not_run" },
      scientificValidation: { status: "not_assessed" },
    };
    const plan = await library.planCreateWorking({
      templateId: "scoped-execution",
      candidate: executed,
    });
    assert.deepEqual(plan.review.validationErrors, []);
    assert.equal(plan.content.executionStatus, "passed");
    assert.deepEqual(plan.content.validationState, executed.validationState);
    await library.applyCreateWorking(plan, "apply-scoped-execution");
    await library.applyPublish(
      await library.planPublish({ templateId: "scoped-execution" }),
      "publish-scoped-execution",
    );
    const published = (await library.listPublishedCandidates())[0]!;
    assert.equal(published.validationState.plotExecution.scope, "synthetic_data");
    assert.equal(published.validationState.upstreamWorkflow.status, "not_run");
    assert.equal(published.validationState.scientificValidation.status, "not_assessed");

    const conflict = pairedCandidate({ title: "Conflicting compatibility state" });
    conflict.executionStatus = "failed";
    conflict.validationState = {
      schema: VALIDATION_STATE_SCHEMA,
      plotExecution: { status: "not_run", scope: "unknown" },
      upstreamWorkflow: { status: "unknown" },
      scientificValidation: { status: "not_assessed" },
    };
    const conflictPlan = await library.planCreateWorking({
      templateId: "conflicting-state",
      candidate: conflict,
    });
    assert.ok(
      conflictPlan.review.validationErrors.some(
        (error) => error.code === "execution_status_conflicts_with_validation_state",
      ),
    );

    const incompleteUpstream = pairedCandidate({ title: "Incomplete upstream state" });
    incompleteUpstream.validationState = {
      schema: VALIDATION_STATE_SCHEMA,
      plotExecution: { status: "not_run", scope: "unknown" },
      upstreamWorkflow: { status: "partial" },
      scientificValidation: { status: "validated" },
    };
    const incompletePlan = await library.planCreateWorking({
      templateId: "incomplete-upstream",
      candidate: incompleteUpstream,
    });
    const incompleteCodes = new Set(
      incompletePlan.review.validationErrors.map((error) => error.code),
    );
    assert.equal(incompleteCodes.has("upstream_workflow_scope_required"), true);
    assert.equal(incompleteCodes.has("upstream_workflow_evidence_required"), true);
    assert.equal(incompleteCodes.has("scientific_validation_decision_source_required"), true);
    assert.equal(incompleteCodes.has("scientific_validation_assessment_required"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy execution projection remains conservative without mutating old content", async () => {
  assert.deepEqual(legacyValidationStateFromExecutionStatus("passed"), {
    schema: VALIDATION_STATE_SCHEMA,
    plotExecution: { status: "passed", scope: "unknown" },
    upstreamWorkflow: { status: "unknown" },
    scientificValidation: { status: "not_assessed" },
  });
  const projected = effectiveValidationState({
    executionStatus: "failed",
    assets: [
      {
        logicalPath: "evidence/legacy.txt",
        file: "assets/evidence/legacy.txt",
        role: "evidence",
        mediaType: "text/plain",
        bytes: 1,
        sha256: "a".repeat(64),
      },
    ],
  });
  assert.deepEqual(projected, {
    schema: VALIDATION_STATE_SCHEMA,
    plotExecution: {
      status: "failed",
      scope: "unknown",
      evidenceAssetPaths: ["evidence/legacy.txt"],
    },
    upstreamWorkflow: { status: "unknown" },
    scientificValidation: { status: "not_assessed" },
  });

  const { root, library } = await temporaryLibrary("sfl-legacy-content-");
  try {
    const plan = await library.planCreateWorking({
      templateId: "legacy-shape",
      candidate: pairedCandidate({ title: "Legacy-shaped content" }),
    });
    await library.applyCreateWorking(plan, "apply-legacy-shape");
    const contentFile = path.join(
      root,
      "store",
      "templates",
      "legacy-shape",
      "revisions",
      plan.content.revisionId,
      "content.json",
    );
    const content = JSON.parse(await fs.readFile(contentFile, "utf8")) as Record<string, unknown>;
    delete content.validationState;
    delete content.canonicalPreviewDecision;
    delete content.contentDigest;
    content.contentDigest = hash(canonicalJson(content));
    await fs.chmod(contentFile, 0o600);
    await fs.writeFile(contentFile, `${JSON.stringify(content, null, 2)}\n`);
    const seriesFile = path.join(root, "store", "templates", "legacy-shape", "series.json");
    const series = JSON.parse(await fs.readFile(seriesFile, "utf8")) as {
      workingHead: { contentDigest: string };
    };
    series.workingHead.contentDigest = String(content.contentDigest);
    await fs.writeFile(seriesFile, `${JSON.stringify(series, null, 2)}\n`);

    const loaded = await library.getContent(
      "legacy-shape",
      plan.content.revisionId,
      String(content.contentDigest),
    );
    assert.ok(loaded);
    assert.equal(loaded.validationState, undefined);
    assert.equal(loaded.canonicalPreviewDecision, undefined);
    assert.equal(effectiveValidationState(loaded).plotExecution.scope, "unknown");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("legacy Release restore projects validationState without changing source semantics", async () => {
  const { root, library } = await temporaryLibrary("sfl-legacy-restore-");
  try {
    const published = await publish(
      library,
      "legacy-release-restore",
      pairedCandidate({ title: "Legacy release restore" }),
      "legacy-release",
    );
    assert.ok(published.revisionId && published.releaseId && published.contentDigest);
    const templateDirectory = path.join(
      root,
      "store",
      "templates",
      "legacy-release-restore",
    );
    const contentFile = path.join(
      templateDirectory,
      "revisions",
      published.revisionId,
      "content.json",
    );
    const content = JSON.parse(await fs.readFile(contentFile, "utf8")) as Record<string, unknown>;
    delete content.validationState;
    delete content.canonicalPreviewDecision;
    delete content.contentDigest;
    const legacyContentDigest = hash(canonicalJson(content));
    content.contentDigest = legacyContentDigest;
    await fs.chmod(contentFile, 0o600);
    await fs.writeFile(contentFile, `${JSON.stringify(content, null, 2)}\n`);

    const releaseFile = path.join(
      templateDirectory,
      "releases",
      `${published.releaseId}.json`,
    );
    const release = JSON.parse(await fs.readFile(releaseFile, "utf8")) as Record<string, unknown>;
    release.contentDigest = legacyContentDigest;
    delete release.releaseDigest;
    release.releaseDigest = hash(canonicalJson(release));
    await fs.chmod(releaseFile, 0o600);
    await fs.writeFile(releaseFile, `${JSON.stringify(release, null, 2)}\n`);

    const seriesFile = path.join(templateDirectory, "series.json");
    const series = JSON.parse(await fs.readFile(seriesFile, "utf8")) as {
      publishedHead: { contentDigest: string };
    };
    series.publishedHead.contentDigest = legacyContentDigest;
    await fs.chmod(seriesFile, 0o600);
    await fs.writeFile(seriesFile, `${JSON.stringify(series, null, 2)}\n`);

    const restorePlan = await library.planRestoreRelease({
      templateId: "legacy-release-restore",
      releaseId: published.releaseId,
    });
    assert.equal(restorePlan.content.validationState?.plotExecution.status, "not_run");
    assert.equal(restorePlan.content.validationState?.plotExecution.scope, "unknown");
    assert.equal(restorePlan.content.canonicalPreviewDecision, undefined);
    const restored = await library.applyRestoreRelease(
      restorePlan,
      "apply-legacy-release-restore",
    );
    assert.equal(restored.revisionId, restorePlan.content.revisionId);

    const gatePlan = await library.planGateUpdate({
      templateId: "legacy-release-restore",
      decisions: [
        {
          gateId: "review-restored-release",
          decision: "resolved",
          note: "The user reviewed the restored legacy Release.",
        },
      ],
    });
    await library.applyGateUpdate(gatePlan, "resolve-legacy-restore-gate");
    const republishPlan = await library.planPublish({
      templateId: "legacy-release-restore",
    });
    const republished = await library.applyPublish(
      republishPlan,
      "republish-legacy-release-restore",
    );
    assert.equal(republished.revisionId, restorePlan.content.revisionId);
    assert.notEqual(republished.releaseId, published.releaseId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
