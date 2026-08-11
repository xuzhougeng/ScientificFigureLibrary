#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const externalMaterializeDestination = process.argv[2];
const serverEntry =
  process.env.FIGURE_LIBRARY_SMOKE_SERVER ?? path.join(root, "dist", "index.js");
const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-0.5-smoke-"));
const libraryDirectory = path.join(smokeRoot, "global-library");
const intakeDirectory = path.join(smokeRoot, "direct-intake");
await fs.mkdir(libraryDirectory, { recursive: true });
await fs.mkdir(intakeDirectory, { recursive: true });
const visualPath = path.join(intakeDirectory, "reference.png");
const codePath = path.join(intakeDirectory, "plot.R");
await fs.writeFile(
  visualPath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
await fs.writeFile(codePath, "plot(1:3)\n");

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);
childEnvironment.FIGURE_LIBRARY_DIR = libraryDirectory;

const client = new Client({ name: "scientific-figure-library-smoke", version: "0.5.1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  stderr: "pipe",
  env: childEnvironment,
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
let smokeStep = "connect";

function structured(result) {
  if (!result.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error(`tool omitted structuredContent: ${JSON.stringify(result.content)}`);
  }
  return result.structuredContent;
}

function outcome(result) {
  const value = structured(result).envelope;
  if (!value || typeof value !== "object") {
    throw new Error(`tool omitted terminal outcome envelope: ${JSON.stringify(result.content)}`);
  }
  if (value.terminal !== true || value.retrySameCall !== false) {
    throw new Error(`tool outcome is not anti-loop terminal: ${JSON.stringify(value)}`);
  }
  return value;
}

function text(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function assertTextFields(result, fields, label) {
  const visible = text(result);
  for (const field of fields) {
    if (!visible.includes(field)) throw new Error(`${label} text omitted ${field}`);
  }
}

try {
  await client.connect(transport);
  smokeStep = "list-tools";
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const required = [
    "figure_library_open",
    "figure_library_search",
    "figure_library_search_page",
    "figure_library_describe",
    "figure_library_preview",
    "figure_library_preview_exact",
    "figure_library_preview_exact_headless",
    "figure_library_confirm_selection",
    "figure_library_confirm_selection_headless",
    "figure_library_record_ui_event",
    "figure_library_export_diagnostics",
    "figure_library_source_status",
    "figure_library_plan_bind_global",
    "figure_library_apply_bind_global",
    "figure_library_plan_recover_write_lock",
    "figure_library_apply_recover_write_lock",
    "figure_library_review_open",
    "figure_library_template_history",
    "figure_library_diff_revisions",
    "figure_library_plan_working_revision",
    "figure_library_apply_working_revision",
    "figure_library_plan_review_gate_update",
    "figure_library_apply_review_gate_update",
    "figure_library_plan_publish_working_revision",
    "figure_library_apply_publish_working_revision",
    "figure_library_plan_discard_working_revision",
    "figure_library_apply_discard_working_revision",
    "figure_library_plan_restore_release",
    "figure_library_apply_restore_release",
    "figure_library_plan_adopt_versioning",
    "figure_library_apply_adopt_versioning",
    "figure_library_plan_materialize",
    "figure_library_apply_materialize",
    "figure_library_plan_bundle_export",
    "figure_library_apply_bundle_export",
    "figure_library_plan_full_restore",
    "figure_library_apply_full_restore",
    "figure_library_plan_template_bundle_import",
    "figure_library_apply_template_bundle_import",
  ].sort();
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`missing 0.5.1 tool ${name}`);
  }
  if (names.length !== 39 || names.length !== required.length) {
    throw new Error(`expected exactly 39 standard tools, received ${names.length}`);
  }
  for (const [toolName, visibility] of [
    ["figure_library_search", "model"],
    ["figure_library_search_page", "app"],
    ["figure_library_preview_exact", "app"],
    ["figure_library_preview_exact_headless", "model"],
    ["figure_library_record_ui_event", "app"],
    ["figure_library_export_diagnostics", "model"],
  ]) {
    const tool = listed.tools.find((candidate) => candidate.name === toolName);
    if (JSON.stringify(tool?._meta?.ui?.visibility) !== JSON.stringify([visibility])) {
      throw new Error(`${toolName} visibility is not ${visibility}-only`);
    }
  }
  if (names.some((name) => name.startsWith("figure_capture_"))) {
    throw new Error("standard 0.5.1 server registered an experimental Capture tool");
  }
  for (const forbidden of [
    "figure_library_project_status",
    "figure_library_plan_project_use",
    "figure_library_apply_project_use",
  ]) {
    if (names.includes(forbidden)) throw new Error(`standard server registered ${forbidden}`);
  }

  smokeStep = "open";
  const opened = await client.callTool({ name: "figure_library_open", arguments: {} });
  if (
    opened.isError ||
    outcome(opened).outcome !== "ok" ||
    outcome(opened).nextAction !== "ask_user" ||
    structured(opened).libraryVersion !== "0.5.1"
  ) {
    throw new Error("open did not report the 0.5.1 direct-intake workbench");
  }

  smokeStep = "initial-status";
  const initialStatus = await client.callTool({
    name: "figure_library_source_status",
    arguments: {},
  });
  if (
    initialStatus.isError ||
    outcome(initialStatus).outcome !== "ok" ||
    structured(initialStatus).serverVersion !== "0.5.1" ||
    structured(initialStatus).standardCore?.captureToolsRegistered !== false ||
    structured(initialStatus).standardCore?.projectPinToolsRegistered !== false
  ) {
    throw new Error("initial source status did not expose the complete standard-core state");
  }
  assertTextFields(
    initialStatus,
    [
      "SERVER_VERSION: 0.5.1",
      `LIBRARY_ROOT: ${libraryDirectory}`,
      "LIBRARY_SOURCE: FIGURE_LIBRARY_DIR",
      "CAPTURE_TOOLS_REGISTERED: false",
      "PROJECT_PIN_TOOLS_REGISTERED: false",
    ],
    "source status",
  );

  smokeStep = "figureya-search-preview";
  const figureYaSearch = await client.callTool({
    name: "figure_library_search",
    arguments: {
      query: "volcano differential expression log2 fold change adjusted p value",
      dataProfile: "gene log2FC pvalue padj",
      limit: 6,
    },
  });
  const figureYaCandidates = structured(figureYaSearch).candidates ?? [];
  const figureYa = figureYaCandidates.find(
    (candidate) =>
      candidate.providerId === "org.figureya.module" && candidate.previewAvailable === true,
  );
  if (
    figureYaSearch.isError ||
    outcome(figureYaSearch).outcome !== "ok" ||
    outcome(figureYaSearch).nextAction !== "ask_user" ||
    !figureYa ||
    !figureYa.exactSelector ||
    figureYa.previewStatus !== "ready" ||
    "previewDataUrl" in figureYa ||
    typeof figureYa.candidateId !== "string" ||
    typeof figureYa.previewSha256 !== "string"
  ) {
    throw new Error("unified search did not stop for user selection with a compact FigureYa result");
  }
  if (JSON.stringify(structured(figureYaSearch)).includes("data:image/")) {
    throw new Error("model-visible search structuredContent contains an image Data URL");
  }
  const figureYaThumbnail = figureYaSearch._meta?.candidatePreviews?.[figureYa.candidateId];
  if (
    typeof figureYaThumbnail?.previewDataUrl !== "string" ||
    !figureYaThumbnail.previewDataUrl.startsWith("data:image/") ||
    figureYaThumbnail.previewSha256 !== figureYa.previewSha256
  ) {
    throw new Error("component-only search metadata omitted the verified FigureYa thumbnail");
  }
  if (structured(figureYaSearch).pagination?.nextCursor) {
    const secondPage = await client.callTool({
      name: "figure_library_search_page",
      arguments: {
        resultSetId: structured(figureYaSearch).resultSetId,
        cursor: structured(figureYaSearch).pagination.nextCursor,
      },
    });
    if (
      outcome(secondPage).outcome !== "ok" ||
      structured(secondPage).resultSetId !== structured(figureYaSearch).resultSetId ||
      structured(secondPage).pageIndex !== 2
    ) {
      throw new Error("App-only pagination did not continue the existing result set");
    }
  }
  const previewed = await client.callTool({
    name: "figure_library_preview",
    arguments: {
      providerId: figureYa.providerId,
      exactSelector: figureYa.exactSelector,
      destination: path.join(smokeRoot, "previews"),
    },
  });
  const previewPath = structured(previewed).path;
  if (
    previewed.isError ||
    typeof previewPath !== "string" ||
    !(await fs.stat(previewPath)).isFile() ||
    !previewed.content?.some((block) => block.type === "image")
  ) {
    throw new Error("exact FigureYa preview did not return one verified MCP image and path");
  }

  smokeStep = "direct-intake-working";
  const workingPlanned = await client.callTool({
    name: "figure_library_plan_working_revision",
    arguments: {
      mode: "create",
      templateId: "smoke-direct-volcano",
      title: "smoke-direct-unique volcano reference",
      description: "A user-confirmed image/code Figure Unit for the 0.5.1 stdio smoke.",
      tags: ["smoke-direct-unique", "volcano"],
      visualProfile: "volcano scatter x log2FC y negative log10 adjusted p value",
      dataProfile: "gene log2FC pvalue padj",
      packages: ["ggplot2"],
      license: "reference only",
      assetKind: "plot_template",
      language: "R",
      plotFamily: "volcano",
      codeStatus: "reviewed",
      executionStatus: "not_run",
      visualAssets: [
        {
          assetId: "source-visual",
          sourcePath: visualPath,
          visualRole: "source_reference",
          mediaType: "image/png",
        },
      ],
      codeAssets: [
        {
          assetId: "canonical-code",
          sourcePath: codePath,
          language: "R",
          codeOrigin: "user_supplied",
        },
      ],
      primaryVisualAssetId: "source-visual",
      canonicalCodeAssetId: "canonical-code",
      figureCodeLinks: [
        {
          visualAssetId: "source-visual",
          codeAssetIds: ["canonical-code"],
          relationship: "user_supplied_pair",
          evidence: "The smoke user supplied and confirmed this exact image/code pair.",
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
  const workingPlan = structured(workingPlanned).plan;
  if (
    workingPlanned.isError ||
    outcome(workingPlanned).outcome !== "needs_user_confirmation" ||
    workingPlan?.action !== "create_working"
  ) {
    throw new Error(`direct intake planning failed: ${JSON.stringify(workingPlanned.content)}`);
  }
  assertTextFields(
    workingPlanned,
    [
      `PLAN_DIGEST: ${workingPlan.planDigest}`,
      "ACTION: create_working",
      "TEMPLATE_ID: smoke-direct-volcano",
      "BLOCKING_GATES: none",
    ],
    "working plan",
  );
  const workingApplyArguments = {
    planDigest: workingPlan.planDigest,
    operationId: "smoke-direct-working",
    expectedAction: workingPlan.action,
    expectedTemplateId: workingPlan.templateId,
    expectedSeriesDigest: workingPlan.expectedSeriesDigest,
  };
  const workingApplied = await client.callTool({
    name: "figure_library_apply_working_revision",
    arguments: workingApplyArguments,
  });
  if (workingApplied.isError || outcome(workingApplied).outcome !== "applied") {
    throw new Error(`direct intake Apply failed: ${JSON.stringify(workingApplied.content)}`);
  }
  const workingReplay = await client.callTool({
    name: "figure_library_apply_working_revision",
    arguments: workingApplyArguments,
  });
  if (outcome(workingReplay).outcome !== "replayed") {
    throw new Error("Working Revision operationId replay was not idempotent");
  }

  const review = await client.callTool({
    name: "figure_library_review_open",
    arguments: { templateId: "smoke-direct-volcano" },
  });
  if (
    review.isError ||
    outcome(review).outcome !== "ok" ||
    !structured(review).series?.workingHead ||
    structured(review).series?.publishedHead
  ) {
    throw new Error("Review Workbench did not isolate the unpublished Working Revision");
  }

  smokeStep = "publish";
  const publishPlanned = await client.callTool({
    name: "figure_library_plan_publish_working_revision",
    arguments: { templateId: "smoke-direct-volcano" },
  });
  const publishPlan = structured(publishPlanned).plan;
  if (
    publishPlanned.isError ||
    outcome(publishPlanned).outcome !== "needs_user_confirmation" ||
    publishPlan?.action !== "publish"
  ) {
    throw new Error(`Publish planning failed: ${JSON.stringify(publishPlanned.content)}`);
  }
  const published = await client.callTool({
    name: "figure_library_apply_publish_working_revision",
    arguments: {
      planDigest: publishPlan.planDigest,
      operationId: "smoke-direct-publish",
      expectedTemplateId: publishPlan.templateId,
      expectedSeriesDigest: publishPlan.expectedSeriesDigest,
    },
  });
  if (
    published.isError ||
    outcome(published).outcome !== "applied" ||
    !structured(published).result?.releaseId
  ) {
    throw new Error(`atomic Publish Apply failed: ${JSON.stringify(published.content)}`);
  }

  smokeStep = "unified-search-describe";
  const unified = await client.callTool({
    name: "figure_library_search",
    arguments: {
      query: "smoke-direct-unique volcano differential expression",
      dataProfile: "gene log2FC pvalue padj",
      limit: 6,
    },
  });
  const unifiedCandidates = structured(unified).candidates ?? [];
  const local = unifiedCandidates.find(
    (candidate) =>
      candidate.providerId === "org.scientificfigurelibrary.local" &&
      candidate.templateId === "smoke-direct-volcano",
  );
  if (
    unified.isError ||
    outcome(unified).outcome !== "ok" ||
    !local?.exactSelector ||
    !unifiedCandidates.some((candidate) => candidate.providerId === "org.figureya.module")
  ) {
    throw new Error("ordinary search did not merge Local Published and FigureYa");
  }

  const described = await client.callTool({
    name: "figure_library_describe",
    arguments: { providerId: local.providerId, exactSelector: local.exactSelector },
  });
  if (
    described.isError ||
    outcome(described).outcome !== "ok" ||
    structured(described).content?.executionStatus !== "not_run"
  ) {
    throw new Error("exact Local Published describe failed or overstated execution");
  }
  const previewCapabilities = structured(described).previewConfirmationCapabilities;
  if (
    previewCapabilities?.updateModelContextFallback !== true ||
    previewCapabilities?.fallbackHandoffMode !== "headless_exact_review" ||
    previewCapabilities?.fallbackCandidateLimit !== 1
  ) {
    throw new Error("describe omitted the single-candidate updateModelContext fallback");
  }

  const materializeDestination = externalMaterializeDestination
    ? path.resolve(externalMaterializeDestination)
    : path.join(smokeRoot, "materialized");
  smokeStep = "materialization";
  const materializationWithoutPreview = await client.callTool({
    name: "figure_library_plan_materialize",
    arguments: {
      providerId: local.providerId,
      exactSelector: local.exactSelector,
      destination: materializeDestination,
      allowNetwork: false,
    },
  });
  if (outcome(materializationWithoutPreview).code !== "preview_required") {
    throw new Error("materialization plan did not fail closed without previewReceipt");
  }
  const exactConfirmationPreview = await client.callTool({
    name: "figure_library_preview_exact_headless",
    arguments: {
      resultSetId: structured(unified).resultSetId,
      providerId: local.providerId,
      exactSelector: local.exactSelector,
    },
  });
  if (
    outcome(exactConfirmationPreview).code !== "exact_preview_ready" ||
    !exactConfirmationPreview.content?.some((block) => block.type === "image") ||
    typeof structured(exactConfirmationPreview).previewChallenge !== "string" ||
    typeof structured(exactConfirmationPreview).previewSha256 !== "string"
  ) {
    throw new Error("exact confirmation preview omitted image, SHA-256, or challenge");
  }
  const headlessConfirmation = await client.callTool({
    name: "figure_library_confirm_selection_headless",
    arguments: {
      previewChallenge: structured(exactConfirmationPreview).previewChallenge,
    },
  });
  if (
    outcome(headlessConfirmation).code !== "preview_confirmed_headless" ||
    typeof structured(headlessConfirmation).previewReceipt !== "string"
  ) {
    throw new Error("headless confirmation did not issue a previewReceipt");
  }
  const materializationPlanned = await client.callTool({
    name: "figure_library_plan_materialize",
    arguments: {
      providerId: local.providerId,
      exactSelector: local.exactSelector,
      previewReceipt: structured(headlessConfirmation).previewReceipt,
      destination: materializeDestination,
      allowNetwork: false,
    },
  });
  const materializationPlan = structured(materializationPlanned).plan;
  if (
    materializationPlanned.isError ||
    outcome(materializationPlanned).outcome !== "needs_user_confirmation" ||
    materializationPlan?.written !== false
  ) {
    throw new Error(`materialization planning failed: ${JSON.stringify(materializationPlanned.content)}`);
  }
  assertTextFields(
    materializationPlanned,
    [
      `PLAN_DIGEST: ${materializationPlan.planDigest}`,
      `PROVIDER_ID: ${local.providerId}`,
      `EXACT_SELECTOR: ${JSON.stringify(local.exactSelector)}`,
      `TARGET: ${materializationPlan.target}`,
      "ALLOW_NETWORK: false",
      "SOURCE_PACK_DIR: none",
    ],
    "materialization plan",
  );
  const materializationArguments = {
    planDigest: materializationPlan.planDigest,
    operationId: "smoke-direct-materialize",
    expectedProviderId: materializationPlan.providerId,
    expectedTarget: materializationPlan.target,
  };
  const materialized = await client.callTool({
    name: "figure_library_apply_materialize",
    arguments: materializationArguments,
  });
  if (
    materialized.isError ||
    outcome(materialized).outcome !== "applied" ||
    !(await fs.stat(structured(materialized).result.target)).isDirectory()
  ) {
    throw new Error(`exact materialization Apply failed: ${JSON.stringify(materialized.content)}`);
  }
  const materializationReplay = await client.callTool({
    name: "figure_library_apply_materialize",
    arguments: materializationArguments,
  });
  if (outcome(materializationReplay).outcome !== "replayed") {
    throw new Error("materialization operationId replay was not idempotent");
  }
  const missingPlan = await client.callTool({
    name: "figure_library_apply_materialize",
    arguments: {
      planDigest: "f".repeat(64),
      operationId: "smoke-missing-plan",
      expectedProviderId: local.providerId,
      expectedTarget: path.join(smokeRoot, "missing-materialization"),
    },
  });
  if (
    missingPlan.isError ||
    outcome(missingPlan).outcome !== "blocked" ||
    outcome(missingPlan).code !== "materialization_plan_not_available"
  ) {
    throw new Error("missing materialization plan did not terminate without retry");
  }

  smokeStep = "bundle-export-import";
  const bundlePlanned = await client.callTool({
    name: "figure_library_plan_bundle_export",
    arguments: {
      kind: "published_template",
      templateId: "smoke-direct-volcano",
      destination: path.join(smokeRoot, "bundles"),
      targetName: "smoke-published-template",
    },
  });
  const bundlePlan = structured(bundlePlanned).plan;
  if (
    bundlePlanned.isError ||
    outcome(bundlePlanned).outcome !== "needs_user_confirmation" ||
    !bundlePlan?.planDigest
  ) {
    throw new Error(`bundle export planning failed: ${JSON.stringify(bundlePlanned.content)}`);
  }
  assertTextFields(
    bundlePlanned,
    [
      `PLAN_DIGEST: ${bundlePlan.planDigest}`,
      "KIND: published_template",
      `TARGET: ${path.join(bundlePlan.destination, bundlePlan.targetName)}`,
    ],
    "bundle export plan",
  );
  const bundleApplied = await client.callTool({
    name: "figure_library_apply_bundle_export",
    arguments: {
      planDigest: bundlePlan.planDigest,
      operationId: "smoke-template-bundle-export",
      expectedTarget: path.join(bundlePlan.destination, bundlePlan.targetName),
    },
  });
  if (bundleApplied.isError || outcome(bundleApplied).outcome !== "applied") {
    throw new Error(`text-only bundle Apply failed: ${JSON.stringify(bundleApplied.content)}`);
  }
  const bundleDirectory = structured(bundleApplied).result.target;
  const importPlanned = await client.callTool({
    name: "figure_library_plan_template_bundle_import",
    arguments: {
      bundleDirectory,
      targetTemplateId: "smoke-bundle-import",
      mode: "create",
    },
  });
  const importPlan = structured(importPlanned).plan;
  const imported = await client.callTool({
    name: "figure_library_apply_template_bundle_import",
    arguments: {
      planDigest: importPlan.planDigest,
      operationId: "smoke-template-bundle-import",
    },
  });
  if (
    imported.isError ||
    outcome(imported).outcome !== "applied" ||
    structured(imported).authorityInherited !== false
  ) {
    throw new Error(`template bundle did not import as a local Working Revision`);
  }

  smokeStep = "final-status-resource";
  const finalStatus = await client.callTool({
    name: "figure_library_source_status",
    arguments: {},
  });
  if (
    finalStatus.isError ||
    structured(finalStatus).library?.publishedCount !== 1 ||
    structured(finalStatus).library?.workingCount !== 1 ||
    structured(finalStatus).providers?.local?.ordinarySearchScope !== "Published only"
  ) {
    throw new Error(`final source status did not preserve Published/Working isolation`);
  }

  smokeStep = "diagnostics-export";
  const diagnosticsExport = await client.callTool({
    name: "figure_library_export_diagnostics",
    arguments: {},
  });
  const diagnostics = structured(diagnosticsExport);
  if (
    diagnosticsExport.isError ||
    outcome(diagnosticsExport).code !== "diagnostics_exported" ||
    typeof diagnostics.resourceUri !== "string" ||
    typeof diagnostics.sha256 !== "string" ||
    !(diagnostics.byteLength > 0) ||
    "localPath" in diagnostics ||
    JSON.stringify(diagnostics).match(/events\.jsonl|data:image|previewReceipt|previewChallenge/u)
  ) {
    throw new Error("diagnostic export did not return a compact sanitized resource link");
  }
  const diagnosticsResource = await client.readResource({ uri: diagnostics.resourceUri });
  if (
    diagnosticsResource.contents[0]?.mimeType !== "application/zip" ||
    typeof diagnosticsResource.contents[0]?.blob !== "string" ||
    Buffer.from(diagnosticsResource.contents[0].blob, "base64").byteLength !== diagnostics.byteLength
  ) {
    throw new Error("diagnostic resource link did not return the generated ZIP bytes");
  }

  const resource = await client.readResource({ uri: "ui://figure-library/candidates-v0.5.1.html" });
  if (!resource.contents[0]?.mimeType?.startsWith("text/html")) {
    throw new Error("MCP App resource was not returned as HTML");
  }

  console.log(
    `OK 0.5.1: ${names.length} standard tools; model/app visibility split; compact search thumbnails; no Capture/project pins; unified providers; direct intake; immutable Publish; preview-confirmed protocol-v2 materialization/replay; sanitized diagnostics resource; portable template bundle/import; terminal anti-loop outcomes${externalMaterializeDestination ? `; materialized ${structured(materialized).result.target}` : ""}`,
  );
} catch (error) {
  console.error(`SMOKE_STEP_FAILED: ${smokeStep}`);
  throw error;
} finally {
  await client.close().catch(() => undefined);
  if (!externalMaterializeDestination) {
    await fs.rm(smokeRoot, { recursive: true, force: true });
  } else {
    // Preserve only the explicitly requested external materialization; remove all smoke fixtures.
    await fs.rm(smokeRoot, { recursive: true, force: true });
  }
}
