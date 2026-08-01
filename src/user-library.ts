import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSearchIntent, scoreSearchableTemplate } from "./catalog.ts";
import {
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
  AssetKind,
  CodeStatus,
  ReviewStatus,
  SearchRequest,
  StoredFile,
  StoredPreview,
  StoredReference,
  TemplateCandidate,
  UserTemplate,
  UserTemplateImport,
} from "./types.ts";

interface LoadedTemplate {
  template: UserTemplate;
  directory: string;
}

function sha256(bytes: Uint8Array) {
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
        ["gallery", "figure-transfer-package"].includes(registry.adapter) &&
        /^[a-f0-9]{64}$/u.test(registry.contentHash) &&
        (registry.templateId === undefined || registry.templateId === item.templateId) &&
        (registry.galleryId === undefined || typeof registry.galleryId === "string") &&
        (registry.sourceCommit === undefined || typeof registry.sourceCommit === "string"))) &&
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

function userCandidate(
  template: UserTemplate,
  evidence: ReturnType<typeof scoreSearchableTemplate>,
) {
  const warnings = [];
  if (templateAssetKind(template) === "visual_reference") {
    warnings.push("只有视觉参考，没有附带绘图代码");
  }
  return {
    templateId: template.templateId,
    sourceId: "user",
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
    assetKind: templateAssetKind(template),
    language: template.language ?? inferStoredLanguage(template),
    plotFamily: template.plotFamily ?? "",
    reviewStatus: template.reviewStatus ?? "approved",
    codeStatus: template.codeStatus ?? (template.code.length ? "reviewed" : "none"),
    license: template.license,
    sourceUrl: template.provenance?.url,
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
  adapter: "gallery" | "figure-transfer-package";
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

export class UserTemplateLibrary {
  readonly root: string;
  readonly templatesDirectory: string;

  constructor(root = process.env.FIGURE_LIBRARY_DIR?.trim() || path.join(os.homedir(), ".figure-library")) {
    this.root = path.resolve(root);
    this.templatesDirectory = path.join(this.root, "templates");
  }

  async list(): Promise<LoadedTemplate[]> {
    let entries;
    try {
      entries = await fs.readdir(this.templatesDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const templates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map(async (entry) => {
          const directory = path.join(this.templatesDirectory, entry.name);
          try {
            const value = JSON.parse(
              await fs.readFile(path.join(directory, "template.json"), "utf8"),
            ) as unknown;
            if (!isUserTemplate(value) || value.templateId !== entry.name) return;
            return { template: value, directory };
          } catch {
            return;
          }
        }),
    );
    return templates
      .filter((item): item is LoadedTemplate => Boolean(item))
      .sort((left, right) => left.template.templateId.localeCompare(right.template.templateId));
  }

  async get(templateId: string) {
    return (await this.list()).find((item) => item.template.templateId === templateId);
  }

  async importTemplate(input: UserTemplateImport) {
    return this.applyPrepared(await prepareDirectImport(input), false);
  }

  async importTransferPackage(packagePath: string) {
    return this.applyPrepared(await prepareTransferPackage(packagePath), false);
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
    const byId = templates.find(({ template }) => template.templateId === prepared.templateId);
    if (byRegistry && byId && byRegistry.directory !== byId.directory) {
      throw new Error(`import registry conflict for ${prepared.registry?.sourceId}`);
    }
    const existing = byRegistry ?? byId;
    if (
      existing &&
      prepared.registry &&
      (existing.template.registry?.adapter !== prepared.registry.adapter ||
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
    return this.applyPrepared(await prepareImportSource(input), true);
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

  private async applyPrepared(prepared: PreparedTemplate, allowUpdate: boolean) {
    const existing = await this.findPrepared(prepared);
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

  async archiveGallery(galleryId: string) {
    const loaded = (await this.list()).find(
      ({ template }) => template.registry?.galleryId === galleryId,
    );
    if (!loaded) throw new Error(`unknown imported gallery_id: ${galleryId}`);
    if (loaded.template.reviewStatus === "archived") {
      return { template: loaded.template, directory: loaded.directory, existed: true };
    }
    const now = new Date().toISOString();
    const template: UserTemplate = {
      ...loaded.template,
      reviewStatus: "archived",
      archivedAt: now,
      updatedAt: now,
    };
    const temporary = path.join(loaded.directory, `.template-${randomUUID()}.json`);
    const manifest = path.join(loaded.directory, "template.json");
    const backup = path.join(loaded.directory, `.template-backup-${randomUUID()}.json`);
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
    return { template, directory: loaded.directory, existed: false };
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

    return Promise.all(
      ranked.map(async ({ template, directory, evidence }) => {
        const candidate = userCandidate(template, evidence);
        if (!template.preview || !EMBEDDABLE_IMAGE_TYPES.has(template.preview.mediaType)) {
          return candidate;
        }
        try {
          const bytes = await checkedStoredBytes(directory, template.preview, MAX_IMAGE_BYTES);
          return {
            ...candidate,
            previewDataUrl: `data:${template.preview.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
          };
        } catch {
          return {
            ...candidate,
            warnings: [...candidate.warnings, "预览文件缺失或校验失败"],
          };
        }
      }),
    );
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
