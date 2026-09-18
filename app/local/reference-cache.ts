import type { Candidate } from "../view.ts";
import { bindModalScrollLock } from "../view.ts";
import type { CachedReference, ReferenceCacheStatus } from "../../src/local/reference-cache.ts";
import { api, details, imageData, imageHash, requireResult } from "./api.ts";
import {
  imageCacheLabel,
  joinReferencePrompts,
  planReferenceCopy,
  referencePackLabel,
  type ReferenceCopyCandidate,
} from "./reference-status.ts";

export { planReferenceCopy, referenceStatusText } from "./reference-status.ts";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
}

export async function referenceStatuses(resultSetId: string, candidates: Array<{ candidateId: string }>) {
  if (!candidates.length) return [];
  return (await api<{ items: ReferenceCacheStatus[] }>("reference-cache/status", { resultSetId, candidateIds: candidates.map((candidate) => candidate.candidateId) })).items;
}

export async function writeReferencePrompts(prompts: string[]) {
  if (!prompts.length) throw new Error("没有可复制的绘图提示词。请选择有配套代码的参考。");
  await navigator.clipboard.writeText(joinReferencePrompts(prompts));
}

export async function copyReferencePrompt(resultSetId: string, candidate: Candidate) {
  const status = (await referenceStatuses(resultSetId, [candidate]))[0];
  if (!status?.cached || status.reference !== "ready") throw new Error("请先缓存图片与代码后再复制提示词。");
  if (!status.cached.hasCode) throw new Error("此参考没有配套代码，无法复制含代码的绘图提示词。请选择有代码的参考。");
  await writeReferencePrompts([status.cached.prompt]);
}

export function referenceStatusIcons(status: ReferenceCacheStatus, candidate: Candidate) {
  const codeReady = status.reference === "ready" && status.cached?.hasCode;
  const state = codeReady ? "ready" : status.image === "preview_cached" ? "image" : status.image === "bundled" ? "bundled" : "empty";
  const image = imageCacheLabel(status.image);
  const pack = referencePackLabel(status, candidate);
  const label = codeReady
    ? "精确图片与代码已缓存到本地"
    : status.image === "preview_cached"
      ? "预览图已缓存到本地，精确参考尚未缓存"
      : status.image === "bundled"
        ? "图片可从图库本地资源读取，尚未写入预览缓存"
        : "预览图与精确参考均未缓存到本地";
  const badge = element("span", undefined, `reference-status-light is-${state}`);
  const explanation = `${label}。预览图：${image.text}。参考包：${pack.text}`;
  badge.tabIndex = 0; badge.setAttribute("role", "img"); badge.setAttribute("aria-label", explanation); badge.dataset.tooltip = explanation;
  badge.addEventListener("click", (event) => event.stopPropagation());
  badge.addEventListener("keydown", (event) => event.stopPropagation());
  return badge;
}

function statusChip(kind: string, label: { tone: string; text: string }) {
  const chip = element("span", undefined, `reference-status-chip is-${label.tone}`);
  chip.append(element("span", kind, "reference-status-chip-kind"), element("span", label.text));
  return chip;
}

export function referenceStatusFacts(status: ReferenceCacheStatus, candidate: Pick<Candidate, "codeStatus">) {
  const facts = element("div", undefined, "reference-status-facts");
  facts.append(statusChip("预览图", imageCacheLabel(status.image)), statusChip("参考包", referencePackLabel(status, candidate)));
  return facts;
}

async function copyPreparedPrompts(resultSetId: string, targets: ReferenceCopyCandidate[], status: HTMLElement, prefix = "") {
  const lead = prefix ? `${prefix} ` : "";
  try {
    const plan = planReferenceCopy(targets, await referenceStatuses(resultSetId, targets));
    if (!plan.ready.length) {
      status.textContent = `${lead}没有可复制的含代码提示词。`.trim();
      return;
    }
    await writeReferencePrompts(plan.ready.map((item) => item.prompt));
    const blocked = plan.blocked.length ? ` ${plan.blocked.length} 个参考无法复制。` : "";
    status.textContent = `${lead}已复制 ${plan.ready.length} 条绘图提示词。AI 无法读取本机路径时，请上传提示词列出的材料。${blocked}`.trim();
  } catch (error) {
    status.textContent = `${lead}缓存完成，但复制提示词失败：${String(error)}`.trim();
  }
}

