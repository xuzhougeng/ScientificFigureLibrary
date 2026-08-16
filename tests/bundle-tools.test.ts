import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBundleTools } from "../src/bundle-tools.ts";
import type { CurrentLibraryContext } from "../src/library-binding-tools.ts";
import {
  ensureLibraryRootMarker,
  readLibraryRootMarker,
  resolveLibraryRuntimeSnapshot,
} from "../src/library-runtime.ts";
import {
  PortableBundleManager,
} from "../src/portable-bundles.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function pathLinePattern(label: string, filePath: string) {
  const variants = new Set([filePath]);
  if (filePath.startsWith("/var/")) variants.add(`/private${filePath}`);
  if (filePath.startsWith("/private/var/")) variants.add(filePath.slice("/private".length));
  return new RegExp(`${label}: (?:${[...variants].map(escapeRegExp).join("|")})`, "u");
}

function fixtureCandidate(): VersionedTemplateCandidate {
  return {
    title: "Portable bundle MCP fixture",
    description: "A user-confirmed exact Published Figure Unit.",
    tags: ["bundle", "line"],
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
        evidence: "The user confirmed the author-provided image/code relationship.",
      },
    ],
    assets: [
      {
        logicalPath: "visuals/source/preview.png",
        role: "visual",
        visualRole: "source_reference",
        mediaType: "image/png",
        text: "bundle-preview",
      },
      {
        logicalPath: "code/plot.R",
        role: "code",
        codeOrigin: "author_provided",
        language: "R",
        text: "plot(1:3, type = 'l')\n",
      },
      {
        logicalPath: "evidence/association.md",
        role: "evidence",
        text: "User-confirmed association.\n",
      },
    ],
  };
}

async function publishedContext(root: string): Promise<CurrentLibraryContext> {
  await ensureLibraryRootMarker(root);
  const snapshot = await resolveLibraryRuntimeSnapshot({ root });
  const versionedLibrary = new VersionedTemplateLibrary(snapshot);
  const working = await versionedLibrary.planCreateWorking({
    templateId: "bundle-mcp-source",
    candidate: fixtureCandidate(),
  });
  await versionedLibrary.applyCreateWorking(working, "bundle-mcp-source-working");
  await versionedLibrary.applyPublish(
    await versionedLibrary.planPublish({ templateId: "bundle-mcp-source" }),
    "bundle-mcp-source-publish",
  );
  return { snapshot, versionedLibrary };
}

