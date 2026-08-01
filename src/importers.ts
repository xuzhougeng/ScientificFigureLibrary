import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { parseDocument } from "yaml";
import { z } from "zod";
import type {
  AssetKind,
  CodeStatus,
  ImportRegistryEntry,
  ReviewStatus,
  StoredFile,
  StoredPreview,
  StoredReference,
  TemplateProvenance,
  UserTemplateImport,
} from "./types.ts";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_CODE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_CODE_FILES = 20;
const MAX_REFERENCE_FILES = 20;
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

export const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"],
]);
export const EMBEDDABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const CODE_EXTENSIONS = new Set([
  ".r",
  ".rmd",
  ".qmd",
  ".py",
  ".ipynb",
  ".jl",
  ".m",
  ".sh",
]);
const DIRECT_REFERENCE_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  ".md",
  ".tex",
  ".json",
  ".yaml",
  ".yml",
]);
const GALLERY_REFERENCE_EXTENSIONS = new Set([
  ...DIRECT_REFERENCE_EXTENSIONS,
  ".csv",
  ".tsv",
  ".txt",
]);

interface PreparedFile<T extends StoredFile = StoredFile> {
  stored: T;
  bytes: Uint8Array;
}

export interface PreparedTemplate {
  templateId: string;
  title: string;
  description: string;
  tags: string[];
  visualProfile: string;
  dataProfile: string;
  packages: string[];
  license: string;
  assetKind: AssetKind;
  language: string;
  plotFamily: string;
  reviewStatus: ReviewStatus;
  codeStatus: CodeStatus;
  provenance?: TemplateProvenance;
  registry?: ImportRegistryEntry;
  contentHash: string;
  preview?: PreparedFile<StoredPreview>;
  code: PreparedFile[];
  references: PreparedFile<StoredReference>[];
}

interface PreparedMetadata {
  title: string;
  description: string;
  tags: string[];
  visualProfile: string;
  dataProfile: string;
  packages: string[];
  license: string;
  assetKind: AssetKind;
  language: string;
  plotFamily: string;
  reviewStatus: ReviewStatus;
  codeStatus: CodeStatus;
  provenance?: TemplateProvenance;
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function compactList(values: string[] | undefined, limit = 40) {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.replace(/\s+/gu, " ").trim())
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

function safeFileName(value: string) {
  const extension = path.extname(value);
  const stem =
    path
      .basename(value, path.extname(value))
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^[._-]+|[._-]+$/gu, "")
      .slice(0, 100) || "reference";
  return `${stem}${extension}`;
}

