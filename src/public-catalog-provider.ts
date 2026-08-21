import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { PNG } from "pngjs";
import {
  buildSearchIntent,
  normalizeSearchText,
  scoreSearchableTemplate,
} from "./catalog.ts";
import {
  canonicalJson,
  compareCanonicalStrings,
} from "./canonical-json.ts";
import {
  exactSelectorDigest,
  assertExactTemplateSelector,
} from "./providers.ts";
import { SecureProviderSourceFetcher } from "./provider-source-fetch.ts";
import type {
  LoadedProviderPreview,
  ProviderAdapter,
  ProviderContext,
  ProviderDescription,
  ProviderDescriptor,
  ProviderMaterializedBinding,
  ProviderStatus,
  ResolvedProviderTemplate,
  VerifiedProviderPayload,
} from "./provider-registry.ts";
import type {
  ExactTemplateSelector,
  SearchRequest,
  TemplateCandidate,
} from "./types.ts";
import { STRICT_SEMVER } from "./semver.ts";
import { legacyValidationStateFromExecutionStatus } from "./versioned-library.ts";

export const COMMUNITY_PROVIDER_ID =
  "io.github.jarxunlai.scientific-figure-community" as const;
export const PUBLIC_CATALOG_SCHEMA =
  "figure-library.public-provider-catalog.v1" as const;
export const PUBLIC_TEMPLATE_ENTRY_SCHEMA =
  "figure-library.public-template-entry.v1" as const;
export const PUBLIC_PREVIEW_MANIFEST_SCHEMA =
  "figure-library.public-preview-manifest.v1" as const;
export const PUBLIC_SELECTOR_KIND = "public-template.v1" as const;
export const PUBLIC_TEMPLATE_LOCK_SCHEMA = "figure-library.template-lock.v3" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TEMPLATE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_RGBA_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;

type PublicCurationStatus = "curated" | "unreviewed";
type PublicRenderValidation =
  | "ci_rendered"
  | "publisher_attested"
  | "unverified";

