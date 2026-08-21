import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { PNG } from "pngjs";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  COMMUNITY_PROVIDER_ID,
  PUBLIC_TEMPLATE_LOCK_SCHEMA,
  PublicCatalogProviderAdapter,
  assertPublicTemplateSelector,
  createPublicCatalogSnapshot,
  loadBundledCommunitySnapshot,
  parsePublicProviderCatalog,
  publicTemplateSelector,
  type PublicArchiveFetcher,
  type PublicProviderCatalogV1,
  type PublicTemplateEntryV1,
} from "../src/public-catalog-provider.ts";
import type { ProviderContext } from "../src/provider-registry.ts";

function digest(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function fixturePng() {
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
  return {
    bytes: new Uint8Array(PNG.sync.write(png)),
    rgbaSha256: digest(png.data),
  };
}

function fixtureSeedContentDigest(previewBytes: Uint8Array) {
  const assets = [
    [
      "payload/code/render.R",
      Buffer.from(
        'png("../preview/preview.png", width=2, height=1); plot(1, 1); dev.off()\n',
      ),
    ],
    ["payload/data/example.csv", Buffer.from("x,y\n1,1\n", "utf8")],
    ["payload/docs/README.md", Buffer.from("# Clean-room public template\n", "utf8")],
    ["payload/preview/preview.png", previewBytes],
  ] as const;
  const rows = assets
    .map(([assetPath, bytes]) => ({
      path: assetPath,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  return digest(JSON.stringify(rows));
}

function fixtureExporterContentDigest(options: {
  providerId: string;
  templateId: string;
  releaseVersion: string;
  previewBytes: Uint8Array;
  rgbaSha256: string;
}) {
  const code = Buffer.from(
    'png("../preview/preview.png", width=2, height=1); plot(1, 1); dev.off()\n',
  );
  const data = Buffer.from("x,y\n1,1\n", "utf8");
  const docs = Buffer.from("# Clean-room public template\n", "utf8");
  const render = {
    schema: "figure-library.render-receipt.v1",
    entrypoint: "payload/code/render.R",
    inputPaths: ["payload/data/example.csv"],
    codePaths: ["payload/code/render.R"],
    previewPath: "payload/preview/preview.png",
    previewBytes: options.previewBytes.byteLength,
    previewSha256: digest(options.previewBytes),
    mediaType: "image/png",
    width: 2,
    height: 1,
    canonicalRgbaSha256: options.rgbaSha256,
    sourceExecution: "publisher_attested",
    codeExecutedBySflClient: false,
  };
  const assets = [
    ["payload/code/render.R", "code", "authored", "MIT", code],
    ["payload/data/example.csv", "synthetic_data", "synthetic", "CC-BY-4.0", data],
    ["payload/docs/README.md", "documentation", "authored", "CC-BY-4.0", docs],
    [
      "payload/preview/preview.png",
      "generated_preview",
      "generated",
      "CC-BY-4.0",
      options.previewBytes,
    ],
  ].map(([assetPath, role, source, license, bytes]) => ({
    path: assetPath as string,
    bytes: (bytes as Uint8Array).byteLength,
    sha256: digest(bytes as Uint8Array),
    role,
    license,
    source,
  }));
  return digest(
    canonicalJson({
      schema: "figure-library.public-template-content-digest.v1",
      providerId: options.providerId,
      templateId: options.templateId,
      releaseVersion: options.releaseVersion,
      metadata: { title: "Synthetic volcano plot" },
      licenses: {
        code: "MIT",
        content: "CC-BY-4.0",
        documentation: "CC-BY-4.0",
      },
      assets,
      render,
    }),
  );
}

interface Fixture {
  providerId: string;
  archiveRepository: string;
  catalogBytes: Uint8Array;
  previewManifestBytes: Uint8Array;
  previewBytes: Uint8Array;
  archiveBytes: Uint8Array;
  entry: PublicTemplateEntryV1;
}

function buildArchive(options: {
  providerId: string;
  templateId: string;
  releaseVersion: string;
  contentDigest: string;
  previewBytes: Uint8Array;
  rgbaSha256: string;
  seedSchema?: boolean;
  additions?: Record<string, Uint8Array>;
}) {
  const code = Buffer.from(
    'png("../preview/preview.png", width=2, height=1); plot(1, 1); dev.off()\n',
  );
  const data = Buffer.from("x,y\n1,1\n", "utf8");
  const docs = Buffer.from("# Clean-room public template\n", "utf8");
  const licenses = {
    schema: "figure-library.publication-licenses.v1",
    code: "MIT",
    syntheticData: "CC-BY-4.0",
    preview: "CC-BY-4.0",
    documentation: "CC-BY-4.0",
  };
  const render = options.seedSchema
    ? {
        schema: "figure-library.render-receipt.v1",
        entrypoint: "payload/code/render.R",
        inputFiles: [
          {
            path: "payload/data/example.csv",
            bytes: data.byteLength,
            sha256: digest(data),
          },
        ],
        code: {
          path: "payload/code/render.R",
          bytes: code.byteLength,
          sha256: digest(code),
          license: "MIT",
        },
        output: {
          path: "payload/preview/preview.png",
          license: "CC-BY-4.0",
        },
        publisherRuntime: {
          engine: "R",
          version: "4.5.3",
          platform: "test",
          environment: "existing-project-pixi-environment",
          packages: { base: "4.5.3" },
        },
        reviewedCiRuntime: {
          engine: "R",
          version: "4.4.3",
          image: "rocker/r-ver:4.4.3",
          deviceIndependentRenderer: "sfl-indexed-raster-v1",
          networkRequired: false,
        },
        randomSeed: null,
        previewBytes: options.previewBytes.byteLength,
        previewSha256: digest(options.previewBytes),
        mediaType: "image/png",
        width: 2,
        height: 1,
        canonicalRgbaSha256: options.rgbaSha256,
        generatedFromSubmittedCodeAndSyntheticData: true,
      }
    : {
    schema: "figure-library.render-receipt.v1",
    entrypoint: "payload/code/render.R",
    inputPaths: ["payload/data/example.csv"],
    codePaths: ["payload/code/render.R"],
    previewPath: "payload/preview/preview.png",
    previewBytes: options.previewBytes.byteLength,
    previewSha256: digest(options.previewBytes),
    mediaType: "image/png",
    width: 2,
    height: 1,
    canonicalRgbaSha256: options.rgbaSha256,
    sourceExecution: "publisher_attested",
    codeExecutedBySflClient: false,
  };
  const template = {
    schema: "figure-library.public-template-archive.v1",
    providerId: options.providerId,
    templateId: options.templateId,
    releaseVersion: options.releaseVersion,
    contentDigest: options.contentDigest,
    metadata: {
      title: "Synthetic volcano plot",
      upstreamStatus: "published",
      publisherVerified: true,
      curationStatus: options.seedSchema ? "unreviewed" : "curated",
      renderValidation: options.seedSchema ? "publisher_attested" : "ci_rendered",
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
      ...(options.seedSchema
        ? {
            contentDigestAlgorithm:
              "sha256(canonical JSON list of code, data, preview, and documentation identities)",
          }
        : {}),
    },
    licenses,
    render: options.seedSchema
      ? {
          entrypoint: "payload/code/render.R",
          inputDirectory: "payload/data",
          outputMediaType: "image/png",
          width: 2,
          height: 1,
          canonicalRgbaSha256: options.rgbaSha256,
          clientExecutionRequired: false,
        }
      : render,
    codeExecutedBySflClient: false,
  };
  const ordinaryAssets = [
    {
      path: "payload/code/render.R",
      role: options.seedSchema ? "render_code" : "code",
      include: true,
      source: options.seedSchema ? "clean_room" : "authored",
      license: "MIT",
      bytes: code.byteLength,
      sha256: digest(code),
    },
    {
      path: "payload/data/example.csv",
      role: "synthetic_data",
      include: true,
      source: "synthetic",
      license: "CC-BY-4.0",
      bytes: data.byteLength,
      sha256: digest(data),
    },
    {
      path: "payload/docs/README.md",
      role: "documentation",
      include: true,
      source: "authored",
      license: "CC-BY-4.0",
      bytes: docs.byteLength,
      sha256: digest(docs),
    },
    {
      path: "payload/preview/preview.png",
      role: "generated_preview",
      include: true,
      source: "generated",
      license: "CC-BY-4.0",
      bytes: options.previewBytes.byteLength,
      sha256: digest(options.previewBytes),
      ...(options.seedSchema
        ? {}
        : { generatedFrom: ["payload/code/render.R", "payload/data/example.csv"] }),
    },
  ];
  const templateBytes = jsonBytes(template);
  const submission = {
    schema: "figure-library.publication-submission.v1",
    providerId: options.providerId,
    templateId: options.templateId,
    releaseVersion: options.releaseVersion,
    contentDigest: options.contentDigest,
    parentLocalRelease: options.seedSchema
      ? {
          relationship: "design-and-exclusion-audit-only",
          bytesCopied: false,
          metadataCopied: false,
          privateAssetsIncluded: false,
        }
      : {
          relationship: "sanitized-export-from-local-published",
          explicitlySelectedAssetsOnly: true,
          privateLifecycleIdentifiersIncluded: false,
        },
    assets: options.seedSchema
      ? [
          {
            path: "payload/template.json",
            role: "metadata",
            include: true,
            source: "authored",
            license: "CC-BY-4.0",
            bytes: templateBytes.byteLength,
            sha256: digest(templateBytes),
          },
          ...ordinaryAssets,
        ]
      : ordinaryAssets,
    rightsAttestation: options.seedSchema
      ? {
          codeLicense: "MIT",
          contentLicense: "CC-BY-4.0",
          cleanRoomAuthored: true,
          syntheticDataOnly: true,
          previewGeneratedByIncludedCodeAndData: true,
          thirdPartyMediaIncluded: false,
          screenshotsIncluded: false,
          paperOrPdfContentIncluded: false,
          patientOrExperimentalDataIncluded: false,
        }
      : {
          publisher: "fixture publisher",
          codeRightsConfirmed: true,
          syntheticDataConfirmed: true,
          generatedPreviewConfirmed: true,
          noThirdPartyMediaConfirmed: true,
          immutableReleaseAcknowledged: true,
        },
    excludedPrivateState: ["local library identity", "absolute machine paths"],
    createdAt: "2026-08-21T00:00:00Z",
  };
  const payload = new Map<string, Uint8Array>([
    ["submission.json", jsonBytes(submission)],
    ["licenses.json", jsonBytes(licenses)],
    ["render-receipt.json", jsonBytes(render)],
    ["payload/template.json", templateBytes],
    ["payload/code/render.R", code],
    ["payload/data/example.csv", data],
    ["payload/preview/preview.png", options.previewBytes],
    ["payload/docs/README.md", docs],
    ...Object.entries(options.additions ?? {}),
  ]);
  const inventory = [...payload]
    .map(([file, bytes]) => ({ path: file, bytes: bytes.byteLength, sha256: digest(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  payload.set(
    "inventory.jsonl",
    Buffer.from(`${inventory.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8"),
  );
  return new Uint8Array(zipSync(Object.fromEntries(payload), { level: 0 }));
}

function buildFixture(options: {
  providerId?: string;
  archiveRepository?: string;
  templateId?: string;
  releaseVersion?: string;
  additions?: Record<string, Uint8Array>;
  seedSchema?: boolean;
} = {}): Fixture {
  const providerId = options.providerId ?? COMMUNITY_PROVIDER_ID;
  const archiveRepository =
    options.archiveRepository ?? "jarxunlai/ScientificFigureLibrary-community-archives";
  const templateId = options.templateId ?? "synthetic-volcano";
  const releaseVersion = options.releaseVersion ?? "1.0.0";
  const preview = fixturePng();
  const contentDigest = options.seedSchema
    ? fixtureSeedContentDigest(preview.bytes)
    : fixtureExporterContentDigest({
        providerId,
        templateId,
        releaseVersion,
        previewBytes: preview.bytes,
        rgbaSha256: preview.rgbaSha256,
      });
  const archiveBytes = buildArchive({
    providerId,
    templateId,
    releaseVersion,
    contentDigest,
    previewBytes: preview.bytes,
    rgbaSha256: preview.rgbaSha256,
    seedSchema: options.seedSchema,
    additions: options.additions,
  });
  const entry: PublicTemplateEntryV1 = {
    schema: "figure-library.public-template-entry.v1",
    providerId,
    templateId,
    releaseVersion,
    contentDigest,
    title: "Synthetic volcano plot",
    description: "A clean-room volcano plot from neutral synthetic values.",
    search: {
      application: "Differential abundance volcano visualization",
      dataProfile: "Synthetic effect size and adjusted p-value table",
      plotFamily: "volcano",
      language: "R",
      tags: ["volcano", "synthetic"],
      packages: ["graphics"],
      codeFiles: ["code/render.R"],
      inputFiles: ["data/example.csv"],
    },
    archive: {
      repository: archiveRepository,
      commit: "1234567890abcdef1234567890abcdef12345678",
      path: `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`,
      bytes: archiveBytes.byteLength,
      sha256: digest(archiveBytes),
    },
    preview: {
      path: `thumbs/${templateId}/${releaseVersion}.png`,
      bytes: preview.bytes.byteLength,
      sha256: digest(preview.bytes),
      mediaType: "image/png",
      width: 2,
      height: 1,
      canonicalRgbaSha256: preview.rgbaSha256,
    },
    status: {
      upstreamStatus: "published",
      publisherVerified: true,
      curationStatus: "curated",
      renderValidation: "ci_rendered",
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
    },
    licenses: {
      code: "MIT",
      content: "CC-BY-4.0",
      documentation: "CC-BY-4.0",
    },
  };
  const catalog: PublicProviderCatalogV1 = {
    schema: "figure-library.public-provider-catalog.v1",
    provider: {
      providerId,
      displayName: `${providerId} display`,
      catalogRepository: "example/public-catalog",
      archiveRepository,
    },
    generatedAt: "2026-08-21T00:00:00.000Z",
    entries: [entry],
  };
  const previewManifest = {
    schema: "figure-library.public-preview-manifest.v1",
    providerId,
    entries: [
      {
        templateId,
        releaseVersion,
        ...entry.preview,
      },
    ],
  };
  return {
    providerId,
    archiveRepository,
    catalogBytes: jsonBytes(catalog),
    previewManifestBytes: jsonBytes(previewManifest),
    previewBytes: preview.bytes,
    archiveBytes,
    entry,
  };
}

async function adapterFor(
  fixture: Fixture,
  options: {
    trust?: "bundled" | "signed-snapshot";
    archiveFetcher?: PublicArchiveFetcher;
    revision?: string;
  } = {},
) {
  const snapshot = await createPublicCatalogSnapshot({
    catalogBytes: fixture.catalogBytes,
    previewManifestBytes: fixture.previewManifestBytes,
    loadPreview: async (relative) => {
      assert.equal(relative, fixture.entry.preview.path);
      return fixture.previewBytes;
    },
    trust: options.trust ?? "bundled",
    sourceReference: "test/snapshot@1234567890abcdef1234567890abcdef12345678",
    revision: options.revision,
  });
  return new PublicCatalogProviderAdapter({
    snapshot,
    archiveFetcher: options.archiveFetcher,
  });
}

function context(operation = false) {
  return {
    ...(operation
      ? { materialization: { operationId: "public-op-1", planDigest: "a".repeat(64) } }
      : {}),
  } as ProviderContext;
}

test("bundled bootstrap Community snapshot is offline, pinned, and empty", async () => {
  const snapshot = await loadBundledCommunitySnapshot();
  assert.equal(snapshot.catalog.provider.providerId, COMMUNITY_PROVIDER_ID);
  assert.equal(snapshot.trust, "bundled");
  assert.equal(snapshot.revision, "be1080c4c637dbf0f3580abbbd145fd03e2491c4");
  assert.equal(snapshot.catalog.entries.length, 0);
});

test("one PublicCatalogProviderAdapter class serves bundled and signed snapshots without search network", async () => {
  const central = buildFixture();
  const personal = buildFixture({
    providerId: "io.github.example.figures",
    archiveRepository: "example/public-archives",
  });
  let networkCalls = 0;
  const forbiddenFetcher: PublicArchiveFetcher = async () => {
    networkCalls += 1;
    throw new Error("network was unexpectedly used");
  };
  const centralAdapter = await adapterFor(central, { archiveFetcher: forbiddenFetcher });
  const personalAdapter = await adapterFor(personal, {
    trust: "signed-snapshot",
    archiveFetcher: forbiddenFetcher,
  });
  const [centralResult] = await centralAdapter.search(context(), { query: "volcano" });
  const [personalResult] = await personalAdapter.search(context(), { query: "volcano" });
  assert.ok(centralResult);
  assert.ok(personalResult);
  assert.equal(networkCalls, 0);
  assert.equal(centralResult.templateId, personalResult.templateId);
  assert.notEqual(centralResult.providerId, personalResult.providerId);
  assert.notEqual(
    JSON.stringify(centralResult.exactSelector),
    JSON.stringify(personalResult.exactSelector),
  );
  await centralAdapter.resolve(context(), centralResult.exactSelector, "describe");
  await personalAdapter.resolve(context(), personalResult.exactSelector, "describe");
  await assert.rejects(
    personalAdapter.resolve(context(), centralResult.exactSelector, "describe"),
    /providerId differs/u,
  );
  const status = await personalAdapter.status(context());
  assert.equal(status.health, "ready");
  assert.equal(status.details.searchNetworkAccess, false);
});

test("Catalog, preview manifest, selector, and exact snapshot identity fail closed", async () => {
  const fixture = buildFixture();
  const parsed = parsePublicProviderCatalog(fixture.catalogBytes);
  const selector = publicTemplateSelector(parsed.entries[0]!, digest(fixture.catalogBytes));
  assert.doesNotThrow(() => assertPublicTemplateSelector(selector));
  assert.throws(
    () => assertPublicTemplateSelector({ ...selector, identity: { ...selector.identity, extra: true } }),
    /not supported/u,
  );
  const invalidCatalog = JSON.parse(Buffer.from(fixture.catalogBytes).toString("utf8"));
  invalidCatalog.entries[0].archive.commit = "main";
  assert.throws(
    () => parsePublicProviderCatalog(jsonBytes(invalidCatalog)),
    /40-hex/u,
  );
  const fourFieldStatus = JSON.parse(Buffer.from(fixture.catalogBytes).toString("utf8"));
  delete fourFieldStatus.entries[0].status.localReviewStatus;
  delete fourFieldStatus.entries[0].status.plotExecutionByRecipient;
  assert.throws(
    () => parsePublicProviderCatalog(jsonBytes(fourFieldStatus)),
    /localReviewStatus is required/u,
  );
  await assert.rejects(
    createPublicCatalogSnapshot({
      catalogBytes: fixture.catalogBytes,
      previewManifestBytes: fixture.previewManifestBytes,
      loadPreview: async () => new Uint8Array([...fixture.previewBytes, 0]),
      trust: "bundled",
      sourceReference: "test/corrupt-preview",
    }),
    /preview failed byte\/SHA-256/u,
  );

  const first = await adapterFor(fixture, { revision: "snapshot-1" });
  const [candidate] = await first.search(context(), { query: "volcano" });
  assert.ok(candidate);
  const catalogWithDifferentRawBytes = Buffer.concat([Buffer.from(" \n"), fixture.catalogBytes]);
  const secondSnapshot = await createPublicCatalogSnapshot({
    catalogBytes: catalogWithDifferentRawBytes,
    previewManifestBytes: fixture.previewManifestBytes,
    loadPreview: async () => fixture.previewBytes,
    trust: "bundled",
    sourceReference: "test/snapshot-2",
    revision: "snapshot-2",
  });
  const second = new PublicCatalogProviderAdapter({ snapshot: secondSnapshot });
  await assert.rejects(
    second.resolve(context(), candidate.exactSelector, "preview"),
    /stale public template selector/u,
  );
  assert.notDeepEqual(await first.revision(context()), await second.revision(context()));
});

test("offline preview is loaded from the verified snapshot and preserves public trust statuses", async () => {
  const fixture = buildFixture();
  const adapter = await adapterFor(fixture);
  const [candidate] = await adapter.search(context(), { query: "volcano", language: "R" });
  assert.ok(candidate);
  assert.equal(candidate.reviewStatus, "not_reviewed");
  assert.equal(candidate.executionStatus, "not_run");
  const resolved = await adapter.resolve(context(), candidate.exactSelector, "preview");
  const preview = await adapter.loadPreview(context(), resolved);
  assert.deepEqual(preview.bytes, fixture.previewBytes);
  assert.equal(preview.sha256, fixture.entry.preview.sha256);
  const description = await adapter.describe(context(), resolved);
  assert.equal(description.detail.localReviewStatus, "not_reviewed");
  assert.equal(description.detail.plotExecutionByRecipient, "not_run");
  assert.equal(description.detail.codeExecutedBySflClient, false);
});

test("public materialization is network-gated, fixed-identity, non-executing, and writes lock v3", async () => {
  const fixture = buildFixture();
  const calls: Parameters<PublicArchiveFetcher>[0][] = [];
  const adapter = await adapterFor(fixture, {
    archiveFetcher: async (request) => {
      calls.push(request);
      return fixture.archiveBytes;
    },
  });
  const [candidate] = await adapter.search(context(), { query: "volcano" });
  assert.ok(candidate);
  const resolved = await adapter.resolve(context(), candidate.exactSelector, "materialize");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-public-provider-"));
  try {
    await assert.rejects(
      adapter.stageMaterialization(context(true), resolved, root, false),
      /allowNetwork=true/u,
    );
    assert.equal(calls.length, 0);
    const result = await adapter.stageMaterialization(context(true), resolved, root, true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      "https://raw.githubusercontent.com/jarxunlai/ScientificFigureLibrary-community-archives/1234567890abcdef1234567890abcdef12345678/archives/synthetic-volcano/1.0.0/synthetic-volcano-1.0.0.zip",
    );
    assert.equal(calls[0]!.expectedBytes, fixture.archiveBytes.byteLength);
    assert.equal(calls[0]!.timeoutMs, 60_000);
    assert.deepEqual(
      (await fs.readdir(result.target)).sort(),
      [
        "code",
        "data",
        "docs",
        "licenses.json",
        "preview",
        "render-receipt.json",
        "template.json",
        "template.lock.json",
      ],
    );
    await assert.rejects(fs.access(path.join(result.target, "submission.json")));
    const lockPath = path.join(result.target, "template.lock.json");
    const lockText = await fs.readFile(lockPath, "utf8");
    const lock = JSON.parse(lockText);
    assert.equal(lock.schema, PUBLIC_TEMPLATE_LOCK_SCHEMA);
    assert.equal(lock.codeExecutedBySflClient, false);
    assert.equal(lock.status.localReviewStatus, "not_reviewed");
    assert.equal(lock.status.plotExecutionByRecipient, "not_run");
    assert.equal(lock.archive.sha256, fixture.entry.archive.sha256);
    const inventory: Array<{ file: string; bytes: number; sha256: string }> = [];
    const walk = async (directory: string, prefix = ""): Promise<void> => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) await walk(path.join(directory, item.name), relative);
        else {
          const bytes = new Uint8Array(await fs.readFile(path.join(directory, item.name)));
          inventory.push({ file: relative, bytes: bytes.byteLength, sha256: digest(bytes) });
        }
      }
    };
    await walk(result.target);
    inventory.sort((left, right) => left.file.localeCompare(right.file, "en"));
    await adapter.verifyMaterialized(context(), {
      plannedSelector: candidate.exactSelector,
      exactSelector: result.exactSelector,
      target: result.target,
      operationId: "public-op-1",
      planDigest: "a".repeat(64),
      inventory,
    });
    lock.archive.sha256 = "0".repeat(64);
    await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      adapter.verifyMaterialized(context(), {
        plannedSelector: candidate.exactSelector,
        exactSelector: result.exactSelector,
        target: result.target,
        operationId: "public-op-1",
        planDigest: "a".repeat(64),
        inventory,
      }),
      /tampered archive/u,
    );
    await fs.writeFile(lockPath, lockText);
    await fs.appendFile(path.join(result.target, "code", "render.R"), "# tampered\n");
    await assert.rejects(
      adapter.verifyMaterialized(context(), {
        plannedSelector: candidate.exactSelector,
        exactSelector: result.exactSelector,
        target: result.target,
        operationId: "public-op-1",
        planDigest: "a".repeat(64),
        inventory,
      }),
      /inventory no longer matches/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("materialization accepts the clean-room seed submission/template/render schema", async () => {
  const fixture = buildFixture({
    seedSchema: true,
    templateId: "single-cell-enrichment-bar-pathway-genes",
  });
  const adapter = await adapterFor(fixture, {
    archiveFetcher: async () => fixture.archiveBytes,
  });
  const [candidate] = await adapter.search(context(), { query: "volcano" });
  assert.ok(candidate);
  const resolved = await adapter.resolve(context(), candidate.exactSelector, "materialize");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-public-seed-schema-"));
  try {
    const result = await adapter.stageMaterialization(context(true), resolved, root, true);
    const lock = JSON.parse(
      await fs.readFile(path.join(result.target, "template.lock.json"), "utf8"),
    );
    assert.equal(lock.schema, PUBLIC_TEMPLATE_LOCK_SCHEMA);
    assert.equal(lock.codeExecutedBySflClient, false);
    assert.equal(lock.status.localReviewStatus, "not_reviewed");
    assert.equal(lock.status.plotExecutionByRecipient, "not_run");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function patchCentralEntryAsSymlink(input: Uint8Array, expectedName: string) {
  const bytes = Buffer.from(input);
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameBytes).toString("utf8");
    if (name !== expectedName) continue;
    bytes.writeUInt16LE((3 << 8) | 20, offset + 4);
    bytes.writeUInt32LE((0xa1ff << 16) >>> 0, offset + 38);
    return new Uint8Array(bytes);
  }
  throw new Error(`test ZIP entry not found: ${expectedName}`);
}

async function rejectionForArchive(archiveBytes: Uint8Array, pattern: RegExp) {
  const fixture = buildFixture();
  fixture.archiveBytes = archiveBytes;
  fixture.entry.archive.bytes = archiveBytes.byteLength;
  fixture.entry.archive.sha256 = digest(archiveBytes);
  const catalog = parsePublicProviderCatalog(fixture.catalogBytes);
  catalog.entries[0]!.archive = { ...fixture.entry.archive };
  fixture.catalogBytes = jsonBytes(catalog);
  const adapter = await adapterFor(fixture, {
    archiveFetcher: async () => archiveBytes,
  });
  const [candidate] = await adapter.search(context(), { query: "volcano" });
  const resolved = await adapter.resolve(context(), candidate!.exactSelector, "materialize");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-public-unsafe-"));
  try {
    await assert.rejects(
      adapter.stageMaterialization(context(true), resolved, root, true),
      pattern,
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("public archive rejects traversal, symlink, case-fold collision, and Windows reserved names", async () => {
  const traversal = buildFixture({ additions: { "../escape.txt": Buffer.from("escape") } });
  await rejectionForArchive(traversal.archiveBytes, /unsafe|not portable/u);

  const collision = buildFixture({ additions: { "Payload/template.json": Buffer.from("collision") } });
  await rejectionForArchive(collision.archiveBytes, /case-fold collision/u);

  const reserved = buildFixture({ additions: { "payload/docs/CON.txt": Buffer.from("reserved") } });
  await rejectionForArchive(reserved.archiveBytes, /not portable/u);

  const ordinary = buildFixture();
  const symlink = patchCentralEntryAsSymlink(
    ordinary.archiveBytes,
    "payload/code/render.R",
  );
  await rejectionForArchive(symlink, /contains a symlink/u);
});

test("public archive rejects stale content digests and ZIP CRC/header inconsistencies", async () => {
  const staleContent = buildFixture();
  const staleArchive = buildArchive({
    providerId: staleContent.providerId,
    templateId: staleContent.entry.templateId,
    releaseVersion: staleContent.entry.releaseVersion,
    contentDigest: "0".repeat(64),
    previewBytes: staleContent.previewBytes,
    rgbaSha256: staleContent.entry.preview.canonicalRgbaSha256,
  });
  await rejectionForArchive(staleArchive, /identity differs|contentDigest/u);

  const ordinary = buildFixture();
  const crcMismatch = new Uint8Array(ordinary.archiveBytes);
  const crcBuffer = Buffer.from(
    crcMismatch.buffer,
    crcMismatch.byteOffset,
    crcMismatch.byteLength,
  );
  for (let offset = 0; offset + 46 <= crcMismatch.length; offset += 1) {
    if (crcBuffer.readUInt32LE(offset) !== 0x02014b50) continue;
    crcBuffer.writeUInt32LE(
      (crcBuffer.readUInt32LE(offset + 16) ^ 1) >>> 0,
      offset + 16,
    );
    break;
  }
  await rejectionForArchive(crcMismatch, /CRC|decompressed size mismatch|header identity/u);
});

test("archive download tampering is rejected before ZIP extraction", async () => {
  const fixture = buildFixture();
  const tampered = new Uint8Array(fixture.archiveBytes);
  tampered[10] = tampered[10]! ^ 1;
  const adapter = await adapterFor(fixture, { archiveFetcher: async () => tampered });
  const [candidate] = await adapter.search(context(), { query: "volcano" });
  const resolved = await adapter.resolve(context(), candidate!.exactSelector, "materialize");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-public-tamper-"));
  try {
    await assert.rejects(
      adapter.stageMaterialization(context(true), resolved, root, true),
      /byte length or SHA-256/u,
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
