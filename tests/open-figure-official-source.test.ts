import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  DEFAULT_PERSONAL_MODULE_ASSETS_DIR,
  ModuleCatalogIndex,
} from "../src/module-catalog.ts";
import {
  OFFICIAL_OPEN_FIGURE_MANIFEST_URL,
  OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
  officialOpenFigurePayloadUrl,
  officialOpenFigurePaths,
  parseOfficialOpenFigurePayloadUrl,
} from "../src/open-figure-official-channel.ts";
import {
  diffOfficialCatalogs,
  fetchVerifiedOfficialOpenFigureSnapshot,
} from "../src/open-figure-feed.ts";
import { OfficialOpenFigureSourceManager } from "../src/open-figure-official-source.ts";
import {
  PROVIDER_SOURCE_MANIFEST_SCHEMA,
  SecureProviderSourceFetcher,
  ed25519PublicKeyIdentity,
  extractExactZipFiles,
  type ProviderSourceHttpsRequest,
  type RawHttpsResponse,
} from "../src/provider-source-fetch.ts";
import { createRuntimeProviderController } from "../src/provider-runtime.ts";

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const encoded = raw.toString("base64");
  return { privateKey, publicKey: encoded, keyId: ed25519PublicKeyIdentity(encoded).keyId };
}

function response(body: Uint8Array, contentType: string): RawHttpsResponse {
  return {
    statusCode: 200,
    headers: { "content-type": contentType, "content-length": String(body.byteLength) },
    body,
  };
}