export interface PublicArchiveIdentityV1 {
  repository: string;
  commit: string;
  path: string;
  bytes: number;
  sha256: string;
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

export interface PublicTemplateEntryV1 {
  schema: typeof PUBLIC_TEMPLATE_ENTRY_SCHEMA;
  providerId: string;
  templateId: string;
  releaseVersion: string;
  contentDigest: string;
  title: string;
  description: string;
  search: {
    application: string;
    dataProfile: string;
    plotFamily: string;
    language: string;
    tags: string[];
    packages: string[];
    codeFiles: string[];
    inputFiles: string[];
  };
  archive: PublicArchiveIdentityV1;
  preview: PublicPreviewIdentityV1;
  status: {
    upstreamStatus: "published";
    publisherVerified: boolean;
    curationStatus: PublicCurationStatus;
    renderValidation: PublicRenderValidation;
    localReviewStatus: "not_reviewed";
    plotExecutionByRecipient: "not_run";
  };
  licenses: {
    code: string;
    content: string;
    documentation: string;
  };
  provenance?: Record<string, unknown>[];
}

export interface PublicProviderCatalogV1 {
  schema: typeof PUBLIC_CATALOG_SCHEMA;
  provider: {
    providerId: string;
    displayName: string;
    catalogRepository: string;
    archiveRepository: string;
  };
  generatedAt: string;
  entries: PublicTemplateEntryV1[];
}

export interface PublicTemplateSelectorIdentity
  extends Record<string, unknown> {
  templateId: string;
  releaseVersion: string;
  contentDigest: string;
  catalogSha256: string;
  archive: {
    repository: string;
    commit: string;
    path: string;
    bytes: number;
    sha256: string;
  };
  preview: {
    bytes: number;
    sha256: string;
    mediaType: "image/png";
  };
  mode: "template";
}

export type PublicTemplateExactSelector = ExactTemplateSelector<
  typeof PUBLIC_SELECTOR_KIND,
  PublicTemplateSelectorIdentity
>;

export interface PublicPreviewManifestV1 {
  schema: typeof PUBLIC_PREVIEW_MANIFEST_SCHEMA;
  providerId: string;
  entries: Array<{
    templateId: string;
    releaseVersion: string;
    path: string;
    bytes: number;
    sha256: string;
    mediaType: "image/png";
    width: number;
    height: number;
    canonicalRgbaSha256: string;
  }>;
}

export interface PublicCatalogSnapshot {
  catalog: PublicProviderCatalogV1;
  catalogBytes: Uint8Array;
  catalogSha256: string;
  previewManifest: PublicPreviewManifestV1;
  previewManifestSha256: string;
  previews: ReadonlyMap<string, Uint8Array>;
  revision: string;
  trust: "bundled" | "signed-snapshot";
  sourceReference: string;
}

export interface PublicArchiveFetchRequest {
  url: string;
  expectedBytes: number;
  maxBytes: number;
  timeoutMs: number;
}

export type PublicArchiveFetcher = (
  request: PublicArchiveFetchRequest,
) => Promise<Uint8Array>;

export interface PublicResolvedProviderTemplate {
  providerId: string;
  exactSelector: PublicTemplateExactSelector;
  templateId: string;
  value: {
    kind: "public-catalog";
    entry: PublicTemplateEntryV1;
    catalogSha256: string;
  };
}

interface ArchiveInventoryEntry {
  path: string;
  bytes: number;
  sha256: string;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(value: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
}

function nonEmptyString(value: unknown, label: string, maximum = 4_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum}`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${label} must be a string no longer than ${maximum}`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} must be a positive safe integer no larger than ${maximum}`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`${label} must be a non-negative safe integer no larger than ${maximum}`);
  }
  return Number(value);
}

function assertDigest(value: unknown, label: string) {
  const result = nonEmptyString(value, label, 64).toLocaleLowerCase("en-US");
  if (!SHA256.test(result)) throw new Error(`${label} must be lowercase SHA-256`);
  return result;
}

function assertStringArray(
  value: unknown,
  label: string,
  maximumEntries = 10_000,
  maximumString = 1_000,
) {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new Error(`${label} must be an array with at most ${maximumEntries} entries`);
  }
  const result = value.map((item, index) =>
    nonEmptyString(item, `${label}[${index}]`, maximumString),
  );
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function parseUtf8Json(bytes: Uint8Array, label: string, maximum: number): unknown {
  if (bytes.byteLength > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

function assertRfc3339(value: unknown, label: string) {
  const text = nonEmptyString(value, label, 100);
  if (
    !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(
      text,
    ) ||
    Number.isNaN(Date.parse(text))
  ) {
    throw new Error(`${label} must be an RFC 3339 date-time`);
  }
  return text;
}

function assertPortableArchivePath(value: unknown, label: string, directory = false) {
  const raw = nonEmptyString(value, label, 1_000);
  if (
    raw.includes("\\") ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/u.test(raw) ||
    raw.normalize("NFC") !== raw ||
    (directory ? !raw.endsWith("/") : raw.endsWith("/"))
  ) {
    throw new Error(`${label} is an unsafe or non-canonical portable path: ${raw}`);
  }
  const body = directory ? raw.slice(0, -1) : raw;
  const parts = body.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        /[<>:"|?*]/u.test(part) ||
        /[\u0000-\u001f]/u.test(part) ||
        RESERVED_WINDOWS_NAME.test(part),
    )
  ) {
    throw new Error(`${label} is not portable across supported filesystems: ${raw}`);
  }
  return raw;
}

function assertRepository(value: unknown, label: string) {
  const repository = nonEmptyString(value, label, 200);
  if (!REPOSITORY.test(repository)) throw new Error(`${label} is not owner/repository`);
  return repository;
}

function parseArchiveIdentity(
  value: unknown,
  label: string,
  templateId: string,
  releaseVersion: string,
  expectedRepository: string,
): PublicArchiveIdentityV1 {
  if (!isRecord(value)) throw new Error(`${label} is missing`);
  assertKeys(
    value,
    ["repository", "commit", "path", "bytes", "sha256"],
    [],
    label,
  );
  const repository = assertRepository(value.repository, `${label}.repository`);
  if (repository !== expectedRepository) {
    throw new Error(`${label}.repository differs from the Provider archive repository`);
  }
  const commit = nonEmptyString(value.commit, `${label}.commit`, 40);
  if (!COMMIT.test(commit)) throw new Error(`${label}.commit must be a 40-hex commit`);
  const archivePath = assertPortableArchivePath(value.path, `${label}.path`);
  const expectedPath = `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`;
  if (archivePath !== expectedPath) throw new Error(`${label}.path must be ${expectedPath}`);
  return {
    repository,
    commit,
    path: archivePath,
    bytes: positiveInteger(value.bytes, `${label}.bytes`, MAX_ARCHIVE_BYTES),
    sha256: assertDigest(value.sha256, `${label}.sha256`),
  };
}

function parsePreviewIdentity(
  value: unknown,
  label: string,
  templateId: string,
  releaseVersion: string,
): PublicPreviewIdentityV1 {
  if (!isRecord(value)) throw new Error(`${label} is missing`);
  assertKeys(
    value,
    [
      "path",
      "bytes",
      "sha256",
      "mediaType",
      "width",
      "height",
      "canonicalRgbaSha256",
    ],
    [],
    label,
  );
  const previewPath = assertPortableArchivePath(value.path, `${label}.path`);
  const expectedPath = `thumbs/${templateId}/${releaseVersion}.png`;
  if (previewPath !== expectedPath) throw new Error(`${label}.path must be ${expectedPath}`);
  if (value.mediaType !== "image/png") throw new Error(`${label}.mediaType must be image/png`);
  return {
    path: previewPath,
    bytes: positiveInteger(value.bytes, `${label}.bytes`, MAX_PREVIEW_BYTES),
    sha256: assertDigest(value.sha256, `${label}.sha256`),
    mediaType: "image/png",
    width: positiveInteger(value.width, `${label}.width`, 16_384),
    height: positiveInteger(value.height, `${label}.height`, 16_384),
    canonicalRgbaSha256: assertDigest(
      value.canonicalRgbaSha256,
      `${label}.canonicalRgbaSha256`,
    ),
  };
}

function parsePublicTemplateEntry(
  value: unknown,
  provider: PublicProviderCatalogV1["provider"],
  index: number,
): PublicTemplateEntryV1 {
  const label = `catalog.entries[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKeys(
    value,
    [
      "schema",
      "providerId",
      "templateId",
      "releaseVersion",
      "contentDigest",
      "title",
      "description",
      "search",
      "archive",
      "preview",
      "status",
      "licenses",
    ],
    ["provenance"],
    label,
  );
  if (value.schema !== PUBLIC_TEMPLATE_ENTRY_SCHEMA) {
    throw new Error(`${label}.schema is unsupported`);
  }
  if (value.providerId !== provider.providerId) throw new Error(`${label}.providerId mismatch`);
  const templateId = nonEmptyString(value.templateId, `${label}.templateId`, 128);
  if (!TEMPLATE_ID.test(templateId)) throw new Error(`${label}.templateId is invalid`);
  const releaseVersion = nonEmptyString(value.releaseVersion, `${label}.releaseVersion`, 100);
  if (!STRICT_SEMVER.test(releaseVersion)) throw new Error(`${label}.releaseVersion is not semantic`);
  if (!isRecord(value.search)) throw new Error(`${label}.search is missing`);
  assertKeys(
    value.search,
    [
      "application",
      "dataProfile",
      "plotFamily",
      "language",
      "tags",
      "packages",
      "codeFiles",
      "inputFiles",
    ],
    [],
    `${label}.search`,
  );
  if (!isRecord(value.status)) throw new Error(`${label}.status is missing`);
  assertKeys(
    value.status,
    [
      "upstreamStatus",
      "publisherVerified",
      "curationStatus",
      "renderValidation",
      "localReviewStatus",
      "plotExecutionByRecipient",
    ],
    [],
    `${label}.status`,
  );
  if (
    value.status.upstreamStatus !== "published" ||
    typeof value.status.publisherVerified !== "boolean" ||
    (value.status.curationStatus !== "curated" &&
      value.status.curationStatus !== "unreviewed") ||
    !["ci_rendered", "publisher_attested", "unverified"].includes(
      String(value.status.renderValidation),
    ) ||
    value.status.localReviewStatus !== "not_reviewed" ||
    value.status.plotExecutionByRecipient !== "not_run"
  ) {
    throw new Error(`${label}.status is invalid`);
  }
  if (!isRecord(value.licenses)) throw new Error(`${label}.licenses is missing`);
  assertKeys(
    value.licenses,
    ["code", "content", "documentation"],
    [],
    `${label}.licenses`,
  );
  let provenance: Record<string, unknown>[] | undefined;
  if (value.provenance !== undefined) {
    if (
      !Array.isArray(value.provenance) ||
      value.provenance.length > 1_000 ||
      value.provenance.some((item) => !isRecord(item))
    ) {
      throw new Error(`${label}.provenance must be an array of objects`);
    }
    provenance = value.provenance as Record<string, unknown>[];
  }
  return {
    schema: PUBLIC_TEMPLATE_ENTRY_SCHEMA,
    providerId: provider.providerId,
    templateId,
    releaseVersion,
    contentDigest: assertDigest(value.contentDigest, `${label}.contentDigest`),
    title: nonEmptyString(value.title, `${label}.title`, 300),
    description: nonEmptyString(value.description, `${label}.description`, 4_000),
    search: {
      application: boundedString(value.search.application, `${label}.search.application`, 4_000),
      dataProfile: boundedString(value.search.dataProfile, `${label}.search.dataProfile`, 4_000),
      plotFamily: nonEmptyString(value.search.plotFamily, `${label}.search.plotFamily`, 200),
      language: nonEmptyString(value.search.language, `${label}.search.language`, 100),
      tags: assertStringArray(value.search.tags, `${label}.search.tags`, 10_000, 100),
      packages: assertStringArray(value.search.packages, `${label}.search.packages`, 10_000, 200),
      codeFiles: assertStringArray(value.search.codeFiles, `${label}.search.codeFiles`),
      inputFiles: assertStringArray(value.search.inputFiles, `${label}.search.inputFiles`),
    },
    archive: parseArchiveIdentity(
      value.archive,
      `${label}.archive`,
      templateId,
      releaseVersion,
      provider.archiveRepository,
    ),
    preview: parsePreviewIdentity(
      value.preview,
      `${label}.preview`,
      templateId,
      releaseVersion,
    ),
    status: {
      upstreamStatus: "published",
      publisherVerified: value.status.publisherVerified,
      curationStatus: value.status.curationStatus as PublicCurationStatus,
      renderValidation: value.status.renderValidation as PublicRenderValidation,
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
    },
    licenses: {
      code: nonEmptyString(value.licenses.code, `${label}.licenses.code`, 100),
      content: nonEmptyString(value.licenses.content, `${label}.licenses.content`, 100),
      documentation: nonEmptyString(
        value.licenses.documentation,
        `${label}.licenses.documentation`,
        100,
      ),
    },
    ...(provenance ? { provenance } : {}),
  };
}

export function parsePublicProviderCatalog(
  bytes: Uint8Array,
): PublicProviderCatalogV1 {
  const value = parseUtf8Json(bytes, "public Provider Catalog", MAX_CATALOG_BYTES);
  if (!isRecord(value)) throw new Error("public Provider Catalog must be an object");
  assertKeys(value, ["schema", "provider", "generatedAt", "entries"], [], "catalog");
  if (value.schema !== PUBLIC_CATALOG_SCHEMA) throw new Error("unsupported public Catalog schema");
  if (!isRecord(value.provider)) throw new Error("catalog.provider is missing");
  assertKeys(
    value.provider,
    ["providerId", "displayName", "catalogRepository", "archiveRepository"],
    [],
    "catalog.provider",
  );
  const providerId = nonEmptyString(value.provider.providerId, "catalog.provider.providerId", 128);
  if (!PROVIDER_ID.test(providerId)) throw new Error("catalog Provider identifier is invalid");
  const provider = {
    providerId,
    displayName: nonEmptyString(value.provider.displayName, "catalog.provider.displayName", 200),
    catalogRepository: assertRepository(
      value.provider.catalogRepository,
      "catalog.provider.catalogRepository",
    ),
    archiveRepository: assertRepository(
      value.provider.archiveRepository,
      "catalog.provider.archiveRepository",
    ),
  };
  const generatedAt = assertRfc3339(value.generatedAt, "catalog.generatedAt");
  if (!Array.isArray(value.entries) || value.entries.length > 100_000) {
    throw new Error("catalog.entries must be an array with at most 100000 entries");
  }
  const entries = value.entries.map((entry, index) =>
    parsePublicTemplateEntry(entry, provider, index),
  );
  let previous = "";
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.templateId}@${entry.releaseVersion}`;
    if (identities.has(identity)) throw new Error(`duplicate public release identity: ${identity}`);
    if (previous && compareCanonicalStrings(identity, previous) <= 0) {
      throw new Error(`public Catalog entries are not canonically ordered at ${identity}`);
    }
    identities.add(identity);
    previous = identity;
  }
  return { schema: PUBLIC_CATALOG_SCHEMA, provider, generatedAt, entries };
}

function parsePreviewManifest(
  bytes: Uint8Array,
  catalog: PublicProviderCatalogV1,
): PublicPreviewManifestV1 {
  const value = parseUtf8Json(bytes, "public preview manifest", MAX_CATALOG_BYTES);
  if (!isRecord(value)) throw new Error("public preview manifest must be an object");
  assertKeys(value, ["schema", "providerId", "entries"], [], "previewManifest");
  if (
    value.schema !== PUBLIC_PREVIEW_MANIFEST_SCHEMA ||
    value.providerId !== catalog.provider.providerId ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("public preview manifest does not match its Catalog");
  }
  const entries = value.entries.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`previewManifest.entries[${index}] is invalid`);
    assertKeys(
      entry,
      [
        "templateId",
        "releaseVersion",
        "path",
        "bytes",
        "sha256",
        "mediaType",
        "width",
        "height",
        "canonicalRgbaSha256",
      ],
      [],
      `previewManifest.entries[${index}]`,
    );
    const matching = catalog.entries[index];
    if (!matching) throw new Error("preview manifest has more entries than its Catalog");
    const expected = {
      templateId: matching.templateId,
      releaseVersion: matching.releaseVersion,
      ...matching.preview,
    };
    if (canonicalJson(entry) !== canonicalJson(expected)) {
      throw new Error(`preview manifest entry differs from Catalog at index ${index}`);
    }
    return expected;
  });
  if (entries.length !== catalog.entries.length) {
    throw new Error("preview manifest entry count differs from its Catalog");
  }
  return {
    schema: PUBLIC_PREVIEW_MANIFEST_SCHEMA,
    providerId: catalog.provider.providerId,
    entries,
  };
}

export async function createPublicCatalogSnapshot(options: {
  catalogBytes: Uint8Array;
  previewManifestBytes: Uint8Array;
  loadPreview: (relativePath: string) => Promise<Uint8Array>;
  expectedCatalogSha256?: string;
  expectedPreviewManifestSha256?: string;
  revision?: string;
  trust: PublicCatalogSnapshot["trust"];
  sourceReference: string;
}): Promise<PublicCatalogSnapshot> {
  const catalogBytes = new Uint8Array(options.catalogBytes);
  const previewManifestBytes = new Uint8Array(options.previewManifestBytes);
  const catalogSha256 = sha256(catalogBytes);
  const previewManifestSha256 = sha256(previewManifestBytes);
  if (
    options.expectedCatalogSha256 &&
    catalogSha256 !== options.expectedCatalogSha256.toLocaleLowerCase("en-US")
  ) {
    throw new Error("public Catalog SHA-256 differs from its trusted source identity");
  }
  if (
    options.expectedPreviewManifestSha256 &&
    previewManifestSha256 !== options.expectedPreviewManifestSha256.toLocaleLowerCase("en-US")
  ) {
    throw new Error("public preview manifest SHA-256 differs from its trusted source identity");
  }
  const catalog = parsePublicProviderCatalog(catalogBytes);
  if (
    options.trust === "bundled" &&
    catalog.provider.providerId !== COMMUNITY_PROVIDER_ID
  ) {
    throw new Error("only the fixed Community Provider may use the bundled trust boundary");
  }
  if (
    options.trust === "signed-snapshot" &&
    catalog.provider.providerId === COMMUNITY_PROVIDER_ID
  ) {
    throw new Error("a signed personal snapshot cannot claim the bundled Community Provider identity");
  }
  const previewManifest = parsePreviewManifest(previewManifestBytes, catalog);
  const previews = new Map<string, Uint8Array>();
  let previewPackBytes = 0;
  for (const entry of catalog.entries) {
    const bytes = new Uint8Array(await options.loadPreview(entry.preview.path));
    if (
      bytes.byteLength !== entry.preview.bytes ||
      sha256(bytes) !== entry.preview.sha256
    ) {
      throw new Error(
        `public preview failed byte/SHA-256 verification: ${entry.templateId}@${entry.releaseVersion}`,
      );
    }
    if (
      bytes.byteLength < 24 ||
      !Buffer.from(bytes.subarray(0, 8)).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      ) ||
      Buffer.from(bytes).readUInt32BE(16) !== entry.preview.width ||
      Buffer.from(bytes).readUInt32BE(20) !== entry.preview.height
    ) {
      throw new Error(`public preview PNG identity is invalid: ${entry.preview.path}`);
    }
    previewPackBytes += bytes.byteLength;
    if (previewPackBytes > MAX_PREVIEW_BYTES) {
      throw new Error("public preview snapshot exceeds the 64 MiB pack limit");
    }
    if (entry.preview.width * entry.preview.height * 4 > MAX_PREVIEW_RGBA_BYTES) {
      throw new Error(`public preview canonical RGBA payload is too large: ${entry.preview.path}`);
    }
    let decoded: PNG;
    try {
      decoded = PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
    } catch (error) {
      throw new Error(
        `public preview PNG decoding failed for ${entry.preview.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      decoded.width !== entry.preview.width ||
      decoded.height !== entry.preview.height ||
      sha256(decoded.data) !== entry.preview.canonicalRgbaSha256
    ) {
      throw new Error(`public preview canonical RGBA identity is invalid: ${entry.preview.path}`);
    }
    previews.set(entry.preview.path, bytes);
  }
  const revision = options.revision ?? sha256(
    canonicalJson({
      schema: "figure-library.public-catalog-snapshot-revision.v1",
      providerId: catalog.provider.providerId,
      catalogSha256,
      previewManifestSha256,
    }),
  );
  return {
    catalog,
    catalogBytes,
    catalogSha256,
    previewManifest,
    previewManifestSha256,
    previews,
    revision,
    trust: options.trust,
    sourceReference: nonEmptyString(options.sourceReference, "sourceReference", 1_000),
  };
}

