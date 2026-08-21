import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { PNG } from "pngjs";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  PROVIDER_SOURCE_MANIFEST_SCHEMA,
  SecureProviderSourceFetcher,
  ed25519PublicKeyIdentity,
  type RawHttpsResponse,
} from "../src/provider-source-fetch.ts";
import {
  ProviderSourceManager,
  providerSourcePaths,
  type ProviderSourceChangePlanV1,
  type ProviderSourcePaths,
} from "../src/provider-sources.ts";
import { createRuntimeProviderController } from "../src/provider-runtime.ts";
import { UnavailableProviderAdapter } from "../src/provider-registry.ts";

const PROVIDER_ID = "io.example.personal.figures";

function assertChangePlan(
  value: ProviderSourceChangePlanV1 | { status: "already_current" },
): asserts value is ProviderSourceChangePlanV1 {
  assert.ok(!("status" in value), "expected a change plan, not already_current");
}

interface TestKey {
  privateKey: KeyObject;
  publicKey: string;
  keyId: string;
}

interface FeedOptions {
  key: TestKey;
  providerId?: string;
  sequence: number;
  baseUrl?: string;
  variant?: string;
  authorizedNextKeys?: TestKey[];
  catalogFault?:
    | "missing_full_schema"
    | "noncanonical_entries"
    | "bad_status"
    | "bad_archive"
    | "bad_licenses";
}

class MockFeed {
  readonly routes = new Map<string, RawHttpsResponse>();
  requests: string[] = [];

  readonly fetcher = new SecureProviderSourceFetcher({
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    request: async (url) => {
      this.requests.push(url.href);
      const found = this.routes.get(url.href);
      if (!found) throw new Error(`unexpected mock provider URL: ${url.href}`);
      return found;
    },
    timeoutMs: 500,
  });

