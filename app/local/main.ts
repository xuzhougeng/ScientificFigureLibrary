import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SFL_BRAND_ICON_DATA_URI } from "../brand.ts";
import { mountExactPreviewImage, openCandidateDetail, parseSearchResult, renderCandidateCards, type Candidate, type DetailViewElements, type SearchResult } from "../view.ts";
import { renderMarkdown } from "../markdown.ts";
import { api, call, details, imageData, imageHash, record, records, requireResult, upload } from "./api.ts";
import "../styles.css";
import "./styles.css";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
const form = (id: string) => el<HTMLFormElement>(id);
const dialog = (id: string) => el<HTMLDialogElement>(id);
const titles: Record<string, string> = { discover: "发现可复用的科学图", library: "我的图片与代码", import: "导入知识库", settings: "设置与连接", integrations: "连接外部工具" };
let page = "discover";
let result: SearchResult | undefined;
let selected = new Map<string, Candidate>();
const pages = new Map<number, SearchResult>();
let editingTemplateId: string | undefined;
let planAction: (() => Promise<void>) | undefined;
let planGeneration = 0;
let pendingMaterialize: { candidate: Candidate; receipt: string; resultSetId: string } | undefined;
let canShutdown = false;
let stopped = false;
(el<HTMLImageElement>("local-logo")).src = SFL_BRAND_ICON_DATA_URI;