async function startClient(context: CurrentLibraryContext) {
  const server = new McpServer({ name: "Bundle tools test", version: "0.5.0" });
  registerBundleTools({ server, currentLibraries: async () => context });
  const client = new Client({ name: "bundle-tools-test", version: "0.5.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("text-only hosts can export and import an exact template using cached planDigest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-bundle-tools-template-"));
  const context = await publishedContext(path.join(root, "library"));
  const connection = await startClient(context);
  try {
    const tools = await connection.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const required of [
      "figure_library_plan_bundle_export",
      "figure_library_apply_bundle_export",
      "figure_library_plan_template_bundle_import",
      "figure_library_apply_template_bundle_import",
    ]) {
      assert.ok(names.includes(required), `missing tool ${required}`);
    }

    const destination = path.join(root, "exports");
    const targetName = "published-template-bundle";
    const planned = await connection.client.callTool({
      name: "figure_library_plan_bundle_export",
      arguments: {
        kind: "published_template",
        templateId: "bundle-mcp-source",
        destination,
        targetName,
      },
    });
    const exportPlan = record(record(planned.structuredContent).plan);
    const exportDigest = String(exportPlan.planDigest);
    assert.equal(record(record(planned.structuredContent).envelope).outcome, "needs_user_confirmation");
    assert.match(toolText(planned), new RegExp(`PLAN_DIGEST: ${exportDigest}`, "u"));
    assert.match(toolText(planned), new RegExp(`TARGET: ${path.join(destination, targetName).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    assert.match(toolText(planned), /PUBLISHED_SELECTOR: .*"templateId":"bundle-mcp-source"/u);
    assert.match(toolText(planned), /"revisionId":"revision-/u);
    assert.match(toolText(planned), /"contentDigest":"[a-f0-9]{64}"/u);
    assert.match(toolText(planned), /"releaseId":"release-/u);
    await assert.rejects(fs.stat(path.join(destination, targetName)), { code: "ENOENT" });

    const exportArguments = {
      planDigest: exportDigest,
      operationId: "bundle-mcp-export-template",
      expectedTarget: path.join(destination, targetName),
    };
    const exported = await connection.client.callTool({
      name: "figure_library_apply_bundle_export",
      arguments: exportArguments,
    });
    assert.equal(record(record(exported.structuredContent).envelope).outcome, "applied");
    const exportedResult = record(record(exported.structuredContent).result);
    const bundleDirectory = String(exportedResult.target);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(bundleDirectory, "bundle.json"), "utf8")).schema,
      "figure-library.published-template-bundle.v1",
    );

    const exportReplay = await connection.client.callTool({
      name: "figure_library_apply_bundle_export",
      arguments: exportArguments,
    });
    assert.equal(record(record(exportReplay.structuredContent).envelope).outcome, "replayed");

    const importPlanned = await connection.client.callTool({
      name: "figure_library_plan_template_bundle_import",
      arguments: {
        bundleDirectory,
        targetTemplateId: "bundle-mcp-imported",
        mode: "create",
      },
    });
    const importPlan = record(record(importPlanned.structuredContent).plan);
    const importDigest = String(importPlan.planDigest);
    assert.equal(
      record(record(importPlanned.structuredContent).envelope).outcome,
      "needs_user_confirmation",
    );
    assert.match(toolText(importPlanned), pathLinePattern("BUNDLE_DIRECTORY", bundleDirectory));
    assert.match(toolText(importPlanned), /BUNDLE_INVENTORY_DIGEST: [a-f0-9]{64}/u);
    assert.match(toolText(importPlanned), /SOURCE_LIBRARY_ID: [0-9a-f-]{36}/u);
    assert.match(toolText(importPlanned), /SOURCE_PUBLISHED_SELECTOR: .*"templateId":"bundle-mcp-source"/u);
    assert.match(toolText(importPlanned), /AUTHORITY_INHERITED: false/u);

    const importArguments = {
      planDigest: importDigest,
      operationId: "bundle-mcp-import-template",
    };
    const imported = await connection.client.callTool({
      name: "figure_library_apply_template_bundle_import",
      arguments: importArguments,
    });
    const importedStructured = record(imported.structuredContent);
    assert.equal(record(importedStructured.envelope).outcome, "applied");
    assert.equal(importedStructured.authorityInherited, false);
    const series = await context.versionedLibrary.getSeries("bundle-mcp-imported");
    assert.ok(series?.workingHead);
    assert.equal(series?.publishedHead, undefined);

    const importReplay = await connection.client.callTool({
      name: "figure_library_apply_template_bundle_import",
      arguments: importArguments,
    });
    assert.equal(record(record(importReplay.structuredContent).envelope).outcome, "replayed");
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("full backup Fork uses cached planDigest and missing cache is terminal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-bundle-tools-full-"));
  const context = await publishedContext(path.join(root, "library"));
  const connection = await startClient(context);
  try {
    const missing = await connection.client.callTool({
      name: "figure_library_apply_bundle_export",
      arguments: {
        planDigest: "f".repeat(64),
        operationId: "missing-bundle-plan",
        expectedTarget: path.join(root, "missing-bundle-target"),
      },
    });
    const missingEnvelope = record(record(missing.structuredContent).envelope);
    assert.equal(missingEnvelope.outcome, "blocked");
    assert.equal(missingEnvelope.code, "plan_not_available");
    assert.equal(missingEnvelope.retrySameCall, false);
    assert.equal(missingEnvelope.nextAction, "create_new_plan");

    const backupPlanned = await connection.client.callTool({
      name: "figure_library_plan_bundle_export",
      arguments: {
        kind: "full_library",
        destination: path.join(root, "backups"),
        targetName: "full-library-backup",
      },
    });
    const backupPlan = record(record(backupPlanned.structuredContent).plan);
    const backupApplied = await connection.client.callTool({
      name: "figure_library_apply_bundle_export",
      arguments: {
        planDigest: String(backupPlan.planDigest),
        operationId: "bundle-mcp-full-backup",
        expectedTarget: path.join(
          String(backupPlan.destination),
          String(backupPlan.targetName),
        ),
      },
    });
    assert.equal(record(record(backupApplied.structuredContent).envelope).outcome, "applied");
    const bundleDirectory = String(record(record(backupApplied.structuredContent).result).target);

    const targetDirectory = path.join(root, "forked-library");
    const forkPlanned = await connection.client.callTool({
      name: "figure_library_plan_full_restore",
      arguments: {
        bundleDirectory,
        targetDirectory,
        mode: "fork",
      },
    });
    const forkPlan = record(record(forkPlanned.structuredContent).plan);
    assert.match(toolText(forkPlanned), pathLinePattern("BUNDLE_DIRECTORY", bundleDirectory));
    assert.match(toolText(forkPlanned), /BUNDLE_INVENTORY_DIGEST: [a-f0-9]{64}/u);
    assert.match(toolText(forkPlanned), pathLinePattern("TARGET_DIRECTORY", targetDirectory));
    const forkApplied = await connection.client.callTool({
      name: "figure_library_apply_full_restore",
      arguments: {
        planDigest: String(forkPlan.planDigest),
        operationId: "bundle-mcp-fork",
      },
    });
    assert.equal(record(record(forkApplied.structuredContent).envelope).outcome, "applied");
    const sourceMarker = await readLibraryRootMarker(context.snapshot.root);
    const forkMarker = await readLibraryRootMarker(targetDirectory);
    assert.ok(sourceMarker && forkMarker);
    assert.notEqual(forkMarker.value.libraryId, sourceMarker.value.libraryId);
    assert.equal(forkMarker.value.forkedFromLibraryId, sourceMarker.value.libraryId);
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bundle export Apply recovers a completed target after server restart loses its plan cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-bundle-tools-restart-"));
  const context = await publishedContext(path.join(root, "library"));
  const operationId = "bundle-mcp-restart-recovery";
  const manager = new PortableBundleManager(context.snapshot.root, context.versionedLibrary);
  const plan = await manager.planPublishedTemplateExport({
    templateId: "bundle-mcp-source",
    destination: path.join(root, "exports"),
    targetName: "restart-recovery-bundle",
  });
  const crashing = new PortableBundleManager(
    context.snapshot.root,
    context.versionedLibrary,
    {
      faultInjector(point) {
        if (point === "before_export_receipt") {
          throw new Error("simulated server stop before export receipt");
        }
      },
    },
  );
  await assert.rejects(
    crashing.applyExport(plan, operationId),
    /simulated server stop before export receipt/u,
  );

  const restarted = await startClient(context);
  try {
    const recovered = await restarted.client.callTool({
      name: "figure_library_apply_bundle_export",
      arguments: {
        planDigest: plan.planDigest,
        operationId,
        expectedTarget: path.join(plan.destination, plan.targetName),
      },
    });
    const structured = record(recovered.structuredContent);
    assert.equal(record(structured.envelope).outcome, "replayed");
    assert.equal(record(structured.envelope).code, "bundle_export_recovered");
    assert.equal(record(structured.result).recovered, true);
  } finally {
    await restarted.client.close();
    await restarted.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
