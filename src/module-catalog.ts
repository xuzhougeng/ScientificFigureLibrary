import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import { assertMcpImageBytes } from "./image-validation.ts";
import { buildSearchIntent, normalizeSearchText, scoreSearchableTemplate } from "./catalog.ts";
import {
  assertProviderId,
  moduleArchiveExactSelector,
  PERSONAL_MODULE_PROVIDER_ID,
} from "./providers.ts";
import type {
  ModuleCatalog,
  ModuleCatalogEntry,
  ModuleCatalogFile,
  ModuleCatalogPreview,
  ModulePreviewManifest,
  ModuleSourcePackManifest,
} from "./types.ts";

export const MODULE_CATALOG_SCHEMA = "figure-library.module-catalog.v1" as const;
export const MODULE_PREVIEW_MANIFEST_SCHEMA =
  "figure-library.module-preview-manifest.v1" as const;
export const MODULE_SOURCE_PACK_SCHEMA = "figure-library.module-source-pack.v1" as const;
export const PERSONAL_MODULE_SOURCE_LABEL = "Open Figure Modules" as const;
export const PERSONAL_MODULE_REPOSITORY =
  "jarxunlai/ScientificFigureLibrary-personal" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MODULE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const SUPPORTED_MEDIA = new Set(["image/png", "image/jpeg", "image/webp"]);
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:OPENSSH |EC |RSA )?PRIVATE KEY-----/u;
const TOKEN_PATTERN = /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;
const ABSOLUTE_MACHINE_PATH_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|\/(?:home|Users|mnt|tmp)\/)/u;
const NON_PUBLIC_LICENSE_PATTERN = /(?:^|[^A-Za-z0-9])(?:unknown|private_reference|unlicensed)(?:$|[^A-Za-z0-9])/iu;

export const DEFAULT_PERSONAL_MODULE_ASSETS_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "assets",
  "personal-modules",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
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
    if (!allowed.has(key)) throw new Error(`${label}.${key} is unsupported`);
  }
}

function text(value: unknown, label: string, maximum = 4_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum}`);
  }
  return value;
}

function integer(value: unknown, label: string, maximum: number, allowZero = false) {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < (allowZero ? 0 : 1) ||
    Number(value) > maximum
  ) {
    throw new Error(`${label} is outside the supported integer range`);
  }
  return Number(value);
}

function digest(value: unknown, label: string) {
  const result = text(value, label, 64);
  if (!SHA256.test(result) || result !== result.toLocaleLowerCase("en-US")) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
  return result;
}

function commit(value: unknown, label: string) {
  const result = text(value, label, 40);
  if (!COMMIT.test(result) || result !== result.toLocaleLowerCase("en-US")) {
    throw new Error(`${label} must be a lowercase 40-hex commit`);
  }
  return result;
}

function repository(value: unknown, label: string) {
  const result = text(value, label, 200);
  if (!REPOSITORY.test(result)) throw new Error(`${label} must be owner/repository`);
  return result;
}

function assertPortableMetadata(value: unknown, label = "catalog metadata", depth = 0): void {
  if (depth > 8) throw new Error(`${label} is nested too deeply`);
  if (typeof value === "string") {
    if (PRIVATE_KEY_PATTERN.test(value) || TOKEN_PATTERN.test(value) || ABSOLUTE_MACHINE_PATH_PATTERN.test(value)) {
      throw new Error(`${label} contains sensitive or machine-local text`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortableMetadata(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertPortableMetadata(key, `${label}.${key}`, depth + 1);
      assertPortableMetadata(item, `${label}.${key}`, depth + 1);
    }
  }
}

function decodeUtf8(bytes: Uint8Array, label: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function publicLicense(value: unknown, label: string) {
  const result = text(value, label, 200);
  if (NON_PUBLIC_LICENSE_PATTERN.test(result)) {
    throw new Error(`${label} does not establish a public redistribution license`);
  }
  return result;
}

export function assertModulePortablePath(value: unknown, label: string) {
  const raw = text(value, label, 1_000);
  if (
    raw.normalize("NFC") !== raw ||
    raw.includes("\\") ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/u.test(raw) ||
    raw.endsWith("/")
  ) {
    throw new Error(`${label} is an unsafe or non-canonical portable path: ${raw}`);
  }
  const parts = raw.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.startsWith(".") ||
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

function stringArray(value: unknown, label: string, maximum = MAX_FILES) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be an array with at most ${maximum} entries`);
  }
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 1_000));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function pathArray(value: unknown, label: string, maximum = MAX_FILES) {
  return stringArray(value, label, maximum).map((item, index) =>
    assertModulePortablePath(item, `${label}[${index}]`),
  );
}

