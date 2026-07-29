import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync, type UnzipFileInfo } from "fflate";
import type { FigureYaCatalog, FigureYaModule } from "./types.ts";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;

export type MaterializeMode = "template" | "full";
export type ArchiveSource = "source-pack" | "network";

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
    /\.(?:rmd|r|py|sh|md|json|ya?ml)$/u.test(name)
  );
}

async function download(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
      headers: { "user-agent": "Scientific-Figure-Library/0.1" },
    });
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? `: ${error.cause.message}`
        : "";
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

function verifyArchive(module: FigureYaModule, bytes: Uint8Array) {
  if (module.archiveBytes !== undefined && bytes.byteLength !== module.archiveBytes) {
    throw new Error(
      `size mismatch: expected ${module.archiveBytes} bytes, got ${bytes.byteLength}`,
    );
  }
  if (
    module.archiveGitBlobSha1 &&
    gitBlobSha1(bytes).toLocaleLowerCase() !== module.archiveGitBlobSha1.toLocaleLowerCase()
  ) {
    throw new Error("Git blob SHA-1 mismatch");
  }
}

function sourcePackCandidates(directory: string, moduleId: string) {
  const root = path.resolve(directory);
  const file = `${moduleId}.zip`;
  return [path.join(root, file), path.join(root, "archives", file)];
}

async function readSourcePackArchive(directory: string, module: FigureYaModule) {
  for (const file of sourcePackCandidates(directory, module.moduleId)) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds 100 MiB limit");
      const bytes = new Uint8Array(await fs.readFile(file));
      verifyArchive(module, bytes);
      return { bytes, location: file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  const failures = [];
  const sourcePackDir =
    options.sourcePackDir ?? process.env.FIGUREYA_SOURCE_PACK_DIR?.trim();
  if (sourcePackDir) {
    try {
      const local = await readSourcePackArchive(sourcePackDir, options.module);
      return { ...local, source: "source-pack" as const };
    } catch (error) {
      failures.push(`source pack: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.allowNetwork) {
    for (const url of archiveUrls(options.catalog, options.module.moduleId)) {
      try {
        const bytes = await download(url);
        verifyArchive(options.module, bytes);
        return { bytes, location: url, source: "network" as const };
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const packHint =
    "Provide sourcePackDir containing <moduleId>.zip (or archives/<moduleId>.zip)";
  throw new Error(
    `archive unavailable. ${failures.join(" | ") || "network access is disabled"}. ${packHint}; ` +
      "do not download the complete FigureYa repository.",
  );
}

export async function inspectFigureYaSourcePack(
  catalog: FigureYaCatalog,
  directory = process.env.FIGUREYA_SOURCE_PACK_DIR?.trim(),
) {
  if (!directory) {
    return {
      configured: false,
      directory: "",
      availableTemplates: [] as string[],
      invalidTemplates: [] as string[],
      missingCount: catalog.modules.filter((module) => module.archiveAvailable).length,
      availableBytes: 0,
      archiveCommit: catalog.compressed.commit,
    };
  }

  const availableTemplates = [];
  const invalidTemplates = [];
  let availableBytes = 0;
  for (const module of catalog.modules) {
    if (!module.archiveAvailable) continue;
    let found = false;
    for (const file of sourcePackCandidates(directory, module.moduleId)) {
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) continue;
        found = true;
        if (module.archiveBytes !== undefined && stat.size !== module.archiveBytes) {
          invalidTemplates.push(module.moduleId);
        } else {
          availableTemplates.push(module.moduleId);
          availableBytes += stat.size;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          found = true;
          invalidTemplates.push(module.moduleId);
          break;
        }
      }
    }
    if (!found) continue;
  }

  return {
    configured: true,
    directory: path.resolve(directory),
    availableTemplates,
    invalidTemplates,
    missingCount:
      catalog.modules.filter((module) => module.archiveAvailable).length -
      availableTemplates.length -
      invalidTemplates.length,
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

async function extract(
  bytes: Uint8Array,
  destination: string,
  moduleId: string,
  mode: MaterializeMode,
) {
  let files = 0;
  let expanded = 0;
  const selected = new Set<string>();
  const contents = unzipSync(bytes, {
    filter(info: UnzipFileInfo) {
      const safe = validateArchivePath(info.name);
      files += 1;
      if (files > MAX_FILES) throw new Error("archive contains too many entries");
      const include = !safe.endsWith("/") && (mode === "full" || shouldIncludeTemplateFile(safe));
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
  const prefix = stripCommonRoot(names, moduleId);
  const written = [];
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

function templateMarkdown(
  module: FigureYaModule,
  catalog: FigureYaCatalog,
  sha256: string,
  archiveSource: ArchiveSource,
  archiveLocation: string,
) {
  return `# ${module.moduleId}

This Scientific Figure Library template contains an untouched upstream FigureYa
module selected as reference material. Adapt it in a separate file; do not edit
\`upstream/\`.

## Why this module exists

${module.requirement || module.application || "See the upstream report for details."}

## Expected inputs

${module.inputSummary || module.inputFiles.map((file) => `- ${file}`).join("\n") || "Inspect the Rmd before mapping user data."}

## Safety

- No downloaded code has been executed.
- Do not run \`install_dependencies.R\` automatically.
- Review network access, package installation, and file paths before execution.

## Provenance

- FigureYa source: ${module.sourceUrl}
- FigureYa commit: \`${catalog.figureya.commit}\`
- Compressed repository commit: \`${catalog.compressed.commit}\`
- Archive source: ${archiveSource}
- Archive location: ${archiveLocation}
- Download SHA-256: \`${sha256}\`
- License: CC BY-NC-SA 4.0
- Citation: ${catalog.citation}
`;
}

export async function materializeFigureYaTemplate(options: {
  catalog: FigureYaCatalog;
  module: FigureYaModule;
  destination: string;
  mode: MaterializeMode;
  sourcePackDir?: string;
  allowNetwork?: boolean;
}) {
  const { catalog, module, mode } = options;
  if (!module.archiveAvailable) {
    throw new Error(`no pinned archive is available for ${module.moduleId}`);
  }

  const parent = path.resolve(options.destination);
  const target = path.join(parent, module.moduleId);
  try {
    await fs.access(target);
    throw new Error(`target already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    const { bytes } = acquired;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const writtenFiles = await extract(bytes, staging, module.moduleId, mode);
    await fs.writeFile(
      path.join(staging, "TEMPLATE.md"),
      templateMarkdown(
        module,
        catalog,
        sha256,
        acquired.source,
        acquired.location,
      ),
    );
    const lock = {
      schema: "figure-library.template-lock.v1",
      templateId: module.moduleId,
      sourceId: "figureya",
      mode,
      createdAt: new Date().toISOString(),
      sourceRepository: catalog.figureya.repository,
      sourceCommit: catalog.figureya.commit,
      archiveRepository: catalog.compressed.repository,
      archiveCommit: catalog.compressed.commit,
      archiveSource: acquired.source,
      archiveLocation: acquired.location,
      archiveUrl: acquired.source === "network" ? acquired.location : undefined,
      archiveSha256: sha256,
      license: "CC BY-NC-SA 4.0",
      citation: catalog.citation,
      files: writtenFiles,
    };
    await fs.writeFile(
      path.join(staging, "template.lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`,
    );
    await fs.rename(staging, target);
    return {
      target,
      archiveSource: acquired.source,
      archiveLocation: acquired.location,
      sha256,
      files: writtenFiles,
    };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