interface CommunitySourceLockV1 {
  schema: "figure-library.community-source-lock.v1";
  providerId: typeof COMMUNITY_PROVIDER_ID;
  catalogRepository: string;
  catalogCommit: string;
  archiveRepository: string;
  catalog: { path: string; bytes: number; sha256: string };
  previewManifest: { path: string; bytes: number; sha256: string };
}

function parseCommunitySourceLock(value: unknown): CommunitySourceLockV1 {
  if (!isRecord(value)) throw new Error("Community source lock must be an object");
  assertKeys(
    value,
    [
      "schema",
      "providerId",
      "catalogRepository",
      "catalogCommit",
      "archiveRepository",
      "catalog",
      "previewManifest",
    ],
    [],
    "sourceLock",
  );
  if (
    value.schema !== "figure-library.community-source-lock.v1" ||
    value.providerId !== COMMUNITY_PROVIDER_ID
  ) {
    throw new Error("unsupported Community source lock identity");
  }
  const catalogCommit = nonEmptyString(value.catalogCommit, "sourceLock.catalogCommit", 40);
  if (!COMMIT.test(catalogCommit)) throw new Error("sourceLock.catalogCommit must be 40-hex");
  const fileIdentity = (item: unknown, label: string) => {
    if (!isRecord(item)) throw new Error(`${label} is missing`);
    assertKeys(item, ["path", "bytes", "sha256"], [], label);
    return {
      path: assertPortableArchivePath(item.path, `${label}.path`),
      bytes: positiveInteger(item.bytes, `${label}.bytes`, MAX_CATALOG_BYTES),
      sha256: assertDigest(item.sha256, `${label}.sha256`),
    };
  };
  return {
    schema: "figure-library.community-source-lock.v1",
    providerId: COMMUNITY_PROVIDER_ID,
    catalogRepository: assertRepository(
      value.catalogRepository,
      "sourceLock.catalogRepository",
    ),
    catalogCommit,
    archiveRepository: assertRepository(
      value.archiveRepository,
      "sourceLock.archiveRepository",
    ),
    catalog: fileIdentity(value.catalog, "sourceLock.catalog"),
    previewManifest: fileIdentity(
      value.previewManifest,
      "sourceLock.previewManifest",
    ),
  };
}

export async function loadBundledCommunitySnapshot(
  root = path.resolve(import.meta.dirname, "..", "assets", "community"),
) {
  const sourceLock = parseCommunitySourceLock(
    JSON.parse(await fs.readFile(path.join(root, "source.lock.json"), "utf8")) as unknown,
  );
  const catalogBytes = new Uint8Array(
    await fs.readFile(path.join(root, ...sourceLock.catalog.path.split("/"))),
  );
  const previewManifestBytes = new Uint8Array(
    await fs.readFile(path.join(root, ...sourceLock.previewManifest.path.split("/"))),
  );
  if (
    catalogBytes.byteLength !== sourceLock.catalog.bytes ||
    previewManifestBytes.byteLength !== sourceLock.previewManifest.bytes
  ) {
    throw new Error("bundled Community snapshot byte length differs from source.lock.json");
  }
  const snapshot = await createPublicCatalogSnapshot({
    catalogBytes,
    previewManifestBytes,
    loadPreview: async (relative) =>
      new Uint8Array(await fs.readFile(path.join(root, ...relative.split("/")))),
    expectedCatalogSha256: sourceLock.catalog.sha256,
    expectedPreviewManifestSha256: sourceLock.previewManifest.sha256,
    revision: sourceLock.catalogCommit,
    trust: "bundled",
    sourceReference: `${sourceLock.catalogRepository}@${sourceLock.catalogCommit}`,
  });
  if (
    snapshot.catalog.provider.providerId !== COMMUNITY_PROVIDER_ID ||
    snapshot.catalog.provider.catalogRepository !== sourceLock.catalogRepository ||
    snapshot.catalog.provider.archiveRepository !== sourceLock.archiveRepository
  ) {
    throw new Error("bundled Community Catalog differs from source.lock.json Provider identity");
  }
  return snapshot;
}

export function publicTemplateSelector(
  entry: PublicTemplateEntryV1,
  catalogSha256: string,
): PublicTemplateExactSelector {
  return {
    schema: "figure-library.provider-selector.v1",
    providerId: entry.providerId,
    kind: PUBLIC_SELECTOR_KIND,
    identity: {
      templateId: entry.templateId,
      releaseVersion: entry.releaseVersion,
      contentDigest: entry.contentDigest,
      catalogSha256: assertDigest(catalogSha256, "catalogSha256"),
      archive: { ...entry.archive },
      preview: {
        bytes: entry.preview.bytes,
        sha256: entry.preview.sha256,
        mediaType: entry.preview.mediaType,
      },
      mode: "template",
    },
  };
}

export function assertPublicTemplateSelector(
  value: unknown,
): asserts value is PublicTemplateExactSelector {
  if (!isRecord(value)) throw new Error("public selector must be an object");
  assertKeys(value, ["schema", "providerId", "kind", "identity"], [], "exactSelector");
  assertExactTemplateSelector(value);
  if (value.kind !== PUBLIC_SELECTOR_KIND) throw new Error("selector is not a public template");
  if (!PROVIDER_ID.test(value.providerId)) throw new Error("public selector providerId is invalid");
  const identity = value.identity;
  assertKeys(
    identity,
    [
      "templateId",
      "releaseVersion",
      "contentDigest",
      "catalogSha256",
      "archive",
      "preview",
      "mode",
    ],
    [],
    "exactSelector.identity",
  );
  const templateId = nonEmptyString(identity.templateId, "exactSelector.identity.templateId", 128);
  if (!TEMPLATE_ID.test(templateId)) throw new Error("public selector templateId is invalid");
  const releaseVersion = nonEmptyString(
    identity.releaseVersion,
    "exactSelector.identity.releaseVersion",
    100,
  );
  if (!STRICT_SEMVER.test(releaseVersion)) throw new Error("public selector releaseVersion is invalid");
  assertDigest(identity.contentDigest, "exactSelector.identity.contentDigest");
  assertDigest(identity.catalogSha256, "exactSelector.identity.catalogSha256");
  if (identity.mode !== "template") throw new Error("public selector mode must be template");
  if (!isRecord(identity.archive)) throw new Error("public selector archive is missing");
  assertKeys(
    identity.archive,
    ["repository", "commit", "path", "bytes", "sha256"],
    [],
    "exactSelector.identity.archive",
  );
  assertRepository(identity.archive.repository, "exactSelector.identity.archive.repository");
  if (!COMMIT.test(nonEmptyString(identity.archive.commit, "exactSelector.identity.archive.commit", 40))) {
    throw new Error("public selector archive commit must be 40-hex");
  }
  const selectorArchivePath = assertPortableArchivePath(
    identity.archive.path,
    "exactSelector.identity.archive.path",
  );
  const expectedArchivePath =
    `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`;
  if (selectorArchivePath !== expectedArchivePath) {
    throw new Error(`public selector archive path must be ${expectedArchivePath}`);
  }
  positiveInteger(identity.archive.bytes, "exactSelector.identity.archive.bytes", MAX_ARCHIVE_BYTES);
  assertDigest(identity.archive.sha256, "exactSelector.identity.archive.sha256");
  if (!isRecord(identity.preview)) throw new Error("public selector preview is missing");
  assertKeys(
    identity.preview,
    ["bytes", "sha256", "mediaType"],
    [],
    "exactSelector.identity.preview",
  );
  positiveInteger(identity.preview.bytes, "exactSelector.identity.preview.bytes", MAX_PREVIEW_BYTES);
  assertDigest(identity.preview.sha256, "exactSelector.identity.preview.sha256");
  if (identity.preview.mediaType !== "image/png") {
    throw new Error("public selector preview mediaType must be image/png");
  }
}

