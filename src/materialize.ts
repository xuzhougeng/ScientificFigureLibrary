import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync, type UnzipFileInfo } from "fflate";
import {
  FIGUREYA_PROVIDER_ID,
  assertFigureYaExactSelector,
  assertFigureYaSelectorMatches,
  canonicalSelectorJson,
  figureYaArchiveIdentity,
  figureYaExactSelector,
} from "./providers.ts";
import type {
  FigureYaCatalog,
  FigureYaExactSelector,
  FigureYaModule,
  MaterializeMode,
  StoredFile,
} from "./types.ts";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type { MaterializeMode } from "./types.ts";
export type ArchiveSource = "source-pack" | "network" | "existing";

interface SourcePackArchive {
  moduleId: string;
  file: string;
  bytes: number;
  gitBlobSha1?: string;
  sha256?: string;
}

interface SourcePackManifest {
  schema: "figure-library.source-pack.v1" | "figure-library.source-pack.v2";
  providerId: typeof FIGUREYA_PROVIDER_ID;
  archiveRepository: string;
  archiveCommit: string;
  archives: SourcePackArchive[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function figureYaMaterializePlanDigest(selector: FigureYaExactSelector): string {
  assertFigureYaExactSelector(selector);
  return sha256(`figure-library.materialize-plan.v1\n${canonicalSelectorJson(selector)}`);
}

function validateOperation(operationId?: string, planDigest?: string) {
  if ((operationId === undefined) !== (planDigest === undefined)) {
    throw new Error("operationId and planDigest must be supplied together");
  }
  if (operationId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(operationId)) {
    throw new Error("operationId must be a portable token of at most 200 characters");
  }
  if (planDigest !== undefined && !SHA256.test(planDigest)) {
    throw new Error("planDigest must be a lowercase SHA-256 digest");
  }
}

export function validateArchivePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new Error(`unsafe archive path: ${value}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) throw new Error(`unsafe archive path: ${value}`);
  return parts.join("/");
}

export function shouldIncludeTemplateFile(value: string): boolean {
  const name = path.posix.basename(value).toLocaleLowerCase();
  return (
    /^easy_input/u.test(name) ||
    /^example\.(?:png|jpe?g|webp|svg|pdf)$/u.test(name) ||
    name === "install_dependencies.r" ||
    name === "readme.md" ||
    /\.(?:rmd|qmd|r|py|ipynb|jl|m|sh|md|json|ya?ml)$/u.test(name)
  );
}

async function download(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
      headers: { "user-agent": "Scientific-Figure-Library/0.5" },
    });
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    throw new Error(
      `network request failed (${error instanceof Error ? error.message : String(error)}${cause})`,
    );
  }
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} ${response.statusText})`);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds 100 MiB limit");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error("archive exceeds 100 MiB limit");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function verifyArchive(
  module: FigureYaModule,
  bytes: Uint8Array,
  sourcePackEntry?: SourcePackArchive,
) {
  const catalogIdentity = figureYaArchiveIdentity(module);
  if (bytes.byteLength !== catalogIdentity.bytes) {
    throw new Error(
      `size mismatch: expected ${catalogIdentity.bytes} bytes, got ${bytes.byteLength}`,
    );
  }
  const actualSha256 = sha256(bytes);
  const actualGitBlobSha1 = gitBlobSha1(bytes);
  if (catalogIdentity.algorithm === "sha256" && actualSha256 !== catalogIdentity.digest) {
    throw new Error("SHA-256 mismatch");
  }
  if (
    catalogIdentity.algorithm === "git-blob-sha1" &&
    actualGitBlobSha1 !== catalogIdentity.digest
  ) {
    throw new Error("Git blob SHA-1 mismatch");
  }
  if (module.archiveSha256 && actualSha256 !== module.archiveSha256.toLocaleLowerCase()) {
    throw new Error("catalog SHA-256 mismatch");
  }
  if (
    module.archiveGitBlobSha1 &&
    actualGitBlobSha1 !== module.archiveGitBlobSha1.toLocaleLowerCase()
  ) {
    throw new Error("catalog Git blob SHA-1 mismatch");
  }
  if (sourcePackEntry) {
    if (bytes.byteLength !== sourcePackEntry.bytes) throw new Error("Source Pack size mismatch");
    if (sourcePackEntry.sha256 && actualSha256 !== sourcePackEntry.sha256) {
      throw new Error("Source Pack SHA-256 mismatch");
    }
    if (sourcePackEntry.gitBlobSha1 && actualGitBlobSha1 !== sourcePackEntry.gitBlobSha1) {
      throw new Error("Source Pack Git blob SHA-1 mismatch");
    }
  }
  return { sha256: actualSha256, gitBlobSha1: actualGitBlobSha1 };
}

function validateSourcePackEntry(value: unknown, schema: SourcePackManifest["schema"]): SourcePackArchive {
  if (!isRecord(value)) throw new Error("Source Pack archive entry must be an object");
  if (typeof value.moduleId !== "string" || !value.moduleId) {
    throw new Error("Source Pack archive moduleId is missing");
  }
  if (typeof value.file !== "string") throw new Error(`${value.moduleId}.file is missing`);
  const file = validateArchivePath(value.file);
  if (path.posix.basename(file) !== `${value.moduleId}.zip`) {
    throw new Error(`${value.moduleId}.file must name ${value.moduleId}.zip`);
  }
  if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0) {
    throw new Error(`${value.moduleId}.bytes is invalid`);
  }
  const gitSha =
    typeof value.gitBlobSha1 === "string" ? value.gitBlobSha1.toLocaleLowerCase() : undefined;
  const archiveSha = typeof value.sha256 === "string" ? value.sha256.toLocaleLowerCase() : undefined;
  if (gitSha && !SHA1.test(gitSha)) throw new Error(`${value.moduleId}.gitBlobSha1 is invalid`);
  if (archiveSha && !SHA256.test(archiveSha)) throw new Error(`${value.moduleId}.sha256 is invalid`);
  if (schema === "figure-library.source-pack.v2" && !archiveSha) {
    throw new Error(`${value.moduleId} lacks the SHA-256 required by Source Pack v2`);
  }
  if (!archiveSha && !gitSha) {
    throw new Error(`${value.moduleId} has no archive integrity identity`);
  }
  return {
    moduleId: value.moduleId,
    file,
    bytes: Number(value.bytes),
    gitBlobSha1: gitSha,
    sha256: archiveSha,
  };
}