function uniqueFileName(value: string, used: Set<string>) {
  const extension = path.extname(value);
  const stem = path.basename(value, extension);
  let candidate = value;
  let index = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    candidate = `${stem}-${index}${extension}`;
    index += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function slug(value: string) {
  return (
    value
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || "template"
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function contentHash(
  metadata: PreparedMetadata,
  preview: PreparedFile<StoredPreview> | undefined,
  code: PreparedFile[],
  references: PreparedFile<StoredReference>[],
) {
  const payload = canonicalize({
    ...metadata,
    tags: [...metadata.tags].sort(),
    packages: [...metadata.packages].sort(),
    preview: preview?.stored,
    code: code.map((item) => item.stored).sort((a, b) => a.file.localeCompare(b.file)),
    references: references
      .map((item) => item.stored)
      .sort((a, b) => a.file.localeCompare(b.file)),
  });
  return sha256(JSON.stringify(payload));
}

async function readHostFile(file: string, maxBytes: number, label: string) {
  const absolute = path.resolve(file);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${absolute}`);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${absolute}`);
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB: ${absolute}`);
  }
  return new Uint8Array(await fs.readFile(absolute));
}

function inferLanguage(files: string[]) {
  const extensions = new Set(files.map((file) => path.extname(file).toLocaleLowerCase()));
  if (extensions.has(".r") || extensions.has(".rmd") || extensions.has(".qmd")) return "R";
  if (extensions.has(".py") || extensions.has(".ipynb")) return "Python";
  if (extensions.has(".jl")) return "Julia";
  if (extensions.has(".m")) return "MATLAB";
  if (extensions.has(".sh")) return "Shell";
  return "none";
}

function validateTotalBytes(
  preview: PreparedFile<StoredPreview> | undefined,
  code: PreparedFile[],
  references: PreparedFile<StoredReference>[],
) {
  const total =
    (preview?.bytes.byteLength ?? 0) +
    [...code, ...references].reduce((sum, item) => sum + item.bytes.byteLength, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error("import exceeds 50 MiB total limit");
}

export async function prepareDirectImport(input: UserTemplateImport): Promise<PreparedTemplate> {
  const imageExtension = input.imagePath
    ? path.extname(input.imagePath).toLocaleLowerCase()
    : undefined;
  if (imageExtension && !IMAGE_TYPES.has(imageExtension)) {
    throw new Error(`unsupported image/reference extension: ${imageExtension}`);
  }
  if ((input.codePaths?.length ?? 0) > MAX_CODE_FILES) {
    throw new Error(`at most ${MAX_CODE_FILES} code files can be imported`);
  }
  if (!input.imagePath && !input.codePaths?.length) {
    throw new Error("provide imagePath or at least one codePaths entry");
  }

  const previewBytes = input.imagePath
    ? await readHostFile(input.imagePath, MAX_IMAGE_BYTES, "image/reference")
    : undefined;
  const preview =
    previewBytes && imageExtension
      ? {
          stored: {
            file: `preview${imageExtension}`,
            bytes: previewBytes.byteLength,
            sha256: sha256(previewBytes),
            mediaType: IMAGE_TYPES.get(imageExtension) ?? "application/octet-stream",
          },
          bytes: previewBytes,
        }
      : undefined;

  const used = new Set<string>();
  const code = [];
  for (const file of input.codePaths ?? []) {
    const extension = path.extname(file).toLocaleLowerCase();
    if (!DIRECT_REFERENCE_EXTENSIONS.has(extension)) {
      throw new Error(`unsupported code/reference extension: ${extension || "(none)"}`);
    }
    const bytes = await readHostFile(file, MAX_CODE_BYTES, "code/reference");
    const name = uniqueFileName(safeFileName(path.basename(file)), used);
    code.push({
      stored: {
        file: path.posix.join("code", name),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      },
      bytes,
    });
  }
  code.sort((left, right) => left.stored.file.localeCompare(right.stored.file));

  const legacyMetadata = {
    title: input.title.replace(/\s+/gu, " ").trim(),
    description: input.description?.replace(/\s+/gu, " ").trim() ?? "",
    tags: compactList(input.tags),
    visualProfile: input.visualProfile?.replace(/\s+/gu, " ").trim() ?? "",
    dataProfile: input.dataProfile?.replace(/\s+/gu, " ").trim() ?? "",
    packages: compactList(input.packages),
    license: input.license?.replace(/\s+/gu, " ").trim() || "User supplied; rights not asserted",
    preview: preview?.stored,
    code: code.map((item) => item.stored),
  };
  if (!legacyMetadata.title) throw new Error("title cannot be blank");

  const hasCode = code.some((item) =>
    CODE_EXTENSIONS.has(path.extname(item.stored.file).toLocaleLowerCase()),
  );
  const metadata: PreparedMetadata = {
    title: legacyMetadata.title,
    description: legacyMetadata.description,
    tags: legacyMetadata.tags,
    visualProfile: legacyMetadata.visualProfile,
    dataProfile: legacyMetadata.dataProfile,
    packages: legacyMetadata.packages,
    license: legacyMetadata.license,
    assetKind: input.assetKind ?? (hasCode ? "plot_template" : "visual_reference"),
    language: input.language?.trim() || inferLanguage(code.map((item) => item.stored.file)),
    plotFamily: input.plotFamily?.trim() ?? "",
    reviewStatus: input.reviewStatus ?? "approved",
    codeStatus: input.codeStatus ?? (hasCode ? "reviewed" : "none"),
    provenance: input.provenance,
  };
  if (metadata.assetKind === "plot_template" && metadata.codeStatus === "none") {
    throw new Error("plot_template requires codeStatus scaffold or reviewed");
  }
  if (metadata.assetKind === "visual_reference" && metadata.codeStatus !== "none") {
    throw new Error("visual_reference requires codeStatus none");
  }
  if (metadata.codeStatus !== "none" && !hasCode) {
    throw new Error("codeStatus requires an executable plotting-code file");
  }
  const advancedIdentity = Boolean(
    input.assetKind ||
      input.language ||
      input.plotFamily ||
      input.reviewStatus ||
      input.codeStatus ||
      input.provenance,
  );
  const identity = sha256(
    JSON.stringify(advancedIdentity ? { ...legacyMetadata, ...metadata } : legacyMetadata),
  ).slice(0, 10);
  const hash = contentHash(metadata, preview, code, []);
  validateTotalBytes(preview, code, []);
  return {
    templateId: `user-${slug(metadata.title)}-${identity}`,
    ...metadata,
    contentHash: hash,
    preview,
    code,
    references: [],
  };
}

const NullableText = z.string().max(4_000).nullable();
const StableId = z.union([z.string().min(1).max(300), z.number().int().nonnegative()]);
const TransferManifestSchema = z
  .object({
    schema: z.literal("figure-transfer-package.v1"),
    version: z.literal(1),
    producer: z
      .object({
        name: z.string().min(1).max(100),
        version: z.string().min(1).max(100),
      })
      .passthrough(),
    exportedAt: z.string().min(1).max(100),
    source: z
      .object({
        sourceId: StableId,
        figureId: StableId,
        parentFigureId: StableId.nullable(),
        figureLabel: z.string().max(200),
        subfigureLabels: z.array(z.string().max(50)).max(100),
        caption: z.string().max(20_000),
        page: z.number().int().positive().nullable(),
        paper: z
          .object({
            title: z.string().max(2_000),
            authors: z.array(z.string().max(300)).max(500),
            year: z.union([z.string().max(20), z.number().int()]).nullable(),
            journal: NullableText,
            doi: NullableText,
            url: NullableText,
          })
          .passthrough(),
        license: z
          .object({
            scope: z.string().min(1).max(500),
            text: NullableText,
          })
          .passthrough(),
      })
      .passthrough(),
    figure: z
      .object({
        file: z.string().min(1).max(200),
        mediaType: z.enum([
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/svg+xml",
          "application/pdf",
        ]),
        bytes: z.number().int().nonnegative().max(MAX_IMAGE_BYTES),
        sha256: z.string().regex(/^[a-fA-F0-9]{64}$/u),
      })
      .passthrough(),
  })
  .passthrough();

function safeArchivePath(value: string) {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe package path: ${value}`);
  }
  return value;
}