function rawArchiveUrl(identity: PublicArchiveIdentityV1) {
  const repository = assertRepository(identity.repository, "archive.repository");
  const commit = nonEmptyString(identity.commit, "archive.commit", 40);
  if (!COMMIT.test(commit)) throw new Error("archive commit must be 40-hex");
  const archivePath = assertPortableArchivePath(identity.path, "archive.path");
  return `https://raw.githubusercontent.com/${repository
    .split("/")
    .map(encodeURIComponent)
    .join("/")}/${commit}/${archivePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

const secureArchiveFetcher = new SecureProviderSourceFetcher({
  timeoutMs: 60_000,
  maxRedirects: 3,
});

export const defaultPublicArchiveFetcher: PublicArchiveFetcher = async (request) => {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "raw.githubusercontent.com" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("public archive URL must be credential-free fixed GitHub raw HTTPS");
  }
  if (request.timeoutMs !== 60_000 || request.maxBytes !== MAX_ARCHIVE_BYTES) {
    throw new Error("public archive fetch policy differs from the fixed 0.6.0 security limits");
  }
  const response = await secureArchiveFetcher.fetch(url.href, {
    maxBytes: request.maxBytes,
    mediaTypes: [
      "application/zip",
      "application/x-zip-compressed",
      "application/octet-stream",
    ],
  });
  return response.bytes;
};

interface CentralZipEntry {
  name: string;
  directory: boolean;
  compressedBytes: number;
  expandedBytes: number;
  crc32: number;
  localHeaderOffset: number;
  dataOffset: number;
}

function readUInt16(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function centralZipEntries(bytes: Uint8Array): CentralZipEntry[] {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("public archive exceeds 100 MiB");
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUInt32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("public archive has no valid ZIP end record");
  const disk = readUInt16(bytes, eocd + 4);
  const centralDisk = readUInt16(bytes, eocd + 6);
  const entriesOnDisk = readUInt16(bytes, eocd + 8);
  const entryCount = readUInt16(bytes, eocd + 10);
  const centralBytes = readUInt32(bytes, eocd + 12);
  const centralOffset = readUInt32(bytes, eocd + 16);
  const commentBytes = readUInt16(bytes, eocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("multi-disk and ZIP64 public archives are not supported");
  }
  if (entryCount > MAX_FILES) throw new Error("public archive contains more than 10000 entries");
  if (eocd + 22 + commentBytes !== bytes.byteLength) {
    throw new Error("public archive contains trailing or malformed ZIP data");
  }
  if (centralOffset + centralBytes !== eocd) {
    throw new Error("public archive central directory boundaries are invalid");
  }
  const entries: CentralZipEntry[] = [];
  const folded = new Map<string, { name: string; directory: boolean }>();
  let expandedTotal = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || readUInt32(bytes, offset) !== 0x02014b50) {
      throw new Error("public archive central directory is malformed");
    }
    const madeBy = readUInt16(bytes, offset + 4);
    const flags = readUInt16(bytes, offset + 8);
    const compression = readUInt16(bytes, offset + 10);
    const expectedCrc32 = readUInt32(bytes, offset + 16);
    const compressedBytes = readUInt32(bytes, offset + 20);
    const expandedBytes = readUInt32(bytes, offset + 24);
    const nameBytes = readUInt16(bytes, offset + 28);
    const extraBytes = readUInt16(bytes, offset + 30);
    const entryCommentBytes = readUInt16(bytes, offset + 32);
    const startingDisk = readUInt16(bytes, offset + 34);
    const externalAttributes = readUInt32(bytes, offset + 38);
    const localHeaderOffset = readUInt32(bytes, offset + 42);
    const end = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      end > eocd ||
      expandedBytes === 0xffffffff ||
      compressedBytes === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      startingDisk !== 0
    ) {
      throw new Error("public archive entry boundaries or ZIP64 fields are invalid");
    }
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset + 46, offset + 46 + nameBytes),
      );
    } catch {
      throw new Error("public archive entry name is not valid UTF-8");
    }
    if (
      !(flags & 0x800) &&
      bytes.subarray(offset + 46, offset + 46 + nameBytes).some((byte) => byte > 0x7f)
    ) {
      throw new Error("public archive non-ASCII entry names must set the UTF-8 ZIP flag");
    }
    const directory = name.endsWith("/");
    const safe = assertPortableArchivePath(name, "ZIP entry", directory);
    if (flags & 0x41) throw new Error(`public archive contains encrypted entry: ${safe}`);
    if (flags & ~0x84f) {
      throw new Error(`public archive uses unsupported ZIP flags: ${safe}`);
    }
    if (compression !== 0 && compression !== 8) {
      throw new Error(`public archive uses unsupported compression: ${safe}`);
    }
    const platform = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (platform === 3 && (unixMode & 0xf000) === 0xa000) {
      throw new Error(`public archive contains a symlink: ${safe}`);
    }
    if (
      platform === 3 &&
      (unixMode & 0xf000) !== 0 &&
      (unixMode & 0xf000) !== (directory ? 0x4000 : 0x8000)
    ) {
      throw new Error(`public archive contains a non-regular filesystem entry: ${safe}`);
    }
    if (
      localHeaderOffset + 30 > centralOffset ||
      readUInt32(bytes, localHeaderOffset) !== 0x04034b50
    ) {
      throw new Error(`public archive local header is invalid: ${safe}`);
    }
    const localFlags = readUInt16(bytes, localHeaderOffset + 6);
    const localCompression = readUInt16(bytes, localHeaderOffset + 8);
    const localNameBytes = readUInt16(bytes, localHeaderOffset + 26);
    const localExtraBytes = readUInt16(bytes, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameBytes + localExtraBytes;
    if (
      localFlags !== flags ||
      localCompression !== compression ||
      localNameBytes !== nameBytes ||
      dataOffset + compressedBytes > centralOffset ||
      !Buffer.from(
        bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameBytes),
      ).equals(Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameBytes)))
    ) {
      throw new Error(`public archive local/central header mismatch: ${safe}`);
    }
    if (!(flags & 8)) {
      if (
        readUInt32(bytes, localHeaderOffset + 14) !== expectedCrc32 ||
        readUInt32(bytes, localHeaderOffset + 18) !== compressedBytes ||
        readUInt32(bytes, localHeaderOffset + 22) !== expandedBytes
      ) {
        throw new Error(`public archive local header identity mismatch: ${safe}`);
      }
    }
    const fold = safe.replace(/\/$/u, "").normalize("NFC").toLocaleLowerCase("en-US");
    const collision = folded.get(fold);
    if (collision) {
      throw new Error(`public archive portable case-fold collision: ${collision.name}, ${safe}`);
    }
    const parts = fold.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const ancestor = folded.get(parts.slice(0, length).join("/"));
      if (ancestor && !ancestor.directory) {
        throw new Error(
          `public archive file/directory collision: ${ancestor.name}, ${safe}`,
        );
      }
    }
    if (!directory) {
      const descendant = [...folded.entries()].find(([key]) => key.startsWith(`${fold}/`));
      if (descendant) {
        throw new Error(
          `public archive file/directory collision: ${safe}, ${descendant[1].name}`,
        );
      }
    }
    folded.set(fold, { name: safe, directory });
    if (!directory) {
      if (expandedBytes > MAX_FILE_BYTES) {
        throw new Error(`public archive entry exceeds 64 MiB: ${safe}`);
      }
      expandedTotal += expandedBytes;
      if (expandedTotal > MAX_EXPANDED_BYTES) {
        throw new Error("public archive expanded payload exceeds 128 MiB");
      }
    }
    entries.push({
      name: safe,
      directory,
      compressedBytes,
      expandedBytes,
      crc32: expectedCrc32,
      localHeaderOffset,
      dataOffset,
    });
    offset = end;
  }
  if (offset !== eocd) throw new Error("public archive central directory entry count is invalid");
  const spans = entries
    .map((entry) => ({ start: entry.localHeaderOffset, end: entry.dataOffset + entry.compressedBytes, name: entry.name }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index]!.start < spans[index - 1]!.end) {
      throw new Error(
        `public archive local entry ranges overlap: ${spans[index - 1]!.name}, ${spans[index]!.name}`,
      );
    }
  }
  return entries;
}

function parseJsonFile(files: Map<string, Uint8Array>, name: string) {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`public archive is missing ${name}`);
  return parseUtf8Json(bytes, `public archive ${name}`, MAX_FILE_BYTES);
}

interface NormalizedArchiveStatus {
  upstreamStatus: "published";
  publisherVerified: boolean;
  curationStatus: PublicCurationStatus;
  renderValidation: PublicRenderValidation;
  localReviewStatus: "not_reviewed";
  plotExecutionByRecipient: "not_run";
}

interface NormalizedRenderTrace {
  entrypoint: string;
  codePaths: string[];
  inputPaths: string[];
  previewPath: "payload/preview/preview.png";
}

function archiveTemplateStatus(template: Record<string, unknown>): NormalizedArchiveStatus {
  if (!isRecord(template.metadata)) {
    throw new Error("public archive template metadata is missing");
  }
  const metadata = template.metadata;
  if (
    metadata.upstreamStatus !== "published" ||
    typeof metadata.publisherVerified !== "boolean" ||
    !["curated", "unreviewed"].includes(String(metadata.curationStatus)) ||
    !["ci_rendered", "publisher_attested", "unverified"].includes(
      String(metadata.renderValidation),
    ) ||
    metadata.localReviewStatus !== "not_reviewed" ||
    metadata.plotExecutionByRecipient !== "not_run"
  ) {
    throw new Error("public archive template trust statuses are invalid");
  }
  return {
    upstreamStatus: "published",
    publisherVerified: metadata.publisherVerified,
    curationStatus: metadata.curationStatus as PublicCurationStatus,
    renderValidation: metadata.renderValidation as PublicRenderValidation,
    localReviewStatus: "not_reviewed",
    plotExecutionByRecipient: "not_run",
  };
}

function assertArchiveFileIdentity(
  value: unknown,
  files: Map<string, Uint8Array>,
  label: string,
  expectedPrefix: string,
) {
  if (!isRecord(value)) throw new Error(`${label} is missing`);
  assertKeys(value, ["path", "bytes", "sha256"], [], label);
  const file = assertPortableArchivePath(value.path, `${label}.path`);
  if (!file.startsWith(expectedPrefix)) {
    throw new Error(`${label}.path is outside ${expectedPrefix}`);
  }
  const payload = files.get(file);
  if (
    !payload ||
    value.bytes !== payload.byteLength ||
    assertDigest(value.sha256, `${label}.sha256`) !== sha256(payload)
  ) {
    throw new Error(`${label} identity does not match the public archive payload`);
  }
  return file;
}

function normalizeRenderTrace(
  render: Record<string, unknown>,
  files: Map<string, Uint8Array>,
  entry: PublicTemplateEntryV1,
): NormalizedRenderTrace {
  if (render.schema !== "figure-library.render-receipt.v1") {
    throw new Error("unsupported public archive render receipt schema");
  }
  const entrypoint = assertPortableArchivePath(
    render.entrypoint,
    "render-receipt.entrypoint",
  );
  if (entrypoint !== "payload/code/render.R") {
    throw new Error("public archive render receipt must use payload/code/render.R");
  }
  let codePaths: string[];
  let inputPaths: string[];
  let previewPath: string;
  if (Array.isArray(render.codePaths) && Array.isArray(render.inputPaths)) {
    assertKeys(
      render,
      [
        "schema",
        "entrypoint",
        "inputPaths",
        "codePaths",
        "previewPath",
        "previewBytes",
        "previewSha256",
        "mediaType",
        "width",
        "height",
        "canonicalRgbaSha256",
        "sourceExecution",
        "codeExecutedBySflClient",
      ],
      [],
      "render-receipt",
    );
    codePaths = assertStringArray(render.codePaths, "render-receipt.codePaths", 1_000);
    inputPaths = assertStringArray(render.inputPaths, "render-receipt.inputPaths", 10_000);
    previewPath = assertPortableArchivePath(
      render.previewPath,
      "render-receipt.previewPath",
    );
    if (
      render.sourceExecution !== "publisher_attested" ||
      render.codeExecutedBySflClient !== false
    ) {
      throw new Error("public archive render receipt execution claims are invalid");
    }
  } else {
    assertKeys(
      render,
      [
        "schema",
        "entrypoint",
        "inputFiles",
        "code",
        "output",
        "publisherRuntime",
        "reviewedCiRuntime",
        "randomSeed",
        "previewBytes",
        "previewSha256",
        "width",
        "height",
        "mediaType",
        "canonicalRgbaSha256",
        "generatedFromSubmittedCodeAndSyntheticData",
      ],
      [],
      "render-receipt",
    );
    if (!Array.isArray(render.inputFiles) || !render.inputFiles.length) {
      throw new Error("public archive render receipt has no synthetic input identities");
    }
    inputPaths = render.inputFiles.map((item, index) =>
      assertArchiveFileIdentity(
        item,
        files,
        `render-receipt.inputFiles[${index}]`,
        "payload/data/",
      ),
    );
    if (!isRecord(render.code)) throw new Error("render-receipt.code is missing");
    assertKeys(render.code, ["path", "bytes", "sha256", "license"], [], "render-receipt.code");
    const codePath = assertArchiveFileIdentity(
      {
        path: render.code.path,
        bytes: render.code.bytes,
        sha256: render.code.sha256,
      },
      files,
      "render-receipt.code",
      "payload/code/",
    );
    if (render.code.license !== entry.licenses.code) {
      throw new Error("public archive render code license differs from its Catalog");
    }
    codePaths = [codePath];
    if (!isRecord(render.output)) throw new Error("render-receipt.output is missing");
    assertKeys(render.output, ["path", "license"], [], "render-receipt.output");
    previewPath = assertPortableArchivePath(
      render.output.path,
      "render-receipt.output.path",
    );
    if (render.output.license !== entry.licenses.content) {
      throw new Error("public archive rendered output license differs from its Catalog");
    }
    if (
      !isRecord(render.reviewedCiRuntime) ||
      render.reviewedCiRuntime.networkRequired !== false ||
      render.generatedFromSubmittedCodeAndSyntheticData !== true
    ) {
      throw new Error("public archive render receipt lacks the offline code/data provenance claim");
    }
  }
  codePaths = codePaths.map((value, index) =>
    assertPortableArchivePath(value, `render-receipt.codePaths[${index}]`),
  );
  inputPaths = inputPaths.map((value, index) =>
    assertPortableArchivePath(value, `render-receipt.inputPaths[${index}]`),
  );
  if (
    !codePaths.length ||
    !inputPaths.length ||
    !codePaths.includes(entrypoint) ||
    codePaths.some((name) => !name.startsWith("payload/code/") || !files.has(name)) ||
    inputPaths.some((name) => !name.startsWith("payload/data/") || !files.has(name)) ||
    previewPath !== "payload/preview/preview.png"
  ) {
    throw new Error("public archive render trace does not bind code/data/preview payloads");
  }
  if (
    render.previewBytes !== entry.preview.bytes ||
    render.previewSha256 !== entry.preview.sha256 ||
    render.mediaType !== entry.preview.mediaType ||
    render.width !== entry.preview.width ||
    render.height !== entry.preview.height ||
    render.canonicalRgbaSha256 !== entry.preview.canonicalRgbaSha256
  ) {
    throw new Error("public archive render receipt differs from its Catalog preview identity");
  }
  return {
    entrypoint,
    codePaths,
    inputPaths,
    previewPath: "payload/preview/preview.png",
  };
}

function containsPrivateMachinePath(text: string) {
  return /(?:^|[\s"'`(=])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|\/(?:Users|home|mnt\/[a-z]|private|var\/folders|tmp|etc|opt|root|srv|workspace|data)\/)/mu.test(
    text,
  );
}

