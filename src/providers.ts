import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.ts";
import type {
  ExactTemplateSelector,
  FigureYaArchiveIdentity,
  FigureYaCatalog,
  FigureYaExactSelector,
  FigureYaModule,
  FigureYaPreviewIdentity,
  FigureYaSourceExactSelector,
  ModuleArchiveExactSelector,
  ModuleArchiveIdentity,
  ModuleArchiveSelectorIdentity,
  ModuleCatalogEntry,
  ModuleCatalogPreview,
  ModulePreviewIdentity,
  LocalPublishedExactSelector,
  LocalPublishedSelectorIdentity,
  MaterializeMode,
} from "./types.ts";

export const FIGUREYA_PROVIDER_ID = "org.figureya.module";
export const LOCAL_LIBRARY_PROVIDER_ID = "org.scientificfigurelibrary.local";
export const PERSONAL_MODULE_PROVIDER_ID = "io.github.jarxunlai.personal-figures";

const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/u;
const HEX_SHA1 = /^[a-f0-9]{40}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[A-Za-z0-9._-]{1,128}$/u;
const PREVIEW_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function exactObjectKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${label}.${key} is unsupported`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
}

function validateJsonValue(value: unknown, pointer: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${pointer}/${index}`));
    return;
  }
  if (!isRecord(value)) throw new Error(`${pointer} is not a portable JSON value`);
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.includes("\0")) throw new Error(`${pointer} has an invalid key`);
    validateJsonValue(item, `${pointer}/${key}`);
  }
}

export function canonicalSelectorJson(selector: ExactTemplateSelector): string {
  assertExactTemplateSelector(selector);
  return canonicalJson(selector);
}

export function exactSelectorDigest(selector: ExactTemplateSelector): string {
  return createHash("sha256").update(canonicalSelectorJson(selector)).digest("hex");
}

export function assertProviderId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new Error(`invalid providerId: ${String(value)}`);
  }
}

export function assertExactTemplateSelector(
  value: unknown,
): asserts value is ExactTemplateSelector {
  if (!isRecord(value)) throw new Error("exactSelector must be an object");
  if (value.schema !== "figure-library.provider-selector.v1") {
    throw new Error(`unsupported exact selector schema: ${String(value.schema)}`);
  }
  assertProviderId(value.providerId);
  nonEmpty(value.kind, "exactSelector.kind");
  if (!isRecord(value.identity)) throw new Error("exactSelector.identity must be an object");
  validateJsonValue(value.identity, "exactSelector.identity");
}

/** Legacy `sourceId` is accepted only at an input boundary. */
export function normalizeProviderId(input: { providerId?: unknown; sourceId?: unknown }): string {
  if (input.providerId !== undefined) {
    assertProviderId(input.providerId);
    return input.providerId;
  }
  if (input.sourceId === "figureya") return FIGUREYA_PROVIDER_ID;
  if (input.sourceId === "user") return LOCAL_LIBRARY_PROVIDER_ID;
  throw new Error("providerId is required; legacy sourceId is recognized only for figureya/user");
}

export function localPublishedExactSelector(
  identity: LocalPublishedSelectorIdentity,
): LocalPublishedExactSelector {
  for (const field of ["templateId", "revisionId", "releaseId"] as const) {
    nonEmpty(identity[field], `local selector ${field}`);
  }
  const contentDigest = nonEmpty(identity.contentDigest, "local selector contentDigest").toLocaleLowerCase();
  if (!HEX_SHA256.test(contentDigest)) throw new Error("local selector contentDigest must be SHA-256");
  return {
    schema: "figure-library.provider-selector.v1",
    providerId: LOCAL_LIBRARY_PROVIDER_ID,
    kind: "local-published.v1",
    identity: { ...identity, contentDigest },
  };
}

export function assertLocalPublishedExactSelector(
  value: unknown,
): asserts value is LocalPublishedExactSelector {
  assertExactTemplateSelector(value);
  if (value.providerId !== LOCAL_LIBRARY_PROVIDER_ID || value.kind !== "local-published.v1") {
    throw new Error("exact selector is not a Local Published selector");
  }
  localPublishedExactSelector(value.identity as LocalPublishedSelectorIdentity);
}

export function assertLocalPublishedSelectorMatches(
  selector: unknown,
  expectedIdentity: LocalPublishedSelectorIdentity,
): asserts selector is LocalPublishedExactSelector {
  assertLocalPublishedExactSelector(selector);
  const expected = localPublishedExactSelector(expectedIdentity);
  if (canonicalSelectorJson(selector) !== canonicalSelectorJson(expected)) {
    throw new Error(
      `stale Local Published selector: expected ${exactSelectorDigest(expected)}, got ${exactSelectorDigest(selector)}`,
    );
  }
}