function validateImageBytes(mediaType: string, bytes: Uint8Array) {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString("ascii");
  const valid =
    (mediaType === "image/png" && starts(137, 80, 78, 71, 13, 10, 26, 10)) ||
    (mediaType === "image/jpeg" && starts(255, 216, 255)) ||
    (mediaType === "image/webp" && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") ||
    (mediaType === "application/pdf" && ascii(0, 5) === "%PDF-") ||
    (mediaType === "image/svg+xml" &&
      /^(?:\uFEFF|\s|<\?xml[^>]*>)*<svg(?:\s|>)/iu.test(
        new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 4_096))),
      ));
  if (!valid) throw new Error(`figure bytes do not match declared media type ${mediaType}`);
}

function decodeUtf8(bytes: Uint8Array, label: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

export async function prepareTransferPackage(packagePath: string): Promise<PreparedTemplate> {
  if (path.extname(packagePath).toLocaleLowerCase() !== ".zip") {
    throw new Error("Figure Transfer Package must be a .zip file");
  }
  const archive = await readHostFile(packagePath, MAX_PACKAGE_BYTES, "Figure Transfer Package");
  let expandedBytes = 0;
  let files = 0;
  const seen = new Set<string>();
  const entries = unzipSync(archive, {
    filter(info) {
      const name = info.name.endsWith("/") ? info.name.slice(0, -1) : info.name;
      safeArchivePath(name);
      if (info.name.endsWith("/")) return false;
      if (seen.has(name)) throw new Error(`duplicate package entry: ${name}`);
      seen.add(name);
      files += 1;
      expandedBytes += info.originalSize;
      if (files > 4) throw new Error("Figure Transfer Package contains too many files");
      if (expandedBytes > MAX_TOTAL_BYTES) throw new Error("expanded package exceeds 50 MiB");
      return true;
    },
  });

  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes) throw new Error("Figure Transfer Package is missing manifest.json");
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("manifest.json exceeds 256 KiB");
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(decodeUtf8(manifestBytes, "manifest.json"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`invalid manifest.json: ${error.message}`);
    throw error;
  }
  const parsed = TransferManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    throw new Error(`invalid Figure Transfer Package manifest: ${z.prettifyError(parsed.error)}`);
  }
  const manifest = parsed.data;
  if (!Number.isFinite(Date.parse(manifest.exportedAt))) {
    throw new Error("invalid Figure Transfer Package exportedAt timestamp");
  }
  const figurePath = safeArchivePath(manifest.figure.file);
  if (figurePath.includes("/")) throw new Error("figure file must be at the package root");
  const figureBytes = entries[figurePath];
  if (!figureBytes) throw new Error(`package is missing declared figure file: ${figurePath}`);
  const extra = Object.keys(entries).filter((name) => name !== "manifest.json" && name !== figurePath);
  if (extra.length) throw new Error(`unexpected package file: ${extra[0]}`);
  if (figureBytes.byteLength !== manifest.figure.bytes) {
    throw new Error(
      `figure size mismatch: expected ${manifest.figure.bytes}, got ${figureBytes.byteLength}`,
    );
  }
  if (sha256(figureBytes) !== manifest.figure.sha256.toLocaleLowerCase()) {
    throw new Error("figure SHA-256 mismatch");
  }
  const extension = path.extname(figurePath).toLocaleLowerCase();
  if (IMAGE_TYPES.get(extension) !== manifest.figure.mediaType) {
    throw new Error(`figure extension ${extension || "(none)"} does not match media type`);
  }
  validateImageBytes(manifest.figure.mediaType, figureBytes);

  const source = manifest.source;
  const paper = source.paper;
  const sourceIdValue = String(source.sourceId);
  const figureIdValue = String(source.figureId);
  const license = [source.license.scope, source.license.text].filter(Boolean).join(" — ");
  const metadata: PreparedMetadata = {
    title: [source.figureLabel, paper.title].filter(Boolean).join(" — ") || `Figure ${figureIdValue}`,
    description: source.caption,
    tags: compactList([
      manifest.producer.name,
      "paper figure",
      source.figureLabel,
      ...source.subfigureLabels,
    ]),
    visualProfile: "",
    dataProfile: "",
    packages: [],
    license: license || "unknown",
    assetKind: "visual_reference",
    language: "none",
    plotFamily: "",
    reviewStatus: "draft",
    codeStatus: "none",
    provenance: {
      producer: manifest.producer.name,
      producerVersion: manifest.producer.version,
      exportedAt: manifest.exportedAt,
      sourceId: sourceIdValue,
      figureId: figureIdValue,
      parentFigureId: source.parentFigureId === null ? undefined : String(source.parentFigureId),
      figureLabel: source.figureLabel || undefined,
      subfigureLabels: source.subfigureLabels,
      caption: source.caption,
      paperTitle: paper.title,
      authors: paper.authors,
      year: paper.year === null ? undefined : String(paper.year),
      journal: paper.journal ?? undefined,
      doi: paper.doi ?? undefined,
      page: source.page === null ? undefined : String(source.page),
      url: paper.url ?? undefined,
      licenseScope: source.license.scope,
      rights: source.license.text ?? undefined,
    },
  };
  const preview: PreparedFile<StoredPreview> = {
    stored: {
      file: `preview${extension}`,
      bytes: figureBytes.byteLength,
      sha256: sha256(figureBytes),
      mediaType: manifest.figure.mediaType,
    },
    bytes: figureBytes,
  };
  const references: PreparedFile<StoredReference>[] = [
    {
      stored: {
        file: "metadata/transfer-manifest.json",
        bytes: manifestBytes.byteLength,
        sha256: sha256(manifestBytes),
        role: "metadata",
      },
      bytes: manifestBytes,
    },
  ];
  const hash = contentHash(metadata, preview, [], references);
  const sourceId = `${manifest.producer.name}:${sourceIdValue}:${figureIdValue}`;
  const registry: ImportRegistryEntry = {
    adapter: "figure-transfer-package",
    sourceId,
    contentHash: hash,
  };
  validateTotalBytes(preview, [], references);
  return {
    templateId: `user-transfer-${slug(manifest.producer.name)}-${sha256(sourceId).slice(0, 10)}`,
    ...metadata,
    registry,
    contentHash: hash,
    preview,
    code: [],
    references,
  };
}

