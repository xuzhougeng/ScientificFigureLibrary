import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  updateModelContextForHeadlessReview,
  updateModelContextForPlotSet,
} from "./handoff.ts";
import {
  openCandidateDetail,
  parseSearchResult,
  renderCandidateCards,
  renderPlotSetBar,
  mountExactPreviewImage,
  type Candidate,
  type DetailViewElements,
  type SearchResult,
} from "./view.ts";
import { VERSION } from "../src/version.ts";
import {
  applyWorkbenchDisplayMode,
  compactWorkbenchSummary,
  hostSupportsMode,
  isDisplayMode,
  type WorkbenchDisplayMode,
} from "./display-mode.ts";
import "./styles.css";

const root = document.getElementById("app")!;
const cards = document.getElementById("cards")!;
const empty = document.getElementById("empty")!;
const query = document.getElementById("query")!;
const status = document.getElementById("status")!;
const previous = document.getElementById("previous-page") as HTMLButtonElement;
const next = document.getElementById("next-page") as HTMLButtonElement;
const pageStatus = document.getElementById("page-status")!;
const plotSetBar = document.getElementById("plot-set-bar")!;
const plotSetCount = document.getElementById("plot-set-count")!;
const plotSetSubmit = document.getElementById("plot-set-submit") as HTMLButtonElement;
const displayControls = document.getElementById("display-controls")!;
const expandBrowse = document.getElementById("expand-browse") as HTMLButtonElement;
const keepVisible = document.getElementById("keep-visible") as HTMLButtonElement;
const reexpand = document.getElementById("reexpand") as HTMLButtonElement;
const pipSummary = document.getElementById("pip-summary")!;
const displayElements = {
  root,
  controls: displayControls,
  expandButton: expandBrowse,
  keepVisibleButton: keepVisible,
  reexpandButton: reexpand,
  pipSummary,
};
const app = new App(
  { name: "Scientific Figure Library", version: VERSION },
  { availableDisplayModes: ["inline", "fullscreen", "pip"] },
);

let activeResult: SearchResult | undefined;
let activeResultSetId: string | undefined;
let activeDetail: DetailViewElements | undefined;
const pageCache = new Map<number, SearchResult>();
const reportedCapabilities = new Set<string>();
const selectedCandidates = new Map<string, Candidate>();

function selectedIds() {
  return new Set(selectedCandidates.keys());
}