export function validateFigureYaSourcePackManifest(
  value: unknown,
  catalog: FigureYaCatalog,
): SourcePackManifest {
  if (!isRecord(value)) throw new Error("Source Pack manifest must be an object");
  if (
    value.schema !== "figure-library.source-pack.v1" &&
    value.schema !== "figure-library.source-pack.v2"
  ) {
    throw new Error(`unsupported Source Pack schema: ${String(value.schema)}`);
  }
  const schema = value.schema;
  const providerId =
    value.providerId === FIGUREYA_PROVIDER_ID ||
    (schema === "figure-library.source-pack.v1" && value.sourceId === "figureya")
      ? FIGUREYA_PROVIDER_ID
      : undefined;
  if (!providerId) throw new Error("Source Pack providerId is not FigureYa");
  if (value.archiveRepository !== catalog.compressed.repository) {
    throw new Error("Source Pack archive repository does not match the catalog");
  }
  if (value.archiveCommit !== catalog.compressed.commit) {
    throw new Error("Source Pack archive commit does not match the catalog");
  }
  if (!Array.isArray(value.archives)) throw new Error("Source Pack archives must be an array");

  const catalogById = new Map(catalog.modules.map((module) => [module.moduleId, module]));
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const archives = value.archives.map((item) => {
    const entry = validateSourcePackEntry(item, schema);
    if (seenIds.has(entry.moduleId)) throw new Error(`duplicate Source Pack module: ${entry.moduleId}`);
    if (seenFiles.has(entry.file)) throw new Error(`duplicate Source Pack file: ${entry.file}`);
    seenIds.add(entry.moduleId);
    seenFiles.add(entry.file);
    const module = catalogById.get(entry.moduleId);
    if (!module?.archiveAvailable) {
      throw new Error(`Source Pack contains unavailable/unknown module: ${entry.moduleId}`);
    }
    const identity = figureYaArchiveIdentity(module);
    if (entry.bytes !== identity.bytes) throw new Error(`${entry.moduleId} size disagrees with catalog`);
    if (module.archiveSha256 && entry.sha256 !== module.archiveSha256.toLocaleLowerCase()) {
      throw new Error(`${entry.moduleId} SHA-256 disagrees with catalog`);
    }
    if (
      module.archiveGitBlobSha1 &&
      entry.gitBlobSha1 &&
      entry.gitBlobSha1 !== module.archiveGitBlobSha1.toLocaleLowerCase()
    ) {
      throw new Error(`${entry.moduleId} Git blob SHA-1 disagrees with catalog`);
    }
    return entry;
  });
  if (archives.length === 0) throw new Error("Source Pack manifest contains no archives");
  return {
    schema,
    providerId,
    archiveRepository: catalog.compressed.repository,
    archiveCommit: catalog.compressed.commit,
    archives,
  };
}