const GalleryManifestSchema = z
  .object({
    schema: z.literal("figure-library.gallery-entry.v1"),
    gallery_id: z.string().min(1).max(300),
    title: z.string().min(1).max(200),
    description: z.string().max(20_000).optional(),
    description_file: z.string().min(1).max(300).optional().default("description.md"),
    tags: z.array(z.string().min(1).max(100)).max(40).optional().default([]),
    visual_profile: z.string().max(4_000).optional().default(""),
    data_profile: z.string().max(4_000).optional().default(""),
    packages: z.array(z.string().min(1).max(100)).max(40).optional().default([]),
    license: z.string().min(1).max(1_000),
    asset_kind: z.enum(["plot_template", "visual_reference"]),
    language: z.string().min(1).max(100),
    plot_family: z.string().max(200).optional().default(""),
    review_status: z.enum(["draft", "approved", "archived"]),
    code_status: z.enum(["none", "scaffold", "reviewed"]),
    preview: z.string().min(1).max(300).optional().default("preview.png"),
    provenance_file: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .default("source/provenance.yml"),
    code_files: z.array(z.string().min(1).max(300)).max(MAX_CODE_FILES).optional(),
    content_hash: z.string().regex(/^[a-fA-F0-9]{64}$/u).optional(),
    source_commit: z.string().min(1).max(200).optional(),
  })
  .passthrough();