function refreshPlotSetBar() {
  renderPlotSetBar({
    bar: plotSetBar,
    submit: plotSetSubmit,
    countLabel: plotSetCount,
    selectedCount: selectedCandidates.size,
    canSubmit: Boolean(activeResult) && updateModelContextAvailable(),
  });
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function structured(result: CallToolResult) {
  return record(result.structuredContent);
}

function resultMeta(result: CallToolResult) {
  return record(result._meta);
}

function exactPreviewMeta(result: CallToolResult) {
  const exact = record(resultMeta(result)?.exactPreview);
  const previewDataUrl = exact?.previewDataUrl;
  const previewChallenge = exact?.previewChallenge;
  if (typeof previewDataUrl !== "string" || typeof previewChallenge !== "string") return;
  return { previewDataUrl, previewChallenge };
}

function serverToolsAvailable() {
  return Boolean(app.getHostCapabilities()?.serverTools);
}

function updateModelContextAvailable() {
  return Boolean(app.getHostCapabilities()?.updateModelContext?.text);
}

async function recordUiEvent(
  event:
    | "host.capabilities_detected"
    | "candidate.thumbnail_clicked"
    | "candidate.detail_opened"
    | "candidate.detail_closed"
    | "exact_preview.image_loaded"
    | "exact_preview.image_error"
    | "model_context.updated",
  candidate: Candidate,
  extra: {
    correlationId?: string;
    durationMs?: number;
    payloadBytes?: number;
    previewBytes?: number;
  } = {},
) {
  if (!activeResult || !serverToolsAvailable()) return;
  try {
    await app.callServerTool({
      name: "figure_library_record_ui_event",
      arguments: {
        event,
        resultSetId: activeResult.resultSetId,
        candidateId: candidate.candidateId,
        ...extra,
      },
    });
  } catch (error) {
    console.warn("Structured UI diagnostics unavailable", error);
  }
}

function updatePagination(result: SearchResult) {
  const pageCount = Math.max(1, Math.ceil(result.pagination.total / result.pagination.pageSize));
  pageStatus.textContent = `第 ${result.pagination.pageIndex || 1} / ${pageCount} 页 · 共 ${result.pagination.total} 个匹配`;
  previous.disabled = result.pagination.pageIndex <= 1;
  next.disabled = !result.pagination.hasMore;
}

function render(result: SearchResult) {
  if (activeDetail?.dialog.open) activeDetail.dialog.close();
  if (activeResultSetId !== result.resultSetId) {
    pageCache.clear();
    selectedCandidates.clear();
    activeResultSetId = result.resultSetId;
  }
  activeResult = result;
  pageCache.set(result.pagination.pageIndex, result);
  query.textContent = `“${result.query}” · v${result.libraryVersion} · protocol v${result.materializationProtocolVersion}`;
  updatePagination(result);
  renderCandidateCards({
    document,
    cards,
    empty,
    result,
    selectedIds: selectedIds(),
    onToggleSelect: (candidate, selected) => {
      if (selected) selectedCandidates.set(candidate.candidateId, candidate);
      else selectedCandidates.delete(candidate.candidateId);
      refreshPlotSetBar();
    },
    onDetail: (candidate, elements, opener) => {
      if (opener === elements.previewButton) {
        void recordUiEvent("candidate.thumbnail_clicked", candidate);
      }
      void recordUiEvent("candidate.detail_opened", candidate);
      activeDetail = openCandidateDetail({
        document,
        candidate,
        opener,
        serverToolsAvailable: serverToolsAvailable(),
        updateModelContextAvailable: updateModelContextAvailable(),
        onClosed: () => {
          void recordUiEvent("candidate.detail_closed", candidate);
          activeDetail = undefined;
        },
        onRequestExactPreview: (detail) => void loadExactPreview(candidate, detail),
        onRequestAgentReview: (detail) => void handoffForHeadlessReview(candidate, detail),
      });
    },
  });
  status.textContent = serverToolsAvailable()
    ? "请先在 App 内浏览候选详情；只有你请求精确预览并确认后，才会把选择交给 Agent。"
    : updateModelContextAvailable()
      ? "当前 Host 未提供 serverTools；可勾选 1 到 8 个模板交给 Agent 绘制，或打开详情做单张审核。"
      : "当前 Host 既未提供 serverTools，也未提供 updateModelContext；只能浏览当前页基础详情。";
  if (result.diagnosticsDegraded) {
    status.textContent += " 诊断日志处于降级状态。";
  }
  const first = result.candidates[0];
  refreshPlotSetBar();
  if (first && !reportedCapabilities.has(result.resultSetId) && serverToolsAvailable()) {
    reportedCapabilities.add(result.resultSetId);
    void recordUiEvent("host.capabilities_detected", first);
  }
}

async function submitPlotSet() {
  if (!activeResult || !updateModelContextAvailable()) {
    status.textContent = "当前 Host 无法通过 updateModelContext 交接多选结果。";
    return;
  }
  const chosen = [...selectedCandidates.values()];
  if (chosen.length < 1 || chosen.length > 8) {
    status.textContent = "请选择 1 到 8 个模板后再交给 Agent 绘制。";
    return;
  }
  plotSetSubmit.disabled = true;
  plotSetSubmit.textContent = "正在交给 Agent…";
  try {
    await updateModelContextForPlotSet({
      resultSetId: activeResult.resultSetId,
      candidates: chosen,
      updateModelContext: (input) => app.updateModelContext(input),
    });
    status.textContent = `已把 ${chosen.length} 个模板交给 Agent 绘制；请在当前课题项目中逐张出图。`;
    plotSetSubmit.textContent = `已交给 Agent（${chosen.length}）`;
  } catch (error) {
    console.error(error);
    status.textContent = "多选交接失败；请重试或在对话中列出要画的模板。";
    refreshPlotSetBar();
  }
}

async function handoffForHeadlessReview(
  candidate: Candidate,
  elements: DetailViewElements,
) {
  if (!activeResult || serverToolsAvailable() || !updateModelContextAvailable()) {
    elements.confirmButton.disabled = true;
    elements.status.textContent =
      "当前 Host 无法通过 updateModelContext 交接选择；未启动 Agent 审核。";
    return;
  }
  const resultSetId = activeResult.resultSetId;
  elements.confirmButton.disabled = true;
  elements.confirmButton.textContent = "正在交给 Agent…";
  elements.status.textContent =
    "正在交接这个候选；不会在 App 内伪装精确预览，也不会授权 Apply。";
  try {
    await updateModelContextForHeadlessReview({
      resultSetId,
      candidate,
      updateModelContext: (input) => app.updateModelContext(input),
    });
    elements.confirmButton.textContent = "已选择并交给 Agent";
    elements.confirmButton.setAttribute("aria-pressed", "true");
    elements.status.textContent =
      "已交给 Agent 对这个候选执行一次 headless 精确审核；该路径不代表精确图片已在 App 内加载。";
    status.textContent = `已选择 ${candidate.templateId} 并交给 Agent 审核；尚未授权 Apply。`;
  } catch (error) {
    console.error(error);
    elements.confirmButton.disabled = false;
    elements.confirmButton.textContent = "重试交给 Agent 审核";
    elements.status.textContent = "Host 上下文更新失败；没有启动 Agent 审核。";
    status.textContent = "选择交接失败；请重试或在对话中明确指定候选。";
  }
}

async function publishSelection(
  candidate: Candidate,
  previewReceipt: string,
  confirmationMode: string,
  previewSha256: string,
) {
  const markdown = `---
source: Scientific Figure Library MCP App
selectedTemplate: ${candidate.templateId}
templateProvider: ${candidate.providerId}
exactSelector: ${JSON.stringify(candidate.exactSelector)}
previewSha256: ${previewSha256}
previewReceipt: ${previewReceipt}
previewConfirmationMode: ${confirmationMode}
---

The user selected and confirmed **${candidate.title}**. Use the unchanged providerId, exactSelector, preview hash, and single-use previewReceipt for figure_library_plan_materialize.`;
  if (app.getHostCapabilities()?.updateModelContext?.text) {
    await app.updateModelContext({ content: [{ type: "text", text: markdown }] });
    await recordUiEvent("model_context.updated", candidate, {
      payloadBytes: new TextEncoder().encode(markdown).byteLength,
    });
    status.textContent = `已确认 ${candidate.templateId}，并把一次性选择凭证交给 Agent。`;
    return true;
  } else {
    status.textContent = `已确认 ${candidate.templateId}，但 Host 不支持上下文更新。一次性凭证：${previewReceipt}`;
    return false;
  }
}

async function confirmCandidate(
  candidate: Candidate,
  elements: DetailViewElements,
  previewChallenge: string,
  previewSha256: string,
) {
  elements.confirmButton.disabled = true;
  elements.confirmButton.textContent = "正在确认…";
  let previewReceipt: string;
  let confirmationMode: string;
  try {
    const result = await app.callServerTool({
      name: "figure_library_confirm_selection",
      arguments: { previewChallenge },
    });
    const value = structured(result);
    const returnedReceipt = value?.previewReceipt;
    const returnedMode = value?.confirmationMode;
    if (typeof returnedReceipt !== "string" || typeof returnedMode !== "string") {
      throw new Error("confirmation tool omitted previewReceipt");
    }
    previewReceipt = returnedReceipt;
    confirmationMode = returnedMode;
  } catch (error) {
    console.error(error);
    elements.confirmButton.disabled = false;
    elements.confirmButton.textContent = "重新确认并交给 Agent";
    elements.status.textContent = "确认失败；未签发 materialize 凭证，请重新加载精确预览。";
    status.textContent = "确认失败；未签发 materialize 凭证。";
    return;
  }
  elements.confirmButton.textContent = "已确认并交给 Agent";
  elements.confirmButton.setAttribute("aria-pressed", "true");
  try {
    const handedOff = await publishSelection(
      candidate,
      previewReceipt,
      confirmationMode,
      previewSha256,
    );
    elements.status.textContent = handedOff
      ? "确认完成；Agent 现在可以创建 materialize plan。"
      : "确认凭证已签发，但 Host 不支持上下文更新。请复制侧栏状态中的凭证交给 Agent。";
  } catch (error) {
    console.error(error);
    elements.status.textContent =
      "确认凭证已签发，但 Host 上下文更新失败。不要重复确认；请复制侧栏状态中的凭证交给 Agent。";
    status.textContent = `已确认 ${candidate.templateId}，但 Host 上下文更新失败。一次性凭证：${previewReceipt}`;
  }
}

async function loadExactPreview(candidate: Candidate, elements: DetailViewElements) {
  if (!activeResult || !serverToolsAvailable()) {
    elements.status.textContent = "当前 Host 不支持 App→Server Tool，无法形成用户可见确认。";
    return;
  }
  const operationStartedAt = performance.now();
  elements.exactPreviewButton.disabled = true;
  elements.confirmButton.disabled = true;
  elements.exactPreviewButton.textContent = "正在加载精确预览…";
  elements.status.textContent = `正在读取 ${candidate.templateId} 的精确预览；不会写文件或下载模板。`;
  status.textContent = `正在 App 内读取 ${candidate.templateId} 的精确预览。`;
  try {
    const result = await app.callServerTool({
      name: "figure_library_preview_exact",
      arguments: {
        resultSetId: activeResult.resultSetId,
        providerId: candidate.providerId,
        exactSelector: candidate.exactSelector,
      },
    });
    const value = structured(result);
    const correlationId = value?.correlationId;
    const previewSha256 = value?.previewSha256;
    const previewBytes = value?.bytes;
    const exact = exactPreviewMeta(result);
    if (
      !exact ||
      typeof correlationId !== "string" ||
      typeof previewSha256 !== "string" ||
      typeof previewBytes !== "number"
    ) {
      throw new Error("exact preview omitted component image metadata or challenge");
    }
    mountExactPreviewImage({
      document,
      elements,
      dataUrl: exact.previewDataUrl,
      alt: `${candidate.title} 精确预览`,
      onLoaded: () => {
        void recordUiEvent("exact_preview.image_loaded", candidate, {
          correlationId,
          durationMs: performance.now() - operationStartedAt,
          previewBytes,
        });
        elements.exactPreviewButton.textContent = "精确预览已加载";
        elements.confirmButton.textContent = "确认并交给 Agent";
        elements.confirmButton.onclick = () =>
          void confirmCandidate(candidate, elements, exact.previewChallenge, previewSha256);
        elements.status.textContent = `精确预览已在侧栏加载。检查图像后再确认 ${candidate.templateId}。`;
        status.textContent = "精确预览已加载；等待用户在详情中确认。";
      },
      onError: () => {
        void recordUiEvent("exact_preview.image_error", candidate, {
          correlationId,
          durationMs: performance.now() - operationStartedAt,
          previewBytes,
        });
        elements.exactPreviewButton.textContent = "精确预览加载失败";
        elements.status.textContent = "精确预览未在侧栏加载成功，因此不能确认或 materialize。";
        status.textContent = "精确预览加载失败；未形成确认。";
      },
    });
  } catch (error) {
    console.error(error);
    elements.confirmButton.disabled = true;
    elements.exactPreviewButton.textContent = "精确预览不可用";
    elements.status.textContent = "精确预览读取或校验失败；该候选不能确认或 materialize。";
    status.textContent = "精确预览读取失败；未形成确认。";
  }
}

async function loadNextPage() {
  if (!activeResult?.pagination.nextCursor || !serverToolsAvailable()) return;
  next.disabled = true;
  status.textContent = "正在 App 内加载下一页候选缩略图…";
  try {
    const result = await app.callServerTool({
      name: "figure_library_search_page",
      arguments: {
        resultSetId: activeResult.resultSetId,
        cursor: activeResult.pagination.nextCursor,
      },
    });
    const parsed = parseSearchResult(result.structuredContent, result._meta);
    if (!parsed) throw new Error("unrecognized search page");
    render(parsed);
  } catch (error) {
    console.error(error);
    next.disabled = false;
    status.textContent = "下一页加载失败或结果集已变化；请回到对话重新搜索。";
  }
}

function loadPreviousPage() {
  if (!activeResult) return;
  const cached = pageCache.get(activeResult.pagination.pageIndex - 1);
  if (cached) render(cached);
}

function pipSummaryText() {
  const pageCount = activeResult
    ? Math.max(1, Math.ceil(activeResult.pagination.total / activeResult.pagination.pageSize))
    : undefined;
  return compactWorkbenchSummary({
    query: activeResult?.query ?? query.textContent ?? "",
    pageIndex: activeResult?.pagination.pageIndex,
    pageCount,
    selectedTitles: [...selectedCandidates.values()].map((candidate) => candidate.title),
  });
}

function refreshDisplayChrome(mode?: WorkbenchDisplayMode) {
  const context = app.getHostContext();
  const requested =
    mode ??
    (isDisplayMode(context?.displayMode) ? context.displayMode : isDisplayMode(root.dataset.displayMode) ? root.dataset.displayMode : "inline");
  return applyWorkbenchDisplayMode({
    elements: displayElements,
    mode: requested,
    available: context?.availableDisplayModes,
    summary: pipSummaryText(),
  });
}

async function requestWorkbenchMode(mode: WorkbenchDisplayMode) {
  const context = app.getHostContext();
  if (!hostSupportsMode(context?.availableDisplayModes, mode)) {
    refreshDisplayChrome();
    return;
  }
  try {
    const result = await app.requestDisplayMode({ mode });
    const applied = isDisplayMode(result.mode) ? result.mode : mode;
    refreshDisplayChrome(applied);
    if (applied !== mode) {
      status.textContent = `Host 将工作台放在 ${applied}，而不是请求的 ${mode}。`;
    }
  } catch (error) {
    console.warn("Display mode request failed", error);
    refreshDisplayChrome();
    status.textContent = "当前 Host 未能切换展示模式。";
  }
}

function applyHostContext(context: NonNullable<ReturnType<App["getHostContext"]>>) {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  if (context.safeAreaInsets) {
    root.style.paddingTop = `${context.safeAreaInsets.top + 20}px`;
    root.style.paddingRight = `${context.safeAreaInsets.right + 20}px`;
    root.style.paddingBottom = `${context.safeAreaInsets.bottom + 20}px`;
    root.style.paddingLeft = `${context.safeAreaInsets.left + 20}px`;
  }
  refreshDisplayChrome(isDisplayMode(context.displayMode) ? context.displayMode : undefined);
}

previous.addEventListener("click", loadPreviousPage);
next.addEventListener("click", () => void loadNextPage());
plotSetSubmit.addEventListener("click", () => void submitPlotSet());
expandBrowse.addEventListener("click", () => void requestWorkbenchMode("fullscreen"));
keepVisible.addEventListener("click", () => void requestWorkbenchMode("pip"));
reexpand.addEventListener("click", () => void requestWorkbenchMode("fullscreen"));

app.ontoolinput = (input) => {
  const request = input.arguments as Record<string, unknown>;
  if (typeof request.query === "string") query.textContent = `“${request.query}”`;
};
app.ontoolresult = (result) => {
  const parsed = parseSearchResult(result.structuredContent, result._meta);
  if (parsed) render(parsed);
};
app.onhostcontextchanged = applyHostContext;

window.addEventListener("error", (event) => {
  console.error(event.error);
  status.textContent = "MCP App 发生错误；未完成侧栏确认，不能 materialize。";
});
window.addEventListener("unhandledrejection", (event) => {
  console.error(event.reason);
  status.textContent = "MCP App 发生错误；未完成侧栏确认，不能 materialize。";
});

app
  .connect()
  .then(() => {
    const context = app.getHostContext();
    if (context) applyHostContext(context);
    else refreshDisplayChrome();
    if (!serverToolsAvailable()) {
      status.textContent = updateModelContextAvailable()
        ? "当前 Host 未授权 serverTools；仍可查看当前页详情并选择一个候选交给 Agent 审核。"
        : "当前 Host 未授权 serverTools 或 updateModelContext；只能查看已返回的基础详情。";
    }
  })
  .catch((error: unknown) => {
    console.error(error);
    status.textContent = "无法连接 MCP Host；仍可读取已返回的基础候选数据，但不能确认或 materialize。";
  });
