import { createHash, createPublicKey, verify } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { unzipSync, type UnzipFileInfo } from "fflate";
import { PNG } from "pngjs";
import { canonicalJson } from "./canonical-json.ts";
import { assertPortableFilesystemSegment, portableCaseFold } from "./library-runtime.ts";
import { STRICT_SEMVER } from "./semver.ts";

export const PROVIDER_SOURCE_MANIFEST_SCHEMA =
  "figure-library.provider-source-manifest.v1" as const;
export const PROVIDER_SOURCE_SIGNATURE_SCHEMA =
  "figure-library.provider-source-signature.v1" as const;
export const PUBLIC_PROVIDER_CATALOG_SCHEMA =
  "figure-library.public-provider-catalog.v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/u;
const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]$/u;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES = 64 * 1024 * 1024;
// pngjs normalizes every decoded preview to RGBA and can use eight bytes per
// pixel while handling 16-bit PNG input. Keep that allocation inside the same
// 64 MiB single-file safety boundary used by Provider payloads.
const MAX_PREVIEW_PIXELS = MAX_PREVIEW_FILE_BYTES / 8;
const MAX_PREVIEW_FILES = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_REDIRECTS = 3;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} must be a positive safe integer no larger than ${maximum}`);
  }
  return Number(value);
}

function nonEmptyString(value: unknown, label: string, maximum = 4_000) {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum}`);
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes, label)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`);
    throw error;
  }
}

function assertPersonalProviderId(value: unknown, label: string) {
  const providerId = nonEmptyString(value, label, 128);
  if (!PROVIDER_ID.test(providerId)) throw new Error(`${label} is not a valid providerId`);
  if (
    providerId === "org.figureya.module" ||
    providerId.startsWith("org.figureya.") ||
    providerId === "org.scientificfigurelibrary.local" ||
    providerId.startsWith("org.scientificfigurelibrary.") ||
    providerId === "io.github.jarxunlai.scientific-figure-community"
  ) {
    throw new Error(`personal provider cannot claim reserved providerId: ${providerId}`);
  }
  return providerId;
}

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export interface RawHttpsResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

export interface SecureHttpsRequestOptions {
  addresses: PinnedAddress[];
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export type ProviderSourceLookup = (hostname: string) => Promise<PinnedAddress[]>;
export type ProviderSourceHttpsRequest = (
  url: URL,
  options: SecureHttpsRequestOptions,
) => Promise<RawHttpsResponse>;

export interface SecureProviderSourceFetcherOptions {
  lookup?: ProviderSourceLookup;
  request?: ProviderSourceHttpsRequest;
  timeoutMs?: number;
  maxRedirects?: number;
}

function parseIpv4(address: string) {
  if (net.isIP(address) !== 4) return undefined;
  const parts = address.split(".").map(Number);
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0;
}

function ipv4InCidr(value: number, base: string, prefix: number) {
  const baseValue = parseIpv4(base);
  if (baseValue === undefined) throw new Error(`invalid internal IPv4 CIDR base: ${base}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function parseIpv6(address: string): bigint | undefined {
  const withoutZone = address.split("%")[0]!.toLowerCase();
  if (net.isIP(withoutZone) !== 6) return undefined;
  const mapped = withoutZone.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/u);
  let normalized = withoutZone;
  if (mapped) {
    const ipv4 = parseIpv4(mapped[2]!);
    if (ipv4 === undefined) return undefined;
    normalized = `${mapped[1]}${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((item) => !/^[a-f0-9]{1,4}$/u.test(item))) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(value: bigint, base: string, prefix: number) {
  const baseValue = parseIpv6(base);
  if (baseValue === undefined) throw new Error(`invalid internal IPv6 CIDR base: ${base}`);
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (baseValue >> shift);
}

export function isGloballyRoutableAddress(address: string) {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) {
    return ![
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.31.196.0", 24],
      ["192.52.193.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["192.175.48.0", 24],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, prefix]) => ipv4InCidr(ipv4, String(base), Number(prefix)));
  }
  const ipv6 = parseIpv6(address);
  if (ipv6 === undefined) return false;
  if (ipv6InCidr(ipv6, "::ffff:0:0", 96)) {
    return isGloballyRoutableAddress(
      `${Number((ipv6 >> 24n) & 0xffn)}.${Number((ipv6 >> 16n) & 0xffn)}.${Number((ipv6 >> 8n) & 0xffn)}.${Number(ipv6 & 0xffn)}`,
    );
  }
  if (!ipv6InCidr(ipv6, "2000::", 3)) return false;
  return ![
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["2620:4f:8000::", 48],
    ["3fff::", 20],
  ].some(([base, prefix]) => ipv6InCidr(ipv6, String(base), Number(prefix)));
}

function assertSafeHttpsUrl(value: string, label = "provider source URL") {
  if (value.length > 4_000) throw new Error(`${label} is too long`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid: ${value}`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} requires public HTTPS`);
  if (url.username || url.password) throw new Error(`${label} cannot contain credentials`);
  if (url.hash) throw new Error(`${label} cannot contain a fragment`);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    /\.(?:localhost|local|internal|home|lan)$/u.test(hostname)
  ) {
    throw new Error(`${label} hostname is not public: ${url.hostname}`);
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${label} has an invalid port`);
    }
  }
  return url;
}