function sourcePackCandidates(directory: string, entry: SourcePackArchive) {
  const root = path.resolve(directory);
  const basename = `${entry.moduleId}.zip`;
  return [
    path.resolve(root, ...entry.file.split("/")),
    path.join(root, basename),
    path.join(root, "archives", basename),
  ].filter((file, index, files) => files.indexOf(file) === index);
}

async function loadSourcePack(directory: string, catalog: FigureYaCatalog) {
  const root = path.resolve(directory);
  const manifestFile = path.join(root, "figureya-source-pack.manifest.json");
  const raw = await fs.readFile(manifestFile);
  const manifest = validateFigureYaSourcePackManifest(JSON.parse(raw.toString("utf8")), catalog);
  return { root, manifest, manifestSha256: sha256(raw) };
}

async function readSourcePackArchive(
  directory: string,
  catalog: FigureYaCatalog,
  module: FigureYaModule,
) {
  const pack = await loadSourcePack(directory, catalog);
  const entry = pack.manifest.archives.find((item) => item.moduleId === module.moduleId);
  if (!entry) throw new Error(`Source Pack manifest does not list ${module.moduleId}`);
  for (const file of sourcePackCandidates(pack.root, entry)) {
    const relative = path.relative(pack.root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`unsafe Source Pack archive path: ${entry.file}`);
    }
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds 100 MiB limit");
      const bytes = new Uint8Array(await fs.readFile(file));
      const identity = verifyArchive(module, bytes, entry);
      return { bytes, location: file, manifestSha256: pack.manifestSha256, identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`missing ${module.moduleId}.zip`);
}

function archiveUrls(catalog: FigureYaCatalog, moduleId: string) {
  const mirrors = (process.env.FIGUREYA_ARCHIVE_BASE_URLS ?? "")
    .split(/[,;\n]/u)
    .map((value) => value.trim().replace(/\/+$/u, ""))
    .filter(Boolean)
    .map((base) => `${base}/${encodeURIComponent(moduleId)}.zip`);
  const upstream =
    `${catalog.compressed.repository.replace("github.com", "raw.githubusercontent.com")}/` +
    `${catalog.compressed.commit}/${encodeURIComponent(moduleId)}.zip`;
  return [...new Set([...mirrors, upstream])];
}