export function figureYaArchiveIdentity(module: FigureYaModule): FigureYaArchiveIdentity {
  if (!module.archiveAvailable) throw new Error(`${module.moduleId} has no pinned archive`);
  const bytes = positiveSafeInteger(module.archiveBytes, `${module.moduleId}.archiveBytes`);
  if (module.archiveSha256) {
    const digest = module.archiveSha256.toLocaleLowerCase();
    if (!HEX_SHA256.test(digest)) throw new Error(`${module.moduleId} has an invalid archive SHA-256`);
    return { algorithm: "sha256", digest, bytes };
  }
  if (module.archiveGitBlobSha1) {
    const digest = module.archiveGitBlobSha1.toLocaleLowerCase();
    if (!HEX_SHA1.test(digest)) throw new Error(`${module.moduleId} has an invalid archive Git blob SHA-1`);
    return { algorithm: "git-blob-sha1", digest, bytes, legacy: true };
  }
  throw new Error(`${module.moduleId} is materializable but has no archive integrity identity`);
}

export function figureYaPreviewIdentity(
  module: FigureYaModule,
): FigureYaPreviewIdentity | undefined {
  const declared = module.primaryPreview ?? module.thumbnail;
  const present = [module.previewBytes, module.previewSha256, module.previewMediaType].filter(
    (value) => value !== undefined,
  ).length;
  if (!declared && present) throw new Error(`${module.moduleId} has preview identity without a preview path`);
  if (!present) return undefined;
  if (present !== 3) throw new Error(`${module.moduleId} has an incomplete preview identity`);
  const bytes = positiveSafeInteger(module.previewBytes, `${module.moduleId}.previewBytes`);
  const digest = nonEmpty(module.previewSha256, `${module.moduleId}.previewSha256`).toLocaleLowerCase();
  if (!HEX_SHA256.test(digest)) throw new Error(`${module.moduleId} has an invalid preview SHA-256`);
  if (typeof module.previewMediaType !== "string" || !PREVIEW_MEDIA_TYPES.has(module.previewMediaType)) {
    throw new Error(`${module.moduleId} has an invalid preview media type`);
  }
  return { algorithm: "sha256", digest, bytes, mediaType: module.previewMediaType };
}

function assertFigureYaPreviewIdentity(
  value: unknown,
  label: string,
): asserts value is FigureYaPreviewIdentity {
  if (!isRecord(value) || value.algorithm !== "sha256") {
    throw new Error(`${label} is not a SHA-256 preview identity`);
  }
  positiveSafeInteger(value.bytes, `${label}.bytes`);
  const digest = nonEmpty(value.digest, `${label}.digest`).toLocaleLowerCase();
  if (!HEX_SHA256.test(digest)) throw new Error(`${label}.digest is not SHA-256`);
  if (typeof value.mediaType !== "string" || !PREVIEW_MEDIA_TYPES.has(value.mediaType)) {
    throw new Error(`${label}.mediaType is unsupported`);
  }
}

export function figureYaExactSelector(
  catalog: FigureYaCatalog,
  module: FigureYaModule,
  mode: MaterializeMode,
): FigureYaExactSelector {
  if (mode !== "template" && mode !== "full") throw new Error(`unsupported materialization mode: ${mode}`);
  const preview = figureYaPreviewIdentity(module);
  return {
    schema: "figure-library.provider-selector.v1",
    providerId: FIGUREYA_PROVIDER_ID,
    kind: "figureya-module.v1",
    identity: {
      moduleId: module.moduleId,
      sourceCommit: catalog.figureya.commit,
      archiveCommit: catalog.compressed.commit,
      archive: figureYaArchiveIdentity(module),
      ...(preview ? { preview } : {}),
      mode,
    },
  };
}

export function figureYaCandidateSelector(
  catalog: FigureYaCatalog,
  module: FigureYaModule,
  mode: MaterializeMode = "template",
): FigureYaExactSelector | FigureYaSourceExactSelector {
  if (module.archiveAvailable) return figureYaExactSelector(catalog, module, mode);
  const preview = figureYaPreviewIdentity(module);
  return {
    schema: "figure-library.provider-selector.v1",
    providerId: FIGUREYA_PROVIDER_ID,
    kind: "figureya-source-module.v1",
    identity: {
      moduleId: module.moduleId,
      sourceCommit: catalog.figureya.commit,
      ...(preview ? { preview } : {}),
    },
  };
}

