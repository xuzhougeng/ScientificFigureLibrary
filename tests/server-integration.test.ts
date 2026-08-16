import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureLibraryRootMarker, readLibraryRootMarker } from "../src/library-runtime.ts";
import { FIGUREYA_PROVIDER_ID, LOCAL_LIBRARY_PROVIDER_ID } from "../src/providers.ts";
import { createServer } from "../src/server.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

const STANDARD_TOOLS = [
  "figure_library_apply_adopt_versioning",
  "figure_library_apply_bind_global",
  "figure_library_apply_bind_workspace",
  "figure_library_apply_bundle_export",
  "figure_library_apply_discard_working_revision",
  "figure_library_apply_full_restore",
  "figure_library_apply_materialize",
  "figure_library_apply_publish_working_revision",
  "figure_library_apply_recover_write_lock",
  "figure_library_apply_restore_release",
  "figure_library_apply_review_gate_update",
  "figure_library_apply_template_bundle_import",
  "figure_library_apply_working_revision",
  "figure_library_confirm_selection",
  "figure_library_confirm_selection_headless",
  "figure_library_describe",
  "figure_library_diff_revisions",
  "figure_library_export_diagnostics",
  "figure_library_open",
  "figure_library_plan_adopt_versioning",
  "figure_library_plan_bind_global",
  "figure_library_plan_bind_workspace",
  "figure_library_plan_bundle_export",
  "figure_library_plan_discard_working_revision",
  "figure_library_plan_full_restore",
  "figure_library_plan_materialize",
  "figure_library_plan_publish_working_revision",
  "figure_library_plan_recover_write_lock",
  "figure_library_plan_restore_release",
  "figure_library_plan_review_gate_update",
  "figure_library_plan_template_bundle_import",
  "figure_library_plan_working_revision",
  "figure_library_preview",
  "figure_library_preview_exact",
  "figure_library_preview_exact_headless",
  "figure_library_preview_working_revision",
  "figure_library_record_ui_event",
  "figure_library_review_open",
  "figure_library_search",
  "figure_library_search_page",
  "figure_library_source_status",
  "figure_library_template_history",
] as const;

function assertTerminalEnvelope(value: unknown, toolName: string) {
  const envelope = record(record(record(value).structuredContent).envelope);
  assert.equal(envelope.schema, "figure-library.tool-outcome.v1", toolName);
  assert.equal(envelope.terminal, true, toolName);
  assert.equal(envelope.retrySameCall, false, toolName);
  assert.equal(typeof envelope.code, "string", toolName);
  assert.equal(typeof envelope.nextAction, "string", toolName);
  const text = toolText(value);
  assert.match(text, /^OUTCOME: .+\nTERMINAL: true\nRETRY_SAME_CALL: false/mu, toolName);
  assert.match(text, /^CODE: .+$/mu, toolName);
  assert.match(text, /^NEXT_ACTION: .+$/mu, toolName);
}

