import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SFL_BRAND_ICON_DATA_URI } from "../brand.ts";
import { bindModalScrollLock, mountExactPreviewImage, openCandidateDetail, parseSearchResult, renderCandidateCards, type Candidate, type DetailViewElements, type SearchResult } from "../view.ts";
import { renderMarkdown } from "../markdown.ts";
import { api, call, details, imageData, imageHash, record, records, requireResult, upload } from "./api.ts";
import "../styles.css";
import "./styles.css";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
const form = (id: string) => el<HTMLFormElement>(id);
const dialog = (id: string) => el<HTMLDialogElement>(id);
function openLockedModal(target: HTMLDialogElement) {
  target.showModal();
  bindModalScrollLock(document, target);
}
const titles: Record<string, string> = { discover: "图库", library: "我的图库", galleries: "外部图库", import: "创建参考图", integrations: "连接外部工具", settings: "设置" };
let page = "discover";
let result: SearchResult | undefined;
let selected = new Map<string, Candidate>();
const pages = new Map<number, SearchResult>();
let editingTemplateId: string | undefined;
let planAction: (() => Promise<void>) | undefined;
let pendingMaterialize: { candidate: Candidate; receipt: string; resultSetId: string } | undefined;
let canShutdown = false;
let stopped = false;
let cacheGalleries: Array<Record<string, unknown>> = [];
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
  if (page === "settings" || page === "galleries" || page === "discover") await loadStatus();
  if (page === "discover" && !result) await (input("search-query").value.trim() ? search() : loadGallery());
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
  el("results-title").textContent = parsed.query ? `“${parsed.query}”的候选图片` : "图库";
  el("results-count").textContent = `${parsed.pagination.total} 个结果`;
  const label = `第 ${parsed.pagination.pageIndex} / ${Math.max(1, Math.ceil(parsed.pagination.total / parsed.pagination.pageSize))} 页`;
  const prevDisabled = !pages.has(parsed.pagination.pageIndex - 1);
  const nextDisabled = !parsed.pagination.nextCursor;
  document.querySelectorAll<HTMLElement>(".gallery-pagination").forEach((nav) => {
    nav.hidden = parsed.pagination.total === 0;
    const pageLabel = nav.querySelector(".page-label");
    const previous = nav.querySelector<HTMLButtonElement>(".page-previous");
    const next = nav.querySelector<HTMLButtonElement>(".page-next");
    if (pageLabel) pageLabel.textContent = label;
    if (previous) previous.disabled = prevDisabled;
    if (next) next.disabled = nextDisabled;
  });
  refreshSelection();
}
function displayResult(value: CallToolResult) {
  requireResult(value);
  const parsed = parseSearchResult(value.structuredContent, value._meta);
  if (!parsed) throw new Error("无法读取候选图片列表");
  display(parsed);
}
function galleryArgs() {
  const provider = el<HTMLSelectElement>("search-provider").value;
  return { limit: 12, ...(provider ? { providerIds: [provider] } : {}) };
}
async function loadGallery() {
  input("search-query").value = "";
  displayResult(await api("gallery", galleryArgs()));
}
async function search() {
  const query = input("search-query").value.trim();
  if (!query) return loadGallery();
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
    openLockedModal(dialog("materialize-dialog"));
  }, view.confirmButton);
}
function planLine(label: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  const line = node("div", undefined, "plan-line");
  line.append(node("strong", label), node("span", typeof value === "string" ? value : JSON.stringify(value)));
  el("plan-summary").append(line);
}
function reviewPlan(title: string, response: CallToolResult, apply: () => Promise<void>) {
  const data = details(requireResult(response));
  const plan = record(data.plan);
  if (typeof plan.planDigest !== "string") throw new Error(String(record(data.envelope).summary ?? "没有生成可执行的计划"));
  el("plan-title").textContent = title;
  el("plan-summary").replaceChildren();
  planLine("操作", title);
  planLine("资产名称", record(plan.content).title ?? plan.templateId);
  planLine("图库来源", plan.providerId);
  planLine("清单地址", plan.manifestUrl);
  planLine("目标目录", plan.target ?? plan.libraryDirectory ?? plan.workspaceDirectory ?? plan.directory);
  planLine("网络下载", plan.allowNetwork === undefined ? undefined : plan.allowNetwork ? "允许下载所选固定版本" : "仅使用本地内容");
  planLine("说明", record(data.envelope).summary);
  const review = record(data.reviewSummary);
  for (const warning of records(review.warnings)) planLine("注意事项", warning.message);
  el("plan-json").textContent = JSON.stringify(data, null, 2);
  planAction = async () => { await apply(); dialog("plan-dialog").close(); planAction = undefined; await loadStatus(); };
  openLockedModal(dialog("plan-dialog"));
}
async function loadStatus() {
  const response = await call("figure_library_source_status");
  if (stopped) return;
  const data = details(response);
  const library = record(data.library);
  const workspace = record(data.workspace);
  el("setup-banner").hidden = record(data.setup).required !== true;
  if (library.root && library.directorySource !== "legacy-default") input("library-directory").value = String(library.root);
  if (workspace.root) input("workspace-directory").value = String(workspace.root);
  const state = await api<Record<string, unknown>>("state");
  if (stopped) return;
  canShutdown = state.canShutdown === true;
  button("shutdown").hidden = !canShutdown;
  el("connection-state").textContent = `本地服务 · ${String(state.version)}`;
  const sourceRows = listedSources(details(await call("figure_library_list_provider_sources")));
  renderSearchProviders(sourceRows);
  const network = await api<Record<string, unknown>>("network-access");
  input("use-system-proxy").checked = network.useSystemProxy === true;
  input("https-proxy").value = String(network.httpsProxy || network.detectedProxy || "");
  const source = String(network.source ?? "off");
  el("network-access-summary").textContent = source === "off"
    ? "当前未使用系统代理。"
    : source === "saved"
      ? `当前使用已保存的本机代理 ${String(network.activeProxy ?? "")}。`
      : `当前来自系统设置或环境变量 ${String(network.activeProxy ?? "")}。`;
  const cache = await api<Record<string, unknown>>("preview-cache");
  el("preview-cache-directory").textContent = String(cache.directory ?? "");
  const cacheBytes = Number(cache.bytes ?? 0);
  const cacheCount = Number(cache.fileCount ?? 0);
  cacheGalleries = records(cache.galleries);
  el("preview-cache-summary").textContent = cache.exists === true && cacheCount > 0
    ? `已缓存 ${cacheCount} 张图片 · ${formatBytes(cacheBytes)}`
    : cache.exists === true
      ? "缓存目录已创建，当前没有图片。"
      : "尚未缓存任何在线预览图。请先选择下面的某个图库。";
  renderPreviewCacheGalleries(cacheGalleries);
  renderProviderSources(sourceRows);
  refreshSelection();
}
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes | 0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function cacheGallery(providerId: string) {
  return cacheGalleries.find((gallery) => String(gallery.providerId) === providerId);
}
function galleryCacheLabel(gallery: Record<string, unknown>) {
  const declared = Number(gallery.declared ?? 0);
  const cached = Number(gallery.cached ?? 0);
  const missing = Number(gallery.missing ?? declared - cached);
  if (declared === 0) return "没有可下载的预览图";
  if (missing <= 0) return `已缓存 ${cached} / ${declared} 张 · ${formatBytes(Number(gallery.bytesCached ?? 0))}`;
  return `可下载 ${declared} 张 · 已缓存 ${cached} 张 · 约 ${formatBytes(Number(gallery.bytesDeclared ?? 0))}`;
}
async function prefetchGallery(providerId: string, sourceLabel: string, declared: number, bytesDeclared: number) {
  if (!window.confirm(`缓存「${sourceLabel}」的 ${declared} 张预览图（约 ${formatBytes(bytesDeclared)}）？只下载该图库的固定图片，不会执行代码。`)) return;
  const result = await api<Record<string, unknown>>("preview-cache", { action: "prefetch", providerId });
  await loadStatus();
  const prefetch = record(result.prefetch);
  const failed = Number(prefetch.failed ?? 0);
  const downloaded = Number(prefetch.downloaded ?? 0);
  const already = Number(prefetch.alreadyCached ?? 0);
  notify(failed > 0
    ? `「${sourceLabel}」已下载 ${downloaded} 张，已有 ${already} 张，失败 ${failed} 张。可检查系统代理后重试。`
    : downloaded > 0
      ? `「${sourceLabel}」已缓存 ${downloaded + already} 张预览图。`
      : `「${sourceLabel}」的预览图已在缓存中。`);
}
function renderPreviewCacheGalleries(galleries: Array<Record<string, unknown>>) {
  const target = el("preview-cache-galleries");
  target.replaceChildren();
  if (!galleries.length) {
    target.append(node("p", "当前安装已包含图库图片，或尚未出现可下载清单。轻量安装包里的 FigureYa 与 Open Figure 需要在这里按图库下载。"));
    return;
  }
  for (const gallery of galleries) {
    const providerId = String(gallery.providerId ?? "");
    const label = String(gallery.sourceLabel ?? providerId);
    const missing = Number(gallery.missing ?? 0);
    const row = node("article", undefined, "cache-gallery");
    const info = node("div");
    info.append(node("h3", label), node("p", galleryCacheLabel(gallery)));
    row.append(info);
    if (missing > 0) {
      row.append(action("缓存图片", () => prefetchGallery(providerId, label, Number(gallery.declared ?? 0), Number(gallery.bytesDeclared ?? 0)), true));
    } else {
      row.append(node("p", "已缓存"));
    }
    target.append(row);
  }
}
function listedSources(providerData: Record<string, unknown>) {
  const result = record(providerData.result);
  return records(result.sources ?? providerData.sources ?? providerData.providers);
}
function sourceKindLabel(source: Record<string, unknown>) {
  const kind = String(source.sourceKind ?? "");
  if (kind === "local-published") return "本机已发布";
  if (kind === "figureya") return "内置 FigureYa";
  if (kind === "official-signed-overlay") return "官方频道";
  if (kind === "signed-personal") return "个人来源";
  if (source.frozen === true) return "冻结兼容";
  if (source.bundled === true) return "内置";
  return kind || "来源";
}
function sourceAddress(source: Record<string, unknown>) {
  const details = record(source.details);
  return String(source.manifestUrl ?? details.manifestUrl ?? "");
}
function sourceHealth(source: Record<string, unknown>) {
  if (source.enabled === false) return "未启用";
  const health = String(source.health ?? "ready");
  if (health === "ready") return "可用";
  if (health === "degraded") return "降级";
  if (health === "corrupt") return "损坏";
  return health;
}
function renderSearchProviders(sources: Array<Record<string, unknown>>) {
  const picker = el<HTMLSelectElement>("search-provider");
  const current = picker.value;
  picker.replaceChildren();
  const all = node("option", "全部默认来源") as HTMLOptionElement;
  all.value = "";
  picker.append(all);
  for (const source of sources) {
    if (source.enabled === false) continue;
    const option = node("option", String(source.sourceLabel ?? source.providerId)) as HTMLOptionElement;
    option.value = String(source.providerId);
    picker.append(option);
  }
  if ([...picker.options].some((option) => option.value === current)) picker.value = current;
}
function renderProviderSources(sources: Array<Record<string, unknown>>) {
  const target = el("provider-list");
  target.replaceChildren();
  const external = sources.filter((source) => source.providerId !== "org.scientificfigurelibrary.local" && source.sourceKind !== "local-published");
  if (!external.length) {
    target.append(node("p", "尚未列出外部图库。绑定本机目录后可查看内置图库，也可添加已签名图库。"));
    return;
  }
  for (const source of external) {
    const providerId = String(source.providerId ?? "");
    const personal = source.sourceKind === "signed-personal";
    const official = source.sourceKind === "official-signed-overlay";
    const card = node("article", undefined, "provider-source");
    card.append(node("h3", String(source.sourceLabel ?? providerId)));
    card.append(node("p", `${sourceKindLabel(source)} · ${sourceHealth(source)}${source.templateCount === undefined ? "" : ` · ${String(source.templateCount)} 个模板`}`));
    card.append(node("p", `图库 ID：${providerId}`));
    const address = sourceAddress(source);
    card.append(node("p", address ? `清单地址：${address}` : official || personal ? "清单地址未返回" : "安装包内置目录"));
    if (source.enabled === false) card.append(node("p", "已从普通搜索中移除，可恢复。"));
    else if (source.includeInDefaultSearch === true) card.append(node("p", "已加入默认搜索"));
    else card.append(node("p", "不参与默认搜索"));
    const autoRefresh = source.autoRefreshEnabled === true || record(source.details).autoRefreshEnabled === true;
    if (official && autoRefresh && source.enabled !== false) card.append(node("p", "官方频道自动刷新已开启"));
    const actions = node("div", undefined, "provider-actions");
    if (personal) {
      actions.append(action("检查更新", () => changeProvider("检查图库更新", { action: "update", providerId }), true));
      actions.append(action(source.includeInDefaultSearch === true ? "移出默认搜索" : "加入默认搜索", () => changeProvider("更改默认搜索", { action: "configure", providerId, includeInDefaultSearch: source.includeInDefaultSearch !== true }), true));
      const replace = node("div", undefined, "provider-replace");
      const url = node("input") as HTMLInputElement;
      url.placeholder = "新的签名清单 HTTPS 地址";
      url.value = address;
      replace.append(url, action("更换地址", async () => {
        const manifestUrl = url.value.trim();
        if (!manifestUrl) throw new Error("请填写新的清单地址");
        await changeProvider("更换图库地址", { action: "configure", providerId, manifestUrl });
      }, true));
      card.append(replace);
    } else if (official && source.enabled !== false) {
      actions.append(action("检查更新", () => changeProvider("检查官方 Open Figure Modules", { action: "update", providerId }), true));
      actions.append(action(autoRefresh ? "关闭自动刷新" : "开启自动刷新", () => changeProvider("更改官方自动刷新", { action: "configure", providerId, autoRefresh: !autoRefresh }), true));
    }
    const gallery = cacheGallery(providerId);
    if (gallery && Number(gallery.missing ?? 0) > 0) {
      actions.append(action("缓存图片", () => prefetchGallery(providerId, String(source.sourceLabel ?? providerId), Number(gallery.declared ?? 0), Number(gallery.bytesDeclared ?? 0)), true));
    }
    if (source.enabled === false && !personal) {
      actions.append(action("恢复", () => changeProvider("恢复图库", { action: "configure", providerId, enabled: true }), true));
    } else {
      actions.append(action("删除", async () => {
        const message = personal
          ? `删除 ${String(source.sourceLabel ?? providerId)}？这会取消注册，不会删除已下载快照或已物化项目。`
          : `移除 ${String(source.sourceLabel ?? providerId)}？普通搜索将不再包含它。安装文件仍保留，可随时恢复。已物化模板不受影响。`;
        if (!window.confirm(message)) return;
        await changeProvider(personal ? "删除图库" : "移除图库", { action: "remove", providerId });
      }, true));
    }
    if (actions.childNodes.length) card.append(actions);
    target.append(card);
  }
}
async function changeProvider(title: string, args: Record<string, unknown>) {
  const planned = await call("figure_library_plan_provider_source_change", args);
  const data = details(planned);
  const envelope = record(data.envelope);
  if (envelope.outcome === "ok") {
    notify(String(envelope.summary ?? "来源已是最新，无需 Apply。"));
    await loadStatus();
    return;
  }
  const plan = record(data.plan);
  reviewPlan(title, planned, async () => {
    await call("figure_library_apply_provider_source_change", {
      planDigest: plan.planDigest,
      operationId: crypto.randomUUID(),
      expectedAction: args.action,
      expectedProviderId: args.expectedProviderId ?? args.providerId,
    }, true);
    notify("来源配置已更新。");
    await loadStatus();
  });
}
async function bindDirectories() {
  const libraryDirectory = input("library-directory").value.trim();
  const localWorkspaceDirectory = input("workspace-directory").value.trim();
  const planned = await call("figure_library_plan_bind_global", { libraryDirectory, migrationMode: "none" });
  const plan = record(details(planned).plan);
  reviewPlan("绑定全局图库", planned, async () => {
    await call("figure_library_apply_bind_global", { planDigest: plan.planDigest, operationId: crypto.randomUUID() }, true);
    // The workspace has its own independent plan and approval.
    dialog("plan-dialog").close();
    const workspacePlan = await call("figure_library_plan_bind_workspace", { workspaceDirectory: localWorkspaceDirectory });
    const prepared = record(details(workspacePlan).plan);
    setTimeout(() => reviewPlan("绑定本地工作区", workspacePlan, async () => {
      await call("figure_library_apply_bind_workspace", { planDigest: prepared.planDigest, operationId: crypto.randomUUID() }, true);
      notify("本机目录已绑定，可以搜索或导入资产。");
    }), 0);
  });
}
async function loadLibrary() {
  const items = records(details(requireResult(await api("library"))).items);
  const target = el("library-items");
  target.replaceChildren();
  if (!items.length) { target.append(node("div", "我的图库还没有资产。用「创建参考图」收入图片和代码。", "local-empty")); return; }
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
  openLockedModal(modal);
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
  reviewPlan(editingTemplateId ? "更新参考图" : "创建参考图", planned, async () => {
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
el("discover-page").addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("button") : null;
  if (!(target instanceof HTMLButtonElement)) return;
  if (target.classList.contains("page-next")) {
    void run(async () => {
      if (!result?.pagination.nextCursor) return;
      displayResult(await call("figure_library_search_page", { resultSetId: result.resultSetId, cursor: result.pagination.nextCursor }));
      el("results-heading").scrollIntoView({ block: "start" });
    }, target);
  }
  if (target.classList.contains("page-previous")) {
    const previous = result && pages.get(result.pagination.pageIndex - 1);
    if (previous) {
      display(previous);
      el("results-heading").scrollIntoView({ block: "start" });
    }
  }
});
el<HTMLSelectElement>("search-provider").addEventListener("change", () => void run(async () => {
  if (input("search-query").value.trim()) await search();
  else await loadGallery();
}));
form("binding-form").addEventListener("submit", (event) => { event.preventDefault(); void run(bindDirectories); });
form("add-provider-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    await changeProvider("添加图库", {
      action: "add",
      expectedProviderId: input("add-provider-id").value.trim(),
      manifestUrl: input("add-provider-manifest").value.trim(),
      publicKeyBase64: input("add-provider-key").value.trim(),
      includeInDefaultSearch: input("add-provider-default-search").checked,
    });
  });
});
form("import-form").addEventListener("submit", (event) => { event.preventDefault(); void run(importAsset, form("import-form").querySelector<HTMLButtonElement>("button[type=submit]")!); });
button("refresh").onclick = () => void run(async () => {
  if (page === "library") await loadLibrary();
  else if (page === "discover") {
    await loadStatus();
    if (input("search-query").value.trim()) await search();
    else await loadGallery();
  } else await loadStatus();
});
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
button("save-proxy").onclick = () => void run(async () => {
  const network = await api<Record<string, unknown>>("network-access", {
    useSystemProxy: input("use-system-proxy").checked,
    httpsProxy: input("https-proxy").value.trim(),
  });
  await loadStatus();
  notify(network.useSystemProxy === true
    ? `已启用系统代理${network.activeProxy ? `：${String(network.activeProxy)}` : "，但未检测到本机回环代理"}。`
    : "已关闭系统代理，将直连 GitHub。");
}, button("save-proxy"));
button("copy-cache-path").onclick = () => void run(async () => {
  const directory = el("preview-cache-directory").textContent?.trim();
  if (!directory) throw new Error("还没有缓存目录");
  await navigator.clipboard.writeText(directory);
  notify("已复制缓存路径。");
}, button("copy-cache-path"));
button("clear-cache").onclick = () => void run(async () => {
  if (!window.confirm("清除已下载的在线预览图？之后需要重新对某个图库执行「缓存图片」，或再次查看当前页。已确认图片需要重新预览后再保存模板。")) return;
  const cleared = await api<Record<string, unknown>>("preview-cache", { action: "clear" });
  await loadStatus();
  notify(`已清除 ${Number(cleared.removed ?? 0)} 张缓存图片。`);
}, button("clear-cache"));
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
  await loadGallery();
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
