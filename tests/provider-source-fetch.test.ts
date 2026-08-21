import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import test from "node:test";
import { zipSync } from "fflate";
import { PNG } from "pngjs";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  PROVIDER_SOURCE_MANIFEST_SCHEMA,
  SecureProviderSourceFetcher,
  ed25519PublicKeyIdentity,
  fetchVerifiedProviderSourceSnapshot,
  isGloballyRoutableAddress,
  type ProviderSourceHttpsRequest,
  type ProviderSourceLookup,
  type RawHttpsResponse,
} from "../src/provider-source-fetch.ts";

interface TestKey {
  privateKey: KeyObject;
  publicKey: string;
  keyId: string;
}

interface SignedFixture {
  manifestUrl: string;
  signatureUrl: string;
  catalogUrl: string;
  previewsUrl: string;
  manifestBytes: Uint8Array;
  signatureBytes: Uint8Array;
  catalogBytes: Uint8Array;
  previewsBytes: Uint8Array;
  routes: Map<string, RawHttpsResponse>;
}

function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const raw = Buffer.from(spki).subarray(-32);
  const encoded = raw.toString("base64");
  return {
    privateKey,
    publicKey: encoded,
    keyId: ed25519PublicKeyIdentity(encoded).keyId,
  };
}

function response(body: Uint8Array, contentType: string, extras: Partial<RawHttpsResponse> = {}) {
  return {
    ...extras,
    statusCode: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      ...(extras.headers ?? {}),
    },
    body,
  } satisfies RawHttpsResponse;
}

