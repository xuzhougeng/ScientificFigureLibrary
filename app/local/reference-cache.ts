import type { Candidate } from "../view.ts";
import { bindModalScrollLock } from "../view.ts";
import type { ReferenceCacheStatus, ReferencePackFiles } from "../../src/local/reference-cache.ts";
import { api } from "./api.ts";
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
  if (!status?.pack?.hasCode || !status.pack.prompt) throw new Error("请先缓存参考包后再复制提示词。");
  await writeReferencePrompts([status.pack.prompt]);
}

export function referenceStatusIcons(status: ReferenceCacheStatus, candidate: Candidate) {
  const packReady = Boolean(status.pack) || status.archive === "cached";
  const state = packReady ? "ready" : status.image === "cached" ? "image" : "empty";
  const image = imageCacheLabel(status.image);
  const pack = referencePackLabel(status, candidate);
  const label = packReady
    ? "参考包已缓存到本地，可复制提示词"
    : status.image === "cached"
      ? "预览图已缓存到本地，参考包尚未缓存"
      : "预览图与参考包均未缓存到本地";
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

async function copyPreparedPrompts(
  resultSetId: string,
  targets: ReferenceCopyCandidate[],
  status: HTMLElement,
  prefix = "",
  onCopied?: (count: number) => void,
) {
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
    onCopied?.(plan.ready.length);
  } catch (error) {
    status.textContent = `${lead}参考包已缓存，但复制提示词失败：${String(error)}`.trim();
  }
}

export async function cacheReferences(options: {
  resultSetId: string;
  candidates: Candidate[];
  onChanged(): void;
  copyWhenReady?: boolean;
  copyCandidates?: Candidate[];
  onCopied?: (count: number) => void;
}) {
  const { resultSetId, candidates } = options;
  const copyTargets = options.copyCandidates ?? candidates;
  if (!candidates.length || candidates.length > 12) throw new Error("请选择 1–12 个参考。");
  const dialog = element("dialog", undefined, "local-dialog reference-cache-dialog");
  const title = element("h2", `缓存 ${candidates.length} 个参考包`);
  const intro = element("p", "将把固定版本压缩包保存到图库的参考包目录。这与预览图是两类缓存，不会另存第三份展开副本，也不会启动绘图任务。");
  const list = element("div", undefined, "reference-review-list");
  const network = element("input"); network.type = "checkbox"; network.checked = true;
  const networkLabel = element("label", undefined, "checkbox");
  networkLabel.append(network, document.createTextNode("缺少参考包时允许联网下载所选固定版本"));
  const status = element("p", "正在检查本地参考包…"); status.setAttribute("role", "status");
  const close = element("button", "关闭", "quiet"); close.type = "button";
  const next = element("button", "确认缓存参考包"); next.type = "button"; next.disabled = true;
  const actions = element("div", undefined, "dialog-actions"); actions.append(close, next);
  dialog.append(title, intro, list, networkLabel, status, actions);
  let busy = false;
  close.onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { dialog.remove(); options.onChanged(); });
  document.body.append(dialog); dialog.showModal(); bindModalScrollLock(document, dialog);

  type Item = { candidate: Candidate; row: HTMLElement; message: HTMLElement };
  const pending: Item[] = [];
  let completed = 0;
  function showReady(item: Item, pack: ReferencePackFiles) {
    item.message.textContent = pack.hasCode ? "参考包已缓存" : "参考包已缓存；此包没有可识别的代码文件";
    const location = element("code", pack.target, "reference-path");
    const copy = element("button", "复制绘图提示词", "quiet");
    copy.type = "button";
    copy.onclick = async () => {
      copy.disabled = true;
      try {
        await copyReferencePrompt(resultSetId, item.candidate);
        item.message.textContent = "已复制。AI 无法读取本机路径时，请上传提示词列出的材料。";
        options.onCopied?.(1);
      }
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
      const message = element("p", "正在检查参考包…");
      row.append(element("h3", candidate.title), message); list.append(row);
      const item: Item = { candidate, row, message };
      const existing = states.get(candidate.candidateId);
      if (existing?.pack) { completed++; showReady(item, existing.pack); continue; }
      if (!candidate.materializable || existing?.archive === "not_applicable") {
        message.textContent = "此条目没有可获取的固定版本参考包；不会下载。";
        continue;
      }
      message.textContent = "待下载固定版本参考包。";
      pending.push(item);
    }
    status.textContent = `${completed} 个已缓存，${pending.length} 个待下载。`;
    next.disabled = pending.length === 0;
    if (!pending.length) {
      next.hidden = true; networkLabel.hidden = true;
      if (options.copyWhenReady) await copyPreparedPrompts(resultSetId, copyTargets, status, "", options.onCopied);
    }
  } catch (error) { status.textContent = String(error); return; }

  next.onclick = async () => {
    busy = true; next.disabled = true; close.disabled = true; network.disabled = true;
    let failed = 0;
    for (const item of pending) {
      item.message.textContent = "正在缓存参考包…";
      try {
        const response = await api<{ pack: ReferencePackFiles }>("reference-cache/ensure", {
          resultSetId,
          candidateId: item.candidate.candidateId,
          allowNetwork: network.checked,
        });
        completed++;
        showReady(item, response.pack);
      } catch (error) {
        failed++;
        item.message.textContent = `缓存失败：${String(error)}。请关闭后检查状态，再试一次。`;
      }
    }
    busy = false; close.disabled = false; next.hidden = true;
    const summary = `${completed} 个参考包可用，本次执行 ${failed} 个失败。`;
    if (options.copyWhenReady) await copyPreparedPrompts(resultSetId, copyTargets, status, summary, options.onCopied);
    else status.textContent = `${summary}已缓存的参考包才能复制绘图提示词。`;
    options.onChanged();
  };
}
