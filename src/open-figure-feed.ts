import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import { assertMcpImageBytes } from "./image-validation.ts";
import {
  MODULE_CATALOG_SCHEMA,
  MODULE_PREVIEW_MANIFEST_SCHEMA,
  MODULE_SOURCE_PACK_SCHEMA,
  parseModuleCatalog,
  type ModuleCatalogIndex,
} from "./module-catalog.ts";
import {
  OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
  OFFICIAL_OPEN_FIGURE_RAW_HOST,
  OFFICIAL_OPEN_FIGURE_REPOSITORY,
  PERSONAL_MODULE_SNAPSHOT_LICENSE,
  officialOpenFigurePayloadUrl,
  parseOfficialOpenFigurePayloadUrl,
} from "./open-figure-official-channel.ts";
import {
  extractExactZipFiles,
  parseProviderSourceManifestBytes,
  parseProviderSourceSignatureBytes,
  verifyEd25519Detached,
  deriveProviderSourceSignatureUrl,
  ed25519PublicKeyIdentity,
  type Ed25519PublicKeyIdentity,
  type ExactZipFile,
  type ProviderSourceManifestV1,
  type ProviderSourceSignatureV1,
  type SecureProviderSourceFetcher,
} from "./provider-source-fetch.ts";
import type { ModuleCatalog, ModuleCatalogEntry } from "./types.ts";

