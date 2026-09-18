import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CatalogIndex } from "../catalog.ts";
import type { ModuleCatalogIndex } from "../module-catalog.ts";
import { cacheFigureYaSourceArchive } from "../materialize.ts";
import { cacheModuleSourceArchive } from "../module-materialize.ts";
import { FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID } from "../providers.ts";
import { cacheStateDatabase } from "./cache-state-db.ts";

export function galleryCodeDirectory(root: string, providerId: string) {
  return path.join(root, "source-packs", providerId === FIGUREYA_PROVIDER_ID ? "figureya" : "open-modules");
}

function previewFileIdentities(providerId: string, figureYa: CatalogIndex, modules: ModuleCatalogIndex | undefined) {
  if (providerId === FIGUREYA_PROVIDER_ID) {
    return figureYa.catalog.modules.flatMap(module => {
      const file = module.primaryPreview ?? module.thumbnail;
      return file && module.previewSha256 ? [{ sha256: module.previewSha256, extension: path.extname(file).toLowerCase() }] : [];
    });
  }
  return modules?.catalog.modules.flatMap(module => [
    { sha256: module.preview.sha256, extension: path.extname(module.preview.path).toLowerCase() },
    { sha256: module.thumbnail.sha256, extension: path.extname(module.thumbnail.path).toLowerCase() },
  ]) ?? [];
}

async function countCachedPreviewFiles(directory: string, identities: Array<{ sha256: string; extension: string }>) {
  const expected = new Set(identities.map(identity => `${identity.sha256}${identity.extension}`));
  if (!expected.size) return 0;
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  return names.filter(name => expected.has(name)).length;
}

async function countCachedArchiveFiles(directory: string): Promise<number> {
  let count = 0;
  const walk = async (current: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".zip")) count++;
    }
  };
  await walk(directory);
  return count;
}

export interface GalleryCacheTask {
  id: string; providerId: string; mode: string; state: "running" | "completed" | "failed";
  total: number; processed: number; currentItem: string; images: number; archives: number;
  failures: Array<{ item: string; message: string }>; error?: string;
}

