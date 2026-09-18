import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CatalogIndex } from "../catalog.ts";
import type { ModuleCatalogIndex } from "../module-catalog.ts";
import { cacheFigureYaSourceArchive } from "../materialize.ts";
import { cacheModuleSourceArchive } from "../module-materialize.ts";
import { FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID } from "../providers.ts";

export function galleryCodeDirectory(root: string, providerId: string) {
  return path.join(root, "source-packs", providerId === FIGUREYA_PROVIDER_ID ? "figureya" : "open-modules");
}

export function createGalleryCache(options: {
  figureYa: CatalogIndex;
  modules(): ModuleCatalogIndex | undefined;
  library(): Promise<{ root: string; contextKey: string; writesEnabled: boolean }>;
}) {
  type Prepared = { plan: { planDigest: string; providerId: string; mode: string; images: number; archives: number; imageDirectory: string; codeDirectory: string }; root: string; contextKey: string; identity: string; expires: number; result?: Promise<unknown> };
  const plans = new Map<string, Prepared>();
  const figureYaIdentity = JSON.stringify(options.figureYa.catalog);
  const identity = (providerId: string) => providerId === FIGUREYA_PROVIDER_ID
    ? figureYaIdentity
    : options.modules()?.catalogSha256;
  return {
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
      if (plans.size > 32) plans.delete(plans.keys().next().value!);
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
          try { await work(); } catch (error) { result.failures.push({ item, message: error instanceof Error ? error.message : String(error) }); }
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
        return result;
      })();
      return prepared.result;
    },
  };
}