  publish(options: FeedOptions) {
    const base = options.baseUrl ?? "https://personal.example/source";
    const providerId = options.providerId ?? "io.example.personal.figures";
    const manifestUrl = `${base}/source-manifest.json`;
    const signatureUrl = `${base}/source-manifest.sig.json`;
    const catalogUrl = `${base}/catalog.json`;
    const previewsUrl = `${base}/previews.zip`;
    const preview = new PNG({ width: 2, height: 1 });
    preview.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
    const previewBytes = new Uint8Array(PNG.sync.write(preview));
    const templateId = "personal-volcano";
    const releaseVersion = "1.0.0";
    const templateIds = options.catalogFault === "noncanonical_entries"
      ? [templateId, "alpha-template"]
      : [templateId];
    const previewArchive: Record<string, Uint8Array> = {};
    const catalogEntries = templateIds.map((entryTemplateId) => {
      const previewPath = `thumbs/${entryTemplateId}/${releaseVersion}.png`;
      previewArchive[previewPath] = previewBytes;
      return {
        schema: "figure-library.public-template-entry.v1",
        providerId,
        templateId: entryTemplateId,
        releaseVersion,
        contentDigest: sha256(
          `${providerId}:${entryTemplateId}:${options.sequence}:${options.variant ?? "default"}`,
        ),
        title: `Personal ${entryTemplateId}`,
        description: "A signed personal Provider test template.",
        search: {
          application: "Provider source validation",
          dataProfile: "Synthetic test data",
          plotFamily: "scatter",
          language: "R",
          tags: ["personal", "test"],
          packages: ["base"],
          codeFiles: ["payload/code/render.R"],
          inputFiles: ["payload/data/input.csv"],
        },
        archive: {
          repository: "example/personal-archives",
          commit: "1".repeat(40),
          path: `archives/${entryTemplateId}/${releaseVersion}/${entryTemplateId}-${releaseVersion}.zip`,
          bytes: 1234,
          sha256: sha256(`archive:${entryTemplateId}:${options.sequence}`),
        },
        preview: {
          path: previewPath,
          bytes: previewBytes.byteLength,
          sha256: sha256(previewBytes),
          mediaType: "image/png",
          width: preview.width,
          height: preview.height,
          canonicalRgbaSha256: sha256(preview.data),
        },
        status: {
          upstreamStatus: "published",
          publisherVerified: true,
          curationStatus: "unreviewed",
          renderValidation: "publisher_attested",
          localReviewStatus: "not_reviewed",
          plotExecutionByRecipient: "not_run",
        },
        licenses: {
          code: "MIT",
          content: "CC-BY-4.0",
          documentation: "CC-BY-4.0",
        },
      };
    });
    const firstEntry = catalogEntries[0]! as Record<string, unknown>;
    if (options.catalogFault === "missing_full_schema") delete firstEntry.search;
    if (options.catalogFault === "bad_status") {
      (firstEntry.status as Record<string, unknown>).localReviewStatus = "approved";
    }
    if (options.catalogFault === "bad_archive") {
      (firstEntry.archive as Record<string, unknown>).repository = "example/wrong-archives";
    }
    if (options.catalogFault === "bad_licenses") {
      (firstEntry.licenses as Record<string, unknown>).code = "";
    }
    const previewsBytes = new Uint8Array(zipSync(previewArchive, { level: 0 }));
    const catalogBytes = Buffer.from(canonicalJson({
      schema: "figure-library.public-provider-catalog.v1",
      provider: {
        providerId,
        displayName: "Personal test provider",
        catalogRepository: "example/personal-catalog",
        archiveRepository: "example/personal-archives",
      },
      generatedAt: "2026-08-21T00:00:00.000Z",
      entries: catalogEntries,
    }));
    const manifest = {
      schema: PROVIDER_SOURCE_MANIFEST_SCHEMA,
      providerId,
      sequence: options.sequence,
      generatedAt: `2026-08-${String(Math.min(options.sequence, 28)).padStart(2, "0")}T00:00:00.000Z`,
      catalog: {
        url: catalogUrl,
        bytes: catalogBytes.byteLength,
        sha256: sha256(catalogBytes),
        mediaType: "application/json",
      },
      previews: {
        url: previewsUrl,
        bytes: previewsBytes.byteLength,
        sha256: sha256(previewsBytes),
        mediaType: "application/zip",
      },
      authorizedNextKeys: (options.authorizedNextKeys ?? []).map((next) => ({
        keyId: next.keyId,
        publicKeyBase64: next.publicKey,
      })),
      tombstones: [],
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest));
    const signature = sign(null, manifestBytes, options.key.privateKey);
    const signatureBytes = Buffer.from(canonicalJson({
      schema: "figure-library.provider-source-signature.v1",
      algorithm: "Ed25519",
      keyId: options.key.keyId,
      manifestSha256: sha256(manifestBytes),
      signatureBase64: signature.toString("base64"),
    }));
    this.routes.set(manifestUrl, rawResponse(manifestBytes, "application/json"));
    this.routes.set(signatureUrl, rawResponse(signatureBytes, "application/json"));
    this.routes.set(catalogUrl, rawResponse(catalogBytes, "application/json"));
    this.routes.set(previewsUrl, rawResponse(previewsBytes, "application/zip"));
    return { manifestUrl, signatureUrl, catalogUrl, previewsUrl, manifestSha256: sha256(manifestBytes) };
  }
}

function keyPair(): TestKey {
  const pair = generateKeyPairSync("ed25519");
  const raw = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const publicKey = raw.toString("base64");
  return {
    privateKey: pair.privateKey,
    publicKey,
    keyId: ed25519PublicKeyIdentity(publicKey).keyId,
  };
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function rawResponse(body: Uint8Array, contentType: string): RawHttpsResponse {
  return {
    statusCode: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(body.byteLength),
    },
    body,
  };
}

async function temporaryManager(feed = new MockFeed()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-provider-sources-"));
  const configRoot = path.join(root, "config");
  const dataRoot = path.join(root, "data");
  const paths: ProviderSourcePaths = {
    configRoot,
    registryFile: path.join(configRoot, "provider-sources.json"),
    dataRoot,
  };
  return {
    root,
    paths,
    feed,
    manager: new ProviderSourceManager({ paths, fetcher: feed.fetcher }),
  };
}

