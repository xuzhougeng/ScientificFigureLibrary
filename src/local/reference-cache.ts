import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { compareCanonicalStrings } from "../canonical-json.ts";
import type { ProviderContext, ProviderRegistry } from "../provider-registry.ts";
import type { FigureYaModule, TemplateCandidate } from "../types.ts";
import {
  assertLocalPublishedExactSelector,
  FIGUREYA_PROVIDER_ID,
  PERSONAL_MODULE_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
} from "../providers.ts";
import { cacheFigureYaSourceArchive, inspectFigureYaSourcePack } from "../materialize.ts";
import { cacheModuleSourceArchive, inspectModuleSourcePack } from "../module-materialize.ts";
import { buildReferencePrompt, referenceHasCode } from "./reference-prompt.ts";
import { galleryCodeDirectory } from "./gallery-cache.ts";

export interface ReferencePackFiles {
  target: string;
  files: string[];
  hasCode: boolean;
  prompt: string;
}

export interface ReferenceCacheStatus {
  candidateId: string;
  image: "cached" | "missing";
  archive: "cached" | "missing" | "not_applicable";
  pack?: ReferencePackFiles;
  error?: string;
}

const selection = z.object({ resultSetId: z.string().min(1), candidateId: z.string().min(1) });
const CACHE_JSON = "cache.json";
const MAX_PACK_FILES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reject redirected cache parents, including on read-only status requests. */
async function regularPath(root: string, target: string) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Reference path escapes the Library");
  let current = root;
  for (const part of ["", ...relative.split(path.sep)]) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Reference cache cannot traverse symbolic links");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function listRegularFiles(root: string) {
  const files: string[] = [];
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`reference pack contains a symlink: ${relative}`);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) {
        if (files.length >= MAX_PACK_FILES) throw new Error("reference pack contains too many files");
        files.push(relative);
      } else throw new Error(`reference pack contains a non-regular entry: ${relative}`);
    }
  };
  await walk(root);
  return files;
}

function toPack(candidate: TemplateCandidate, target: string, files: string[]): ReferencePackFiles {
  const usable = files.filter((file) => file !== CACHE_JSON);
  return {
    target,
    files: usable,
    hasCode: referenceHasCode(usable),
    prompt: buildReferencePrompt(candidate, target, usable),
  };
}