export function assertFigureYaExactSelector(
  value: unknown,
): asserts value is FigureYaExactSelector {
  assertExactTemplateSelector(value);
  if (value.providerId !== FIGUREYA_PROVIDER_ID || value.kind !== "figureya-module.v1") {
    throw new Error("exact selector is not a FigureYa module selector");
  }
  const identity = value.identity;
  nonEmpty(identity.moduleId, "exactSelector.identity.moduleId");
  const sourceCommit = nonEmpty(identity.sourceCommit, "exactSelector.identity.sourceCommit");
  const archiveCommit = nonEmpty(identity.archiveCommit, "exactSelector.identity.archiveCommit");
  if (!COMMIT.test(sourceCommit) || !COMMIT.test(archiveCommit)) {
    throw new Error("FigureYa selector commits contain unsupported characters");
  }
  if (identity.mode !== "template" && identity.mode !== "full") {
    throw new Error("FigureYa selector mode must be template or full");
  }
  if (identity.preview !== undefined) {
    assertFigureYaPreviewIdentity(identity.preview, "exactSelector.identity.preview");
  }
  if (!isRecord(identity.archive)) throw new Error("FigureYa selector archive identity is missing");
  const bytes = positiveSafeInteger(identity.archive.bytes, "exactSelector.identity.archive.bytes");
  const digest = nonEmpty(identity.archive.digest, "exactSelector.identity.archive.digest").toLocaleLowerCase();
  if (identity.archive.algorithm === "sha256") {
    if (!HEX_SHA256.test(digest)) throw new Error("FigureYa selector has an invalid SHA-256");
  } else if (identity.archive.algorithm === "git-blob-sha1") {
    if (identity.archive.legacy !== true || !HEX_SHA1.test(digest)) {
      throw new Error("FigureYa legacy selector has an invalid Git blob SHA-1 identity");
    }
  } else {
    throw new Error(`unsupported FigureYa archive identity: ${String(identity.archive.algorithm)}`);
  }
  void bytes;
}

export function assertFigureYaSourceExactSelector(
  value: unknown,
): asserts value is FigureYaSourceExactSelector {
  assertExactTemplateSelector(value);
  if (
    value.providerId !== FIGUREYA_PROVIDER_ID ||
    value.kind !== "figureya-source-module.v1"
  ) {
    throw new Error("exact selector is not a FigureYa source-module selector");
  }
  const moduleId = nonEmpty(value.identity.moduleId, "exactSelector.identity.moduleId");
  const sourceCommit = nonEmpty(
    value.identity.sourceCommit,
    "exactSelector.identity.sourceCommit",
  );
  if (!COMMIT.test(moduleId) || !COMMIT.test(sourceCommit)) {
    throw new Error("FigureYa source selector contains unsupported characters");
  }
  if (value.identity.preview !== undefined) {
    assertFigureYaPreviewIdentity(
      value.identity.preview,
      "exactSelector.identity.preview",
    );
  }
}

export function assertFigureYaSourceSelectorMatches(
  selector: unknown,
  catalog: FigureYaCatalog,
  module: FigureYaModule,
): asserts selector is FigureYaSourceExactSelector {
  assertFigureYaSourceExactSelector(selector);
  if (module.archiveAvailable) {
    throw new Error(`stale FigureYa source selector: ${module.moduleId} now has a pinned archive`);
  }
  const expected = figureYaCandidateSelector(catalog, module);
  if (expected.kind !== "figureya-source-module.v1") {
    throw new Error(`stale FigureYa source selector: ${module.moduleId} is materializable`);
  }
  if (canonicalSelectorJson(selector) !== canonicalSelectorJson(expected)) {
    throw new Error(
      `stale FigureYa source selector: expected ${exactSelectorDigest(expected)}, got ${exactSelectorDigest(selector)}`,
    );
  }
}

export function assertFigureYaSelectorMatches(
  selector: unknown,
  catalog: FigureYaCatalog,
  module: FigureYaModule,
  mode: MaterializeMode,
): asserts selector is FigureYaExactSelector {
  assertFigureYaExactSelector(selector);
  const expected = figureYaExactSelector(catalog, module, mode);
  if (canonicalSelectorJson(selector) !== canonicalSelectorJson(expected)) {
    throw new Error(
      `stale FigureYa selector: expected ${exactSelectorDigest(expected)}, got ${exactSelectorDigest(selector)}`,
    );
  }
}