async function officialFixture(options: {
  key?: ReturnType<typeof testKey>;
  sequence?: number;
  payloadCommit?: string;
  dropModule?: string;
  tombstones?: string[];
} = {}) {
  const key = options.key ?? testKey();
  const sequence = options.sequence ?? 1;
  const payloadCommit = options.payloadCommit ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const index = await ModuleCatalogIndex.load(DEFAULT_PERSONAL_MODULE_ASSETS_DIR, {
    expectedProviderId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
    validatePreviews: false,
  });
  const catalog = {
    ...index.catalog,
    modules: options.dropModule
      ? index.catalog.modules.filter((module) => module.moduleId !== options.dropModule)
      : index.catalog.modules,
  };
  const catalogBytes = Buffer.from(canonicalJson(catalog) + "\n");
  const files: Record<string, Uint8Array> = {};
  for (const module of catalog.modules) {
    files[module.preview.path] = await fs.readFile(path.join(index.assetsDir, ...module.preview.path.split("/")));
    files[module.thumbnail.path] = await fs.readFile(path.join(index.assetsDir, ...module.thumbnail.path.split("/")));
  }
  const previewsBytes = new Uint8Array(zipSync(files, { level: 0 }));
  const catalogUrl = officialOpenFigurePayloadUrl(payloadCommit, sequence, "module-catalog.json");
  const previewsUrl = officialOpenFigurePayloadUrl(payloadCommit, sequence, "module-previews.zip");
  const manifest = {
    schema: PROVIDER_SOURCE_MANIFEST_SCHEMA,
    providerId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
    sequence,
    generatedAt: "2026-09-07T00:00:00.000Z",
    catalog: { url: catalogUrl, bytes: catalogBytes.byteLength, sha256: sha256(catalogBytes), mediaType: "application/json" },
    previews: { url: previewsUrl, bytes: previewsBytes.byteLength, sha256: sha256(previewsBytes), mediaType: "application/zip" },
    authorizedNextKeys: [],
    tombstones: [...(options.tombstones ?? [])].sort(),
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const signatureBytes = Buffer.from(canonicalJson({
    schema: "figure-library.provider-source-signature.v1",
    algorithm: "Ed25519",
    keyId: key.keyId,
    manifestSha256: sha256(manifestBytes),
    signatureBase64: sign(null, manifestBytes, key.privateKey).toString("base64"),
  }));
  const routes = new Map<string, RawHttpsResponse>([
    [OFFICIAL_OPEN_FIGURE_MANIFEST_URL, response(manifestBytes, "text/plain")],
    [OFFICIAL_OPEN_FIGURE_MANIFEST_URL.replace(/source-manifest\.json$/u, "source-manifest.sig.json"), response(signatureBytes, "text/plain")],
    [catalogUrl, response(catalogBytes, "text/plain")],
    [previewsUrl, response(previewsBytes, "application/octet-stream")],
  ]);
  return { key, catalog, catalogBytes, previewsBytes, manifestBytes, routes, sequence, payloadCommit };
}

function mockFetcher(routes: Map<string, RawHttpsResponse>) {
  const request: ProviderSourceHttpsRequest = async (url) => {
    const found = routes.get(url.href);
    if (!found) throw new Error(`missing fixture route: ${url.href}`);
    return found;
  };
  return new SecureProviderSourceFetcher({
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    request,
  });
}

test("official payload URLs are commit-pinned and reject branch names", () => {
  const url = officialOpenFigurePayloadUrl("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 2, "module-catalog.json");
  assert.equal(parseOfficialOpenFigurePayloadUrl(url).sequence, 2);
  assert.throws(() => parseOfficialOpenFigurePayloadUrl(
    "https://raw.githubusercontent.com/jarxunlai/ScientificFigureLibrary-personal/open-figure-feed/snapshots/1/module-catalog.json",
  ));
});

test("extractExactZipFiles accepts declared files and rejects extras", () => {
  const body = Buffer.from("hello");
  const digest = sha256(body);
  const zip = zipSync({ "previews/demo/a.png": body }, { level: 0 });
  const files = extractExactZipFiles(zip, new Map([["previews/demo/a.png", { bytes: body.byteLength, sha256: digest }]]));
  assert.equal(files.length, 1);
  assert.throws(() => extractExactZipFiles(zip, new Map([["previews/demo/missing.png", { bytes: 1, sha256: digest }]])));
});

test("withdrawn modules require cumulative tombstones and cannot return", async () => {
  const index = await ModuleCatalogIndex.load(DEFAULT_PERSONAL_MODULE_ASSETS_DIR, { validatePreviews: false });
  const dropped = index.catalog.modules[0]!.moduleId;
  const next = { ...index.catalog, modules: index.catalog.modules.slice(1) };
  const diff = diffOfficialCatalogs({
    previous: index.catalog,
    next,
    previousTombstones: [],
    nextTombstones: [dropped],
  });
  assert.deepEqual(diff.withdrawn, [dropped]);
  assert.throws(() => diffOfficialCatalogs({
    previous: index.catalog,
    next,
    previousTombstones: [],
    nextTombstones: [],
  }));
  assert.throws(() => diffOfficialCatalogs({
    previous: next,
    next: index.catalog,
    previousTombstones: [dropped],
    nextTombstones: [dropped],
  }));
});

test("signed official feed activates without blocking startup and updates the current catalog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-figure-"));
  const key = testKey();
  const fixture = await officialFixture({ key, sequence: 1 });
  const manager = new OfficialOpenFigureSourceManager({
    paths: officialOpenFigurePaths({ env: { APPDATA: path.join(root, "cfg"), LOCALAPPDATA: path.join(root, "data") } }),
    bundledRoot: DEFAULT_PERSONAL_MODULE_ASSETS_DIR,
    fetcher: mockFetcher(fixture.routes),
    jitterRatio: 0,
    env: { NODE_TEST_CONTEXT: "1" },
    bootstrapPublicKeyBase64: key.publicKey,
  });
  await manager.load();
  const before = manager.currentIndex().catalogSha256;
  assert.equal(manager.statusDetails().activeOrigin, "bundled");
  await manager.refresh({ ignoreTtl: true });
  assert.equal(manager.statusDetails().activeOrigin, "remote-lkg");
  assert.equal(manager.currentIndex().catalogSha256, sha256(fixture.catalogBytes));
  assert.notEqual(manager.currentIndex().catalogSha256, before);
  const historical = await manager.indexForCatalogSha256(before);
  assert.ok(historical);
  manager.dispose();
});

test("auto-refresh env kill switch does not network on load or search", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-figure-kill-"));
  let networked = false;
  const fetcher = new SecureProviderSourceFetcher({
    lookup: async () => {
      networked = true;
      return [{ address: "1.1.1.1", family: 4 }];
    },
    request: async () => {
      networked = true;
      throw new Error("network should not run");
    },
  });
  const manager = new OfficialOpenFigureSourceManager({
    paths: officialOpenFigurePaths({ env: { APPDATA: path.join(root, "cfg"), LOCALAPPDATA: path.join(root, "data") } }),
    fetcher,
    env: { NODE_TEST_CONTEXT: "1", SFL_OPEN_FIGURE_AUTO_REFRESH: "0" },
  });
  await manager.load();
  manager.maybeRefresh();
  manager.scheduleBackgroundRefresh();
  await manager.refreshOnProcessStart();
  assert.equal(networked, false);
  assert.equal(manager.autoRefreshEffective(), false);
  manager.dispose();
});

