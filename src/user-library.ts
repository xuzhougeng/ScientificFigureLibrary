import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSearchIntent, scoreSearchableTemplate } from "./catalog.ts";
import { LOCAL_LIBRARY_PROVIDER_ID } from "./providers.ts";
import {
  assetFingerprints,
  discoverGalleryEntries,
  EMBEDDABLE_IMAGE_TYPES,
  MAX_CODE_BYTES,
  MAX_CODE_FILES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  prepareDirectImport,
  prepareGalleryEntry,
  prepareTransferPackage,
  type PreparedTemplate,
} from "./importers.ts";
import type {
  AssetFingerprintsV1,
  AssetKind,
  CodeStatus,
  ImportAdapter,
  ManagementReference,
  ReviewStatus,
  SearchRequest,
  StoredFile,
  StoredPreview,
  StoredReference,
  TemplateCandidate,
  UserTemplate,
  UserTemplateImport,
} from "./types.ts";

export interface LoadedTemplate {
  template: UserTemplate;
  directory: string;
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveStoredFile(directory: string, relative: string) {
  const normalized = relative.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`unsafe stored file path: ${relative}`);
  }
  const resolved = path.resolve(directory, ...normalized.split("/"));
  const root = `${path.resolve(directory)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error(`unsafe stored file path: ${relative}`);
  return resolved;
}

function validFingerprints(value: unknown): value is AssetFingerprintsV1 {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AssetFingerprintsV1>;
  const optionalHash = (hash: unknown) => hash === undefined || /^[a-f0-9]{64}$/u.test(String(hash));
  return (
    item.algorithm === "figure-library.asset-fingerprints.v1" &&
    optionalHash(item.previewSha256) &&
    optionalHash(item.executableCodeSetSha256) &&
    optionalHash(item.dataSetSha256) &&
    optionalHash(item.metadataSetSha256) &&
    /^[a-f0-9]{64}$/u.test(item.fullAssetSha256 ?? "")
  );
}

function isUserTemplate(value: unknown): value is UserTemplate {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<UserTemplate>;
  const storedFile = (file: unknown): file is StoredFile => {
    if (!file || typeof file !== "object") return false;
    const stored = file as Partial<StoredFile>;
    return (
      typeof stored.file === "string" &&
      typeof stored.bytes === "number" &&
      Number.isSafeInteger(stored.bytes) &&
      stored.bytes >= 0 &&
      typeof stored.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(stored.sha256)
    );
  };
  const storedReference = (file: unknown): file is StoredReference =>
    storedFile(file) &&
    (file as Partial<StoredReference>).role !== undefined &&
    ["data", "metadata"].includes((file as Partial<StoredReference>).role ?? "");
  const references = item.references ?? [];
  const assetKinds: AssetKind[] = ["plot_template", "visual_reference"];
  const reviewStatuses: ReviewStatus[] = ["draft", "approved", "archived"];
  const codeStatuses: CodeStatus[] = ["none", "scaffold", "reviewed"];
  const registry = item.registry;
  return (
    item.schema === "figure-library.template.v1" &&
    item.sourceId === "user" &&
    typeof item.templateId === "string" &&
    typeof item.title === "string" &&
    typeof item.description === "string" &&
    typeof item.visualProfile === "string" &&
    typeof item.dataProfile === "string" &&
    typeof item.license === "string" &&
    typeof item.importedAt === "string" &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === "string") &&
    Array.isArray(item.packages) &&
    item.packages.every((name) => typeof name === "string") &&
    Array.isArray(item.code) &&
    item.code.length <= MAX_CODE_FILES &&
    item.code.every(storedFile) &&
    Array.isArray(references) &&
    references.length <= MAX_CODE_FILES &&
    references.every(storedReference) &&
    (item.assetKind === undefined || assetKinds.includes(item.assetKind)) &&
    (item.language === undefined || typeof item.language === "string") &&
    (item.plotFamily === undefined || typeof item.plotFamily === "string") &&
    (item.reviewStatus === undefined || reviewStatuses.includes(item.reviewStatus)) &&
    (item.codeStatus === undefined || codeStatuses.includes(item.codeStatus)) &&
    (registry === undefined ||
      (typeof registry.sourceId === "string" &&
        ["direct", "gallery", "figure-transfer-package"].includes(registry.adapter) &&
        /^[a-f0-9]{64}$/u.test(registry.contentHash) &&
        (registry.templateId === undefined || registry.templateId === item.templateId) &&
        (registry.galleryId === undefined || typeof registry.galleryId === "string") &&
        (registry.sourceCommit === undefined || typeof registry.sourceCommit === "string") &&
        (registry.identityMode === undefined ||
          ["stable-source", "content-addressed"].includes(registry.identityMode)) &&
        (registry.fingerprints === undefined || validFingerprints(registry.fingerprints)))) &&
    (item.preview === undefined ||
      (storedFile(item.preview) && typeof item.preview.mediaType === "string")) &&
    [...item.code, ...references].reduce(
      (total, file) => total + file.bytes,
      item.preview?.bytes ?? 0,
    ) <= MAX_TOTAL_BYTES
  );
}

async function checkedStoredBytes(directory: string, stored: StoredFile, maxBytes: number) {
  if (stored.bytes > maxBytes) throw new Error(`stored reference exceeds size limit: ${stored.file}`);
  const file = resolveStoredFile(directory, stored.file);
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`stored reference is not a regular file: ${stored.file}`);
  }
  if (stat.size !== stored.bytes) throw new Error(`stored reference size mismatch: ${stored.file}`);
  const bytes = new Uint8Array(await fs.readFile(file));
  if (sha256(bytes) !== stored.sha256) {
    throw new Error(`stored reference checksum mismatch: ${stored.file}`);
  }
  return bytes;
}

export function managementReference(template: UserTemplate): ManagementReference {
  const registry = template.registry;
  if (!registry) {
    return {
      templateId: template.templateId,
      canArchive: true,
      canUpdate: false,
    };
  }
  const updateVia =
    registry.adapter === "gallery"
      ? "gallery-sync"
      : registry.adapter === "figure-transfer-package"
        ? "diff-upsert"
        : registry.adapter === "direct"
          ? "plan-apply"
          : undefined;
  return {
    templateId: template.templateId,
    adapter: registry.adapter,
    registrySourceId: registry.sourceId,
    galleryId: registry.galleryId,
    identityMode: registry.identityMode,
    canArchive: true,
    canUpdate: Boolean(updateVia),
    updateVia,
  };
}

function userCandidate(
  template: UserTemplate,
  evidence: ReturnType<typeof scoreSearchableTemplate>,
) {
  const warnings = [];
  if (templateAssetKind(template) === "visual_reference") {
    warnings.push("只有视觉参考，没有附带绘图代码");
  }
  const contentDigest =
    template.registry?.contentHash && /^[a-f0-9]{64}$/u.test(template.registry.contentHash)
      ? template.registry.contentHash
      : sha256(
          JSON.stringify({
            templateId: template.templateId,
            preview: template.preview?.sha256,
            code: template.code.map((file) => file.sha256).sort(),
            references: (template.references ?? []).map((file) => file.sha256).sort(),
          }),
        );
  const exactSelector = {
    schema: "figure-library.provider-selector.v1" as const,
    providerId: LOCAL_LIBRARY_PROVIDER_ID,
    kind: "legacy-flat.v1",
    identity: { templateId: template.templateId, contentDigest },
  };
  return {
    templateId: template.templateId,
    providerId: LOCAL_LIBRARY_PROVIDER_ID,
    exactSelector,
    sourceLabel: "User Library",
    title: template.title,
    retrievalScore: evidence.score,
    matchedTerms: evidence.matchedTerms.slice(0, 12),
    reasons: evidence.reasons,
    warnings,
    excerpt: template.description.slice(0, 420),
    description: template.description,
    application: template.visualProfile,
    dataProfile: template.dataProfile,
    inputFiles: (template.references ?? [])
      .filter((file) => file.role === "data")
      .map((file) => path.posix.basename(file.file)),
    codeFiles: template.code.map((file) => path.posix.basename(file.file)),
    packages: template.packages,
    materializable: true,
    previewAvailable: Boolean(
      template.preview && EMBEDDABLE_IMAGE_TYPES.has(template.preview.mediaType),
    ),
    previewRef:
      template.preview && EMBEDDABLE_IMAGE_TYPES.has(template.preview.mediaType)
        ? {
            schema: "figure-library.provider-preview-ref.v1" as const,
            providerId: LOCAL_LIBRARY_PROVIDER_ID,
            exactSelector,
          }
        : undefined,
    assetKind: templateAssetKind(template),
    language: template.language ?? inferStoredLanguage(template),
    plotFamily: template.plotFamily ?? "",
    reviewStatus: template.reviewStatus ?? "approved",
    codeStatus: template.codeStatus ?? (template.code.length ? "reviewed" : "none"),
    executionStatus: "not_run" as const,
    license: template.license,
    sourceUrl: template.provenance?.url,
    management: managementReference(template),
  } satisfies TemplateCandidate;
}

function inferStoredLanguage(template: UserTemplate) {
  const files = template.code.map((file) => file.file.toLocaleLowerCase());
  if (files.some((file) => /\.(?:r|rmd|qmd)$/u.test(file))) return "R";
  if (files.some((file) => /\.(?:py|ipynb)$/u.test(file))) return "Python";
  if (files.some((file) => file.endsWith(".jl"))) return "Julia";
  if (files.some((file) => file.endsWith(".m"))) return "MATLAB";
  return "none";
}

function templateAssetKind(template: UserTemplate): AssetKind {
  return template.assetKind ?? (template.code.length ? "plot_template" : "visual_reference");
}

function sameText(left: string | undefined, right: string | undefined) {
  return (left ?? "").toLocaleLowerCase() === (right ?? "").toLocaleLowerCase();
}

function matchesTemplateFilters(template: UserTemplate, request: SearchRequest) {
  const reviewStatus = template.reviewStatus ?? "approved";
  if (reviewStatus !== (request.reviewStatus ?? "approved")) return false;
  if (request.assetKind && templateAssetKind(template) !== request.assetKind) return false;
  if (request.language && !sameText(template.language ?? inferStoredLanguage(template), request.language)) {
    return false;
  }
  if (request.plotFamily && !sameText(template.plotFamily, request.plotFamily)) return false;
  if (
    request.codeStatus &&
    (template.codeStatus ?? (template.code.length ? "reviewed" : "none")) !== request.codeStatus
  ) {
    return false;
  }
  return true;
}

export interface ImportSourceInput {
  packagePath?: string;
  galleryPath?: string;
  sourceCommit?: string;
}

export interface ImportChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ImportDiff {
  action: "create" | "unchanged" | "update" | "skipped";
  adapter: ImportAdapter;
  sourceId: string;
  galleryId?: string;
  templateId: string;
  incomingContentHash: string;
  existingContentHash?: string;
  sourceCommit?: string;
  reviewStatus: ReviewStatus;
  changes: ImportChange[];
  reason?: string;
}

export interface GallerySyncOptions {
  galleryDirectory: string;
  dryRun: boolean;
  sourceCommit?: string;
  assetKind?: AssetKind;
  language?: string;
  plotFamily?: string;
  reviewStatus?: ReviewStatus;
  codeStatus?: CodeStatus;
}

export interface TemplateDiagnostic {
  directoryName: string;
  directory: string;
  templateId?: string;
  error: string;
}

export interface ScannedTemplate extends LoadedTemplate {
  manifestSha256: string;
  verifiedFileSetDigest: string;
  fingerprints: AssetFingerprintsV1;
  legacy: boolean;
}

export interface TemplateScan {
  valid: ScannedTemplate[];
  invalid: TemplateDiagnostic[];
}

export type DirectImportAction =
  | "create"
  | "unchanged"
  | "update"
  | "duplicate_candidate"
  | "source_conflict";

export interface DirectImportMatch {
  templateId: string;
  title: string;
  matchKinds: string[];
  manifestSha256: string;
}

export interface DirectImportPlan {
  action: DirectImportAction;
  normalizedTitle: string;
  proposedTemplateId: string;
  registrySourceId: string;
  identityMode: "stable-source" | "content-addressed";
  fingerprints: AssetFingerprintsV1;
  contentHash: string;
  changes: ImportChange[];
  matches: DirectImportMatch[];
  planDigest: string;
  written: false;
}

export interface DirectImportApplyInput extends UserTemplateImport {
  planDigest: string;
  expectedAction: DirectImportAction;
  expectedTemplateId: string;
  operationId: string;
  duplicateResolution?:
    | { action: "reuse"; templateId: string; reason: string }
    | { action: "create_separate"; reason: string };
  sourceConflictResolution?: { action: "replace_source"; reason: string };
}

export interface ReconcileExpectedState {
  manifestSha256: string;
  verifiedFileSetDigest: string;
  reviewStatus: ReviewStatus;
}

export interface ReconcileInput {
  mode?: "dry-run" | "apply" | "rollback";
  reconcileId: string;
  canonicalTemplateId: string;
  duplicateTemplateIds: string[];
  strategy: "archive_duplicates";
  expectedState: Record<string, ReconcileExpectedState>;
  reason: string;
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, comparable(item)]),
  );
}

function templateSummary(template: UserTemplate) {
  return {
    title: template.title,
    description: template.description,
    tags: [...template.tags].sort(),
    visualProfile: template.visualProfile,
    dataProfile: template.dataProfile,
    packages: [...template.packages].sort(),
    license: template.license,
    assetKind: templateAssetKind(template),
    language: template.language ?? inferStoredLanguage(template),
    plotFamily: template.plotFamily ?? "",
    reviewStatus: template.reviewStatus ?? "approved",
    codeStatus: template.codeStatus ?? (template.code.length ? "reviewed" : "none"),
    sourceCommit: template.registry?.sourceCommit ?? "",
    provenance: template.provenance,
    preview: template.preview,
    code: [...template.code].sort((left, right) => left.file.localeCompare(right.file)),
    references: [...(template.references ?? [])].sort((left, right) =>
      left.file.localeCompare(right.file),
    ),
  };
}

function preparedSummary(prepared: PreparedTemplate) {
  return {
    title: prepared.title,
    description: prepared.description,
    tags: [...prepared.tags].sort(),
    visualProfile: prepared.visualProfile,
    dataProfile: prepared.dataProfile,
    packages: [...prepared.packages].sort(),
    license: prepared.license,
    assetKind: prepared.assetKind,
    language: prepared.language,
    plotFamily: prepared.plotFamily,
    reviewStatus: prepared.reviewStatus,
    codeStatus: prepared.codeStatus,
    sourceCommit: prepared.registry?.sourceCommit ?? "",
    provenance: prepared.provenance,
    preview: prepared.preview?.stored,
    code: prepared.code
      .map((item) => item.stored)
      .sort((left, right) => left.file.localeCompare(right.file)),
    references: prepared.references
      .map((item) => item.stored)
      .sort((left, right) => left.file.localeCompare(right.file)),
  };
}

function changedFields(existing: UserTemplate, prepared: PreparedTemplate) {
  const before = templateSummary(existing);
  const after = preparedSummary(prepared);
  const changes: ImportChange[] = [];
  for (const field of Object.keys(after) as Array<keyof typeof after>) {
    if (JSON.stringify(comparable(before[field])) !== JSON.stringify(comparable(after[field]))) {
      changes.push({ field, before: before[field] ?? null, after: after[field] ?? null });
    }
  }
  return changes;
}

function matchesPreparedFilters(prepared: PreparedTemplate, options: GallerySyncOptions) {
  return (
    (!options.assetKind || prepared.assetKind === options.assetKind) &&
    (!options.language || sameText(prepared.language, options.language)) &&
    (!options.plotFamily || sameText(prepared.plotFamily, options.plotFamily)) &&
    (!options.reviewStatus || prepared.reviewStatus === options.reviewStatus) &&
    (!options.codeStatus || prepared.codeStatus === options.codeStatus)
  );
}

async function prepareImportSource(input: ImportSourceInput) {
  if (Boolean(input.packagePath) === Boolean(input.galleryPath)) {
    throw new Error("provide exactly one of packagePath or galleryPath");
  }
  return input.packagePath
    ? prepareTransferPackage(input.packagePath)
    : prepareGalleryEntry(input.galleryPath ?? "", input.sourceCommit);
}

async function writeReadOnly(file: string, bytes: Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  await fs.chmod(file, 0o444);
}

function provenanceMarkdown(template: UserTemplate) {
  const provenance = template.provenance;
  if (!provenance) return "\n";
  const lines = [
    ["Source ID", provenance.sourceId],
    ["Figure ID", provenance.figureId],
    ["Figure", provenance.figureLabel],
    ["Caption", provenance.caption],
    ["Paper", provenance.paperTitle],
    ["DOI", provenance.doi],
    ["Page", provenance.page],
    ["URL", provenance.url],
    ["Rights", provenance.rights],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `- ${label}: ${value}`);
  return lines.length ? `\n## Provenance\n\n${lines.join("\n")}\n\n` : "\n";
}