export function createGalleryCache(options: {
  figureYa: CatalogIndex;
  modules(): ModuleCatalogIndex | undefined;
  library(): Promise<{ root: string; contextKey: string; writesEnabled: boolean }>;
}) {
  type Prepared = { plan: { planDigest: string; providerId: string; mode: string; images: number; archives: number; imageDirectory: string; codeDirectory: string }; root: string; contextKey: string; identity: string; expires: number; result?: Promise<unknown>; task?: GalleryCacheTask };
  const plans = new Map<string, Prepared>();
  const figureYaIdentity = JSON.stringify(options.figureYa.catalog);
  const identity = (providerId: string) => providerId === FIGUREYA_PROVIDER_ID
    ? figureYaIdentity
    : options.modules()?.catalogSha256;
  const api = {
    status: async () => {
      const library = await options.library();
      const stateDb = await cacheStateDatabase(library.root);
      const imageDirectory = path.join(library.root, "indexes", "preview-cache", "v1");
      let imageFiles = 0;
      try { imageFiles = (await fs.readdir(imageDirectory)).filter(name => /^[a-f0-9]{64}\.(png|jpe?g|webp|gif)$/u.test(name)).length; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const providers: Record<string, unknown> = {};
      for (const providerId of [FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID]) {
        const codeDirectory = galleryCodeDirectory(library.root, providerId);
        const sourceIdentity = identity(providerId) ?? "unknown";
        const archiveCount = providerId === FIGUREYA_PROVIDER_ID
          ? options.figureYa.catalog.modules.filter(item => item.archiveAvailable).length
          : options.modules()?.catalog.modules.length ?? 0;
        const cachedArchiveState = stateDb.get(providerId, "source-archive", sourceIdentity);
        let codeFiles = cachedArchiveState?.cacheRoot === codeDirectory ? cachedArchiveState.cachedCount : 0;
        if (!cachedArchiveState || cachedArchiveState.cacheRoot !== codeDirectory) {
          codeFiles = await countCachedArchiveFiles(codeDirectory);
          stateDb.put({ providerId, kind: "source-archive", sourceIdentity, cacheRoot: codeDirectory, declaredCount: archiveCount, cachedCount: codeFiles, missingCount: Math.max(0, archiveCount - codeFiles), bytesDeclared: 0, bytesCached: 0, lastScannedAt: new Date().toISOString() });
        }
        const identities = previewFileIdentities(providerId, options.figureYa, options.modules());
        const imageFilesForGallery = await countCachedPreviewFiles(imageDirectory, identities);
        const task = [...plans.values()].map(item => item.task).reverse().find(item => item?.providerId === providerId);
        providers[providerId] = {
          imageFiles: imageFilesForGallery,
          codeFiles,
          ...(cachedArchiveState?.lastCachedAt ? { lastCachedAt: cachedArchiveState.lastCachedAt } : {}),
          ...(task ? { task: structuredClone(task) } : {}),
        };
      }
      stateDb.close();
      return { imageFiles, providers };
    },
    tasks: () => ({ tasks: [...plans.values()].flatMap(item => item.task ? [structuredClone(item.task)] : []) }),
    start: (raw: unknown): { task: GalleryCacheTask } => {
      const input = z.object({ planDigest: z.string().uuid(), confirmedBy: z.literal("user") }).strict().parse(raw);
      const prepared = plans.get(input.planDigest);
      if (!prepared) throw new Error("缓存计划不存在，请重新生成。");
      if (prepared.task) return { task: structuredClone(prepared.task) };
      if ([...plans.values()].some(item => item.task?.state === "running" && item.plan.providerId === prepared.plan.providerId && item.root === prepared.root)) throw new Error("该图库已有缓存任务，请在任务进度中查看。");
      const task: GalleryCacheTask = { id: input.planDigest, providerId: prepared.plan.providerId, mode: prepared.plan.mode, state: "running", total: prepared.plan.images + prepared.plan.archives, processed: 0, currentItem: "准备中", images: 0, archives: 0, failures: [] };
      prepared.task = task;
      void api.apply(input).then(() => { task.state = "completed"; task.currentItem = ""; }, error => { task.state = "failed"; task.error = error instanceof Error ? error.message : String(error); });
      return { task: structuredClone(task) };
    },
    plan: async (raw: unknown) => {
      const input = z.object({ providerId: z.enum([FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID]), mode: z.enum(["images", "code", "update"]) }).strict().parse(raw);
      const library = await options.library();
      if (!library.writesEnabled) throw new Error("请先设置图库存储位置");
      const modules = options.modules();
      if (input.providerId === PERSONAL_MODULE_PROVIDER_ID && !modules) throw new Error("Open Figure Modules 目录尚不可用，请先检查图库更新。");
      const figureYa = input.providerId === FIGUREYA_PROVIDER_ID;
      const plan = { planDigest: randomUUID(), ...input,
        images: input.mode === "code" ? 0 : figureYa ? options.figureYa.catalog.modules.filter(item => item.primaryPreview ?? item.thumbnail).length : modules!.catalog.modules.length * 2,
        archives: input.mode === "images" ? 0 : figureYa ? options.figureYa.catalog.modules.filter(item => item.archiveAvailable).length : modules!.catalog.modules.length,
        imageDirectory: path.join(library.root, "indexes", "preview-cache", "v1"),
        codeDirectory: galleryCodeDirectory(library.root, input.providerId),
      };
      plans.set(plan.planDigest, { plan, root: library.root, contextKey: library.contextKey, identity: identity(input.providerId)!, expires: Date.now() + 10 * 60_000 });
      if (plans.size > 32) {
        const removable = [...plans.entries()].find(([, item]) => item.task?.state !== "running");
        if (removable) plans.delete(removable[0]);
      }
      return { plan };
    },
    apply: async (raw: unknown) => {
      const input = z.object({ planDigest: z.string().uuid(), confirmedBy: z.literal("user") }).strict().parse(raw);
      const prepared = plans.get(input.planDigest);
      if (!prepared) throw new Error("缓存计划不存在，请重新生成。");
      if (prepared.result) return prepared.result;
      prepared.result = (async () => {
        const current = await options.library();
        if (Date.now() > prepared.expires || current.contextKey !== prepared.contextKey || identity(prepared.plan.providerId) !== prepared.identity) throw new Error("图库或目录版本已变化，请重新生成缓存计划。");
        const { plan } = prepared;
        const result = { images: 0, archives: 0, downloadedArchives: 0, failures: [] as Array<{ item: string; message: string }> };
        const check = async () => {
          if ((await options.library()).contextKey !== prepared.contextKey || identity(plan.providerId) !== prepared.identity) throw new Error("图库位置或版本已变化，本次缓存已停止。");
          for (const relative of ["", "indexes", "indexes/preview-cache", "indexes/preview-cache/v1", "source-packs", path.relative(prepared.root, plan.codeDirectory)]) {
            try { const stat = await fs.lstat(path.join(prepared.root, relative)); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("缓存路径必须为图库内的真实目录"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
        };
        const attempt = async (item: string, work: () => Promise<void>) => {
          await check();
          if (prepared.task) prepared.task.currentItem = item;
          try { await work(); } catch (error) { result.failures.push({ item, message: error instanceof Error ? error.message : String(error) }); }
          if (prepared.task) { prepared.task.processed++; prepared.task.images = result.images; prepared.task.archives = result.archives; prepared.task.failures = [...result.failures]; }
        };
        const saveImage = async (image: { bytes: Uint8Array; extension: string } | undefined) => {
          if (!image) throw new Error("此条目没有可用图片");
          await fs.mkdir(plan.imageDirectory, { recursive: true });
          const file = path.join(plan.imageDirectory, createHash("sha256").update(image.bytes).digest("hex") + image.extension);
          const temporary = `${file}.${randomUUID()}.tmp`;
          try { await fs.writeFile(temporary, image.bytes, { flag: "wx" }); await fs.rename(temporary, file); }
          finally { await fs.rm(temporary, { force: true }); }
          result.images++;
        };
        if (plan.providerId === FIGUREYA_PROVIDER_ID) {
          for (const module of options.figureYa.catalog.modules) {
            if (plan.mode !== "code" && (module.primaryPreview ?? module.thumbnail)) await attempt(`${module.moduleId}/image`, async () => saveImage(await options.figureYa.preview(module.moduleId)));
            if (plan.mode !== "images" && module.archiveAvailable) await attempt(`${module.moduleId}/code`, async () => {
              const state = await cacheFigureYaSourceArchive(options.figureYa.catalog, module, plan.codeDirectory);
              result.archives++; if (state === "downloaded") result.downloadedArchives++;
            });
          }
        } else {
          const index = options.modules()!;
          for (const module of index.catalog.modules) {
            if (plan.mode !== "code") for (const role of ["primary", "thumbnail"] as const) await attempt(`${module.moduleId}/${role}`, async () => saveImage(await index.preview(module, role)));
            if (plan.mode !== "images") await attempt(`${module.moduleId}/code`, async () => {
              const state = await cacheModuleSourceArchive(index, module, plan.codeDirectory);
              result.archives++; if (state === "downloaded") result.downloadedArchives++;
            });
          }
        }
        const stateDb = await cacheStateDatabase(current.root);
        const cachedAt = new Date().toISOString();
        const sourceIdentity = prepared.identity;
        if (plan.mode !== "images") {
          stateDb.put({ providerId: plan.providerId, kind: "source-archive", sourceIdentity, cacheRoot: plan.codeDirectory, declaredCount: plan.archives, cachedCount: result.archives, missingCount: Math.max(0, plan.archives - result.archives), bytesDeclared: 0, bytesCached: 0, lastScannedAt: cachedAt, lastCachedAt: cachedAt, lastVerifiedAt: cachedAt });
        }
        stateDb.close();
        return result;
      })();
      return prepared.result;
    },
  };
  return api;
}
