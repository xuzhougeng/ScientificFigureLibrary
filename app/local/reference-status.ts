import type { Candidate } from "../view.ts";
import type { ReferenceCacheStatus } from "../../src/local/reference-cache.ts";

export type ReferenceCopyCandidate = Pick<Candidate, "candidateId" | "title" | "materializable" | "codeStatus">;

export type StatusTone = "empty" | "bundled" | "image" | "ready" | "warning";

export interface ReferenceCopyPlan<T extends ReferenceCopyCandidate = ReferenceCopyCandidate> {
  ready: Array<{ candidate: T; prompt: string }>;
  needsCache: T[];
  blocked: Array<{ candidate: T; reason: string }>;
}

export function imageCacheLabel(image: ReferenceCacheStatus["image"]): { tone: StatusTone; text: string } {
  if (image === "preview_cached") return { tone: "image", text: "已缓存" };
  if (image === "bundled") return { tone: "bundled", text: "可本地读取" };
  return { tone: "empty", text: "待缓存" };
}

export function referencePackLabel(
  status: Pick<ReferenceCacheStatus, "reference" | "cached"> & Partial<Pick<ReferenceCacheStatus, "archive">>,
  candidate: Pick<ReferenceCopyCandidate, "codeStatus">,
): { tone: StatusTone; text: string } {
  if (status.reference === "ready") {
    return status.cached?.hasCode
      ? { tone: "ready", text: "可复制 · 含代码" }
      : { tone: "warning", text: "已缓存 · 无代码" };
  }
  if (status.reference === "invalid") return { tone: "warning", text: "需重新获取" };
  if (status.reference === "unavailable") return { tone: "warning", text: "不可获取" };
  if (status.archive === "cached") return { tone: "ready", text: "已缓存" };
  return { tone: "empty", text: candidate.codeStatus === "none" ? "仅图片 · 待缓存" : "待缓存" };
}

export function referenceStatusText(status: ReferenceCacheStatus, candidate: Pick<ReferenceCopyCandidate, "codeStatus">) {
  return `预览图：${imageCacheLabel(status.image).text} · 参考包：${referencePackLabel(status, candidate).text}`;
}

export function joinReferencePrompts(prompts: string[]) {
  return prompts.join("\n\n————\n\n");
}

export function planReferenceCopy<T extends ReferenceCopyCandidate>(candidates: T[], statuses: ReferenceCacheStatus[]): {
  ready: Array<{ candidate: T; prompt: string }>;
  needsCache: T[];
  blocked: Array<{ candidate: T; reason: string }>;
} {
  const byId = new Map(statuses.map((status) => [status.candidateId, status]));
  const ready: Array<{ candidate: T; prompt: string }> = [];
  const needsCache: T[] = [];
  const blocked: Array<{ candidate: T; reason: string }> = [];
  for (const candidate of candidates) {
    const status = byId.get(candidate.candidateId);
    if (!status) {
      blocked.push({ candidate, reason: `无法读取「${candidate.title}」的本地缓存状态。` });
      continue;
    }
    if (status.reference === "ready" && status.cached?.hasCode && status.cached.prompt) {
      ready.push({ candidate, prompt: status.cached.prompt });
      continue;
    }
    if (status.reference === "ready") {
      blocked.push({ candidate, reason: `「${candidate.title}」没有配套代码，无法复制含代码的绘图提示词。` });
      continue;
    }
    if (status.reference === "unavailable" || !candidate.materializable) {
      blocked.push({ candidate, reason: `「${candidate.title}」没有可获取的固定版本参考包。` });
      continue;
    }
    needsCache.push(candidate);
  }
  return { ready, needsCache, blocked };
}