function templateFingerprints(template: UserTemplate) {
  return (
    template.registry?.fingerprints ??
    assetFingerprints(template.preview, template.code, template.references ?? [])
  );
}

function verifiedDescriptorDigest(template: UserTemplate) {
  const descriptors = [
    ...(template.preview ? [{ role: "preview", ...template.preview }] : []),
    ...template.code.map((file) => ({ role: "code", ...file })),
    ...(template.references ?? []).map((file) => ({ ...file, role: file.role })),
  ].sort(
    (left, right) => left.role.localeCompare(right.role) || left.file.localeCompare(right.file),
  );
  return sha256(JSON.stringify(descriptors));
}

function normalizedTitle(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function componentMatchKinds(
  left: AssetFingerprintsV1,
  right: AssetFingerprintsV1,
  leftTitle?: string,
  rightTitle?: string,
) {
  const kinds: string[] = [];
  if (left.fullAssetSha256 === right.fullAssetSha256) kinds.push("same_full_asset");
  if (left.previewSha256 && left.previewSha256 === right.previewSha256) kinds.push("same_preview");
  if (
    left.executableCodeSetSha256 &&
    left.executableCodeSetSha256 === right.executableCodeSetSha256
  ) {
    kinds.push("same_executable_code");
  }
  if (left.dataSetSha256 && left.dataSetSha256 === right.dataSetSha256) kinds.push("same_data");
  if (left.metadataSetSha256 && left.metadataSetSha256 === right.metadataSetSha256) {
    kinds.push("same_metadata");
  }
  if (
    kinds.some((kind) =>
      ["same_preview", "same_executable_code", "same_data", "same_metadata"].includes(kind),
    ) &&
    !kinds.includes("same_full_asset")
  ) {
    kinds.push("partial_component_overlap");
  }
  if (
    leftTitle !== undefined &&
    rightTitle !== undefined &&
    normalizedTitle(leftTitle) === normalizedTitle(rightTitle)
  ) {
    kinds.push("similar_title");
  }
  return kinds;
}

function hasStrongAssetContinuity(kinds: string[]) {
  return kinds.some((kind) =>
    ["same_full_asset", "same_preview", "same_executable_code", "same_data"].includes(kind),
  );
}

export class UserTemplateLibrary {
  readonly root: string;
  readonly templatesDirectory: string;
  readonly directorySource: "argument" | "FIGURE_LIBRARY_DIR" | "default";
  readonly writeLockDirectory: string;
  readonly transactionsDirectory: string;

  constructor(root?: string) {
    const environmentRoot = process.env.FIGURE_LIBRARY_DIR?.trim() || undefined;
    const selected = root ?? environmentRoot ?? path.join(os.homedir(), ".figure-library");
    this.directorySource = root ? "argument" : environmentRoot ? "FIGURE_LIBRARY_DIR" : "default";
    this.root = path.resolve(selected);
    this.templatesDirectory = path.join(this.root, "templates");
    this.writeLockDirectory = path.join(this.root, ".write-lock");
    this.transactionsDirectory = path.join(this.root, "transactions");
  }

  private async incompleteTransactions() {
    let entries;
    try {
      entries = await fs.readdir(this.transactionsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const incomplete = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      try {
        const journal = JSON.parse(
          await fs.readFile(path.join(this.transactionsDirectory, entry.name, "journal.json"), "utf8"),
        ) as { status?: string };
        if (journal.status !== "committed" && journal.status !== "rolled-back") {
          incomplete.push(entry.name);
        }
      } catch {
        incomplete.push(entry.name);
      }
    }
    return incomplete.sort();
  }

  private async withWriteLock<T>(
    operation: string,
    callback: () => Promise<T>,
    options: { allowIncompleteTransaction?: string } = {},
  ) {
    await fs.mkdir(this.root, { recursive: true });
    try {
      await fs.mkdir(this.writeLockDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        let owner = "unknown writer";
        try {
          owner = await fs.readFile(path.join(this.writeLockDirectory, "owner.json"), "utf8");
        } catch {
          // Preserve a missing/corrupt lock for manual recovery.
        }
        throw new Error(`user library is write-locked; manual recovery required: ${owner}`);
      }
      throw error;
    }
    try {
      await fs.writeFile(
        path.join(this.writeLockDirectory, "owner.json"),
        `${JSON.stringify({ operation, pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
        { flag: "wx" },
      );
      const incomplete = (await this.incompleteTransactions()).filter(
        (transactionId) => transactionId !== options.allowIncompleteTransaction,
      );
      if (incomplete.length) {
        throw new Error(
          `incomplete user-library transaction requires recovery: ${incomplete.join(", ")}`,
        );
      }
      return await callback();
    } finally {
      await fs.rm(this.writeLockDirectory, { recursive: true, force: true });
    }
  }

  async scanTemplates(options: { verifyFiles?: boolean } = {}): Promise<TemplateScan> {
    let entries;
    try {
      entries = await fs.readdir(this.templatesDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { valid: [], invalid: [] };
      throw error;
    }
    const valid: ScannedTemplate[] = [];
    const invalid: TemplateDiagnostic[] = [];
    for (const entry of entries.filter((item) => !item.name.startsWith("."))) {
      const directory = path.join(this.templatesDirectory, entry.name);
      if (!entry.isDirectory()) {
        invalid.push({ directoryName: entry.name, directory, error: "template entry is not a directory" });
        continue;
      }
      let value: unknown;
      let manifestText: string;
      try {
        manifestText = await fs.readFile(path.join(directory, "template.json"), "utf8");
        value = JSON.parse(manifestText) as unknown;
      } catch (error) {
        invalid.push({
          directoryName: entry.name,
          directory,
          error: `template manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const templateId =
        value && typeof value === "object" && "templateId" in value
          ? String((value as { templateId?: unknown }).templateId ?? "") || undefined
          : undefined;
      if (!isUserTemplate(value)) {
        invalid.push({ directoryName: entry.name, directory, templateId, error: "invalid template schema" });
        continue;
      }
      if (value.templateId !== entry.name) {
        invalid.push({
          directoryName: entry.name,
          directory,
          templateId: value.templateId,
          error: "templateId does not match directory name",
        });
        continue;
      }
      try {
        for (const stored of [
          ...(value.preview ? [value.preview] : []),
          ...value.code,
          ...(value.references ?? []),
        ]) {
          resolveStoredFile(directory, stored.file);
          if (options.verifyFiles) {
            await checkedStoredBytes(
              directory,
              stored,
              stored === value.preview ? MAX_IMAGE_BYTES : MAX_CODE_BYTES,
            );
          }
        }
      } catch (error) {
        invalid.push({
          directoryName: entry.name,
          directory,
          templateId: value.templateId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const computedFingerprints = assetFingerprints(
        value.preview,
        value.code,
        value.references ?? [],
      );
      if (
        value.registry?.fingerprints &&
        JSON.stringify(comparable(value.registry.fingerprints)) !==
          JSON.stringify(comparable(computedFingerprints))
      ) {
        invalid.push({
          directoryName: entry.name,
          directory,
          templateId: value.templateId,
          error: "registry component fingerprints do not match the verified stored files",
        });
        continue;
      }
      valid.push({
        template: value,
        directory,
        manifestSha256: sha256(manifestText),
        verifiedFileSetDigest: verifiedDescriptorDigest(value),
        fingerprints: computedFingerprints,
        legacy: !value.registry,
      });
    }
    valid.sort((left, right) => left.template.templateId.localeCompare(right.template.templateId));
    invalid.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
    return { valid, invalid };
  }

  async list(): Promise<LoadedTemplate[]> {
    const scan = await this.scanTemplates();
    return scan.valid.map(({ template, directory }) => ({ template, directory }));
  }

  async get(templateId: string) {
    return (await this.list()).find((item) => item.template.templateId === templateId);
  }

  private async directAlias(registrySourceId: string) {
    try {
      const lines = (await fs.readFile(path.join(this.root, "migrations", "aliases.jsonl"), "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean);
      for (const line of lines.reverse()) {
        const value = JSON.parse(line) as {
          adapter?: string;
          registrySourceId?: string;
          canonicalTemplateId?: string;
        };
        if (
          value.adapter === "direct" &&
          value.registrySourceId === registrySourceId &&
          value.canonicalTemplateId
        ) {
          return value.canonicalTemplateId;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return undefined;
  }

  private async preparedDirectPlan(input: UserTemplateImport) {
    const prepared = await prepareDirectImport(input);
    const registry = prepared.registry;
    if (!registry || registry.adapter !== "direct" || !registry.fingerprints) {
      throw new Error("direct import preparation did not produce a stable registry");
    }
    const scan = await this.scanTemplates({ verifyFiles: true });
    if (
      scan.invalid.some(
        (item) =>
          item.directoryName === prepared.templateId || item.directoryName === prepared.legacyTemplateId,
      )
    ) {
      throw new Error("direct import target collides with an invalid existing template directory");
    }
    const aliasedTemplateId = await this.directAlias(registry.sourceId);
    const matches = scan.valid
      .map((item) => {
        const kinds = componentMatchKinds(
          registry.fingerprints!,
          item.fingerprints,
          prepared.title,
          item.template.title,
        );
        if (
          item.template.registry?.adapter === "direct" &&
          item.template.registry.sourceId === registry.sourceId
        ) {
          kinds.unshift("same_source");
        }
        if (
          item.template.registry?.contentHash &&
          item.template.registry.contentHash === prepared.contentHash
        ) {
          kinds.push("same_content");
        }
        if (prepared.legacyTemplateId === item.template.templateId) kinds.push("legacy_template_id");
        if (aliasedTemplateId === item.template.templateId) kinds.unshift("source_alias");
        return { item, kinds: [...new Set(kinds)] };
      })
      .filter(({ kinds }) => kinds.length > 0);
    const sourceMatches = matches.filter(({ kinds }) => kinds.includes("same_source"));
    const aliasMatches = matches.filter(({ kinds }) => kinds.includes("source_alias"));
    if (sourceMatches.length > 1) {
      throw new Error(
        `direct source registry resolves to multiple templates: ${sourceMatches
          .map(({ item }) => item.template.templateId)
          .join(", ")}`,
      );
    }
    if (aliasMatches.length > 1) {
      throw new Error(
        `direct source alias resolves to multiple templates: ${aliasMatches
          .map(({ item }) => item.template.templateId)
          .join(", ")}`,
      );
    }
    if (
      sourceMatches[0] &&
      aliasMatches[0] &&
      sourceMatches[0].item.template.templateId !== aliasMatches[0].item.template.templateId
    ) {
      throw new Error(
        `direct source registry and alias disagree: ${sourceMatches[0].item.template.templateId}, ` +
          aliasMatches[0].item.template.templateId,
      );
    }
    const legacyMatch = matches.find(({ kinds }) => kinds.includes("legacy_template_id"));
    const registeredSourceMatch = sourceMatches[0];
    const aliasMatch = aliasMatches[0];
    const logical = registeredSourceMatch ?? aliasMatch ?? legacyMatch;
    const changes = logical ? changedFields(logical.item.template, prepared) : [];
    let action: DirectImportAction;
    let proposedTemplateId = prepared.templateId;
    if (registeredSourceMatch) {
      const existing = registeredSourceMatch;
      proposedTemplateId = existing.item.template.templateId;
      if (
        existing.item.template.registry?.contentHash === prepared.contentHash &&
        changes.length === 0
      ) {
        action = "unchanged";
      } else if (
        registry.identityMode === "content-addressed" ||
        hasStrongAssetContinuity(existing.kinds)
      ) {
        action = "update";
      } else {
        action = "source_conflict";
      }
    } else if (aliasMatch) {
      if (
        aliasMatch.item.fingerprints.fullAssetSha256 === registry.fingerprints.fullAssetSha256
      ) {
        // A reuse decision intentionally keeps the canonical template's metadata and registry.
        action = "unchanged";
        proposedTemplateId = aliasMatch.item.template.templateId;
      } else {
        // Replacing a reused source must branch away from the canonical template rather than
        // overwrite the canonical template owned by another Registry source.
        action = "source_conflict";
      }
    } else if (
      legacyMatch &&
      legacyMatch.item.fingerprints.fullAssetSha256 === registry.fingerprints.fullAssetSha256 &&
      changes.length === 0
    ) {
      action = "unchanged";
      proposedTemplateId = legacyMatch.item.template.templateId;
    } else if (matches.some(({ kinds }) => kinds.includes("same_full_asset"))) {
      action = "duplicate_candidate";
    } else {
      action = "create";
    }
    const publicMatches: DirectImportMatch[] = matches
      .map(({ item, kinds }) => ({
        templateId: item.template.templateId,
        title: item.template.title,
        matchKinds: kinds,
        manifestSha256: item.manifestSha256,
      }))
      .sort((left, right) => left.templateId.localeCompare(right.templateId));
    const planPayload = {
      action,
      normalizedTitle: prepared.title,
      proposedTemplateId,
      registrySourceId: registry.sourceId,
      identityMode: registry.identityMode ?? "content-addressed",
      fingerprints: registry.fingerprints,
      contentHash: prepared.contentHash,
      changes,
      matches: publicMatches,
    };
    const plan: DirectImportPlan = {
      ...planPayload,
      planDigest: sha256(JSON.stringify(comparable(planPayload))),
      written: false,
    };
    return { prepared, plan, scan };
  }

  async planDirectImport(input: UserTemplateImport) {
    return (await this.preparedDirectPlan(input)).plan;
  }

  private async appendAlias(record: {
    operationId: string;
    adapter: "direct";
    registrySourceId: string;
    canonicalTemplateId: string;
    reason: string;
  }) {
    const directory = path.join(this.root, "migrations");
    await fs.mkdir(directory, { recursive: true });
    await fs.appendFile(
      path.join(directory, "aliases.jsonl"),
      `${JSON.stringify({ ...record, createdAt: new Date().toISOString() })}\n`,
    );
  }

  private async appendDuplicateDecision(record: {
    operationId: string;
    registrySourceId: string;
    templateId: string;
    duplicateOf: string[];
    reason: string;
  }) {
    const directory = path.join(this.root, "migrations");
    await fs.mkdir(directory, { recursive: true });
    await fs.appendFile(
      path.join(directory, "duplicate-decisions.jsonl"),
      `${JSON.stringify({ ...record, createdAt: new Date().toISOString() })}\n`,
    );
  }

  private async appendSourceConflictDecision(record: {
    operationId: string;
    registrySourceId: string;
    templateId: string;
    reason: string;
  }) {
    const directory = path.join(this.root, "migrations");
    await fs.mkdir(directory, { recursive: true });
    await fs.appendFile(
      path.join(directory, "source-conflict-decisions.jsonl"),
      `${JSON.stringify({ ...record, createdAt: new Date().toISOString() })}\n`,
    );
  }

  async applyDirectImport(input: DirectImportApplyInput) {
    return this.withWriteLock(`direct-apply:${input.operationId}`, async () => {
      const {
        planDigest,
        expectedAction,
        expectedTemplateId,
        operationId,
        duplicateResolution,
        sourceConflictResolution,
        ...direct
      } = input;
      const { prepared, plan } = await this.preparedDirectPlan(direct);
      if (
        expectedAction === "create" &&
        plan.action === "unchanged" &&
        plan.proposedTemplateId === expectedTemplateId
      ) {
        const existing = await this.get(expectedTemplateId);
        if (!existing) throw new Error("safe replay target disappeared");
        return { ...existing, action: "unchanged" as const, replayed: true, plan };
      }
      if (plan.planDigest !== planDigest) {
        throw new Error("stale import plan: input files or user-library state changed");
      }
      if (plan.action !== expectedAction || plan.proposedTemplateId !== expectedTemplateId) {
        throw new Error("stale import plan: expected action or template ID changed");
      }
      if (plan.action === "unchanged") {
        const existing = await this.get(expectedTemplateId);
        if (!existing) throw new Error("unchanged import target disappeared");
        return { ...existing, action: "unchanged" as const, replayed: false, plan };
      }
      if (plan.action === "duplicate_candidate") {
        if (!duplicateResolution) {
          throw new Error("duplicate candidate requires an explicit reuse or create_separate decision");
        }
        if (!duplicateResolution.reason.trim()) throw new Error("duplicate decision requires a reason");
        if (duplicateResolution.action === "reuse") {
          const canonical = await this.get(duplicateResolution.templateId);
          if (
            !canonical ||
            !plan.matches.some((item) => item.templateId === duplicateResolution.templateId)
          ) {
            throw new Error("reuse target is not one of the planned duplicate matches");
          }
          await this.appendAlias({
            operationId,
            adapter: "direct",
            registrySourceId: plan.registrySourceId,
            canonicalTemplateId: canonical.template.templateId,
            reason: duplicateResolution.reason.trim(),
          });
          return {
            ...canonical,
            action: "reused" as const,
            replayed: false,
            plan,
          };
        }
      }
      if (plan.action === "source_conflict") {
        if (
          sourceConflictResolution?.action !== "replace_source" ||
          !sourceConflictResolution.reason.trim()
        ) {
          throw new Error("source conflict requires an explicit replace_source decision and reason");
        }
      }
      const createSeparate =
        plan.action === "duplicate_candidate" &&
        duplicateResolution?.action === "create_separate";
      const aliasBreakout =
        plan.action === "source_conflict" &&
        plan.matches.some((item) => item.matchKinds.includes("source_alias")) &&
        !plan.matches.some((item) => item.matchKinds.includes("same_source"));
      if (aliasBreakout && sourceConflictResolution) {
        await this.appendAlias({
          operationId,
          adapter: "direct",
          registrySourceId: plan.registrySourceId,
          canonicalTemplateId: prepared.templateId,
          reason: sourceConflictResolution.reason.trim(),
        });
      }
      const result = await this.applyPrepared(
        createSeparate || aliasBreakout ? { ...prepared, legacyTemplateId: undefined } : prepared,
        true,
      );
      if (plan.action === "duplicate_candidate" && duplicateResolution?.action === "create_separate") {
        await this.appendDuplicateDecision({
          operationId,
          registrySourceId: plan.registrySourceId,
          templateId: result.template.templateId,
          duplicateOf: plan.matches.map((item) => item.templateId),
          reason: duplicateResolution.reason.trim(),
        });
      }
      if (plan.action === "source_conflict" && sourceConflictResolution) {
        await this.appendSourceConflictDecision({
          operationId,
          registrySourceId: plan.registrySourceId,
          templateId: result.template.templateId,
          reason: sourceConflictResolution.reason.trim(),
        });
      }
      return { ...result, replayed: false, plan };
    });
  }

  async importTemplate(input: UserTemplateImport) {
    return this.withWriteLock("direct-import", async () =>
      this.applyPrepared(await prepareDirectImport(input), false),
    );
  }

  async importTransferPackage(packagePath: string) {
    return this.withWriteLock("transfer-import", async () =>
      this.applyPrepared(await prepareTransferPackage(packagePath), false),
    );
  }

  private async findPrepared(prepared: PreparedTemplate) {
    const templates = await this.list();
    const registry = prepared.registry;
    const byRegistry = registry
      ? templates.find(
          ({ template }) =>
            template.registry?.adapter === registry.adapter &&
            template.registry.sourceId === registry.sourceId,
        )
      : undefined;
    const byId = templates.find(
      ({ template }) =>
        template.templateId === prepared.templateId ||
        (prepared.legacyTemplateId !== undefined && template.templateId === prepared.legacyTemplateId),
    );
    if (byRegistry && byId && byRegistry.directory !== byId.directory) {
      throw new Error(`import registry conflict for ${prepared.registry?.sourceId}`);
    }
    const existing = byRegistry ?? byId;
    if (
      existing &&
      prepared.registry &&
      existing.template.registry &&
      (existing.template.registry.adapter !== prepared.registry.adapter ||
        existing.template.registry.sourceId !== prepared.registry.sourceId)
    ) {
      throw new Error(`template ID collision: ${prepared.templateId}`);
    }
    return existing;
  }

  private async diffPrepared(prepared: PreparedTemplate): Promise<ImportDiff> {
    if (!prepared.registry) throw new Error("diff requires a Gallery or Transfer Package source");
    const existing = await this.findPrepared(prepared);
    const changes = existing ? changedFields(existing.template, prepared) : [];
    const unchanged =
      existing &&
      existing.template.registry?.contentHash === prepared.contentHash &&
      existing.template.registry.sourceCommit === prepared.registry.sourceCommit &&
      changes.length === 0;
    return {
      action: existing ? (unchanged ? "unchanged" : "update") : "create",
      adapter: prepared.registry.adapter,
      sourceId: prepared.registry.sourceId,
      galleryId: prepared.registry.galleryId,
      templateId: existing?.template.templateId ?? prepared.templateId,
      incomingContentHash: prepared.contentHash,
      existingContentHash: existing?.template.registry?.contentHash,
      sourceCommit: prepared.registry.sourceCommit,
      reviewStatus: prepared.reviewStatus,
      changes,
    };
  }

  async diffImportSource(input: ImportSourceInput) {
    return this.diffPrepared(await prepareImportSource(input));
  }

  async upsertImportSource(input: ImportSourceInput) {
    return this.withWriteLock("source-upsert", async () =>
      this.applyPrepared(await prepareImportSource(input), true),
    );
  }

  private async writePrepared(prepared: PreparedTemplate, existing?: LoadedTemplate) {
    const target = existing?.directory ?? path.join(this.templatesDirectory, prepared.templateId);
    if (!existing) {
      try {
        await fs.access(target);
        throw new Error(`template target already exists but is invalid: ${target}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    await fs.mkdir(this.templatesDirectory, { recursive: true });
    const staging = path.join(this.templatesDirectory, `.import-${randomUUID()}`);
    await fs.mkdir(staging);
    const now = new Date().toISOString();
    const template: UserTemplate = {
      schema: "figure-library.template.v1",
      templateId: existing?.template.templateId ?? prepared.templateId,
      sourceId: "user",
      title: prepared.title,
      description: prepared.description,
      tags: prepared.tags,
      visualProfile: prepared.visualProfile,
      dataProfile: prepared.dataProfile,
      packages: prepared.packages,
      license: prepared.license,
      importedAt: existing?.template.importedAt ?? now,
      updatedAt: existing ? now : undefined,
      archivedAt: prepared.reviewStatus === "archived" ? now : undefined,
      assetKind: prepared.assetKind,
      language: prepared.language,
      plotFamily: prepared.plotFamily,
      reviewStatus: prepared.reviewStatus,
      codeStatus: prepared.codeStatus,
      provenance: prepared.provenance,
      registry: prepared.registry
        ? {
            ...prepared.registry,
            templateId: existing?.template.templateId ?? prepared.templateId,
          }
        : undefined,
      preview: prepared.preview?.stored,
      code: prepared.code.map((item) => item.stored),
      references: prepared.references.map((item) => item.stored),
    };
    try {
      const allFiles = [
        ...(prepared.preview ? [prepared.preview] : []),
        ...prepared.code,
        ...prepared.references,
      ];
      const used = new Set<string>();
      for (const item of allFiles) {
        const key = item.stored.file.toLocaleLowerCase();
        if (used.has(key)) throw new Error(`duplicate stored reference: ${item.stored.file}`);
        used.add(key);
        const output = resolveStoredFile(staging, item.stored.file);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, item.bytes);
      }
      await fs.writeFile(
        path.join(staging, "template.json"),
        `${JSON.stringify(template, null, 2)}\n`,
      );

      if (!existing) {
        await fs.rename(staging, target);
      } else {
        const backup = path.join(this.templatesDirectory, `.replace-${randomUUID()}`);
        await fs.rename(target, backup);
        try {
          await fs.rename(staging, target);
        } catch (error) {
          await fs.rename(backup, target);
          throw error;
        }
        await fs.rm(backup, { recursive: true, force: true });
      }
      return { template, directory: target };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async replaceManifest(directory: string, template: UserTemplate) {
    const temporary = path.join(directory, `.template-${randomUUID()}.json`);
    const manifest = path.join(directory, "template.json");
    const backup = path.join(directory, `.template-backup-${randomUUID()}.json`);
    await fs.writeFile(temporary, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
    try {
      await fs.rename(manifest, backup);
      try {
        await fs.rename(temporary, manifest);
      } catch (error) {
        await fs.rename(backup, manifest);
        throw error;
      }
      await fs.rm(backup, { force: true });
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  private async applyPrepared(prepared: PreparedTemplate, allowUpdate: boolean) {
    const existing = await this.findPrepared(prepared);
    if (
      prepared.registry?.adapter === "direct" &&
      existing &&
      !existing.template.registry &&
      changedFields(existing.template, prepared).length === 0 &&
      templateFingerprints(existing.template).fullAssetSha256 ===
        prepared.registry.fingerprints?.fullAssetSha256
    ) {
      return {
        template: existing.template,
        directory: existing.directory,
        existed: true,
        action: "unchanged" as const,
      };
    }
    if (!prepared.registry && existing) {
      return {
        template: existing.template,
        directory: existing.directory,
        existed: true,
        action: "unchanged" as const,
      };
    }
    const diff = prepared.registry ? await this.diffPrepared(prepared) : undefined;
    if (diff?.action === "unchanged" && existing) {
      return {
        template: existing.template,
        directory: existing.directory,
        existed: true,
        action: "unchanged" as const,
        diff,
      };
    }
    if (diff?.action === "update" && !allowUpdate) {
      throw new Error(
        `source content changed for ${diff.sourceId}; inspect figure_library_diff and use ` +
          "figure_library_upsert to apply it",
      );
    }
    const written = await this.writePrepared(prepared, existing);
    return {
      ...written,
      existed: Boolean(existing),
      action: existing ? ("update" as const) : ("create" as const),
      diff,
    };
  }

  async syncGallery(options: GallerySyncOptions) {
    if (options.dryRun) return this.syncGalleryUnlocked(options);
    return this.withWriteLock("gallery-sync", async () => this.syncGalleryUnlocked(options));
  }

  private async syncGalleryUnlocked(options: GallerySyncOptions) {
    const entries = await discoverGalleryEntries(options.galleryDirectory);
    const results: ImportDiff[] = [];
    for (const entry of entries) {
      const prepared = await prepareGalleryEntry(entry, options.sourceCommit);
      let diff = await this.diffPrepared(prepared);
      if (!matchesPreparedFilters(prepared, options)) {
        diff = { ...diff, action: "skipped", reason: "does not match sync filters" };
      } else if (prepared.reviewStatus === "draft") {
        diff = { ...diff, action: "skipped", reason: "draft Gallery entries are not synchronized" };
      } else if (prepared.reviewStatus === "archived" && diff.action === "create") {
        diff = { ...diff, action: "skipped", reason: "archive has no imported template to update" };
      } else if (!options.dryRun && diff.action !== "unchanged") {
        await this.applyPrepared(prepared, true);
      }
      results.push(diff);
    }
    return {
      galleryDirectory: path.resolve(options.galleryDirectory),
      dryRun: options.dryRun,
      entries: results.length,
      create: results.filter((item) => item.action === "create").length,
      update: results.filter((item) => item.action === "update").length,
      unchanged: results.filter((item) => item.action === "unchanged").length,
      skipped: results.filter((item) => item.action === "skipped").length,
      results,
    };
  }

  async resolveTemplateReference(reference: {
    templateId?: string;
    galleryId?: string;
    registrySourceId?: string;
    adapter?: ImportAdapter;
  }) {
    const kinds = [reference.templateId, reference.galleryId, reference.registrySourceId].filter(
      (value) => value !== undefined,
    );
    if (kinds.length !== 1) {
      throw new Error("provide exactly one of templateId, galleryId, or registrySourceId + adapter");
    }
    if (reference.registrySourceId && !reference.adapter) {
      throw new Error("adapter is required with registrySourceId");
    }
    const matches = (await this.list()).filter(({ template }) => {
      if (reference.templateId) return template.templateId === reference.templateId;
      if (reference.galleryId) return template.registry?.galleryId === reference.galleryId;
      return (
        template.registry?.adapter === reference.adapter &&
        template.registry?.sourceId === reference.registrySourceId
      );
    });
    if (matches.length === 0) {
      throw new Error(
        "unknown template reference; accepted references are templateId, galleryId, or registrySourceId + adapter",
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `template reference is ambiguous: ${matches.map((item) => item.template.templateId).join(", ")}`,
      );
    }
    return matches[0]!;
  }

  async archiveTemplate(reference: {
    templateId?: string;
    galleryId?: string;
    registrySourceId?: string;
    adapter?: ImportAdapter;
  }) {
    return this.withWriteLock("template-archive", async () => {
      const loaded = await this.resolveTemplateReference(reference);
      const previousReviewStatus = loaded.template.reviewStatus ?? "approved";
      if (previousReviewStatus === "archived") {
        return {
          template: loaded.template,
          directory: loaded.directory,
          previousReviewStatus,
          changed: false,
          alreadyArchived: true,
          filesRetained: true as const,
        };
      }
      const now = new Date().toISOString();
      const template: UserTemplate = {
        ...loaded.template,
        reviewStatus: "archived",
        archivedAt: now,
        updatedAt: now,
      };
      await this.replaceManifest(loaded.directory, template);
      return {
        template,
        directory: loaded.directory,
        previousReviewStatus,
        changed: true,
        alreadyArchived: false,
        filesRetained: true as const,
      };
    });
  }

  async archiveGallery(galleryId: string) {
    const result = await this.archiveTemplate({ galleryId });
    return { ...result, existed: result.alreadyArchived };
  }

  async auditTemplates(options: {
    scope?: "duplicates" | "legacy" | "integrity" | "all";
    includeArchived?: boolean;
  } = {}) {
    const scope = options.scope ?? "all";
    const includeArchived = options.includeArchived ?? true;
    const scan = await this.scanTemplates({ verifyFiles: true });
    const visible = scan.valid.filter(
      (item) => includeArchived || (item.template.reviewStatus ?? "approved") !== "archived",
    );
    const nodes = visible.map((item) => ({
      templateId: item.template.templateId,
      title: item.template.title,
      reviewStatus: item.template.reviewStatus ?? "approved",
      codeStatus: item.template.codeStatus ?? (item.template.code.length ? "reviewed" : "none"),
      importedAt: item.template.importedAt,
      adapter: item.template.registry?.adapter,
      registrySourceId: item.template.registry?.sourceId,
      galleryId: item.template.registry?.galleryId,
      identityMode: item.template.registry?.identityMode,
      contentHash: item.template.registry?.contentHash,
      fingerprints: item.fingerprints,
      manifestSha256: item.manifestSha256,
      verifiedFileSetDigest: item.verifiedFileSetDigest,
      integrityStatus: "valid" as const,
      legacy: item.legacy,
      management: managementReference(item.template),
      metadataCompleteness: [
        item.template.title,
        item.template.description,
        item.template.visualProfile,
        item.template.dataProfile,
        item.template.license,
        item.template.provenance,
      ].filter(Boolean).length,
    }));
    const edges: Array<{ left: string; right: string; matchKinds: string[] }> = [];
    for (let leftIndex = 0; leftIndex < visible.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < visible.length; rightIndex += 1) {
        const left = visible[leftIndex]!;
        const right = visible[rightIndex]!;
        const kinds = componentMatchKinds(
          left.fingerprints,
          right.fingerprints,
          left.template.title,
          right.template.title,
        );
        if (
          left.template.registry &&
          right.template.registry &&
          left.template.registry.adapter === right.template.registry.adapter &&
          left.template.registry.sourceId === right.template.registry.sourceId
        ) {
          kinds.unshift("same_source");
        }
        if (
          left.template.registry?.contentHash &&
          left.template.registry.contentHash === right.template.registry?.contentHash
        ) {
          kinds.push("same_content");
        }
        if (kinds.length) {
          edges.push({
            left: left.template.templateId,
            right: right.template.templateId,
            matchKinds: [...new Set(kinds)],
          });
        }
      }
    }
    const parent = new Map(nodes.map((node) => [node.templateId, node.templateId]));
    const find = (id: string): string => {
      const current = parent.get(id) ?? id;
      if (current === id) return id;
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    const union = (left: string, right: string) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };
    for (const edge of edges) {
      if (
        edge.matchKinds.some((kind) => kind === "same_source" || kind === "same_content") ||
        hasStrongAssetContinuity(edge.matchKinds)
      ) {
        union(edge.left, edge.right);
      }
    }
    const grouped = new Map<string, typeof nodes>();
    for (const node of nodes) {
      const root = find(node.templateId);
      grouped.set(root, [...(grouped.get(root) ?? []), node]);
    }
    const duplicateGroups = [...grouped.values()]
      .filter((group) => group.length > 1)
      .map((group) => {
        const templateIds = new Set(group.map((node) => node.templateId));
        const groupEdges = edges.filter(
          (edge) => templateIds.has(edge.left) && templateIds.has(edge.right),
        );
        const stableRegistry = (node: (typeof group)[number]) =>
          Boolean(
            node.registrySourceId &&
              (node.adapter !== "direct" || node.identityMode === "stable-source"),
          );
        const recommendation = [...group].sort(
          (left, right) =>
            Number(left.reviewStatus === "archived") - Number(right.reviewStatus === "archived") ||
            Number(!stableRegistry(left)) - Number(!stableRegistry(right)) ||
            Number(!left.registrySourceId) - Number(!right.registrySourceId) ||
            Number(left.codeStatus !== "reviewed") - Number(right.codeStatus !== "reviewed") ||
            right.metadataCompleteness - left.metadataCompleteness ||
            left.importedAt.localeCompare(right.importedAt) ||
            left.templateId.localeCompare(right.templateId),
        )[0]!;
        return {
          groupId: sha256([...templateIds].sort().join("\n")).slice(0, 16),
          templateIds: [...templateIds].sort(),
          evidence: groupEdges,
          recommendedCanonicalTemplateId: recommendation.templateId,
          recommendationOnly: true as const,
        };
      })
      .sort((left, right) => left.groupId.localeCompare(right.groupId));
    return {
      scope,
      includeArchived,
      libraryDirectory: this.root,
      userTemplateCount: nodes.length,
      legacyTemplateCount: nodes.filter((node) => node.legacy).length,
      invalidTemplateCount: scan.invalid.length,
      duplicateGroupCount: duplicateGroups.length,
      invalid: scope === "duplicates" || scope === "legacy" ? [] : scan.invalid,
      templates:
        scope === "legacy"
          ? nodes.filter((node) => node.legacy)
          : scope === "integrity"
            ? []
            : nodes,
      duplicateGroups:
        scope === "legacy" || scope === "integrity" ? [] : duplicateGroups,
    };
  }

  private async writeJournal(directory: string, value: unknown) {
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, "journal.json");
    const temporary = path.join(directory, `.journal-${randomUUID()}.json`);
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporary, target);
  }

  private async validateReconcile(input: ReconcileInput) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(input.reconcileId)) {
      throw new Error("reconcileId must be a portable 1-100 character identifier");
    }
    if (!input.reason.trim()) throw new Error("reconcile requires a non-empty reason");
    const duplicateIds = [...new Set(input.duplicateTemplateIds)];
    if (duplicateIds.length === 0 || duplicateIds.length !== input.duplicateTemplateIds.length) {
      throw new Error("duplicateTemplateIds must be a non-empty unique list");
    }
    if (duplicateIds.includes(input.canonicalTemplateId)) {
      throw new Error("canonicalTemplateId cannot also be a duplicate");
    }
    const scan = await this.scanTemplates({ verifyFiles: true });
    const byId = new Map(scan.valid.map((item) => [item.template.templateId, item]));
    const ids = [input.canonicalTemplateId, ...duplicateIds];
    for (const templateId of ids) {
      const item = byId.get(templateId);
      if (!item) throw new Error(`reconcile template is missing or invalid: ${templateId}`);
      const expected = input.expectedState[templateId];
      if (!expected) throw new Error(`expectedState is missing ${templateId}`);
      if (
        item.manifestSha256 !== expected.manifestSha256 ||
        item.verifiedFileSetDigest !== expected.verifiedFileSetDigest ||
        (item.template.reviewStatus ?? "approved") !== expected.reviewStatus
      ) {
        throw new Error(`stale reconcile state for ${templateId}`);
      }
    }
    const audit = await this.auditTemplates({ scope: "duplicates", includeArchived: true });
    const planned = new Set(ids);
    const oneGroup = audit.duplicateGroups.some((group) =>
      [...planned].every((templateId) => group.templateIds.includes(templateId)),
    );
    if (!oneGroup) {
      throw new Error("reconcile templates are not connected by audit duplicate evidence");
    }
    return { scan, byId, duplicateIds };
  }

  async reconcileTemplates(input: ReconcileInput) {
    const mode = input.mode ?? "dry-run";
    if (mode === "rollback") return this.rollbackReconcile(input);
    const validated = await this.validateReconcile(input);
    const changes = validated.duplicateIds.map((templateId) => {
      const item = validated.byId.get(templateId)!;
      return {
        templateId,
        beforeReviewStatus: item.template.reviewStatus ?? "approved",
        afterReviewStatus: "archived" as const,
        retainedFiles:
          Number(Boolean(item.template.preview)) +
          item.template.code.length +
          (item.template.references ?? []).length,
      };
    });
    const plan = {
      reconcileId: input.reconcileId,
      mode,
      strategy: input.strategy,
      canonicalTemplateId: input.canonicalTemplateId,
      duplicateTemplateIds: validated.duplicateIds,
      changes,
      filesRetained: changes.reduce((sum, item) => sum + item.retainedFiles, 0),
      written: false,
    };
    if (mode === "dry-run") return plan;
    return this.withWriteLock(`reconcile:${input.reconcileId}`, async () => {
      const current = await this.validateReconcile(input);
      const transactionDirectory = path.join(this.transactionsDirectory, input.reconcileId);
      try {
        await fs.access(transactionDirectory);
        throw new Error(`reconcile transaction already exists: ${input.reconcileId}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const now = new Date().toISOString();
      const entries = await Promise.all(
        current.duplicateIds.map(async (templateId) => {
          const item = current.byId.get(templateId)!;
          const beforeManifest = await fs.readFile(
            path.join(item.directory, "template.json"),
            "utf8",
          );
          const afterTemplate: UserTemplate = {
            ...item.template,
            reviewStatus: "archived",
            archivedAt: now,
            updatedAt: now,
          };
          const afterManifest = `${JSON.stringify(afterTemplate, null, 2)}\n`;
          return {
            templateId,
            directory: item.directory,
            beforeManifest,
            beforeManifestSha256: sha256(beforeManifest),
            afterManifest,
            afterManifestSha256: sha256(afterManifest),
          };
        }),
      );
      const journal = {
        schema: "figure-library.reconcile-transaction.v1",
        reconcileId: input.reconcileId,
        status: "prepared",
        canonicalTemplateId: input.canonicalTemplateId,
        duplicateTemplateIds: current.duplicateIds,
        strategy: input.strategy,
        reason: input.reason.trim(),
        createdAt: now,
        entries,
      };
      await this.writeJournal(transactionDirectory, journal);
      const applied: typeof entries = [];
      const ledgerDirectory = path.join(this.root, "migrations", "reconciliations");
      const ledgerFile = path.join(ledgerDirectory, `${input.reconcileId}.json`);
      let ledgerCreated = false;
      try {
        journal.status = "committing";
        await this.writeJournal(transactionDirectory, journal);
        for (const entry of entries) {
          await this.replaceManifest(entry.directory, JSON.parse(entry.afterManifest) as UserTemplate);
          applied.push(entry);
        }
        await fs.mkdir(ledgerDirectory, { recursive: true });
        await fs.writeFile(
          ledgerFile,
          `${JSON.stringify(
            {
              schema: "figure-library.reconcile-ledger.v1",
              reconcileId: input.reconcileId,
              canonicalTemplateId: input.canonicalTemplateId,
              aliases: current.duplicateIds.map((templateId) => ({
                templateId,
                canonicalTemplateId: input.canonicalTemplateId,
              })),
              reason: input.reason.trim(),
              committedAt: new Date().toISOString(),
              entries: entries.map(({ templateId, beforeManifestSha256, afterManifestSha256 }) => ({
                templateId,
                beforeManifestSha256,
                afterManifestSha256,
              })),
            },
            null,
            2,
          )}\n`,
          { flag: "wx" },
        );
        ledgerCreated = true;
        journal.status = "committed";
        await this.writeJournal(transactionDirectory, journal);
      } catch (error) {
        let rollbackError: unknown;
        for (const entry of [...applied].reverse()) {
          try {
            await this.replaceManifest(
              entry.directory,
              JSON.parse(entry.beforeManifest) as UserTemplate,
            );
          } catch (restoreError) {
            rollbackError ??= restoreError;
          }
        }
        if (ledgerCreated) {
          try {
            await fs.rm(ledgerFile);
          } catch (removeError) {
            rollbackError ??= removeError;
          }
        }
        if (!rollbackError) {
          journal.status = "rolled-back";
          try {
            await this.writeJournal(transactionDirectory, journal);
          } catch (journalError) {
            rollbackError = journalError;
          }
        }
        if (rollbackError) {
          throw new Error(
            `reconcile failed and automatic recovery also failed: ${String(error)}; ${String(rollbackError)}`,
          );
        }
        throw error;
      }
      return { ...plan, mode: "apply" as const, written: true };
    });
  }

  private async rollbackReconcile(input: ReconcileInput) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(input.reconcileId)) {
      throw new Error("reconcileId must be a portable 1-100 character identifier");
    }
    if (!input.reason.trim()) throw new Error("rollback requires a non-empty reason");
    return this.withWriteLock(
      `reconcile-rollback:${input.reconcileId}`,
      async () => {
        const transactionDirectory = path.join(this.transactionsDirectory, input.reconcileId);
        const journal = JSON.parse(
          await fs.readFile(path.join(transactionDirectory, "journal.json"), "utf8"),
        ) as {
          schema?: string;
          reconcileId?: string;
          status: string;
          canonicalTemplateId: string;
          duplicateTemplateIds: string[];
          entries: Array<{
            templateId: string;
            directory: string;
            beforeManifest: string;
            beforeManifestSha256: string;
            afterManifest: string;
            afterManifestSha256: string;
          }>;
        };
        if (
          journal.schema !== "figure-library.reconcile-transaction.v1" ||
          journal.reconcileId !== input.reconcileId ||
          !Array.isArray(journal.entries)
        ) {
          throw new Error(`reconcile ${input.reconcileId} has an invalid recovery journal`);
        }
        const recoverableStatuses = new Set(["prepared", "committing", "committed", "rolling-back"]);
        if (!recoverableStatuses.has(journal.status)) {
          throw new Error(`reconcile ${input.reconcileId} is not recoverable from ${journal.status}`);
        }
        const recoveredIncomplete = journal.status !== "committed";
        if (
          journal.canonicalTemplateId !== input.canonicalTemplateId ||
          JSON.stringify([...journal.duplicateTemplateIds].sort()) !==
            JSON.stringify([...new Set(input.duplicateTemplateIds)].sort())
        ) {
          throw new Error("rollback request does not match the reconcile transaction journal");
        }

        const journalEntryIds = journal.entries.map((entry) => entry.templateId);
        if (
          new Set(journalEntryIds).size !== journalEntryIds.length ||
          JSON.stringify([...journalEntryIds].sort()) !==
            JSON.stringify([...journal.duplicateTemplateIds].sort())
        ) {
          throw new Error(`reconcile ${input.reconcileId} has inconsistent journal entries`);
        }
        for (const entry of journal.entries) {
          const expectedDirectory = path.join(this.templatesDirectory, entry.templateId);
          if (path.resolve(entry.directory) !== path.resolve(expectedDirectory)) {
            throw new Error(`reconcile journal has an unsafe template directory: ${entry.templateId}`);
          }
          if (
            sha256(entry.beforeManifest) !== entry.beforeManifestSha256 ||
            sha256(entry.afterManifest) !== entry.afterManifestSha256
          ) {
            throw new Error(`reconcile journal manifest hash mismatch: ${entry.templateId}`);
          }
          let before: unknown;
          let after: unknown;
          try {
            before = JSON.parse(entry.beforeManifest) as unknown;
            after = JSON.parse(entry.afterManifest) as unknown;
          } catch {
            throw new Error(`reconcile journal contains invalid manifest JSON: ${entry.templateId}`);
          }
          if (
            !isUserTemplate(before) ||
            !isUserTemplate(after) ||
            before.templateId !== entry.templateId ||
            after.templateId !== entry.templateId
          ) {
            throw new Error(`reconcile journal contains invalid template manifests: ${entry.templateId}`);
          }
        }

        const currentHashes = new Map<string, string>();
        for (const entry of journal.entries) {
          const directoryStat = await fs.lstat(entry.directory);
          const manifestPath = path.join(entry.directory, "template.json");
          const manifestStat = await fs.lstat(manifestPath);
          if (
            directoryStat.isSymbolicLink() ||
            !directoryStat.isDirectory() ||
            manifestStat.isSymbolicLink() ||
            !manifestStat.isFile()
          ) {
            throw new Error(`rollback target is not a regular template: ${entry.templateId}`);
          }
          const current = await fs.readFile(manifestPath, "utf8");
          const currentHash = sha256(current);
          const allowed = recoveredIncomplete
            ? [entry.beforeManifestSha256, entry.afterManifestSha256]
            : [entry.afterManifestSha256];
          if (!allowed.includes(currentHash)) {
            throw new Error(`rollback would overwrite later changes to ${entry.templateId}`);
          }
          currentHashes.set(entry.templateId, currentHash);
        }

        const ledgerDirectory = path.join(this.root, "migrations", "reconciliations");
        const applyLedger = path.join(ledgerDirectory, `${input.reconcileId}.json`);
        const rollbackLedger = path.join(ledgerDirectory, `${input.reconcileId}.rollback.json`);
        let incompleteApplyLedger: string | undefined;
        if (recoveredIncomplete) {
          try {
            incompleteApplyLedger = await fs.readFile(applyLedger, "utf8");
            const parsed = JSON.parse(incompleteApplyLedger) as {
              schema?: string;
              reconcileId?: string;
            };
            if (
              parsed.schema !== "figure-library.reconcile-ledger.v1" ||
              parsed.reconcileId !== input.reconcileId
            ) {
              throw new Error(`incomplete reconcile has an unrelated ledger: ${input.reconcileId}`);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            incompleteApplyLedger = undefined;
          }
        }
        try {
          await fs.access(rollbackLedger);
          throw new Error(`reconcile rollback record already exists: ${input.reconcileId}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        journal.status = "rolling-back";
        await this.writeJournal(transactionDirectory, journal);
        const restored: typeof journal.entries = [];
        let applyLedgerRemoved = false;
        let rollbackLedgerCreated = false;
        try {
          for (const entry of journal.entries) {
            if (currentHashes.get(entry.templateId) === entry.beforeManifestSha256) continue;
            await this.replaceManifest(
              entry.directory,
              JSON.parse(entry.beforeManifest) as UserTemplate,
            );
            restored.push(entry);
          }
          if (incompleteApplyLedger !== undefined) {
            await fs.rm(applyLedger);
            applyLedgerRemoved = true;
          }
          await fs.mkdir(ledgerDirectory, { recursive: true });
          await fs.writeFile(
            rollbackLedger,
            `${JSON.stringify(
              {
                schema: "figure-library.reconcile-rollback.v1",
                reconcileId: input.reconcileId,
                recoveredIncomplete,
                rolledBackAt: new Date().toISOString(),
                reason: input.reason.trim(),
              },
              null,
              2,
            )}\n`,
            { flag: "wx" },
          );
          rollbackLedgerCreated = true;
          journal.status = "rolled-back";
          await this.writeJournal(transactionDirectory, journal);
        } catch (error) {
          let recoveryError: unknown;
          for (const entry of [...restored].reverse()) {
            try {
              await this.replaceManifest(
                entry.directory,
                JSON.parse(entry.afterManifest) as UserTemplate,
              );
            } catch (restoreError) {
              recoveryError ??= restoreError;
            }
          }
          if (applyLedgerRemoved && incompleteApplyLedger !== undefined) {
            try {
              await fs.writeFile(applyLedger, incompleteApplyLedger, { flag: "wx" });
            } catch (ledgerRestoreError) {
              recoveryError ??= ledgerRestoreError;
            }
          }
          if (rollbackLedgerCreated) {
            try {
              await fs.rm(rollbackLedger);
            } catch (removeError) {
              recoveryError ??= removeError;
            }
          }
          if (!recoveryError) {
            journal.status = recoveredIncomplete ? "committing" : "committed";
            try {
              await this.writeJournal(transactionDirectory, journal);
            } catch (journalError) {
              recoveryError = journalError;
            }
          }
          if (recoveryError) {
            throw new Error(
              `reconcile rollback failed and restoring the prior state also failed: ${String(error)}; ${String(recoveryError)}`,
            );
          }
          throw error;
        }
        return {
          reconcileId: input.reconcileId,
          mode: "rollback" as const,
          canonicalTemplateId: input.canonicalTemplateId,
          restoredTemplateIds: journal.entries.map((entry) => entry.templateId),
          recoveredIncomplete,
          written: true,
        };
      },
      { allowIncompleteTransaction: input.reconcileId },
    );
  }

  async search(request: SearchRequest): Promise<TemplateCandidate[]> {
    const limit = Math.min(Math.max(request.limit ?? 6, 1), 12);
    const intent = buildSearchIntent(request);
    const scored = (await this.list())
      .filter(({ template }) => matchesTemplateFilters(template, request))
      .map(({ template, directory }) => {
        const evidence = scoreSearchableTemplate(
          {
            templateId: template.templateId,
            title: template.title,
            description: template.description,
            application: template.visualProfile,
            dataProfile: template.dataProfile,
            inputFiles: (template.references ?? [])
              .filter((file) => file.role === "data")
              .map((file) => path.posix.basename(file.file)),
            codeFiles: template.code.map((file) => path.posix.basename(file.file)),
            packages: template.packages,
            tags: template.tags,
          },
          intent,
        );
        return { template, directory, evidence };
      });
    const ranked = scored
      .filter((item) => item.evidence.score > 0)
      .sort(
        (left, right) =>
          right.evidence.score - left.evidence.score ||
          left.template.templateId.localeCompare(right.template.templateId),
      )
      .slice(0, limit);

    return ranked.map(({ template, evidence }) => userCandidate(template, evidence));
  }

  async preview(templateId: string) {
    const loaded = await this.get(templateId);
    const stored = loaded?.template.preview;
    if (!loaded || !stored || !EMBEDDABLE_IMAGE_TYPES.has(stored.mediaType)) return;
    return {
      bytes: await checkedStoredBytes(loaded.directory, stored, MAX_IMAGE_BYTES),
      extension: path.extname(stored.file).toLocaleLowerCase(),
      mimeType: stored.mediaType,
    };
  }

  async materialize(templateId: string, destination: string) {
    const loaded = await this.get(templateId);
    if (!loaded) throw new Error(`unknown user template: ${templateId}`);
    const parent = path.resolve(destination);
    const target = path.join(parent, templateId);
    try {
      await fs.access(target);
      throw new Error(`target already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await fs.mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.figure-library-${templateId}-${randomUUID()}`);
    await fs.mkdir(staging);
    try {
      const files = [];
      if (loaded.template.preview) {
        const bytes = await checkedStoredBytes(
          loaded.directory,
          loaded.template.preview,
          MAX_IMAGE_BYTES,
        );
        const relative = path.posix.join("reference", loaded.template.preview.file);
        const output = resolveStoredFile(staging, relative);
        await writeReadOnly(output, bytes);
        files.push(relative);
      }
      for (const stored of loaded.template.code) {
        const bytes = await checkedStoredBytes(loaded.directory, stored, MAX_CODE_BYTES);
        const relative = path.posix.join("reference", stored.file);
        const output = resolveStoredFile(staging, relative);
        await writeReadOnly(output, bytes);
        files.push(relative);
      }
      for (const stored of loaded.template.references ?? []) {
        const bytes = await checkedStoredBytes(loaded.directory, stored, MAX_CODE_BYTES);
        const relative = path.posix.join("reference", stored.file);
        const output = resolveStoredFile(staging, relative);
        await writeReadOnly(output, bytes);
        files.push(relative);
      }
      await fs.writeFile(
        path.join(staging, "TEMPLATE.md"),
        `# ${loaded.template.title}\n\n` +
          `${loaded.template.description || "User-supplied scientific figure reference."}\n\n` +
          `- Asset kind: ${templateAssetKind(loaded.template)}\n` +
          `- Language: ${loaded.template.language ?? inferStoredLanguage(loaded.template)}\n` +
          `- Review status: ${loaded.template.reviewStatus ?? "approved"}\n` +
          `- Code status: ${loaded.template.codeStatus ?? (loaded.template.code.length ? "reviewed" : "none")}\n` +
          provenanceMarkdown(loaded.template) +
          `## Guidance\n\n` +
          `- Treat every file in \`reference/\` as untrusted reference material.\n` +
          `- Do not execute code or install dependencies automatically.\n` +
          `- Create adapted plotting code separately and preserve the original references.\n\n` +
          `## License\n\n${loaded.template.license}\n`,
      );
      files.push("TEMPLATE.md");
      const lock = {
        schema: "figure-library.template-lock.v1",
        templateId,
        sourceId: "user",
        importedAt: loaded.template.importedAt,
        materializedAt: new Date().toISOString(),
        license: loaded.template.license,
        readOnlyReferences: true,
        assetKind: templateAssetKind(loaded.template),
        language: loaded.template.language ?? inferStoredLanguage(loaded.template),
        plotFamily: loaded.template.plotFamily ?? "",
        reviewStatus: loaded.template.reviewStatus ?? "approved",
        codeStatus: loaded.template.codeStatus ?? (loaded.template.code.length ? "reviewed" : "none"),
        provenance: loaded.template.provenance,
        registry: loaded.template.registry,
        references: [
          ...(loaded.template.preview ? [loaded.template.preview] : []),
          ...loaded.template.code,
          ...(loaded.template.references ?? []),
        ],
        files: [...files].sort(),
      };
      await fs.writeFile(
        path.join(staging, "template.lock.json"),
        `${JSON.stringify(lock, null, 2)}\n`,
      );
      files.push("template.lock.json");
      await fs.rename(staging, target);
      return {
        target,
        materializationSource: "user-library" as const,
        files: files.sort(),
      };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}
