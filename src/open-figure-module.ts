import { figureDescriptionMarkdown, markdownPlainText, resolveFigureDescription } from "./figure-description.ts";
import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { zipSync, unzipSync } from "fflate";
import { encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import type { VersionedTemplateLibrary, TemplateContentV1, StoredRevisionAsset } from "./versioned-library.ts";

export const OPEN_FIGURE_MODULE_SCHEMA = "figure-library.personal-module.v1" as const;
export const OPEN_FIGURE_ARCHIVE_MANIFEST_SCHEMA = "figure-library.personal-archive-manifest.v1" as const;
export const OPEN_FIGURE_PROVIDER_ID = "io.github.jarxunlai.personal-figures" as const;
export const OPEN_FIGURE_REPOSITORY = "jarxunlai/ScientificFigureLibrary-personal" as const;
export const OPEN_FIGURE_SOURCE_LABEL = "Open Figure Modules" as const;

const MODULE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const UUID_TEMPLATE_ID =
  /^template-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PRIVATE_KEY = /-----BEGIN (?:OPENSSH |EC |RSA )?PRIVATE KEY-----/u;
const TOKEN = /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;
const PRIVATE_PATH =
  /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s"'`(=])\/(?:Users|home|mnt\/[A-Za-z]|private|var|tmp|etc|opt|root|srv|Volumes)\/)/mu;
const FORBIDDEN_PUBLIC_FILE =
  /(?:^|\/)(?:\.git|source|validation)(?:\/|$)|(?:^|\/)original\.r$|\.(?:pdf|rds|rda|rdata|log|tiff?)$/iu;
const PRIVATE_SUPPORTING_FILE = /(?:^|\/)(?:source|evidence|validation|receipts?|private_reference)(?:[._-][^/]*)?(?:\/|$)/iu;
const SOURCE_DATE_EPOCH = new Date("2000-01-01T00:00:00.000Z");
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const THUMBNAIL_MAX_EDGE = 320;

export interface OpenFigureModuleFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface OpenFigureModuleBuild {
  moduleId: string;
  title: string;
  titleEn: string;
  titleEnDerived: boolean;
  description: string;
  application: string;
  scientificQuestion?: string;
  dataProfile: string;
  plotFamily: string;
  language: string;
  tags: string[];
  packages: string[];
  canonicalCode: string;
  canonicalCodeSha256: string;
  previewSha256: string;
  files: OpenFigureModuleFile[];
  excludedLogicalPaths: string[];
  searchQuery: string;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function basename(logicalPath: string) {
  const parts = logicalPath.split("/");
  return parts[parts.length - 1] ?? logicalPath;
}

function extension(pathValue: string) {
  const name = basename(pathValue);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLocaleLowerCase("en-US") : "";
}

export function normalizeComparableText(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

export function assertPortableModuleId(templateId: string) {
  if (UUID_TEMPLATE_ID.test(templateId) || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.test(templateId)) {
    throw new Error(`Local templateId is a machine UUID and cannot be used as an Open Figure moduleId: ${templateId}`);
  }
  if (!MODULE_ID.test(templateId)) {
    throw new Error(`Local templateId is not a portable Open Figure moduleId: ${templateId}`);
  }
  return templateId;
}

function deriveTitleEn(title: string, moduleId: string) {
  if (/^[\x20-\x7e]+$/u.test(title) && title.trim()) return { titleEn: title.trim(), derived: false };
  return { titleEn: moduleId.replace(/[-_.]+/gu, " ").trim(), derived: true };
}

function scanText(pathValue: string, text: string) {
  if (text.includes("\uFFFD")) throw new Error(`public text asset is not valid UTF-8: ${pathValue}`);
  if (PRIVATE_PATH.test(text) || TOKEN.test(text) || PRIVATE_KEY.test(text)) {
    throw new Error(`public asset contains a private path, token, or key: ${pathValue}`);
  }
}

function scanBytes(pathValue: string, bytes: Uint8Array, mediaType: string) {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`public asset exceeds the file size limit: ${pathValue}`);
  if (FORBIDDEN_PUBLIC_FILE.test(pathValue)) throw new Error(`forbidden public path: ${pathValue}`);
  if (
    /^(?:text\/|application\/(?:json|yaml|x-yaml))/u.test(mediaType) ||
    /\.(?:r|py|md|txt|csv|tsv|json|ya?ml)$/iu.test(pathValue)
  ) {
    scanText(pathValue, Buffer.from(bytes).toString("utf8"));
  }
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].sort(compareCanonicalStrings);
}

function codePublicPath(asset: StoredRevisionAsset, canonicalPath: string, used: Set<string>) {
  if (asset.logicalPath === canonicalPath) {
    const ext = extension(asset.logicalPath) === ".py" ? ".py" : ".R";
    return `code/organized${ext === ".py" ? ".py" : ".R"}`;
  }
  const ext = extension(asset.logicalPath) === ".py" ? ".py" : ".R";
  // A revision may contain several non-canonical code assets.  Mapping all of
  // them to code/example.R used to make publication fail deterministically.
  // Keep the public names portable and derive the suffix from the immutable
  // asset identity so plans remain reproducible across runs.
  const digest = typeof asset.sha256 === "string" ? asset.sha256.slice(0, 8) : "asset";
  let pathValue = `code/example-${digest}${ext}`;
  let index = 2;
  while (used.has(pathValue)) {
    pathValue = `code/example-${digest}-${index}${ext}`;
    index += 1;
  }
  return pathValue;
}

function dataPublicPath(logicalPath: string, used: Set<string>) {
  const name = basename(logicalPath).replace(/[^A-Za-z0-9._-]/gu, "-");
  let pathValue = `data/${name || "input.csv"}`;
  let index = 2;
  while (used.has(pathValue)) {
    pathValue = `data/${index}-${name}`;
    index += 1;
  }
  return pathValue;
}

function jpegThumbnail(pngBytes: Uint8Array) {
  const png = PNG.sync.read(Buffer.from(pngBytes), { checkCRC: true });
  const width = png.width;
  const height = png.height;
  if (!width || !height) throw new Error("generated preview has unsafe dimensions");
  const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(width, height));
  const nextWidth = Math.max(1, Math.round(width * scale));
  const nextHeight = Math.max(1, Math.round(height * scale));
  const data = Buffer.alloc(nextWidth * nextHeight * 4);
  for (let y = 0; y < nextHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / nextHeight));
    for (let x = 0; x < nextWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / nextWidth));
      const source = (sourceY * width + sourceX) * 4;
      const dest = (y * nextWidth + x) * 4;
      data[dest] = png.data[source] ?? 0;
      data[dest + 1] = png.data[source + 1] ?? 0;
      data[dest + 2] = png.data[source + 2] ?? 0;
      data[dest + 3] = 255;
    }
  }
  const encoded = encodeJpeg({ data, width: nextWidth, height: nextHeight }, 80);
  return encoded.data instanceof Uint8Array ? encoded.data : Uint8Array.from(encoded.data);
}

