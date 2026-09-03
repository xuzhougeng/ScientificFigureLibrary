import type {
  CanonicalPreviewDecisionSummary,
  ValidationStateSummaryV1,
} from "../src/types.ts";

export interface CandidatePreviewMeta {
  previewDataUrl: string;
  previewMimeType?: "image/png" | "image/jpeg" | "image/webp";
  previewByteLength?: number;
  previewSha256?: string;
}

export interface Candidate {
  candidateId: string;
  templateId: string;
  providerId: string;
  exactSelector: {
    schema: "figure-library.provider-selector.v1";
    providerId: string;
    kind: string;
    identity: Record<string, unknown>;
  };
  sourceLabel: string;
  title: string;
  retrievalScore: number;
  reasons: string[];
  warnings: string[];
  excerpt: string;
  description: string;
  scientificQuestion?: string;
  application?: string;
  dataProfile?: string;
  inputFiles: string[];
  codeFiles?: string[];
  packages: string[];
  materializable: boolean;
  previewAvailable: boolean;
  searchPreviewAvailable?: boolean;
  previewStatus?: "ready" | "missing" | "unreadable" | "unsupported" | "too_large";
  searchPreviewStatus?: "ready" | "missing" | "unreadable" | "unsupported" | "too_large";
  previewDataUrl?: string;
  previewMimeType?: "image/png" | "image/jpeg" | "image/webp";
  previewByteLength?: number;
  previewSha256?: string;
  materializationModes?: Array<"template" | "full">;
  materializationSelectors?: Partial<Record<"template" | "full", Candidate["exactSelector"]>>;
  assetKind: "plot_template" | "visual_reference";
  language: string;
  plotFamily: string;
  reviewStatus: "not_reviewed" | "draft" | "approved" | "archived";
  codeStatus: "none" | "scaffold" | "provided" | "reviewed";
  executionStatus: "not_run" | "passed" | "failed" | "unknown";
  validationState?: ValidationStateSummaryV1;
  canonicalPreviewDecision?: CanonicalPreviewDecisionSummary;
  upstreamStatus?: "published" | "available" | "unavailable" | "unknown";
  publisherReviewStatus?: "approved" | "not_reviewed";
  publisherExecutionStatus?: "not_run" | "passed" | "failed";
  publisherExecutionScope?: "synthetic_data" | "example_data" | "real_data" | "unknown";
  publisherEvidence?: string[];
  codeExecutedBySflClient?: false;
  management: {
    templateId: string;
    adapter?: "direct" | "gallery" | "figure-transfer-package";
    registrySourceId?: string;
    galleryId?: string;
    identityMode?: "stable-source" | "content-addressed";
    canArchive: boolean;
    canUpdate: boolean;
    updateVia?: "plan-apply" | "diff-upsert" | "gallery-sync";
  };
}