export function deriveProviderSourceSignatureUrl(manifestUrl: string) {
  const url = assertSafeHttpsUrl(manifestUrl, "provider source manifest URL");
  if (path.posix.basename(url.pathname) !== "source-manifest.json") {
    throw new Error("provider source manifest URL basename must be source-manifest.json");
  }
  const directory = path.posix.dirname(url.pathname).replace(/\/$/u, "");
  url.pathname = `${directory}/source-manifest.sig.json`;
  return url.href;
}

async function defaultLookup(hostname: string) {
  const directFamily = net.isIP(hostname);
  if (directFamily) {
    return [{ address: hostname, family: directFamily as 4 | 6 }];
  }
  const values = await dnsLookup(hostname, { all: true, verbatim: true });
  return values.map((value) => ({ address: value.address, family: value.family as 4 | 6 }));
}

function headerValue(headers: RawHttpsResponse["headers"], name: string) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  if (Array.isArray(found)) return found[0];
  return found;
}

async function defaultHttpsRequest(url: URL, options: SecureHttpsRequestOptions) {
  const selected = options.addresses[0];
  if (!selected) throw new Error("provider source DNS resolution returned no address");
  return new Promise<RawHttpsResponse>((resolve, reject) => {
    let settled = false;
    let responseEnded = false;
    const abort = () => request.destroy(new Error("provider source HTTPS request was aborted"));
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const request = https.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json, application/octet-stream;q=0.9",
          "Accept-Encoding": "identity",
          "User-Agent": "ScientificFigureLibrary-provider-source/0.6",
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, selected.address, selected.family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > options.maxBytes) {
            request.destroy(new Error(`provider source response exceeds ${options.maxBytes} bytes`));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          responseEnded = true;
          finish(() => resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: new Uint8Array(Buffer.concat(chunks)),
          }));
        });
        response.on("aborted", () => {
          finish(() => reject(new Error("provider source HTTPS response was aborted before completion")));
        });
        response.on("error", (error) => finish(() => reject(error)));
        response.on("close", () => {
          if (!responseEnded) {
            finish(() => reject(new Error("provider source HTTPS response closed before completion")));
          }
        });
      },
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`provider source request timed out after ${options.timeoutMs}ms`));
    });
    request.on("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class SecureProviderSourceFetcher {
  private readonly lookup: ProviderSourceLookup;
  private readonly request: ProviderSourceHttpsRequest;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  constructor(options: SecureProviderSourceFetcherOptions = {}) {
    this.lookup = options.lookup ?? defaultLookup;
    this.request = options.request ?? defaultHttpsRequest;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_REDIRECTS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new Error("provider source timeout must be between 100 and 120000 milliseconds");
    }
    if (!Number.isSafeInteger(this.maxRedirects) || this.maxRedirects < 0 || this.maxRedirects > 3) {
      throw new Error("provider source redirect limit must be between 0 and 3");
    }
  }

  async fetch(
    rawUrl: string,
    options: { maxBytes: number; mediaTypes: string[] },
  ): Promise<{ url: string; bytes: Uint8Array; mediaType: string; accessUrls: string[] }> {
    const visited = new Set<string>();
    const accessUrls: string[] = [];
    let current = assertSafeHttpsUrl(rawUrl);
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      if (visited.has(current.href)) throw new Error("provider source redirect loop detected");
      visited.add(current.href);
      accessUrls.push(current.href);
      const addresses = await promiseWithTimeout(
        this.lookup(current.hostname.replace(/^\[|\]$/gu, "")),
        this.timeoutMs,
        "provider source DNS lookup",
      );
      if (!addresses.length) throw new Error("provider source DNS resolution returned no address");
      for (const address of addresses) {
        if ((address.family !== 4 && address.family !== 6) || !isGloballyRoutableAddress(address.address)) {
          throw new Error(`provider source resolved to a non-public address: ${address.address}`);
        }
      }
      const abortController = new AbortController();
      const response = await promiseWithTimeout(
        this.request(current, {
          addresses: addresses.map((value) => ({ ...value })),
          timeoutMs: this.timeoutMs,
          maxBytes: options.maxBytes,
          signal: abortController.signal,
        }),
        this.timeoutMs,
        "provider source HTTPS request",
        () => abortController.abort(),
      );
      const contentEncoding = headerValue(response.headers, "content-encoding")?.toLowerCase();
      if (contentEncoding && contentEncoding !== "identity") {
        throw new Error(`provider source response uses unsupported content encoding: ${contentEncoding}`);
      }
      const declaredLength = headerValue(response.headers, "content-length");
      if (declaredLength !== undefined) {
        if (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > options.maxBytes) {
          throw new Error("provider source Content-Length is invalid or too large");
        }
        if (Number(declaredLength) !== response.body.byteLength) {
          throw new Error("provider source Content-Length does not match the received body");
        }
      }
      if (response.body.byteLength > options.maxBytes) {
        throw new Error(`provider source response exceeds ${options.maxBytes} bytes`);
      }
      const redirectLocation = headerValue(response.headers, "location");
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (!redirectLocation) throw new Error("provider source redirect omitted Location");
        if (redirect === this.maxRedirects) throw new Error("provider source redirect limit exceeded");
        current = assertSafeHttpsUrl(new URL(redirectLocation, current).href);
        continue;
      }
      if (response.statusCode !== 200) {
        throw new Error(`provider source HTTPS request failed with status ${response.statusCode}`);
      }
      const mediaType = (headerValue(response.headers, "content-type") ?? "")
        .split(";", 1)[0]!
        .trim()
        .toLowerCase();
      if (!options.mediaTypes.includes(mediaType)) {
        throw new Error(`provider source response has unsupported MIME type: ${mediaType || "missing"}`);
      }
      return { url: current.href, bytes: response.body, mediaType, accessUrls };
    }
    throw new Error("provider source redirect limit exceeded");
  }
}