async function parseYamlFile(file: string, label: string) {
  const bytes = await readHostFile(file, MAX_MANIFEST_BYTES, label);
  const document = parseDocument(decodeUtf8(bytes, label), { uniqueKeys: true });
  if (document.errors.length) {
    throw new Error(`invalid ${label}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return { bytes, value: document.toJS({ maxAliasCount: 20 }) as unknown };
}

function portableRelativePath(value: string, label: string) {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe ${label} path: ${value}`);
  }
  return value;
}

async function readGalleryFile(root: string, relative: string, maxBytes: number, label: string) {
  const safe = portableRelativePath(relative, label);
  const rootReal = await fs.realpath(root);
  const candidate = path.resolve(rootReal, ...safe.split("/"));
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist: ${relative}`);
    }
    throw error;
  }
  if (!real.startsWith(`${rootReal}${path.sep}`)) throw new Error(`${label} escapes gallery entry`);
  const stat = await fs.lstat(real);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds its size limit`);
  return new Uint8Array(await fs.readFile(real));
}

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function walkGalleryCode(root: string, relative = "code"): Promise<string[]> {
  const directory = path.join(root, ...relative.split("/"));
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error(`gallery code cannot contain symlink: ${entry.name}`);
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await walkGalleryCode(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalText(value: unknown) {
  const result =
    typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
  return result || undefined;
}

function normalizeProvenance(value: unknown): TemplateProvenance {
  const source = record(value);
  const paper = record(source.paper);
  const license = record(source.license);
  const stringList = (item: unknown) =>
    Array.isArray(item) ? item.map((value) => text(value)).filter(Boolean) : undefined;
  return {
    producer: optionalText(source.producer ?? source.producer_name),
    producerVersion: optionalText(source.producerVersion ?? source.producer_version),
    exportedAt: optionalText(source.exportedAt ?? source.exported_at),
    sourceId: optionalText(source.sourceId ?? source.source_id),
    figureId: optionalText(source.figureId ?? source.figure_id),
    parentFigureId: optionalText(source.parentFigureId ?? source.parent_figure_id),
    figureLabel: optionalText(source.figureLabel ?? source.figure_label),
    subfigureLabels: stringList(source.subfigureLabels ?? source.subfigure_labels),
    caption: optionalText(source.caption),
    paperTitle: optionalText(source.paperTitle ?? source.paper_title ?? paper.title),
    authors: stringList(source.authors ?? paper.authors),
    year: optionalText(source.year ?? paper.year),
    journal: optionalText(source.journal ?? paper.journal),
    doi: optionalText(source.doi ?? paper.doi),
    page: optionalText(source.page ?? source.page_number),
    url: optionalText(source.url ?? paper.url),
    licenseScope: optionalText(source.licenseScope ?? source.license_scope ?? license.scope),
    rights: optionalText(source.rights ?? license.text),
  };
}

export async function prepareGalleryEntry(
  entryPath: string,
  sourceCommit?: string,
): Promise<PreparedTemplate> {
  const entry = path.resolve(entryPath);
  const stat = await fs.lstat(entry);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`gallery entry is not a regular directory: ${entry}`);
  }
  const manifestFile = path.join(entry, "figure.yml");
  const { value: rawManifest } = await parseYamlFile(manifestFile, "figure.yml");
  const parsed = GalleryManifestSchema.safeParse(rawManifest);
  if (!parsed.success) throw new Error(`invalid figure.yml: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;
  if (/\p{C}/u.test(manifest.gallery_id) || manifest.gallery_id.trim() !== manifest.gallery_id) {
    throw new Error("gallery_id contains control or surrounding whitespace");
  }

  const previewRelative = portableRelativePath(manifest.preview, "preview");
  const previewExtension = path.extname(previewRelative).toLocaleLowerCase();
  const mediaType = IMAGE_TYPES.get(previewExtension);
  if (!mediaType) throw new Error(`unsupported gallery preview extension: ${previewExtension}`);
  const previewBytes = await readGalleryFile(entry, previewRelative, MAX_IMAGE_BYTES, "preview");
  const preview: PreparedFile<StoredPreview> = {
    stored: {
      file: `preview${previewExtension}`,
      bytes: previewBytes.byteLength,
      sha256: sha256(previewBytes),
      mediaType,
    },
    bytes: previewBytes,
  };

  let description = manifest.description?.trim() ?? "";
  const descriptionRelative = portableRelativePath(manifest.description_file, "description");
  const descriptionPath = path.join(entry, ...descriptionRelative.split("/"));
  let descriptionBytes: Uint8Array | undefined;
  if (await exists(descriptionPath)) {
    descriptionBytes = await readGalleryFile(
      entry,
      descriptionRelative,
      MAX_MANIFEST_BYTES,
      "description",
    );
    description ||= decodeUtf8(descriptionBytes, "description").trim();
  }
  if (!description) throw new Error("gallery entry needs description or description_file content");

  const provenanceRelative = portableRelativePath(manifest.provenance_file, "provenance");
  const provenanceFile = path.join(entry, ...provenanceRelative.split("/"));
  const { bytes: provenanceBytes, value: rawProvenance } = await parseYamlFile(
    provenanceFile,
    "provenance.yml",
  );
  const provenance = normalizeProvenance(rawProvenance);

  const listedFiles = manifest.code_files?.map((file) => portableRelativePath(file, "code"));
  const galleryFiles = listedFiles ?? (await walkGalleryCode(entry));
  if (galleryFiles.length > MAX_CODE_FILES) {
    throw new Error(`at most ${MAX_CODE_FILES} gallery code/data files can be imported`);
  }
  const code: PreparedFile[] = [];
  const references: PreparedFile<StoredReference>[] = [];
  for (const relative of [...new Set(galleryFiles)].sort()) {
    if (!relative.startsWith("code/")) throw new Error(`gallery code file must be under code/: ${relative}`);
    const extension = path.extname(relative).toLocaleLowerCase();
    if (!GALLERY_REFERENCE_EXTENSIONS.has(extension)) {
      throw new Error(`unsupported gallery code/data extension: ${extension || "(none)"}`);
    }
    const bytes = await readGalleryFile(entry, relative, MAX_CODE_BYTES, "gallery code/data");
    const stored = { file: relative, bytes: bytes.byteLength, sha256: sha256(bytes) };
    if (CODE_EXTENSIONS.has(extension)) code.push({ stored, bytes });
    else references.push({ stored: { ...stored, role: "data" }, bytes });
  }
  if (descriptionBytes) {
    references.push({
      stored: {
        file: "metadata/description.md",
        bytes: descriptionBytes.byteLength,
        sha256: sha256(descriptionBytes),
        role: "metadata",
      },
      bytes: descriptionBytes,
    });
  }
  references.push({
    stored: {
      file: "metadata/provenance.yml",
      bytes: provenanceBytes.byteLength,
      sha256: sha256(provenanceBytes),
      role: "metadata",
    },
    bytes: provenanceBytes,
  });
  if (references.length > MAX_REFERENCE_FILES) {
    throw new Error(`at most ${MAX_REFERENCE_FILES} gallery data/metadata files can be imported`);
  }

  if (manifest.asset_kind === "plot_template" && manifest.code_status === "none") {
    throw new Error("plot_template requires code_status scaffold or reviewed");
  }
  if (manifest.asset_kind === "visual_reference" && manifest.code_status !== "none") {
    throw new Error("visual_reference requires code_status none");
  }
  if (manifest.code_status !== "none" && code.length === 0) {
    throw new Error("code_status requires at least one executable plotting-code file");
  }
  if (
    manifest.language.toLocaleLowerCase() === "r" &&
    manifest.code_status !== "none" &&
    !code.some((item) => /\.(?:r|rmd|qmd)$/iu.test(item.stored.file))
  ) {
    throw new Error("R gallery template requires an .R, .Rmd, or .qmd file");
  }

  const metadata: PreparedMetadata = {
    title: manifest.title.replace(/\s+/gu, " ").trim(),
    description,
    tags: compactList(manifest.tags),
    visualProfile: manifest.visual_profile.trim(),
    dataProfile: manifest.data_profile.trim(),
    packages: compactList(manifest.packages),
    license: manifest.license.trim(),
    assetKind: manifest.asset_kind,
    language: manifest.language.trim(),
    plotFamily: manifest.plot_family.trim(),
    reviewStatus: manifest.review_status,
    codeStatus: manifest.code_status,
    provenance,
  };
  const hash = contentHash(metadata, preview, code, references);
  if (manifest.content_hash && manifest.content_hash.toLocaleLowerCase() !== hash) {
    throw new Error(`content_hash mismatch: computed ${hash}`);
  }
  const registry: ImportRegistryEntry = {
    adapter: "gallery",
    sourceId: manifest.gallery_id,
    galleryId: manifest.gallery_id,
    contentHash: hash,
    sourceCommit: manifest.source_commit ?? sourceCommit,
  };
  validateTotalBytes(preview, code, references);
  return {
    templateId: `user-gallery-${slug(manifest.gallery_id)}-${sha256(manifest.gallery_id).slice(0, 10)}`,
    ...metadata,
    registry,
    contentHash: hash,
    preview,
    code,
    references,
  };
}

export async function discoverGalleryEntries(galleryDirectory: string) {
  let root = path.resolve(galleryDirectory);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`gallery is not a regular directory: ${root}`);
  }
  if (await exists(path.join(root, "figure.yml"))) return [root];
  if (await exists(path.join(root, "gallery"))) {
    root = path.join(root, "gallery");
    const galleryStat = await fs.lstat(root);
    if (galleryStat.isSymbolicLink() || !galleryStat.isDirectory()) {
      throw new Error(`gallery is not a regular directory: ${root}`);
    }
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (await exists(path.join(directory, "figure.yml"))) result.push(directory);
  }
  return result;
}
