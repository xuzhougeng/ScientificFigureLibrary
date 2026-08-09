import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  "figure_library_describe",
  "figure_library_diff_revisions",
  "figure_library_open",
  "figure_library_plan_adopt_versioning",
  "figure_library_plan_bind_global",
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
  "figure_library_review_open",
  "figure_library_search",
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
    });
    await library.applyCreateWorking(publishedPlan, "server-local-working");
    await library.applyPublish(
      await library.planPublish({ templateId: "local-published-volcano" }),
      "server-local-publish",
    );
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
    const client = new Client({ name: "server-integration-test", version: "0.5.0" });
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
      assert.equal(searchedEnvelope.nextAction, "preview_selected_candidate");
      const candidates = records(searchedStructured.candidates);
      const providers = new Set(candidates.map((item) => item.providerId));
      assert.ok(providers.has(LOCAL_LIBRARY_PROVIDER_ID));
      assert.ok(providers.has(FIGUREYA_PROVIDER_ID));
      assert.ok(candidates.some((item) => item.templateId === "local-published-volcano"));
      assert.equal(candidates.some((item) => item.templateId === "hidden-working-volcano"), false);
      assert.equal(candidates.some((item) => item.templateId === "hidden-legacy-flat"), false);
      assert.ok(
        candidates.every(
          (item) =>
            record(item.exactSelector).providerId === item.providerId &&
            !("previewDataUrl" in item) &&
            !("thumbnail" in item),
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
      assert.match(toolText(searched), /NEXT_ACTION: preview_selected_candidate/u);
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

      const status = await client.callTool({
        name: "figure_library_source_status",
        arguments: {},
      });
      const statusStructured = record(status.structuredContent);
      assert.equal(statusStructured.serverVersion, "0.5.0");
      const libraryStatus = record(statusStructured.library);
      const marker = await readLibraryRootMarker(libraryRoot);
      assert.ok(marker);
      assert.equal(libraryStatus.root, libraryRoot);
      assert.equal(libraryStatus.directorySource, "FIGURE_LIBRARY_DIR");
      assert.equal(libraryStatus.libraryId, marker.value.libraryId);
      assert.equal(libraryStatus.publishedCount, 1);
      assert.equal(libraryStatus.workingCount, 1);
      assert.equal(libraryStatus.legacyFlatCount, 1);
      const standardCore = record(statusStructured.standardCore);
      assert.equal(standardCore.directIntake, true);
      assert.equal(standardCore.captureToolsRegistered, false);
      assert.equal(standardCore.projectPinToolsRegistered, false);
      assert.equal(standardCore.flatEntriesInOrdinarySearch, false);
      const text = toolText(status);
      for (const field of [
        "SERVER_VERSION: 0.5.0",
        `LIBRARY_ROOT: ${libraryRoot}`,
        `LIBRARY_ID: ${marker.value.libraryId}`,
        "PUBLISHED: 1",
        "WORKING: 1",
        "LEGACY_FLAT: 1",
        "FIGUREYA_CATALOG:",
        "CAPTURE_TOOLS_REGISTERED: false",
        "PROJECT_PIN_TOOLS_REGISTERED: false",
      ]) {
        assert.ok(text.includes(field), `status text omitted ${field}`);
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
        figure_library_review_open: {},
        figure_library_template_history: { templateId: "missing-template" },
      };
      const alreadyAudited = new Set([
        "figure_library_open",
        "figure_library_preview",
        "figure_library_search",
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
        ["figure_library_open", opened],
        ["figure_library_preview", preview],
        ["figure_library_search", searched],
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