function parseFile(value: unknown, label: string): ModuleCatalogFile {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["path", "bytes", "sha256"], [], label);
  return {
    path: assertModulePortablePath(value.path, `${label}.path`),
    bytes: integer(value.bytes, `${label}.bytes`, MAX_FILE_BYTES, true),
    sha256: digest(value.sha256, `${label}.sha256`),
  };
}

function parsePreview(value: unknown, label: string): ModuleCatalogPreview {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["path", "bytes", "sha256", "mediaType"], [], label);
  if (typeof value.mediaType !== "string" || !SUPPORTED_MEDIA.has(value.mediaType)) {
    throw new Error(`${label}.mediaType is unsupported`);
  }
  return {
    path: assertModulePortablePath(value.path, `${label}.path`),
    bytes: integer(value.bytes, `${label}.bytes`, MAX_PREVIEW_BYTES),
    sha256: digest(value.sha256, `${label}.sha256`),
    mediaType: value.mediaType as ModuleCatalogPreview["mediaType"],
  };
}

function parseEntry(
  value: unknown,
  provider: ModuleCatalog["provider"],
  index: number,
): ModuleCatalogEntry {
  const label = `catalog.modules[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(
    value,
    [
      "moduleId",
      "title",
      "titleEn",
      "description",
      "application",
      "dataProfile",
      "plotFamily",
      "language",
      "tags",
      "packages",
      "codeFiles",
      "inputFiles",
      "canonicalCode",
      "requiredFiles",
      "files",
      "source",
      "archive",
      "preview",
      "thumbnail",
      "licenses",
      "publisher",
    ],
    ["provenance"],
    label,
  );
  assertPortableMetadata(value, label);
  const moduleId = text(value.moduleId, `${label}.moduleId`, 128);
  if (!MODULE_ID.test(moduleId)) throw new Error(`${label}.moduleId is invalid`);
  const tags = stringArray(value.tags, `${label}.tags`, 100);
  const packages = stringArray(value.packages, `${label}.packages`, 100);
  const codeFiles = pathArray(value.codeFiles, `${label}.codeFiles`, 100);
  const inputFiles = pathArray(value.inputFiles, `${label}.inputFiles`, 1_000);
  const canonicalCode = assertModulePortablePath(value.canonicalCode, `${label}.canonicalCode`);
  const requiredFiles = pathArray(value.requiredFiles, `${label}.requiredFiles`);
  const assertCanonicalStrings = (items: string[], field: string) => {
    const ordered = [...items].sort(compareCanonicalStrings);
    if (canonicalJson(items) !== canonicalJson(ordered)) {
      throw new Error(`${label}.${field} is not canonically ordered`);
    }
  };
  assertCanonicalStrings(tags, "tags");
  assertCanonicalStrings(packages, "packages");
  assertCanonicalStrings(codeFiles, "codeFiles");
  assertCanonicalStrings(inputFiles, "inputFiles");
  assertCanonicalStrings(requiredFiles, "requiredFiles");
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES) {
    throw new Error(`${label}.files must contain between 1 and ${MAX_FILES} entries`);
  }
  const files = value.files.map((file, fileIndex) =>
    parseFile(file, `${label}.files[${fileIndex}]`),
  );
  const orderedFiles = [...files].sort((left, right) =>
    compareCanonicalStrings(left.path, right.path),
  );
  if (canonicalJson(files) !== canonicalJson(orderedFiles)) {
    throw new Error(`${label}.files is not canonically ordered`);
  }
  const filePaths = new Set(files.map((file) => file.path));
  if (filePaths.size !== files.length) throw new Error(`${label}.files contains duplicate paths`);
  const foldedPaths = new Map<string, string>();
  for (const file of files) {
    const folded = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = foldedPaths.get(folded);
    if (prior !== undefined && prior !== file.path) {
      throw new Error(`${label}.files contains a case/NFC collision: ${prior} / ${file.path}`);
    }
    foldedPaths.set(folded, file.path);
  }
  for (const candidate of [canonicalCode, ...codeFiles, ...inputFiles, ...requiredFiles]) {
    if (!filePaths.has(candidate)) throw new Error(`${label} references undeclared file ${candidate}`);
  }
  if (!requiredFiles.includes(canonicalCode)) {
    throw new Error(`${label}.requiredFiles must include canonicalCode`);
  }
  if (!codeFiles.includes(canonicalCode)) {
    throw new Error(`${label}.canonicalCode must be listed in codeFiles`);
  }

  if (!isRecord(value.source)) throw new Error(`${label}.source must be an object`);
  exactKeys(value.source, ["repository", "commit", "path"], [], `${label}.source`);
  const sourceRepository = repository(value.source.repository, `${label}.source.repository`);
  if (sourceRepository !== provider.repository) {
    throw new Error(`${label}.source.repository differs from the Provider repository`);
  }
  const sourcePath = assertModulePortablePath(value.source.path, `${label}.source.path`);
  if (sourcePath !== `modules/${moduleId}`) {
    throw new Error(`${label}.source.path must be modules/${moduleId}`);
  }

  if (!isRecord(value.archive)) throw new Error(`${label}.archive must be an object`);
  exactKeys(
    value.archive,
    ["repository", "commit", "path", "bytes", "sha256"],
    [],
    `${label}.archive`,
  );
  const archiveRepository = repository(value.archive.repository, `${label}.archive.repository`);
  if (archiveRepository !== provider.repository || archiveRepository !== sourceRepository) {
    throw new Error(`${label}.archive.repository must equal the single Provider repository`);
  }
  const archivePath = assertModulePortablePath(value.archive.path, `${label}.archive.path`);
  if (archivePath !== `archives/${moduleId}.zip`) {
    throw new Error(`${label}.archive.path must be archives/${moduleId}.zip`);
  }

  const preview = parsePreview(value.preview, `${label}.preview`);
  const thumbnail = parsePreview(value.thumbnail, `${label}.thumbnail`);
  if (preview.path === thumbnail.path) {
    throw new Error(`${label}.preview and thumbnail must be independent files`);
  }
  if (!preview.path.startsWith(`previews/${moduleId}/`)) {
    throw new Error(`${label}.preview.path must be under previews/${moduleId}/`);
  }
  const thumbnailExtension = path.posix.extname(thumbnail.path).toLocaleLowerCase("en-US");
  if (
    thumbnail.path !== `thumbs/${moduleId}${thumbnailExtension}` ||
    !extensionMatchesMediaType(thumbnailExtension, thumbnail.mediaType)
  ) {
    throw new Error(`${label}.thumbnail.path must be the canonical thumbs/${moduleId} image path`);
  }
  const previewExtension = path.posix.extname(preview.path).toLocaleLowerCase("en-US");
  if (!extensionMatchesMediaType(previewExtension, preview.mediaType)) {
    throw new Error(`${label}.preview media type differs from its path extension`);
  }

  if (!isRecord(value.licenses)) throw new Error(`${label}.licenses must be an object`);
  exactKeys(value.licenses, ["code", "content", "documentation"], [], `${label}.licenses`);
  if (!isRecord(value.publisher)) throw new Error(`${label}.publisher must be an object`);
  exactKeys(
    value.publisher,
    ["reviewStatus", "executionStatus", "executionScope"],
    ["evidence"],
    `${label}.publisher`,
  );
  if (value.publisher.reviewStatus !== "approved") {
    throw new Error(`${label}.publisher.reviewStatus must be approved`);
  }
  if (!new Set(["not_run", "passed", "failed"]).has(String(value.publisher.executionStatus))) {
    throw new Error(`${label}.publisher.executionStatus is invalid`);
  }
  if (
    !new Set(["synthetic_data", "example_data", "real_data", "unknown"]).has(
      String(value.publisher.executionScope),
    )
  ) {
    throw new Error(`${label}.publisher.executionScope is invalid`);
  }
  if (value.publisher.executionStatus === "passed" && value.publisher.executionScope === "unknown") {
    throw new Error(`${label}.publisher passed execution requires a specific scope`);
  }
  const publisherEvidence =
    value.publisher.evidence === undefined
      ? undefined
      : pathArray(value.publisher.evidence, `${label}.publisher.evidence`, 100);
  if (publisherEvidence?.some((item) => !filePaths.has(item))) {
    throw new Error(`${label}.publisher.evidence references undeclared files`);
  }

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
    moduleId,
    title: text(value.title, `${label}.title`, 300),
    titleEn: text(value.titleEn, `${label}.titleEn`, 300),
    description: text(value.description, `${label}.description`, 8_000),
    application: text(value.application, `${label}.application`, 8_000),
    dataProfile: text(value.dataProfile, `${label}.dataProfile`, 8_000),
    plotFamily: text(value.plotFamily, `${label}.plotFamily`, 200),
    language: text(value.language, `${label}.language`, 100),
    tags,
    packages,
    codeFiles,
    inputFiles,
    canonicalCode,
    requiredFiles,
    files,
    source: {
      repository: sourceRepository,
      commit: commit(value.source.commit, `${label}.source.commit`),
      path: sourcePath,
    },
    archive: {
      repository: archiveRepository,
      commit: commit(value.archive.commit, `${label}.archive.commit`),
      path: archivePath,
      bytes: integer(value.archive.bytes, `${label}.archive.bytes`, MAX_ARCHIVE_BYTES),
      sha256: digest(value.archive.sha256, `${label}.archive.sha256`),
    },
    preview,
    thumbnail,
    licenses: {
      code: publicLicense(value.licenses.code, `${label}.licenses.code`),
      content: publicLicense(value.licenses.content, `${label}.licenses.content`),
      documentation: publicLicense(value.licenses.documentation, `${label}.licenses.documentation`),
    },
    publisher: {
      reviewStatus: "approved",
      executionStatus: value.publisher.executionStatus as ModuleCatalogEntry["publisher"]["executionStatus"],
      executionScope: value.publisher.executionScope as ModuleCatalogEntry["publisher"]["executionScope"],
      ...(publisherEvidence ? { evidence: publisherEvidence } : {}),
    },
    ...(provenance ? { provenance } : {}),
  };
}

export function parseModuleCatalog(
  value: unknown,
  options: { expectedProviderId?: string; expectedRepository?: string } = {},
): ModuleCatalog {
  if (!isRecord(value)) throw new Error("module Catalog must be an object");
  exactKeys(value, ["schema", "generatedAt", "provider", "modules"], [], "catalog");
  if (value.schema !== MODULE_CATALOG_SCHEMA) throw new Error("unsupported module Catalog schema");
  if (!isRecord(value.provider)) throw new Error("catalog.provider must be an object");
  exactKeys(value.provider, ["providerId", "displayName", "repository"], [], "catalog.provider");
  assertPortableMetadata(value.provider, "catalog.provider");
  assertProviderId(value.provider.providerId);
  if (
    options.expectedProviderId !== undefined &&
    value.provider.providerId !== options.expectedProviderId
  ) {
    throw new Error(
      `module Catalog providerId must be ${options.expectedProviderId}`,
    );
  }
  const provider = {
    providerId: value.provider.providerId,
    displayName: text(value.provider.displayName, "catalog.provider.displayName", 200),
    repository: repository(value.provider.repository, "catalog.provider.repository"),
  };
  if (
    options.expectedRepository !== undefined &&
    provider.repository !== options.expectedRepository
  ) {
    throw new Error(
      `module Catalog repository must be ${options.expectedRepository}`,
    );
  }
  if (!Array.isArray(value.modules) || value.modules.length > MAX_FILES) {
    throw new Error(`catalog.modules must have at most ${MAX_FILES} entries`);
  }
  const modules = value.modules.map((module, index) => parseEntry(module, provider, index));
  const ids = modules.map((module) => module.moduleId);
  if (new Set(ids).size !== ids.length) throw new Error("module Catalog contains duplicate moduleId");
  const ordered = [...modules].sort((left, right) =>
    compareCanonicalStrings(left.moduleId, right.moduleId),
  );
  if (canonicalJson(modules) !== canonicalJson(ordered)) {
    throw new Error("module Catalog entries are not canonically ordered");
  }
  const generatedAt = text(value.generatedAt, "catalog.generatedAt", 100);
  assertPortableMetadata(generatedAt, "catalog.generatedAt");
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("catalog.generatedAt is invalid");
  return { schema: MODULE_CATALOG_SCHEMA, generatedAt, provider, modules };
}

export function parseModulePreviewManifest(
  value: unknown,
  catalog: ModuleCatalog,
): ModulePreviewManifest {
  if (!isRecord(value)) throw new Error("module preview manifest must be an object");
  exactKeys(value, ["schema", "providerId", "entries"], [], "previewManifest");
  if (value.schema !== MODULE_PREVIEW_MANIFEST_SCHEMA) throw new Error("unsupported module preview manifest schema");
  if (value.providerId !== catalog.provider.providerId) throw new Error("module preview manifest providerId mismatch");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_FILES * 2) {
    throw new Error("module preview manifest entries are invalid");
  }
  const entries = value.entries.map((entryValue, index) => {
    const label = `previewManifest.entries[${index}]`;
    if (!isRecord(entryValue)) throw new Error(`${label} must be an object`);
    exactKeys(entryValue, ["moduleId", "role", "path", "bytes", "sha256", "mediaType"], [], label);
    if (entryValue.role !== "primary" && entryValue.role !== "thumbnail") {
      throw new Error(`${label}.role is invalid`);
    }
    const preview = parsePreview(
      {
        path: entryValue.path,
        bytes: entryValue.bytes,
        sha256: entryValue.sha256,
        mediaType: entryValue.mediaType,
      },
      label,
    );
    return {
      moduleId: text(entryValue.moduleId, `${label}.moduleId`, 128),
      role: entryValue.role as "primary" | "thumbnail",
      ...preview,
    };
  });
  const expected = catalog.modules.flatMap((module) => [
    { moduleId: module.moduleId, role: "primary" as const, ...module.preview },
    { moduleId: module.moduleId, role: "thumbnail" as const, ...module.thumbnail },
  ]);
  if (canonicalJson(entries) !== canonicalJson(expected)) {
    throw new Error("module preview manifest does not exactly match the Catalog previews");
  }
  return { schema: MODULE_PREVIEW_MANIFEST_SCHEMA, providerId: catalog.provider.providerId, entries };
}

export function parseModuleSourcePackManifest(
  value: unknown,
  catalog: ModuleCatalog,
): ModuleSourcePackManifest {
  if (!isRecord(value)) throw new Error("module Source Pack manifest must be an object");
  exactKeys(value, ["schema", "providerId", "repository", "entries"], [], "sourcePackManifest");
  if (value.schema !== MODULE_SOURCE_PACK_SCHEMA) throw new Error("unsupported module Source Pack schema");
  if (value.providerId !== catalog.provider.providerId) throw new Error("module Source Pack providerId mismatch");
  const manifestRepository = repository(value.repository, "sourcePackManifest.repository");
  if (manifestRepository !== catalog.provider.repository) throw new Error("module Source Pack repository mismatch");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_FILES) {
    throw new Error("module Source Pack entries are invalid");
  }
  const entries = value.entries.map((entryValue, index) => {
    const label = `sourcePackManifest.entries[${index}]`;
    if (!isRecord(entryValue)) throw new Error(`${label} must be an object`);
    exactKeys(
      entryValue,
      [
        "moduleId",
        "sourceRepository",
        "sourceCommit",
        "archiveRepository",
        "archiveCommit",
        "file",
        "bytes",
        "sha256",
      ],
      [],
      label,
    );
    return {
      moduleId: text(entryValue.moduleId, `${label}.moduleId`, 128),
      sourceRepository: repository(entryValue.sourceRepository, `${label}.sourceRepository`),
      sourceCommit: commit(entryValue.sourceCommit, `${label}.sourceCommit`),
      archiveRepository: repository(entryValue.archiveRepository, `${label}.archiveRepository`),
      archiveCommit: commit(entryValue.archiveCommit, `${label}.archiveCommit`),
      file: assertModulePortablePath(entryValue.file, `${label}.file`),
      bytes: integer(entryValue.bytes, `${label}.bytes`, MAX_ARCHIVE_BYTES),
      sha256: digest(entryValue.sha256, `${label}.sha256`),
    };
  });
  const expectedById = new Map(catalog.modules.map((module) => [module.moduleId, {
    moduleId: module.moduleId,
    sourceRepository: module.source.repository,
    sourceCommit: module.source.commit,
    archiveRepository: module.archive.repository,
    archiveCommit: module.archive.commit,
    file: module.archive.path,
    bytes: module.archive.bytes,
    sha256: module.archive.sha256,
  }]));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.moduleId)) throw new Error(`duplicate Source Pack module: ${entry.moduleId}`);
    seen.add(entry.moduleId);
    const expected = expectedById.get(entry.moduleId);
    if (!expected || canonicalJson(entry) !== canonicalJson(expected)) {
      throw new Error(`module Source Pack entry does not match the Catalog: ${entry.moduleId}`);
    }
  }
  const orderedEntries = [...entries].sort((left, right) =>
    compareCanonicalStrings(left.moduleId, right.moduleId),
  );
  if (canonicalJson(entries) !== canonicalJson(orderedEntries)) {
    throw new Error("module Source Pack entries are not canonically ordered");
  }
  return {
    schema: MODULE_SOURCE_PACK_SCHEMA,
    providerId: catalog.provider.providerId,
    repository: manifestRepository,
    entries,
  };
}

function extensionForMediaType(mediaType: ModuleCatalogPreview["mediaType"]) {
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/jpeg") return ".jpg";
  return ".webp";
}

function extensionMatchesMediaType(
  extension: string,
  mediaType: ModuleCatalogPreview["mediaType"],
) {
  const normalized = extension.toLocaleLowerCase("en-US");
  return mediaType === "image/jpeg"
    ? normalized === ".jpg" || normalized === ".jpeg"
    : normalized === extensionForMediaType(mediaType);
}

async function readRegularContainedFile(root: string, relativePath: string) {
  const safe = assertModulePortablePath(relativePath, "asset path");
  const absoluteRoot = path.resolve(root);
  const file = path.resolve(absoluteRoot, ...safe.split("/"));
  const relative = path.relative(absoluteRoot, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`asset path escapes its root: ${relativePath}`);
  }
  let current = absoluteRoot;
  for (const [index, part] of safe.split("/").entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`asset path traverses a symlink: ${relativePath}`);
    if (index < safe.split("/").length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`asset path is not a regular file: ${relativePath}`);
    }
  }
  return new Uint8Array(await fs.readFile(file));
}

async function readSnapshotControlFile(root: string, name: string, maximumBytes: number) {
  const file = path.join(root, name);
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`personal module snapshot control file is not regular: ${name}`);
  }
  if (stat.size > maximumBytes) {
    throw new Error(`personal module snapshot control file exceeds its limit: ${name}`);
  }
  return new Uint8Array(await fs.readFile(file));
}

async function snapshotInventory(root: string) {
  const files: string[] = [];
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertModulePortablePath(relative, "personal module snapshot path");
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`personal module snapshot contains a symlink: ${relative}`);
      }
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`personal module snapshot contains a non-regular entry: ${relative}`);
    }
  };
  await walk(root);
  return files;
}

function assertSnapshotInventory(
  files: string[],
  previewManifest: ModulePreviewManifest,
) {
  const controls = new Set([
    "module-catalog.json",
    "module-preview.manifest.json",
    "module-source-pack.manifest.json",
    "PERSONAL_MODULES_LICENSE.txt",
  ]);
  const requiredControls = controls;
  const expected = new Set([
    ...requiredControls,
    ...previewManifest.entries.map((entry) => entry.path),
  ]);
  const folded = new Map<string, string>();
  for (const file of files) {
    const key = file.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = folded.get(key);
    if (prior !== undefined && prior !== file) {
      throw new Error(`personal module snapshot contains a case/NFC collision: ${prior} / ${file}`);
    }
    folded.set(key, file);
    if (
      !expected.has(file)
    ) {
      throw new Error(`personal module snapshot contains an undeclared file: ${file}`);
    }
    if (file.toLocaleLowerCase("en-US").endsWith(".zip")) {
      throw new Error(`personal module archive ZIP must not enter the SFL snapshot: ${file}`);
    }
  }
  const missing = [...expected].filter((file) => !files.includes(file));
  if (missing.length) {
    throw new Error(`personal module snapshot is missing declared files: ${missing.join(", ")}`);
  }
}

export class ModuleCatalogIndex {
  readonly catalog: ModuleCatalog;
  readonly catalogSha256: string;
  readonly previewManifest: ModulePreviewManifest;
  readonly sourcePackManifest: ModuleSourcePackManifest;
  readonly assetsDir: string;

  private constructor(options: {
    catalog: ModuleCatalog;
    catalogSha256: string;
    previewManifest: ModulePreviewManifest;
    sourcePackManifest: ModuleSourcePackManifest;
    assetsDir: string;
  }) {
    this.catalog = options.catalog;
    this.catalogSha256 = options.catalogSha256;
    this.previewManifest = options.previewManifest;
    this.sourcePackManifest = options.sourcePackManifest;
    this.assetsDir = options.assetsDir;
  }

  static empty(options: {
    providerId?: string;
    displayName?: string;
    repository?: string;
  } = {}) {
    assertProviderId(options.providerId ?? PERSONAL_MODULE_PROVIDER_ID);
    repository(options.repository ?? PERSONAL_MODULE_REPOSITORY, "empty Provider repository");
    const catalog: ModuleCatalog = {
      schema: MODULE_CATALOG_SCHEMA,
      generatedAt: "2000-01-01T00:00:00.000Z",
      provider: {
        providerId: options.providerId ?? PERSONAL_MODULE_PROVIDER_ID,
        displayName: options.displayName ?? PERSONAL_MODULE_SOURCE_LABEL,
        repository: options.repository ?? PERSONAL_MODULE_REPOSITORY,
      },
      modules: [],
    };
    const previewManifest: ModulePreviewManifest = {
      schema: MODULE_PREVIEW_MANIFEST_SCHEMA,
      providerId: catalog.provider.providerId,
      entries: [],
    };
    const sourcePackManifest: ModuleSourcePackManifest = {
      schema: MODULE_SOURCE_PACK_SCHEMA,
      providerId: catalog.provider.providerId,
      repository: catalog.provider.repository,
      entries: [],
    };
    const bytes = Buffer.from(`${canonicalJson(catalog)}\n`, "utf8");
    return new ModuleCatalogIndex({
      catalog,
      catalogSha256: createHash("sha256").update(bytes).digest("hex"),
      previewManifest,
      sourcePackManifest,
      assetsDir: DEFAULT_PERSONAL_MODULE_ASSETS_DIR,
    });
  }

  static async load(
    assetsDir = DEFAULT_PERSONAL_MODULE_ASSETS_DIR,
    options: {
      expectedProviderId?: string;
      expectedRepository?: string;
      validatePreviews?: boolean;
    } = {},
  ) {
    const root = path.resolve(assetsDir);
    let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      rootStat = await fs.lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const empty = ModuleCatalogIndex.empty({
        providerId: options.expectedProviderId,
        repository: options.expectedRepository,
      });
      return new ModuleCatalogIndex({
        catalog: empty.catalog,
        catalogSha256: empty.catalogSha256,
        previewManifest: empty.previewManifest,
        sourcePackManifest: empty.sourcePackManifest,
        assetsDir: root,
      });
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("personal module snapshot root must be a regular directory");
    }
    // An absent or genuinely empty snapshot directory is the supported
    // healthy-empty bootstrap. Once any file exists, all control files become
    // mandatory; silently converting a partial/corrupt installation to an
    // empty Provider would erase an important fail-closed signal.
    if ((await fs.readdir(root)).length === 0) {
      const empty = ModuleCatalogIndex.empty({
        providerId: options.expectedProviderId,
        repository: options.expectedRepository,
      });
      return new ModuleCatalogIndex({
        catalog: empty.catalog,
        catalogSha256: empty.catalogSha256,
        previewManifest: empty.previewManifest,
        sourcePackManifest: empty.sourcePackManifest,
        assetsDir: root,
      });
    }
    const catalogBytes = await readSnapshotControlFile(root, "module-catalog.json", MAX_CATALOG_BYTES);
    if (catalogBytes.byteLength > MAX_CATALOG_BYTES) throw new Error("module Catalog exceeds 16 MiB");
    const catalog = parseModuleCatalog(
      JSON.parse(decodeUtf8(catalogBytes, "module-catalog.json")) as unknown,
      {
        expectedProviderId: options.expectedProviderId,
        expectedRepository: options.expectedRepository,
      },
    );
    const previewManifest = parseModulePreviewManifest(
      JSON.parse(
        decodeUtf8(
          await readSnapshotControlFile(root, "module-preview.manifest.json", MAX_CATALOG_BYTES),
          "module-preview.manifest.json",
        ),
      ) as unknown,
      catalog,
    );
    const sourcePackManifest = parseModuleSourcePackManifest(
      JSON.parse(
        decodeUtf8(
          await readSnapshotControlFile(root, "module-source-pack.manifest.json", MAX_CATALOG_BYTES),
          "module-source-pack.manifest.json",
        ),
      ) as unknown,
      catalog,
    );
    const licenseBytes = await readSnapshotControlFile(
      root,
      "PERSONAL_MODULES_LICENSE.txt",
      1 * 1024 * 1024,
    );
    assertPortableMetadata(decodeUtf8(licenseBytes, "PERSONAL_MODULES_LICENSE.txt"), "personal module snapshot license");
    assertSnapshotInventory(await snapshotInventory(root), previewManifest);
    const result = new ModuleCatalogIndex({
      catalog,
      catalogSha256: createHash("sha256").update(catalogBytes).digest("hex"),
      previewManifest,
      sourcePackManifest,
      assetsDir: root,
    });
    if (options.validatePreviews !== false) {
      await Promise.all(
        catalog.modules.flatMap((module) => [
          result.loadPreview(module, "primary"),
          result.loadPreview(module, "thumbnail"),
        ]),
      );
    }
    return result;
  }

  get(moduleId: string) {
    return this.catalog.modules.find((module) => module.moduleId === moduleId);
  }

  async searchAll(request: import("./types.ts").SearchRequest) {
    const intent = buildSearchIntent(request);
    const scored = this.catalog.modules
      .filter((module) => {
        if (request.assetKind && request.assetKind !== "plot_template") return false;
        if (request.reviewStatus && request.reviewStatus !== "not_reviewed") return false;
        if (request.codeStatus && request.codeStatus !== "provided" && request.codeStatus !== "reviewed") {
          return false;
        }
        if (
          request.language &&
          normalizeSearchText(request.language) !== normalizeSearchText(module.language)
        ) {
          return false;
        }
        if (request.plotFamily) {
          const desired = buildSearchIntent({ query: request.plotFamily }).families;
          const actual = buildSearchIntent({ query: module.plotFamily }).families;
          if (
            desired.length
              ? !desired.some((family) => actual.includes(family))
              : !normalizeSearchText(module.plotFamily).includes(normalizeSearchText(request.plotFamily))
          ) {
            return false;
          }
        }
        return true;
      })
      .map((module) => ({
        module,
        evidence: scoreSearchableTemplate(
          {
            templateId: module.moduleId,
            title: `${module.title} ${module.titleEn}`,
            description: module.description,
            application: module.application,
            dataProfile: module.dataProfile,
            inputFiles: module.inputFiles,
            codeFiles: module.codeFiles,
            packages: module.packages,
            tags: module.tags,
          },
          intent,
        ),
      }))
      .filter(({ evidence }) => evidence.score > 0)
      .sort(
        (left, right) =>
          right.evidence.score - left.evidence.score ||
          compareCanonicalStrings(left.module.moduleId, right.module.moduleId),
      );
    return Promise.all(
      scored.map(async ({ module, evidence }) => {
        const selector = moduleArchiveExactSelector(
          this.catalog.provider.providerId,
          module,
          this.catalogSha256,
          "template",
        );
        const [previewAvailable, searchPreviewAvailable] = await Promise.all([
          this.primaryPreviewAvailable(module),
          this.thumbnailAvailable(module),
        ]);
        const warnings = [
          `publisherReviewStatus=${module.publisher.reviewStatus}`,
          `publisherExecutionStatus=${module.publisher.executionStatus}`,
          `publisherExecutionScope=${module.publisher.executionScope}`,
          "localReviewStatus=not_reviewed",
          "executionStatus=not_run",
          "codeExecutedBySflClient=false",
        ];
        if (!previewAvailable) warnings.push("declared personal module preview failed local integrity validation");
        return {
          templateId: module.moduleId,
          providerId: this.catalog.provider.providerId,
          exactSelector: selector,
          sourceLabel: this.catalog.provider.displayName,
          title: module.title,
          retrievalScore: evidence.score,
          matchedTerms: evidence.matchedTerms.slice(0, 12),
          reasons: evidence.reasons,
          warnings,
          excerpt: module.description.slice(0, 420),
          description: module.description,
          application: module.application,
          dataProfile: module.dataProfile,
          inputFiles: [...module.inputFiles],
          codeFiles: [...module.codeFiles],
          packages: [...module.packages],
          materializable: true,
          previewAvailable,
          searchPreviewAvailable,
          ...(previewAvailable
            ? {
                previewRef: {
                  schema: "figure-library.provider-preview-ref.v1" as const,
                  providerId: this.catalog.provider.providerId,
                  exactSelector: selector,
                },
              }
            : {}),
          materializationModes: ["template", "full"] as Array<"template" | "full">,
          materializationSelectors: {
            template: selector,
            full: moduleArchiveExactSelector(
              this.catalog.provider.providerId,
              module,
              this.catalogSha256,
              "full",
            ),
          },
          assetKind: "plot_template" as const,
          language: module.language,
          plotFamily: module.plotFamily,
          reviewStatus: "not_reviewed" as const,
          codeStatus: (module.codeFiles.length ? "provided" : "none") as "provided" | "none",
          executionStatus: "not_run" as const,
          publisherReviewStatus: module.publisher.reviewStatus,
          publisherExecutionStatus: module.publisher.executionStatus,
          publisherExecutionScope: module.publisher.executionScope,
          ...(module.publisher.evidence ? { publisherEvidence: [...module.publisher.evidence] } : {}),
          codeExecutedBySflClient: false as const,
          upstreamStatus: "published" as const,
          license: `${module.licenses.code}; ${module.licenses.content}; ${module.licenses.documentation}`,
          sourceUrl: `https://github.com/${module.source.repository}/tree/${module.source.commit}/${module.source.path}`,
          management: {
            templateId: module.moduleId,
            canArchive: false,
            canUpdate: false,
          },
        };
      }),
    );
  }

  async preview(
    module: ModuleCatalogEntry,
    role: "primary" | "thumbnail" = "primary",
  ) {
    return this.loadPreview(module, role);
  }

  async loadPreview(module: ModuleCatalogEntry, role: "primary" | "thumbnail" = "primary") {
    const identity = role === "primary" ? module.preview : module.thumbnail;
    const bytes = await readRegularContainedFile(this.assetsDir, identity.path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== identity.bytes || actual !== identity.sha256) {
      throw new Error(`${module.moduleId} ${role} preview differs from its pinned identity`);
    }
    const extension = path.posix.extname(identity.path).toLocaleLowerCase("en-US");
    assertMcpImageBytes({ bytes, mimeType: identity.mediaType, extension });
    return { bytes, mimeType: identity.mediaType, extension };
  }

  async primaryPreviewAvailable(module: ModuleCatalogEntry) {
    try {
      await this.loadPreview(module, "primary");
      return true;
    } catch {
      return false;
    }
  }

  async thumbnailAvailable(module: ModuleCatalogEntry) {
    try {
      await this.loadPreview(module, "thumbnail");
      return true;
    } catch {
      return false;
    }
  }

  async previewAvailable(module: ModuleCatalogEntry) {
    return this.primaryPreviewAvailable(module);
  }
}