function assertCommit(value: unknown, label: string): asserts value is string {
  const commit = nonEmpty(value, label);
  if (commit !== commit.toLocaleLowerCase("en-US") || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error(`${label} must be a lowercase 40-hex commit`);
  }
}

const RESERVED_MODULE_WINDOWS_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function assertPortablePath(value: unknown, label: string): asserts value is string {
  const raw = nonEmpty(value, label);
  if (raw.length > 1_000) throw new Error(`${label} is too long`);
  const parts = raw.split("/");
  if (
    raw.normalize("NFC") !== raw ||
    raw.includes("\\") ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    raw.endsWith("/") ||
    /^[A-Za-z]:/u.test(raw) ||
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
        RESERVED_MODULE_WINDOWS_NAME.test(part),
    )
  ) {
    throw new Error(`${label} is not a portable relative path`);
  }
}

function assertModulePreviewIdentity(value: unknown, label: string): asserts value is ModulePreviewIdentity {
  if (!isRecord(value)) {
    throw new Error(`${label} is not a SHA-256 preview identity`);
  }
  exactObjectKeys(value, ["algorithm", "digest", "bytes", "mediaType"], label);
  if (value.algorithm !== "sha256") {
    throw new Error(`${label} is not a SHA-256 preview identity`);
  }
  const digest = nonEmpty(value.digest, `${label}.digest`);
  if (digest !== digest.toLocaleLowerCase("en-US") || !HEX_SHA256.test(digest)) {
    throw new Error(`${label}.digest must be lowercase SHA-256`);
  }
  const bytes = positiveSafeInteger(value.bytes, `${label}.bytes`);
  if (bytes > 64 * 1024 * 1024) throw new Error(`${label}.bytes exceeds the preview limit`);
  if (
    value.mediaType !== "image/png" &&
    value.mediaType !== "image/jpeg" &&
    value.mediaType !== "image/webp"
  ) {
    throw new Error(`${label}.mediaType is unsupported`);
  }
}

function assertModuleArchiveIdentity(value: unknown, label: string): asserts value is ModuleArchiveIdentity {
  if (!isRecord(value)) {
    throw new Error(`${label} is not a SHA-256 archive identity`);
  }
  exactObjectKeys(value, ["algorithm", "repository", "commit", "path", "digest", "bytes"], label);
  if (value.algorithm !== "sha256") {
    throw new Error(`${label} is not a SHA-256 archive identity`);
  }
  const repository = nonEmpty(value.repository, `${label}.repository`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`${label}.repository must be owner/repository`);
  }
  assertCommit(value.commit, `${label}.commit`);
  assertPortablePath(value.path, `${label}.path`);
  const digest = nonEmpty(value.digest, `${label}.digest`);
  if (digest !== digest.toLocaleLowerCase("en-US") || !HEX_SHA256.test(digest)) {
    throw new Error(`${label}.digest must be lowercase SHA-256`);
  }
  const bytes = positiveSafeInteger(value.bytes, `${label}.bytes`);
  if (bytes > 100 * 1024 * 1024) throw new Error(`${label}.bytes exceeds the archive limit`);
}

export function moduleArchiveExactSelector(
  providerId: string,
  module: ModuleCatalogEntry,
  catalogSha256: string,
  mode: "template" | "full",
): ModuleArchiveExactSelector {
  assertProviderId(providerId);
  if (mode !== "template" && mode !== "full") throw new Error(`unsupported materialization mode: ${mode}`);
  if (
    typeof catalogSha256 !== "string" ||
    catalogSha256 !== catalogSha256.toLocaleLowerCase("en-US") ||
    !HEX_SHA256.test(catalogSha256)
  ) {
    throw new Error("catalogSha256 must be a SHA-256 digest");
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(module.moduleId)) {
    throw new Error("module moduleId is invalid");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(module.source.repository)) {
    throw new Error("module source repository is invalid");
  }
  assertCommit(module.source.commit, "module source commit");
  assertPortablePath(module.source.path, "module source path");
  assertCommit(module.archive.commit, "module archive commit");
  assertPortablePath(module.archive.path, "module archive path");
  if (module.source.repository !== module.archive.repository) {
    throw new Error("module source and archive repositories must match");
  }
  if (module.source.path !== `modules/${module.moduleId}`) {
    throw new Error("module source path is not canonical");
  }
  if (module.archive.path !== `archives/${module.moduleId}.zip`) {
    throw new Error("module archive path is not canonical");
  }
  const preview: ModulePreviewIdentity = {
    algorithm: "sha256",
    digest: module.preview.sha256,
    bytes: module.preview.bytes,
    mediaType: module.preview.mediaType,
  };
  const archive: ModuleArchiveIdentity = {
    algorithm: "sha256",
    repository: module.archive.repository,
    commit: module.archive.commit,
    path: module.archive.path,
    digest: module.archive.sha256,
    bytes: module.archive.bytes,
  };
  assertModuleArchiveIdentity(archive, "module archive");
  assertModulePreviewIdentity(preview, "module preview");
  return {
    schema: "figure-library.provider-selector.v1",
    providerId,
    kind: "module-archive.v1",
    identity: {
      moduleId: module.moduleId,
      sourceRepository: module.source.repository,
      sourceCommit: module.source.commit,
      sourcePath: module.source.path,
      archiveCommit: module.archive.commit,
      archive,
      preview,
      catalogSha256,
      mode,
    },
  };
}