function notify(message: string, error = false) {
  const target = el("notice");
  target.textContent = message;
  target.classList.toggle("error", error);
  target.hidden = false;
}
async function run(action: () => Promise<void>, control?: HTMLButtonElement) {
  if (control) control.disabled = true;
  try { await action(); } catch (error) { if (!stopped) notify(error instanceof Error ? error.message : String(error), true); }
  finally { if (control) control.disabled = false; }
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function action(text: string, handler: () => Promise<void>, quiet = false) {
  const control = node("button", text, quiet ? "quiet" : undefined);
  control.addEventListener("click", () => void run(handler, control));
  return control;
}
function safeLink(url: string) {
  if (!/^https?:\/\//iu.test(url)) throw new Error("只允许打开 HTTP(S) 链接");
  window.open(url, "_blank", "noopener,noreferrer");
}
async function showPage(next: string) {
  if (!(next in titles)) return;
  page = next;
  for (const key of Object.keys(titles)) el(`${key}-page`).hidden = key !== page;
  el("page-title").textContent = titles[page]!;
  document.querySelectorAll<HTMLButtonElement>(".local-sidebar button[data-page]").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  if (page === "library") await loadLibrary();
  if (page === "settings") await loadStatus();
  if (page === "integrations") await loadIntegrations();
}
function refreshSelection() {
  el("selection-bar").hidden = selected.size === 0;
  el("selection-count").textContent = `已选择 ${selected.size} 个模板`;

}
function display(parsed: SearchResult) {
  if (parsed.resultSetId !== result?.resultSetId) { selected = new Map(); pages.clear(); }
  result = parsed;
  pages.set(parsed.pagination.pageIndex, parsed);
  renderCandidateCards({ document, cards: el("cards"), empty: el("empty"), result: parsed, selectionPurpose: "保存或复制信息", selectedIds: new Set(selected.keys()),
    onToggleSelect: (candidate, checked) => {
      if (checked && selected.size < 12) selected.set(candidate.candidateId, candidate);
      else selected.delete(candidate.candidateId);
      if (checked && !selected.has(candidate.candidateId)) { notify("一次最多选择 12 个模板。", true); display(parsed); }
      refreshSelection();
    },
    onDetail: (candidate, _elements, opener) => {
      const elements = openCandidateDetail({ document, candidate, opener, serverToolsAvailable: true, updateModelContextAvailable: false,
        onOpenLink: async (url) => safeLink(url),
        onRequestExactPreview: (view) => void run(() => exactPreview(candidate, view), view.exactPreviewButton),
        onRequestAgentReview: () => {},
      });
      elements.confirmButton.textContent = "确认图片并保存模板";
    },
  });
  el("results-title").textContent = parsed.query ? `“${parsed.query}”的候选图片` : "候选图片";
  el("results-count").textContent = `${parsed.pagination.total} 个结果`;
  el("local-pagination").hidden = parsed.pagination.total === 0;
  el("page-label").textContent = `第 ${parsed.pagination.pageIndex} / ${Math.max(1, Math.ceil(parsed.pagination.total / parsed.pagination.pageSize))} 页`;
  button("previous").disabled = !pages.has(parsed.pagination.pageIndex - 1);
  button("next").disabled = !parsed.pagination.nextCursor;
  refreshSelection();
}
function displayResult(value: CallToolResult) {
  requireResult(value);
  const parsed = parseSearchResult(value.structuredContent, value._meta);
  if (!parsed) throw new Error("无法读取候选图片列表");
  display(parsed);
}
async function search() {
  const query = input("search-query").value.trim();
  if (!query) return;
  const provider = el<HTMLSelectElement>("search-provider").value;
  displayResult(await call("figure_library_search", { query, limit: 6, ...(provider ? { providerIds: [provider] } : {}), ...(input("search-data").value.trim() ? { dataProfile: input("search-data").value.trim() } : {}) }));
}
async function exactPreview(candidate: Candidate, view: DetailViewElements) {
  if (!result) return;
  const resultSetId = result.resultSetId;
  view.confirmButton.disabled = true;
  view.confirmButton.onclick = null;
  const preview = requireResult(await api("preview", { resultSetId, providerId: candidate.providerId, exactSelector: candidate.exactSelector }));
  const image = imageData(preview);
  const sha256 = await imageHash(image.data);
  if (sha256 !== details(preview).transportSha256) throw new Error("精确图片传输校验失败");
  let loaded = false;
  mountExactPreviewImage({ document, elements: view, dataUrl: image.url, alt: candidate.title,
    onLoaded: () => { loaded = true; view.status.textContent = "精确图片已加载。确认后可生成保存到项目的计划。"; },
    onError: () => { loaded = false; view.confirmButton.disabled = true; view.status.textContent = "图片加载失败，无法确认。"; },
  });
  view.confirmButton.onclick = () => void run(async () => {
    if (!loaded) throw new Error("先查看成功加载的精确图片");
    const confirmed = requireResult(await api("confirm", { previewChallenge: details(preview).previewChallenge, displayedImageSha256: sha256, imageLoaded: true, confirmedBy: "user" }));
    pendingMaterialize = { candidate, receipt: String(details(confirmed).previewReceipt), resultSetId };
    view.dialog.close();
    dialog("materialize-dialog").showModal();
  }, view.confirmButton);
}
function planLine(label: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  const line = node("div", undefined, "plan-line");
  line.append(node("strong", label), node("span", typeof value === "string" ? value : JSON.stringify(value)));
  el("plan-summary").append(line);
}
function joined(value: unknown) {
  if (!Array.isArray(value) || !value.length) return undefined;
  return value.map((item) => {
    if (typeof item === "string") return item;
    const entry = record(item);
    return String(entry.identity ?? entry.moduleId ?? JSON.stringify(item));
  }).join("、");
}
function reviewPlan(title: string, response: CallToolResult, apply: () => Promise<void>) {
  const data = details(requireResult(response));
  const plan = record(data.plan);
  if (typeof plan.planDigest !== "string") throw new Error(String(record(data.envelope).summary ?? "没有生成可执行的计划"));
  el("plan-title").textContent = title;
  el("plan-summary").replaceChildren();
  planLine("操作", title);
  planLine("资产名称", record(plan.content).title ?? plan.templateId);
  planLine("来源", plan.providerId ?? plan.sourceLabel);
  planLine("清单地址", plan.manifestUrl);
  planLine("目标目录", plan.target ?? plan.libraryDirectory ?? plan.workspaceDirectory ?? plan.directory ?? plan.configPath);
  planLine("网络下载", plan.allowNetwork === undefined ? undefined : plan.allowNetwork ? "允许下载所选固定版本" : "仅使用本地内容");
  planLine("新增模板", joined(record(plan.templateDiff).added));
  planLine("更新模板", joined(record(plan.templateDiff).updated));
  planLine("撤回模板", joined(record(plan.templateDiff).withdrawn));
  planLine("说明", record(data.envelope).summary);
  const review = record(data.reviewSummary);
  for (const warning of records(review.warnings)) planLine("注意事项", warning.message);
  el("plan-json").textContent = JSON.stringify(data, null, 2);
  const generation = ++planGeneration;
  planAction = async () => {
    await apply();
    if (generation !== planGeneration) return;
    dialog("plan-dialog").close();
    planAction = undefined;
    await loadStatus();
  };
  dialog("plan-dialog").showModal();
}
function providerSources(result: Awaited<ReturnType<typeof call>>) {
  const data = details(result);
  return records(record(data.result).sources ?? data.sources ?? data.providers);
}
function cacheLabel(source: Record<string, unknown>, cache: Record<string, unknown>) {
  const status = records(cache.sources).find((item) => item.providerId === source.providerId);
  if (!status) return source.sourceKind === "signed-personal" ? "目录快照已缓存" : undefined;
  if (status.delivery === "local") return "图片已随目录提供";
  if (Number(status.missing) === 0) return `图片已缓存 ${status.cached}/${status.total}`;
  return `待缓存图片 ${status.cached}/${status.total}`;
}
function renderCacheBanner(setupRequired: boolean, cache: Record<string, unknown>) {
  const downloadable = cache.downloadable === true;
  const complete = cache.complete === true;
  el("setup-banner").hidden = !setupRequired;
  el("cache-banner").hidden = setupRequired || !downloadable || complete;
  const hint = el("preview-cache-hint");
  if (setupRequired) hint.textContent = "安装包默认不包含图库图片。请先设置本机目录，再缓存图片；未缓存时，当前页仍会在首次查看时下载。";
  else if (!downloadable) hint.textContent = "图库图片来自本机目录或安装包，可直接浏览。";
  else if (complete) hint.textContent = "图库图片已缓存，可离线浏览。";
  else hint.textContent = "安装包未包含图库图片。可一次性缓存，或在首次查看当前页时下载。";
  const totals = records(cache.sources).filter((item) => item.delivery === "download");
  const cached = totals.reduce((sum, item) => sum + Number(item.cached ?? 0), 0);
  const total = totals.reduce((sum, item) => sum + Number(item.total ?? 0), 0);
  el("cache-progress").textContent = total ? `已缓存 ${cached} / ${total}` : "";
}
function renderSearchProviders(sources: Array<Record<string, unknown>>) {
  const picker = el<HTMLSelectElement>("search-provider");
  const previous = picker.value;
  picker.replaceChildren();
  picker.append(Object.assign(node("option", "全部默认来源"), { value: "" }));
  for (const source of sources) {
    if (source.enabled === false || source.frozen === true) continue;
    const option = node("option", String(source.sourceLabel ?? source.providerId));
    option.value = String(source.providerId);
    picker.append(option);
  }
  if ([...picker.options].some((item) => item.value === previous)) picker.value = previous;
}
function renderProviderList(sources: Array<Record<string, unknown>>, cache: Record<string, unknown>) {
  const target = el("provider-list");
  target.replaceChildren();
  if (!sources.length) {
    target.append(node("p", "默认检索本地已发布、FigureYa、Open Figure Modules 与已启用的个人来源。"));
    return;
  }
  for (const source of sources) {
    const providerId = String(source.providerId);
    const kind = String(source.sourceKind ?? "");
    const row = node("article", undefined, "provider-row");
    const info = node("div");
    const health = String(source.health ?? (source.enabled === false ? "未启用" : "可用"));
    const count = source.templateCount === undefined ? "模板数量未知" : `${source.templateCount} 个模板`;
    const cacheText = cacheLabel(source, cache);
    info.append(
      node("h3", String(source.sourceLabel ?? source.name ?? providerId)),
      node("p", [providerId, health, count, source.includeInDefaultSearch === false ? "未加入默认搜索" : "默认搜索", cacheText].filter(Boolean).join(" · ")),
    );
    const actions = node("div", undefined, "provider-actions");
    const status = records(cache.sources).find((item) => item.providerId === providerId);
    if (status?.delivery === "download" && Number(status.missing) > 0) {
      actions.append(action("缓存图片", () => cachePreviews(providerId)));
    }
    if (kind === "official-signed-overlay" || kind === "signed-personal") {
      actions.append(action("更新图库", () => changeProviderSource("更新图库", { action: "update", providerId }), true));
    }
    if (kind === "signed-personal") {
      const include = source.includeInDefaultSearch !== false;
      actions.append(action(include ? "移出默认搜索" : "加入默认搜索", () => changeProviderSource(include ? "移出默认搜索" : "加入默认搜索", {
        action: "configure", providerId, includeInDefaultSearch: !include,
      }), true));
    }
    row.append(info, actions);
    target.append(row);
  }
}
async function loadPreviewCache() {
  return api<Record<string, unknown>>("preview-cache");
}
async function cachePreviews(providerId?: string) {
  let safety = 0;
  while (safety++ < 200) {
    if (stopped) return;
    const cache = await api<Record<string, unknown>>("preview-cache", { limit: 24, ...(providerId ? { providerId } : {}) });
    renderCacheBanner(el("setup-banner").hidden === false, cache);
    const sources = records(cache.sources).filter((item) => !providerId || item.providerId === providerId);
    const missing = sources.filter((item) => item.delivery === "download" && Number(item.missing) > 0);
    const filled = sources.reduce((sum, item) => sum + Number(item.filled ?? 0), 0);
    const failed = sources.reduce((sum, item) => sum + Number(item.failed ?? 0), 0);
    if (!missing.length) {
      notify(providerId ? "该来源的图片已缓存。" : "图库图片已缓存，可以离线浏览。");
      await loadStatus();
      return;
    }
    if (filled === 0 && failed > 0) {
      const first = records(sources[0]?.errors)[0];
      throw new Error(String(first?.message ?? "缓存失败，请检查网络后重试"));
    }
  }
  throw new Error("缓存尚未完成，请再试一次");
}
async function changeProviderSource(title: string, args: Record<string, unknown>) {
  const planned = await call("figure_library_plan_provider_source_change", args);
  const data = details(planned);
  if (record(data.envelope).code === "provider_source_already_current" || record(data.result).status === "already_current") {
    notify("该图库已是最新，无需更新。");
    return;
  }
  const plan = record(data.plan);
  reviewPlan(title, planned, async () => {
    await call("figure_library_apply_provider_source_change", {
      planDigest: plan.planDigest, operationId: crypto.randomUUID(),
      expectedAction: plan.action, expectedProviderId: plan.providerId,
    }, true);
    if (args.action === "add") form("add-source-form").reset();
    notify(args.action === "add" ? "来源已添加，目录快照已缓存。可在列表中更新，或加入默认搜索。" : "图库来源已更新。");
    await loadStatus();
  });
}
async function addProviderSource() {
  await changeProviderSource("添加图片来源", {
    action: "add",
    expectedProviderId: input("source-provider-id").value.trim(),
    manifestUrl: input("source-manifest-url").value.trim(),
    publicKeyBase64: input("source-public-key").value.trim(),
    includeInDefaultSearch: input("source-default-search").checked,
  });
}
async function loadStatus() {
  const response = await call("figure_library_source_status");
  if (stopped) return;
  const data = details(response);
  const library = record(data.library);
  const workspace = record(data.workspace);
  const setupRequired = record(data.setup).required === true;
  if (library.root && library.directorySource !== "legacy-default") input("library-directory").value = String(library.root);
  if (workspace.root) input("workspace-directory").value = String(workspace.root);
  const state = await api<Record<string, unknown>>("state");
  if (stopped) return;
  canShutdown = state.canShutdown === true;
  button("shutdown").hidden = !canShutdown;
  el("connection-state").textContent = `本地服务 · ${String(state.version)}`;
  const providers = await call("figure_library_list_provider_sources");
  const cache = await loadPreviewCache();
  if (stopped) return;
  const sourceRows = providerSources(providers);
  renderCacheBanner(setupRequired, cache);
  renderSearchProviders(sourceRows);
  renderProviderList(sourceRows, cache);
  refreshSelection();
}
async function bindDirectories() {
  const libraryDirectory = input("library-directory").value.trim();
  const localWorkspaceDirectory = input("workspace-directory").value.trim();
  const planned = await call("figure_library_plan_bind_global", { libraryDirectory, migrationMode: "none" });
  const plan = record(details(planned).plan);
  reviewPlan("绑定全局图库", planned, async () => {
    await call("figure_library_apply_bind_global", { planDigest: plan.planDigest, operationId: crypto.randomUUID() }, true);
    const workspacePlan = await call("figure_library_plan_bind_workspace", { workspaceDirectory: localWorkspaceDirectory });
    const prepared = record(details(workspacePlan).plan);
    reviewPlan("绑定本地工作区", workspacePlan, async () => {
      await call("figure_library_apply_bind_workspace", { planDigest: prepared.planDigest, operationId: crypto.randomUUID() }, true);
      const cache = await loadPreviewCache();
      notify(cache.downloadable === true && cache.complete !== true ? "本机目录已绑定。请缓存图库图片。" : "本机目录已绑定，可以搜索或导入资产。");
    });
  });
}
async function loadLibrary() {
  const items = records(details(requireResult(await api("library"))).items);
  const target = el("library-items");
  target.replaceChildren();
  if (!items.length) { target.append(node("div", "知识库还没有资产。导入图片和代码，开始积累你的可复用参考。", "local-empty")); return; }
  for (const item of items) {
    const row = node("article", undefined, "library-row");
    const info = node("div");
    info.append(node("h3", String(item.title)), node("p", `${item.workingHead ? "有待审阅草稿" : "已发布"} · ${String(item.templateId)}`));
    row.append(info, action("查看与管理", () => showLibraryDetail(String(item.templateId))));
    target.append(row);
  }
}
async function showLibraryDetail(templateId: string) {
  const response = await call("figure_library_review_open", { templateId });
  const data = details(response);
  const content = record(data.workingContent ?? data.publishedContent);
  const modal = node("dialog", undefined, "local-dialog");
  const close = action("关闭", async () => modal.close(), true);
  modal.append(close, node("h2", String(content.title)), renderMarkdown(document, String(content.description ?? ""), async (url) => safeLink(url)));
  if (content.primaryPreview) {
    const asset = requireResult(await api("asset", { templateId, revisionId: content.revisionId, contentDigest: content.contentDigest, logicalPath: content.primaryPreview }));
    const assetData = details(asset);
    const image = node("img");
    image.src = `data:${String(assetData.mimeType)};base64,${String(assetData.data)}`;
    image.alt = String(content.title);
    image.style.maxWidth = "100%";
    modal.append(image);
  }
  const review = record(data.workingReview ?? data.publishedReview);
  for (const finding of [...records(review.validationErrors), ...records(review.blockingGates), ...records(review.warnings)]) modal.append(node("p", String(finding.message)));
  for (const asset of records(content.assets).filter((item) => item.role === "code")) {
    modal.append(action(`查看代码：${String(asset.logicalPath)}`, async () => {
      const response = requireResult(await api("asset", { templateId, revisionId: content.revisionId, contentDigest: content.contentDigest, logicalPath: asset.logicalPath }));
      const raw = Uint8Array.from(atob(String(details(response).data)), (char) => char.charCodeAt(0));
      const pre = node("pre", new TextDecoder().decode(raw));
      modal.append(pre);
    }, true));
  }
  const actions = node("div", undefined, "dialog-actions");
  actions.append(action("更新图片与代码", async () => {
    editingTemplateId = templateId;
    for (const key of ["title", "description", "application", "dataProfile", "license", "language"]) {
      const field = form("import-form").elements.namedItem(key) as HTMLInputElement | null;
      if (field) field.value = String(content[key] ?? "");
    }
    modal.close();
    await showPage("import");
    notify("更新这份资产：请选择本次完整的图片和代码，确认后创建新修订。");
  }, true));
  if (data.workingContent) {
    actions.append(action("发布草稿", async () => {
      const planned = await call("figure_library_plan_publish_working_revision", { templateId });
      const plan = record(details(planned).plan);
      modal.close();
      reviewPlan("发布为不可变版本", planned, async () => {
        await call("figure_library_apply_publish_working_revision", { planDigest: plan.planDigest, operationId: crypto.randomUUID(), expectedTemplateId: templateId, expectedSeriesDigest: plan.expectedSeriesDigest }, true);
        await loadLibrary();
        notify("已发布，普通搜索可以检索到这个版本。");
      });
    }));
    actions.append(action("丢弃草稿", async () => {
      const planned = await call("figure_library_plan_discard_working_revision", { templateId });
      const plan = record(details(planned).plan);
      modal.close();
      reviewPlan("丢弃当前草稿", planned, async () => {
        await call("figure_library_apply_discard_working_revision", { planDigest: plan.planDigest, operationId: crypto.randomUUID(), expectedTemplateId: templateId, expectedSeriesDigest: plan.expectedSeriesDigest }, true);
        await loadLibrary();
      });
    }, true));
  }
  const history = node("details");
  history.append(node("summary", "查看版本历史与审阅记录"), node("pre", JSON.stringify(data.history, null, 2)));
  modal.append(history, actions);
  modal.addEventListener("close", () => modal.remove());
  document.body.append(modal);
  modal.showModal();
}
async function importAsset() {
  const fields = new FormData(form("import-form"));
  const image = fields.get("image");
  const code = fields.get("code");
  if (!(image instanceof File) || !image.size || fields.get("confirmed") !== "on") throw new Error("请选择图片并确认资产边界与关联");
  const imagePath = await upload(image);
  const codePath = code instanceof File && code.size ? await upload(code) : undefined;
  const planned = await call("figure_library_plan_working_revision", {
    mode: editingTemplateId ? "update" : "create", ...(editingTemplateId ? { templateId: editingTemplateId } : {}),
    title: fields.get("title"), description: fields.get("description"), application: fields.get("application"),
    dataProfile: fields.get("dataProfile"), license: fields.get("license"), language: fields.get("language"),
    tags: String(fields.get("tags") ?? "").split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean),
    assetKind: codePath ? "plot_template" : "visual_reference", codeStatus: codePath ? "scaffold" : "none", executionStatus: "not_run",
    visualAssets: [{ assetId: "reference", sourcePath: imagePath, visualRole: "source_reference" }],
    codeAssets: codePath ? [{ assetId: "code", sourcePath: codePath, codeOrigin: "user_supplied", language: fields.get("language") }] : [],
    ...(codePath ? { canonicalCodeAssetId: "code", figureCodeLinks: [{ visualAssetId: "reference", codeAssetIds: ["code"], relationship: "user_supplied_pair", confirmedBy: "user", evidence: "用户在本地客户端提供图片与代码并明确确认关联。" }] } : {}),
    confirmations: { createOrUpdate: true, figureUnitBoundary: true, multiImageGrouping: true, primaryPreview: true, assetKind: true, canonicalImplementation: true, codeRelationships: true, codeOrigin: true, executionClaim: true, duplicateDecision: editingTemplateId ? "update_exact" : "create_new" },
  });
  const plan = record(details(planned).plan);
  reviewPlan(editingTemplateId ? "更新知识库资产" : "导入图片与代码", planned, async () => {
    await call("figure_library_apply_working_revision", { planDigest: plan.planDigest, operationId: crypto.randomUUID(), expectedAction: plan.action, expectedTemplateId: plan.templateId, expectedSeriesDigest: plan.expectedSeriesDigest }, true);
    editingTemplateId = undefined;
    form("import-form").reset();
    await showPage("library");
    notify("资产已保存为草稿。审阅后可发布为可检索版本。");
  });
}

for (const control of document.querySelectorAll<HTMLButtonElement>("button[data-page]")) control.addEventListener("click", () => void run(() => showPage(control.dataset.page!)));
for (const control of document.querySelectorAll<HTMLButtonElement>("button[data-query]")) control.addEventListener("click", () => { input("search-query").value = control.dataset.query!; void run(search, control); });
form("search-form").addEventListener("submit", (event) => { event.preventDefault(); void run(search, form("search-form").querySelector("button")!); });
form("binding-form").addEventListener("submit", (event) => { event.preventDefault(); void run(bindDirectories); });
form("add-source-form").addEventListener("submit", (event) => { event.preventDefault(); void run(addProviderSource, form("add-source-form").querySelector("button")!); });
button("cache-previews").onclick = () => void run(() => cachePreviews(), button("cache-previews"));
form("import-form").addEventListener("submit", (event) => { event.preventDefault(); void run(importAsset, form("import-form").querySelector<HTMLButtonElement>("button[type=submit]")!); });
button("refresh").onclick = () => void run(async () => { if (page === "library") await loadLibrary(); else await loadStatus(); });
button("next").onclick = () => void run(async () => { if (result?.pagination.nextCursor) displayResult(await call("figure_library_search_page", { resultSetId: result.resultSetId, cursor: result.pagination.nextCursor })); }, button("next"));
button("previous").onclick = () => { const previous = result && pages.get(result.pagination.pageIndex - 1); if (previous) display(previous); };
button("copy-selection").onclick = () => void run(async () => {
  await navigator.clipboard.writeText(JSON.stringify([...selected.values()].map(({ title, providerId, exactSelector }) => ({ title, providerId, exactSelector })), null, 2));
  notify("已复制所选模板的名称与精确引用。");
}, button("copy-selection"));
button("plan-apply").onclick = () => void run(async () => { await planAction?.(); }, button("plan-apply"));
button("plan-cancel").onclick = () => { planAction = undefined; dialog("plan-dialog").close(); };
button("materialize-cancel").onclick = () => dialog("materialize-dialog").close();
form("materialize-form").addEventListener("submit", (event) => { event.preventDefault(); void run(async () => {
  if (!pendingMaterialize) return;
  const { candidate, receipt } = pendingMaterialize;
  const planned = await call("figure_library_plan_materialize", { providerId: candidate.providerId, exactSelector: candidate.exactSelector, previewReceipt: receipt, destination: input("materialize-directory").value.trim(), allowNetwork: input("allow-network").checked });
  const plan = record(details(planned).plan);
  pendingMaterialize = undefined;
  dialog("materialize-dialog").close();
  reviewPlan("保存精确模板到项目", planned, async () => {
    await call("figure_library_apply_materialize", { planDigest: plan.planDigest, operationId: crypto.randomUUID(), expectedProviderId: candidate.providerId, expectedTarget: plan.target }, true);
    notify(`模板已保存到 ${String(plan.target)}。未执行绘图代码。`);
  });
}); });
button("copy-mcp").onclick = () => void run(async () => {
  await navigator.clipboard.writeText(JSON.stringify(await api("connection"), null, 2));
  notify("已复制使用当前运行时的 MCP 配置。");
}, button("copy-mcp"));
button("shutdown").onclick = () => void run(async () => {
  stopped = true;
  try { await api("shutdown", {}); }
  catch (error) { stopped = false; throw error; }
  document.querySelectorAll<HTMLButtonElement>("button").forEach((control) => { control.disabled = true; });
  el("connection-state").textContent = "本地服务已退出";
  notify("本地客户端已退出，可以关闭这个页面。");
});

async function connect() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("connect");
  if (ticket) { await api("connect", { ticket }); history.replaceState(null, "", location.pathname); }
  await loadStatus();

}
void run(connect);


