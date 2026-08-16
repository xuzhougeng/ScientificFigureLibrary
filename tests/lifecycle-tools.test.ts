import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withCrossRuntimeWriteLock } from "../src/cross-runtime-lock.ts";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";
import { registerLifecycleTools } from "../src/lifecycle-tools.ts";
import { VersionedTemplateLibrary } from "../src/versioned-library.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function records(value: unknown) {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

function toolText(value: unknown) {
  return records(record(value).content)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

async function startLifecycleClient(root: string, writesEnabled = true) {
  const library = writesEnabled
    ? new VersionedTemplateLibrary(root)
    : new VersionedTemplateLibrary({
        root,
        directorySource: "legacy-default",
        locatorPath: path.join(path.dirname(root), "locator.json"),
        configRevision: null,
        locatorDigest: null,
        writesEnabled: false,
        legacyDefault: true,
        contextKey: `unbound:${root}`,
      });
  const server = new McpServer({ name: "Lifecycle tools test", version: "0.5.0" });
  registerLifecycleTools({ server, currentLibrary: async () => library });
  const client = new Client({ name: "lifecycle-tools-test", version: "0.5.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, library };
}

async function startSwitchableLifecycleClient(initialLibrary: VersionedTemplateLibrary) {
  let library = initialLibrary;
  const server = new McpServer({ name: "Switchable lifecycle tools test", version: "0.5.0" });
  registerLifecycleTools({ server, currentLibrary: async () => library });
  const client = new Client({ name: "switchable-lifecycle-tools-test", version: "0.5.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    setLibrary(nextLibrary: VersionedTemplateLibrary) {
      library = nextLibrary;
    },
  };
}

test("core lifecycle registration omits Capture/project pins and missing confirmations are terminal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-tools-missing-"));
  const connection = await startLifecycleClient(path.join(root, "library"));
  try {
    const tools = await connection.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("figure_library_plan_working_revision"));
    assert.ok(names.includes("figure_library_preview_working_revision"));
    assert.ok(names.includes("figure_library_apply_publish_working_revision"));
    assert.ok(names.includes("figure_library_review_open"));
    const workingPreview = tools.tools.find(
      (tool) => tool.name === "figure_library_preview_working_revision",
    );
    const previewProperties = record(record(workingPreview?.inputSchema).properties);
    assert.deepEqual(Object.keys(previewProperties).sort(), [
      "contentDigest",
      "revisionId",
      "templateId",
    ]);
    assert.equal(names.some((name) => name.startsWith("figure_capture_")), false);
    assert.equal(names.some((name) => name.includes("project_use") || name === "figure_library_project_status"), false);

    const missing = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {},
    });
    assert.equal(missing.isError, undefined);
    const structured = record(missing.structuredContent);
    const outcome = record(structured.envelope);
    assert.equal(outcome.outcome, "needs_user_input");
    assert.equal(outcome.terminal, true);
    assert.equal(outcome.retrySameCall, false);
    assert.ok(Array.isArray(outcome.missingConfirmations));
    assert.ok(outcome.missingConfirmations.length > 0);
    assert.match(toolText(missing), /^OUTCOME: needs_user_input\nTERMINAL: true\nRETRY_SAME_CALL: false/mu);
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unbound lifecycle Apply is terminal and directs the Agent to bind the Library", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-tools-unbound-"));
  const source = path.join(root, "reference.png");
  await fs.writeFile(source, "unbound-reference");
  const connection = await startLifecycleClient(path.join(root, "legacy-default"), false);
  try {
    const planned = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {
        mode: "create",
        templateId: "unbound-reference",
        title: "Unbound reference",
        assetKind: "visual_reference",
        language: "none",
        codeStatus: "none",
        executionStatus: "not_run",
        visualAssets: [
          {
            assetId: "figure",
            sourcePath: source,
            visualRole: "source_reference",
            mediaType: "image/png",
          },
        ],
        primaryVisualAssetId: "figure",
        confirmations: {
          createOrUpdate: true,
          figureUnitBoundary: true,
          primaryPreview: true,
          assetKind: true,
          executionClaim: true,
          duplicateDecision: "create_new",
        },
      },
    });
    const plan = record(record(planned.structuredContent).plan);
    const applied = await connection.client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: {
        planDigest: plan.planDigest,
        operationId: "unbound-apply",
        expectedAction: plan.action,
        expectedTemplateId: plan.templateId,
        expectedSeriesDigest: plan.expectedSeriesDigest,
      },
    });
    const result = record(record(applied.structuredContent).envelope);
    assert.equal(result.outcome, "blocked");
    assert.equal(result.code, "library_binding_required");
    assert.equal(result.nextAction, "rebind_library");
    assert.equal(result.retrySameCall, false);
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("direct visual intake plans, applies, replays, and never publishes source paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-tools-direct-"));
  const libraryRoot = path.join(root, "library");
  const source = path.join(root, "uploaded-reference.png");
  await fs.writeFile(source, Buffer.from("verified-direct-intake-image"));
  const connection = await startLifecycleClient(libraryRoot);
  try {
    const planned = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {
        mode: "create",
        templateId: "direct-visual-reference",
        title: "Direct visual reference",
        description: "A user-confirmed visual-only Figure Unit.",
        assetKind: "visual_reference",
        language: "none",
        codeStatus: "none",
        executionStatus: "not_run",
        intake: {
          adapterId: "user-upload",
          sourceManifest: { schema: "test.user-upload.v1", sourceId: "fixture-1" },
        },
        visualAssets: [
          {
            assetId: "figure-1",
            sourcePath: source,
            visualRole: "source_reference",
            mediaType: "image/png",
          },
        ],
        primaryVisualAssetId: "figure-1",
        confirmations: {
          createOrUpdate: true,
          figureUnitBoundary: true,
          primaryPreview: true,
          assetKind: true,
          executionClaim: true,
          duplicateDecision: "create_new",
        },
      },
    });
    assert.equal(planned.isError, undefined);
    const plannedStructured = record(planned.structuredContent);
    assert.equal(record(plannedStructured.envelope).outcome, "needs_user_confirmation");
    const plan = record(plannedStructured.plan);
    assert.equal(plan.action, "create_working");
    assert.match(String(plan.planDigest), /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(plan).includes(source), false);
    assert.match(toolText(planned), /PLAN_DIGEST: [a-f0-9]{64}/u);

    const applyArguments = {
      planDigest: String(plan.planDigest),
      operationId: "apply-direct-visual-reference",
      expectedAction: "create_working",
      expectedTemplateId: "direct-visual-reference",
      expectedSeriesDigest: plan.expectedSeriesDigest,
    };
    const marker = (await ensureLibraryRootMarker(libraryRoot)).value;
    await withCrossRuntimeWriteLock(
      {
        root: libraryRoot,
        lockDirectory: path.join(libraryRoot, "locks", "write"),
        libraryId: marker.libraryId,
        operation: "test-held-lifecycle-writer",
      },
      async () => {
        const blocked = await connection.client.callTool({
          name: "figure_library_apply_working_revision",
          arguments: applyArguments,
        });
        const blockedEnvelope = record(record(blocked.structuredContent).envelope);
        assert.equal(blockedEnvelope.outcome, "blocked");
        assert.equal(blockedEnvelope.code, "library_busy");
        assert.equal(blockedEnvelope.nextAction, "stop_other_writers");
        assert.equal(blockedEnvelope.retrySameCall, false);
      },
    );
    const applied = await connection.client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: applyArguments,
    });
    assert.equal(applied.isError, undefined);
    assert.equal(record(record(applied.structuredContent).envelope).outcome, "applied");
    const appliedResult = record(record(applied.structuredContent).result);
    assert.equal(appliedResult.idempotentReplay, false);

    const replayed = await connection.client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: applyArguments,
    });
    assert.equal(record(record(replayed.structuredContent).envelope).outcome, "replayed");
    assert.equal(record(record(replayed.structuredContent).result).idempotentReplay, true);

    const series = await connection.library.getSeries("direct-visual-reference");
    assert.ok(series?.workingHead);
    const content = await connection.library.getContent(
      "direct-visual-reference",
      series.workingHead.revisionId,
      series.workingHead.contentDigest,
    );
    assert.ok(content);
    assert.equal(JSON.stringify(content).includes(source), false);
    assert.equal(content.assets[0]?.visualRole, "source_reference");
    assert.equal(content.executionStatus, "not_run");

    const review = await connection.client.callTool({
      name: "figure_library_review_open",
      arguments: { templateId: "direct-visual-reference" },
    });
    assert.equal(record(record(review.structuredContent).envelope).outcome, "ok");
    assert.match(toolText(review), /WORKING_REVISION: revision-/u);

    const contentFile = path.join(
      connection.library.templatesDirectory,
      "direct-visual-reference",
      "revisions",
      series.workingHead.revisionId,
      "content.json",
    );
    await fs.rename(contentFile, `${contentFile}.missing`);
    const missingContentReview = await connection.client.callTool({
      name: "figure_library_review_open",
      arguments: { templateId: "direct-visual-reference" },
    });
    assert.equal(
      record(record(missingContentReview.structuredContent).envelope).code,
      "review_read_failed",
    );
    assert.equal(record(record(missingContentReview.structuredContent).envelope).outcome, "blocked");

    const missingContentList = await connection.client.callTool({
      name: "figure_library_review_open",
      arguments: {},
    });
    assert.equal(record(record(missingContentList.structuredContent).envelope).code, "review_read_failed");
    assert.equal(record(record(missingContentList.structuredContent).envelope).outcome, "blocked");

    const replayWithoutContent = await connection.client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: applyArguments,
    });
    const replayWithoutContentEnvelope = record(
      record(replayWithoutContent.structuredContent).envelope,
    );
    assert.equal(replayWithoutContentEnvelope.code, "working_revision_apply_failed");
    assert.equal(replayWithoutContentEnvelope.outcome, "blocked");
    assert.equal(record(replayWithoutContent.structuredContent).reviewSummary, undefined);
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("direct plot-template intake preserves the user-confirmed code origin", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-tools-plot-"));
  const visual = path.join(root, "reference.png");
  const code = path.join(root, "plot.R");
  await fs.writeFile(visual, "reference");
  await fs.writeFile(code, "plot(1:3)\n");
  const connection = await startLifecycleClient(path.join(root, "library"));
  try {
    const planned = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {
        mode: "create",
        templateId: "direct-user-plot",
        title: "Direct user plot",
        assetKind: "plot_template",
        language: "R",
        codeStatus: "reviewed",
        executionStatus: "not_run",
        visualAssets: [
          {
            assetId: "source",
            sourcePath: visual,
            visualRole: "source_reference",
            mediaType: "image/png",
          },
        ],
        codeAssets: [
          {
            assetId: "code",
            sourcePath: code,
            language: "R",
            codeOrigin: "user_supplied",
          },
        ],
        primaryVisualAssetId: "source",
        canonicalCodeAssetId: "code",
        figureCodeLinks: [
          {
            visualAssetId: "source",
            codeAssetIds: ["code"],
            relationship: "user_supplied_pair",
            evidence: "The user supplied and confirmed this image/code pair.",
            confirmedBy: "user",
          },
        ],
        confirmations: {
          createOrUpdate: true,
          figureUnitBoundary: true,
          primaryPreview: true,
          assetKind: true,
          canonicalImplementation: true,
          codeRelationships: true,
          codeOrigin: true,
          executionClaim: true,
          duplicateDecision: "create_new",
        },
      },
    });
    const plan = record(record(planned.structuredContent).plan);
    assert.equal(record(record(planned.structuredContent).envelope).outcome, "needs_user_confirmation");

    const applied = await connection.client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: {
        planDigest: String(plan.planDigest),
        operationId: "apply-direct-user-plot",
        expectedAction: "create_working",
        expectedTemplateId: "direct-user-plot",
        expectedSeriesDigest: plan.expectedSeriesDigest,
      },
    });
    assert.equal(record(record(applied.structuredContent).envelope).outcome, "applied");

    const series = await connection.library.getSeries("direct-user-plot");
    assert.ok(series?.workingHead);
    const content = await connection.library.getContent(
      "direct-user-plot",
      series.workingHead.revisionId,
      series.workingHead.contentDigest,
    );
    assert.ok(content);
    const storedCode = content.assets.find((asset) => asset.role === "code");
    assert.equal(storedCode?.codeOrigin, "user_supplied");
    assert.equal(content.canonicalImplementation?.assetPath, storedCode?.logicalPath);
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("visual inference cannot be mislabeled as executed reproduction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-tools-inference-"));
  const visual = path.join(root, "reference.png");
  const code = path.join(root, "generated.R");
  await fs.writeFile(visual, "reference");
  await fs.writeFile(code, "plot(1:3)\n");
  const connection = await startLifecycleClient(path.join(root, "library"));
  try {
    const response = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {
        mode: "create",
        templateId: "invalid-inference-claim",
        title: "Invalid inference claim",
        assetKind: "plot_template",
        language: "R",
        codeStatus: "reviewed",
        executionStatus: "passed",
        visualAssets: [{ assetId: "source", sourcePath: visual, visualRole: "source_reference" }],
        codeAssets: [{ assetId: "code", sourcePath: code, language: "R", codeOrigin: "agent_generated" }],
        primaryVisualAssetId: "source",
        canonicalCodeAssetId: "code",
        figureCodeLinks: [
          {
            visualAssetId: "source",
            codeAssetIds: ["code"],
            relationship: "visual_inference",
            evidence: "The model inferred a scaffold from the visual reference.",
            confirmedBy: "user",
          },
        ],
        confirmations: {
          createOrUpdate: true,
          figureUnitBoundary: true,
          primaryPreview: true,
          assetKind: true,
          canonicalImplementation: true,
          codeRelationships: true,
          codeOrigin: true,
          executionClaim: true,
          duplicateDecision: "create_new",
        },
      },
    });
    assert.equal(response.isError, undefined);
    const outcome = record(record(response.structuredContent).envelope);
    assert.equal(outcome.outcome, "blocked");
    assert.equal(outcome.retrySameCall, false);
    assert.match(toolText(response), /visual_inference must remain scaffold\/not_run/u);
    assert.equal(await connection.library.getSeries("invalid-inference-claim"), undefined);
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Working plan preview, Apply, Publish, and Review preserve one truthful summary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-tools-truthful-"));
  const source = path.join(root, "uploaded-source.png");
  const rendered = path.join(root, "rendered-output.png");
  const code = path.join(root, "plot.R");
  const evidence = path.join(root, "run-evidence.txt");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await Promise.all([
    fs.writeFile(source, png),
    fs.writeFile(rendered, png),
    fs.writeFile(code, "plot(1:3)\n"),
    fs.writeFile(evidence, "synthetic plot execution passed\n"),
  ]);
  const connection = await startLifecycleClient(path.join(root, "library"));

  const workingArguments = (
    mode: "create" | "update",
    warningCode: string,
    title: string,
  ) => ({
    mode,
    templateId: "truthful-plot",
    title,
    assetKind: "plot_template",
    language: "R",
    codeStatus: "reviewed",
    executionStatus: "passed",
    visualAssets: [
      {
        assetId: "uploaded",
        sourcePath: source,
        visualRole: "source_reference",
        mediaType: "image/png",
      },
      {
        assetId: "rendered",
        sourcePath: rendered,
        visualRole: "rendered_output",
        mediaType: "image/png",
      },
    ],
    codeAssets: [
      {
        assetId: "code",
        sourcePath: code,
        language: "R",
        codeOrigin: "agent_generated",
      },
    ],
    evidenceAssets: [
      {
        assetId: "run-evidence",
        sourcePath: evidence,
        mediaType: "text/plain",
      },
    ],
    canonicalCodeAssetId: "code",
    figureCodeLinks: [
      {
        visualAssetId: "uploaded",
        codeAssetIds: ["code"],
        relationship: "adapted_from_template",
        evidence: "The user confirmed that this implementation was adapted from the uploaded source reference.",
        confirmedBy: "user",
      },
      {
        visualAssetId: "rendered",
        codeAssetIds: ["code"],
        relationship: "generated_output",
        evidence: "The rendered output was produced by this code during the recorded synthetic run.",
        confirmedBy: "user",
      },
    ],
    validationState: {
      schema: "figure-library.validation-state.v1",
      plotExecution: {
        status: "passed",
        scope: "synthetic_data",
        evidenceAssetIds: ["run-evidence"],
      },
      upstreamWorkflow: { status: "not_run" },
      scientificValidation: { status: "not_assessed" },
    },
    assessment: {
      warnings: [
        {
          code: warningCode,
          message: `Review warning ${warningCode}`,
          source: "agent",
        },
      ],
    },
    confirmations: {
      createOrUpdate: true,
      figureUnitBoundary: true,
      multiImageGrouping: true,
      assetKind: true,
      canonicalImplementation: true,
      codeRelationships: true,
      codeOrigin: true,
      executionClaim: true,
      duplicateDecision: mode === "create" ? "create_new" : "update_exact",
    },
  });

  try {
    const planned = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: workingArguments("create", "published-warning", "Truthful plot v1"),
    });
    const plannedStructured = record(planned.structuredContent);
    const plan = record(plannedStructured.plan);
    const selector = record(plannedStructured.previewSelector);
    assert.deepEqual(selector, record(plan.previewSelector));
    assert.equal(selector.templateId, "truthful-plot");
    assert.match(String(selector.revisionId), /^revision-/u);
    assert.match(String(selector.contentDigest), /^[a-f0-9]{64}$/u);

    const plannedSummary = record(plannedStructured.reviewSummary);
    assert.equal(plannedSummary.publishEligible, true);
    assert.equal(record(plannedSummary.canonicalPreviewDecision).reason, "default_uploaded_source");
    const plannedValidation = record(plannedSummary.validationState);
    assert.equal(record(plannedValidation.plotExecution).scope, "synthetic_data");
    assert.deepEqual(record(plannedValidation.plotExecution).evidenceAssetPaths, [
      "evidence/run-evidence.txt",
    ]);
    assert.equal(record(plannedValidation.upstreamWorkflow).status, "not_run");
    assert.equal(record(plannedValidation.scientificValidation).status, "not_assessed");

    const previewBeforeApply = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: selector,
    });
    const beforeStructured = record(previewBeforeApply.structuredContent);
    assert.equal(record(beforeStructured.envelope).code, "working_preview_ready");
    assert.equal(beforeStructured.selectorScope, "pending_plan");
    assert.equal(beforeStructured.visualRole, "source_reference");
    assert.equal(beforeStructured.canonicalPreview, "visuals/source/uploaded.png");
    assert.equal(
      records(record(previewBeforeApply).content).some((item) => item.type === "image"),
      true,
    );

    const staleBeforeApply = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: { ...selector, contentDigest: "0".repeat(64) },
    });
    const staleEnvelope = record(record(staleBeforeApply.structuredContent).envelope);
    assert.equal(staleEnvelope.outcome, "conflict");
    assert.equal(staleEnvelope.code, "working_revision_stale");

    const applied = await connection.client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: {
        planDigest: plan.planDigest,
        operationId: "apply-truthful-plot-v1",
        expectedAction: plan.action,
        expectedTemplateId: plan.templateId,
        expectedSeriesDigest: plan.expectedSeriesDigest,
      },
    });
    const appliedStructured = record(applied.structuredContent);
    assert.equal(record(appliedStructured.envelope).outcome, "applied");
    assert.deepEqual(appliedStructured.reviewSummary, plannedStructured.reviewSummary);

    const previewAfterApply = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: selector,
    });
    assert.equal(record(previewAfterApply.structuredContent).selectorScope, "working_head");

    const workingReviewResponse = await connection.client.callTool({
      name: "figure_library_review_open",
      arguments: { templateId: "truthful-plot" },
    });
    const workingReviewStructured = record(workingReviewResponse.structuredContent);
    assert.ok(workingReviewStructured.workingReview);
    assert.equal(workingReviewStructured.publishedReview, undefined);
    assert.deepEqual(workingReviewStructured.review, workingReviewStructured.workingReview);
    assert.match(toolText(workingReviewResponse), /WORKING_WARNINGS: published-warning/u);
    assert.match(toolText(workingReviewResponse), /PUBLISHED_WARNINGS: none/u);

    const publishPlanned = await connection.client.callTool({
      name: "figure_library_plan_publish_working_revision",
      arguments: { templateId: "truthful-plot" },
    });
    const publishPlanStructured = record(publishPlanned.structuredContent);
    const publishPlan = record(publishPlanStructured.plan);
    assert.deepEqual(publishPlanStructured.reviewSummary, plannedStructured.reviewSummary);

    const published = await connection.client.callTool({
      name: "figure_library_apply_publish_working_revision",
      arguments: {
        planDigest: publishPlan.planDigest,
        operationId: "publish-truthful-plot-v1",
        expectedTemplateId: publishPlan.templateId,
        expectedSeriesDigest: publishPlan.expectedSeriesDigest,
      },
    });
    const publishedStructured = record(published.structuredContent);
    assert.equal(record(publishedStructured.envelope).outcome, "applied");
    assert.deepEqual(publishedStructured.reviewSummary, plannedStructured.reviewSummary);

    const noWorking = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: selector,
    });
    const noWorkingEnvelope = record(record(noWorking.structuredContent).envelope);
    assert.equal(noWorkingEnvelope.outcome, "not_found");
    assert.equal(noWorkingEnvelope.code, "working_revision_not_found");

    const publishedReviewResponse = await connection.client.callTool({
      name: "figure_library_review_open",
      arguments: { templateId: "truthful-plot" },
    });
    const publishedReviewStructured = record(publishedReviewResponse.structuredContent);
    assert.equal(publishedReviewStructured.workingReview, undefined);
    assert.ok(publishedReviewStructured.publishedReview);
    assert.deepEqual(publishedReviewStructured.review, publishedReviewStructured.publishedReview);
    assert.match(toolText(publishedReviewResponse), /PUBLISHED_WARNINGS: published-warning/u);
    assert.match(toolText(publishedReviewResponse), /REVIEW_WARNINGS: published-warning/u);

    const obsoletePlanResponse = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: workingArguments("update", "obsolete-warning", "Truthful plot v2 draft"),
    });
    const obsoletePlanStructured = record(obsoletePlanResponse.structuredContent);
    const obsoletePlan = record(obsoletePlanStructured.plan);
    const obsoleteSelector = record(obsoletePlanStructured.previewSelector);
    const updatePlanned = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: workingArguments("update", "working-warning", "Truthful plot v2"),
    });
    const updatePlanStructured = record(updatePlanned.structuredContent);
    const updateSelector = record(updatePlanStructured.previewSelector);
    const obsoletePreview = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: obsoleteSelector,
    });
    assert.equal(
      record(record(obsoletePreview.structuredContent).envelope).code,
      "working_revision_stale",
    );
    const updatePreview = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: updateSelector,
    });
    assert.equal(record(updatePreview.structuredContent).selectorScope, "pending_plan");

    const obsoleteApplied = await connection.client.callTool({
      name: "figure_library_apply_working_revision",
      arguments: {
        planDigest: obsoletePlan.planDigest,
        operationId: "apply-obsolete-truthful-plot-v2",
        expectedAction: obsoletePlan.action,
        expectedTemplateId: obsoletePlan.templateId,
        expectedSeriesDigest: obsoletePlan.expectedSeriesDigest,
      },
    });
    assert.equal(record(record(obsoleteApplied.structuredContent).envelope).outcome, "applied");
    const pendingAfterSeriesChange = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: updateSelector,
    });
    const pendingAfterSeriesChangeEnvelope = record(
      record(pendingAfterSeriesChange.structuredContent).envelope,
    );
    assert.equal(pendingAfterSeriesChangeEnvelope.outcome, "conflict");
    assert.equal(pendingAfterSeriesChangeEnvelope.code, "working_revision_stale");

    const dualReviewResponse = await connection.client.callTool({
      name: "figure_library_review_open",
      arguments: { templateId: "truthful-plot" },
    });
    const dual = record(dualReviewResponse.structuredContent);
    const workingReview = record(dual.workingReview);
    const publishedReview = record(dual.publishedReview);
    assert.notEqual(workingReview.reviewId, publishedReview.reviewId);
    assert.deepEqual(dual.review, dual.workingReview);
    assert.equal(record(records(workingReview.warnings)[0]).code, "obsolete-warning");
    assert.equal(record(records(publishedReview.warnings)[0]).code, "published-warning");
    assert.match(toolText(dualReviewResponse), /WORKING_WARNINGS: obsolete-warning/u);
    assert.match(toolText(dualReviewResponse), /PUBLISHED_WARNINGS: published-warning/u);

    const publishedReleasePlan = record(publishPlan.release);
    const publishedReviewFile = path.join(
      connection.library.templatesDirectory,
      "truthful-plot",
      "reviews",
      `${publishedReleasePlan.reviewId}.json`,
    );
    await fs.rename(publishedReviewFile, `${publishedReviewFile}.missing`);
    const replayWithoutReview = await connection.client.callTool({
      name: "figure_library_apply_publish_working_revision",
      arguments: {
        planDigest: publishPlan.planDigest,
        operationId: "publish-truthful-plot-v1",
        expectedTemplateId: publishPlan.templateId,
        expectedSeriesDigest: publishPlan.expectedSeriesDigest,
      },
    });
    const replayWithoutReviewEnvelope = record(
      record(replayWithoutReview.structuredContent).envelope,
    );
    assert.equal(replayWithoutReviewEnvelope.outcome, "blocked");
    assert.equal(replayWithoutReviewEnvelope.code, "lifecycle_apply_failed");
    assert.equal(record(replayWithoutReview.structuredContent).reviewSummary, undefined);
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Working preview returns stable not-found and invalid-image outcomes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-tools-preview-errors-"));
  const connection = await startLifecycleClient(path.join(root, "library"));
  const corrupt = path.join(root, "corrupt.png");
  const unsupported = path.join(root, "unsupported.svg");
  await fs.writeFile(corrupt, "not a PNG");
  await fs.writeFile(unsupported, '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');

  async function planVisual(templateId: string, sourcePath: string, mediaType: string) {
    const planned = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {
        mode: "create",
        templateId,
        title: templateId,
        assetKind: "visual_reference",
        language: "none",
        codeStatus: "none",
        executionStatus: "not_run",
        visualAssets: [
          {
            assetId: "visual",
            sourcePath,
            visualRole: "source_reference",
            mediaType,
          },
        ],
        confirmations: {
          createOrUpdate: true,
          figureUnitBoundary: true,
          assetKind: true,
          executionClaim: true,
          duplicateDecision: "create_new",
        },
      },
    });
    const structured = record(planned.structuredContent);
    assert.equal(record(structured.envelope).outcome, "needs_user_confirmation");
    return { plan: record(structured.plan), selector: record(structured.previewSelector) };
  }

  try {
    const absent = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: {
        templateId: "absent-template",
        revisionId: "revision-absent",
        contentDigest: "0".repeat(64),
      },
    });
    const absentEnvelope = record(record(absent.structuredContent).envelope);
    assert.equal(absentEnvelope.outcome, "not_found");
    assert.equal(absentEnvelope.code, "template_not_found");

    for (const fixture of [
      {
        templateId: "corrupt-working-preview",
        sourcePath: corrupt,
        mediaType: "image/png",
      },
      {
        templateId: "unsupported-working-preview",
        sourcePath: unsupported,
        mediaType: "image/svg+xml",
      },
    ]) {
      const { plan, selector } = await planVisual(
        fixture.templateId,
        fixture.sourcePath,
        fixture.mediaType,
      );
      const pendingPreview = await connection.client.callTool({
        name: "figure_library_preview_working_revision",
        arguments: selector,
      });
      const pendingEnvelope = record(record(pendingPreview.structuredContent).envelope);
      assert.equal(pendingEnvelope.outcome, "blocked");
      assert.equal(pendingEnvelope.code, "working_preview_unavailable");

      const applied = await connection.client.callTool({
        name: "figure_library_apply_working_revision",
        arguments: {
          planDigest: plan.planDigest,
          operationId: `apply-${fixture.templateId}`,
          expectedAction: plan.action,
          expectedTemplateId: plan.templateId,
          expectedSeriesDigest: plan.expectedSeriesDigest,
        },
      });
      assert.equal(record(record(applied.structuredContent).envelope).outcome, "applied");

      const storedPreview = await connection.client.callTool({
        name: "figure_library_preview_working_revision",
        arguments: selector,
      });
      const storedEnvelope = record(record(storedPreview.structuredContent).envelope);
      assert.equal(storedEnvelope.outcome, "blocked");
      assert.equal(storedEnvelope.code, "working_preview_unavailable");
    }
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pending Working preview becomes stale after the bound Library changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-tools-rebind-"));
  const source = path.join(root, "reference.png");
  await fs.writeFile(
    source,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const snapshot = (name: string, configRevision: number) => ({
    root: path.join(root, name),
    directorySource: "locator" as const,
    locatorPath: path.join(root, `${name}-locator.json`),
    configRevision,
    locatorDigest: name.repeat(64).slice(0, 64),
    libraryId: `${name}-library-id`,
    writesEnabled: true,
    legacyDefault: false,
    contextKey: `locator:${name}:${configRevision}`,
  });
  const libraryA = new VersionedTemplateLibrary(snapshot("a", 1));
  const libraryB = new VersionedTemplateLibrary(snapshot("b", 2));
  const connection = await startSwitchableLifecycleClient(libraryA);
  try {
    const planned = await connection.client.callTool({
      name: "figure_library_plan_working_revision",
      arguments: {
        mode: "create",
        templateId: "rebound-preview",
        title: "Rebound preview",
        assetKind: "visual_reference",
        language: "none",
        codeStatus: "none",
        executionStatus: "not_run",
        visualAssets: [
          {
            assetId: "source",
            sourcePath: source,
            visualRole: "source_reference",
            mediaType: "image/png",
          },
        ],
        confirmations: {
          createOrUpdate: true,
          figureUnitBoundary: true,
          assetKind: true,
          executionClaim: true,
          duplicateDecision: "create_new",
        },
      },
    });
    const selector = record(record(planned.structuredContent).previewSelector);
    const beforeRebind = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: selector,
    });
    assert.equal(record(beforeRebind.structuredContent).selectorScope, "pending_plan");

    connection.setLibrary(libraryB);
    const afterRebind = await connection.client.callTool({
      name: "figure_library_preview_working_revision",
      arguments: selector,
    });
    const envelope = record(record(afterRebind.structuredContent).envelope);
    assert.equal(envelope.outcome, "conflict");
    assert.equal(envelope.code, "working_revision_stale");
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