function candidate(title: string): VersionedTemplateCandidate {
  return {
    title,
    description: "crossprovideruniquemarker differential expression volcano reference",
    tags: ["crossprovideruniquemarker", "volcano", "differential-expression"],
    visualProfile: "volcano scatter x log2 fold change y negative log10 adjusted p value",
    dataProfile: "gene log2FC pvalue padj",
    packages: ["ggplot2"],
    license: "reference only",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "volcano",
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
        bytes: ONE_PIXEL_PNG,
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

test("standard server unifies Local Published and FigureYa while hiding Working/legacy/Capture", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-server-integration-"));
  const libraryRoot = path.join(root, "library");
  const previousLibraryDirectory = process.env.FIGURE_LIBRARY_DIR;
  try {
    await ensureLibraryRootMarker(libraryRoot);
    const library = new VersionedTemplateLibrary(libraryRoot);
    const publishedPlan = await library.planCreateWorking({
      templateId: "local-published-volcano",
      candidate: candidate("Local crossprovideruniquemarker volcano"),
      assessment: {
        warnings: [
          {
            code: "upstream_workflow_not_run",
            message: "Published immutable Review warning: upstream workflow was not run.",
            source: "agent",
          },
        ],
      },
    });
    await library.applyCreateWorking(publishedPlan, "server-local-working");
    await library.applyPublish(
      await library.planPublish({ templateId: "local-published-volcano" }),
      "server-local-publish",
    );
    for (let index = 1; index <= 3; index += 1) {
      const templateId = `zz-local-pagination-${index}`;
      await library.applyCreateWorking(
        await library.planCreateWorking({
          templateId,
          candidate: candidate(`Local pagination ${index} crossprovideruniquemarker volcano`),
        }),
        `server-pagination-working-${index}`,
      );
      await library.applyPublish(
        await library.planPublish({ templateId }),
        `server-pagination-publish-${index}`,
      );
    }
    const hiddenWorking = await library.planCreateWorking({
      templateId: "hidden-working-volcano",
      candidate: candidate("Working crossprovideruniquemarker volcano must stay hidden"),
    });
    await library.applyCreateWorking(hiddenWorking, "server-hidden-working");
    await fs.mkdir(path.join(libraryRoot, "templates", "hidden-legacy-flat"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(libraryRoot, "templates", "hidden-legacy-flat", "template.json"),
      `${JSON.stringify({
        schema: "figure-library.template.v1",
        templateId: "hidden-legacy-flat",
        title: "Legacy crossprovideruniquemarker volcano must stay hidden",
      })}\n`,
    );

    process.env.FIGURE_LIBRARY_DIR = libraryRoot;
    const server = await createServer();
    // Simulate an Apps-capable Host such as Wisp. The iframe-level Host may
    // still omit serverTools, so updateModelContext must be able to hand the
    // selected candidate to the model-visible headless preview/confirm tools.
    const client = new Client(
      { name: "server-integration-test", version: "0.5.3" },
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
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      const nameSet = new Set<string>(names);
      assert.deepEqual(names, [...STANDARD_TOOLS]);
      assert.ok(names.includes("figure_library_search"));
      assert.ok(names.includes("figure_library_plan_materialize"));
      assert.ok(names.includes("figure_library_plan_bundle_export"));
      for (const [toolName, visibility] of [
        ["figure_library_search", "model"],
        ["figure_library_search_page", "app"],
        ["figure_library_preview_exact", "app"],
        ["figure_library_preview_exact_headless", "model"],
        ["figure_library_record_ui_event", "app"],
        ["figure_library_export_diagnostics", "model"],
      ] as const) {
        const tool = listed.tools.find((candidate) => candidate.name === toolName);
        assert.ok(tool, `missing ${toolName}`);
        assert.deepEqual(record(record(tool._meta).ui).visibility, [visibility]);
      }
      assert.equal(names.some((name) => name.startsWith("figure_capture_")), false);
      for (const forbidden of [
        "figure_library_project_status",
        "figure_library_plan_project_use",
        "figure_library_apply_project_use",
      ]) {
        assert.equal(nameSet.has(forbidden), false, `forbidden standard-core tool ${forbidden}`);
      }

      const opened = await client.callTool({
        name: "figure_library_open",
        arguments: {},
      });
      const openedStructured = record(opened.structuredContent);
      const openedEnvelope = record(openedStructured.envelope);
      assert.equal(openedEnvelope.schema, "figure-library.tool-outcome.v1");
      assert.equal(openedEnvelope.terminal, true);
      assert.equal(openedEnvelope.retrySameCall, false);
      assert.equal(openedEnvelope.nextAction, "ask_user");
      assert.match(toolText(opened), /OUTCOME: ok[\s\S]*TERMINAL: true/u);
      assert.ok(Array.isArray(openedStructured.candidates));

      const searched = await client.callTool({
        name: "figure_library_search",
        arguments: {
          query: "crossprovideruniquemarker volcano differential expression",
          dataProfile: "gene log2FC pvalue padj",
          limit: 6,
        },
      });
      assert.equal(searched.isError, undefined);
      const searchedStructured = record(searched.structuredContent);
      const searchedEnvelope = record(searchedStructured.envelope);
      assert.equal(searchedEnvelope.schema, "figure-library.tool-outcome.v1");
      assert.equal(searchedEnvelope.terminal, true);
      assert.equal(searchedEnvelope.retrySameCall, false);
      assert.equal(searchedEnvelope.nextAction, "ask_user");
      const candidates = records(searchedStructured.candidates);
      assert.doesNotMatch(JSON.stringify(searchedStructured), /data:image\//u);
      const providers = new Set(candidates.map((item) => item.providerId));
      assert.ok(providers.has(LOCAL_LIBRARY_PROVIDER_ID));
      assert.ok(providers.has(FIGUREYA_PROVIDER_ID));
      assert.ok(candidates.some((item) => item.templateId === "local-published-volcano"));
      assert.equal(candidates.some((item) => item.templateId === "hidden-working-volcano"), false);
      assert.equal(candidates.some((item) => item.templateId === "hidden-legacy-flat"), false);
      assert.ok(
        candidates.every(
          (item) => record(item.exactSelector).providerId === item.providerId,
        ),
      );
      const localThumbnail = candidates.find(
        (item) => item.templateId === "local-published-volcano",
      );
      assert.ok(localThumbnail);
      assert.equal(localThumbnail.previewStatus, "ready");
      assert.equal(localThumbnail.previewDataUrl, undefined);
      assert.equal(localThumbnail.previewMimeType, "image/png");
      assert.equal(localThumbnail.previewByteLength, ONE_PIXEL_PNG.byteLength);
      assert.match(String(localThumbnail.previewSha256), /^[a-f0-9]{64}$/u);
      assert.equal(typeof localThumbnail.candidateId, "string");
      assert.deepEqual(localThumbnail.warnings, [
        "Published immutable Review warning: upstream workflow was not run.",
      ]);
      const localValidationState = record(localThumbnail.validationState);
      assert.equal(localValidationState.schema, "figure-library.validation-state.v1");
      assert.deepEqual(record(localValidationState.plotExecution), {
        status: "not_run",
        scope: "unknown",
      });
      assert.deepEqual(record(localValidationState.upstreamWorkflow), { status: "unknown" });
      assert.deepEqual(record(localValidationState.scientificValidation), {
        status: "not_assessed",
      });
      assert.deepEqual(record(localThumbnail.canonicalPreviewDecision), {
        assetPath: "visuals/source/preview.png",
        reason: "default_uploaded_source",
        selectedBy: "policy",
      });
      const figureYaCandidate = candidates.find(
        (item) => item.providerId === FIGUREYA_PROVIDER_ID,
      );
      assert.ok(figureYaCandidate);
      const figureYaValidationState = record(figureYaCandidate.validationState);
      assert.deepEqual(record(figureYaValidationState.plotExecution), {
        status: "not_run",
        scope: "unknown",
      });
      assert.deepEqual(record(figureYaValidationState.upstreamWorkflow), {
        status: "unknown",
      });
      assert.deepEqual(record(figureYaValidationState.scientificValidation), {
        status: "not_assessed",
      });
      const searchedMeta = record(record(searched)._meta);
      const candidatePreviews = record(searchedMeta.candidatePreviews);
      const localPreview = record(candidatePreviews[String(localThumbnail.candidateId)]);
      assert.match(String(localPreview.previewDataUrl), /^data:image\/png;base64,/u);
      assert.equal(localPreview.previewMimeType, "image/png");
      assert.equal(localPreview.previewByteLength, ONE_PIXEL_PNG.byteLength);
      assert.match(String(localPreview.previewSha256), /^[a-f0-9]{64}$/u);
      const pagination = record(searchedStructured.pagination);
      assert.equal(pagination.pageIndex, 1);
      assert.equal(pagination.pageSize, 6);
      assert.ok(Number(pagination.total) > candidates.length);
      assert.equal(pagination.hasMore, true);
      assert.equal(typeof pagination.nextCursor, "string");
      assert.equal(typeof searchedStructured.resultSetId, "string");
      assert.equal(searchedStructured.total, pagination.total);
      assert.equal(searchedStructured.pageIndex, pagination.pageIndex);
      assert.equal(searchedStructured.hasMore, pagination.hasMore);
      assert.equal(searchedStructured.nextCursor, pagination.nextCursor);
      const secondPage = await client.callTool({
        name: "figure_library_search_page",
        arguments: {
          resultSetId: searchedStructured.resultSetId,
          cursor: pagination.nextCursor,
        },
      });
      const secondStructured = record(secondPage.structuredContent);
      const secondPagination = record(secondStructured.pagination);
      const secondCandidates = records(secondStructured.candidates);
      assert.equal(secondStructured.resultSetId, searchedStructured.resultSetId);
      assert.equal(secondPagination.pageIndex, 2);
      assert.equal(secondPagination.total, pagination.total);
      assert.ok(secondCandidates.length > 0);
      const firstKeys = new Set(candidates.map((item) => `${item.providerId}:${item.templateId}`));
      assert.ok(
        secondCandidates.every(
          (item) => !firstKeys.has(`${String(item.providerId)}:${String(item.templateId)}`),
        ),
      );
      assert.ok(
        records(searchedStructured.sources).some(
          (item) => item.providerId === LOCAL_LIBRARY_PROVIDER_ID && Number(item.matched) >= 1,
        ),
      );
      assert.ok(
        records(searchedStructured.sources).some(
          (item) => item.providerId === FIGUREYA_PROVIDER_ID && Number(item.matched) >= 1,
        ),
      );
      assert.match(toolText(searched), /EXACT_SELECTOR:/u);
      assert.match(toolText(searched), /plotExecution=not_run \(scope=unknown\)/u);
      assert.match(toolText(searched), /upstreamWorkflow=unknown/u);
      assert.match(toolText(searched), /scientificValidation=not_assessed/u);
      assert.match(toolText(searched), /CANONICAL_PREVIEW: default_uploaded_source/u);
      assert.match(
        toolText(searched),
        /Published immutable Review warning: upstream workflow was not run\./u,
      );
      assert.match(toolText(searched), /NEXT_ACTION: ask_user/u);
      assert.doesNotMatch(toolText(searched), /data:image\//u);

      const localCandidate = candidates.find(
        (item) => item.templateId === "local-published-volcano",
      )!;
      const preview = await client.callTool({
        name: "figure_library_preview",
        arguments: {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: localCandidate.exactSelector,
        },
      });
      const imageBlocks = records(record(preview).content).filter(
        (block) => block.type === "image",
      );
      assert.equal(imageBlocks.length, 1);
      assert.equal(imageBlocks[0]?.mimeType, "image/png");
      assert.equal(
        Buffer.from(String(imageBlocks[0]?.data), "base64").subarray(0, 8).toString("hex"),
        ONE_PIXEL_PNG.subarray(0, 8).toString("hex"),
      );

      const exactPreview = await client.callTool({
        name: "figure_library_preview_exact_headless",
        arguments: {
          resultSetId: searchedStructured.resultSetId,
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: localCandidate.exactSelector,
        },
      });
      assert.equal(record(record(exactPreview.structuredContent).envelope).code, "exact_preview_ready");
      assert.equal(
        records(record(exactPreview).content).filter((block) => block.type === "image").length,
        1,
      );
      const exactStructured = record(exactPreview.structuredContent);
      assert.match(String(exactStructured.previewSha256 ?? exactStructured.sha256), /^[a-f0-9]{64}$/u);
      const destination = path.join(root, "confirmation-only-materialization");
      const withoutReceipt = await client.callTool({
        name: "figure_library_plan_materialize",
        arguments: {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: localCandidate.exactSelector,
          destination,
          allowNetwork: false,
        },
      });
      assert.equal(record(record(withoutReceipt.structuredContent).envelope).code, "preview_required");
      const headlessConfirmation = await client.callTool({
        name: "figure_library_confirm_selection_headless",
        arguments: { previewChallenge: exactStructured.previewChallenge },
      });
      const headlessStructured = record(headlessConfirmation.structuredContent);
      assert.equal(record(headlessStructured.envelope).code, "preview_confirmed_headless");
      assert.equal(headlessStructured.confirmationMode, "headless");
      const plannedAfterHeadlessConfirmation = await client.callTool({
        name: "figure_library_plan_materialize",
        arguments: {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: localCandidate.exactSelector,
          previewReceipt: headlessStructured.previewReceipt,
          destination,
          allowNetwork: false,
        },
      });
      assert.equal(
        record(record(plannedAfterHeadlessConfirmation.structuredContent).envelope).code,
        "materialization_plan_ready",
      );
      assert.equal(
        record(record(plannedAfterHeadlessConfirmation.structuredContent).plan).schema,
        "figure-library.materialization-plan.v2",
      );
      const replayedReceipt = await client.callTool({
        name: "figure_library_plan_materialize",
        arguments: {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: localCandidate.exactSelector,
          previewReceipt: headlessStructured.previewReceipt,
          destination: path.join(root, "receipt-replay"),
          allowNetwork: false,
        },
      });
      assert.equal(record(record(replayedReceipt.structuredContent).envelope).code, "preview_receipt_used");

      const appExactPreview = await client.callTool({
        name: "figure_library_preview_exact",
        arguments: {
          resultSetId: searchedStructured.resultSetId,
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: localCandidate.exactSelector,
        },
      });
      assert.equal(
        records(record(appExactPreview).content).filter((block) => block.type === "image").length,
        0,
      );
      const appExactMeta = record(record(record(appExactPreview)._meta).exactPreview);
      assert.match(String(appExactMeta.previewDataUrl), /^data:image\/png;base64,/u);
      assert.equal(typeof appExactMeta.previewChallenge, "string");
      const uiEvent = await client.callTool({
        name: "figure_library_record_ui_event",
        arguments: {
          event: "exact_preview.image_loaded",
          resultSetId: searchedStructured.resultSetId,
          candidateId: localCandidate.candidateId,
          previewBytes: ONE_PIXEL_PNG.byteLength,
        },
      });
      const appConfirmation = await client.callTool({
        name: "figure_library_confirm_selection",
        arguments: {
          previewChallenge: appExactMeta.previewChallenge,
        },
      });
      const appConfirmationStructured = record(appConfirmation.structuredContent);
      assert.equal(appConfirmationStructured.confirmationMode, "app");
      const plannedAfterAppConfirmation = await client.callTool({
        name: "figure_library_plan_materialize",
        arguments: {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: localCandidate.exactSelector,
          previewReceipt: appConfirmationStructured.previewReceipt,
          destination: path.join(root, "app-confirmation-only-materialization"),
          allowNetwork: false,
        },
      });
      assert.equal(
        record(record(plannedAfterAppConfirmation.structuredContent).envelope).code,
        "materialization_plan_ready",
      );

      await library.applyCreateWorking(
        await library.planCreateWorking({
          templateId: "zz-local-pagination-stale",
          candidate: candidate("Local stale cursor crossprovideruniquemarker volcano"),
        }),
        "server-stale-cursor-working",
      );
      await library.applyPublish(
        await library.planPublish({ templateId: "zz-local-pagination-stale" }),
        "server-stale-cursor-publish",
      );
      const stalePage = await client.callTool({
        name: "figure_library_search_page",
        arguments: {
          resultSetId: searchedStructured.resultSetId,
          cursor: pagination.nextCursor,
        },
      });
      assert.equal(
        record(record(stalePage.structuredContent).envelope).code,
        "search_results_stale",
      );

      const describedLocal = await client.callTool({
        name: "figure_library_describe",
        arguments: {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: localCandidate.exactSelector,
        },
      });
      const describedLocalStructured = record(describedLocal.structuredContent);
      assert.equal(describedLocalStructured.materializationProtocolVersion, 2);
      const describedReview = record(describedLocalStructured.review);
      assert.deepEqual(
        records(describedReview.warnings).map((warning) => warning.message),
        ["Published immutable Review warning: upstream workflow was not run."],
      );
      assert.deepEqual(
        record(describedLocalStructured.validationState),
        localValidationState,
      );
      assert.deepEqual(
        record(describedLocalStructured.canonicalPreviewDecision),
        record(localThumbnail.canonicalPreviewDecision),
      );
      assert.match(toolText(describedLocal), /PLOT_EXECUTION_STATUS: not_run/u);
      assert.match(toolText(describedLocal), /UPSTREAM_WORKFLOW_STATUS: unknown/u);
      assert.match(toolText(describedLocal), /SCIENTIFIC_VALIDATION_STATUS: not_assessed/u);
      assert.match(toolText(describedLocal), /default_uploaded_source/u);
      assert.match(
        toolText(describedLocal),
        /REVIEW_WARNINGS: Published immutable Review warning: upstream workflow was not run\./u,
      );
      assert.deepEqual(record(describedLocalStructured.previewConfirmationCapabilities), {
        app: true,
        headless: true,
        receiptRequired: true,
        appPaginationTool: "figure_library_search_page",
        appExactPreviewTool: "figure_library_preview_exact",
        headlessExactPreviewTool: "figure_library_preview_exact_headless",
        updateModelContextFallback: true,
        fallbackHandoffMode: "headless_exact_review",
        fallbackCandidateLimit: 1,
        modelVisibleSearchIncludesImageData: false,
        componentThumbnailMetaKey: "candidatePreviews",
      });
      assert.deepEqual(record(describedLocalStructured.diagnosticsExportCapabilities), {
        exportTool: "figure_library_export_diagnostics",
        defaultScope: "current_session",
        defaultDetail: "sanitized_bundle",
        resourceUriTemplate: "figure-library://diagnostics/{bundleId}",
        sessionBound: true,
      });

      const status = await client.callTool({
        name: "figure_library_source_status",
        arguments: {},
      });
      const statusStructured = record(status.structuredContent);
      assert.equal(statusStructured.serverVersion, "0.5.4");
      const libraryStatus = record(statusStructured.library);
      const marker = await readLibraryRootMarker(libraryRoot);
      assert.ok(marker);
      assert.equal(libraryStatus.root, libraryRoot);
      assert.equal(libraryStatus.directorySource, "FIGURE_LIBRARY_DIR");
      assert.equal(libraryStatus.libraryId, marker.value.libraryId);
      assert.equal(libraryStatus.publishedCount, 5);
      assert.equal(libraryStatus.workingCount, 1);
      assert.equal(libraryStatus.legacyFlatCount, 1);
      const standardCore = record(statusStructured.standardCore);
      assert.equal(standardCore.directIntake, true);
      assert.equal(standardCore.captureToolsRegistered, false);
      assert.equal(standardCore.projectPinToolsRegistered, false);
      assert.equal(standardCore.flatEntriesInOrdinarySearch, false);
      const text = toolText(status);
      for (const field of [
        "SERVER_VERSION: 0.5.4",
        `LIBRARY_ROOT: ${libraryRoot}`,
        `LIBRARY_ID: ${marker.value.libraryId}`,
        "PUBLISHED: 5",
        "WORKING: 1",
        "LEGACY_FLAT: 1",
        "FIGUREYA_CATALOG:",
        "CAPTURE_TOOLS_REGISTERED: false",
        "PROJECT_PIN_TOOLS_REGISTERED: false",
      ]) {
        assert.ok(text.includes(field), `status text omitted ${field}`);
      }

      const diagnosticsExport = await client.callTool({
        name: "figure_library_export_diagnostics",
        arguments: {},
      });
      assert.equal(
        record(record(diagnosticsExport.structuredContent).envelope).code,
        "diagnostics_exported",
      );
      const diagnosticsStructured = record(diagnosticsExport.structuredContent);
      assert.match(String(diagnosticsStructured.bundleId), /^diagnostics-/u);
      assert.match(String(diagnosticsStructured.fileName), /\.zip$/u);
      assert.ok(Number(diagnosticsStructured.byteLength) > 0);
      assert.match(String(diagnosticsStructured.sha256), /^[a-f0-9]{64}$/u);
      assert.equal(diagnosticsStructured.localPath, undefined);
      const diagnosticLinks = records(record(diagnosticsExport).content).filter(
        (block) => block.type === "resource_link",
      );
      assert.equal(diagnosticLinks.length, 1);
      assert.equal(diagnosticLinks[0]?.uri, diagnosticsStructured.resourceUri);
      const diagnosticResource = await client.readResource({
        uri: String(diagnosticsStructured.resourceUri),
      });
      const diagnosticContents = records(diagnosticResource.contents);
      assert.equal(diagnosticContents.length, 1);
      assert.equal(diagnosticContents[0]?.mimeType, "application/zip");
      assert.ok(Buffer.from(String(diagnosticContents[0]?.blob), "base64").byteLength > 0);
      assert.doesNotMatch(
        JSON.stringify(diagnosticsStructured),
        /events\.jsonl|data:image|previewReceipt|previewChallenge/u,
      );
      const previousDiagnosticsDirectory = process.env.SFL_DIAGNOSTICS_DIR;
      const blockedDiagnosticsPath = path.join(root, "diagnostics-not-a-directory");
      await fs.writeFile(blockedDiagnosticsPath, "fixture");
      process.env.SFL_DIAGNOSTICS_DIR = blockedDiagnosticsPath;
      const otherServer = await createServer();
      const otherClient = new Client({ name: "server-isolation-test", version: "0.5.3" });
      const [otherClientTransport, otherServerTransport] =
        InMemoryTransport.createLinkedPair();
      await otherServer.connect(otherServerTransport);
      await otherClient.connect(otherClientTransport);
      try {
        const degradedSearch = await otherClient.callTool({
          name: "figure_library_search",
          arguments: { query: "crossprovideruniquemarker volcano", limit: 2 },
        });
        assert.equal(record(degradedSearch.structuredContent).diagnosticsDegraded, true);
        assert.equal(
          record(record(degradedSearch.structuredContent).envelope).code,
          "search_candidates_ready",
        );
        await assert.rejects(
          otherClient.readResource({ uri: String(diagnosticsStructured.resourceUri) }),
          /unavailable in this server session/u,
        );
      } finally {
        await otherClient.close();
        await otherServer.close();
        if (previousDiagnosticsDirectory === undefined) delete process.env.SFL_DIAGNOSTICS_DIR;
        else process.env.SFL_DIAGNOSTICS_DIR = previousDiagnosticsDirectory;
      }

      const hash = "0".repeat(64);
      const unknownSelector = {
        schema: "figure-library.provider-selector.v1",
        providerId: LOCAL_LIBRARY_PROVIDER_ID,
        kind: "local-published.v1",
        identity: {
          templateId: "missing-template",
          revisionId: "missing-revision",
          contentDigest: hash,
          releaseId: "missing-release",
        },
      };
      const genericApply = {
        planDigest: hash,
        operationId: "anti-loop-audit",
        expectedTemplateId: "missing-template",
        expectedSeriesDigest: null,
      };
      const opaqueApply = {
        plan: {},
        planDigest: hash,
        operationId: "anti-loop-audit",
      };
      const auditArguments: Record<string, Record<string, unknown>> = {
        figure_library_apply_adopt_versioning: genericApply,
        figure_library_apply_bind_global: opaqueApply,
        figure_library_apply_bind_workspace: opaqueApply,
        figure_library_apply_bundle_export: {
          ...opaqueApply,
          expectedTarget: path.join(root, "missing-bundle-export"),
        },
        figure_library_apply_discard_working_revision: genericApply,
        figure_library_apply_full_restore: opaqueApply,
        figure_library_apply_materialize: {
          planDigest: hash,
          operationId: "anti-loop-audit",
          expectedProviderId: LOCAL_LIBRARY_PROVIDER_ID,
          expectedTarget: path.join(root, "missing-materialization"),
        },
        figure_library_apply_publish_working_revision: genericApply,
        figure_library_apply_recover_write_lock: opaqueApply,
        figure_library_apply_restore_release: genericApply,
        figure_library_apply_review_gate_update: genericApply,
        figure_library_apply_template_bundle_import: opaqueApply,
        figure_library_apply_working_revision: {
          ...genericApply,
          expectedAction: "create_working",
        },
        figure_library_describe: {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: unknownSelector,
        },
        figure_library_diff_revisions: {
          templateId: "missing-template",
          fromRevisionId: "missing-one",
          toRevisionId: "missing-two",
        },
        figure_library_plan_adopt_versioning: { templateId: "missing-template" },
        figure_library_plan_bind_global: { libraryDirectory: "relative-library" },
        figure_library_plan_bind_workspace: { workspaceDirectory: "relative-workspace" },
        figure_library_plan_bundle_export: {
          kind: "full_library",
          destination: path.join(root, "bundle-exports"),
        },
        figure_library_plan_discard_working_revision: { templateId: "missing-template" },
        figure_library_plan_full_restore: {
          bundleDirectory: path.join(root, "missing-full-bundle"),
          targetDirectory: path.join(root, "restored-library"),
          mode: "fork",
        },
        figure_library_plan_materialize: {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: unknownSelector,
          destination: path.join(root, "materializations"),
          allowNetwork: false,
        },
        figure_library_plan_publish_working_revision: { templateId: "missing-template" },
        figure_library_plan_recover_write_lock: { reason: "anti-loop outcome audit" },
        figure_library_plan_restore_release: {
          templateId: "missing-template",
          releaseId: "missing-release",
        },
        figure_library_plan_review_gate_update: {
          templateId: "missing-template",
          decisions: [{ gateId: "missing-gate", decision: "resolved", note: "audit" }],
        },
        figure_library_plan_template_bundle_import: {
          bundleDirectory: path.join(root, "missing-template-bundle"),
          targetTemplateId: "missing-template",
        },
        figure_library_plan_working_revision: {},
        figure_library_preview_working_revision: {
          templateId: "missing-template",
          revisionId: "missing-revision",
          contentDigest: hash,
        },
        figure_library_review_open: {},
        figure_library_template_history: { templateId: "missing-template" },
      };
      const alreadyAudited = new Set([
        "figure_library_confirm_selection",
        "figure_library_confirm_selection_headless",
        "figure_library_export_diagnostics",
        "figure_library_open",
        "figure_library_preview",
        "figure_library_preview_exact",
        "figure_library_preview_exact_headless",
        "figure_library_record_ui_event",
        "figure_library_search",
        "figure_library_search_page",
        "figure_library_source_status",
      ]);
      assert.deepEqual(
        [...new Set([...alreadyAudited, ...Object.keys(auditArguments)])].sort(),
        [...STANDARD_TOOLS],
      );
      for (const [toolName, arguments_] of Object.entries(auditArguments)) {
        const result = await client.callTool({ name: toolName, arguments: arguments_ });
        assertTerminalEnvelope(result, toolName);
      }
      for (const [toolName, result] of [
        ["figure_library_confirm_selection", appConfirmation],
        ["figure_library_confirm_selection_headless", headlessConfirmation],
        ["figure_library_export_diagnostics", diagnosticsExport],
        ["figure_library_open", opened],
        ["figure_library_preview", preview],
        ["figure_library_preview_exact", appExactPreview],
        ["figure_library_preview_exact_headless", exactPreview],
        ["figure_library_record_ui_event", uiEvent],
        ["figure_library_search", searched],
        ["figure_library_search_page", secondPage],
        ["figure_library_source_status", status],
      ] as const) {
        assertTerminalEnvelope(result, toolName);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    if (previousLibraryDirectory === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = previousLibraryDirectory;
    await fs.rm(root, { recursive: true, force: true });
  }
});
