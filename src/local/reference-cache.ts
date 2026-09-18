import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OperationRegistry } from "../service/operations.ts";
import type { ProviderContext, ProviderRegistry } from "../provider-registry.ts";
import type { TemplateCandidate } from "../types.ts";
import { exactSelectorDigest, FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID } from "../providers.ts";
import { inspectMaterializedReference } from "../materialization-tools.ts";
import { inspectFigureYaSourcePack } from "../materialize.ts";
import { inspectModuleSourcePack } from "../module-materialize.ts";
import { buildReferencePrompt } from "./reference-prompt.ts";
import { galleryCodeDirectory } from "./gallery-cache.ts";

export interface CachedReference {
  target: string;
  files: string[];
  hasCode: boolean;
  prompt: string;
}
export interface ReferenceCacheStatus {
  candidateId: string;
  /**
   * The preview cache is separate from a provider's bundled/local source and
   * from the exact reference cache. Keep those states explicit so the UI does
   * not report a readable bundled preview as a downloaded cache entry.
   */
  image: "bundled" | "preview_cached" | "not_cached";
  /**
   * Gallery-level source-pack archive for this template. Distinct from
   * `reference`, which is the extracted, copy-ready exact cache.
   */
  archive: "cached" | "missing" | "not_applicable";
  reference: "ready" | "missing" | "invalid" | "unavailable";
  cached?: CachedReference;
  error?: string;
}