async function readCacheJson(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function templateCacheMatches(
  value: unknown,
  expected: { schema: string; moduleId: string; sourceCommit: string; archiveCommit: string; archiveSha256?: string },
) {
  if (!isRecord(value) || value.schema !== expected.schema) return false;
  if (value.moduleId !== expected.moduleId) return false;
  if (value.sourceCommit !== expected.sourceCommit || value.archiveCommit !== expected.archiveCommit) return false;
  if (expected.archiveSha256 && value.archiveSha256 !== expected.archiveSha256) return false;
  return true;
}

async function readTemplatePack(
  libraryRoot: string,
  cacheRoot: string,
  candidate: TemplateCandidate,
  expected: { schema: string; moduleId: string; sourceCommit: string; archiveCommit: string; archiveSha256?: string },
) {
  await regularPath(libraryRoot, cacheRoot);
  let stat;
  try {
    stat = await fs.lstat(cacheRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  const metadata = await readCacheJson(path.join(cacheRoot, CACHE_JSON));
  if (!templateCacheMatches(metadata, expected)) return undefined;
  return toPack(candidate, cacheRoot, await listRegularFiles(cacheRoot));
}

export function createReferenceCache(options: {
  registry: ProviderRegistry;
  context(): Promise<ProviderContext>;
  candidate(resultSetId: string, candidateId: string): Promise<TemplateCandidate>;
}) {
  const figureYaModule = (context: ProviderContext, candidate: TemplateCandidate) =>
    context.catalog.catalog.modules.find((item) => item.moduleId === candidate.templateId);

  const openModule = (context: ProviderContext, candidate: TemplateCandidate) =>
    context.moduleCatalogs?.get(PERSONAL_MODULE_PROVIDER_ID)?.get(candidate.templateId);

  async function localPublishedPack(context: ProviderContext, candidate: TemplateCandidate) {
    assertLocalPublishedExactSelector(candidate.exactSelector);
    const identity = candidate.exactSelector.identity;
    const content = await context.library.versionedLibrary.getContent(
      identity.templateId,
      identity.revisionId,
      identity.contentDigest,
    );
    if (!content) throw new Error("Local Published content is unavailable");
    const target = path.join(
      context.library.versionedLibrary.templatesDirectory,
      identity.templateId,
      "revisions",
      identity.revisionId,
    );
    await regularPath(context.library.snapshot.root, target);
    return toPack(candidate, target, content.assets.map((asset) => asset.file));
  }

  async function figureYaPack(
    context: ProviderContext,
    candidate: TemplateCandidate,
    module: FigureYaModule,
    sourcePackDir: string,
  ) {
    return readTemplatePack(context.library.snapshot.root, path.join(sourcePackDir, "templates", module.moduleId), candidate, {
      schema: "figure-library.figureya-cache.v1",
      moduleId: module.moduleId,
      sourceCommit: context.catalog.catalog.figureya.commit,
      archiveCommit: context.catalog.catalog.compressed.commit,
      ...(module.archiveSha256 ? { archiveSha256: module.archiveSha256 } : {}),
    });
  }

  async function openModulesPack(context: ProviderContext, candidate: TemplateCandidate, sourcePackDir: string) {
    const module = openModule(context, candidate);
    if (!module) return undefined;
    return readTemplatePack(context.library.snapshot.root, path.join(sourcePackDir, "templates", module.moduleId), candidate, {
      schema: "figure-library.open-modules-cache.v1",
      moduleId: module.moduleId,
      sourceCommit: module.source.commit,
      archiveCommit: module.archive.commit,
      archiveSha256: module.archive.sha256,
    });
  }

  async function sourcePackIds(context: ProviderContext, providerId: string, directory: string) {
    try {
      if (providerId === FIGUREYA_PROVIDER_ID) {
        return new Set((await inspectFigureYaSourcePack(context.catalog.catalog, directory, { verifyArchives: false })).availableTemplates);
      }
      if (providerId === PERSONAL_MODULE_PROVIDER_ID) {
        const index = context.moduleCatalogs?.get(providerId);
        if (!index) return new Set<string>();
        return new Set((await inspectModuleSourcePack(index, directory, { verifyArchives: false })).availableTemplates);
      }
    } catch {
      /* Status must not fail the whole page if a source pack is unreadable. */
    }
    return new Set<string>();
  }

  async function cachedImage(context: ProviderContext, candidate: TemplateCandidate): Promise<ReferenceCacheStatus["image"]> {
    const adapter = options.registry.get(candidate.providerId);
    try {
      const offline = { ...context, allowPreviewDownload: false };
      const resolved = await adapter.resolve(offline, candidate.exactSelector, "preview");
      await adapter.loadPreview(offline, resolved);
      return "cached";
    } catch {
      return "missing";
    }
  }

  async function packStatus(context: ProviderContext, candidate: TemplateCandidate): Promise<Pick<ReferenceCacheStatus, "archive" | "pack">> {
    if (candidate.providerId === LOCAL_LIBRARY_PROVIDER_ID) {
      try {
        return { archive: "cached", pack: await localPublishedPack(context, candidate) };
      } catch {
        return { archive: "missing" };
      }
    }
    if (candidate.providerId !== FIGUREYA_PROVIDER_ID && candidate.providerId !== PERSONAL_MODULE_PROVIDER_ID) {
      return { archive: "not_applicable" };
    }
    if (!candidate.materializable) return { archive: "not_applicable" };
    const directory = galleryCodeDirectory(context.library.snapshot.root, candidate.providerId);
    const ids = await sourcePackIds(context, candidate.providerId, directory);
    const zipCached = ids.has(candidate.templateId);
    const pack =
      candidate.providerId === FIGUREYA_PROVIDER_ID
        ? await (async () => {
            const module = figureYaModule(context, candidate);
            return module ? figureYaPack(context, candidate, module, directory) : undefined;
          })()
        : await openModulesPack(context, candidate, directory);
    return { archive: zipCached || pack ? "cached" : "missing", ...(pack ? { pack } : {}) };
  }

  async function ensureProviderPack(context: ProviderContext, candidate: TemplateCandidate, allowNetwork: boolean) {
    if (candidate.providerId === LOCAL_LIBRARY_PROVIDER_ID) return localPublishedPack(context, candidate);
    const directory = galleryCodeDirectory(context.library.snapshot.root, candidate.providerId);
    if (candidate.providerId === FIGUREYA_PROVIDER_ID) {
      const module = figureYaModule(context, candidate);
      if (!module?.archiveAvailable) throw new Error("此参考没有可获取的固定版本参考包");
      const existing = await figureYaPack(context, candidate, module, directory);
      if (existing) return existing;
      await fs.rm(path.join(directory, "templates", module.moduleId), { recursive: true, force: true });
      await cacheFigureYaSourceArchive(context.catalog.catalog, module, directory, allowNetwork, true);
      const pack = await figureYaPack(context, candidate, module, directory);
      if (!pack) throw new Error("参考包已下载，但未能展开为可复制的文件");
      return pack;
    }
    if (candidate.providerId === PERSONAL_MODULE_PROVIDER_ID) {
      const index = context.moduleCatalogs?.get(PERSONAL_MODULE_PROVIDER_ID);
      const module = openModule(context, candidate);
      if (!index || !module) throw new Error("此参考没有可获取的固定版本参考包");
      const existing = await openModulesPack(context, candidate, directory);
      if (existing) return existing;
      await fs.rm(path.join(directory, "templates", module.moduleId), { recursive: true, force: true });
      await cacheModuleSourceArchive(index, module, directory, allowNetwork, true);
      const pack = await openModulesPack(context, candidate, directory);
      if (!pack) throw new Error("参考包已下载，但未能展开为可复制的文件");
      return pack;
    }
    throw new Error("此来源没有参考包缓存；请使用「保存到项目」导出，不要另建第三份缓存");
  }

  return {
    status: async (raw: unknown) => {
      const input = z.object({ resultSetId: z.string().min(1), candidateIds: z.array(z.string().min(1)).min(1).max(12) }).strict().parse(raw);
      const context = await options.context();
      const items: ReferenceCacheStatus[] = [];
      for (const candidateId of [...new Set(input.candidateIds)]) {
        const candidate = await options.candidate(input.resultSetId, candidateId);
        const image = await cachedImage(context, candidate);
        try {
          const pack = await packStatus(context, candidate);
          items.push({ candidateId, image, ...pack });
        } catch (error) {
          items.push({
            candidateId,
            image,
            archive: "missing",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { items };
    },
    ensure: async (raw: unknown) => {
      const input = selection.extend({ allowNetwork: z.boolean() }).strict().parse(raw);
      const candidate = await options.candidate(input.resultSetId, input.candidateId);
      const context = await options.context();
      if (!candidate.materializable) throw new Error("此参考没有可获取的固定版本包");
      const pack = await ensureProviderPack(context, candidate, input.allowNetwork);
      return { archive: "cached" as const, pack };
    },
  };
}
