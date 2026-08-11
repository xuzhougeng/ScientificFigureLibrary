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
  application?: string;
  dataProfile?: string;
  inputFiles: string[];
  codeFiles?: string[];
  packages: string[];
  materializable: boolean;
  previewAvailable: boolean;
  previewStatus?: "ready" | "missing" | "unreadable" | "unsupported" | "too_large";
  previewDataUrl?: string;
  previewMimeType?: "image/png" | "image/jpeg" | "image/webp";
  previewByteLength?: number;
  previewSha256?: string;
  assetKind: "plot_template" | "visual_reference";
  language: string;
  plotFamily: string;
  reviewStatus: "not_reviewed" | "draft" | "approved" | "archived";
  codeStatus: "none" | "scaffold" | "provided" | "reviewed";
  executionStatus: "not_run" | "passed" | "failed" | "unknown";
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

function candidateTags(candidate: Candidate) {
  return [
    candidate.assetKind,
    candidate.language,
    candidate.plotFamily,
    candidate.reviewStatus,
    candidate.codeStatus,
    candidate.executionStatus,
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
  if (candidate.previewStatus === "ready" && candidate.previewDataUrl) {
    const image = element(document, "img");
    image.src = candidate.previewDataUrl;
    image.alt = `${candidate.title} ${size === "thumbnail" ? "候选缩略图" : "候选详情图"}`;
    image.decoding = "async";
    if (size === "thumbnail") image.loading = "lazy";
    container.append(image);
    return;
  }
  container.append(
    element(document, "span", "preview-status", previewFailureLabel(candidate.previewStatus)),
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
    content.append(top, element(document, "p", "description", description));

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
    card.append(previewButton, content);
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
  onClosed?: () => void;
  onRequestExactPreview: (elements: DetailViewElements) => void;
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
  if (!candidate.previewAvailable || candidate.previewStatus !== "ready") {
    exactPreviewButton.disabled = true;
    status.textContent = "该候选没有通过安全校验的预览，不能进行确认。";
  } else if (!options.serverToolsAvailable) {
    exactPreviewButton.disabled = true;
    status.textContent = "当前 Host 未提供 App→Server Tool；基础详情可查看，但不能加载精确预览或确认。";
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