export interface Ed25519PublicKeyIdentity {
  algorithm: "ed25519";
  publicKeyBase64: string;
  keyId: string;
}

export function ed25519PublicKeyIdentity(publicKeyBase64: string): Ed25519PublicKeyIdentity {
  const bytes = Buffer.from(publicKeyBase64, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== publicKeyBase64) {
    throw new Error("Ed25519 public key must be canonical base64 for exactly 32 raw bytes");
  }
  return { algorithm: "ed25519", publicKeyBase64, keyId: sha256(bytes) };
}

export function verifyEd25519Detached(
  rawBytes: Uint8Array,
  signature: Uint8Array,
  identity: Ed25519PublicKeyIdentity,
) {
  if (signature.byteLength !== 64) throw new Error("Ed25519 detached signature must be 64 bytes");
  const rawKey = Buffer.from(identity.publicKeyBase64, "base64");
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, rawBytes, key, signature)) {
    throw new Error(`provider source Ed25519 signature verification failed for key ${identity.keyId}`);
  }
}

export interface RemotePayloadV1 {
  url: string;
  bytes: number;
  sha256: string;
  mediaType: "application/json" | "application/zip";
}

export interface ProviderSourceManifestV1 {
  schema: typeof PROVIDER_SOURCE_MANIFEST_SCHEMA;
  providerId: string;
  sequence: number;
  generatedAt: string;
  catalog: RemotePayloadV1 & { mediaType: "application/json" };
  previews: RemotePayloadV1 & { mediaType: "application/zip" };
  authorizedNextKeys: Array<{ keyId: string; publicKeyBase64: string }>;
  tombstones: string[];
}

export interface ProviderSourceSignatureV1 {
  schema: typeof PROVIDER_SOURCE_SIGNATURE_SCHEMA;
  algorithm: "Ed25519";
  keyId: string;
  manifestSha256: string;
  signatureBase64: string;
}

export interface PublicPreviewIdentityV1 {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: "image/png";
  width: number;
  height: number;
  canonicalRgbaSha256: string;
}

export interface PersonalCatalogEntryObservation {
  templateId: string;
  releaseVersion: string;
  contentDigest: string;
  entrySha256: string;
  identity: string;
  preview: PublicPreviewIdentityV1;
}

export interface PersonalCatalogObservation {
  providerId: string;
  entries: PersonalCatalogEntryObservation[];
}

function parseRemotePayload<T extends RemotePayloadV1["mediaType"]>(
  value: unknown,
  label: string,
  mediaType: T,
  maximum: number,
): RemotePayloadV1 & { mediaType: T } {
  if (!isRecord(value)) throw new Error(`${label} is missing`);
  assertExactKeys(value, ["url", "bytes", "sha256", "mediaType"], label);
  if (value.mediaType !== mediaType) throw new Error(`${label} mediaType must be ${mediaType}`);
  const digest = nonEmptyString(value.sha256, `${label} sha256`, 64);
  if (!HASH.test(digest)) throw new Error(`${label} sha256 is invalid`);
  return {
    url: assertSafeHttpsUrl(nonEmptyString(value.url, `${label} URL`), `${label} URL`).href,
    bytes: positiveInteger(value.bytes, `${label} bytes`, maximum),
    sha256: digest,
    mediaType,
  };
}