async function replaceActiveSnapshotWithCoherentInvalidCatalog(
  state: Awaited<ReturnType<typeof temporaryManager>>,
  key: TestKey,
) {
  const endpoints = state.feed.publish({
    key,
    sequence: 1,
    variant: "coherent-invalid-lkg",
    catalogFault: "bad_status",
  });
  const manifestBytes = Buffer.from(state.feed.routes.get(endpoints.manifestUrl)!.body);
  const signatureBytes = Buffer.from(state.feed.routes.get(endpoints.signatureUrl)!.body);
  const catalogBytes = Buffer.from(state.feed.routes.get(endpoints.catalogUrl)!.body);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const registry = JSON.parse(await fs.readFile(state.paths.registryFile, "utf8")) as Record<string, unknown>;
  const sources = registry.sources as Array<Record<string, unknown>>;
  const source = sources.find((candidate) => candidate.providerId === PROVIDER_ID)!;
  const activeSnapshot = source.activeSnapshot as Record<string, unknown>;
  const oldDirectory = path.join(
    state.paths.dataRoot,
    "snapshots",
    PROVIDER_ID,
    String(activeSnapshot.manifestSha256),
  );
  const nextManifestSha256 = sha256(manifestBytes);
  const nextDirectory = path.join(
    state.paths.dataRoot,
    "snapshots",
    PROVIDER_ID,
    nextManifestSha256,
  );
  await fs.cp(oldDirectory, nextDirectory, { recursive: true, errorOnExist: true });

  const inventoryPath = path.join(nextDirectory, "snapshot-inventory.jsonl");
  const inventory = (await fs.readFile(inventoryPath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const replacements = new Map<string, Buffer>([
    ["source-manifest.json", manifestBytes],
    ["source-manifest.sig.json", signatureBytes],
    ["catalog.json", catalogBytes],
  ]);
  for (const [relative, bytes] of replacements) {
    const target = path.join(nextDirectory, relative);
    await fs.chmod(target, 0o666).catch(() => undefined);
    await fs.writeFile(target, bytes);
    const entry = inventory.find((candidate) => candidate.localPath === relative)!;
    entry.bytes = bytes.byteLength;
    entry.sha256 = sha256(bytes);
  }
  const inventoryBytes = Buffer.from(
    `${inventory.map((entry) => canonicalJson(entry)).join("\n")}\n`,
  );
  await fs.chmod(inventoryPath, 0o666).catch(() => undefined);
  await fs.writeFile(inventoryPath, inventoryBytes);

  activeSnapshot.manifestSha256 = nextManifestSha256;
  activeSnapshot.catalogSha256 = sha256(catalogBytes);
  activeSnapshot.catalogBytes = catalogBytes.byteLength;
  activeSnapshot.inventorySha256 = sha256(inventoryBytes);
  const observed = source.observedRevisions as Array<Record<string, unknown>>;
  observed.find((candidate) => candidate.sequence === 1)!.manifestSha256 = nextManifestSha256;
  await fs.writeFile(state.paths.registryFile, `${canonicalJson(registry)}\n`, "utf8");

  assert.equal((manifest.catalog as Record<string, unknown>).sha256, sha256(catalogBytes));
  return nextDirectory;
}

test("provider source paths separate Windows and XDG config from immutable data", () => {
  const windows = providerSourcePaths({
    platform: "win32",
    homedir: "C:\\Users\\Researcher",
    env: {
      APPDATA: "D:\\Profile\\Roaming",
      LOCALAPPDATA: "D:\\Profile\\Local",
    },
  });
  assert.equal(
    windows.registryFile,
    "D:\\Profile\\Roaming\\ScientificFigureLibrary\\provider-sources.json",
  );
  assert.equal(
    windows.dataRoot,
    "D:\\Profile\\Local\\ScientificFigureLibrary\\provider-sources",
  );

  const linux = providerSourcePaths({
    platform: "linux",
    homedir: "/home/researcher",
    env: { XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "/data" },
  });
  assert.equal(linux.registryFile, "/cfg/scientific-figure-library/provider-sources.json");
  assert.equal(linux.dataRoot, "/data/scientific-figure-library/provider-sources");
});

test("Add defaults out of ordinary search and atomically activates an immutable last-known-good snapshot", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 1 });
  try {
    const plan = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: key.publicKey,
    });
    assertChangePlan(plan);
    assert.equal(plan.includeInDefaultSearch, false);
    assert.equal(plan.enabled, true);
    assert.equal(plan.snapshot?.sequence, 1);
    await assert.rejects(fs.access(state.paths.registryFile));

    const applied = await state.manager.applyChange({
      planDigest: plan.planDigest,
      operationId: "add-personal-main",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });
    assert.equal(applied.idempotentReplay, false);
    const listed = await state.manager.listSources();
    assert.equal(listed.configRevision, 1);
    assert.equal(listed.sources.length, 1);
    assert.equal(listed.sources[0]?.signingKeyId, key.keyId);
    assert.equal(listed.sources[0]?.includeInDefaultSearch, false);

    const callsBeforeOfflineList = state.feed.requests.length;
    await state.manager.listSources();
    assert.equal(state.feed.requests.length, callsBeforeOfflineList, "list must remain completely offline");

    const loaded = await state.manager.loadLastKnownGood(PROVIDER_ID);
    assert.equal(loaded.source.providerId, PROVIDER_ID);
    assert.equal(loaded.source.activeSnapshot.sequence, 1);
    const snapshotDirectory = path.join(
      state.paths.dataRoot,
      "snapshots",
      PROVIDER_ID,
      loaded.source.activeSnapshot.manifestSha256,
    );
    assert.deepEqual(
      (await fs.readdir(snapshotDirectory)).sort(),
      ["catalog.json", "previews", "snapshot-inventory.jsonl", "source-manifest.json", "source-manifest.sig.json"],
    );

    const replay = await state.manager.applyChange({
      planDigest: plan.planDigest,
      operationId: "add-personal-main",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.receiptId, applied.receiptId);
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("signed but incomplete public Catalogs never create config or immutable snapshots", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 1, catalogFault: "missing_full_schema" });
  try {
    await assert.rejects(
      () => state.manager.planChange({
        action: "add",
        expectedProviderId: PROVIDER_ID,
        manifestUrl: endpoints.manifestUrl,
        publicKeyBase64: key.publicKey,
      }),
      /Catalog|search/u,
    );
    await assert.rejects(fs.access(state.paths.registryFile));
    await assert.rejects(fs.access(path.join(state.paths.dataRoot, "snapshots")));
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("full Catalog status, archive, licenses, and canonical order fail before switching and preserve last-known-good", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 1 });
  try {
    const add = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: key.publicKey,
    });
    assertChangePlan(add);
    await state.manager.applyChange({
      planDigest: add.planDigest,
      operationId: "add-before-full-catalog-faults",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });
    const registryBefore = await fs.readFile(state.paths.registryFile);
    const snapshotRoot = path.join(state.paths.dataRoot, "snapshots", PROVIDER_ID);
    const snapshotsBefore = (await fs.readdir(snapshotRoot)).sort();

    for (const catalogFault of [
      "bad_status",
      "bad_archive",
      "bad_licenses",
      "noncanonical_entries",
    ] as const) {
      state.feed.publish({ key, sequence: 2, variant: catalogFault, catalogFault });
      await assert.rejects(
        () => state.manager.planChange({ action: "update", providerId: PROVIDER_ID }),
        /Catalog|status|archive|license|canonically ordered/u,
      );
      assert.deepEqual(await fs.readFile(state.paths.registryFile), registryBefore);
      assert.deepEqual((await fs.readdir(snapshotRoot)).sort(), snapshotsBefore);
      assert.equal((await state.manager.loadLastKnownGood(PROVIDER_ID)).source.activeSnapshot.sequence, 1);
    }
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("updates reject rollback and same-sequence equivocation without changing last-known-good", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 2 });
  try {
    const add = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: key.publicKey,
    });
    assertChangePlan(add);
    await state.manager.applyChange({
      planDigest: add.planDigest,
      operationId: "add-rollback-test",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });

    state.feed.publish({ key, sequence: 1 });
    await assert.rejects(
      () => state.manager.planChange({ action: "update", providerId: PROVIDER_ID }),
      /rollback rejected/u,
    );
    state.feed.publish({ key, sequence: 2, variant: "equivocated" });
    await assert.rejects(
      () => state.manager.planChange({ action: "update", providerId: PROVIDER_ID }),
      /equivocation/u,
    );
    const listed = await state.manager.listSources();
    assert.equal(listed.configRevision, 1);
    assert.equal(listed.sources[0]?.activeSnapshot.sequence, 2);
    assert.equal(listed.sources[0]?.activeSnapshot.manifestSha256, add.snapshot?.manifestSha256);
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("Apply re-fetches the planned remote snapshot and rejects post-Plan drift", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 1 });
  try {
    const plan = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: key.publicKey,
    });
    assertChangePlan(plan);
    const requestsAfterPlan = state.feed.requests.length;
    state.feed.publish({ key, sequence: 2, variant: "changed-after-plan" });
    await assert.rejects(
      () => state.manager.applyChange({
        planDigest: plan.planDigest,
        operationId: "remote-drift-after-plan",
        expectedAction: "add",
        expectedProviderId: PROVIDER_ID,
      }),
      /stale provider source plan/u,
    );
    assert.ok(state.feed.requests.length >= requestsAfterPlan + 2, "Apply must re-fetch before any write");
    await assert.rejects(fs.access(state.paths.registryFile));
    const plannedSnapshot = path.join(
      state.paths.dataRoot,
      "snapshots",
      PROVIDER_ID,
      plan.snapshot!.manifestSha256,
    );
    await assert.rejects(fs.access(plannedSnapshot));
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("Apply rejects a newly signed malformed full Catalog before any active switch", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 1 });
  try {
    const plan = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: key.publicKey,
    });
    assertChangePlan(plan);
    state.feed.publish({ key, sequence: 1, catalogFault: "bad_status" });
    await assert.rejects(
      () => state.manager.applyChange({
        planDigest: plan.planDigest,
        operationId: "malformed-full-catalog-after-plan",
        expectedAction: "add",
        expectedProviderId: PROVIDER_ID,
      }),
      /stale provider source plan.*status/u,
    );
    await assert.rejects(fs.access(state.paths.registryFile));
    await assert.rejects(fs.access(path.join(state.paths.dataRoot, "snapshots")));
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("Configure re-verifies changed endpoints, detects stale plans, and Remove retains snapshots", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 1 });
  try {
    const add = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: key.publicKey,
    });
    assertChangePlan(add);
    await state.manager.applyChange({
      planDigest: add.planDigest,
      operationId: "add-config-test",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });
    const snapshotDirectory = path.join(state.paths.dataRoot, "snapshots", PROVIDER_ID, add.snapshot!.manifestSha256);

    const stale = await state.manager.planChange({
      action: "configure",
      providerId: PROVIDER_ID,
      enabled: false,
    });
    assertChangePlan(stale);
    const configured = await state.manager.planChange({
      action: "configure",
      providerId: PROVIDER_ID,
      includeInDefaultSearch: true,
    });
    assertChangePlan(configured);
    await state.manager.applyChange({
      planDigest: configured.planDigest,
      operationId: "configure-default-search",
      expectedAction: "configure",
      expectedProviderId: PROVIDER_ID,
    });
    await assert.rejects(
      () => state.manager.applyChange({
        planDigest: stale.planDigest,
        operationId: "configure-stale",
        expectedAction: "configure",
        expectedProviderId: PROVIDER_ID,
      }),
      /stale provider source plan/u,
    );

    const newEndpoints = state.feed.publish({
      key,
      sequence: 2,
      baseUrl: "https://moved.example/source",
    });
    const callsBeforeMove = state.feed.requests.length;
    const moved = await state.manager.planChange({
      action: "configure",
      providerId: PROVIDER_ID,
      manifestUrl: newEndpoints.manifestUrl,
    });
    assertChangePlan(moved);
    assert.ok(state.feed.requests.length >= callsBeforeMove + 4, "endpoint Configure must fetch and verify now");
    await state.manager.applyChange({
      planDigest: moved.planDigest,
      operationId: "configure-moved-endpoint",
      expectedAction: "configure",
      expectedProviderId: PROVIDER_ID,
    });

    const remove = await state.manager.planChange({ action: "remove", providerId: PROVIDER_ID });
    assertChangePlan(remove);
    await state.manager.applyChange({
      planDigest: remove.planDigest,
      operationId: "remove-config-test",
      expectedAction: "remove",
      expectedProviderId: PROVIDER_ID,
    });
    assert.equal((await state.manager.listSources()).sources.length, 0);
    await fs.access(snapshotDirectory);
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("normal key rotation authorizes the next trusted key for subsequent updates", async () => {
  const state = await temporaryManager();
  const oldKey = keyPair();
  const nextKey = keyPair();
  const endpoints = state.feed.publish({
    key: oldKey,
    sequence: 1,
    authorizedNextKeys: [nextKey],
  });
  try {
    const add = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: oldKey.publicKey,
    });
    assertChangePlan(add);
    assert.equal(add.signingKeyId, oldKey.keyId);
    await state.manager.applyChange({
      planDigest: add.planDigest,
      operationId: "add-rotation-test",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });

    state.feed.publish({ key: nextKey, sequence: 2 });
    const update = await state.manager.planChange({ action: "update", providerId: PROVIDER_ID });
    assertChangePlan(update);
    assert.equal(update.signingKeyId, nextKey.keyId);
    await state.manager.applyChange({
      planDigest: update.planDigest,
      operationId: "update-after-rotation",
      expectedAction: "update",
      expectedProviderId: PROVIDER_ID,
    });
    assert.equal((await state.manager.listSources()).sources[0]?.activeSnapshot.sequence, 2);
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("an unlisted signing key cannot take over during normal Update", async () => {
  const state = await temporaryManager();
  const currentKey = keyPair();
  const attackerKey = keyPair();
  const endpoints = state.feed.publish({ key: currentKey, sequence: 1 });
  try {
    const add = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: currentKey.publicKey,
    });
    assertChangePlan(add);
    await state.manager.applyChange({
      planDigest: add.planDigest,
      operationId: "add-before-unauthorized-key",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });
    state.feed.publish({ key: attackerKey, sequence: 2 });
    await assert.rejects(
      () => state.manager.planChange({ action: "update", providerId: PROVIDER_ID }),
      /not independently trusted or previously authorized/u,
    );
    const source = (await state.manager.listSources()).sources[0]!;
    assert.equal(source.signingKeyId, currentKey.keyId);
    assert.equal(source.activeSnapshot.sequence, 1);
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("durable intent completes a missing receipt offline after the registry switch", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 1 });
  try {
    const add = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: key.publicKey,
    });
    assertChangePlan(add);
    const applied = await state.manager.applyChange({
      planDigest: add.planDigest,
      operationId: "durable-intent-recovery",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });
    const receipt = path.join(
      state.paths.dataRoot,
      "operations",
      "receipts",
      "durable-intent-recovery.json",
    );
    await fs.chmod(receipt, 0o666).catch(() => undefined);
    await fs.rm(receipt);
    const callsBeforeRecovery = state.feed.requests.length;
    const restarted = new ProviderSourceManager({ paths: state.paths, fetcher: state.feed.fetcher });
    const recovered = await restarted.applyChange({
      planDigest: add.planDigest,
      operationId: "durable-intent-recovery",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });
    assert.equal(recovered.idempotentReplay, true);
    assert.notEqual(recovered.receiptId, applied.receiptId);
    assert.equal(state.feed.requests.length, callsBeforeRecovery, "durable recovery must use the verified local snapshot");
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("Trust Reset requires explicit sequence-reset authority and advances the trust epoch", async () => {
  const state = await temporaryManager();
  const oldKey = keyPair();
  const newKey = keyPair();
  const endpoints = state.feed.publish({ key: oldKey, sequence: 5 });
  try {
    const add = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: oldKey.publicKey,
    });
    assertChangePlan(add);
    await state.manager.applyChange({
      planDigest: add.planDigest,
      operationId: "add-trust-reset-test",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });

    state.feed.publish({ key: newKey, sequence: 1 });
    await assert.rejects(
      () => state.manager.planChange({
        action: "trust_reset",
        providerId: PROVIDER_ID,
        publicKeyBase64: newKey.publicKey,
      }),
      /rollback rejected/u,
    );
    const reset = await state.manager.planChange({
      action: "trust_reset",
      providerId: PROVIDER_ID,
      publicKeyBase64: newKey.publicKey,
      allowSequenceReset: true,
    });
    assertChangePlan(reset);
    assert.equal(reset.allowSequenceReset, true);
    assert.equal(reset.trustEpoch, 2);
    assert.equal(reset.previousSigningKeyId, oldKey.keyId);
    assert.equal(reset.signingKeyId, newKey.keyId);
    await state.manager.applyChange({
      planDigest: reset.planDigest,
      operationId: "trust-reset-explicit-sequence",
      expectedAction: "trust_reset",
      expectedProviderId: PROVIDER_ID,
    });
    const source = (await state.manager.listSources()).sources[0]!;
    assert.equal(source.trustEpoch, 2);
    assert.equal(source.activeSnapshot.sequence, 1);
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("last-known-good loading fails closed after snapshot tampering", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 1 });
  try {
    const add = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: key.publicKey,
    });
    assertChangePlan(add);
    await state.manager.applyChange({
      planDigest: add.planDigest,
      operationId: "add-tamper-test",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });
    const signatureFile = path.join(
      state.paths.dataRoot,
      "snapshots",
      PROVIDER_ID,
      add.snapshot!.manifestSha256,
      "source-manifest.sig.json",
    );
    await fs.chmod(signatureFile, 0o666).catch(() => undefined);
    const bytes = await fs.readFile(signatureFile);
    bytes[0] = bytes[0]! ^ 1;
    await fs.writeFile(signatureFile, bytes);
    await assert.rejects(
      () => state.manager.loadLastKnownGood(PROVIDER_ID),
      /snapshot file mismatch/u,
    );
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});

test("a corrupt last-known-good snapshot becomes unavailable without a network request", async () => {
  const state = await temporaryManager();
  const key = keyPair();
  const endpoints = state.feed.publish({ key, sequence: 1 });
  try {
    const add = await state.manager.planChange({
      action: "add",
      expectedProviderId: PROVIDER_ID,
      manifestUrl: endpoints.manifestUrl,
      publicKeyBase64: key.publicKey,
    });
    assertChangePlan(add);
    await state.manager.applyChange({
      planDigest: add.planDigest,
      operationId: "add-before-offline-lkg-corruption",
      expectedAction: "add",
      expectedProviderId: PROVIDER_ID,
    });
    await replaceActiveSnapshotWithCoherentInvalidCatalog(state, key);
    state.feed.requests.length = 0;

    await assert.rejects(
      () => state.manager.loadLastKnownGood(PROVIDER_ID),
      /status is invalid/u,
    );
    const controller = await createRuntimeProviderController({ manager: state.manager });
    assert.ok(controller.registry.get(PROVIDER_ID) instanceof UnavailableProviderAdapter);
    assert.equal(state.feed.requests.length, 0, "runtime LKG degradation must remain completely offline");
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});