export function assertModuleArchiveExactSelector(
  value: unknown,
): asserts value is ModuleArchiveExactSelector {
  assertExactTemplateSelector(value);
  exactObjectKeys(
    value as unknown as Record<string, unknown>,
    ["schema", "providerId", "kind", "identity"],
    "exactSelector",
  );
  if (value.kind !== "module-archive.v1") throw new Error("exact selector is not a module archive selector");
  const identity = value.identity as ModuleArchiveSelectorIdentity;
  exactObjectKeys(
    identity,
    [
      "moduleId",
      "sourceRepository",
      "sourceCommit",
      "sourcePath",
      "archiveCommit",
      "archive",
      "preview",
      "catalogSha256",
      "mode",
    ],
    "exactSelector.identity",
  );
  const moduleId = nonEmpty(identity.moduleId, "exactSelector.identity.moduleId");
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(moduleId)) {
    throw new Error("exactSelector.identity.moduleId is invalid");
  }
  const sourceRepository = nonEmpty(
    identity.sourceRepository,
    "exactSelector.identity.sourceRepository",
  );
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(sourceRepository)) {
    throw new Error("exactSelector.identity.sourceRepository must be owner/repository");
  }
  assertCommit(identity.sourceCommit, "exactSelector.identity.sourceCommit");
  assertPortablePath(identity.sourcePath, "exactSelector.identity.sourcePath");
  if (identity.sourcePath !== `modules/${moduleId}`) {
    throw new Error("exactSelector.identity.sourcePath is not canonical for the module");
  }
  assertCommit(identity.archiveCommit, "exactSelector.identity.archiveCommit");
  assertModuleArchiveIdentity(identity.archive, "exactSelector.identity.archive");
  if (identity.archiveCommit !== identity.archive.commit) {
    throw new Error("module selector archiveCommit differs from archive.commit");
  }
  if (identity.sourceRepository !== identity.archive.repository) {
    throw new Error("module selector source and archive repositories differ");
  }
  if (identity.archive.path !== `archives/${moduleId}.zip`) {
    throw new Error("exactSelector.identity.archive.path is not canonical for the module");
  }
  assertModulePreviewIdentity(identity.preview, "exactSelector.identity.preview");
  const catalogSha256 = nonEmpty(identity.catalogSha256, "exactSelector.identity.catalogSha256");
  if (
    !HEX_SHA256.test(catalogSha256) ||
    catalogSha256 !== catalogSha256.toLocaleLowerCase("en-US")
  ) {
    throw new Error("module selector catalogSha256 must be lowercase SHA-256");
  }
  if (identity.mode !== "template" && identity.mode !== "full") {
    throw new Error("module selector mode must be template or full");
  }
}

export function assertModuleArchiveSelectorMatches(
  selector: unknown,
  providerId: string,
  module: ModuleCatalogEntry,
  catalogSha256: string,
): asserts selector is ModuleArchiveExactSelector {
  assertModuleArchiveExactSelector(selector);
  if (selector.providerId !== providerId) throw new Error("module selector providerId mismatch");
  const expected = moduleArchiveExactSelector(providerId, module, catalogSha256, selector.identity.mode);
  if (canonicalSelectorJson(selector) !== canonicalSelectorJson(expected)) {
    throw new Error(
      `stale module selector: expected ${exactSelectorDigest(expected)}, got ${exactSelectorDigest(selector)}`,
    );
  }
}