function parseManifest(bytes: Uint8Array): ProviderSourceManifestV1 {
  const parsed = parseJson(bytes, "provider source manifest");
  if (!isRecord(parsed) || parsed.schema !== PROVIDER_SOURCE_MANIFEST_SCHEMA) {
    throw new Error("unsupported provider source manifest schema");
  }
  assertExactKeys(parsed, [
    "schema",
    "providerId",
    "sequence",
    "generatedAt",
    "catalog",
    "previews",
    "authorizedNextKeys",
    "tombstones",
  ], "provider source manifest");
  const providerId = assertPersonalProviderId(parsed.providerId, "manifest providerId");
  const generatedAt = nonEmptyString(parsed.generatedAt, "manifest generatedAt", 100);
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("manifest generatedAt is invalid");
  if (!Array.isArray(parsed.authorizedNextKeys) || parsed.authorizedNextKeys.length > 16) {
    throw new Error("manifest authorizedNextKeys must contain no more than 16 keys");
  }
  const authorizedNextKeys: ProviderSourceManifestV1["authorizedNextKeys"] = [];
  const keyIds = new Set<string>();
  for (const raw of parsed.authorizedNextKeys) {
    if (!isRecord(raw)) throw new Error("manifest authorizedNextKeys entry is invalid");
    assertExactKeys(raw, ["keyId", "publicKeyBase64"], "manifest authorizedNextKeys entry");
    const key = ed25519PublicKeyIdentity(
      nonEmptyString(raw.publicKeyBase64, "authorized publicKeyBase64", 100),
    );
    if (raw.keyId !== key.keyId) throw new Error("authorized next keyId does not match publicKeyBase64");
    if (keyIds.has(key.keyId)) throw new Error("manifest authorizedNextKeys contains a duplicate key");
    keyIds.add(key.keyId);
    authorizedNextKeys.push({ keyId: key.keyId, publicKeyBase64: key.publicKeyBase64 });
  }
  if (!Array.isArray(parsed.tombstones) || parsed.tombstones.length > MAX_PREVIEW_FILES) {
    throw new Error("manifest tombstones is invalid");
  }
  const tombstones = parsed.tombstones.map((value) =>
    nonEmptyString(value, "manifest tombstone", 200));
  if (new Set(tombstones).size !== tombstones.length) {
    throw new Error("manifest tombstones contains a duplicate");
  }
  return {
    schema: PROVIDER_SOURCE_MANIFEST_SCHEMA,
    providerId,
    sequence: positiveInteger(parsed.sequence, "manifest sequence"),
    generatedAt,
    catalog: parseRemotePayload(parsed.catalog, "manifest catalog", "application/json", MAX_CATALOG_BYTES),
    previews: parseRemotePayload(
      parsed.previews,
      "manifest previews",
      "application/zip",
      MAX_PREVIEW_ARCHIVE_BYTES,
    ),
    authorizedNextKeys,
    tombstones,
  };
}

function parseSignature(bytes: Uint8Array): { value: ProviderSourceSignatureV1; signature: Uint8Array } {
  const parsed = parseJson(bytes, "provider source signature sidecar");
  if (!isRecord(parsed) || parsed.schema !== PROVIDER_SOURCE_SIGNATURE_SCHEMA) {
    throw new Error("unsupported provider source signature schema");
  }
  assertExactKeys(
    parsed,
    ["schema", "algorithm", "keyId", "manifestSha256", "signatureBase64"],
    "provider source signature sidecar",
  );
  if (parsed.algorithm !== "Ed25519") throw new Error("provider source signature algorithm must be Ed25519");
  const keyId = nonEmptyString(parsed.keyId, "signature keyId", 64);
  const manifestSha256 = nonEmptyString(parsed.manifestSha256, "signature manifestSha256", 64);
  if (!HASH.test(keyId) || !HASH.test(manifestSha256)) {
    throw new Error("provider source signature keyId and manifestSha256 must be SHA-256");
  }
  const signatureBase64 = nonEmptyString(parsed.signatureBase64, "signatureBase64", 88);
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== signatureBase64) {
    throw new Error("signatureBase64 must be canonical base64 for exactly 64 bytes");
  }
  return {
    value: {
      schema: PROVIDER_SOURCE_SIGNATURE_SCHEMA,
      algorithm: "Ed25519",
      keyId,
      manifestSha256,
      signatureBase64,
    },
    signature: new Uint8Array(signature),
  };
}

export function parseProviderSourceManifestBytes(bytes: Uint8Array) {
  return parseManifest(bytes);
}

export function parseProviderSourceSignatureBytes(bytes: Uint8Array) {
  return parseSignature(bytes);
}

function parsePreview(value: unknown, templateId: string, releaseVersion: string) {
  if (!isRecord(value)) throw new Error("catalog entry preview is missing");
  assertExactKeys(
    value,
    ["path", "bytes", "sha256", "mediaType", "width", "height", "canonicalRgbaSha256"],
    "catalog entry preview",
  );
  const expectedPath = `thumbs/${templateId}/${releaseVersion}.png`;
  if (value.path !== expectedPath) throw new Error(`catalog preview path must be ${expectedPath}`);
  if (value.mediaType !== "image/png") throw new Error("catalog preview mediaType must be image/png");
  const digest = nonEmptyString(value.sha256, "catalog preview sha256", 64);
  const rgbaDigest = nonEmptyString(value.canonicalRgbaSha256, "catalog preview canonicalRgbaSha256", 64);
  if (!HASH.test(digest) || !HASH.test(rgbaDigest)) throw new Error("catalog preview digest is invalid");
  const width = positiveInteger(value.width, "catalog preview width", 16_384);
  const height = positiveInteger(value.height, "catalog preview height", 16_384);
  if (width * height > MAX_PREVIEW_PIXELS) {
    throw new Error(`catalog preview exceeds the ${MAX_PREVIEW_PIXELS}-pixel decode budget`);
  }
  return {
    path: expectedPath,
    bytes: positiveInteger(value.bytes, "catalog preview bytes", MAX_PREVIEW_FILE_BYTES),
    sha256: digest,
    mediaType: "image/png" as const,
    width,
    height,
    canonicalRgbaSha256: rgbaDigest,
  };
}