function copyBlock(title: string, value: string, format = "") {
  const block = node("section", "", "integration-code");
  block.append(node("h3", title + (format ? ` · ${format}` : "")), node("pre", value));
  block.append(action("复制", async () => { await navigator.clipboard.writeText(value); notify(`已复制${title}。`); }, true));
  return block;
}
async function loadIntegrations() {
  const guide = await api<Record<string, unknown>>("integrations");
  const hosts = records(guide.hosts), snippets = records(guide.snippets);
  const picker = el<HTMLSelectElement>("integration-host");
  const previous = picker.value;
  picker.replaceChildren(...hosts.map(host => { const option = node("option", String(host.title)); option.value = String(host.id); return option; }));
  if (hosts.some(host => host.id === previous)) picker.value = previous;
  const render = () => {
    const host = hosts.find(item => item.id === picker.value) ?? hosts[0]!;
    const steps = node("ol", "");
    for (const step of host.steps as string[]) steps.append(node("li", step));
    el("integration-instructions").replaceChildren(steps);
    if (typeof host.documentationUrl === "string") el("integration-instructions").append(action("查看官方说明", async () => safeLink(String(host.documentationUrl)), true));
    el("integration-snippets").replaceChildren(...snippets.filter(item => (host.snippetIds as string[]).includes(String(item.id))).map(item => {
      const block = copyBlock(String(item.title), String(item.content), String(item.format));
      block.prepend(node("p", String(item.description)));
      return block;
    }));
    if (host.id === "other") el("integration-snippets").append(copyBlock("命令", String(guide.command)), copyBlock("参数（JSON 数组）", JSON.stringify(guide.args, null, 2)));
  };
  picker.onchange = render;
  render();
  el("integration-skill-help").textContent = String(guide.skillInstructions);
  el("integration-skill").replaceChildren(copyBlock("Skill 文件夹", String(guide.skillDirectory)), copyBlock("SKILL.md 路径", String(guide.skillPath)));
  el("integration-verify").replaceChildren(copyBlock("验证指令", String(guide.verificationPrompt)));
  el("integration-notes").replaceChildren(...(guide.notes as string[]).map(note => node("p", note)));
}