test("runtime controller exposes official overlay without changing Provider identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-figure-runtime-"));
  const controller = await createRuntimeProviderController({
    officialOpenFigure: await new OfficialOpenFigureSourceManager({
      paths: officialOpenFigurePaths({ env: { APPDATA: path.join(root, "cfg"), LOCALAPPDATA: path.join(root, "data") } }),
      env: { NODE_TEST_CONTEXT: "1", SFL_OPEN_FIGURE_AUTO_REFRESH: "0" },
    }).load(),
  });
  const descriptor = controller.registry.get(OFFICIAL_OPEN_FIGURE_PROVIDER_ID).descriptor;
  assert.equal(descriptor.kind, "module-catalog");
  assert.equal(descriptor.providerId, OFFICIAL_OPEN_FIGURE_PROVIDER_ID);
  assert.equal(controller.getModuleCatalogs().get(OFFICIAL_OPEN_FIGURE_PROVIDER_ID)?.catalog.provider.providerId, OFFICIAL_OPEN_FIGURE_PROVIDER_ID);
});

test("process start refreshes immediately and later checks skip unchanged payloads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-figure-startup-"));
  const key = testKey();
  const fixture = await officialFixture({ key, sequence: 1 });
  const hits: string[] = [];
  const fetcher = new SecureProviderSourceFetcher({
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    request: async (url) => {
      hits.push(url.href);
      const found = fixture.routes.get(url.href);
      if (!found) throw new Error(`missing fixture route: ${url.href}`);
      return found;
    },
  });
  const paths = officialOpenFigurePaths({ env: { APPDATA: path.join(root, "cfg"), LOCALAPPDATA: path.join(root, "data") } });
  const first = new OfficialOpenFigureSourceManager({
    paths,
    bundledRoot: DEFAULT_PERSONAL_MODULE_ASSETS_DIR,
    fetcher,
    jitterRatio: 0,
    env: { NODE_TEST_CONTEXT: "1", SFL_OPEN_FIGURE_ALLOW_TEST_NETWORK: "1" },
    bootstrapPublicKeyBase64: key.publicKey,
  });
  await first.load();
  assert.equal(first.statusDetails().activeOrigin, "bundled");
  await first.refreshOnProcessStart();
  assert.equal(first.statusDetails().activeOrigin, "remote-lkg");
  assert.equal(first.statusDetails().templateCount, fixture.catalog.modules.length);
  assert.ok(hits.some((url) => url.endsWith("module-catalog.json")));
  assert.ok(hits.some((url) => url.endsWith("module-previews.zip")));
  first.dispose();

  const laterHits: string[] = [];
  const laterFetcher = new SecureProviderSourceFetcher({
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    request: async (url) => {
      laterHits.push(url.href);
      const found = fixture.routes.get(url.href);
      if (!found) throw new Error(`missing fixture route: ${url.href}`);
      return found;
    },
  });
  const second = new OfficialOpenFigureSourceManager({
    paths,
    bundledRoot: DEFAULT_PERSONAL_MODULE_ASSETS_DIR,
    fetcher: laterFetcher,
    jitterRatio: 0,
    env: { NODE_TEST_CONTEXT: "1", SFL_OPEN_FIGURE_ALLOW_TEST_NETWORK: "1" },
    bootstrapPublicKeyBase64: key.publicKey,
  });
  await second.load();
  assert.equal(second.statusDetails().activeOrigin, "remote-lkg");
  await second.refreshOnProcessStart();
  assert.equal(second.statusDetails().activeOrigin, "remote-lkg");
  assert.ok(laterHits.some((url) => url.endsWith("source-manifest.json")));
  assert.ok(laterHits.some((url) => url.endsWith("source-manifest.sig.json")));
  assert.equal(laterHits.some((url) => url.endsWith("module-catalog.json")), false);
  assert.equal(laterHits.some((url) => url.endsWith("module-previews.zip")), false);
  second.dispose();
});