function assertSafePublicPayload(name: string, bytes: Uint8Array) {
  const signature = Buffer.from(bytes.subarray(0, 16));
  const forbiddenBinary =
    signature.subarray(0, 5).toString("ascii") === "%PDF-" ||
    signature.subarray(0, 2).toString("ascii") === "MZ" ||
    signature.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    signature.subarray(0, 3).toString("ascii") === "GIF" ||
    signature.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ||
    signature.subarray(0, 4).toString("ascii") === "RIFF" ||
    signature.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    signature.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])) ||
    signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (name !== "payload/preview/preview.png" && forbiddenBinary) {
    throw new Error(`public archive contains forbidden executable/document/media payload: ${name}`);
  }
  if (name.startsWith("payload/code/") && !/\.r$/iu.test(name)) {
    throw new Error(`public archive render code must use an .R path: ${name}`);
  }
  if (
    name.startsWith("payload/data/") &&
    !/\.(?:csv|tsv|jsonl?|txt|ya?ml)$/iu.test(name)
  ) {
    throw new Error(`public archive synthetic data must use a reviewable text format: ${name}`);
  }
  if (name.startsWith("payload/docs/") && !/\.(?:md|txt)$/iu.test(name)) {
    throw new Error(`public archive documentation must be Markdown or plain text: ${name}`);
  }
  if (/\.(?:r|md|txt|csv|tsv|json|ya?ml)$/iu.test(name)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`public archive textual asset is not UTF-8: ${name}`);
    }
    if (/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(text)) {
      throw new Error(`public archive contains forbidden SVG media: ${name}`);
    }
    if (containsPrivateMachinePath(text)) {
      throw new Error(`public archive contains an absolute/private machine path: ${name}`);
    }
  }
}

function assertSubmissionBoundary(submission: Record<string, unknown>) {
  const parent = submission.parentLocalRelease;
  if (!isRecord(parent)) throw new Error("submission.parentLocalRelease is missing");
  const sanitizedExport =
    parent.relationship === "sanitized-export-from-local-published" &&
    parent.explicitlySelectedAssetsOnly === true &&
    parent.privateLifecycleIdentifiersIncluded === false;
  const cleanRoomSeed =
    parent.relationship === "design-and-exclusion-audit-only" &&
    parent.bytesCopied === false &&
    parent.metadataCopied === false &&
    parent.privateAssetsIncluded === false;
  if (sanitizedExport) {
    assertKeys(
      parent,
      [
        "relationship",
        "explicitlySelectedAssetsOnly",
        "privateLifecycleIdentifiersIncluded",
      ],
      [],
      "submission.parentLocalRelease",
    );
  } else if (cleanRoomSeed) {
    assertKeys(
      parent,
      ["relationship", "bytesCopied", "metadataCopied", "privateAssetsIncluded"],
      [],
      "submission.parentLocalRelease",
    );
  } else {
    throw new Error("submission parent Local boundary is unsafe or unsupported");
  }

  const rights = submission.rightsAttestation;
  if (!isRecord(rights)) throw new Error("submission.rightsAttestation is missing");
  const exportRights =
    typeof rights.publisher === "string" &&
    Boolean(rights.publisher.trim()) &&
    rights.codeRightsConfirmed === true &&
    rights.syntheticDataConfirmed === true &&
    rights.generatedPreviewConfirmed === true &&
    rights.noThirdPartyMediaConfirmed === true &&
    rights.immutableReleaseAcknowledged === true;
  const seedRights =
    rights.codeLicense === "MIT" &&
    rights.contentLicense === "CC-BY-4.0" &&
    rights.cleanRoomAuthored === true &&
    rights.syntheticDataOnly === true &&
    rights.previewGeneratedByIncludedCodeAndData === true &&
    rights.thirdPartyMediaIncluded === false &&
    rights.screenshotsIncluded === false &&
    rights.paperOrPdfContentIncluded === false &&
    rights.patientOrExperimentalDataIncluded === false;
  if (exportRights) {
    assertKeys(
      rights,
      [
        "publisher",
        "codeRightsConfirmed",
        "syntheticDataConfirmed",
        "generatedPreviewConfirmed",
        "noThirdPartyMediaConfirmed",
        "immutableReleaseAcknowledged",
      ],
      [],
      "submission.rightsAttestation",
    );
  } else if (seedRights) {
    assertKeys(
      rights,
      [
        "codeLicense",
        "contentLicense",
        "cleanRoomAuthored",
        "syntheticDataOnly",
        "previewGeneratedByIncludedCodeAndData",
        "thirdPartyMediaIncluded",
        "screenshotsIncluded",
        "paperOrPdfContentIncluded",
        "patientOrExperimentalDataIncluded",
      ],
      [],
      "submission.rightsAttestation",
    );
  } else {
    throw new Error("submission rights attestation is incomplete or unsafe");
  }
  const excluded = assertStringArray(
    submission.excludedPrivateState,
    "submission.excludedPrivateState",
    100,
    200,
  );
  const excludedText = excluded.join(" ").toLocaleLowerCase("en-US");
  if (!excludedText.includes("absolute") || !excludedText.includes("local")) {
    throw new Error("submission does not explicitly exclude local identity and absolute paths");
  }
}