function fixture(options: {
  key?: TestKey;
  providerId?: string;
  sequence?: number;
  catalog?: Record<string, unknown>;
  catalogBytes?: Uint8Array;
  authorizedNextKeys?: TestKey[];
  previewZipAdditions?: Record<string, Uint8Array>;
  previewBytes?: Uint8Array;
  omitDeclaredPreview?: boolean;
} = {}): SignedFixture {
  const key = options.key ?? testKey();
  const providerId = options.providerId ?? "io.example.personal.figures";
  const sequence = options.sequence ?? 1;
  const manifestUrl = "https://provider.example/source-manifest.json";
  const signatureUrl = "https://provider.example/source-manifest.sig.json";
  const catalogUrl = "https://cdn.example/catalog.json";
  const previewsUrl = "https://cdn.example/previews.zip";
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
  const previewBytes = options.previewBytes ?? new Uint8Array(PNG.sync.write(png));
  const previewPath = "thumbs/personal-volcano/1.0.0.png";
  const previewsBytes = new Uint8Array(zipSync({
    ...(options.omitDeclaredPreview ? {} : { [previewPath]: previewBytes }),
    ...(options.previewZipAdditions ?? {}),
  }, { level: 0 }));
  const catalogBytes = options.catalogBytes ?? Buffer.from(
    canonicalJson(options.catalog ?? {
      schema: "figure-library.public-provider-catalog.v1",
      provider: {
        providerId,
        displayName: "Personal figures",
        catalogRepository: "example/personal-catalog",
        archiveRepository: "example/personal-archives",
      },
      generatedAt: "2026-08-21T00:00:00.000Z",
      entries: [{
        schema: "figure-library.public-template-entry.v1",
        providerId,
        templateId: "personal-volcano",
        releaseVersion: "1.0.0",
        contentDigest: sha256(Buffer.from(`content:${sequence}`)),
        preview: {
          path: previewPath,
          bytes: previewBytes.byteLength,
          sha256: sha256(previewBytes),
          mediaType: "image/png",
          width: png.width,
          height: png.height,
          canonicalRgbaSha256: sha256(png.data),
        },
      }],
    }),
  );
  const manifest = {
    schema: PROVIDER_SOURCE_MANIFEST_SCHEMA,
    providerId,
    sequence,
    generatedAt: "2026-08-21T00:00:00.000Z",
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
  const signature = sign(null, manifestBytes, key.privateKey);
  const signatureBytes = Buffer.from(canonicalJson({
    schema: "figure-library.provider-source-signature.v1",
    algorithm: "Ed25519",
    keyId: key.keyId,
    manifestSha256: sha256(manifestBytes),
    signatureBase64: signature.toString("base64"),
  }));
  const routes = new Map<string, RawHttpsResponse>([
    [manifestUrl, response(manifestBytes, "application/json")],
    [signatureUrl, response(signatureBytes, "application/json")],
    [catalogUrl, response(catalogBytes, "application/json")],
    [previewsUrl, response(previewsBytes, "application/zip")],
  ]);
  return {
    manifestUrl,
    signatureUrl,
    catalogUrl,
    previewsUrl,
    manifestBytes,
    signatureBytes,
    catalogBytes,
    previewsBytes,
    routes,
  };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function mockFetcher(
  routes: Map<string, RawHttpsResponse>,
  options: {
    lookup?: ProviderSourceLookup;
    request?: ProviderSourceHttpsRequest;
    timeoutMs?: number;
    maxRedirects?: number;
  } = {},
) {
  const lookup = options.lookup ?? (async () => [{ address: "1.1.1.1", family: 4 as const }]);
  const request = options.request ?? (async (url) => {
    const found = routes.get(url.href);
    if (!found) throw new Error(`unexpected mock URL: ${url.href}`);
    return found;
  });
  return new SecureProviderSourceFetcher({
    lookup,
    request,
    timeoutMs: options.timeoutMs ?? 500,
    maxRedirects: options.maxRedirects,
  });
}

async function verifyFixture(item: SignedFixture, key: TestKey, expectedProviderId = "io.example.personal.figures") {
  return fetchVerifiedProviderSourceSnapshot({
    fetcher: mockFetcher(item.routes),
    manifestUrl: item.manifestUrl,
    expectedProviderId,
    trustedKeys: [ed25519PublicKeyIdentity(key.publicKey)],
  });
}

test("signed provider snapshots bind the signature to the exact raw manifest bytes", async () => {
  const key = testKey();
  const item = fixture({ key });
  const verified = await verifyFixture(item, key);
  assert.equal(verified.manifest.providerId, "io.example.personal.figures");
  assert.equal(verified.manifest.sequence, 1);
  assert.equal(verified.signingKey.keyId, key.keyId);
  assert.equal(verified.previewFiles.length, 1);
  assert.deepEqual(verified.catalogBytes, item.catalogBytes);

  const changed = fixture({ key });
  changed.routes.set(
    changed.manifestUrl,
    response(Buffer.concat([Buffer.from(changed.manifestBytes), Buffer.from("\n")]), "application/json"),
  );
  await assert.rejects(() => verifyFixture(changed, key), /manifestSha256 does not match/u);

  const wrongKey = testKey();
  await assert.rejects(() => verifyFixture(item, wrongKey), /not independently trusted/u);

  item.routes.set(
    item.signatureUrl,
    response(Buffer.from("{}"), "application/json"),
  );
  await assert.rejects(() => verifyFixture(item, key), /unsupported provider source signature schema/u);
});

test("signed provider snapshots reject manifest and catalog identity mismatches", async () => {
  const key = testKey();
  const wrongId = fixture({ key });
  await assert.rejects(
    () => verifyFixture(wrongId, key, "io.example.other"),
    /manifest providerId does not match/u,
  );

  const wrongProvider = fixture({
    key,
    providerId: "io.example.expected",
    catalog: {
      schema: "figure-library.public-provider-catalog.v1",
      provider: { providerId: "io.example.other" },
      entries: [],
    },
  });
  await assert.rejects(
    () => verifyFixture(wrongProvider, key, "io.example.expected"),
    /catalog providerId does not match/u,
  );

  const corrupted = fixture({ key });
  const original = corrupted.routes.get(corrupted.catalogUrl)!;
  const changedBody = Buffer.from(original.body);
  changedBody[changedBody.byteLength - 1] = changedBody[changedBody.byteLength - 1]! ^ 1;
  corrupted.routes.set(
    corrupted.catalogUrl,
    response(changedBody, "application/json"),
  );
  await assert.rejects(() => verifyFixture(corrupted, key), /catalog identity does not match/u);
});

test("the signed manifest exposes only explicitly authorized next keys", async () => {
  const oldKey = testKey();
  const nextKey = testKey();
  const rotating = fixture({ key: oldKey, authorizedNextKeys: [nextKey] });
  const verified = await verifyFixture(rotating, oldKey);
  assert.deepEqual(verified.authorizedNextKeys.map((item) => item.keyId), [nextKey.keyId]);
});

test("preview ZIP must exactly cover catalog previews and contain valid pinned PNG bytes", async () => {
  const key = testKey();
  await assert.rejects(
    () => verifyFixture(fixture({
      key,
      previewZipAdditions: { "thumbs/undeclared/1.0.0.png": Buffer.from("extra") },
    }), key),
    /undeclared file/u,
  );
  await assert.rejects(
    () => verifyFixture(fixture({ key, omitDeclaredPreview: true }), key),
    /missing catalog preview/u,
  );
  await assert.rejects(
    () => verifyFixture(fixture({ key, previewBytes: Buffer.from("not a png") }), key),
    /not PNG/u,
  );
  await assert.rejects(
    () => verifyFixture(fixture({ key, previewZipAdditions: { "../escape.png": Buffer.from("x") } }), key),
    /unsafe (?:portable )?preview ZIP/u,
  );
  await assert.rejects(
    () => verifyFixture(fixture({ key, previewZipAdditions: { "thumbs/CON/1.0.0.png": Buffer.from("x") } }), key),
    /unsafe portable preview ZIP segment/u,
  );
});

test("provider source address policy rejects local, private, documentation, and transition ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isGloballyRoutableAddress(address), false, address);
  }
  assert.equal(isGloballyRoutableAddress("1.1.1.1"), true);
  assert.equal(isGloballyRoutableAddress("8.8.8.8"), true);
  assert.equal(isGloballyRoutableAddress("2606:4700:4700::1111"), true);
});