function parseCatalog(bytes: Uint8Array, providerId: string): PersonalCatalogObservation {
  const parsed = parseJson(bytes, "provider source catalog");
  if (!isRecord(parsed) || parsed.schema !== PUBLIC_PROVIDER_CATALOG_SCHEMA) {
    throw new Error("unsupported personal provider catalog schema");
  }
  if (!isRecord(parsed.provider) || parsed.provider.providerId !== providerId) {
    throw new Error("provider source catalog providerId does not match the signed manifest");
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length > MAX_PREVIEW_FILES) {
    throw new Error("provider source catalog entries is invalid or too large");
  }
  const entries: PersonalCatalogEntryObservation[] = [];
  const identities = new Set<string>();
  const previewPaths = new Set<string>();
  for (const raw of parsed.entries) {
    if (!isRecord(raw) || raw.providerId !== providerId) {
      throw new Error("provider source catalog entry providerId is invalid");
    }
    const templateId = nonEmptyString(raw.templateId, "catalog templateId", 128);
    const releaseVersion = nonEmptyString(raw.releaseVersion, "catalog releaseVersion", 100);
    const contentDigest = nonEmptyString(raw.contentDigest, "catalog contentDigest", 64);
    if (!TEMPLATE_ID.test(templateId) || !STRICT_SEMVER.test(releaseVersion) || !HASH.test(contentDigest)) {
      throw new Error("provider source catalog entry identity is invalid");
    }
    const identity = `${templateId}@${releaseVersion}`;
    if (identities.has(identity)) throw new Error(`provider source catalog duplicate identity: ${identity}`);
    identities.add(identity);
    const preview = parsePreview(raw.preview, templateId, releaseVersion);
    const foldedPreview = portableCaseFold(preview.path);
    if (previewPaths.has(foldedPreview)) {
      throw new Error(`provider source catalog preview path collision: ${preview.path}`);
    }
    previewPaths.add(foldedPreview);
    entries.push({
      templateId,
      releaseVersion,
      contentDigest,
      entrySha256: sha256(canonicalJson(raw)),
      identity,
      preview,
    });
  }
  entries.sort((left, right) => left.identity.localeCompare(right.identity, "en"));
  return { providerId, entries };
}

export function parsePersonalProviderCatalogBytes(bytes: Uint8Array, providerId: string) {
  return parseCatalog(bytes, assertPersonalProviderId(providerId, "expectedProviderId"));
}

interface ZipCentralEntry {
  name: string;
  directory: boolean;
  originalSize: number;
}

function readUInt32(buffer: Buffer, offset: number, label: string) {
  if (offset < 0 || offset + 4 > buffer.byteLength) throw new Error(`truncated preview ZIP ${label}`);
  return buffer.readUInt32LE(offset);
}

function readUInt16(buffer: Buffer, offset: number, label: string) {
  if (offset < 0 || offset + 2 > buffer.byteLength) throw new Error(`truncated preview ZIP ${label}`);
  return buffer.readUInt16LE(offset);
}

function assertNoZip64Extra(buffer: Buffer, start: number, length: number, label: string) {
  const end = start + length;
  if (start < 0 || end > buffer.byteLength) throw new Error(`truncated preview ZIP ${label}`);
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) throw new Error(`malformed preview ZIP ${label}`);
    const fieldId = readUInt16(buffer, offset, `${label} field id`);
    const fieldBytes = readUInt16(buffer, offset + 2, `${label} field length`);
    offset += 4;
    if (offset + fieldBytes > end) throw new Error(`malformed preview ZIP ${label}`);
    if (fieldId === 0x0001) throw new Error("preview ZIP64 extra fields are not supported");
    offset += fieldBytes;
  }
}

function safePreviewArchivePath(raw: string, directory: boolean) {
  if (
    !raw ||
    raw.length > 1_000 ||
    raw !== raw.normalize("NFC") ||
    raw.includes("\\") ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/u.test(raw) ||
    raw.includes("//")
  ) {
    throw new Error(`unsafe preview ZIP path: ${raw}`);
  }
  const normalized = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!normalized || (!directory && raw.endsWith("/"))) throw new Error(`unsafe preview ZIP path: ${raw}`);
  for (const segment of normalized.split("/")) {
    assertPortableFilesystemSegment(segment, "preview ZIP segment");
  }
  return normalized;
}