async function acquireArchive(options: {
  catalog: FigureYaCatalog;
  module: FigureYaModule;
  sourcePackDir?: string;
  allowNetwork: boolean;
}) {
  const failures: string[] = [];
  const sourcePackDir = options.sourcePackDir ?? process.env.FIGUREYA_SOURCE_PACK_DIR?.trim();
  if (sourcePackDir) {
    try {
      const local = await readSourcePackArchive(sourcePackDir, options.catalog, options.module);
      return { ...local, source: "source-pack" as const };
    } catch (error) {
      failures.push(`source pack: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.allowNetwork) {
    for (const url of archiveUrls(options.catalog, options.module.moduleId)) {
      try {
        const bytes = await download(url);
        const identity = verifyArchive(options.module, bytes);
        return { bytes, location: url, source: "network" as const, identity };
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const packHint =
    "Provide sourcePackDir containing a validated figureya-source-pack.manifest.json and its archives";
  throw new Error(
    `archive unavailable. ${failures.join(" | ") || "network access is disabled"}. ${packHint}; ` +
      "do not download the complete FigureYa repository.",
  );
}

export async function inspectFigureYaSourcePack(
  catalog: FigureYaCatalog,
  directory = process.env.FIGUREYA_SOURCE_PACK_DIR?.trim(),
) {
  const expectedCount = catalog.modules.filter((module) => module.archiveAvailable).length;
  if (!directory) {
    return {
      configured: false,
      directory: "",
      manifestValid: false,
      ready: false,
      availableTemplates: [] as string[],
      invalidTemplates: [] as string[],
      missingCount: expectedCount,
      availableBytes: 0,
      archiveCommit: catalog.compressed.commit,
    };
  }

  let pack: Awaited<ReturnType<typeof loadSourcePack>>;
  try {
    pack = await loadSourcePack(directory, catalog);
  } catch (error) {
    return {
      configured: true,
      directory: path.resolve(directory),
      manifestValid: false,
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
      availableTemplates: [] as string[],
      invalidTemplates: [] as string[],
      missingCount: expectedCount,
      availableBytes: 0,
      archiveCommit: catalog.compressed.commit,
    };
  }

  const catalogById = new Map(catalog.modules.map((module) => [module.moduleId, module]));
  const availableTemplates: string[] = [];
  const invalidTemplates: string[] = [];
  let availableBytes = 0;
  for (const entry of pack.manifest.archives) {
    const module = catalogById.get(entry.moduleId);
    if (!module) {
      invalidTemplates.push(entry.moduleId);
      continue;
    }
    try {
      const result = await readSourcePackArchive(pack.root, catalog, module);
      availableTemplates.push(entry.moduleId);
      availableBytes += result.bytes.byteLength;
    } catch {
      invalidTemplates.push(entry.moduleId);
    }
  }

  return {
    configured: true,
    directory: pack.root,
    manifestValid: true,
    manifestSha256: pack.manifestSha256,
    ready: invalidTemplates.length === 0,
    availableTemplates: availableTemplates.sort(),
    invalidTemplates: invalidTemplates.sort(),
    missingCount: expectedCount - availableTemplates.length - invalidTemplates.length,
    availableBytes,
    archiveCommit: catalog.compressed.commit,
  };
}

function stripCommonRoot(entries: string[], moduleId: string) {
  const prefix = `${moduleId}/`;
  return entries.length > 0 && entries.every((entry) => entry === moduleId || entry.startsWith(prefix))
    ? prefix
    : "";
}

function matchesRequiredFile(safe: string, required: Set<string>) {
  return [...required].some(
    (item) => safe === item || safe.endsWith(`/${item}`) || path.posix.basename(safe) === item,
  );
}

async function extract(
  bytes: Uint8Array,
  destination: string,
  module: FigureYaModule,
  mode: MaterializeMode,
) {
  let files = 0;
  let expanded = 0;
  const selected = new Set<string>();
  const required = new Set(
    [module.canonicalCode, module.primaryPreview, ...(module.requiredFiles ?? [])]
      .filter((value): value is string => Boolean(value))
      .map((value) => validateArchivePath(value)),
  );
  const contents = unzipSync(bytes, {
    filter(info: UnzipFileInfo) {
      const safe = validateArchivePath(info.name);
      files += 1;
      if (files > MAX_FILES) throw new Error("archive contains too many entries");
      const include =
        !safe.endsWith("/") &&
        (mode === "full" || matchesRequiredFile(safe, required) || shouldIncludeTemplateFile(safe));
      if (!include) return false;
      if (info.originalSize > MAX_FILE_BYTES) throw new Error(`archive file is too large: ${safe}`);
      expanded += info.originalSize;
      if (expanded > MAX_EXPANDED_BYTES) throw new Error("expanded archive exceeds 128 MiB");
      selected.add(safe);
      return true;
    },
  });

  const entries = Object.entries(contents).map(([rawName, data]) => ({
    name: validateArchivePath(rawName),
    data,
  }));
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error("archive contains duplicate normalized paths");
  }
  const prefix = stripCommonRoot(names, module.moduleId);
  const written: string[] = [];
  for (const { name, data } of entries) {
    if (!selected.has(name) || name.endsWith("/")) continue;
    const relative = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!relative) continue;
    const output = path.join(destination, "upstream", ...relative.split("/"));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, data);
    written.push(path.posix.join("upstream", relative));
  }
  if (written.length === 0) throw new Error("archive contained no usable template files");
  return written.sort();
}

function assetBucket(file: string): "visuals" | "code" | "references" {
  const extension = path.posix.extname(file).toLocaleLowerCase();
  if ([".r", ".rmd", ".qmd", ".py", ".ipynb", ".jl", ".m", ".sh"].includes(extension)) {
    return "code";
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf", ".tif", ".tiff"].includes(extension)) {
    return "visuals";
  }
  return "references";
}

async function createNormalizedAssets(root: string, upstreamFiles: string[]) {
  for (const bucket of ["visuals", "code", "references", "evidence"]) {
    await fs.mkdir(path.join(root, "assets", bucket), { recursive: true });
  }
  const assets: Record<"visuals" | "code" | "references" | "evidence", string[]> = {
    visuals: [],
    code: [],
    references: [],
    evidence: [],
  };
  for (const upstreamFile of upstreamFiles) {
    const relative = upstreamFile.replace(/^upstream\//u, "");
    const bucket = assetBucket(relative);
    const destination = path.join(root, "assets", bucket, ...relative.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, ...upstreamFile.split("/")), destination);
    assets[bucket].push(path.posix.join("assets", bucket, relative));
  }
  return assets;
}

async function storedFile(root: string, relative: string): Promise<StoredFile> {
  const bytes = new Uint8Array(await fs.readFile(path.join(root, ...relative.split("/"))));
  return { file: relative, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function inventory(root: string, files: string[]): Promise<StoredFile[]> {
  const unique = [...new Set(files)].sort();
  return Promise.all(unique.map((file) => storedFile(root, file)));
}

function resolvedSelector(
  catalog: FigureYaCatalog,
  module: FigureYaModule,
  mode: MaterializeMode,
  archiveSha256: string,
): FigureYaExactSelector {
  return figureYaExactSelector(
    catalog,
    {
      ...module,
      archiveSha256,
      archiveIdentity: "sha256",
    },
    mode,
  );
}

function templateMarkdown(
  module: FigureYaModule,
  catalog: FigureYaCatalog,
  selector: FigureYaExactSelector,
) {
  return `# ${module.moduleId}

This materialization contains an untouched upstream FigureYa module plus a
normalized Scientific Figure Library asset envelope. Adapt upstream code in a
separate file; do not edit \`upstream/\` if exact replay is required.

## Why this module exists

${module.requirement || module.application || "See the upstream report for details."}

## Expected inputs

${module.inputSummary || module.inputFiles.map((file) => `- ${file}`).join("\n") || "Inspect the upstream code before mapping user data."}

## Review and execution state

- Upstream files are available as reference material.
- ScientificFigureLibrary has not locally approved or executed this code.
- No downloaded code has been executed during materialization.
- Do not run \`install_dependencies.R\` automatically.

## Portable provenance

- Provider: \`${FIGUREYA_PROVIDER_ID}\`
- Module: \`${module.moduleId}\`
- FigureYa commit: \`${catalog.figureya.commit}\`
- Compressed repository commit: \`${catalog.compressed.commit}\`
- Archive SHA-256: \`${selector.identity.archive.digest}\`
- License: CC BY-NC-SA 4.0
- Citation: ${catalog.citation}
`;
}

async function verifyExistingMaterialization(options: {
  target: string;
  plannedSelector: FigureYaExactSelector;
  operationId: string;
  planDigest: string;
}) {
  const lockPath = path.join(options.target, "template.lock.json");
  const lockBytes = new Uint8Array(await fs.readFile(lockPath));
  const lock: unknown = JSON.parse(Buffer.from(lockBytes).toString("utf8"));
  if (!isRecord(lock) || lock.schema !== "figure-library.template-lock.v2") {
    throw new Error(`target exists but has no compatible materialization lock: ${options.target}`);
  }
  if (!isRecord(lock.operation)) {
    throw new Error(`target exists but has no idempotent operation receipt: ${options.target}`);
  }
  if (
    lock.operation.operationId !== options.operationId ||
    lock.operation.planDigest !== options.planDigest
  ) {
    throw new Error(`target exists with a different operation or stale plan: ${options.target}`);
  }
  assertFigureYaExactSelector(lock.plannedSelector);
  if (canonicalSelectorJson(lock.plannedSelector) !== canonicalSelectorJson(options.plannedSelector)) {
    throw new Error(`target exists with a different exact selector: ${options.target}`);
  }
  assertFigureYaExactSelector(lock.exactSelector);
  const resolved = lock.exactSelector.identity;
  const planned = options.plannedSelector.identity;
  if (
    resolved.moduleId !== planned.moduleId ||
    resolved.sourceCommit !== planned.sourceCommit ||
    resolved.archiveCommit !== planned.archiveCommit ||
    resolved.mode !== planned.mode ||
    resolved.archive.algorithm !== "sha256" ||
    resolved.archive.bytes !== planned.archive.bytes ||
    lock.archiveSha256 !== resolved.archive.digest
  ) {
    throw new Error("existing materialization resolved selector does not match the plan");
  }
  if (!Array.isArray(lock.files)) throw new Error("materialization lock inventory is missing");
  const payload: StoredFile[] = [];
  for (const entry of lock.files) {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      !Number.isSafeInteger(entry.bytes) ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error("materialization lock inventory entry is invalid");
    }
    const relative = validateArchivePath(entry.file);
    const actual = await storedFile(options.target, relative);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`existing materialization failed integrity verification: ${relative}`);
    }
    payload.push(actual);
  }
  const lockFile = {
    file: "template.lock.json",
    bytes: lockBytes.byteLength,
    sha256: sha256(lockBytes),
  };
  const fileInventory = [...payload, lockFile].sort((left, right) =>
    left.file.localeCompare(right.file),
  );
  return {
    target: options.target,
    providerId: FIGUREYA_PROVIDER_ID,
    exactSelector: lock.exactSelector,
    plannedSelector: options.plannedSelector,
    archiveSource: "existing" as const,
    archiveLocation: undefined,
    sha256: String(lock.archiveSha256),
    files: fileInventory.map((file) => file.file),
    fileInventory,
    replayed: true,
  };
}