function assertTemplateBoundary(
  template: Record<string, unknown>,
  entry: PublicTemplateEntryV1,
) {
  if (!isRecord(template.licenses)) throw new Error("public archive template licenses are missing");
  if (
    template.licenses.code !== entry.licenses.code ||
    template.licenses.syntheticData !== entry.licenses.content ||
    template.licenses.preview !== entry.licenses.content ||
    template.licenses.documentation !== entry.licenses.documentation
  ) {
    throw new Error("public archive template licenses differ from its Catalog entry");
  }
  if (!isRecord(template.render)) throw new Error("public archive template render contract is missing");
  const contract = template.render;
  if (
    contract.entrypoint !== "payload/code/render.R" ||
    (contract.clientExecutionRequired !== undefined &&
      contract.clientExecutionRequired !== false) ||
    (contract.previewPath !== undefined &&
      contract.previewPath !== "payload/preview/preview.png") ||
    (contract.inputDirectory !== undefined && contract.inputDirectory !== "payload/data") ||
    (contract.outputMediaType !== undefined && contract.outputMediaType !== "image/png") ||
    (contract.mediaType !== undefined && contract.mediaType !== "image/png") ||
    (contract.previewBytes !== undefined && contract.previewBytes !== entry.preview.bytes) ||
    (contract.previewSha256 !== undefined && contract.previewSha256 !== entry.preview.sha256) ||
    (contract.width !== undefined && contract.width !== entry.preview.width) ||
    (contract.height !== undefined && contract.height !== entry.preview.height) ||
    (contract.canonicalRgbaSha256 !== undefined &&
      contract.canonicalRgbaSha256 !== entry.preview.canonicalRgbaSha256)
  ) {
    throw new Error("public archive template render contract is unsafe or stale");
  }
}

function assertPublicContentDigest(
  submission: Record<string, unknown>,
  template: Record<string, unknown>,
  assets: Record<string, unknown>[],
  entry: PublicTemplateEntryV1,
) {
  if (!isRecord(template.metadata)) throw new Error("public archive template metadata is missing");
  let observed: string;
  if (
    template.metadata.contentDigestAlgorithm ===
    "sha256(canonical JSON list of code, data, preview, and documentation identities)"
  ) {
    const rows = assets
      .filter((asset) => asset.path !== "payload/template.json")
      .map((asset) => ({
        path: asset.path,
        bytes: asset.bytes,
        sha256: asset.sha256,
      }))
      .sort((left, right) =>
        compareCanonicalStrings(String(left.path), String(right.path)),
      );
    observed = sha256(JSON.stringify(rows));
  } else {
    const {
      upstreamStatus: _upstreamStatus,
      publisherVerified: _publisherVerified,
      curationStatus: _curationStatus,
      renderValidation: _renderValidation,
      localReviewStatus: _localReviewStatus,
      plotExecutionByRecipient: _plotExecutionByRecipient,
      ...publicMetadata
    } = template.metadata;
    observed = sha256(
      canonicalJson({
        schema: "figure-library.public-template-content-digest.v1",
        providerId: entry.providerId,
        templateId: entry.templateId,
        releaseVersion: entry.releaseVersion,
        metadata: publicMetadata,
        licenses: {
          code: entry.licenses.code,
          content: entry.licenses.content,
          documentation: entry.licenses.documentation,
        },
        assets: assets.map((asset) => ({
          path: asset.path,
          bytes: asset.bytes,
          sha256: asset.sha256,
          role: asset.role,
          license: asset.license,
          source: asset.source,
        })),
        render: template.render,
      }),
    );
  }
  if (observed !== entry.contentDigest || submission.contentDigest !== observed) {
    throw new Error("public archive contentDigest does not match its declared public content");
  }
}

