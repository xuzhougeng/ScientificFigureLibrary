import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { strToU8, zipSync } from "fflate";
import { CatalogIndex } from "../src/catalog.ts";
import type { CurrentLibraryContext } from "../src/library-binding-tools.ts";
import {
  ensureLibraryRootMarker,
  resolveLibraryRuntimeSnapshot,
} from "../src/library-runtime.ts";
import { registerMaterializationTools } from "../src/materialization-tools.ts";
import { PreviewConfirmationStore } from "../src/preview-confirmation.ts";
import {
  libraryBindingDigest,
  loadProviderPreview,
  searchCatalogRevision,
} from "../src/preview-service.ts";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  exactSelectorDigest,
  figureYaExactSelector,
  localPublishedExactSelector,
} from "../src/providers.ts";
import type { ExactTemplateSelector, FigureYaCatalog, FigureYaModule } from "../src/types.ts";
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

function toolText(value: unknown) {
  const content = record(value).content;
  assert.ok(Array.isArray(content));
  return content
    .map((block) =>
      block &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
        ? ((block as Record<string, unknown>).text as string)
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function fixtureCandidate(): VersionedTemplateCandidate {
  return {
    title: "Materialization replay fixture",
    description: "A complete user-confirmed Figure Unit for exact local materialization.",
    tags: ["materialization", "scatter"],
    visualProfile: "scatter points",
    dataProfile: "x/y numeric table",
    packages: ["ggplot2"],
    license: "reference only",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "scatter",
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
        evidence: "The user explicitly confirmed the image/code pair.",
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

async function publishedContext(root: string): Promise<CurrentLibraryContext> {
  await ensureLibraryRootMarker(root);
  const snapshot = await resolveLibraryRuntimeSnapshot({ root });
  const library = new VersionedTemplateLibrary(snapshot);
  const working = await library.planCreateWorking({
    templateId: "materialization-fixture",
    candidate: fixtureCandidate(),
  });
  await library.applyCreateWorking(working, "materialization-fixture-working");
  await library.applyPublish(
    await library.planPublish({ templateId: "materialization-fixture" }),
    "materialization-fixture-publish",
  );
  return { snapshot, versionedLibrary: library };
}

async function startClient(
  context: CurrentLibraryContext | (() => Promise<CurrentLibraryContext>),
  index: CatalogIndex,
  options: {
    faultInjector?: (
      point: "after_public_intent" | "before_public_receipt",
      operation: { operationId: string; planDigest: string; providerId: string },
    ) => Promise<void> | void;
  } = {},
) {
  const server = new McpServer({ name: "Materialization tools test", version: "0.5.1" });
  const currentLibraries =
    typeof context === "function" ? context : async () => context;
  const previewConfirmations = new PreviewConfirmationStore();
  registerMaterializationTools({
    server,
    index,
    currentLibraries,
    previewConfirmations,
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  const client = new Client({ name: "materialization-tools-test", version: "0.5.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, currentLibraries, index, previewConfirmations };
}

async function confirmedReceipt(
  connection: Awaited<ReturnType<typeof startClient>>,
  providerId: string,
  exactSelector: ExactTemplateSelector,
) {
  const context = await connection.currentLibraries();
  const providerIds = [providerId];
  const catalogRevision = await searchCatalogRevision(context, connection.index, providerIds);
  const bindingDigest = libraryBindingDigest(context);
  const resultSetId = connection.previewConfirmations.registerResultSet({
    queryDigest: "materialization-test-result-set",
    catalogRevision,
    libraryBindingDigest: bindingDigest,
    providerIds,
    candidates: [{ providerId, exactSelector }],
  });
  const preview = await loadProviderPreview({
    context,
    index: connection.index,
    providerId,
    exactSelector,
  });
  const previewChallenge = connection.previewConfirmations.issueChallenge({
    resultSetId,
    providerId,
    exactSelector,
    exactSelectorDigest: exactSelectorDigest(exactSelector),
    previewSha256: preview.sha256,
    catalogRevision,
    libraryBindingDigest: bindingDigest,
  });
  return connection.previewConfirmations.confirm(previewChallenge, "headless").previewReceipt;
}

async function planMaterialization(
  connection: Awaited<ReturnType<typeof startClient>>,
  arguments_: Record<string, unknown> & {
    providerId: string;
    exactSelector: ExactTemplateSelector;
  },
) {
  const previewReceipt = await confirmedReceipt(
    connection,
    arguments_.providerId,
    arguments_.exactSelector,
  );
  return connection.client.callTool({
    name: "figure_library_plan_materialize",
    arguments: { ...arguments_, previewReceipt },
  });
}

async function figureYaFixture(root: string) {
  const moduleId = "FigureYaMaterializationReceiptFixture";
  const archive = zipSync({
    [`${moduleId}/plot.R`]: strToU8("plot(1:3)\n"),
    [`${moduleId}/example.png`]: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const module: FigureYaModule = {
    moduleId,
    title: "FigureYa materialization receipt fixture",
    requirement: "Verify authoritative materialization replay.",
    application: "test",
    inputSummary: "none",
    codeFiles: ["plot.R"],
    inputFiles: [],
    packages: [],
    files: [
      { name: "plot.R", size: 10 },
      { name: "example.png", size: 8 },
    ],
    archiveAvailable: true,
    archiveBytes: archive.byteLength,
    archiveSha256,
    archiveIdentity: "sha256",
    primaryPreview: `previews/${moduleId}.png`,
    previewBytes: ONE_PIXEL_PNG.byteLength,
    previewSha256: createHash("sha256").update(ONE_PIXEL_PNG).digest("hex"),
    previewMediaType: "image/png",
    canonicalCode: "plot.R",
    requiredFiles: ["plot.R", "example.png"],
    sourceUrl: "https://example.invalid/fixture",
    fullText: "materialization receipt fixture",
  };
  const catalog: FigureYaCatalog = {
    schema: "figure-library.figureya-catalog.v2",
    generatedAt: "2026-08-10T00:00:00.000Z",
    figureya: { repository: "https://example.invalid/FigureYa", commit: "source-commit" },
    compressed: {
      repository: "https://example.invalid/FigureYa-compressed",
      commit: "archive-commit",
    },
    citation: "fixture",
    modules: [module],
  };
  const assets = path.join(root, "figureya-assets");
  const sourcePack = path.join(root, "figureya-source-pack");
  await fs.mkdir(path.join(sourcePack, "archives"), { recursive: true });
  await fs.mkdir(path.join(assets, "previews"), { recursive: true });
  await fs.writeFile(path.join(assets, "catalog.json"), `${JSON.stringify(catalog)}\n`);
  await fs.writeFile(path.join(assets, "previews", `${moduleId}.png`), ONE_PIXEL_PNG);
  await fs.writeFile(
    path.join(assets, "figureya-preview-manifest.json"),
    `${JSON.stringify({
      schema: "figure-library.figureya-preview-manifest.v1",
      providerId: FIGUREYA_PROVIDER_ID,
      sourceRepository: catalog.figureya.repository,
      sourceCommit: catalog.figureya.commit,
      previews: [
        {
          moduleId,
          file: `previews/${moduleId}.png`,
          bytes: ONE_PIXEL_PNG.byteLength,
          sha256: createHash("sha256").update(ONE_PIXEL_PNG).digest("hex"),
          mediaType: "image/png",
        },
      ],
    })}\n`,
  );
  await fs.writeFile(path.join(sourcePack, "archives", `${moduleId}.zip`), archive);
  await fs.writeFile(
    path.join(sourcePack, "figureya-source-pack.manifest.json"),
    `${JSON.stringify({
      schema: "figure-library.source-pack.v2",
      providerId: FIGUREYA_PROVIDER_ID,
      archiveRepository: catalog.compressed.repository,
      archiveCommit: catalog.compressed.commit,
      archives: [
        {
          moduleId,
          file: `archives/${moduleId}.zip`,
          bytes: archive.byteLength,
          sha256: archiveSha256,
        },
      ],
    })}\n`,
  );
  return {
    assets,
    sourcePack,
    catalog,
    exactSelector: figureYaExactSelector(catalog, module, "template"),
    index: await CatalogIndex.load(assets),
  };
}

test("Local Published materialization plans, applies, and durably replays after restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-materialization-tools-"));
  const context = await publishedContext(path.join(root, "library"));
  const index = await CatalogIndex.load();
  const destination = path.join(root, "materialized");
  const published = (await context.versionedLibrary.listPublishedCandidates())[0];
  assert.ok(published);
  const exactSelector = localPublishedExactSelector({
    templateId: published.templateId,
    revisionId: published.revisionId,
    contentDigest: published.contentDigest,
    releaseId: published.releaseId,
  });
  const first = await startClient(context, index);
  let applyArguments: Record<string, unknown>;
  try {
    const planned = await planMaterialization(first, {
        providerId: LOCAL_LIBRARY_PROVIDER_ID,
        exactSelector,
        destination,
        allowNetwork: false,
      });
    assert.equal(planned.isError, undefined);
    const plannedStructured = record(planned.structuredContent);
    assert.equal(record(plannedStructured.envelope).outcome, "needs_user_confirmation");
    const plan = record(plannedStructured.plan);
    assert.equal(plan.written, false);
    assert.equal(plan.providerId, LOCAL_LIBRARY_PROVIDER_ID);
    assert.equal(plan.target, path.join(destination, "materialization-fixture"));
    const planText = toolText(planned);
    for (const field of [
      `PLAN_DIGEST: ${String(plan.planDigest)}`,
      `PROVIDER_ID: ${LOCAL_LIBRARY_PROVIDER_ID}`,
      `LIBRARY_ID: ${context.snapshot.libraryId}`,
      `EXACT_SELECTOR: ${JSON.stringify(exactSelector)}`,
      `TARGET: ${String(plan.target)}`,
      "ALLOW_NETWORK: false",
      "SOURCE_PACK_DIR: none",
    ]) {
      assert.ok(planText.includes(field), `materialization plan text omitted ${field}`);
    }
    applyArguments = {
      planDigest: String(plan.planDigest),
      operationId: "materialize-local-fixture",
      expectedProviderId: LOCAL_LIBRARY_PROVIDER_ID,
      expectedTarget: String(plan.target),
    };

    const applied = await first.client.callTool({
      name: "figure_library_apply_materialize",
      arguments: applyArguments,
    });
    assert.equal(record(record(applied.structuredContent).envelope).outcome, "applied");
    assert.equal(record(record(applied.structuredContent).result).replayed, false);
    const receiptFile = path.join(
      context.snapshot.root,
      "store",
      "operations",
      "receipts",
      "public-materializations",
      LOCAL_LIBRARY_PROVIDER_ID,
      "materialize-local-fixture.json",
    );
    const receiptText = await fs.readFile(receiptFile, "utf8");
    const receipt = record(JSON.parse(receiptText));
    assert.equal(receipt.schema, "figure-library.public-materialization-receipt.v1");
    assert.equal(receipt.planDigest, plan.planDigest);
    assert.equal(receipt.providerId, LOCAL_LIBRARY_PROVIDER_ID);
    assert.match(String(receipt.targetPathDigest), /^[a-f0-9]{64}$/u);
    assert.equal(receiptText.includes(root), false, "receipt leaked an absolute target path");
    assert.ok(
      (receipt.fileInventory as Array<{ file: string }>).some(
        (entry) => entry.file === "template.lock.json",
      ),
      "receipt omitted the lock from its complete inventory",
    );

    const memoryReplay = await first.client.callTool({
      name: "figure_library_apply_materialize",
      arguments: applyArguments,
    });
    assert.equal(record(record(memoryReplay.structuredContent).envelope).outcome, "replayed");
  } finally {
    await first.client.close();
    await first.server.close();
  }

  const restarted = await startClient(context, index);
  try {
    const durableReplay = await restarted.client.callTool({
      name: "figure_library_apply_materialize",
      arguments: applyArguments!,
    });
    assert.equal(record(record(durableReplay.structuredContent).envelope).outcome, "replayed");
    const result = record(record(durableReplay.structuredContent).result);
    assert.equal(result.materializationSource, "authoritative-receipt-replay");
    assert.equal(result.providerId, LOCAL_LIBRARY_PROVIDER_ID);
    assert.ok((result.files as unknown[]).includes("assets/code/plot.R"));
  } finally {
    await restarted.client.close();
    await restarted.server.close();
  }

  const codeFile = path.join(destination, "materialization-fixture", "assets", "code", "plot.R");
  await fs.chmod(codeFile, 0o644);
  await fs.writeFile(codeFile, "tampered\n");
  const corrupted = await startClient(context, index);
  try {
    const rejected = await corrupted.client.callTool({
      name: "figure_library_apply_materialize",
      arguments: applyArguments!,
    });
    const envelope = record(record(rejected.structuredContent).envelope);
    assert.equal(envelope.outcome, "conflict");
    assert.equal(envelope.retrySameCall, false);
    assert.equal(envelope.nextAction, "create_new_plan");
  } finally {
    await corrupted.client.close();
    await corrupted.server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a pre-write intent rolls a complete atomic target forward after receipt-finalize failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-materialization-intent-recovery-"));
  try {
    const context = await publishedContext(path.join(root, "library"));
    const index = await CatalogIndex.load();
    const published = (await context.versionedLibrary.listPublishedCandidates())[0];
    assert.ok(published);
    const exactSelector = localPublishedExactSelector({
      templateId: published.templateId,
      revisionId: published.revisionId,
      contentDigest: published.contentDigest,
      releaseId: published.releaseId,
    });
    const operationId = "materialize-intent-roll-forward";
    let faultInjected = false;
    const first = await startClient(context, index, {
      faultInjector(point) {
        if (point === "before_public_receipt" && !faultInjected) {
          faultInjected = true;
          throw new Error("injected public receipt finalize failure");
        }
      },
    });
    let applyArguments: Record<string, unknown>;
    let target = "";
    try {
      const planned = await planMaterialization(first, {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector,
          destination: path.join(root, "materialized"),
          allowNetwork: false,
      });
      const plan = record(record(planned.structuredContent).plan);
      target = String(plan.target);
      applyArguments = {
        planDigest: String(plan.planDigest),
        operationId,
        expectedProviderId: LOCAL_LIBRARY_PROVIDER_ID,
        expectedTarget: target,
      };
      const interrupted = await first.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: applyArguments,
      });
      assert.equal(record(record(interrupted.structuredContent).envelope).outcome, "failed");
      assert.equal((await fs.lstat(target)).isDirectory(), true);
    } finally {
      await first.client.close();
      await first.server.close();
    }

    const intentFile = path.join(
      context.snapshot.root,
      "store",
      "operations",
      "intents",
      "public-materializations",
      LOCAL_LIBRARY_PROVIDER_ID,
      `${operationId}.json`,
    );
    const receiptFile = path.join(
      context.snapshot.root,
      "store",
      "operations",
      "receipts",
      "public-materializations",
      LOCAL_LIBRARY_PROVIDER_ID,
      `${operationId}.json`,
    );
    const intentText = await fs.readFile(intentFile, "utf8");
    const intent = record(JSON.parse(intentText));
    assert.equal(intent.schema, "figure-library.public-materialization-intent.v1");
    assert.equal(record(intent.libraryContext).libraryId, context.snapshot.libraryId);
    assert.deepEqual(intent.exactSelector, exactSelector);
    assert.match(String(intent.targetPathDigest), /^[a-f0-9]{64}$/u);
    assert.equal(intentText.includes(root), false, "intent leaked an absolute target path");
    await assert.rejects(fs.lstat(receiptFile), { code: "ENOENT" });

    const restarted = await startClient(context, index);
    try {
      const recovered = await restarted.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: applyArguments!,
      });
      const structured = record(recovered.structuredContent);
      const recoveredEnvelope = record(structured.envelope);
      assert.equal(recoveredEnvelope.outcome, "replayed");
      assert.equal(recoveredEnvelope.code, "materialization_recovered");
      const result = record(structured.result);
      assert.equal(result.recovered, true);
      assert.equal(result.materializationSource, "authoritative-intent-recovery");
      assert.equal((await fs.lstat(receiptFile)).isFile(), true);
    } finally {
      await restarted.client.close();
      await restarted.server.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an intent-only operation stays blocked after restart and conflicts before a different target write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-materialization-intent-only-"));
  try {
    const context = await publishedContext(path.join(root, "library"));
    const index = await CatalogIndex.load();
    const published = (await context.versionedLibrary.listPublishedCandidates())[0];
    assert.ok(published);
    const exactSelector = localPublishedExactSelector({
      templateId: published.templateId,
      revisionId: published.revisionId,
      contentDigest: published.contentDigest,
      releaseId: published.releaseId,
    });
    const operationId = "materialize-intent-only";
    let faultInjected = false;
    const first = await startClient(context, index, {
      faultInjector(point) {
        if (point === "after_public_intent" && !faultInjected) {
          faultInjected = true;
          throw new Error("injected failure after public intent");
        }
      },
    });
    let firstApplyArguments: Record<string, unknown>;
    let firstTarget = "";
    let secondTarget = "";
    try {
      const firstPlanResult = await planMaterialization(first, {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector,
          destination: path.join(root, "first-destination"),
          allowNetwork: false,
      });
      const firstPlan = record(record(firstPlanResult.structuredContent).plan);
      firstTarget = String(firstPlan.target);
      firstApplyArguments = {
        planDigest: String(firstPlan.planDigest),
        operationId,
        expectedProviderId: LOCAL_LIBRARY_PROVIDER_ID,
        expectedTarget: firstTarget,
      };
      const interrupted = await first.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: firstApplyArguments,
      });
      assert.equal(record(record(interrupted.structuredContent).envelope).outcome, "failed");
      await assert.rejects(fs.lstat(firstTarget), { code: "ENOENT" });

      const secondPlanResult = await planMaterialization(first, {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector,
          destination: path.join(root, "second-destination"),
          allowNetwork: false,
      });
      const secondPlan = record(record(secondPlanResult.structuredContent).plan);
      secondTarget = String(secondPlan.target);
      const conflicted = await first.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: {
          planDigest: String(secondPlan.planDigest),
          operationId,
          expectedProviderId: LOCAL_LIBRARY_PROVIDER_ID,
          expectedTarget: secondTarget,
        },
      });
      const conflictEnvelope = record(record(conflicted.structuredContent).envelope);
      assert.equal(conflictEnvelope.outcome, "conflict");
      assert.equal(conflictEnvelope.nextAction, "create_new_plan");
      await assert.rejects(fs.lstat(secondTarget), { code: "ENOENT" });
    } finally {
      await first.client.close();
      await first.server.close();
    }

    const restarted = await startClient(context, index);
    try {
      const blocked = await restarted.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: firstApplyArguments!,
      });
      const blockedEnvelope = record(record(blocked.structuredContent).envelope);
      assert.equal(blockedEnvelope.outcome, "blocked");
      assert.equal(blockedEnvelope.code, "materialization_plan_not_available");
      assert.equal(blockedEnvelope.retrySameCall, false);
      await assert.rejects(fs.lstat(firstTarget), { code: "ENOENT" });
      await assert.rejects(fs.lstat(secondTarget), { code: "ENOENT" });
    } finally {
      await restarted.client.close();
      await restarted.server.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an unapplied materialization plan cannot cross a global Library rebind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-materialization-rebind-"));
  try {
    const firstContext = await publishedContext(path.join(root, "library-a"));
    const secondContext = await publishedContext(path.join(root, "library-b"));
    const published = (await firstContext.versionedLibrary.listPublishedCandidates())[0];
    assert.ok(published);
    const selector = localPublishedExactSelector({
      templateId: published.templateId,
      revisionId: published.revisionId,
      contentDigest: published.contentDigest,
      releaseId: published.releaseId,
    });
    const destination = path.join(root, "materialized");
    let active = firstContext;
    const connection = await startClient(async () => active, await CatalogIndex.load());
    try {
      const planned = await planMaterialization(connection, {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          exactSelector: selector,
          destination,
          allowNetwork: false,
      });
      const plan = record(record(planned.structuredContent).plan);
      assert.equal(
        record(plan.libraryContext).libraryId,
        firstContext.snapshot.libraryId,
      );
      const applyArguments = {
        planDigest: String(plan.planDigest),
        operationId: "materialize-after-rebind",
        expectedProviderId: LOCAL_LIBRARY_PROVIDER_ID,
        expectedTarget: String(plan.target),
      };

      active = secondContext;
      const rejected = await connection.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: applyArguments,
      });
      const rejectedEnvelope = record(record(rejected.structuredContent).envelope);
      assert.equal(rejectedEnvelope.outcome, "conflict");
      assert.equal(rejectedEnvelope.nextAction, "create_new_plan");
      await assert.rejects(fs.lstat(String(plan.target)), { code: "ENOENT" });
      await assert.rejects(
        fs.lstat(
          path.join(
            secondContext.snapshot.root,
            "store",
            "operations",
            "receipts",
            "public-materializations",
            LOCAL_LIBRARY_PROVIDER_ID,
            "materialize-after-rebind.json",
          ),
        ),
        { code: "ENOENT" },
      );

      active = firstContext;
      const applied = await connection.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: applyArguments,
      });
      assert.equal(record(record(applied.structuredContent).envelope).outcome, "applied");
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a pre-created target lock without a Library receipt cannot replay", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-materialization-figureya-replay-"));
  try {
    const context = await publishedContext(path.join(root, "library"));
    const index = await CatalogIndex.load();
    const target = path.join(root, "materialized", "FigureYaDurableReplay");
    await fs.mkdir(target, { recursive: true });
    const payload = new TextEncoder().encode("verified FigureYa payload\n");
    await fs.writeFile(path.join(target, "template.json"), payload);
    const planDigest = "b".repeat(64);
    const operationId = "materialize-figureya-fixture";
    const exactSelector = {
      schema: "figure-library.provider-selector.v1",
      providerId: FIGUREYA_PROVIDER_ID,
      kind: "figureya-module.v1",
      identity: {
        moduleId: "FigureYaDurableReplay",
        sourceCommit: "source-commit",
        archiveCommit: "archive-commit",
        archive: { algorithm: "sha256", digest: "a".repeat(64), bytes: 42 },
        mode: "template",
      },
    };
    await fs.writeFile(
      path.join(target, "template.lock.json"),
      `${JSON.stringify({
        schema: "figure-library.template-lock.v2",
        providerId: FIGUREYA_PROVIDER_ID,
        exactSelector,
        plannedSelector: exactSelector,
        operation: { operationId, planDigest },
        files: [
          {
            file: "template.json",
            bytes: payload.byteLength,
            sha256: createHash("sha256").update(payload).digest("hex"),
          },
        ],
      })}\n`,
    );

    const connection = await startClient(context, index);
    try {
      const replayed = await connection.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: {
          planDigest,
          operationId,
          expectedProviderId: FIGUREYA_PROVIDER_ID,
          expectedTarget: target,
        },
      });
      const structured = record(replayed.structuredContent);
      const envelope = record(structured.envelope);
      assert.equal(envelope.outcome, "blocked");
      assert.equal(envelope.code, "materialization_plan_not_available");
      assert.equal(envelope.retrySameCall, false);
      assert.equal(envelope.nextAction, "create_new_plan");
      assert.equal("result" in structured, false);
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FigureYa replay requires an authoritative receipt and a selector matching the current Catalog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-materialization-figureya-receipt-"));
  try {
    const context = await publishedContext(path.join(root, "library"));
    const fixture = await figureYaFixture(root);
    const destination = path.join(root, "materialized");
    const operationId = "materialize-figureya-authoritative";
    const first = await startClient(context, fixture.index);
    let applyArguments: Record<string, unknown>;
    try {
      const planned = await planMaterialization(first, {
          providerId: FIGUREYA_PROVIDER_ID,
          exactSelector: fixture.exactSelector,
          destination,
          sourcePackDir: fixture.sourcePack,
          allowNetwork: false,
      });
      const plan = record(record(planned.structuredContent).plan);
      applyArguments = {
        planDigest: String(plan.planDigest),
        operationId,
        expectedProviderId: FIGUREYA_PROVIDER_ID,
        expectedTarget: String(plan.target),
      };
      const applied = await first.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: applyArguments,
      });
      assert.equal(record(record(applied.structuredContent).envelope).outcome, "applied");
    } finally {
      await first.client.close();
      await first.server.close();
    }

    const receiptFile = path.join(
      context.snapshot.root,
      "store",
      "operations",
      "receipts",
      "public-materializations",
      FIGUREYA_PROVIDER_ID,
      `${operationId}.json`,
    );
    const receipt = record(JSON.parse(await fs.readFile(receiptFile, "utf8")));
    assert.deepEqual(receipt.plannedSelector, fixture.exactSelector);
    assert.deepEqual(receipt.exactSelector, fixture.exactSelector);
    assert.equal(String(receipt.materializationSource), "source-pack");
    assert.equal(JSON.stringify(receipt).includes(fixture.sourcePack), false);

    const restarted = await startClient(context, fixture.index);
    try {
      const replayed = await restarted.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: applyArguments!,
      });
      const structured = record(replayed.structuredContent);
      assert.equal(record(structured.envelope).outcome, "replayed");
      assert.equal(
        record(structured.result).materializationSource,
        "authoritative-receipt-replay",
      );
    } finally {
      await restarted.client.close();
      await restarted.server.close();
    }

    await fs.rm(receiptFile);
    const recoveredAfterReceiptLoss = await startClient(context, fixture.index);
    try {
      const recovered = await recoveredAfterReceiptLoss.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: applyArguments!,
      });
      const structured = record(recovered.structuredContent);
      assert.equal(record(structured.envelope).code, "materialization_recovered");
      assert.equal(record(structured.result).recovered, true);
      const recoveredReceipt = record(JSON.parse(await fs.readFile(receiptFile, "utf8")));
      assert.equal(recoveredReceipt.materializationSource, "intent-recovery");
      assert.equal(recoveredReceipt.archiveSha256, fixture.exactSelector.identity.archive.digest);
    } finally {
      await recoveredAfterReceiptLoss.client.close();
      await recoveredAfterReceiptLoss.server.close();
    }

    await fs.writeFile(
      path.join(fixture.assets, "catalog.json"),
      `${JSON.stringify({
        ...fixture.catalog,
        figureya: { ...fixture.catalog.figureya, commit: "changed-source-commit" },
      })}\n`,
    );
    const staleCatalog = await startClient(context, await CatalogIndex.load(fixture.assets));
    try {
      const rejected = await staleCatalog.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: applyArguments!,
      });
      const envelope = record(record(rejected.structuredContent).envelope);
      assert.equal(envelope.outcome, "conflict");
      assert.equal(envelope.nextAction, "create_new_plan");
    } finally {
      await staleCatalog.client.close();
      await staleCatalog.server.close();
    }

    await fs.writeFile(
      path.join(fixture.assets, "catalog.json"),
      `${JSON.stringify(fixture.catalog)}\n`,
    );
    await fs.chmod(receiptFile, 0o644);
    const invalidReceipt = { ...receipt, fileInventoryDigest: "f".repeat(64) };
    await fs.writeFile(receiptFile, `${JSON.stringify(invalidReceipt, null, 2)}\n`);
    const corruptedReceipt = await startClient(context, await CatalogIndex.load(fixture.assets));
    try {
      const rejected = await corruptedReceipt.client.callTool({
        name: "figure_library_apply_materialize",
        arguments: applyArguments!,
      });
      const envelope = record(record(rejected.structuredContent).envelope);
      assert.equal(envelope.outcome, "conflict");
      assert.equal(envelope.code, "materialization_target_conflict");
    } finally {
      await corruptedReceipt.client.close();
      await corruptedReceipt.server.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
