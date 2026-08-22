import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CurrentLibraryContext } from "../src/library-binding-tools.ts";
import { ensureLibraryRootMarker, resolveLibraryRuntimeSnapshot } from "../src/library-runtime.ts";
import { registerPublicationExportTools } from "../src/publication-export-tools.ts";
import { LOCAL_LIBRARY_PROVIDER_ID, localPublishedExactSelector } from "../src/providers.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";

const PNG_BYTES = Buffer.from(
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

function safeCandidate(): VersionedTemplateCandidate {
  return {
    title: "Private parent title",
    description: "A locally reviewed private parent release.",
    tags: ["private-parent", "bars"],
    visualProfile: "private parent visual wording",
    dataProfile: "private parent data wording",
    packages: [],
    license: "private_reference",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "bar",
    codeStatus: "reviewed",
    executionStatus: "passed",
    validationState: {
      schema: "figure-library.validation-state.v1",
      plotExecution: {
        status: "passed",
        scope: "synthetic_data",
        evidenceAssetPaths: ["evidence/private-assessment.md"],
      },
      upstreamWorkflow: { status: "not_applicable" },
      scientificValidation: { status: "not_assessed" },
    },
    primaryPreview: "visuals/rendered/preview.png",
    primaryPreviewOverride: {
      confirmedBy: "user",
      reason: "The public-safe generated output is the canonical preview; the private source reference remains excluded.",
    },
    canonicalImplementation: { assetPath: "code/render.R", selectedBy: "user" },
    visualGrouping: {
      visualAssetPaths: ["visuals/source/private-reference.png", "visuals/rendered/preview.png"],
      confirmedBy: "user",
    },
    figureCodeLinks: [
      {
        visualAssetPath: "visuals/rendered/preview.png",
        codeAssetPaths: ["code/render.R"],
        relationship: "generated_output",
        confirmedBy: "user",
        evidence: "The user confirmed that render.R and the synthetic table generated this preview.",
      },
      {
        visualAssetPath: "visuals/source/private-reference.png",
        codeAssetPaths: ["code/render.R"],
        relationship: "adapted_from_template",
        confirmedBy: "user",
        evidence: "The user confirmed that the clean-room renderer is only generally inspired by this private reference.",
      },
    ],
    provenance: {
      note: "Private parent metadata is not automatically promoted to a public license.",
      url: "https://example.org/design-notes",
    },
    assets: [
      {
        logicalPath: "code/render.R",
        role: "code",
        codeOrigin: "agent_generated",
        language: "R",
        mediaType: "text/x-r-source",
        text: [
          "args <- commandArgs(trailingOnly = TRUE)",
          "input_dir <- args[[2]]",
          "output <- args[[4]]",
          "dat <- read.csv(file.path(input_dir, 'data.csv'))",
          "png(output, width = 1, height = 1)",
          "plot.new()",
          "dev.off()",
          "",
        ].join("\n"),
      },
      {
        logicalPath: "references/data.csv",
        role: "reference",
        mediaType: "text/csv",
        text: "group,value\nCluster A,1\nCluster B,2\n",
      },
      {
        logicalPath: "references/README.md",
        role: "reference",
        mediaType: "text/markdown",
        text: "# Clean-room public notes\n\nThe example table is synthetic.\n",
      },
      {
        logicalPath: "visuals/rendered/preview.png",
        role: "visual",
        visualRole: "rendered_output",
        mediaType: "image/png",
        bytes: new Uint8Array(PNG_BYTES),
      },
      {
        logicalPath: "visuals/source/private-reference.png",
        role: "visual",
        visualRole: "source_reference",
        mediaType: "image/png",
        bytes: new Uint8Array(PNG_BYTES),
      },
      {
        logicalPath: "evidence/private-assessment.md",
        role: "evidence",
        mediaType: "text/markdown",
        text: "This Local-only evidence must never enter a publication submission.\n",
      },
    ],
  };
}

async function publishedContext(root: string): Promise<{
  context: CurrentLibraryContext;
  selector: ReturnType<typeof localPublishedExactSelector>;
}> {
  await ensureLibraryRootMarker(root);
  const snapshot = await resolveLibraryRuntimeSnapshot({ root });
  const versionedLibrary = new VersionedTemplateLibrary(snapshot);
  await versionedLibrary.applyCreateWorking(
    await versionedLibrary.planCreateWorking({
      templateId: "clean-room-publication-fixture",
      candidate: safeCandidate(),
    }),
    "publication-fixture-working",
  );
  await versionedLibrary.applyPublish(
    await versionedLibrary.planPublish({ templateId: "clean-room-publication-fixture" }),
    "publication-fixture-publish",
  );
  const published = (await versionedLibrary.listPublishedCandidates())[0]!;
  return {
    context: { snapshot, versionedLibrary },
    selector: localPublishedExactSelector({
      templateId: published.templateId,
      revisionId: published.revisionId,
      contentDigest: published.contentDigest,
      releaseId: published.releaseId,
    }),
  };
}

async function startClient(
  context: CurrentLibraryContext,
  faultInjector?: Parameters<typeof registerPublicationExportTools>[0]["faultInjector"],
) {
  const server = new McpServer({ name: "publication export test", version: "0.6.0" });
  registerPublicationExportTools({
    server,
    currentLibraries: async () => context,
    ...(faultInjector ? { faultInjector } : {}),
  });
  const client = new Client({ name: "publication-export-test", version: "0.6.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

function metadata() {
  return {
    title: "Clean-room enrichment bars",
    description: "A public example generated only from neutral synthetic values.",
    application: "Compare abstract categories in a horizontal bar chart.",
    dataProfile: "A synthetic long table with group and value columns.",
    plotFamily: "bar",
    language: "R",
    tags: ["synthetic", "clean-room", "bar"],
    provenance: [
      { type: "url", value: "https://example.org/general-chart-guidance" },
      { type: "inspiration", value: "Uses a generic grouped-bar grammar without redistributing third-party media." },
    ],
  };
}

function declarations(includePrivate = false) {
  return [
    {
      logicalPath: "code/render.R",
      include: true,
      publicPath: "payload/code/render.R",
      role: "code",
      license: "MIT",
      source: "clean_room",
    },
    {
      logicalPath: "references/data.csv",
      include: true,
      publicPath: "payload/data/data.csv",
      role: "synthetic_data",
      license: "CC-BY-4.0",
      source: "synthetic",
    },
    {
      logicalPath: "references/README.md",
      include: true,
      publicPath: "payload/docs/README.md",
      role: "documentation",
      license: "CC-BY-4.0",
      source: "authored",
    },
    {
      logicalPath: "visuals/rendered/preview.png",
      include: true,
      publicPath: "payload/preview/preview.png",
      role: "generated_preview",
      license: "CC-BY-4.0",
      source: "generated",
      generatedFrom: ["code/render.R", "references/data.csv"],
    },
    includePrivate
      ? {
          logicalPath: "visuals/source/private-reference.png",
          include: true,
          publicPath: "payload/preview/private-reference.png",
          role: "generated_preview",
          license: "CC-BY-4.0",
          source: "generated",
          generatedFrom: ["code/render.R", "references/data.csv"],
        }
      : { logicalPath: "visuals/source/private-reference.png", include: false },
    { logicalPath: "evidence/private-assessment.md", include: false },
  ];
}

function rights() {
  return {
    publisher: "Fixture Publisher",
    codeRightsConfirmed: true,
    syntheticDataConfirmed: true,
    generatedPreviewConfirmed: true,
    noThirdPartyMediaConfirmed: true,
    immutableReleaseAcknowledged: true,
  };
}

function planArgs(selector: unknown, target: string, options: { includePrivate?: boolean; confirmConflicts?: boolean } = {}) {
  return {
    providerId: LOCAL_LIBRARY_PROVIDER_ID,
    exactSelector: selector,
    releaseVersion: "1.0.0",
    target,
    publicMetadata: metadata(),
    assetDeclarations: declarations(options.includePrivate),
    confirmMetadataConflicts: options.confirmConflicts ?? true,
    rightsAttestation: rights(),
  };
}

async function inventory(root: string) {
  const output: Record<string, Buffer> = {};
  const walk = async (directory: string, relativeDirectory = ""): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else output[relative] = await fs.readFile(absolute);
    }
  };
  await walk(root);
  return output;
}

test("publication export is explicit, sanitized, deterministic, and replayable", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-publication-export-"));
  const { context, selector } = await publishedContext(path.join(temporary, "library"));
  const connection = await startClient(context);
  try {
    const tools = await connection.client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "figure_library_plan_publication_export"));
    assert.ok(tools.tools.some((tool) => tool.name === "figure_library_apply_publication_export"));

    const targetA = path.join(temporary, "exports", "submission-a");
    const plannedA = await connection.client.callTool({
      name: "figure_library_plan_publication_export",
      arguments: planArgs(selector, targetA),
    });
    const planA = record(record(plannedA.structuredContent).plan);
    assert.equal(planA.written, false);
    assert.ok(Array.isArray(planA.metadataConflicts));
    assert.ok(records(planA.metadataConflicts).some((item) => item.field === "license"));
    await assert.rejects(fs.stat(targetA), { code: "ENOENT" });

    const appliedA = await connection.client.callTool({
      name: "figure_library_apply_publication_export",
      arguments: {
        planDigest: planA.planDigest,
        operationId: "publication-export-a",
        expectedTarget: targetA,
      },
    });
    assert.equal(record(record(appliedA.structuredContent).envelope).outcome, "applied");
    const outputA = await inventory(targetA);
    for (const required of [
      "submission.json",
      "licenses.json",
      "render-receipt.json",
      "inventory.jsonl",
      "payload/template.json",
      "payload/code/render.R",
      "payload/data/data.csv",
      "payload/preview/preview.png",
      "payload/docs/README.md",
    ]) {
      assert.ok(outputA[required], required);
    }
    assert.equal(Object.keys(outputA).some((name) => name.includes("private-reference") || name.includes("evidence")), false);
    const allText = Object.entries(outputA)
      .filter(([name]) => /\.(?:json|jsonl|md|r|csv)$/u.test(name))
      .map(([, bytes]) => bytes.toString("utf8"))
      .join("\n");
    assert.equal(allText.includes(context.snapshot.root), false);
    assert.equal(allText.includes("private-assessment"), false);
    assert.equal(allText.includes("private-reference.png"), false);
    assert.equal(allText.includes("library.json"), true, "the exclusion report names forbidden state without embedding it");
    const submission = record(JSON.parse(outputA["submission.json"]!.toString("utf8")));
    const parent = record(submission.parentLocalRelease);
    assert.equal(parent.relationship, "sanitized-export-from-local-published");
    assert.equal(parent.explicitlySelectedAssetsOnly, true);
    assert.equal(parent.privateLifecycleIdentifiersIncluded, false);
    assert.equal("providerId" in parent, false);
    assert.equal("sourceContentDigest" in parent, false);
    assert.equal("exactSelector" in parent, false);
    assert.equal("publicMetadata" in submission, false, "public metadata is carried by payload/template.json to match the central submission schema");
    const publicTemplate = record(JSON.parse(outputA["payload/template.json"]!.toString("utf8")));
    assert.equal("status" in publicTemplate, false, "trust status fields remain inside metadata for the archive v1 schema");
    assert.equal(record(publicTemplate.metadata).localReviewStatus, "not_reviewed");
    assert.equal(allText.includes(selector.identity.revisionId), false);
    assert.equal(allText.includes(selector.identity.releaseId), false);
    assert.equal(allText.includes(context.snapshot.libraryId ?? "missing-library-id"), false);

    const replay = await connection.client.callTool({
      name: "figure_library_apply_publication_export",
      arguments: {
        planDigest: planA.planDigest,
        operationId: "publication-export-a",
        expectedTarget: targetA,
      },
    });
    assert.equal(record(record(replay.structuredContent).envelope).outcome, "replayed");

    const targetB = path.join(temporary, "exports", "submission-b");
    const plannedB = await connection.client.callTool({
      name: "figure_library_plan_publication_export",
      arguments: planArgs(selector, targetB),
    });
    const planB = record(record(plannedB.structuredContent).plan);
    await connection.client.callTool({
      name: "figure_library_apply_publication_export",
      arguments: {
        planDigest: planB.planDigest,
        operationId: "publication-export-b",
        expectedTarget: targetB,
      },
    });
    const outputB = await inventory(targetB);
    assert.deepEqual(Object.keys(outputA).sort(), Object.keys(outputB).sort());
    for (const name of Object.keys(outputA)) assert.deepEqual(outputA[name], outputB[name], name);
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("publication Plan rejects unconfirmed parent conflicts and source-reference inclusion", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-publication-blocked-"));
  const { context, selector } = await publishedContext(path.join(temporary, "library"));
  const connection = await startClient(context);
  try {
    const unconfirmed = await connection.client.callTool({
      name: "figure_library_plan_publication_export",
      arguments: planArgs(selector, path.join(temporary, "unconfirmed"), { confirmConflicts: false }),
    });
    assert.equal(record(record(unconfirmed.structuredContent).envelope).outcome, "failed");
    assert.match(records(record(unconfirmed).content)[0]!.text as string, /conflicts require explicit confirmation/u);

    const privateReference = await connection.client.callTool({
      name: "figure_library_plan_publication_export",
      arguments: planArgs(selector, path.join(temporary, "private-reference"), { includePrivate: true }),
    });
    const privateEnvelope = record(record(privateReference.structuredContent).envelope);
    assert.equal(privateEnvelope.outcome, "blocked");
    assert.match(records(record(privateReference).content)[0]!.text as string, /source-reference/u);
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("publication Apply detects a stale source asset and writes no target", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-publication-stale-"));
  const { context, selector } = await publishedContext(path.join(temporary, "library"));
  const connection = await startClient(context);
  try {
    const target = path.join(temporary, "exports", "stale");
    const planned = await connection.client.callTool({
      name: "figure_library_plan_publication_export",
      arguments: planArgs(selector, target),
    });
    const plan = record(record(planned.structuredContent).plan);
    const code = await context.versionedLibrary.readAsset({
      templateId: selector.identity.templateId,
      revisionId: selector.identity.revisionId,
      contentDigest: selector.identity.contentDigest,
      logicalPath: "code/render.R",
    });
    const revisionDirectory = path.join(
      context.snapshot.root,
      "store",
      "templates",
      selector.identity.templateId,
      "revisions",
      selector.identity.revisionId,
    );
    const codeFile = path.join(revisionDirectory, ...code.asset.file.split("/"));
    await fs.chmod(codeFile, 0o644).catch(() => undefined);
    const original = await fs.readFile(codeFile);
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0] === 35 ? 32 : 35;
    await fs.writeFile(codeFile, tampered);
    const applied = await connection.client.callTool({
      name: "figure_library_apply_publication_export",
      arguments: {
        planDigest: plan.planDigest,
        operationId: "publication-export-stale",
        expectedTarget: target,
      },
    });
    assert.notEqual(record(record(applied.structuredContent).envelope).outcome, "applied");
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  } finally {
    await connection.client.close();
    await connection.server.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

for (const faultPoint of ["after_export_intent", "before_export_receipt"] as const) {
  test(`publication Apply recovers ${faultPoint} after a server restart`, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `sfl-publication-${faultPoint}-`));
    const { context, selector } = await publishedContext(path.join(temporary, "library"));
    let injected = false;
    const crashing = await startClient(context, async (point) => {
      if (point === faultPoint && !injected) {
        injected = true;
        throw new Error(`simulated publication crash at ${faultPoint}`);
      }
    });
    const target = path.join(temporary, "exports", faultPoint);
    const operationId = `publication-${faultPoint.replaceAll("_", "-")}`;
    let planDigest: string;
    try {
      const planned = await crashing.client.callTool({
        name: "figure_library_plan_publication_export",
        arguments: planArgs(selector, target),
      });
      planDigest = String(record(record(planned.structuredContent).plan).planDigest);
      const failed = await crashing.client.callTool({
        name: "figure_library_apply_publication_export",
        arguments: { planDigest, operationId, expectedTarget: target },
      });
      assert.equal(record(record(failed.structuredContent).envelope).outcome, "failed");
    } finally {
      await crashing.client.close();
      await crashing.server.close();
    }

    const restarted = await startClient(context);
    try {
      const recovered = await restarted.client.callTool({
        name: "figure_library_apply_publication_export",
        arguments: { planDigest: planDigest!, operationId, expectedTarget: target },
      });
      const structured = record(recovered.structuredContent);
      assert.equal(record(structured.envelope).outcome, "replayed");
      assert.equal(record(structured.envelope).code, "publication_export_recovered");
      assert.equal(structured.recovered, true);
      assert.ok((await fs.stat(path.join(target, "submission.json"))).isFile());
    } finally {
      await restarted.client.close();
      await restarted.server.close();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
}