export interface SearchResult {
  query: string;
  libraryVersion: string;
  materializationProtocolVersion: number;
  intentFamilies: string[];
  reviewRequired: boolean;
  resultSetId: string;
  correlationId?: string;
  diagnosticsDegraded?: boolean;
  pagination: {
    total: number;
    pageIndex: number;
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  candidates: Candidate[];
}

export interface CandidateElements {
  card: HTMLElement;
  previewButton: HTMLButtonElement;
  titleButton: HTMLButtonElement;
  detailButton: HTMLButtonElement;
}

export interface DetailViewElements {
  dialog: HTMLDialogElement;
  preview: HTMLElement;
  status: HTMLElement;
  exactPreviewButton: HTMLButtonElement;
  confirmButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
}

export function mountExactPreviewImage(options: {
  document: Document;
  elements: DetailViewElements;
  dataUrl: string;
  alt: string;
  onLoaded: () => void;
  onError: () => void;
}) {
  const image = options.document.createElement("img");
  image.alt = options.alt;
  image.decoding = "async";
  options.elements.confirmButton.disabled = true;
  image.addEventListener("load", () => {
    options.elements.confirmButton.disabled = false;
    options.onLoaded();
  });
  image.addEventListener("error", () => {
    options.elements.confirmButton.disabled = true;
    options.onError();
  });
  image.src = options.dataUrl;
  options.elements.preview.replaceChildren(image);
  return image;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(document: Document, className: string, text: string) {
  const node = element(document, "button", className, text);
  node.type = "button";
  return node;
}

function chips(document: Document, values: string[], maximum = 6) {
  const container = element(document, "div", "chips");
  for (const value of values.slice(0, maximum)) {
    container.append(element(document, "span", "chip", value));
  }
  return container;
}

function previewFailureLabel(status: Candidate["previewStatus"]) {
  if (status === "too_large") return "缩略图超过安全传输上限";
  if (status === "unsupported") return "预览格式不受支持";
  if (status === "unreadable") return "预览校验或读取失败";
  return "无可用预览";
}

function effectiveCandidateValidationState(
  candidate: Candidate,
): ValidationStateSummaryV1 {
  const value = candidate.validationState;
  if (
    value?.schema === "figure-library.validation-state.v1" &&
    value.plotExecution &&
    value.upstreamWorkflow &&
    value.scientificValidation
  ) {
    return value;
  }
  return {
    schema: "figure-library.validation-state.v1",
    plotExecution: {
      status:
        candidate.executionStatus === "passed" || candidate.executionStatus === "failed"
          ? candidate.executionStatus
          : "not_run",
      scope: "unknown",
    },
    upstreamWorkflow: { status: "unknown" },
    scientificValidation: { status: "not_assessed" },
  };
}

function validationSummaryLines(candidate: Candidate) {
  const state = effectiveCandidateValidationState(candidate);
  return [
    `绘图执行：${state.plotExecution.status}（范围：${state.plotExecution.scope}）`,
    `上游流程：${state.upstreamWorkflow.status}${
      state.upstreamWorkflow.scope ? `（范围：${state.upstreamWorkflow.scope}）` : ""
    }`,
    `科学验证：${state.scientificValidation.status}${
      state.scientificValidation.decisionSource
        ? `（来源：${state.scientificValidation.decisionSource}）`
        : ""
    }`,
  ];
}

function providerStateLines(candidate: Candidate) {
  return [
    `来源：${candidate.sourceLabel}`,
    ...(candidate.upstreamStatus ? [`上游状态：${candidate.upstreamStatus}`] : []),
    ...(candidate.publisherReviewStatus
      ? [`发布者审核状态：${candidate.publisherReviewStatus}`]
      : []),
    ...(candidate.publisherExecutionStatus
      ? [
          `发布者执行状态：${candidate.publisherExecutionStatus}${
            candidate.publisherExecutionScope
              ? `（${candidate.publisherExecutionScope}）`
              : ""
          }`,
        ]
      : []),
    `SFL Local review：${candidate.reviewStatus}`,
    `SFL execution：${candidate.executionStatus}`,
    ...(candidate.codeExecutedBySflClient !== undefined
      ? [`SFL code execution：${candidate.codeExecutedBySflClient}`]
      : []),
  ];
}

function moduleIdentityLines(candidate: Candidate) {
  if (candidate.exactSelector.kind !== "module-archive.v1") return [];
  const identity = candidate.exactSelector.identity;
  return [
    `源码 commit：${String(identity.sourceCommit ?? "unknown")}`,
    `归档 commit：${String(identity.archiveCommit ?? "unknown")}`,
    `ZIP SHA-256：${String((identity.archive as Record<string, unknown> | undefined)?.digest ?? "unknown")}`,
    `物化模式：${String(identity.mode ?? "unknown")}`,
    ...(candidate.materializationModes?.length
      ? [`可选物化模式：${candidate.materializationModes.join(", ")}`]
      : []),
  ];
}

function candidateTags(candidate: Candidate) {
  return [
    candidate.assetKind,
    candidate.language,
    candidate.plotFamily,
    candidate.reviewStatus,
    candidate.codeStatus,
    candidate.canonicalPreviewDecision
      ? `canonical:${candidate.canonicalPreviewDecision.reason}`
      : "",
    candidate.exactSelector.kind,
    candidate.management.adapter,
    candidate.management.galleryId ? `gallery:${candidate.management.galleryId}` : "",
    candidate.management.registrySourceId
      ? `source:${candidate.management.registrySourceId}`
      : "",
    ...candidate.inputFiles.map((name) => `input:${name}`),
    ...(candidate.codeFiles ?? []).map((name) => `code:${name}`),
    ...candidate.packages.map((name) => `pkg:${name}`),
  ].filter((value): value is string => Boolean(value));
}

function appendPreviewImage(
  document: Document,
  container: HTMLElement,
  candidate: Candidate,
  size: "thumbnail" | "detail",
) {
  const status = candidate.searchPreviewStatus ?? candidate.previewStatus;
  if (status === "ready" && candidate.previewDataUrl) {
    const image = element(document, "img");
    image.src = candidate.previewDataUrl;
    image.alt = `${candidate.title} ${size === "thumbnail" ? "候选缩略图" : "候选详情图"}`;
    image.decoding = "async";
    if (size === "thumbnail") image.loading = "lazy";
    container.append(image);
    return;
  }
  container.append(
    element(document, "span", "preview-status", previewFailureLabel(status)),
  );
}

function parsePreviewMeta(meta: unknown) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const candidatePreviews = (meta as Record<string, unknown>).candidatePreviews;
  if (!candidatePreviews || typeof candidatePreviews !== "object" || Array.isArray(candidatePreviews)) {
    return {};
  }
  return candidatePreviews as Record<string, CandidatePreviewMeta>;
}

export function parseSearchResult(value: unknown, meta?: unknown): SearchResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const raw = value as Partial<SearchResult>;
  if (
    typeof raw.query !== "string" ||
    typeof raw.resultSetId !== "string" ||
    !Array.isArray(raw.candidates) ||
    !raw.pagination ||
    typeof raw.pagination !== "object" ||
    typeof raw.pagination.total !== "number" ||
    typeof raw.pagination.pageIndex !== "number"
  ) {
    return;
  }
  const previewMeta = parsePreviewMeta(meta);
  const candidates = raw.candidates
    .filter((candidate): candidate is Candidate => {
      if (!candidate || typeof candidate !== "object") return false;
      const value = candidate as Partial<Candidate>;
      return (
        typeof value.candidateId === "string" &&
        typeof value.templateId === "string" &&
        typeof value.providerId === "string"
      );
    })
    .map((candidate) => ({ ...candidate, ...(previewMeta[candidate.candidateId] ?? {}) }));
  return {
    query: raw.query,
    libraryVersion: typeof raw.libraryVersion === "string" ? raw.libraryVersion : "unknown",
    materializationProtocolVersion:
      typeof raw.materializationProtocolVersion === "number"
        ? raw.materializationProtocolVersion
        : 0,
    intentFamilies: Array.isArray(raw.intentFamilies)
      ? raw.intentFamilies.filter((item): item is string => typeof item === "string")
      : [],
    reviewRequired: raw.reviewRequired === true,
    resultSetId: raw.resultSetId,
    ...(typeof raw.correlationId === "string" ? { correlationId: raw.correlationId } : {}),
    diagnosticsDegraded: raw.diagnosticsDegraded === true,
    pagination: {
      total: raw.pagination.total,
      pageIndex: raw.pagination.pageIndex,
      pageSize:
        typeof raw.pagination.pageSize === "number" ? raw.pagination.pageSize : candidates.length,
      hasMore: raw.pagination.hasMore === true,
      nextCursor:
        typeof raw.pagination.nextCursor === "string" ? raw.pagination.nextCursor : null,
    },
    candidates,
  };
}