function csvSchema(bytes: Uint8Array) {
  const text = Buffer.from(bytes).toString("utf8");
  const header = text.split(/\r?\n/u)[0] ?? "";
  const columns = header.split(",").map((item) => item.trim()).filter(Boolean);
  return stringifyYaml(
    {
      format: "csv",
      columns,
      note: "Example or synthetic input used to demonstrate the plotting layer.",
    },
    { lineWidth: 0 },
  );
}

function fileEntry(pathValue: string, bytes: Uint8Array): OpenFigureModuleFile {
  return { path: pathValue, bytes, sha256: sha256(bytes) };
}

function yamlModule(options: {
  moduleId: string;
  title: string;
  titleEn: string;
  description: string;
  application: string;
  scientificQuestion?: string;
  dataProfile: string;
  plotFamily: string;
  language: string;
  tags: string[];
  packages: string[];
  codeFiles: string[];
  inputFiles: string[];
  canonicalCode: string;
  requiredFiles: string[];
  files: string[];
  preview: { path: string; bytes: number; sha256: string; mediaType: string };
  thumbnail: { path: string; bytes: number; sha256: string; mediaType: string };
  publisher: {
    reviewStatus: "approved";
    executionStatus: "not_run" | "passed" | "failed";
    executionScope: "synthetic_data" | "example_data" | "real_data" | "unknown";
    evidence?: string[];
  };
}) {
  const document = {
    schema: OPEN_FIGURE_MODULE_SCHEMA,
    moduleId: options.moduleId,
    title: options.title,
    titleEn: options.titleEn,
    description: options.description,
    application: options.application,
    ...(options.scientificQuestion ? { scientificQuestion: options.scientificQuestion } : {}),
    dataProfile: options.dataProfile,
    plotFamily: options.plotFamily,
    language: options.language,
    tags: options.tags,
    packages: options.packages,
    codeFiles: options.codeFiles,
    inputFiles: options.inputFiles,
    canonicalCode: options.canonicalCode,
    requiredFiles: options.requiredFiles,
    files: options.files,
    preview: options.preview,
    thumbnail: options.thumbnail,
    licenses: {
      code: "MIT",
      content: "CC BY 4.0",
      documentation: "CC BY 4.0",
    },
    publisher: options.publisher,
    provenance: [
      {
        type: "local_published_cleaning",
        note: `Prepared from the reviewed Local Published entry ${options.moduleId}; internal Library state is not distributed.`,
      },
      {
        type: "synthetic_data",
        note: "Example inputs were generated for portable execution and do not represent real samples or scientific conclusions.",
      },
      {
        type: "clean_room_transformation",
        note: "Only files listed in this manifest are distributed; source/reference images, PDFs, logs, receipts, and machine-local state are excluded.",
      },
    ],
  };
  return stringifyYaml(document, { lineWidth: 120, indent: 2 });
}