export async function cacheReferences(options: {
  resultSetId: string;
  candidates: Candidate[];
  onChanged(): void;
  copyWhenReady?: boolean;
  copyCandidates?: Candidate[];
}) {
  const { resultSetId, candidates } = options;
  const copyTargets = options.copyCandidates ?? candidates;
  if (!candidates.length || candidates.length > 12) throw new Error("请选择 1–12 个参考。");
  const dialog = element("dialog", undefined, "local-dialog reference-cache-dialog");
  const title = element("h2", `缓存 ${candidates.length} 个参考`);
  const intro = element("p", "查看以下精确图片后生成缓存计划。图片与代码按固定版本保存到本地参考目录，缓存不会启动绘图任务。");
  const list = element("div", undefined, "reference-review-list");
  const network = element("input"); network.type = "checkbox"; network.checked = true;
  const networkLabel = element("label", undefined, "checkbox");
  networkLabel.append(network, document.createTextNode("缺少代码包时允许联网下载所选固定版本"));
  const status = element("p", "正在检查本地参考…"); status.setAttribute("role", "status");
  const close = element("button", "关闭", "quiet"); close.type = "button";
  const next = element("button", "确认这些图片并生成缓存计划"); next.type = "button"; next.disabled = true;
  const actions = element("div", undefined, "dialog-actions"); actions.append(close, next);
  dialog.append(title, intro, list, networkLabel, status, actions);
  let busy = false;
  close.onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { dialog.remove(); options.onChanged(); });
  document.body.append(dialog); dialog.showModal(); bindModalScrollLock(document, dialog);

  type Item = { candidate: Candidate; row: HTMLElement; message: HTMLElement; previewChallenge?: string; hash?: string; plan?: Record<string, unknown> };
  const pending: Item[] = [];
  let completed = 0;
  function showReady(item: Item, reference: CachedReference) {
    item.message.textContent = reference.hasCode ? "图片与代码已缓存" : "参考已缓存；此包没有可识别的代码文件";
    const location = element("code", reference.target, "reference-path");
    const copy = element("button", "复制绘图提示词", "quiet");
    copy.type = "button";
    copy.onclick = async () => {
      copy.disabled = true;
      try { await copyReferencePrompt(resultSetId, item.candidate); item.message.textContent = "已复制。AI 无法读取本机路径时，请上传提示词列出的材料。"; }
      catch (error) { item.message.textContent = String(error); }
      finally { copy.disabled = false; }
    };
    item.row.append(location, copy);
  }
  try {
    const states = new Map((await referenceStatuses(resultSetId, candidates)).map((item) => [item.candidateId, item]));
    for (const candidate of candidates) {
      if (!dialog.open) return;
      const row = element("article", undefined, "reference-review-item");
      const message = element("p", "正在加载精确图片…");
      row.append(element("h3", candidate.title), message); list.append(row);
      const item: Item = { candidate, row, message };
      const existing = states.get(candidate.candidateId);
      if (existing?.reference === "ready" && existing.cached) { completed++; showReady(item, existing.cached); continue; }
      if (!candidate.materializable) { message.textContent = "此条目没有可获取的固定版本参考包；不会生成代码。"; continue; }
      try {
        const preview = requireResult(await api("preview", { resultSetId, providerId: candidate.providerId, exactSelector: candidate.exactSelector }));
        const image = imageData(preview);
        const hash = await imageHash(image.data);
        if (hash !== details(preview).transportSha256) throw new Error("精确图片校验失败");
        const img = element("img"); img.alt = `${candidate.title} 精确预览`;
        const loaded = new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("精确图片显示失败")); });
        img.src = image.url; row.insertBefore(img, message); await loaded;
        item.previewChallenge = String(details(preview).previewChallenge); item.hash = hash;
        message.textContent = "请确认此图片是要缓存的参考。";
        pending.push(item);
      } catch (error) { message.textContent = `无法缓存：${String(error)}`; }
    }
    status.textContent = `${completed} 个已缓存，${pending.length} 个待确认。`;
    next.disabled = pending.length === 0;
    if (!pending.length) {
      next.hidden = true; networkLabel.hidden = true;
      if (options.copyWhenReady) await copyPreparedPrompts(resultSetId, copyTargets, status);
    }
  } catch (error) { status.textContent = String(error); return; }

  next.onclick = async () => {
    busy = true; next.disabled = true; close.disabled = true; network.disabled = true;
    let plans = 0;
    for (const item of pending) {
      try {
        const confirmation = requireResult(await api("confirm", { previewChallenge: item.previewChallenge, displayedImageSha256: item.hash, imageLoaded: true, confirmedBy: "user" }));
        const prepared = await api<{ plan: Record<string, unknown> }>("reference-cache/plan", { resultSetId, candidateId: item.candidate.candidateId, previewReceipt: details(confirmation).previewReceipt, allowNetwork: network.checked });
        item.plan = prepared.plan; plans++;
        item.message.textContent = `待写入：${String(item.plan.target)}；${network.checked ? "缺失代码包时联网获取" : "仅使用本地代码包"}`;
        const technical = element("details"); technical.append(element("summary", "查看完整缓存计划"), element("pre", JSON.stringify(item.plan, null, 2))); item.row.append(technical);
      } catch (error) { item.message.textContent = `计划失败，未缓存：${String(error)}`; }
    }
    busy = false; close.disabled = false;
    next.textContent = `确认缓存 ${plans} 个参考`; next.disabled = plans === 0;
    status.textContent = `已生成 ${plans} 个计划，确认后才下载代码和写入参考目录。失败项不会执行。`;
    next.onclick = async () => {
      busy = true; next.disabled = true; close.disabled = true;
      let failed = 0;
      for (const item of pending.filter((item) => item.plan)) {
        item.message.textContent = "正在缓存…";
        try {
          const response = await api<{ reference: CachedReference }>("reference-cache/apply", { planDigest: item.plan!.planDigest, confirmedBy: "user" });
          completed++; showReady(item, response.reference);
        } catch (error) { failed++; item.message.textContent = `缓存失败：${String(error)}。请关闭后检查状态，重新预览并生成计划。`; }
      }
      busy = false; close.disabled = false; next.hidden = true;
      const summary = `${completed} 个参考可用，本次执行 ${failed} 个失败。`;
      if (options.copyWhenReady) await copyPreparedPrompts(resultSetId, copyTargets, status, summary);
      else status.textContent = `${summary}可用参考才能复制绘图提示词。`;
      options.onChanged();
    };
  };
}