const MODULE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(bytes: Uint8Array, label: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function officialMediaTypes(url: string, kind: "json" | "zip") {
  const host = new URL(url).hostname.toLowerCase();
  if (kind === "json") {
    return host === OFFICIAL_OPEN_FIGURE_RAW_HOST
      ? ["application/json", "text/plain"]
      : ["application/json"];
  }
  return host === OFFICIAL_OPEN_FIGURE_RAW_HOST
    ? ["application/zip", "application/octet-stream", "application/x-zip-compressed", "text/plain"]
    : ["application/zip"];
}

export interface OfficialCatalogDiff {
  added: string[];
  updated: Array<{ moduleId: string; previousArchiveSha256: string; nextArchiveSha256: string }>;
  withdrawn: string[];
  tombstones: string[];
}

export interface OfficialOpenFigureUnchangedCheck {
  unchanged: true;
  manifest: ProviderSourceManifestV1;
  manifestSha256: string;
  sequence: number;
  signingKey: Ed25519PublicKeyIdentity;
}

export type OfficialOpenFigureFetchResult = OfficialOpenFigureUnchangedCheck | VerifiedOfficialOpenFigureSnapshot;

export function isUnchangedOfficialOpenFigureFetch(
  value: OfficialOpenFigureFetchResult,
): value is OfficialOpenFigureUnchangedCheck {
  return "unchanged" in value && value.unchanged === true;
}

export interface VerifiedOfficialOpenFigureSnapshot {
  manifest: ProviderSourceManifestV1;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  signature: ProviderSourceSignatureV1;
  signatureSidecarBytes: Uint8Array;
  signatureSidecarSha256: string;
  signingKey: Ed25519PublicKeyIdentity;
  catalogBytes: Uint8Array;
  catalogSha256: string;
  catalog: ModuleCatalog;
  previewsArchiveBytes: Uint8Array;
  previewsArchiveSha256: string;
  previewFiles: ExactZipFile[];
  authorizedNextKeys: Ed25519PublicKeyIdentity[];
  tombstones: string[];
  payloadCommit: string;
  snapshotFiles: Map<string, Uint8Array>;
  payloadUrls: {
    manifest: string;
    signature: string;
    catalog: string;
    previews: string;
  };
  accessUrls: string[];
}

export function assertOfficialOpenFigureManifest(
  manifest: ProviderSourceManifestV1,
): { payloadCommit: string } {
  if (manifest.providerId !== OFFICIAL_OPEN_FIGURE_PROVIDER_ID) {
    throw new Error(
      `official Open Figure manifest providerId must be ${OFFICIAL_OPEN_FIGURE_PROVIDER_ID}`,
    );
  }
  const catalogPayload = parseOfficialOpenFigurePayloadUrl(manifest.catalog.url);
  const previewPayload = parseOfficialOpenFigurePayloadUrl(manifest.previews.url);
  if (catalogPayload.file !== "module-catalog.json") {
    throw new Error("official Open Figure catalog URL must end with module-catalog.json");
  }
  if (previewPayload.file !== "module-previews.zip") {
    throw new Error("official Open Figure preview URL must end with module-previews.zip");
  }
  if (catalogPayload.payloadCommit !== previewPayload.payloadCommit) {
    throw new Error("official Open Figure catalog and preview payload commits must match");
  }
  if (catalogPayload.sequence !== manifest.sequence || previewPayload.sequence !== manifest.sequence) {
    throw new Error("official Open Figure payload URL sequence must match the signed manifest sequence");
  }
  if (
    officialOpenFigurePayloadUrl(catalogPayload.payloadCommit, manifest.sequence, "module-catalog.json") !==
      manifest.catalog.url ||
    officialOpenFigurePayloadUrl(previewPayload.payloadCommit, manifest.sequence, "module-previews.zip") !==
      manifest.previews.url
  ) {
    throw new Error("official Open Figure payload URLs are not canonical");
  }
  const tombstones = [...manifest.tombstones].sort(compareCanonicalStrings);
  if (canonicalJson(tombstones) !== canonicalJson(manifest.tombstones)) {
    throw new Error("official Open Figure tombstones must be canonically ordered");
  }
  for (const moduleId of tombstones) {
    if (!MODULE_ID.test(moduleId)) {
      throw new Error(`official Open Figure tombstone is not a valid moduleId: ${moduleId}`);
    }
  }
  return { payloadCommit: catalogPayload.payloadCommit };
}

export function officialPreviewInventory(catalog: ModuleCatalog) {
  const expected = new Map<string, { bytes: number; sha256: string; mediaType: string }>();
  for (const module of catalog.modules) {
    for (const preview of [module.preview, module.thumbnail]) {
      const prior = expected.get(preview.path);
      if (prior) throw new Error(`official Open Figure catalog preview path collision: ${preview.path}`);
      expected.set(preview.path, {
        bytes: preview.bytes,
        sha256: preview.sha256,
        mediaType: preview.mediaType,
      });
    }
  }
  return expected;
}

export function verifyOfficialPreviewFiles(catalog: ModuleCatalog, files: ExactZipFile[]) {
  const expected = officialPreviewInventory(catalog);
  if (files.length !== expected.size) {
    throw new Error("official Open Figure preview ZIP file count does not match the Catalog");
  }
  for (const file of files) {
    const declared = expected.get(file.path);
    if (!declared) throw new Error(`official Open Figure preview ZIP contains an undeclared file: ${file.path}`);
    if (file.bytes !== declared.bytes || file.sha256 !== declared.sha256) {
      throw new Error(`official Open Figure preview identity mismatch: ${file.path}`);
    }
    assertMcpImageBytes({
      bytes: file.data,
      mimeType: declared.mediaType,
      extension: path.posix.extname(file.path),
    });
  }
}

export function assembleOfficialCatalogSnapshotFiles(options: {
  catalogBytes: Uint8Array;
  catalog: ModuleCatalog;
  previewFiles: ExactZipFile[];
}): Map<string, Uint8Array> {
  const previewManifest = {
    schema: MODULE_PREVIEW_MANIFEST_SCHEMA,
    providerId: options.catalog.provider.providerId,
    entries: options.catalog.modules.flatMap((module) => [
      { moduleId: module.moduleId, role: "primary" as const, ...module.preview },
      { moduleId: module.moduleId, role: "thumbnail" as const, ...module.thumbnail },
    ]),
  };
  const sourcePackManifest = {
    schema: MODULE_SOURCE_PACK_SCHEMA,
    providerId: options.catalog.provider.providerId,
    repository: options.catalog.provider.repository,
    entries: options.catalog.modules.map((module) => ({
      moduleId: module.moduleId,
      sourceRepository: module.source.repository,
      sourceCommit: module.source.commit,
      archiveRepository: module.archive.repository,
      archiveCommit: module.archive.commit,
      file: module.archive.path,
      bytes: module.archive.bytes,
      sha256: module.archive.sha256,
    })),
  };
  const files = new Map<string, Uint8Array>([
    ["module-catalog.json", new Uint8Array(options.catalogBytes)],
    ["module-preview.manifest.json", Buffer.from(`${canonicalJson(previewManifest)}\n`, "utf8")],
    ["module-source-pack.manifest.json", Buffer.from(`${canonicalJson(sourcePackManifest)}\n`, "utf8")],
    ["PERSONAL_MODULES_LICENSE.txt", Buffer.from(PERSONAL_MODULE_SNAPSHOT_LICENSE, "utf8")],
  ]);
  for (const file of options.previewFiles) {
    files.set(file.path, file.data);
  }
  return files;
}

export function diffOfficialCatalogs(options: {
  previous?: ModuleCatalog;
  next: ModuleCatalog;
  previousTombstones?: string[];
  nextTombstones: string[];
}): OfficialCatalogDiff {
  const previousIds = new Set((options.previous?.modules ?? []).map((module) => module.moduleId));
  const nextIds = new Set(options.next.modules.map((module) => module.moduleId));
  const previousById = new Map((options.previous?.modules ?? []).map((module) => [module.moduleId, module]));
  const previousTombstones = [...(options.previousTombstones ?? [])].sort(compareCanonicalStrings);
  const nextTombstones = [...options.nextTombstones].sort(compareCanonicalStrings);
  for (const moduleId of previousTombstones) {
    if (!nextTombstones.includes(moduleId)) {
      throw new Error(`official Open Figure tombstone disappeared: ${moduleId}`);
    }
  }
  for (const module of options.next.modules) {
    if (nextTombstones.includes(module.moduleId)) {
      throw new Error(`official Open Figure catalog contains a tombstoned moduleId: ${module.moduleId}`);
    }
  }
  const added = [...nextIds].filter((moduleId) => !previousIds.has(moduleId)).sort(compareCanonicalStrings);
  const withdrawn = [...previousIds].filter((moduleId) => !nextIds.has(moduleId)).sort(compareCanonicalStrings);
  for (const moduleId of withdrawn) {
    if (!nextTombstones.includes(moduleId)) {
      throw new Error(`official Open Figure withdrew ${moduleId} without a cumulative tombstone`);
    }
  }
  for (const moduleId of added) {
    if (previousTombstones.includes(moduleId) || nextTombstones.includes(moduleId)) {
      throw new Error(`official Open Figure tombstoned moduleId cannot return: ${moduleId}`);
    }
  }
  const updated: OfficialCatalogDiff["updated"] = [];
  for (const module of options.next.modules) {
    const previous = previousById.get(module.moduleId);
    if (!previous) continue;
    if (canonicalJson(previous) !== canonicalJson(module)) {
      updated.push({
        moduleId: module.moduleId,
        previousArchiveSha256: previous.archive.sha256,
        nextArchiveSha256: module.archive.sha256,
      });
    }
  }
  updated.sort((left, right) => compareCanonicalStrings(left.moduleId, right.moduleId));
  return {
    added,
    updated,
    withdrawn,
    tombstones: nextTombstones,
  };
}

export function assertOfficialSequenceTransition(options: {
  previousSequence?: number;
  previousManifestSha256?: string;
  observed: Array<{ sequence: number; manifestSha256: string }>;
  nextSequence: number;
  nextManifestSha256: string;
}) {
  if (options.previousSequence !== undefined && options.nextSequence < options.previousSequence) {
    throw new Error(
      `official Open Figure rollback rejected: ${options.nextSequence} < ${options.previousSequence}`,
    );
  }
  const same = options.observed.find((item) => item.sequence === options.nextSequence);
  if (same && same.manifestSha256 !== options.nextManifestSha256) {
    throw new Error(`official Open Figure equivocation at sequence ${options.nextSequence}`);
  }
  if (
    options.previousSequence !== undefined &&
    options.nextSequence === options.previousSequence &&
    options.previousManifestSha256 &&
    options.previousManifestSha256 !== options.nextManifestSha256
  ) {
    throw new Error(`official Open Figure equivocation at sequence ${options.nextSequence}`);
  }
}

export function assertOfficialKeyTransition(options: {
  previousSigningKey?: Ed25519PublicKeyIdentity;
  authorizedNextKeys?: Ed25519PublicKeyIdentity[];
  nextSigningKey: Ed25519PublicKeyIdentity;
}) {
  if (!options.previousSigningKey) return;
  if (options.nextSigningKey.keyId === options.previousSigningKey.keyId) {
    if (options.nextSigningKey.publicKeyBase64 !== options.previousSigningKey.publicKeyBase64) {
      throw new Error("official Open Figure signing key identity mismatch");
    }
    return;
  }
  const authorized = (options.authorizedNextKeys ?? []).find(
    (key) =>
      key.keyId === options.nextSigningKey.keyId &&
      key.publicKeyBase64 === options.nextSigningKey.publicKeyBase64,
  );
  if (!authorized) {
    throw new Error(
      `official Open Figure signing key ${options.nextSigningKey.keyId} was not authorized by the previous verified manifest`,
    );
  }
}

export async function fetchVerifiedOfficialOpenFigureSnapshot(options: {
  fetcher: SecureProviderSourceFetcher;
  manifestUrl: string;
  trustedKeys: Ed25519PublicKeyIdentity[];
  skipUnchangedPayload?: boolean;
  previous?: {
    catalog?: ModuleCatalog;
    tombstones?: string[];
    sequence?: number;
    manifestSha256?: string;
    signingKey?: Ed25519PublicKeyIdentity;
    authorizedNextKeys?: Ed25519PublicKeyIdentity[];
    observed?: Array<{ sequence: number; manifestSha256: string }>;
  };
}): Promise<OfficialOpenFigureFetchResult> {
  if (!options.trustedKeys.length) throw new Error("at least one independently trusted public key is required");
  const trustedKeys = new Map<string, Ed25519PublicKeyIdentity>();
  for (const key of options.trustedKeys) {
    const checked = ed25519PublicKeyIdentity(key.publicKeyBase64);
    if (checked.keyId !== key.keyId) throw new Error("trusted Ed25519 key identity is invalid");
    if (trustedKeys.has(checked.keyId)) throw new Error("trusted Ed25519 key list contains a duplicate");
    trustedKeys.set(checked.keyId, checked);
  }
  const signatureUrl = deriveProviderSourceSignatureUrl(options.manifestUrl);
  const manifestResponse = await options.fetcher.fetch(options.manifestUrl, {
    maxBytes: MAX_MANIFEST_BYTES,
    mediaTypes: officialMediaTypes(options.manifestUrl, "json"),
  });
  const signatureResponse = await options.fetcher.fetch(signatureUrl, {
    maxBytes: MAX_SIGNATURE_BYTES,
    mediaTypes: officialMediaTypes(signatureUrl, "json"),
  });
  const parsedSignature = parseProviderSourceSignatureBytes(signatureResponse.bytes);
  const manifestSha256 = sha256(manifestResponse.bytes);
  if (parsedSignature.value.manifestSha256 !== manifestSha256) {
    throw new Error("official Open Figure signature manifestSha256 does not match raw manifest bytes");
  }
  const signingKey = trustedKeys.get(parsedSignature.value.keyId);
  if (!signingKey) {
    throw new Error(
      `official Open Figure signature key is not independently trusted or previously authorized: ${parsedSignature.value.keyId}`,
    );
  }
  verifyEd25519Detached(manifestResponse.bytes, parsedSignature.signature, signingKey);
  const manifest = parseProviderSourceManifestBytes(manifestResponse.bytes);
  const { payloadCommit } = assertOfficialOpenFigureManifest(manifest);
  assertOfficialSequenceTransition({
    previousSequence: options.previous?.sequence,
    previousManifestSha256: options.previous?.manifestSha256,
    observed: options.previous?.observed ?? [],
    nextSequence: manifest.sequence,
    nextManifestSha256: manifestSha256,
  });
  assertOfficialKeyTransition({
    previousSigningKey: options.previous?.signingKey,
    authorizedNextKeys: options.previous?.authorizedNextKeys,
    nextSigningKey: signingKey,
  });
  if (
    options.skipUnchangedPayload &&
    options.previous?.sequence === manifest.sequence &&
    options.previous?.manifestSha256 === manifestSha256
  ) {
    return {
      unchanged: true,
      manifest,
      manifestSha256,
      sequence: manifest.sequence,
      signingKey,
    };
  }
  const catalogResponse = await options.fetcher.fetch(manifest.catalog.url, {
    maxBytes: manifest.catalog.bytes,
    mediaTypes: officialMediaTypes(manifest.catalog.url, "json"),
  });
  if (
    catalogResponse.bytes.byteLength !== manifest.catalog.bytes ||
    sha256(catalogResponse.bytes) !== manifest.catalog.sha256
  ) {
    throw new Error("official Open Figure catalog identity does not match the signed manifest");
  }
  const catalog = parseModuleCatalog(JSON.parse(decodeUtf8(catalogResponse.bytes, "module-catalog.json")), {
    expectedProviderId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
    expectedRepository: OFFICIAL_OPEN_FIGURE_REPOSITORY,
  });
  if (catalog.schema !== MODULE_CATALOG_SCHEMA) {
    throw new Error("official Open Figure catalog schema must be figure-library.module-catalog.v1");
  }
  const previewsResponse = await options.fetcher.fetch(manifest.previews.url, {
    maxBytes: manifest.previews.bytes,
    mediaTypes: officialMediaTypes(manifest.previews.url, "zip"),
  });
  if (
    previewsResponse.bytes.byteLength !== manifest.previews.bytes ||
    sha256(previewsResponse.bytes) !== manifest.previews.sha256
  ) {
    throw new Error("official Open Figure preview archive identity does not match the signed manifest");
  }
  const expected = new Map(
    [...officialPreviewInventory(catalog)].map(([previewPath, identity]) => [
      previewPath,
      { bytes: identity.bytes, sha256: identity.sha256 },
    ]),
  );
  const previewFiles = extractExactZipFiles(previewsResponse.bytes, expected);
  verifyOfficialPreviewFiles(catalog, previewFiles);
  diffOfficialCatalogs({
    previous: options.previous?.catalog,
    next: catalog,
    previousTombstones: options.previous?.tombstones,
    nextTombstones: manifest.tombstones,
  });
  const authorizedNextKeys = manifest.authorizedNextKeys.map((value) =>
    ed25519PublicKeyIdentity(value.publicKeyBase64),
  );
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
    previewsArchiveBytes: previewsResponse.bytes,
    previewsArchiveSha256: sha256(previewsResponse.bytes),
    previewFiles,
    authorizedNextKeys,
    tombstones: [...manifest.tombstones],
    payloadCommit,
    snapshotFiles: assembleOfficialCatalogSnapshotFiles({
      catalogBytes: catalogResponse.bytes,
      catalog,
      previewFiles,
    }),
    payloadUrls: {
      manifest: options.manifestUrl,
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

export function officialModuleIdentity(module: ModuleCatalogEntry) {
  return {
    moduleId: module.moduleId,
    sourceCommit: module.source.commit,
    archiveCommit: module.archive.commit,
    archiveSha256: module.archive.sha256,
    previewSha256: module.preview.sha256,
  };
}

export type { ModuleCatalogIndex };
