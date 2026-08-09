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

test("core lifecycle registration omits Capture/project pins and missing confirmations are terminal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-lifecycle-tools-missing-"));
  const connection = await startLifecycleClient(path.join(root, "library"));
  try {
    const tools = await connection.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("figure_library_plan_working_revision"));
    assert.ok(names.includes("figure_library_apply_publish_working_revision"));
    assert.ok(names.includes("figure_library_review_open"));
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