export function renderCandidateCards(options: {
  document: Document;
  cards: HTMLElement;
  empty: HTMLElement;
  result: SearchResult;
  selectedIds?: Set<string>;
  onToggleSelect?: (candidate: Candidate, selected: boolean) => void;
  onDetail: (
    candidate: Candidate,
    elements: CandidateElements,
    opener: HTMLButtonElement,
  ) => void;
}) {
  const { document, cards, empty, result } = options;
  cards.replaceChildren();
  empty.hidden = result.candidates.length > 0;

  for (const candidate of result.candidates) {
    const card = element(document, "article", "card");
    card.dataset.candidateId = candidate.candidateId;
    const selectLabel = element(document, "label", "candidate-select");
    const selectBox = document.createElement("input");
    selectBox.type = "checkbox";
    selectBox.className = "candidate-select-input";
    selectBox.checked = Boolean(options.selectedIds?.has(candidate.candidateId));
    selectBox.setAttribute("aria-label", `选择 ${candidate.title} 交给 Agent 绘制`);
    selectBox.addEventListener("click", (event) => event.stopPropagation());
    selectBox.addEventListener("change", () => options.onToggleSelect?.(candidate, selectBox.checked));
    selectLabel.append(selectBox, document.createTextNode("选择"));
    const previewButton = button(
      document,
      "preview preview-button",
      "",
    );
    previewButton.setAttribute("aria-label", `查看 ${candidate.title} 详情`);
    appendPreviewImage(document, previewButton, candidate, "thumbnail");

    const content = element(document, "div", "content");
    const top = element(document, "div", "topline");
    const heading = element(document, "div");
    const headingNode = element(document, "h2", "module");
    const titleButton = button(document, "candidate-title", candidate.title);
    titleButton.setAttribute("aria-label", `查看 ${candidate.title} 详情`);
    headingNode.append(titleButton);
    heading.append(
      headingNode,
      element(document, "code", "template-id", candidate.templateId),
      element(
        document,
        "span",
        `source source-${candidate.providerId === "org.scientificfigurelibrary.local" ? "local" : "external"}`,
        candidate.sourceLabel,
      ),
    );
    top.append(heading, element(document, "span", "score", `召回 ${candidate.retrievalScore}`));
    const description = candidate.description || candidate.excerpt || "查看模板详情以确认输入要求。";
    content.append(
      top,
      element(document, "p", "description", description),
      element(document, "p", "provider-state", providerStateLines(candidate).join(" · ")),
      element(
        document,
        "p",
        "validation-summary",
        validationSummaryLines(candidate).join(" · "),
      ),
    );

    const tags = candidateTags(candidate);
    if (tags.length) content.append(chips(document, tags, 6));
    if (candidate.reasons[0]) content.append(element(document, "p", "reason", candidate.reasons[0]));
    if (candidate.warnings[0]) content.append(element(document, "p", "warning", candidate.warnings[0]));

    const detailButton = button(document, "candidate-action", "查看详情");
    const elements = { card, previewButton, titleButton, detailButton };
    const open = (opener: HTMLButtonElement) => options.onDetail(candidate, elements, opener);
    previewButton.addEventListener("click", () => open(previewButton));
    titleButton.addEventListener("click", () => open(titleButton));
    detailButton.addEventListener("click", () => open(detailButton));
    content.append(detailButton);
    card.append(selectLabel, previewButton, content);
    cards.append(card);
  }
}