function inspectZipCentralDirectory(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const minimum = Math.max(0, buffer.byteLength - 65_557);
  for (let offset = buffer.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUInt32(buffer, offset, "EOCD scan") === ZIP_EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("preview ZIP end-of-central-directory record is missing");
  const disk = readUInt16(buffer, eocd + 4, "disk number");
  const centralDisk = readUInt16(buffer, eocd + 6, "central disk number");
  const diskEntries = readUInt16(buffer, eocd + 8, "disk entry count");
  const totalEntries = readUInt16(buffer, eocd + 10, "entry count");
  const centralBytes = readUInt32(buffer, eocd + 12, "central size");
  const centralOffset = readUInt32(buffer, eocd + 16, "central offset");
  const commentBytes = readUInt16(buffer, eocd + 20, "comment length");
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("preview ZIP multi-disk and ZIP64 archives are not supported");
  }
  if (totalEntries > MAX_PREVIEW_FILES || eocd + 22 + commentBytes !== buffer.byteLength) {
    throw new Error("preview ZIP entry count or trailing data is invalid");
  }
  if (centralOffset + centralBytes !== eocd) throw new Error("preview ZIP central directory bounds are invalid");
  const output = new Map<string, ZipCentralEntry>();
  const folded = new Map<string, string>();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(buffer, offset, "central header") !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("preview ZIP central directory is malformed");
    }
    const versionMadeBy = readUInt16(buffer, offset + 4, "version made by");
    const flags = readUInt16(buffer, offset + 8, "general purpose flags");
    if ((flags & 0x1) !== 0) throw new Error("encrypted preview ZIP entries are not allowed");
    if ((flags & ~(0x0008 | 0x0800)) !== 0) throw new Error("preview ZIP uses unsupported general-purpose flags");
    const compressionMethod = readUInt16(buffer, offset + 10, "compression method");
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(`preview ZIP compression method is not supported: ${compressionMethod}`);
    }
    const originalSize = readUInt32(buffer, offset + 24, "original size");
    const nameBytes = readUInt16(buffer, offset + 28, "name length");
    const extraBytes = readUInt16(buffer, offset + 30, "extra length");
    const commentLength = readUInt16(buffer, offset + 32, "entry comment length");
    const diskStart = readUInt16(buffer, offset + 34, "entry disk");
    const externalAttributes = readUInt32(buffer, offset + 38, "external attributes");
    const localOffset = readUInt32(buffer, offset + 42, "local offset");
    if (diskStart !== 0 || localOffset === 0xffffffff || originalSize === 0xffffffff) {
      throw new Error("preview ZIP64 or multi-disk entry is not supported");
    }
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameBytes;
    if (nameEnd + extraBytes + commentLength > eocd) throw new Error("truncated preview ZIP central entry");
    assertNoZip64Extra(buffer, nameEnd, extraBytes, "central extra field");
    const rawName = decodeUtf8(buffer.subarray(nameStart, nameEnd), "preview ZIP entry name");
    const host = versionMadeBy >>> 8;
    const mode = externalAttributes >>> 16;
    if (host === 3 && (mode & 0o170000) === 0o120000) {
      throw new Error(`preview ZIP symbolic link is not allowed: ${rawName}`);
    }
    const directory = rawName.endsWith("/") || (host === 3 && (mode & 0o170000) === 0o040000);
    const name = safePreviewArchivePath(rawName, directory);
    const foldedName = portableCaseFold(name);
    const prior = folded.get(foldedName);
    if (prior !== undefined) throw new Error(`preview ZIP duplicate/case-fold collision: ${prior}, ${name}`);
    folded.set(foldedName, name);
    if (!directory && originalSize > MAX_PREVIEW_FILE_BYTES) {
      throw new Error(`preview ZIP file exceeds 64 MiB: ${name}`);
    }
    if (readUInt32(buffer, localOffset, "local header") !== ZIP_LOCAL_SIGNATURE) {
      throw new Error(`preview ZIP local header is missing: ${name}`);
    }
    const localFlags = readUInt16(buffer, localOffset + 6, "local general purpose flags");
    const localCompressionMethod = readUInt16(buffer, localOffset + 8, "local compression method");
    if (localFlags !== flags || localCompressionMethod !== compressionMethod) {
      throw new Error(`preview ZIP local/central flags or compression mismatch: ${name}`);
    }
    const localNameBytes = readUInt16(buffer, localOffset + 26, "local name length");
    const localExtraBytes = readUInt16(buffer, localOffset + 28, "local extra length");
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameBytes;
    if (localNameEnd + localExtraBytes > buffer.byteLength) throw new Error("truncated preview ZIP local header");
    assertNoZip64Extra(buffer, localNameEnd, localExtraBytes, "local extra field");
    const localName = decodeUtf8(buffer.subarray(localNameStart, localNameEnd), "preview ZIP local name");
    if (localName !== rawName) throw new Error(`preview ZIP local/central path mismatch: ${name}`);
    output.set(name, { name, directory, originalSize });
    offset = nameEnd + extraBytes + commentLength;
  }
  if (offset !== eocd) throw new Error("preview ZIP central directory entry count is inconsistent");
  const fileNames = [...output.values()].filter((entry) => !entry.directory).map((entry) => entry.name);
  const files = new Set(fileNames);
  for (const name of fileNames) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const prefix = parts.slice(0, index).join("/");
      if (files.has(prefix)) throw new Error(`preview ZIP file/directory path conflict: ${prefix}`);
    }
  }
  return output;
}

export interface VerifiedPreviewFile extends PublicPreviewIdentityV1 {
  snapshotPath: string;
  data: Uint8Array;
}