export function buildSearchQuery(content: TemplateContentV1) {
  const parts = uniqueSorted([
    content.title,
    content.plotFamily,
    content.language,
    ...content.tags,
    ...markdownPlainText(content.description).split(/\s+/u).slice(0, 8),
  ]);
  const query = parts.join(" ").trim();
  if (!query) throw new Error("Open Figure search query could not be derived from the Local Published metadata");
  return query.slice(0, 2_000);
}

export async function buildOpenFigureModule(options: {
  library: VersionedTemplateLibrary;
  content: TemplateContentV1;
}): Promise<OpenFigureModuleBuild> {
  const moduleId = assertPortableModuleId(options.content.templateId);
  const canonicalPath = options.content.canonicalImplementation?.assetPath;
  if (!canonicalPath) throw new Error("Open Figure publication requires a user-selected canonical implementation");
  const canonicalAsset = options.content.assets.find((asset) => asset.logicalPath === canonicalPath);
  if (!canonicalAsset || canonicalAsset.role !== "code") {
    throw new Error("canonical implementation is not a code asset");
  }
  const previewPath =
    options.content.canonicalPreviewDecision?.assetPath ?? options.content.primaryPreview;
  const previewAsset = options.content.assets.find((asset) => asset.logicalPath === previewPath);
  if (!previewAsset || previewAsset.role !== "visual" || previewAsset.visualRole !== "rendered_output") {
    throw new Error("Open Figure publication requires a generated rendered_output PNG preview");
  }
  if (previewAsset.mediaType !== "image/png") {
    throw new Error("Open Figure generated preview must be a PNG");
  }

  const usedPaths = new Set<string>();
  const fileMap = new Map<string, Uint8Array>();
  const excludedLogicalPaths: string[] = [];
  const addFile = (pathValue: string, bytes: Uint8Array, mediaType: string) => {
    if (usedPaths.has(pathValue)) throw new Error(`Open Figure module path collision: ${pathValue}`);
    scanBytes(pathValue, bytes, mediaType);
    usedPaths.add(pathValue);
    fileMap.set(pathValue, bytes);
  };

  for (const asset of options.content.assets) {
    if (asset.role === "reference" && PRIVATE_SUPPORTING_FILE.test(asset.logicalPath)) {
      excludedLogicalPaths.push(asset.logicalPath);
      continue;
    }
    const includeCode =
      asset.role === "code" &&
      (asset.logicalPath === canonicalPath ||
        asset.codeOrigin === "user_supplied" ||
        asset.codeOrigin === "adapted" ||
        asset.codeOrigin === "agent_generated");
    const includeData =
      asset.role === "reference" &&
      /\.(?:csv|tsv|txt)$/iu.test(asset.logicalPath);
    const includeDocs =
      asset.role === "reference" &&
      /\.(?:md|txt)$/iu.test(asset.logicalPath) &&
      !includeData;
    const includePreview = asset.logicalPath === previewAsset.logicalPath;
    if (includeDocs && basename(asset.logicalPath).toLocaleLowerCase("en-US") === "description.md") {
      excludedLogicalPaths.push(asset.logicalPath);
      continue; // The public description is regenerated from confirmed fields.
    }
    if (asset.role === "evidence" || asset.visualRole === "source_reference" || asset.codeOrigin === "author_provided" && asset.logicalPath !== canonicalPath) {
      excludedLogicalPaths.push(asset.logicalPath);
      continue;
    }
    if (/\.(?:pdf|tiff?)$/iu.test(asset.logicalPath) || /\b(?:application\/pdf)\b/iu.test(asset.mediaType)) {
      excludedLogicalPaths.push(asset.logicalPath);
      continue;
    }
    if (!includeCode && !includeData && !includeDocs && !includePreview) {
      excludedLogicalPaths.push(asset.logicalPath);
      continue;
    }
    const loaded = await options.library.readAsset({
      templateId: options.content.templateId,
      revisionId: options.content.revisionId,
      contentDigest: options.content.contentDigest,
      logicalPath: asset.logicalPath,
    });
    if (includePreview) {
      addFile("preview.png", loaded.bytes, "image/png");
      continue;
    }
    if (includeCode) {
      addFile(codePublicPath(asset, canonicalPath, usedPaths), loaded.bytes, asset.mediaType);
      continue;
    }
    if (includeData) {
      addFile(dataPublicPath(asset.logicalPath, usedPaths), loaded.bytes, asset.mediaType);
      continue;
    }
    if (includeDocs) {
      const name = basename(asset.logicalPath).toLocaleLowerCase("en-US") === "readme.md" ? "README.md" : `docs/${basename(asset.logicalPath)}`;
      addFile(name, loaded.bytes, asset.mediaType);
    }
  }

  if (!fileMap.has("preview.png")) throw new Error("Open Figure publication is missing a generated PNG preview");
  const canonicalCode = [...fileMap.keys()].find((pathValue) => pathValue.startsWith("code/organized.")) ??
    [...fileMap.keys()].find((pathValue) => pathValue.startsWith("code/"));
  if (!canonicalCode) throw new Error("Open Figure publication is missing canonical code");
  const thumbnail = jpegThumbnail(fileMap.get("preview.png")!);
  addFile("thumbnail.jpg", thumbnail, "image/jpeg");

  const dataFiles = [...fileMap.keys()].filter((pathValue) => pathValue.startsWith("data/")).sort(compareCanonicalStrings);
  if (dataFiles[0] && extension(dataFiles[0]) === ".csv" && !fileMap.has("data_schema.yml")) {
    addFile("data_schema.yml", utf8(csvSchema(fileMap.get(dataFiles[0])!)), "application/yaml");
  }

  const title = options.content.title.trim();
  if (!title) throw new Error("Open Figure publication requires a title");
  const titleEnInfo = deriveTitleEn(title, moduleId);
  const projection = resolveFigureDescription(options.content.description, options.content.application);
  const description = projection.description.trim() || title;
  const application = projection.application.trim() || "未单独记录。此历史模板尚未提供独立应用场景。";
  const scientificQuestion = options.content.scientificQuestion?.trim();
  const dataProfile = options.content.dataProfile.trim() || "Example or synthetic plotting inputs.";
  const tags = uniqueSorted(options.content.tags.length ? options.content.tags : [moduleId, options.content.plotFamily]);
  const packages = uniqueSorted(options.content.packages);
  if (!fileMap.has("README.md")) {
    addFile(
      "README.md",
      utf8(`# ${title}\n\n${description}\n\nThis module is an Open Figure Modules submission prepared from a Local Published release. SFL does not execute the code.\n`),
      "text/markdown",
    );
  }
  // This generated public document uses the same confirmed fields as module.yml.
  // Never retain a divergent uploaded description as a second source of truth.
  fileMap.delete("description.md");
  usedPaths.delete("description.md");
  addFile("description.md", utf8(figureDescriptionMarkdown({ title, description, application, dataProfile })), "text/markdown");
  if (!fileMap.has("provenance.md")) {
    addFile(
      "provenance.md",
      utf8(`Prepared from Local Published entry \`${moduleId}\`.\nInternal Library revisions, receipts, locators, and absolute paths are not distributed.\n`),
      "text/markdown",
    );
  }
  const codeFiles = [...fileMap.keys()].filter((pathValue) => pathValue.startsWith("code/")).sort(compareCanonicalStrings);
  const inputFiles = [...fileMap.keys()].filter((pathValue) => pathValue.startsWith("data/") && pathValue !== "data_schema.yml").sort(compareCanonicalStrings);
  const executionStatus = options.content.validationState?.plotExecution.status ??
    (options.content.executionStatus === "passed" || options.content.executionStatus === "failed" || options.content.executionStatus === "not_run"
      ? options.content.executionStatus
      : "not_run");
  const executionScope = options.content.validationState?.plotExecution.scope ?? "synthetic_data";
  const files = [...fileMap.keys(), "module.yml"].sort(compareCanonicalStrings);
  if (files.length > MAX_FILES) throw new Error("Open Figure module contains too many files");
  const requiredFiles = files.filter((pathValue) => pathValue !== "provenance.md");
  const previewStat = fileEntry("preview.png", fileMap.get("preview.png")!);
  const thumbnailStat = fileEntry("thumbnail.jpg", fileMap.get("thumbnail.jpg")!);
  const publisher = {
    reviewStatus: "approved" as const,
    executionStatus,
    executionScope,
    ...(executionStatus === "passed" ? { evidence: ["preview.png"] } : {}),
  };
  const moduleYaml = yamlModule({
    moduleId,
    title,
    titleEn: titleEnInfo.titleEn,
    description,
    application,
    ...(scientificQuestion ? { scientificQuestion } : {}),
    dataProfile,
    plotFamily: options.content.plotFamily,
    language: options.content.language,
    tags,
    packages,
    codeFiles,
    inputFiles,
    canonicalCode,
    requiredFiles,
    files,
    preview: { path: "preview.png", bytes: previewStat.bytes.byteLength, sha256: previewStat.sha256, mediaType: "image/png" },
    thumbnail: { path: "thumbnail.jpg", bytes: thumbnailStat.bytes.byteLength, sha256: thumbnailStat.sha256, mediaType: "image/jpeg" },
    publisher,
  });
  addFile("module.yml", utf8(moduleYaml), "application/yaml");
  const finalFiles = [...fileMap.entries()]
    .map(([pathValue, bytes]) => fileEntry(pathValue, bytes))
    .sort((left, right) => compareCanonicalStrings(left.path, right.path));
  const listed = finalFiles.map((file) => file.path);
  if (canonicalJson(listed) !== canonicalJson([...listed].sort(compareCanonicalStrings))) {
    throw new Error("Open Figure module file list is not canonically ordered");
  }
  return {
    moduleId,
    title,
    titleEn: titleEnInfo.titleEn,
    titleEnDerived: titleEnInfo.derived,
    description,
    application,
    ...(scientificQuestion ? { scientificQuestion } : {}),
    dataProfile,
    plotFamily: options.content.plotFamily,
    language: options.content.language,
    tags,
    packages,
    canonicalCode,
    canonicalCodeSha256: finalFiles.find((file) => file.path === canonicalCode)!.sha256,
    previewSha256: previewStat.sha256,
    files: finalFiles,
    excludedLogicalPaths: uniqueSorted(excludedLogicalPaths),
    searchQuery: buildSearchQuery(options.content),
  };
}

export function archiveOpenFigureModule(files: OpenFigureModuleFile[]) {
  const archive = Object.fromEntries(files.map((file) => [file.path, file.bytes]));
  const bytes = zipSync(archive, { level: 6, mtime: SOURCE_DATE_EPOCH });
  const unpacked = unzipSync(bytes);
  const expected = files.map((file) => file.path).sort(compareCanonicalStrings);
  const actual = Object.keys(unpacked).sort(compareCanonicalStrings);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("Open Figure archive inventory mismatch");
  }
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Open Figure archive exceeds 100 MiB");
  return { bytes: new Uint8Array(bytes), sha256: sha256(bytes), files: expected };
}

export function stableJson(value: unknown) {
  const sortValue = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sortValue);
    if (isRecord(item)) {
      return Object.fromEntries(
        Object.keys(item).sort(compareCanonicalStrings).map((key) => [key, sortValue(item[key])]),
      );
    }
    return item;
  };
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}