export async function materializeFigureYaTemplate(options: {
  catalog: FigureYaCatalog;
  module: FigureYaModule;
  destination: string;
  mode: MaterializeMode;
  exactSelector?: FigureYaExactSelector;
  operationId?: string;
  planDigest?: string;
  sourcePackDir?: string;
  allowNetwork?: boolean;
}) {
  const { catalog, module, mode } = options;
  if (!module.archiveAvailable) {
    throw new Error(`no pinned archive is available for ${module.moduleId}`);
  }
  const plannedSelector = figureYaExactSelector(catalog, module, mode);
  validateOperation(options.operationId, options.planDigest);
  if (options.exactSelector) {
    assertFigureYaSelectorMatches(options.exactSelector, catalog, module, mode);
  }
  // `planDigest` is intentionally opaque here. The public plan/apply layer
  // binds destination and acquisition policy in addition to this selector;
  // this storage layer validates the selector and durably echoes that digest.

  const parent = path.resolve(options.destination);
  const target = path.join(parent, module.moduleId);
  let targetExists = false;
  try {
    await fs.access(target);
    targetExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (targetExists) {
    if (options.operationId && options.planDigest) {
      return verifyExistingMaterialization({
        target,
        plannedSelector,
        operationId: options.operationId,
        planDigest: options.planDigest,
      });
    }
    throw new Error(`target already exists: ${target}`);
  }

  await fs.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.figure-library-${module.moduleId}-${randomUUID()}`);
  await fs.mkdir(staging);
  try {
    const acquired = await acquireArchive({
      catalog,
      module,
      sourcePackDir: options.sourcePackDir,
      allowNetwork: options.allowNetwork ?? true,
    });
    const exactSelector = resolvedSelector(catalog, module, mode, acquired.identity.sha256);
    const upstreamFiles = await extract(acquired.bytes, staging, module, mode);
    const assets = await createNormalizedAssets(staging, upstreamFiles);

    await fs.writeFile(
      path.join(staging, "TEMPLATE.md"),
      templateMarkdown(module, catalog, exactSelector),
    );
    const assetInventory = {
      visuals: await inventory(staging, assets.visuals),
      code: await inventory(staging, assets.code),
      references: await inventory(staging, assets.references),
      evidence: [] as StoredFile[],
    };
    const template = {
      schema: "figure-library.materialized-template.v1",
      providerId: FIGUREYA_PROVIDER_ID,
      exactSelector,
      templateId: module.moduleId,
      title: module.title,
      description: module.requirement,
      application: module.application,
      dataProfile: module.inputSummary,
      language: module.codeFiles.some((file) => /\.(?:r|rmd|qmd)$/iu.test(file)) ? "R" : "unknown",
      review: {
        localReviewStatus: "not_reviewed",
        upstreamStatus: "published",
        codeStatus: module.codeFiles.length ? "provided" : "none",
        executionStatus: "not_run",
      },
      assets: assetInventory,
      upstream: {
        sourceRepository: catalog.figureya.repository,
        sourceCommit: catalog.figureya.commit,
        archiveRepository: catalog.compressed.repository,
        archiveCommit: catalog.compressed.commit,
        files: await inventory(staging, upstreamFiles),
      },
      license: "CC BY-NC-SA 4.0",
      citation: catalog.citation,
    };
    await fs.writeFile(
      path.join(staging, "template.json"),
      `${JSON.stringify(template, null, 2)}\n`,
    );

    const payloadFiles = await inventory(staging, [
      "TEMPLATE.md",
      "template.json",
      ...upstreamFiles,
      ...assets.visuals,
      ...assets.code,
      ...assets.references,
      ...assets.evidence,
    ]);
    const lock = {
      schema: "figure-library.template-lock.v2",
      providerId: FIGUREYA_PROVIDER_ID,
      exactSelector,
      plannedSelector,
      selectorDigest: sha256(canonicalSelectorJson(exactSelector)),
      mode,
      sourceRepository: catalog.figureya.repository,
      sourceCommit: catalog.figureya.commit,
      archiveRepository: catalog.compressed.repository,
      archiveCommit: catalog.compressed.commit,
      archiveSha256: acquired.identity.sha256,
      archiveBytes: acquired.bytes.byteLength,
      license: "CC BY-NC-SA 4.0",
      citation: catalog.citation,
      inventoryPolicy: "all-output-files-except-this-lock",
      operation:
        options.operationId && options.planDigest
          ? { operationId: options.operationId, planDigest: options.planDigest }
          : undefined,
      files: payloadFiles,
    };
    await fs.writeFile(
      path.join(staging, "template.lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`,
    );
    const fileInventory = [
      ...payloadFiles,
      await storedFile(staging, "template.lock.json"),
    ].sort((left, right) => left.file.localeCompare(right.file));
    await fs.rename(staging, target);
    return {
      target,
      providerId: FIGUREYA_PROVIDER_ID,
      exactSelector,
      plannedSelector,
      archiveSource: acquired.source,
      archiveLocation: acquired.location,
      sha256: acquired.identity.sha256,
      files: fileInventory.map((file) => file.file),
      fileInventory,
      replayed: false,
    };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