async function previewCacheHasFile(root: string, preview: { sha256: string; extension: string; byteLength: number }) {
  const file = path.join(root, "indexes", "preview-cache", "v1", `${preview.sha256}${preview.extension}`);
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === preview.byteLength;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const selection = z.object({ resultSetId: z.string().min(1), candidateId: z.string().min(1) });
const pointerSchema = z.object({ generation: z.string().uuid(), operationId: z.string().uuid() }).strict();
const HASH = /^[a-f0-9]{64}$/u;
function checked(result: Awaited<ReturnType<OperationRegistry["execute"]>>) {
  const value = result.structuredContent as Record<string, unknown> | undefined;
  const envelope = value?.envelope as { outcome?: string; summary?: string } | undefined;
  if (!value || result.isError || !["ok", "applied", "replayed", "needs_user_confirmation"].includes(envelope?.outcome ?? "")) {
    throw new Error(envelope?.summary ?? "Reference operation failed");
  }
  return value;
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
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function createReferenceCache(options: {
  operations: OperationRegistry;
  registry: ProviderRegistry;
  context(): Promise<ProviderContext>;
  candidate(resultSetId: string, candidateId: string): Promise<TemplateCandidate>;
}) {
  const plans = new Map<string, { candidate: TemplateCandidate; root: string; keyDirectory: string; generation: string; operationId: string; target: string }>();
  const keyDirectory = (context: ProviderContext, candidate: TemplateCandidate) =>
    path.join(context.library.snapshot.root, "indexes", "reference-cache", exactSelectorDigest(candidate.exactSelector));

  async function cached(context: ProviderContext, candidate: TemplateCandidate): Promise<CachedReference | undefined> {
    const directory = keyDirectory(context, candidate);
    const pointer = path.join(directory, "reference.json");
    await regularPath(context.library.snapshot.root, pointer);
    let saved: z.infer<typeof pointerSchema>;
    try { saved = pointerSchema.parse(JSON.parse(await fs.readFile(pointer, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const target = path.join(directory, saved.generation, candidate.templateId);
    await regularPath(context.library.snapshot.root, target);
    const verified = await inspectMaterializedReference({
      context: context.library, index: context.catalog, registry: options.registry,
      selector: candidate.exactSelector, operationId: saved.operationId, target, moduleCatalogs: context.moduleCatalogs,
    });
    const hasCode = verified.files.some((file) => /(?:^|\/)code\/|\.(?:r|py|rmd|qmd|ipynb|jl|js|ts|m)$/iu.test(file));
    return { target, files: verified.files, hasCode, prompt: buildReferencePrompt(candidate, target, verified.files) };
  }

  return {
    status: async (raw: unknown) => {
      const input = z.object({ resultSetId: z.string().min(1), candidateIds: z.array(z.string().min(1)).min(1).max(12) }).strict().parse(raw);
      const context = await options.context();
      const packs = new Map<string, Set<string> | "not_applicable">();
      const sourcePack = async (providerId: string) => {
        const existing = packs.get(providerId);
        if (existing) return existing;
        const directory = galleryCodeDirectory(context.library.snapshot.root, providerId);
        try {
          if (providerId === FIGUREYA_PROVIDER_ID) {
            const inspected = await inspectFigureYaSourcePack(context.catalog.catalog, directory, { verifyArchives: false });
            const ids = new Set(inspected.availableTemplates);
            packs.set(providerId, ids);
            return ids;
          }
          if (providerId === PERSONAL_MODULE_PROVIDER_ID) {
            const index = context.moduleCatalogs?.get(providerId);
            if (!index) {
              const empty = new Set<string>();
              packs.set(providerId, empty);
              return empty;
            }
            const inspected = await inspectModuleSourcePack(index, directory, { verifyArchives: false });
            const ids = new Set(inspected.availableTemplates);
            packs.set(providerId, ids);
            return ids;
          }
        } catch { /* Status must not fail the whole page if a source pack is unreadable. */ }
        const fallback = providerId === FIGUREYA_PROVIDER_ID || providerId === PERSONAL_MODULE_PROVIDER_ID ? new Set<string>() : "not_applicable";
        packs.set(providerId, fallback);
        return fallback;
      };
      const items: ReferenceCacheStatus[] = [];
      for (const candidateId of [...new Set(input.candidateIds)]) {
        const candidate = await options.candidate(input.resultSetId, candidateId);
        let image: ReferenceCacheStatus["image"] = "not_cached";
        const adapter = options.registry.get(candidate.providerId);
        try {
          const offline = { ...context, allowPreviewDownload: false };
          const resolved = await adapter.resolve(offline, candidate.exactSelector, "preview");
          const preview = await adapter.loadPreview(offline, resolved);
          image = await previewCacheHasFile(context.library.snapshot.root, preview) ? "preview_cached" : "bundled";
        } catch { /* Status must never download a missing image. */ }
        const pack = await sourcePack(candidate.providerId);
        const archive: ReferenceCacheStatus["archive"] = pack === "not_applicable" ? "not_applicable" : pack.has(candidate.templateId) ? "cached" : "missing";
        if (!candidate.materializable) { items.push({ candidateId, image, archive, reference: "unavailable" }); continue; }
        try {
          const value = await cached(context, candidate);
          items.push({ candidateId, image, archive, reference: value ? "ready" : "missing", ...(value ? { cached: value } : {}) });
        } catch (error) {
          items.push({ candidateId, image, archive, reference: "invalid", error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { items };
    },
    plan: async (raw: unknown) => {
      const input = selection.extend({ previewReceipt: z.string().min(1), allowNetwork: z.boolean() }).strict().parse(raw);
      const candidate = await options.candidate(input.resultSetId, input.candidateId);
      const context = await options.context();
      if (!candidate.materializable) throw new Error("此参考没有可获取的固定版本包");
      const directory = keyDirectory(context, candidate);
      const generation = randomUUID();
      const destination = path.join(directory, generation);
      await regularPath(context.library.snapshot.root, destination);
      const value = checked(await options.operations.execute("figure_library_plan_materialize", {
        providerId: candidate.providerId, exactSelector: candidate.exactSelector,
        previewReceipt: input.previewReceipt, allowNetwork: input.allowNetwork, destination,
        sourcePackDir: galleryCodeDirectory(context.library.snapshot.root, candidate.providerId),
      }));
      const plan = value.plan as { planDigest: string; target: string };
      plans.set(plan.planDigest, { candidate, root: context.library.snapshot.root, keyDirectory: directory, generation, operationId: randomUUID(), target: plan.target });
      while (plans.size > 64) plans.delete(plans.keys().next().value!);
      return { plan: value.plan };
    },
    apply: async (raw: unknown) => {
      const input = z.object({ planDigest: z.string().regex(HASH), confirmedBy: z.literal("user") }).strict().parse(raw);
      const prepared = plans.get(input.planDigest);
      if (!prepared) throw new Error("缓存计划已失效，请重新预览并生成计划");
      const context = await options.context();
      if (path.resolve(context.library.snapshot.root) !== path.resolve(prepared.root)) throw new Error("Library changed; create a new plan");
      await regularPath(prepared.root, prepared.target);
      checked(await options.operations.execute("figure_library_apply_materialize", {
        planDigest: input.planDigest, operationId: prepared.operationId,
        expectedProviderId: prepared.candidate.providerId, expectedTarget: prepared.target,
      }));
      // This pointer is only a rebuildable locator. Every subsequent read verifies the authoritative receipt and all files.
      const pointer = path.join(prepared.keyDirectory, "reference.json");
      await regularPath(prepared.root, pointer);
      const temporary = `${pointer}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ generation: prepared.generation, operationId: prepared.operationId }), { flag: "wx" });
      try { await fs.rename(temporary, pointer); } finally { await fs.rm(temporary, { force: true }); }
      const reference = await cached(context, prepared.candidate);
      if (!reference) throw new Error("Reference cache verification failed");
      return { reference };
    },
  };
}