function validateArchiveInventory(files: Map<string, Uint8Array>) {
  const inventoryBytes = files.get("inventory.jsonl");
  if (!inventoryBytes) throw new Error("public archive is missing inventory.jsonl");
  let lines: string[];
  try {
    lines = new TextDecoder("utf-8", { fatal: true })
      .decode(inventoryBytes)
      .split("\n")
      .filter((line) => line.trim());
  } catch {
    throw new Error("public archive inventory.jsonl is not valid UTF-8");
  }
  const declared: ArchiveInventoryEntry[] = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`public archive inventory line ${index + 1} is invalid JSON`);
    }
    if (!isRecord(value)) throw new Error(`public archive inventory line ${index + 1} is invalid`);
    assertKeys(value, ["path", "bytes", "sha256"], [], `inventory[${index}]`);
    return {
      path: assertPortableArchivePath(value.path, `inventory[${index}].path`),
      bytes: nonNegativeInteger(value.bytes, `inventory[${index}].bytes`, MAX_FILE_BYTES),
      sha256: assertDigest(value.sha256, `inventory[${index}].sha256`),
    };
  });
  const observed = [...files.entries()]
    .filter(([name]) => name !== "inventory.jsonl")
    .map(([name, bytes]) => ({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const ordered = [...declared].sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (canonicalJson(declared) !== canonicalJson(ordered)) {
    throw new Error("public archive inventory is not canonically ordered");
  }
  if (canonicalJson(declared) !== canonicalJson(observed)) {
    throw new Error("public archive inventory does not match its complete payload");
  }
}

function validatePublicArchive(
  bytes: Uint8Array,
  entry: PublicTemplateEntryV1,
): Map<string, Uint8Array> {
  const central = centralZipEntries(bytes);
  let contents: Record<string, Uint8Array>;
  try {
    contents = unzipSync(bytes);
  } catch (error) {
    throw new Error(
      `public archive decompression failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = new Map<string, Uint8Array>();
  for (const metadata of central) {
    if (metadata.directory) continue;
    const data = contents[metadata.name];
    if (
      !data ||
      data.byteLength !== metadata.expandedBytes ||
      crc32(data) !== metadata.crc32
    ) {
      throw new Error(`public archive decompressed size mismatch: ${metadata.name}`);
    }
    files.set(metadata.name, data);
  }
  const extractedNames = Object.keys(contents).filter((name) => !name.endsWith("/"));
  if (extractedNames.length !== files.size) {
    throw new Error("public archive decompressed entry set differs from its central directory");
  }
  const allowed = /^(?:submission\.json|licenses\.json|render-receipt\.json|inventory\.jsonl|payload\/template\.json|payload\/(?:code|data|preview|docs)\/.+)$/u;
  for (const name of files.keys()) {
    if (!allowed.test(name)) throw new Error(`public archive contains unsupported payload: ${name}`);
  }
  for (const required of [
    "submission.json",
    "licenses.json",
    "render-receipt.json",
    "inventory.jsonl",
    "payload/template.json",
    "payload/code/render.R",
    "payload/preview/preview.png",
  ]) {
    if (!files.has(required)) throw new Error(`public archive is missing ${required}`);
  }
  if (![...files.keys()].some((name) => name.startsWith("payload/data/"))) {
    throw new Error("public archive contains no declared synthetic data");
  }
  validateArchiveInventory(files);
  const submission = parseJsonFile(files, "submission.json");
  const template = parseJsonFile(files, "payload/template.json");
  const licenses = parseJsonFile(files, "licenses.json");
  const render = parseJsonFile(files, "render-receipt.json");
  if (!isRecord(submission)) throw new Error("public archive submission must be an object");
  assertKeys(
    submission,
    [
      "schema",
      "providerId",
      "templateId",
      "releaseVersion",
      "contentDigest",
      "parentLocalRelease",
      "assets",
      "rightsAttestation",
      "excludedPrivateState",
      "createdAt",
    ],
    ["publicMetadata"],
    "submission",
  );
  if (
    submission.schema !== "figure-library.publication-submission.v1" ||
    submission.providerId !== entry.providerId ||
    submission.templateId !== entry.templateId ||
    submission.releaseVersion !== entry.releaseVersion ||
    submission.contentDigest !== entry.contentDigest ||
    !isRecord(submission.parentLocalRelease) ||
    !isRecord(submission.rightsAttestation) ||
    !Array.isArray(submission.excludedPrivateState)
  ) {
    throw new Error("public archive submission identity differs from its Catalog entry");
  }
  assertRfc3339(submission.createdAt, "submission.createdAt");
  assertSubmissionBoundary(submission);
  if (
    !isRecord(template) ||
    template.schema !== "figure-library.public-template-archive.v1" ||
    template.providerId !== entry.providerId ||
    template.templateId !== entry.templateId ||
    template.releaseVersion !== entry.releaseVersion ||
    template.contentDigest !== entry.contentDigest ||
    template.codeExecutedBySflClient !== false
  ) {
    throw new Error("public archive template identity differs from its Catalog entry");
  }
  assertKeys(
    template,
    [
      "schema",
      "providerId",
      "templateId",
      "releaseVersion",
      "contentDigest",
      "metadata",
      "licenses",
      "render",
      "codeExecutedBySflClient",
    ],
    [],
    "template",
  );
  const templateStatus = archiveTemplateStatus(template);
  if (templateStatus.publisherVerified !== entry.status.publisherVerified) {
    throw new Error("public archive publisher verification differs from its Catalog entry");
  }
  assertTemplateBoundary(template, entry);
  if (
    !isRecord(licenses) ||
    licenses.schema !== "figure-library.publication-licenses.v1" ||
    licenses.code !== entry.licenses.code ||
    licenses.syntheticData !== entry.licenses.content ||
    licenses.preview !== entry.licenses.content ||
    licenses.documentation !== entry.licenses.documentation
  ) {
    throw new Error("public archive licenses differ from its Catalog entry");
  }
  const preview = files.get("payload/preview/preview.png")!;
  if (preview.byteLength !== entry.preview.bytes || sha256(preview) !== entry.preview.sha256) {
    throw new Error("public archive preview differs from its Catalog preview identity");
  }
  if (!isRecord(render)) throw new Error("public archive render receipt must be an object");
  const renderTrace = normalizeRenderTrace(render, files, entry);
  const publicAssets = submission.assets;
  if (!Array.isArray(publicAssets) || !publicAssets.length || publicAssets.length > MAX_FILES) {
    throw new Error("public archive submission asset declarations are missing or invalid");
  }
  const declared = new Set<string>();
  const normalizedAssets: Record<string, unknown>[] = [];
  for (const [index, asset] of publicAssets.entries()) {
    if (!isRecord(asset)) throw new Error(`public archive asset declaration ${index} is invalid`);
    const assetPath = assertPortableArchivePath(asset.path, `submission.assets[${index}].path`);
    if (declared.has(assetPath)) throw new Error(`duplicate public archive asset: ${assetPath}`);
    declared.add(assetPath);
    const role = String(asset.role);
    const rolePrefix = {
      code: "payload/code/",
      render_code: "payload/code/",
      synthetic_data: "payload/data/",
      generated_preview: "payload/preview/",
      documentation: "payload/docs/",
      metadata: "payload/template.json",
    }[role];
    if (
      !rolePrefix ||
      (role === "metadata" ? assetPath !== rolePrefix : !assetPath.startsWith(rolePrefix))
    ) {
      throw new Error(`public archive asset role/path mismatch: ${assetPath}`);
    }
    if (
      asset.include !== true ||
      !["clean_room", "generated", "synthetic", "authored"].includes(String(asset.source))
    ) {
      throw new Error(`public archive asset lacks explicit public inclusion: ${assetPath}`);
    }
    const expectedLicense =
      role === "code" || role === "render_code"
        ? entry.licenses.code
        : role === "documentation"
          ? entry.licenses.documentation
          : entry.licenses.content;
    if (asset.license !== expectedLicense) {
      throw new Error(`public archive asset license differs from its Catalog: ${assetPath}`);
    }
    const payload = files.get(assetPath);
    if (
      !payload ||
      asset.bytes !== payload.byteLength ||
      assertDigest(asset.sha256, `submission.assets[${index}].sha256`) !== sha256(payload)
    ) {
      throw new Error(`public archive asset identity mismatch: ${assetPath}`);
    }
    normalizedAssets.push(asset);
  }
  const payloadAssets = [...files.keys()].filter((name) =>
    /^payload\/(?:code|data|preview|docs)\//u.test(name),
  );
  const declaredTemplate = declared.has("payload/template.json") ? 1 : 0;
  if (
    payloadAssets.some((name) => !declared.has(name)) ||
    declared.size !== payloadAssets.length + declaredTemplate
  ) {
    throw new Error("public archive asset declarations do not cover the complete public payload");
  }
  if (
    !declared.has(renderTrace.entrypoint) ||
    renderTrace.codePaths.some((name) => !declared.has(name)) ||
    renderTrace.inputPaths.some((name) => !declared.has(name)) ||
    !declared.has(renderTrace.previewPath)
  ) {
    throw new Error("public archive render trace does not bind declared code/data/preview assets");
  }
  const generatedPreview = publicAssets.find(
    (asset) => isRecord(asset) && asset.path === "payload/preview/preview.png",
  );
  if (
    !generatedPreview ||
    (generatedPreview.generatedFrom !== undefined &&
      (!Array.isArray(generatedPreview.generatedFrom) ||
        !generatedPreview.generatedFrom.some(
          (name: unknown) =>
            typeof name === "string" && renderTrace.codePaths.includes(name),
        ) ||
        !generatedPreview.generatedFrom.some(
          (name: unknown) =>
            typeof name === "string" && renderTrace.inputPaths.includes(name),
        )))
  ) {
    throw new Error("public archive generated preview lacks code/data provenance");
  }
  assertPublicContentDigest(submission, template, normalizedAssets, entry);
  for (const [name, payload] of files) {
    assertSafePublicPayload(name, payload);
  }
  return files;
}

function publicResolved(
  resolved: ResolvedProviderTemplate,
  providerId: string,
): PublicResolvedProviderTemplate {
  const value = resolved as unknown as PublicResolvedProviderTemplate;
  if (
    value.providerId !== providerId ||
    value.value?.kind !== "public-catalog" ||
    value.value.entry.providerId !== providerId
  ) {
    throw new Error("resolved template is not owned by this public Provider");
  }
  return value;
}

async function regularFileInventory(root: string) {
  const result: ArchiveInventoryEntry[] = [];
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    );
    for (const item of entries) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      assertPortableArchivePath(relative, "materialized file path");
      const absolute = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error(`materialized public template contains a symlink: ${relative}`);
      if (item.isDirectory()) await walk(absolute, relative);
      else if (item.isFile()) {
        const bytes = new Uint8Array(await fs.readFile(absolute));
        result.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
      } else {
        throw new Error(`materialized public template contains a non-file: ${relative}`);
      }
    }
  };
  await walk(root);
  return result.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export class PublicCatalogProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly snapshot: PublicCatalogSnapshot;
  readonly #archiveFetcher: PublicArchiveFetcher;
  readonly #entries: Map<string, PublicTemplateEntryV1>;

  constructor(options: {
    snapshot: PublicCatalogSnapshot;
    sourceLabel?: string;
    defaultSearchOrder?: number;
    bundled?: boolean;
    enabled?: boolean;
    includeInDefaultSearch?: boolean;
    archiveFetcher?: PublicArchiveFetcher;
  }) {
    this.snapshot = options.snapshot;
    this.descriptor = {
      providerId: options.snapshot.catalog.provider.providerId,
      sourceLabel: options.sourceLabel ?? options.snapshot.catalog.provider.displayName,
      kind: "public-catalog",
      defaultSearchOrder: options.defaultSearchOrder ?? 100,
      bundled: options.bundled ?? options.snapshot.trust === "bundled",
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.includeInDefaultSearch !== undefined
        ? { includeInDefaultSearch: options.includeInDefaultSearch }
        : {}),
    };
    this.#archiveFetcher = options.archiveFetcher ?? defaultPublicArchiveFetcher;
    this.#entries = new Map(
      options.snapshot.catalog.entries.map((entry) => [
        `${entry.templateId}@${entry.releaseVersion}`,
        entry,
      ]),
    );
  }

  assertSelector(
    selector: ExactTemplateSelector,
    _purpose: "describe" | "preview" | "materialize" | "replay",
  ) {
    assertPublicTemplateSelector(selector);
    if (selector.providerId !== this.descriptor.providerId) {
      throw new Error("public selector providerId differs from this Provider");
    }
  }

  async revision(_context: ProviderContext) {
    return {
      providerId: this.descriptor.providerId,
      snapshotRevision: this.snapshot.revision,
      catalogSha256: this.snapshot.catalogSha256,
      previewManifestSha256: this.snapshot.previewManifestSha256,
    };
  }

  async search(_context: ProviderContext, request: SearchRequest) {
    const intent = buildSearchIntent(request);
    const scored = this.snapshot.catalog.entries
      .filter((entry) => {
        if (request.assetKind && request.assetKind !== "plot_template") return false;
        if (request.reviewStatus && request.reviewStatus !== "not_reviewed") return false;
        if (request.codeStatus && request.codeStatus !== "provided") return false;
        if (
          request.language &&
          normalizeSearchText(request.language) !== normalizeSearchText(entry.search.language)
        ) return false;
        if (request.plotFamily) {
          const desired = buildSearchIntent({ query: request.plotFamily }).families;
          const actual = buildSearchIntent({ query: entry.search.plotFamily }).families;
          if (
            desired.length
              ? !desired.some((family) => actual.includes(family))
              : !normalizeSearchText(entry.search.plotFamily).includes(
                  normalizeSearchText(request.plotFamily),
                )
          ) return false;
        }
        return true;
      })
      .map((entry) => ({
        entry,
        evidence: scoreSearchableTemplate(
          {
            templateId: entry.templateId,
            title: entry.title,
            description: entry.description,
            application: entry.search.application,
            dataProfile: entry.search.dataProfile,
            inputFiles: entry.search.inputFiles,
            codeFiles: entry.search.codeFiles,
            packages: entry.search.packages,
            tags: entry.search.tags,
          },
          intent,
        ),
      }))
      .filter(({ evidence }) => evidence.score > 0)
      .sort(
        (left, right) =>
          right.evidence.score - left.evidence.score ||
          left.entry.templateId.localeCompare(right.entry.templateId, "en") ||
          left.entry.releaseVersion.localeCompare(right.entry.releaseVersion, "en"),
      );
    return scored.map(({ entry, evidence }): TemplateCandidate => {
      const selector = publicTemplateSelector(entry, this.snapshot.catalogSha256);
      return {
        templateId: entry.templateId,
        providerId: this.descriptor.providerId,
        exactSelector: selector,
        sourceLabel: this.descriptor.sourceLabel,
        title: entry.title,
        retrievalScore: evidence.score,
        matchedTerms: evidence.matchedTerms.slice(0, 12),
        reasons: evidence.reasons,
        warnings: [
          `publisherVerified=${entry.status.publisherVerified}`,
          `curationStatus=${entry.status.curationStatus}`,
          `renderValidation=${entry.status.renderValidation}`,
          "localReviewStatus=not_reviewed",
          "plotExecutionByRecipient=not_run",
        ],
        excerpt: entry.description.slice(0, 420),
        description: entry.description,
        application: entry.search.application,
        dataProfile: entry.search.dataProfile,
        inputFiles: [...entry.search.inputFiles],
        codeFiles: [...entry.search.codeFiles],
        packages: [...entry.search.packages],
        materializable: true,
        previewAvailable: true,
        previewRef: {
          schema: "figure-library.provider-preview-ref.v1",
          providerId: this.descriptor.providerId,
          exactSelector: selector,
        },
        assetKind: "plot_template",
        language: entry.search.language,
        plotFamily: entry.search.plotFamily,
        reviewStatus: "not_reviewed",
        codeStatus: "provided",
        executionStatus: "not_run",
        validationState: legacyValidationStateFromExecutionStatus("not_run"),
        upstreamStatus: "published",
        license: `${entry.licenses.code}; ${entry.licenses.content}; ${entry.licenses.documentation}`,
        sourceUrl: rawArchiveUrl(entry.archive),
        management: {
          templateId: entry.templateId,
          canArchive: false,
          canUpdate: false,
        },
      };
    });
  }

  async resolve(
    _context: ProviderContext,
    selector: ExactTemplateSelector,
    purpose: "describe" | "preview" | "materialize" | "replay",
  ): Promise<ResolvedProviderTemplate> {
    this.assertSelector(selector, purpose);
    assertPublicTemplateSelector(selector);
    const entry = this.#entries.get(
      `${selector.identity.templateId}@${selector.identity.releaseVersion}`,
    );
    if (!entry) throw new Error("stale or unknown public template selector");
    const expected = publicTemplateSelector(entry, this.snapshot.catalogSha256);
    if (canonicalJson(expected) !== canonicalJson(selector)) {
      throw new Error("stale public template selector differs from the active Catalog snapshot");
    }
    const resolved: PublicResolvedProviderTemplate = {
      providerId: this.descriptor.providerId,
      exactSelector: expected,
      templateId: entry.templateId,
      value: { kind: "public-catalog", entry, catalogSha256: this.snapshot.catalogSha256 },
    };
    // ProviderRegistry's compatibility union is extended by the integration
    // commit. Keeping the implementation isolated avoids coupling this module
    // to that cross-cutting edit while preserving the exact runtime shape.
    return resolved as unknown as ResolvedProviderTemplate;
  }

  async describe(
    _context: ProviderContext,
    resolved: ResolvedProviderTemplate,
  ): Promise<ProviderDescription> {
    const value = publicResolved(resolved, this.descriptor.providerId);
    const { entry } = value.value;
    return {
      code: "public_template_described" as ProviderDescription["code"],
      summary: `Loaded exact ${entry.providerId} public release ${entry.templateId}@${entry.releaseVersion}.`,
      detail: {
        entry,
        exactSelector: value.exactSelector,
        catalogSha256: this.snapshot.catalogSha256,
        snapshotRevision: this.snapshot.revision,
        upstreamStatus: "published",
        publisherVerified: entry.status.publisherVerified,
        curationStatus: entry.status.curationStatus,
        renderValidation: entry.status.renderValidation,
        localReviewStatus: "not_reviewed",
        plotExecutionByRecipient: "not_run",
        codeExecutedBySflClient: false,
      },
      lines: [
        `TITLE: ${entry.title}`,
        `RELEASE_VERSION: ${entry.releaseVersion}`,
        "UPSTREAM_STATUS: published",
        `PUBLISHER_VERIFIED: ${entry.status.publisherVerified}`,
        `CURATION_STATUS: ${entry.status.curationStatus}`,
        `RENDER_VALIDATION: ${entry.status.renderValidation}`,
        "LOCAL_REVIEW_STATUS: not_reviewed",
        "PLOT_EXECUTION_BY_RECIPIENT: not_run",
        "CODE_EXECUTED_BY_SFL_CLIENT: false",
      ],
    };
  }

  async loadPreview(
    _context: ProviderContext,
    resolved: ResolvedProviderTemplate,
  ): Promise<LoadedProviderPreview> {
    const value = publicResolved(resolved, this.descriptor.providerId);
    const current = await this.resolve(_context, value.exactSelector, "preview");
    const entry = publicResolved(current, this.descriptor.providerId).value.entry;
    const bytes = this.snapshot.previews.get(entry.preview.path);
    if (!bytes) throw new Error("preview_unavailable: verified snapshot preview is missing");
    return {
      providerId: this.descriptor.providerId,
      exactSelector: value.exactSelector,
      exactSelectorDigest: exactSelectorDigest(value.exactSelector),
      templateId: entry.templateId,
      bytes: new Uint8Array(bytes),
      byteLength: bytes.byteLength,
      mimeType: "image/png",
      extension: ".png",
      sha256: entry.preview.sha256,
    };
  }

  async stageMaterialization(
    context: ProviderContext,
    resolved: ResolvedProviderTemplate,
    destination: string,
    allowNetwork: boolean,
  ): Promise<VerifiedProviderPayload> {
    const operation = context.materialization;
    if (!operation) throw new Error("materialization operation binding is required");
    const value = publicResolved(resolved, this.descriptor.providerId);
    const refreshed = publicResolved(
      await this.resolve(context, value.exactSelector, "materialize"),
      this.descriptor.providerId,
    );
    const { entry } = refreshed.value;
    if (!allowNetwork) {
      throw new Error("public archive materialization requires explicit allowNetwork=true");
    }
    const url = rawArchiveUrl(entry.archive);
    const archive = new Uint8Array(
      await this.#archiveFetcher({
        url,
        expectedBytes: entry.archive.bytes,
        maxBytes: MAX_ARCHIVE_BYTES,
        timeoutMs: 60_000,
      }),
    );
    if (
      archive.byteLength !== entry.archive.bytes ||
      sha256(archive) !== entry.archive.sha256
    ) {
      throw new Error("public archive byte length or SHA-256 differs from its exact selector");
    }
    const sourceFiles = validatePublicArchive(archive, entry);
    const parent = path.resolve(destination);
    const target = path.join(parent, entry.templateId);
    await fs.mkdir(parent, { recursive: true });
    try {
      await fs.lstat(target);
      throw new Error(`target already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const staging = path.join(parent, `.figure-library-public-${entry.templateId}-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: false });
    try {
      const output = new Map<string, Uint8Array>();
      for (const [source, bytes] of sourceFiles) {
        let relative: string | undefined;
        if (source === "payload/template.json") relative = "template.json";
        else if (source === "licenses.json" || source === "render-receipt.json") relative = source;
        else {
          const matched = source.match(/^payload\/(code|data|preview|docs)\/(.+)$/u);
          if (matched) relative = `${matched[1]}/${matched[2]}`;
        }
        if (!relative) continue;
        assertPortableArchivePath(relative, "materialized public path");
        output.set(relative, bytes);
      }
      for (const [relative, bytes] of [...output].sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      )) {
        const file = path.join(staging, ...relative.split("/"));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes, { flag: "wx" });
      }
      const payloadInventory = [...output]
        .map(([file, bytes]) => ({ file, bytes: bytes.byteLength, sha256: sha256(bytes) }))
        .sort((left, right) => left.file.localeCompare(right.file, "en"));
      const lock = {
        schema: PUBLIC_TEMPLATE_LOCK_SCHEMA,
        providerId: this.descriptor.providerId,
        exactSelector: refreshed.exactSelector,
        plannedSelector: value.exactSelector,
        selectorDigest: exactSelectorDigest(refreshed.exactSelector),
        catalogIdentity: {
          snapshotRevision: this.snapshot.revision,
          catalogSha256: this.snapshot.catalogSha256,
          previewManifestSha256: this.snapshot.previewManifestSha256,
          trust: this.snapshot.trust,
          sourceReference: this.snapshot.sourceReference,
        },
        archive: { ...entry.archive },
        preview: { ...entry.preview },
        licenses: { ...entry.licenses },
        status: {
          upstreamStatus: "published",
          publisherVerified: entry.status.publisherVerified,
          curationStatus: entry.status.curationStatus,
          renderValidation: entry.status.renderValidation,
          localReviewStatus: "not_reviewed",
          plotExecutionByRecipient: "not_run",
        },
        codeExecutedBySflClient: false,
        inventoryPolicy: "all-output-files-except-this-lock",
        operation: {
          operationId: operation.operationId,
          planDigest: operation.planDigest,
        },
        files: payloadInventory,
      };
      await fs.writeFile(
        path.join(staging, "template.lock.json"),
        `${JSON.stringify(lock, null, 2)}\n`,
        { flag: "wx" },
      );
      await fs.rename(staging, target);
      return {
        providerId: this.descriptor.providerId,
        exactSelector: refreshed.exactSelector,
        target,
        files: [...payloadInventory.map((item) => item.file), "template.lock.json"].sort(),
        materializationSource: "network",
        archiveSha256: entry.archive.sha256,
      };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async verifyMaterialized(
    context: ProviderContext,
    binding: ProviderMaterializedBinding,
  ) {
    this.assertSelector(binding.plannedSelector, "replay");
    this.assertSelector(binding.exactSelector, "replay");
    if (canonicalJson(binding.plannedSelector) !== canonicalJson(binding.exactSelector)) {
      throw new Error("stale public selector changed during materialization");
    }
    const resolved = publicResolved(
      await this.resolve(context, binding.plannedSelector, "replay"),
      this.descriptor.providerId,
    );
    if (path.basename(path.resolve(binding.target)) !== resolved.templateId) {
      throw new Error("stale public materialization target name");
    }
    const lockFile = path.join(binding.target, "template.lock.json");
    const lock = JSON.parse(await fs.readFile(lockFile, "utf8")) as unknown;
    if (
      !isRecord(lock) ||
      lock.schema !== PUBLIC_TEMPLATE_LOCK_SCHEMA ||
      lock.providerId !== this.descriptor.providerId ||
      lock.codeExecutedBySflClient !== false ||
      lock.selectorDigest !== exactSelectorDigest(resolved.exactSelector) ||
      lock.inventoryPolicy !== "all-output-files-except-this-lock" ||
      !isRecord(lock.operation) ||
      lock.operation.operationId !== binding.operationId ||
      lock.operation.planDigest !== binding.planDigest
    ) {
      throw new Error("target exists but has no compatible public template-lock.v3");
    }
    assertPublicTemplateSelector(lock.plannedSelector);
    assertPublicTemplateSelector(lock.exactSelector);
    if (
      canonicalJson(lock.plannedSelector) !== canonicalJson(binding.plannedSelector) ||
      canonicalJson(lock.exactSelector) !== canonicalJson(binding.exactSelector)
    ) {
      throw new Error("public materialization lock has a different exact selector");
    }
    const expectedIdentity = {
      catalogIdentity: {
        snapshotRevision: this.snapshot.revision,
        catalogSha256: this.snapshot.catalogSha256,
        previewManifestSha256: this.snapshot.previewManifestSha256,
        trust: this.snapshot.trust,
        sourceReference: this.snapshot.sourceReference,
      },
      archive: resolved.value.entry.archive,
      preview: resolved.value.entry.preview,
      licenses: resolved.value.entry.licenses,
      status: {
        upstreamStatus: "published",
        publisherVerified: resolved.value.entry.status.publisherVerified,
        curationStatus: resolved.value.entry.status.curationStatus,
        renderValidation: resolved.value.entry.status.renderValidation,
        localReviewStatus: "not_reviewed",
        plotExecutionByRecipient: "not_run",
      },
    };
    for (const [key, expected] of Object.entries(expectedIdentity)) {
      if (canonicalJson(lock[key]) !== canonicalJson(expected)) {
        throw new Error(`public materialization lock has stale or tampered ${key}`);
      }
    }
    const observed = await regularFileInventory(binding.target);
    const withoutLock = observed
      .filter((item) => item.path !== "template.lock.json")
      .map(({ path: file, ...item }) => ({ file, ...item }));
    if (!Array.isArray(lock.files) || canonicalJson(lock.files) !== canonicalJson(withoutLock)) {
      throw new Error("public materialization lock inventory no longer matches target files");
    }
    const receiptInventory = observed.map(({ path: file, ...item }) => ({ file, ...item }));
    if (canonicalJson(receiptInventory) !== canonicalJson(binding.inventory)) {
      throw new Error("public materialization receipt inventory no longer matches target files");
    }
  }

  async status(_context: ProviderContext): Promise<ProviderStatus> {
    return {
      providerId: this.descriptor.providerId,
      sourceLabel: this.descriptor.sourceLabel,
      health: "ready",
      details: {
        providerId: this.descriptor.providerId,
        templateCount: this.snapshot.catalog.entries.length,
        catalogSha256: this.snapshot.catalogSha256,
        previewManifestSha256: this.snapshot.previewManifestSha256,
        snapshotRevision: this.snapshot.revision,
        trust: this.snapshot.trust,
        startupNetworkAccess: false,
        searchNetworkAccess: false,
        archiveNetworkRequiredForMaterialization: true,
      },
    };
  }
}