test("secure fetch rejects unsafe URLs, mixed DNS answers, and redirect rebinding", async () => {
  const empty = new Map<string, RawHttpsResponse>();
  const safe = mockFetcher(empty);
  await assert.rejects(
    () => safe.fetch("http://provider.example/data", { maxBytes: 10, mediaTypes: ["application/json"] }),
    /requires public HTTPS/u,
  );
  await assert.rejects(
    () => safe.fetch("https://user:pass@provider.example/data", { maxBytes: 10, mediaTypes: ["application/json"] }),
    /cannot contain credentials/u,
  );
  await assert.rejects(
    () => safe.fetch("https://localhost/data", { maxBytes: 10, mediaTypes: ["application/json"] }),
    /hostname is not public/u,
  );

  const mixed = mockFetcher(empty, {
    lookup: async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  });
  await assert.rejects(
    () => mixed.fetch("https://provider.example/data", { maxBytes: 10, mediaTypes: ["application/json"] }),
    /non-public address/u,
  );

  const redirectRoutes = new Map<string, RawHttpsResponse>([
    [
      "https://provider.example/data",
      { statusCode: 302, headers: { location: "https://internal.example/data" }, body: new Uint8Array() },
    ],
  ]);
  const rebound = mockFetcher(redirectRoutes, {
    lookup: async (hostname) => hostname === "provider.example"
      ? [{ address: "1.1.1.1", family: 4 }]
      : [{ address: "10.0.0.9", family: 4 }],
  });
  await assert.rejects(
    () => rebound.fetch("https://provider.example/data", { maxBytes: 10, mediaTypes: ["application/json"] }),
    /non-public address/u,
  );
});

test("secure fetch enforces redirect, timeout, size, encoding, and MIME limits", async () => {
  const loopRoutes = new Map<string, RawHttpsResponse>([
    [
      "https://provider.example/a",
      { statusCode: 302, headers: { location: "/b" }, body: new Uint8Array() },
    ],
    [
      "https://provider.example/b",
      { statusCode: 302, headers: { location: "/a" }, body: new Uint8Array() },
    ],
  ]);
  await assert.rejects(
    () => mockFetcher(loopRoutes).fetch("https://provider.example/a", {
      maxBytes: 10,
      mediaTypes: ["application/json"],
    }),
    /redirect loop/u,
  );

  const oversized = new Map<string, RawHttpsResponse>([
    [
      "https://provider.example/data",
      response(Buffer.from("too-large"), "application/json", {
        headers: { "content-length": "999" },
      }),
    ],
  ]);
  await assert.rejects(
    () => mockFetcher(oversized).fetch("https://provider.example/data", {
      maxBytes: 8,
      mediaTypes: ["application/json"],
    }),
    /Content-Length is invalid or too large/u,
  );

  const compressed = new Map<string, RawHttpsResponse>([
    [
      "https://provider.example/data",
      response(Buffer.from("{}"), "application/json", {
        headers: { "content-encoding": "gzip" },
      }),
    ],
  ]);
  await assert.rejects(
    () => mockFetcher(compressed).fetch("https://provider.example/data", {
      maxBytes: 8,
      mediaTypes: ["application/json"],
    }),
    /unsupported content encoding/u,
  );

  const wrongMime = new Map<string, RawHttpsResponse>([
    ["https://provider.example/data", response(Buffer.from("{}"), "text/html")],
  ]);
  await assert.rejects(
    () => mockFetcher(wrongMime).fetch("https://provider.example/data", {
      maxBytes: 8,
      mediaTypes: ["application/json"],
    }),
    /unsupported MIME type/u,
  );

  const timedOut = mockFetcher(new Map(), {
    timeoutMs: 100,
    request: async () => new Promise<RawHttpsResponse>(() => undefined),
  });
  await assert.rejects(
    () => timedOut.fetch("https://provider.example/data", {
      maxBytes: 8,
      mediaTypes: ["application/json"],
    }),
    /timed out after 100ms/u,
  );
});