function extractVerifiedPreviews(archiveBytes: Uint8Array, catalog: PersonalCatalogObservation) {
  const central = inspectZipCentralDirectory(archiveBytes);
  const expected = new Map(catalog.entries.map((entry) => [entry.preview.path, entry.preview]));
  const expectedDirectories = new Set<string>();
  for (const expectedPath of expected.keys()) {
    const parts = expectedPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  for (const entry of central.values()) {
    if (entry.directory && !expectedDirectories.has(entry.name)) {
      throw new Error(`preview ZIP contains an undeclared directory: ${entry.name}`);
    }
    if (!entry.directory && !expected.has(entry.name)) {
      throw new Error(`preview ZIP contains an undeclared file: ${entry.name}`);
    }
  }
  for (const expectedPath of expected.keys()) {
    if (!central.has(expectedPath) || central.get(expectedPath)?.directory) {
      throw new Error(`preview ZIP is missing catalog preview: ${expectedPath}`);
    }
  }
  let expandedBytes = 0;
  let files = 0;
  const contents = unzipSync(archiveBytes, {
    filter(info: UnzipFileInfo) {
      const directory = info.name.endsWith("/");
      const name = safePreviewArchivePath(info.name, directory);
      const observed = central.get(name);
      if (!observed || observed.directory !== directory || observed.originalSize !== info.originalSize) {
        throw new Error(`preview ZIP entry metadata mismatch: ${name}`);
      }
      if (directory) return false;
      files += 1;
      expandedBytes += info.originalSize;
      if (files > MAX_PREVIEW_FILES) throw new Error("preview ZIP contains too many files");
      if (info.originalSize > MAX_PREVIEW_FILE_BYTES) throw new Error(`preview ZIP file exceeds 64 MiB: ${name}`);
      if (expandedBytes > MAX_PREVIEW_EXPANDED_BYTES) throw new Error("expanded preview ZIP exceeds 128 MiB");
      return true;
    },
  });
  const previewFiles: VerifiedPreviewFile[] = [];
  for (const [catalogPath, preview] of expected) {
    const data = contents[catalogPath];
    if (!data) throw new Error(`preview ZIP extraction omitted catalog preview: ${catalogPath}`);
    if (data.byteLength !== preview.bytes || sha256(data) !== preview.sha256) {
      throw new Error(`preview ZIP file identity mismatch: ${catalogPath}`);
    }
    const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (data.byteLength < 8 || !Buffer.from(data.subarray(0, 8)).equals(pngMagic)) {
      throw new Error(`preview ZIP file is not PNG: ${catalogPath}`);
    }
    const pngHeader = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (
      data.byteLength < 33 ||
      pngHeader.readUInt32BE(8) !== 13 ||
      pngHeader.toString("ascii", 12, 16) !== "IHDR"
    ) {
      throw new Error(`preview ZIP PNG has no canonical IHDR header: ${catalogPath}`);
    }
    const headerWidth = pngHeader.readUInt32BE(16);
    const headerHeight = pngHeader.readUInt32BE(20);
    const bitDepth = pngHeader[24]!;
    const colorType = pngHeader[25]!;
    const interlace = pngHeader[28]!;
    const channels = colorType === 0 || colorType === 3
      ? 1
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 6
            ? 4
            : 0;
    const decodedBytes = headerWidth * headerHeight * (bitDepth === 16 ? 8 : 4);
    const inflatedRowBytes = channels
      ? Math.ceil((headerWidth * channels * bitDepth) / 8) + 1
      : Number.POSITIVE_INFINITY;
    if (
      headerWidth !== preview.width ||
      headerHeight !== preview.height ||
      headerWidth * headerHeight > MAX_PREVIEW_PIXELS ||
      decodedBytes > MAX_PREVIEW_FILE_BYTES ||
      inflatedRowBytes * headerHeight > MAX_PREVIEW_FILE_BYTES
    ) {
      throw new Error(`preview ZIP PNG dimensions exceed the safe decode budget: ${catalogPath}`);
    }
    // pngjs' synchronous interlaced path inflates without a maxLength. Reject
    // interlacing so the non-interlaced bounded inflater is always used.
    if (interlace !== 0) {
      throw new Error(`preview ZIP PNG interlacing is not supported: ${catalogPath}`);
    }
    let decoded: PNG;
    try {
      decoded = PNG.sync.read(Buffer.from(data), { checkCRC: true });
    } catch (error) {
      throw new Error(
        `preview ZIP PNG is invalid (${catalogPath}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      decoded.width !== preview.width ||
      decoded.height !== preview.height ||
      sha256(decoded.data) !== preview.canonicalRgbaSha256
    ) {
      throw new Error(`preview ZIP PNG dimensions or canonical RGBA digest mismatch: ${catalogPath}`);
    }
    previewFiles.push({ ...preview, snapshotPath: `previews/${catalogPath}`, data: new Uint8Array(data) });
  }
  return previewFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export interface VerifiedProviderSourceSnapshot {
  manifest: ProviderSourceManifestV1;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  signature: ProviderSourceSignatureV1;
  signatureSidecarBytes: Uint8Array;
  signatureSidecarSha256: string;
  signingKey: Ed25519PublicKeyIdentity;
  catalogBytes: Uint8Array;
  catalogSha256: string;
  catalog: PersonalCatalogObservation;
  previewsArchiveBytes: number;
  previewsArchiveSha256: string;
  previewFiles: VerifiedPreviewFile[];
  authorizedNextKeys: Ed25519PublicKeyIdentity[];
  payloadUrls: {
    manifest: string;
    signature: string;
    catalog: string;
    previews: string;
  };
  accessUrls: string[];
}

export async function fetchVerifiedProviderSourceSnapshot(options: {
  fetcher: SecureProviderSourceFetcher;
  manifestUrl: string;
  expectedProviderId: string;
  trustedKeys: Ed25519PublicKeyIdentity[];
}): Promise<VerifiedProviderSourceSnapshot> {
  const expectedProviderId = assertPersonalProviderId(options.expectedProviderId, "expectedProviderId");
  if (!options.trustedKeys.length) throw new Error("at least one independently trusted public key is required");
  const trustedKeys = new Map<string, Ed25519PublicKeyIdentity>();
  for (const key of options.trustedKeys) {
    const checked = ed25519PublicKeyIdentity(key.publicKeyBase64);
    if (checked.keyId !== key.keyId) throw new Error("trusted Ed25519 key identity is invalid");
    if (trustedKeys.has(checked.keyId)) throw new Error("trusted Ed25519 key list contains a duplicate");
    trustedKeys.set(checked.keyId, checked);
  }
  const manifestUrl = assertSafeHttpsUrl(options.manifestUrl, "provider source manifest URL").href;
  const signatureUrl = deriveProviderSourceSignatureUrl(manifestUrl);
  const manifestResponse = await options.fetcher.fetch(manifestUrl, {
    maxBytes: MAX_MANIFEST_BYTES,
    mediaTypes: ["application/json"],
  });
  const signatureResponse = await options.fetcher.fetch(signatureUrl, {
    maxBytes: MAX_SIGNATURE_BYTES,
    mediaTypes: ["application/json"],
  });
  const parsedSignature = parseSignature(signatureResponse.bytes);
  const manifestSha256 = sha256(manifestResponse.bytes);
  if (parsedSignature.value.manifestSha256 !== manifestSha256) {
    throw new Error("provider source signature manifestSha256 does not match raw manifest bytes");
  }
  const signingKey = trustedKeys.get(parsedSignature.value.keyId);
  if (!signingKey) {
    throw new Error(
      `provider source signature key is not independently trusted or previously authorized: ${parsedSignature.value.keyId}`,
    );
  }
  verifyEd25519Detached(manifestResponse.bytes, parsedSignature.signature, signingKey);
  const manifest = parseManifest(manifestResponse.bytes);
  if (manifest.providerId !== expectedProviderId) {
    throw new Error(`provider source manifest providerId does not match expectedProviderId: ${expectedProviderId}`);
  }
  const catalogResponse = await options.fetcher.fetch(manifest.catalog.url, {
    maxBytes: manifest.catalog.bytes,
    mediaTypes: [manifest.catalog.mediaType],
  });
  if (
    catalogResponse.bytes.byteLength !== manifest.catalog.bytes ||
    sha256(catalogResponse.bytes) !== manifest.catalog.sha256
  ) {
    throw new Error("provider source catalog identity does not match the signed manifest");
  }
  const catalog = parseCatalog(catalogResponse.bytes, expectedProviderId);
  const previewsResponse = await options.fetcher.fetch(manifest.previews.url, {
    maxBytes: manifest.previews.bytes,
    mediaTypes: [manifest.previews.mediaType],
  });
  if (
    previewsResponse.bytes.byteLength !== manifest.previews.bytes ||
    sha256(previewsResponse.bytes) !== manifest.previews.sha256
  ) {
    throw new Error("provider source preview archive identity does not match the signed manifest");
  }
  const previewFiles = extractVerifiedPreviews(previewsResponse.bytes, catalog);
  const authorizedNextKeys = manifest.authorizedNextKeys.map((value) =>
    ed25519PublicKeyIdentity(value.publicKeyBase64));
  return {
    manifest,
    manifestBytes: manifestResponse.bytes,
    manifestSha256,
    signature: parsedSignature.value,
    signatureSidecarBytes: signatureResponse.bytes,
    signatureSidecarSha256: sha256(signatureResponse.bytes),
    signingKey,
    catalogBytes: catalogResponse.bytes,
    catalogSha256: sha256(catalogResponse.bytes),
    catalog,
    previewsArchiveBytes: previewsResponse.bytes.byteLength,
    previewsArchiveSha256: sha256(previewsResponse.bytes),
    previewFiles,
    authorizedNextKeys,
    payloadUrls: {
      manifest: manifestUrl,
      signature: signatureUrl,
      catalog: manifest.catalog.url,
      previews: manifest.previews.url,
    },
    accessUrls: [
      ...manifestResponse.accessUrls,
      ...signatureResponse.accessUrls,
      ...catalogResponse.accessUrls,
      ...previewsResponse.accessUrls,
    ],
  };
}