function appendDetailSection(
  document: Document,
  container: HTMLElement,
  title: string,
  values: string[],
  className = "detail-list",
) {
  if (!values.length) return;
  const section = element(document, "section", "detail-section");
  section.append(element(document, "h3", "detail-section-title", title));
  const list = element(document, "ul", className);
  for (const value of values) list.append(element(document, "li", "", value));
  section.append(list);
  container.append(section);
}

export function openCandidateDetail(options: {
  document: Document;
  candidate: Candidate;
  opener: HTMLButtonElement;
  serverToolsAvailable: boolean;
  updateModelContextAvailable: boolean;
  onClosed?: () => void;
  onRequestExactPreview: (elements: DetailViewElements) => void;
  onRequestAgentReview: (elements: DetailViewElements) => void;
}): DetailViewElements {
  const { document, candidate, opener } = options;
  const dialog = element(document, "dialog", "candidate-dialog");
  dialog.setAttribute("aria-labelledby", `detail-title-${candidate.candidateId}`);
  const panel = element(document, "div", "detail-panel");
  const closeButton = button(document, "dialog-close", "关闭详情");
  closeButton.setAttribute("aria-label", `关闭 ${candidate.title} 详情`);
  const title = element(document, "h2", "detail-title", candidate.title);
  title.id = `detail-title-${candidate.candidateId}`;
  const identity = element(document, "div", "detail-identity");
  identity.append(
    element(document, "span", "source", candidate.sourceLabel),
    element(document, "code", "template-id", candidate.templateId),
    element(document, "code", "provider-id", candidate.providerId),
  );
  const preview = element(document, "div", "detail-preview");
  appendPreviewImage(document, preview, candidate, "detail");
  const description = element(
    document,
    "p",
    "detail-description",
    candidate.description || candidate.excerpt || "没有可用描述。",
  );
  const metadata = element(document, "div", "detail-metadata");
  const tags = candidateTags(candidate);
  if (tags.length) metadata.append(chips(document, tags, Number.POSITIVE_INFINITY));
  if (candidate.application) {
    appendDetailSection(document, metadata, "适用场景", [candidate.application]);
  }
  if (candidate.dataProfile) {
    appendDetailSection(document, metadata, "数据特征", [candidate.dataProfile]);
  }
  appendDetailSection(document, metadata, "验证状态", validationSummaryLines(candidate));
  appendDetailSection(document, metadata, "来源与执行边界", providerStateLines(candidate));
  appendDetailSection(document, metadata, "固定模块身份", moduleIdentityLines(candidate));
  if (candidate.canonicalPreviewDecision) {
    appendDetailSection(document, metadata, "Canonical 预览", [
      `${candidate.canonicalPreviewDecision.reason}：${
        candidate.canonicalPreviewDecision.assetPath
      }${
        candidate.canonicalPreviewDecision.reason === "user_override_rendered"
          ? `（${candidate.canonicalPreviewDecision.note}）`
          : ""
      }`,
    ]);
  }
  appendDetailSection(document, metadata, "检索原因", candidate.reasons);
  appendDetailSection(document, metadata, "警告", candidate.warnings, "detail-list warning-list");
  appendDetailSection(document, metadata, "输入文件", candidate.inputFiles);
  appendDetailSection(document, metadata, "代码文件", candidate.codeFiles ?? []);
  appendDetailSection(document, metadata, "依赖包", candidate.packages);

  const status = element(document, "p", "detail-status");
  status.setAttribute("aria-live", "polite");
  const controls = element(document, "div", "detail-controls");
  const exactPreviewButton = button(document, "exact-preview-action", "查看精确预览");
  const confirmButton = button(document, "confirm-action", "确认并交给 Agent");
  confirmButton.disabled = true;
  if (
    !candidate.previewAvailable ||
    (candidate.previewStatus !== undefined && candidate.previewStatus !== "ready")
  ) {
    exactPreviewButton.disabled = true;
    status.textContent = "该候选没有通过安全校验的预览，不能进行确认。";
  } else if (!options.serverToolsAvailable) {
    exactPreviewButton.disabled = true;
    if (options.updateModelContextAvailable) {
      confirmButton.disabled = false;
      confirmButton.textContent = "选择并交给 Agent 审核";
      status.textContent =
        "当前 Host 未提供 App→Server Tool；可把这个候选交给 Agent 进行一次 headless 精确审核。该路径不能证明精确图片已在 App 内加载。";
    } else {
      confirmButton.textContent = "Host 不支持选择交接";
      status.textContent =
        "当前 Host 既未提供 App→Server Tool，也未提供 updateModelContext；只能查看基础详情，不能加载精确预览或交接选择。";
    }
  } else {
    status.textContent = "基础详情来自搜索结果。需要时可仅为此候选加载一次精确预览。";
  }
  const elements: DetailViewElements = {
    dialog,
    preview,
    status,
    exactPreviewButton,
    confirmButton,
    closeButton,
  };
  exactPreviewButton.addEventListener("click", () => options.onRequestExactPreview(elements));
  if (!options.serverToolsAvailable && options.updateModelContextAvailable) {
    confirmButton.addEventListener("click", () => options.onRequestAgentReview(elements));
  }
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    opener.focus();
    options.onClosed?.();
    dialog.remove();
  });
  controls.append(exactPreviewButton, confirmButton);
  panel.append(closeButton, title, identity, preview, description, metadata, status, controls);
  dialog.append(panel);
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  queueMicrotask(() => closeButton.focus());
  return elements;
}

export function renderPlotSetBar(options: {
  bar: HTMLElement;
  submit: HTMLButtonElement;
  countLabel: HTMLElement;
  selectedCount: number;
  canSubmit: boolean;
}) {
  const { bar, submit, countLabel, selectedCount, canSubmit } = options;
  bar.hidden = false;
  countLabel.textContent = `已选 ${selectedCount} 个模板`;
  submit.disabled = !canSubmit || selectedCount < 1 || selectedCount > 8;
  submit.textContent =
    selectedCount > 8 ? "最多选择 8 个模板" : `交给 Agent 绘制（${selectedCount}）`;
}
